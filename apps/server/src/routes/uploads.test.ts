import assert from "node:assert/strict";
import { readdir, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { buildApp } from "../app.js";
import type { HarnessConfig } from "../config.js";
import { HarnessStore, type SavedProjectRecord } from "../database.js";
import { ApiHttpError } from "../http.js";
import { UnconfiguredHarnessRuntime } from "../runtime.js";
import { decryptToStaged } from "../uploads/blob.js";
import { prepareUserUploadPaths } from "../uploads/paths.js";
import { hashPassword } from "../security.js";
import { startUploadPaceMonitor } from "./uploads.js";

const CSV_BODY = Buffer.from("id,name\n1,alpha\n2,beta\n3,gamma\n", "utf8");

interface TenantSession {
  tenantId: string;
  userId: string;
  cookie: string;
}

interface UploadFixture {
  app: FastifyInstance;
  config: HarnessConfig;
  store: HarnessStore;
  directory: string;
  project: SavedProjectRecord;
  workspacePath: string;
  threadId: string;
  owner: TenantSession;
  /** A second tenant with a live session and nothing else. */
  outsider: TenantSession;
}

function responseCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers["set-cookie"];
  assert.ok(setCookie);
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

async function login(
  app: FastifyInstance,
  config: HarnessConfig,
  username: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: config.webOrigin },
    payload: { username, password },
  });
  assert.equal(response.statusCode, 200);
  return responseCookie(response);
}

async function uploadFixture(t: TestContext): Promise<UploadFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-uploads-route-"));
  const uploadDataDir = `${directory}-uploads`;
  const config: HarnessConfig = {
    host: "127.0.0.1",
    port: 0,
    webOrigin: "http://127.0.0.1:4173",
    databasePath: join(directory, "harness.db"),
    runtimeDataDir: join(directory, "runtimes"),
    uploadDataDir,
    sessionTtlMs: 60 * 60 * 1_000,
    sessionSecret: "test-session-secret-that-is-long-enough",
    credentialEncryptionKey: "test-credential-key-that-is-long-enough",
    codexBinary: "codex",
    codexExperimentalApi: false,
    allowedWorkspaceRoots: [directory],
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    stripePricePro: null,
    stripePriceTeam: null,
    publicAppUrl: "http://127.0.0.1:4173",
    litellmBaseUrl: "http://127.0.0.1:4000/v1",
    litellmMasterKey: null,
  };
  const store = new HarnessStore(config.databasePath);
  const admin = await store.bootstrapAdmin("upload-route-admin", "upload-route-password");
  store.db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(admin.id);

  const workspacePath = await realpath(directory);
  store.grantWorkspace({
    tenantId: admin.tenantId,
    rootPath: workspacePath,
    createdByUserId: admin.id,
  });
  const grant = store.findWorkspaceGrantForPath(admin.tenantId, workspacePath);
  assert.ok(grant);
  const project = store.registerSavedProject({
    tenantId: admin.tenantId,
    name: "Upload fixture",
    workspacePath,
    workspaceGrantId: grant.id,
    createdByUserId: admin.id,
  });
  const threadId = "upload-route-thread";
  store.bindThreadWorkspace({
    tenantId: admin.tenantId,
    userId: admin.id,
    threadId,
    workspacePath,
  });

  // A second tenant, so "another tenant's id" is a real session rather than a
  // hand-built request.
  const createdAt = new Date().toISOString();
  const outsiderTenantId = "upload-route-tenant-two";
  const outsiderUserId = "upload-route-user-two";
  store.db
    .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run(outsiderTenantId, "Second tenant", "upload-route-second", createdAt);
  store.db
    .prepare(`
      INSERT INTO users (
        id, tenant_id, username, display_name, password_hash, role, status,
        must_change_password, created_at
      ) VALUES (?, ?, ?, ?, ?, 'admin', 'active', 0, ?)
    `)
    .run(
      outsiderUserId,
      outsiderTenantId,
      "upload-route-outsider",
      "Second admin",
      await hashPassword("upload-route-outsider-password"),
      createdAt,
    );
  store.createEntitlementSnapshot({
    tenantId: outsiderTenantId,
    plan: "free",
    status: "active",
    seatLimit: 4,
    activeRunLimit: 1,
    requestLimit: 1_000,
    periodStart: createdAt,
    periodEnd: null,
    allowedRouteIds: ["*"],
  });

  const app = await buildApp({
    config,
    store,
    runtime: new UnconfiguredHarnessRuntime(),
    logger: false,
  });
  const ownerCookie = await login(app, config, "upload-route-admin", "upload-route-password");
  const outsiderCookie = await login(
    app,
    config,
    "upload-route-outsider",
    "upload-route-outsider-password",
  );

  t.after(async () => {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(uploadDataDir, { recursive: true, force: true });
  });

  return {
    app,
    config,
    store,
    directory,
    project,
    workspacePath,
    threadId,
    owner: { tenantId: admin.tenantId, userId: admin.id, cookie: ownerCookie },
    outsider: {
      tenantId: outsiderTenantId,
      userId: outsiderUserId,
      cookie: outsiderCookie,
    },
  };
}

