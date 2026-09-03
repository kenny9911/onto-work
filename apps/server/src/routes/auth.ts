import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { HarnessConfig } from "../config.js";
import type { HarnessStore } from "../database.js";
import {
  ApiHttpError,
  clearSessionCookie,
  optionalUser,
  readSessionToken,
  requireUser,
  sessionExpiresAt,
  setSessionCookie,
} from "../http.js";
import { hashPassword, opaqueToken, verifyPassword } from "../security.js";

const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(128),
    password: z.string().min(1).max(4_096),
  })
  .strict();

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(4_096),
    newPassword: z.string().min(12).max(4_096),
  })
  .strict();

export async function registerAuthRoutes(
  app: FastifyInstance,
  input: { store: HarnessStore; config: HarnessConfig },
): Promise<void> {
  const { store, config } = input;
  const dummyPasswordHash = await hashPassword(opaqueToken());

  app.post(
    "/api/auth/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const row = store.getUserByUsername(body.username);
      const passwordMatches = await verifyPassword(
        body.password,
        row?.password_hash ?? dummyPasswordHash,
      );

      if (!row || !passwordMatches || row.status !== "active") {
        if (row) {
          store.audit({
            tenantId: row.tenant_id,
            userId: row.id,
            action: "auth.login_failed",
            targetType: "user",
            targetId: row.id,
            metadata: { reason: row.status === "active" ? "invalid_credentials" : "inactive" },
          });
        }
        throw new ApiHttpError(401, "invalid_credentials", "Invalid username or password.");
      }

      store.deleteExpiredSessions();
      const token = opaqueToken();
      store.createSession(token, row.id, sessionExpiresAt(config));
      store.recordLogin(row.id);
      const user = store.getUserSummary(row.id)!;
      store.audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: "auth.login_succeeded",
        targetType: "session",
      });
      setSessionCookie(reply, token, config);
      return { user };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const user = optionalUser(request, store);
    const token = readSessionToken(request);
    if (token) store.deleteSession(token);
    if (user) {
      store.audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: "auth.logout",
        targetType: "session",
      });
    }
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    const user = requireUser(request, store, { allowPasswordChange: true });
    return { user };
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const user = requireUser(request, store, { allowPasswordChange: true });
    const body = changePasswordSchema.parse(request.body);
    const passwordHash = store.getPasswordHash(user.id);
    if (!passwordHash || !(await verifyPassword(body.currentPassword, passwordHash))) {
      throw new ApiHttpError(400, "invalid_current_password", "The current password is incorrect.");
    }
    if (await verifyPassword(body.newPassword, passwordHash)) {
      throw new ApiHttpError(400, "password_reused", "Choose a different password.");
    }

    await store.changePassword(user.id, body.newPassword);
    const token = opaqueToken();
    store.createSession(token, user.id, sessionExpiresAt(config));
    setSessionCookie(reply, token, config);
    store.audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: "auth.password_changed",
      targetType: "user",
      targetId: user.id,
    });
    return { user: store.getUserSummary(user.id) };
  });
}

