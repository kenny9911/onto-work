import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserSummary } from "@agent-harness/contracts";
import type { HarnessConfig } from "./config.js";
import type { HarnessStore } from "./database.js";

export const SESSION_COOKIE_NAME = "agent_harness_session";

export class ApiHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiHttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function readSessionToken(request: FastifyRequest): string | null {
  const cookie = request.cookies[SESSION_COOKIE_NAME];
  if (!cookie) return null;

  const unsigned = request.unsignCookie(cookie);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

export function optionalUser(
  request: FastifyRequest,
  store: HarnessStore,
): UserSummary | null {
  const token = readSessionToken(request);
  return token ? store.getSessionUser(token) : null;
}

export function requireUser(
  request: FastifyRequest,
  store: HarnessStore,
  options: { allowPasswordChange?: boolean } = {},
): UserSummary {
  const user = optionalUser(request, store);
  if (!user) {
    throw new ApiHttpError(401, "unauthenticated", "Sign in to continue.");
  }
  if (user.mustChangePassword && !options.allowPasswordChange) {
    throw new ApiHttpError(
      403,
      "password_change_required",
      "Change the temporary password before continuing.",
    );
  }
  return user;
}

export function requireAdmin(request: FastifyRequest, store: HarnessStore): UserSummary {
  const user = requireUser(request, store);
  if (user.role !== "admin") {
    throw new ApiHttpError(403, "forbidden", "Administrator access is required.");
  }
  return user;
}

function secureCookie(config: HarnessConfig): boolean {
  try {
    return new URL(config.publicAppUrl).protocol === "https:";
  } catch {
    return process.env.NODE_ENV === "production";
  }
}

export function setSessionCookie(
  reply: FastifyReply,
  rawToken: string,
  config: HarnessConfig,
): void {
  reply.setCookie(SESSION_COOKIE_NAME, rawToken, {
    path: "/",
    httpOnly: true,
    secure: secureCookie(config),
    sameSite: "lax",
    signed: true,
    maxAge: Math.floor(config.sessionTtlMs / 1_000),
  });
}

export function clearSessionCookie(reply: FastifyReply, config: HarnessConfig): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    secure: secureCookie(config),
    sameSite: "lax",
    signed: true,
  });
}

export function sessionExpiresAt(config: HarnessConfig): string {
  return new Date(Date.now() + config.sessionTtlMs).toISOString();
}