function uploadHeaders(
  fixture: UploadFixture,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: fixture.owner.cookie,
    origin: fixture.config.webOrigin,
    "content-type": "application/octet-stream",
    "idempotency-key": `upload-${Math.random().toString(36).slice(2)}`,
    "x-upload-filename": encodeURIComponent("report.csv"),
    ...overrides,
  };
}

/** A payload stream that records how many times it was pulled. */
function pullCountingStream(payload: Buffer): { stream: Readable; reads: () => number } {
  let reads = 0;
  let delivered = false;
  const stream = new Readable({
    read() {
      reads += 1;
      if (delivered) {
        this.push(null);
        return;
      }
      delivered = true;
      this.push(payload);
    },
  });
  return { stream, reads: () => reads };
}

/** A payload stream that announces when it is first pulled and waits to be released. */
function gatedStream(payload: Buffer): {
  stream: Readable;
  started: Promise<void>;
  release: () => void;
} {
  let announceStart!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStart = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delivered = false;
  const stream = new Readable({
    read() {
      if (delivered) return;
      delivered = true;
      announceStart();
      void gate.then(() => {
        this.push(payload);
        this.push(null);
      });
    },
  });
  return { stream, started, release };
}

/** One `app.log.<level>(payload, message)` call, captured verbatim. */
interface CapturedLog {
  level: string;
  payload: unknown;
  message: unknown;
}

/**
 * Replaces the instance logger with a recorder and returns what it collects.
 *
 * `app.log` is a plain writable property on the Fastify instance, and the
 * upload registrar reads it at call time through its captured `app`, so this
 * sees exactly what the route hands pino. Fastify's own per-request logger
 * comes from its log controller rather than this property, so nothing else is
 * disturbed.
 */
function captureAppLog(app: FastifyInstance): CapturedLog[] {
  const captured: CapturedLog[] = [];
  const record =
    (level: string) =>
    (payload: unknown, message?: unknown): void => {
      captured.push({ level, payload, message });
    };
  const logger: Record<string, unknown> = {
    level: "debug",
    fatal: record("fatal"),
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
    debug: record("debug"),
    trace: record("trace"),
    silent: () => undefined,
  };
  logger.child = () => logger;
  (app as unknown as { log: unknown }).log = logger;
  return captured;
}

/**
 * Renders captured log arguments the way pino's `err` serializer would.
 *
 * A bare `JSON.stringify` of an `Error` yields `{}` for `message` and `stack`
 * because they are non-enumerable, which would hide the very leak under test —
 * pino expands them, and `fs` errors carry the path in all three of `message`,
 * `stack` and the enumerable `path`.
 */
function renderLog(entries: readonly CapturedLog[]): string {
  return JSON.stringify(entries, (_key, value: unknown) => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
        cause: value.cause,
        ...Object.fromEntries(Object.entries(value)),
      };
    }
    return value;
  });
}

/**
 * Sends a hand-built request over a real socket and returns the parsed reply.
 *
 * `app.inject` cannot express a repeated header: light-my-request assigns
 * `headers[name] = "" + value`, so an array collapses into one entry and
 * `rawHeaders` records a single occurrence — which is the state the merged
 * header bug already produces, so an inject-based test would pass against the
 * broken code. Only the wire carries two header lines.
 */
async function rawRequest(
  app: FastifyInstance,
  input: {
    method: string;
    path: string;
    headers: ReadonlyArray<readonly [string, string]>;
    body: Buffer;
  },
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  const head = [
    `${input.method} ${input.path} HTTP/1.1`,
    `host: 127.0.0.1:${address.port}`,
    ...input.headers.map(([name, value]) => `${name}: ${value}`),
    "connection: close",
    "",
    "",
  ].join("\r\n");

  const socket = connect({ host: "127.0.0.1", port: address.port });
  const chunks: Buffer[] = [];
  const finished = new Promise<void>((settle, fail) => {
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => settle());
    socket.on("error", fail);
  });
  await new Promise<void>((ready) => socket.once("connect", () => ready()));
  socket.write(Buffer.concat([Buffer.from(head, "latin1"), input.body]));
  await finished;
  socket.destroy();

  const raw = Buffer.concat(chunks).toString("utf8");
  const status = Number.parseInt(raw.slice("HTTP/1.1 ".length, "HTTP/1.1 ".length + 3), 10);
  // The reply may be chunk-framed, so take the JSON document rather than
  // everything after the blank line.
  const opened = raw.indexOf("{");
  const closed = raw.lastIndexOf("}");
  const json =
    opened === -1 || closed <= opened
      ? null
      : (JSON.parse(raw.slice(opened, closed + 1)) as Record<string, unknown>);
  return { status, json };
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

