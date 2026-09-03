import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { UserRole, UserStatus, UserSummary } from "@agent-harness/contracts";
import { SeatLimitExceededError, type HarnessStore } from "../database.js";
import { ApiHttpError, requireAdmin } from "../http.js";

const userIdSchema = z.object({ userId: z.string().uuid() });

const createUserSchema = z
  .object({
    username: z.string().trim().min(3).max(128).regex(/^[a-zA-Z0-9._-]+$/),
    displayName: z.string().trim().min(1).max(160),
    password: z.string().min(12).max(4_096),
    role: z.enum(["admin", "member"]).default("member"),
  })
  .strict();

const updateUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160).optional(),
    role: z.enum(["admin", "member"]).optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Supply at least one field to update.");

const statusSchema = z.object({ status: z.enum(["active", "suspended"]) }).strict();

function tenantUser(store: HarnessStore, tenantId: string, userId: string): UserSummary {
  const user = store.listUsers(tenantId).find((candidate) => candidate.id === userId);
  if (!user) throw new ApiHttpError(404, "user_not_found", "User not found.");
  return user;
}

function assertAdminContinuity(
  users: UserSummary[],
  target: UserSummary,
  nextRole: UserRole,
  nextStatus: UserStatus,
): void {
  if (target.role !== "admin" || target.status !== "active") return;
  if (nextRole === "admin" && nextStatus === "active") return;
  const otherActiveAdmin = users.some(
    (user) => user.id !== target.id && user.role === "admin" && user.status === "active",
  );
  if (!otherActiveAdmin) {
    throw new ApiHttpError(
      409,
      "last_admin_required",
      "Create or activate another administrator before changing this account.",
    );
  }
}

function assertSeatAvailableForActivation(
  store: HarnessStore,
  tenantId: string,
  users: readonly UserSummary[],
  target: UserSummary,
  nextStatus: UserStatus,
): void {
  if (target.status === "active" || nextStatus !== "active") return;
  const entitlement = store.getLatestEntitlementSnapshot(tenantId);
  if (!entitlement) {
    throw new ApiHttpError(
      409,
      "entitlement_missing",
      "The workspace has no current seat entitlement.",
    );
  }
  const activeSeats = users.filter((user) => user.status === "active").length;
  if (activeSeats >= entitlement.seatLimit) {
    throw new ApiHttpError(
      409,
      "seat_limit_reached",
      `The workspace seat limit of ${entitlement.seatLimit} has been reached.`,
    );
  }
}

function updateUser(
  store: HarnessStore,
  actor: UserSummary,
  targetId: string,
  changes: { displayName?: string; role?: UserRole; status?: UserStatus },
): UserSummary {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const users = store.listUsers(actor.tenantId);
    const target = users.find((user) => user.id === targetId);
    if (!target) throw new ApiHttpError(404, "user_not_found", "User not found.");

    const nextRole = changes.role ?? target.role;
    const nextStatus = changes.status ?? target.status;
    if (actor.id === target.id && nextStatus === "suspended") {
      throw new ApiHttpError(409, "cannot_suspend_self", "You cannot suspend your own account.");
    }
    assertAdminContinuity(users, target, nextRole, nextStatus);
    assertSeatAvailableForActivation(
      store,
      actor.tenantId,
      users,
      target,
      nextStatus,
    );

    store.db
      .prepare(
        "UPDATE users SET display_name = ?, role = ?, status = ? WHERE tenant_id = ? AND id = ?",
      )
      .run(
        changes.displayName ?? target.displayName,
        nextRole,
        nextStatus,
        actor.tenantId,
        target.id,
      );
    if (nextStatus === "suspended") {
      store.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    }
    store.audit({
      tenantId: actor.tenantId,
      userId: actor.id,
      action: "user.updated",
      targetType: "user",
      targetId: target.id,
      metadata: {
        displayNameChanged:
          changes.displayName !== undefined && changes.displayName !== target.displayName,
        previousRole: target.role,
        role: nextRole,
        previousStatus: target.status,
        status: nextStatus,
      },
    });
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }

  return tenantUser(store, actor.tenantId, targetId);
}

export function registerUserRoutes(
  app: FastifyInstance,
  input: { store: HarnessStore },
): void {
  const { store } = input;

  app.get("/api/users", async (request) => {
    const actor = requireAdmin(request, store);
    return { users: store.listUsers(actor.tenantId) };
  });

  app.get("/api/users/:userId", async (request) => {
    const actor = requireAdmin(request, store);
    const { userId } = userIdSchema.parse(request.params);
    return { user: tenantUser(store, actor.tenantId, userId) };
  });

  app.post("/api/users", async (request, reply) => {
    const actor = requireAdmin(request, store);
    const body = createUserSchema.parse(request.body);
    let user: UserSummary;
    try {
      user = await store.createUser({ tenantId: actor.tenantId, ...body });
    } catch (error) {
      if (error instanceof SeatLimitExceededError) {
        throw new ApiHttpError(
          409,
          "seat_limit_reached",
          `The workspace seat limit of ${error.seatLimit} has been reached.`,
        );
      }
      throw error;
    }
    store.audit({
      tenantId: actor.tenantId,
      userId: actor.id,
      action: "user.created",
      targetType: "user",
      targetId: user.id,
      metadata: { role: user.role },
    });
    return reply.status(201).send({ user });
  });

  app.patch("/api/users/:userId", async (request) => {
    const actor = requireAdmin(request, store);
    const { userId } = userIdSchema.parse(request.params);
    const changes = updateUserSchema.parse(request.body);
    return { user: updateUser(store, actor, userId, changes) };
  });

  app.patch("/api/users/:userId/status", async (request) => {
    const actor = requireAdmin(request, store);
    const { userId } = userIdSchema.parse(request.params);
    const { status } = statusSchema.parse(request.body);
    return { user: updateUser(store, actor, userId, { status }) };
  });

  app.delete("/api/users/:userId", async (request, reply) => {
    const actor = requireAdmin(request, store);
    const { userId } = userIdSchema.parse(request.params);
    if (actor.id === userId) {
      throw new ApiHttpError(409, "cannot_delete_self", "You cannot delete your own account.");
    }

    store.db.exec("BEGIN IMMEDIATE");
    try {
      const users = store.listUsers(actor.tenantId);
      const target = users.find((user) => user.id === userId);
      if (!target) throw new ApiHttpError(404, "user_not_found", "User not found.");
      assertAdminContinuity(users, target, "member", "suspended");
      const result = store.db
        .prepare("DELETE FROM users WHERE tenant_id = ? AND id = ?")
        .run(actor.tenantId, userId);
      if (result.changes !== 1) {
        throw new ApiHttpError(404, "user_not_found", "User not found.");
      }
      store.audit({
        tenantId: actor.tenantId,
        userId: actor.id,
        action: "user.deleted",
        targetType: "user",
        targetId: userId,
        metadata: { username: target.username, role: target.role },
      });
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }

    return reply.status(204).send();
  });
}
