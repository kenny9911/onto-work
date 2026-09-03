import type { FastifyInstance } from "fastify";
import { isIP } from "node:net";
import { z } from "zod";
import {
  PROVIDER_CATALOG,
  type ProviderCatalogItem,
  type ProviderConnection,
} from "@agent-harness/contracts";
import type { HarnessConfig } from "../config.js";
import type { HarnessStore, ProviderRow } from "../database.js";
import { ApiHttpError, requireAdmin, requireUser } from "../http.js";
import { encryptSecret } from "../security.js";

const providerIdSchema = z.object({ providerId: z.string().uuid() });

const createProviderSchema = z
  .object({
    catalogId: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(160),
    baseUrl: z.string().trim().url().max(2_048).nullable().optional(),
    defaultModel: z.string().trim().min(1).max(256).nullable().optional(),
    credential: z.string().min(1).max(16_384).nullable().optional(),
    enabled: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  })
  .strict();

const updateProviderSchema = z
  .object({
    catalogId: z.string().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    baseUrl: z.string().trim().url().max(2_048).nullable().optional(),
    defaultModel: z.string().trim().min(1).max(256).nullable().optional(),
    credential: z.string().min(1).max(16_384).nullable().optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Supply at least one field to update.");

function catalogItem(id: string): ProviderCatalogItem {
  const item = PROVIDER_CATALOG.find((candidate) => candidate.id === id);
  if (!item) {
    throw new ApiHttpError(400, "invalid_provider_catalog", "Unsupported provider catalog item.");
  }
  return item;
}

type AddressScope = "public" | "private" | "forbidden";

const OBVIOUS_PRIVATE_HOSTS = new Set([
  "host.docker.internal",
  "gateway.docker.internal",
  "host.containers.internal",
  "ip6-localhost",
]);
const FORBIDDEN_METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.aws.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

function ipv4Scope(hostname: string): AddressScope {
  const octets = hostname.split(".").map(Number);
  const [first, second] = octets;
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return "public";
  }
  if (first === 0 || (first === 169 && second === 254) || (first !== undefined && first >= 224)) {
    return "forbidden";
  }
  if (
    first === 10 ||
    first === 127 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  ) {
    return "private";
  }
  return "public";
}

function ipv6Value(hostname: string): bigint | null {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6Scope(hostname: string): AddressScope {
  const value = ipv6Value(hostname);
  if (value === null) return "forbidden";
  if (value === 0n || value === 1n) return value === 0n ? "forbidden" : "private";

  // IPv4-compatible and IPv4-mapped addresses inherit the embedded IPv4 scope.
  const high96 = value >> 32n;
  if (high96 === 0n || high96 === 0xffffn) {
    const low32 = Number(value & 0xffff_ffffn);
    const mapped = [24, 16, 8, 0].map((shift) => (low32 >>> shift) & 0xff).join(".");
    return ipv4Scope(mapped);
  }
  if (value >> 118n === 0x3fan || value >> 120n === 0xffn) return "forbidden";
  if (value >> 121n === 0x7en) return "private";
  return "public";
}

function addressScope(hostname: string): AddressScope {
  const normalized = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (FORBIDDEN_METADATA_HOSTS.has(normalized)) return "forbidden";
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    OBVIOUS_PRIVATE_HOSTS.has(normalized)
  ) {
    return "private";
  }
  const version = isIP(normalized);
  if (version === 4) return ipv4Scope(normalized);
  if (version === 6) return ipv6Scope(normalized);
  return "public";
}

function normalizeBaseUrl(
  value: string | null,
  policy: { allowPrivate: boolean; localProvider: boolean },
): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiHttpError(400, "invalid_provider_url", "Provider URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new ApiHttpError(400, "invalid_provider_url", "Provider URL cannot contain credentials.");
  }
  if (url.search || url.hash) {
    throw new ApiHttpError(
      400,
      "invalid_provider_url",
      "Provider URL cannot contain a query string or fragment.",
    );
  }
  const scope = addressScope(url.hostname);
  if (scope === "forbidden") {
    throw new ApiHttpError(
      400,
      "invalid_provider_url",
      "Provider URL cannot target metadata, link-local, multicast, or unspecified addresses.",
    );
  }
  if ((policy.localProvider || scope === "private") && !policy.allowPrivate) {
    throw new ApiHttpError(
      400,
      "private_provider_url_disabled",
      "Private and local provider endpoints are disabled by the server deployment policy.",
    );
  }
  if (url.protocol !== "https:" && !(policy.allowPrivate && scope === "private")) {
    throw new ApiHttpError(
      400,
      "invalid_provider_url",
      "Remote provider URLs must use HTTPS.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function providerById(
  store: HarnessStore,
  tenantId: string,
  providerId: string,
): ProviderConnection {
  const provider = store.listProviders(tenantId).find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new ApiHttpError(404, "provider_not_found", "Provider connection not found.");
  }
  return provider;
}

function validatedValues(input: {
  config: HarnessConfig;
  catalog: ProviderCatalogItem;
  baseUrl: string | null | undefined;
  tenantSuppliedBaseUrl: boolean;
  defaultModel: string | null | undefined;
  enabled: boolean;
  isDefault: boolean;
  hasCredential: boolean;
}): { baseUrl: string | null; defaultModel: string | null } {
  if (input.isDefault && !input.enabled) {
    throw new ApiHttpError(
      400,
      "invalid_provider_state",
      "A disabled provider cannot be the default.",
    );
  }
  const hasRouteCredential =
    input.hasCredential ||
    (input.catalog.adapter === "litellm" && Boolean(input.config.litellmMasterKey));
  if (input.enabled && input.catalog.keyLabel && !hasRouteCredential) {
    throw new ApiHttpError(
      400,
      "provider_credential_required",
      `${input.catalog.keyLabel} is required while this provider is enabled.`,
    );
  }

  const endpointPolicy = {
    allowPrivate: Boolean(input.config.allowPrivateProviderEndpoints),
    localProvider: input.catalog.local,
  };
  // Preserve validation for every tenant-supplied URL even when a gateway URL
  // will be ignored. This prevents credentials or redirect-like query data from
  // becoming an accepted (but misleading) provider configuration field.
  if (input.catalog.adapter === "litellm" && input.tenantSuppliedBaseUrl && input.baseUrl) {
    normalizeBaseUrl(input.baseUrl, endpointPolicy);
  }

  // Gateway-backed entries are pinned to the operator-owned gateway. Tenants
  // select an alias and scoped token, but cannot redirect the control plane.
  const requestedBaseUrl =
    input.catalog.adapter === "litellm"
      ? input.config.litellmBaseUrl
      : input.baseUrl === undefined
        ? input.catalog.defaultBaseUrl
        : input.baseUrl;
  const baseUrl = normalizeBaseUrl(requestedBaseUrl, endpointPolicy);
  if (!baseUrl) {
    throw new ApiHttpError(400, "provider_url_required", "A provider base URL is required.");
  }
  return {
    baseUrl,
    defaultModel:
      input.defaultModel === undefined ? input.catalog.defaultModel : input.defaultModel,
  };
}

export function registerProviderRoutes(
  app: FastifyInstance,
  input: { store: HarnessStore; config: HarnessConfig },
): void {
  const { store, config } = input;

  app.get("/api/providers/catalog", async (request) => {
    requireUser(request, store);
    return { providers: PROVIDER_CATALOG };
  });

  app.get("/api/providers", async (request) => {
    const user = requireUser(request, store);
    return { providers: store.listProviders(user.tenantId) };
  });

  app.get("/api/providers/:providerId", async (request) => {
    const user = requireUser(request, store);
    const { providerId } = providerIdSchema.parse(request.params);
    return { provider: providerById(store, user.tenantId, providerId) };
  });

  app.post("/api/providers", async (request, reply) => {
    const actor = requireAdmin(request, store);
    const body = createProviderSchema.parse(request.body);
    const catalog = catalogItem(body.catalogId);
    const hasCredential = Boolean(body.credential);
    const values = validatedValues({
      config,
      catalog,
      baseUrl: body.baseUrl,
      tenantSuppliedBaseUrl: body.baseUrl !== undefined,
      defaultModel: body.defaultModel,
      enabled: body.enabled,
      isDefault: body.isDefault,
      hasCredential,
    });
    const provider = store.saveProvider({
      tenantId: actor.tenantId,
      catalogId: catalog.id,
      name: body.name,
      adapter: catalog.adapter,
      baseUrl: values.baseUrl,
      defaultModel: values.defaultModel,
      credentialCiphertext: body.credential
        ? encryptSecret(body.credential, config.credentialEncryptionKey)
        : null,
      enabled: body.enabled,
      isDefault: body.isDefault,
    });
    store.audit({
      tenantId: actor.tenantId,
      userId: actor.id,
      action: "provider.created",
      targetType: "provider_connection",
      targetId: provider.id,
      metadata: { catalogId: catalog.id, enabled: provider.enabled, isDefault: provider.isDefault },
    });
    return reply.status(201).send({ provider });
  });

  app.patch("/api/providers/:providerId", async (request) => {
    const actor = requireAdmin(request, store);
    const { providerId } = providerIdSchema.parse(request.params);
    const body = updateProviderSchema.parse(request.body);
    const existing = store.getProviderRow(actor.tenantId, providerId) as ProviderRow | undefined;
    if (!existing) {
      throw new ApiHttpError(404, "provider_not_found", "Provider connection not found.");
    }

    const nextCatalog = catalogItem(body.catalogId ?? existing.catalog_id);
    const catalogChanged = nextCatalog.id !== existing.catalog_id;
    const credentialCiphertext =
      body.credential === undefined
        ? undefined
        : body.credential === null
          ? null
          : encryptSecret(body.credential, config.credentialEncryptionKey);
    const hasCredential =
      body.credential === undefined
        ? Boolean(existing.credential_ciphertext)
        : body.credential !== null;
    if (catalogChanged && nextCatalog.keyLabel && body.credential === undefined) {
      throw new ApiHttpError(
        400,
        "provider_credential_required",
        "Supply a credential when changing provider type.",
      );
    }
    const enabled = body.enabled ?? existing.enabled === 1;
    const isDefault = body.isDefault ?? existing.is_default === 1;
    const values = validatedValues({
      config,
      catalog: nextCatalog,
      baseUrl: body.baseUrl === undefined ? existing.base_url : body.baseUrl,
      tenantSuppliedBaseUrl: body.baseUrl !== undefined,
      defaultModel:
        body.defaultModel === undefined ? existing.default_model : body.defaultModel,
      enabled,
      isDefault,
      hasCredential,
    });
    const provider = store.saveProvider({
      id: providerId,
      tenantId: actor.tenantId,
      catalogId: nextCatalog.id,
      name: body.name ?? existing.name,
      adapter: nextCatalog.adapter,
      baseUrl: values.baseUrl,
      defaultModel: values.defaultModel,
      credentialCiphertext,
      enabled,
      isDefault,
    });
    store.audit({
      tenantId: actor.tenantId,
      userId: actor.id,
      action: "provider.updated",
      targetType: "provider_connection",
      targetId: provider.id,
      metadata: {
        catalogId: nextCatalog.id,
        credentialRotated: body.credential !== undefined,
        enabled: provider.enabled,
        isDefault: provider.isDefault,
      },
    });
    return { provider };
  });

  app.delete("/api/providers/:providerId", async (request, reply) => {
    const actor = requireAdmin(request, store);
    const { providerId } = providerIdSchema.parse(request.params);
    const provider = providerById(store, actor.tenantId, providerId);
    if (!store.deleteProvider(actor.tenantId, providerId)) {
      throw new ApiHttpError(404, "provider_not_found", "Provider connection not found.");
    }
    store.audit({
      tenantId: actor.tenantId,
      userId: actor.id,
      action: "provider.deleted",
      targetType: "provider_connection",
      targetId: providerId,
      metadata: { catalogId: provider.catalogId, name: provider.name },
    });
    return reply.status(204).send();
  });
}