test("a thread-scoped upload is stored, encrypted, and audited", async (t) => {
  const fixture = await uploadFixture(t);
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture),
    payload: CSV_BODY,
  });
  assert.equal(response.statusCode, 201);

  const body = response.json() as { upload: Record<string, unknown> };
  assert.equal(body.upload.scope, "thread");
  assert.equal(body.upload.threadId, fixture.threadId);
  assert.equal(body.upload.projectId, null);
  assert.equal(body.upload.filename, "report.csv");
  assert.equal(body.upload.contentType, "text/csv");
  assert.equal(body.upload.sizeBytes, CSV_BODY.byteLength);
  assert.equal(body.upload.status, "stored");
  // The wire projection never leaks the storage path or the encryption material.
  for (const forbidden of ["storageKey", "workspacePath", "wrappedDataKey", "encryptionIv"]) {
    assert.equal(forbidden in body.upload, false, `${forbidden} must not be serialized`);
  }

  const uploadId = body.upload.id as string;
  const record = fixture.store.getUpload(fixture.owner.tenantId, fixture.owner.userId, uploadId);
  assert.ok(record);
  assert.equal(record.workspacePath, fixture.workspacePath);
  assert.equal(record.status, "stored");

  // The blob is ciphertext at rest, read-only, and named by the upload UUID.
  const blobPath = join(fixture.config.uploadDataDir, ...record.storageKey.split("/"));
  const blob = await readFile(blobPath);
  assert.equal(blob.byteLength, CSV_BODY.byteLength);
  assert.notEqual(blob.toString("utf8"), CSV_BODY.toString("utf8"));
  const blobStat = await stat(blobPath);
  if (process.platform !== "win32") assert.equal(blobStat.mode & 0o777, 0o400);
  assert.ok(record.storageKey.endsWith(uploadId));

  const listing = await fixture.app.inject({
    method: "GET",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: { cookie: fixture.owner.cookie },
  });
  assert.equal(listing.statusCode, 200);
  const uploads = (listing.json() as { uploads: Array<{ id: string }> }).uploads;
  assert.deepEqual(uploads.map((entry) => entry.id), [uploadId]);

  const audit = fixture.store
    .listAuditEvents(fixture.owner.tenantId)
    .filter((event) => event.action === "upload.created");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.targetId, uploadId);
  // Audit metadata is flat scalars only: no filename, no path, no digest.
  const metadata = JSON.stringify(audit[0]?.metadata ?? {});
  assert.equal(metadata.includes("report.csv"), false);
  assert.equal(metadata.includes(fixture.workspacePath), false);
  assert.equal(metadata.includes(record.storageKey), false);
});

test("a project-scoped upload is stored unbound, awaiting its first thread", async (t) => {
  const fixture = await uploadFixture(t);
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/projects/${fixture.project.id}/uploads`,
    headers: uploadHeaders(fixture, { "x-upload-filename": encodeURIComponent("notes.md") }),
    payload: Buffer.from("# Heading\n\n- one\n- two\n", "utf8"),
  });
  assert.equal(response.statusCode, 201);
  const body = response.json() as { upload: Record<string, unknown> };
  assert.equal(body.upload.scope, "project");
  assert.equal(body.upload.threadId, null);
  assert.equal(body.upload.projectId, fixture.project.id);
  assert.equal(body.upload.contentType, "text/markdown");

  // It is not visible on any thread until a turn claims it.
  const listing = await fixture.app.inject({
    method: "GET",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: { cookie: fixture.owner.cookie },
  });
  assert.deepEqual((listing.json() as { uploads: unknown[] }).uploads, []);
});

test("an upload without an Origin header is refused before the body is considered", async (t) => {
  const fixture = await uploadFixture(t);
  const headers = uploadHeaders(fixture);
  delete headers.origin;
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers,
    payload: CSV_BODY,
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "invalid_origin");
});

test("an unauthenticated upload is refused with zero bytes read off the body", async (t) => {
  const fixture = await uploadFixture(t);

  for (const url of [
    `/api/tasks/${fixture.threadId}/uploads`,
    `/api/projects/${fixture.project.id}/uploads`,
  ]) {
    const body = pullCountingStream(CSV_BODY);
    const headers = uploadHeaders(fixture);
    delete headers.cookie;
    const response = await fixture.app.inject({
      method: "POST",
      url,
      headers: { ...headers, "content-length": String(CSV_BODY.byteLength) },
      payload: body.stream,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "unauthenticated");
    // This is the property the pass-through parser exists for: the handler ran
    // and answered before a single byte was pulled off the socket, so an
    // anonymous caller cannot make this process buffer, hash, or write anything.
    assert.equal(body.reads(), 0, `${url} must not read the body of an anonymous request`);
  }

  // Nothing was reserved and nothing landed on disk.
  assert.deepEqual(await listFiles(fixture.config.uploadDataDir), []);
});

test("an oversized declared length is refused as upload_too_large", async (t) => {
  const fixture = await uploadFixture(t);
  const body = pullCountingStream(CSV_BODY);
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, { "content-length": String(21 * 1024 * 1024) }),
    payload: body.stream,
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error, "upload_too_large");
  // Point 1 of four: rejected on the declared length, before anything is read.
  assert.equal(body.reads(), 0);
  assert.deepEqual(await listFiles(fixture.config.uploadDataDir), []);
});

test("a body of exactly the maximum size is accepted end to end", async (t) => {
  const fixture = await uploadFixture(t);
  // 20 MiB of real text through the whole pipeline: counted, classified,
  // hashed, encrypted and written without the body being held in memory.
  const maximum = Buffer.alloc(20 * 1024 * 1024, 0x61);
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, { "x-upload-filename": encodeURIComponent("large.txt") }),
    payload: maximum,
  });
  assert.equal(response.statusCode, 201);
  const body = response.json() as { upload: { sizeBytes: number; contentType: string } };
  assert.equal(body.upload.sizeBytes, maximum.byteLength);
  assert.equal(body.upload.contentType, "text/plain");
  assert.equal(
    fixture.store.getUploadStorageUsage(fixture.owner.tenantId),
    maximum.byteLength,
  );
});

test("the upload route carries its own rate limit", async (t) => {
  const fixture = await uploadFixture(t);
  // `@fastify/rate-limit` is registered `global: false`, so a route without an
  // explicit `config.rateLimit` has no throttling at all. These requests are
  // refused in the handler, but the limiter runs at `onRequest` and counts
  // every one — which is exactly what makes the limit load-bearing.
  const headers = uploadHeaders(fixture);
  delete headers["content-length"];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${fixture.threadId}/uploads`,
      headers: { ...headers, "content-length": "not-a-number" },
      payload: pullCountingStream(CSV_BODY).stream,
    });
    assert.equal(response.statusCode, 400, `attempt ${attempt} should reach the handler`);
  }
  const throttled = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: { ...headers, "content-length": "not-a-number" },
    payload: pullCountingStream(CSV_BODY).stream,
  });
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.json().error, "rate_limited");
});

test("a multipart body is refused as unsupported_media_type", async (t) => {
  const fixture = await uploadFixture(t);
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, {
      "content-type": "multipart/form-data; boundary=agent-harness",
    }),
    payload: "--agent-harness\r\nContent-Disposition: form-data; name=a\r\n\r\nb\r\n--agent-harness--",
  });
  assert.equal(response.statusCode, 415);
  assert.equal(response.json().error, "unsupported_media_type");

  // And a type this route could parse but must not accept.
  const asJson = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, { "content-type": "application/json" }),
    payload: JSON.stringify({ not: "bytes" }),
  });
  assert.equal(asJson.statusCode, 415);
  assert.equal(asJson.json().error, "unsupported_media_type");
});

test("the upload routes do not widen the buffering body limit", async (t) => {
  const fixture = await uploadFixture(t);
  // A route-level `bodyLimit` would not affect the streaming path at all —
  // Fastify only consults it inside the buffering `rawBody()` — but it would
  // raise the ceiling for a JSON body on this same path, which is parsed
  // *before* `requireUser` runs. Inheriting the app's 1 MiB keeps that window
  // as small as everywhere else.
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: {
      origin: fixture.config.webOrigin,
      "content-type": "application/json",
    },
    payload: JSON.stringify({ filler: "x".repeat(2 * 1024 * 1024) }),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error, "payload_too_large");
});

test("a body that disagrees with its declared Content-Length is refused", async (t) => {
  const fixture = await uploadFixture(t);

  // Short: the stream ends before the declared length, so only the final
  // equality assertion can catch it.
  const short = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, {
      "content-length": String(CSV_BODY.byteLength + 64),
    }),
    payload: pullCountingStream(CSV_BODY).stream,
  });
  assert.equal(short.statusCode, 400);
  assert.equal(short.json().error, "upload_length_mismatch");

  // Long: the running counter destroys the stream mid-body.
  const long = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, { "content-length": "8" }),
    payload: pullCountingStream(CSV_BODY).stream,
  });
  assert.equal(long.statusCode, 400);
  assert.equal(long.json().error, "upload_length_mismatch");
  // The rest of the body will never be read, so the connection cannot be
  // reused. Saying so is Fastify's own convention for an abandoned body — and
  // the reply still reaches the client, which destroying the request would
  // have prevented.
  assert.equal(long.headers.connection, "close");

  // Both reservations were released, so nothing counts against the tenant and
  // no partial blob survives.
  assert.equal(fixture.store.getUploadStorageUsage(fixture.owner.tenantId), 0);
  assert.deepEqual(await listFiles(fixture.config.uploadDataDir), []);
});

test("a zero-length or absent Content-Length is refused before the body is read", async (t) => {
  const fixture = await uploadFixture(t);

  const empty = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, { "content-length": "0" }),
    payload: pullCountingStream(Buffer.alloc(0)).stream,
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, "upload_empty");

  const undeclared = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture),
    payload: pullCountingStream(CSV_BODY).stream,
  });
  assert.equal(undeclared.statusCode, 400);
  assert.equal(undeclared.json().error, "validation_error");
});

test("content that is not UTF-8 text is refused and its reservation released", async (t) => {
  const fixture = await uploadFixture(t);
  // Valid UTF-8, no NUL — a magic-number table would be needed to see this as
  // a ZIP. The control-byte rule catches it instead.
  const archive = Buffer.concat([
    Buffer.from("PK", "latin1"),
    Buffer.from("payload", "utf8"),
  ]);
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, { "x-upload-filename": encodeURIComponent("bundle.zip") }),
    payload: archive,
  });
  assert.equal(response.statusCode, 415);
  assert.equal(response.json().error, "unsupported_upload_type");

  assert.equal(fixture.store.getUploadStorageUsage(fixture.owner.tenantId), 0);
  assert.deepEqual(await listFiles(fixture.config.uploadDataDir), []);
});

test("a replayed Idempotency-Key returns the same upload without storing twice", async (t) => {
  const fixture = await uploadFixture(t);
  const headers = uploadHeaders(fixture, { "idempotency-key": "upload-replay-key" });

  const first = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers,
    payload: CSV_BODY,
  });
  assert.equal(first.statusCode, 201);

  const replay = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers,
    payload: CSV_BODY,
  });
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.json(), first.json());

  assert.equal(
    fixture.store.listThreadUploads(
      fixture.owner.tenantId,
      fixture.owner.userId,
      fixture.threadId,
    ).length,
    1,
  );
  assert.equal(
    fixture.store.getUploadStorageUsage(fixture.owner.tenantId),
    CSV_BODY.byteLength,
  );

  // The same key against a different file is a conflict, not a silent replay.
  const conflict = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: { ...headers, "x-upload-filename": encodeURIComponent("other.csv") },
    payload: CSV_BODY,
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, "idempotency_conflict");

  const missingKey = { ...headers } as Record<string, string>;
  delete missingKey["idempotency-key"];
  const unkeyed = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: missingKey,
    payload: CSV_BODY,
  });
  assert.equal(unkeyed.statusCode, 400);
  assert.equal(unkeyed.json().error, "invalid_idempotency_key");
});

test("another tenant cannot read or delete an upload, and gets 404 rather than 403", async (t) => {
  const fixture = await uploadFixture(t);
  const created = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture),
    payload: CSV_BODY,
  });
  assert.equal(created.statusCode, 201);
  const uploadId = (created.json() as { upload: { id: string } }).upload.id;

  const foreignListing = await fixture.app.inject({
    method: "GET",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: { cookie: fixture.outsider.cookie },
  });
  assert.equal(foreignListing.statusCode, 404);
  assert.equal(foreignListing.json().error, "thread_not_found");

  const foreignDelete = await fixture.app.inject({
    method: "DELETE",
    url: `/api/uploads/${uploadId}`,
    headers: { cookie: fixture.outsider.cookie, origin: fixture.config.webOrigin },
  });
  assert.equal(foreignDelete.statusCode, 404);
  assert.equal(foreignDelete.json().error, "upload_not_found");

  const foreignUpload = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, { cookie: fixture.outsider.cookie }),
    payload: CSV_BODY,
  });
  assert.equal(foreignUpload.statusCode, 404);

  const foreignProjectUpload = await fixture.app.inject({
    method: "POST",
    url: `/api/projects/${fixture.project.id}/uploads`,
    headers: uploadHeaders(fixture, { cookie: fixture.outsider.cookie }),
    payload: CSV_BODY,
  });
  assert.equal(foreignProjectUpload.statusCode, 404);
  assert.equal(foreignProjectUpload.json().error, "project_not_found");

  // The row and its blob are untouched by any of it.
  const record = fixture.store.getUpload(
    fixture.owner.tenantId,
    fixture.owner.userId,
    uploadId,
  );
  assert.equal(record?.status, "stored");
  await stat(join(fixture.config.uploadDataDir, ...(record?.storageKey ?? "").split("/")));
});

test("the owner can delete an upload, and the blob goes with it", async (t) => {
  const fixture = await uploadFixture(t);
  const created = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture),
    payload: CSV_BODY,
  });
  const uploadId = (created.json() as { upload: { id: string } }).upload.id;
  const record = fixture.store.getUpload(
    fixture.owner.tenantId,
    fixture.owner.userId,
    uploadId,
  );
  assert.ok(record);
  const blobPath = join(fixture.config.uploadDataDir, ...record.storageKey.split("/"));

  const deleted = await fixture.app.inject({
    method: "DELETE",
    url: `/api/uploads/${uploadId}`,
    headers: { cookie: fixture.owner.cookie, origin: fixture.config.webOrigin },
  });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json(), { ok: true });
  await assert.rejects(() => stat(blobPath));
  assert.equal(fixture.store.getUploadStorageUsage(fixture.owner.tenantId), 0);

  // The tombstone stays as an audit anchor, and a second delete is a 404.
  assert.equal(
    fixture.store.getUpload(fixture.owner.tenantId, fixture.owner.userId, uploadId)?.status,
    "deleted",
  );
  const again = await fixture.app.inject({
    method: "DELETE",
    url: `/api/uploads/${uploadId}`,
    headers: { cookie: fixture.owner.cookie, origin: fixture.config.webOrigin },
  });
  assert.equal(again.statusCode, 404);
  assert.equal(again.json().error, "upload_not_found");
});

test("deleting an upload also removes its staged plaintext", async (t) => {
  const fixture = await uploadFixture(t);
  const created = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture),
    payload: CSV_BODY,
  });
  const uploadId = (created.json() as { upload: { id: string } }).upload.id;
  const record = fixture.store.getUpload(
    fixture.owner.tenantId,
    fixture.owner.userId,
    uploadId,
  );
  assert.ok(record?.threadId);

  // Stage it the way a turn dispatch does, so the delete has real plaintext to
  // reclaim rather than a hypothetical one.
  const paths = await prepareUserUploadPaths(fixture.config.uploadDataDir, {
    tenantId: fixture.owner.tenantId,
    userId: fixture.owner.userId,
  });
  const staged = await decryptToStaged({
    paths,
    uploadId,
    threadId: record.threadId,
    contentType: record.contentType,
    storageKey: record.storageKey,
    encryptionSecret: fixture.config.credentialEncryptionKey,
    encryptionIv: record.encryptionIv,
    encryptionTag: record.encryptionTag,
    wrappedDataKey: record.wrappedDataKey,
  });
  assert.deepEqual(await readFile(staged.path), CSV_BODY);

  const deleted = await fixture.app.inject({
    method: "DELETE",
    url: `/api/uploads/${uploadId}`,
    headers: { cookie: fixture.owner.cookie, origin: fixture.config.webOrigin },
  });
  assert.equal(deleted.statusCode, 200);
  // Ciphertext and the one turn's plaintext both go; a delete during a live
  // turn must not leave the only readable copy behind.
  await assert.rejects(() => stat(staged.path));
  assert.deepEqual(await listFiles(fixture.config.uploadDataDir), []);
});

test("a traversal-shaped filename is a label and never a path", async (t) => {
  const fixture = await uploadFixture(t);

  // A label containing a path separator is refused outright...
  for (const hostile of ["../../etc/passwd", "..\\..\\etc\\passwd", ".", "..", ""]) {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${fixture.threadId}/uploads`,
      headers: uploadHeaders(fixture, { "x-upload-filename": encodeURIComponent(hostile) }),
      payload: CSV_BODY,
    });
    assert.equal(response.statusCode, 400, `"${hostile}" must be refused`);
    assert.equal(response.json().error, "invalid_upload_filename");
  }
  // ...and percent-encoding the dots does not smuggle one through.
  const encodedDots = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, { "x-upload-filename": "%2e%2e%2fetc%2fpasswd" }),
    payload: CSV_BODY,
  });
  assert.equal(encodedDots.statusCode, 400);
  assert.equal(encodedDots.json().error, "invalid_upload_filename");
  assert.deepEqual(await listFiles(fixture.config.uploadDataDir), []);

  // A label that survives validation is stored verbatim and still contributes
  // nothing to any path: the blob is named by the server's own UUID. U+2044 is
  // a solidus look-alike, so this is as close to `../../etc/passwd` as a legal
  // label can get.
  const label = "..⁄..⁄etc⁄passwd";
  const stored = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, { "x-upload-filename": encodeURIComponent(label) }),
    payload: CSV_BODY,
  });
  assert.equal(stored.statusCode, 201);
  const body = stored.json() as { upload: { id: string; filename: string } };
  assert.equal(body.upload.filename, label);

  const files = await listFiles(fixture.config.uploadDataDir);
  assert.deepEqual(files, [body.upload.id]);
  assert.equal(
    files.some((name) => name.includes("passwd") || name.includes("..")),
    false,
  );
});

test("a user may not have more than three uploads in flight", async (t) => {
  const fixture = await uploadFixture(t);
  const gates = [gatedStream(CSV_BODY), gatedStream(CSV_BODY), gatedStream(CSV_BODY)];
  const inFlight = gates.map((gate) =>
    fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${fixture.threadId}/uploads`,
      headers: uploadHeaders(fixture, { "content-length": String(CSV_BODY.byteLength) }),
      payload: gate.stream,
    }),
  );
  // Each stream is pulled only once the slot is already held, so this resolves
  // exactly when three slots are occupied.
  await Promise.all(gates.map((gate) => gate.started));

  const rejected = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture, { "content-length": String(CSV_BODY.byteLength) }),
    payload: pullCountingStream(CSV_BODY).stream,
  });
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.json().error, "upload_concurrency_limit");

  for (const gate of gates) gate.release();
  for (const response of await Promise.all(inFlight)) {
    assert.equal(response.statusCode, 201);
  }

  // The slots are returned, so a fourth upload now succeeds.
  const afterRelease = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture),
    payload: CSV_BODY,
  });
  assert.equal(afterRelease.statusCode, 201);
});

test("the pace monitor aborts a stalled upload on both its limits", async () => {
  // The real limits are a 20 s window and a 120 s wall clock, which no test
  // should wait for. The monitor takes them as a parameter for exactly this
  // reason, so what runs here is the production code path at 1/500th scale.
  const stalled: ApiHttpError[] = [];
  const stopStalled = startUploadPaceMonitor(
    { bytes: () => 16, abort: (error) => stalled.push(error) },
    { wallClockMs: 10_000, windowMs: 40, floorBytesPerSecond: 8 * 1024, sampleIntervalMs: 10 },
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  stopStalled();
  assert.ok(stalled.length > 0, "a stream below the throughput floor must be aborted");
  assert.equal(stalled[0]?.statusCode, 408);
  assert.equal(stalled[0]?.code, "upload_timeout");

  // A stream moving fast enough is never touched.
  let fastBytes = 0;
  const fast: ApiHttpError[] = [];
  const stopFast = startUploadPaceMonitor(
    {
      bytes: () => {
        fastBytes += 64 * 1024;
        return fastBytes;
      },
      abort: (error) => fast.push(error),
    },
    { wallClockMs: 10_000, windowMs: 40, floorBytesPerSecond: 8 * 1024, sampleIntervalMs: 10 },
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  stopFast();
  assert.deepEqual(fast, []);

  // The wall clock fires regardless of throughput.
  let clockBytes = 0;
  const expired: ApiHttpError[] = [];
  const stopExpired = startUploadPaceMonitor(
    {
      bytes: () => {
        clockBytes += 64 * 1024;
        return clockBytes;
      },
      abort: (error) => expired.push(error),
    },
    { wallClockMs: 40, windowMs: 10_000, floorBytesPerSecond: 8 * 1024, sampleIntervalMs: 10 },
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  stopExpired();
  assert.ok(expired.length > 0, "the wall clock must abort a long-running upload");
  assert.equal(expired[0]?.code, "upload_timeout");
});

test("an upload to an unbound or foreign thread is reported as absent", async (t) => {
  const fixture = await uploadFixture(t);

  // This route has no runtime, so it cannot lazily bind a legacy thread the way
  // `authorizedThreadBridge` does. An unbound thread therefore reads as absent
  // — the same answer another tenant's thread gets, so ids stay un-oracle-able.
  const unbound = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks/never-bound-thread/uploads",
    headers: uploadHeaders(fixture),
    payload: CSV_BODY,
  });
  assert.equal(unbound.statusCode, 404);
  assert.equal(unbound.json().error, "thread_not_found");

  const disabled = fixture.store.updateSavedProject({
    tenantId: fixture.owner.tenantId,
    projectId: fixture.project.id,
    actorUserId: fixture.owner.userId,
    enabled: false,
  });
  assert.equal(disabled?.enabled, false);
  const toDisabledProject = await fixture.app.inject({
    method: "POST",
    url: `/api/projects/${fixture.project.id}/uploads`,
    headers: uploadHeaders(fixture),
    payload: CSV_BODY,
  });
  assert.equal(toDisabledProject.statusCode, 409);
  assert.equal(toDisabledProject.json().error, "project_disabled");

  assert.deepEqual(await listFiles(fixture.config.uploadDataDir), []);
});

// --- Finding 5: absolute store paths must never reach the Fastify logger ---

test("a failed unlink is logged as uploadId plus a reason, never as a path", async (t) => {
  const fixture = await uploadFixture(t);
  const created = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers: uploadHeaders(fixture),
    payload: CSV_BODY,
  });
  assert.equal(created.statusCode, 201);
  const uploadId = (created.json() as { upload: { id: string } }).upload.id;
  const record = fixture.store.getUpload(
    fixture.owner.tenantId,
    fixture.owner.userId,
    uploadId,
  );
  assert.ok(record?.threadId);

  // Stage the plaintext the way a turn dispatch does, so the delete has both
  // an unlink of the blob and an unlink of the staged copy to perform.
  const paths = await prepareUserUploadPaths(fixture.config.uploadDataDir, {
    tenantId: fixture.owner.tenantId,
    userId: fixture.owner.userId,
  });
  const staged = await decryptToStaged({
    paths,
    uploadId,
    threadId: record.threadId,
    contentType: record.contentType,
    storageKey: record.storageKey,
    encryptionSecret: fixture.config.credentialEncryptionKey,
    encryptionIv: record.encryptionIv,
    encryptionTag: record.encryptionTag,
    wrappedDataKey: record.wrappedDataKey,
  });

  // Replace both files with directories: `unlink` then fails with a
  // path-bearing errno (EPERM on macOS, EISDIR on Linux) rather than the
  // ENOENT the route treats as the ordinary "already gone" case.
  const blobPath = join(fixture.config.uploadDataDir, ...record.storageKey.split("/"));
  for (const path of [blobPath, staged.path]) {
    await rm(path, { force: true });
    await mkdir(path, { recursive: true });
  }

  const captured = captureAppLog(fixture.app);
  const deleted = await fixture.app.inject({
    method: "DELETE",
    url: `/api/uploads/${uploadId}`,
    headers: { cookie: fixture.owner.cookie, origin: fixture.config.webOrigin },
  });
  assert.equal(deleted.statusCode, 200);

  // Both unlinks failed, so both log calls ran and there is something to check.
  assert.ok(captured.length >= 2, `expected two log lines, got ${captured.length}`);

  // Design §6: "the Fastify logger never receives the label or a path; only
  // uploadId". A raw `fs` error carries the absolute store path in `message`,
  // `stack` and the enumerable `path` — all three are rendered here.
  const rendered = renderLog(captured);
  assert.equal(
    rendered.includes(fixture.config.uploadDataDir),
    false,
    `log leaked the upload store path: ${rendered}`,
  );
  assert.equal(rendered.includes(record.storageKey), false, "log leaked the storage key");
  assert.equal(rendered.includes(uploadId.slice(0, 2)) && rendered.includes("blobs"), false);
  assert.equal(rendered.includes("report.csv"), false, "log leaked the display label");

  for (const entry of captured) {
    assert.deepEqual(
      Object.keys(entry.payload as Record<string, unknown>).sort(),
      ["reason", "uploadId"],
      `unexpected log payload: ${JSON.stringify(entry.payload)}`,
    );
    const payload = entry.payload as { uploadId: string; reason: string };
    assert.equal(payload.uploadId, uploadId);
    // Bounded alphabet: a reason cannot smuggle a path through it.
    assert.match(payload.reason, /^[A-Za-z0-9_]{1,32}$/);
  }
});

// --- Finding 7: a repeated single-value header must not be silently merged ---

test("a repeated single-value header is refused rather than comma-joined", async (t) => {
  const fixture = await uploadFixture(t);
  await fixture.app.listen({ host: "127.0.0.1", port: 0 });

  const base: ReadonlyArray<readonly [string, string]> = [
    ["origin", fixture.config.webOrigin],
    ["cookie", fixture.owner.cookie],
    ["content-type", "application/octet-stream"],
    ["content-length", String(CSV_BODY.byteLength)],
  ];
  const url = `/api/tasks/${fixture.threadId}/uploads`;

  // Node comma-joins both of these into one string, so the array form a
  // `typeof value === "string"` guard watches for never appears: without the
  // rawHeaders count these are 201s with a merged label and a merged key.
  const duplicateLabel = await rawRequest(fixture.app, {
    method: "POST",
    path: url,
    headers: [
      ...base,
      ["idempotency-key", "dup-label"],
      ["x-upload-filename", encodeURIComponent("a.csv")],
      ["x-upload-filename", encodeURIComponent("b.csv")],
    ],
    body: CSV_BODY,
  });
  assert.equal(duplicateLabel.status, 400);
  assert.equal(duplicateLabel.json?.error, "invalid_upload_filename");

  const duplicateKey = await rawRequest(fixture.app, {
    method: "POST",
    path: url,
    headers: [
      ...base,
      ["x-upload-filename", encodeURIComponent("report.csv")],
      ["idempotency-key", "dup-key-one"],
      ["idempotency-key", "dup-key-two"],
    ],
    body: CSV_BODY,
  });
  assert.equal(duplicateKey.status, 400);
  assert.equal(duplicateKey.json?.error, "invalid_idempotency_key");

  // A second content-type would otherwise choose the parser from the first
  // copy while the caller believed the second.
  const duplicateType = await rawRequest(fixture.app, {
    method: "POST",
    path: url,
    headers: [
      ["origin", fixture.config.webOrigin],
      ["cookie", fixture.owner.cookie],
      ["content-type", "application/octet-stream"],
      ["content-type", "text/plain"],
      ["content-length", String(CSV_BODY.byteLength)],
      ["idempotency-key", "dup-type"],
      ["x-upload-filename", encodeURIComponent("report.csv")],
    ],
    body: CSV_BODY,
  });
  assert.equal(duplicateType.status, 415);
  assert.equal(duplicateType.json?.error, "unsupported_media_type");

  // Nothing was stored by any of them, and no reservation was left behind.
  assert.deepEqual(await listFiles(fixture.config.uploadDataDir), []);
  assert.equal(fixture.store.getUploadStorageUsage(fixture.owner.tenantId), 0);

  // The control: the same transport, one copy of each header, still works — so
  // the check refuses duplication rather than the socket path itself.
  const single = await rawRequest(fixture.app, {
    method: "POST",
    path: url,
    headers: [
      ...base,
      ["idempotency-key", "single-headers"],
      ["x-upload-filename", encodeURIComponent("report.csv")],
    ],
    body: CSV_BODY,
  });
  assert.equal(single.status, 201);
  assert.equal(
    (single.json?.upload as { filename: string } | undefined)?.filename,
    "report.csv",
  );
});

// --- Finding 8: a reused key must not replay a receipt for other bytes ---

test("a reused Idempotency-Key with different bytes is a conflict, not a replay", async (t) => {
  const fixture = await uploadFixture(t);
  // Same label, same length, different content — the exact collision the
  // fingerprint [scope, targetId, filename, declaredLength] cannot see.
  const other = Buffer.from(CSV_BODY.toString("utf8").toUpperCase(), "utf8");
  assert.equal(other.byteLength, CSV_BODY.byteLength);
  assert.notDeepEqual(other, CSV_BODY);

  const headers = uploadHeaders(fixture, { "idempotency-key": "upload-content-collision" });
  const first = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers,
    payload: CSV_BODY,
  });
  assert.equal(first.statusCode, 201);
  const uploadId = (first.json() as { upload: { id: string } }).upload.id;

  const collision = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers,
    payload: other,
  });
  assert.equal(
    collision.statusCode,
    409,
    `a different file under a spent key must not be answered with ${collision.statusCode}`,
  );
  assert.equal(collision.json().error, "idempotency_conflict");

  // The stored bytes are still the first file's, and the second file was
  // neither stored nor charged to the tenant.
  assert.equal(
    fixture.store.listThreadUploads(
      fixture.owner.tenantId,
      fixture.owner.userId,
      fixture.threadId,
    ).length,
    1,
  );
  assert.equal(
    fixture.store.getUploadStorageUsage(fixture.owner.tenantId),
    CSV_BODY.byteLength,
  );
  const record = fixture.store.getUpload(
    fixture.owner.tenantId,
    fixture.owner.userId,
    uploadId,
  );
  assert.ok(record);
  const paths = await prepareUserUploadPaths(fixture.config.uploadDataDir, {
    tenantId: fixture.owner.tenantId,
    userId: fixture.owner.userId,
  });
  const staged = await decryptToStaged({
    paths,
    uploadId,
    threadId: fixture.threadId,
    contentType: record.contentType,
    storageKey: record.storageKey,
    encryptionSecret: fixture.config.credentialEncryptionKey,
    encryptionIv: record.encryptionIv,
    encryptionTag: record.encryptionTag,
    wrappedDataKey: record.wrappedDataKey,
  });
  assert.deepEqual(await readFile(staged.path), CSV_BODY);

  // An honest retry — the same key with the same bytes — still replays, so the
  // check refuses a mismatch rather than idempotency itself.
  const retry = await fixture.app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.threadId}/uploads`,
    headers,
    payload: CSV_BODY,
  });
  assert.equal(retry.statusCode, 201);
  assert.deepEqual(retry.json(), first.json());
});
