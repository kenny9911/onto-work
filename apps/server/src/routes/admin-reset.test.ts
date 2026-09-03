import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessStore } from "../database.js";
import { verifyPassword } from "../security.js";

test("explicit bootstrap reset rotates an admin password and invalidates sessions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-admin-reset-"));
  const store = new HarnessStore(join(directory, "harness.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const user = await store.bootstrapAdmin("reset-admin", "temporary-password");
  await store.changePassword(user.id, "previous-strong-password");
  store.createSession("existing-session", user.id, new Date(Date.now() + 60_000).toISOString());

  const reset = await store.resetBootstrapAdminPassword("reset-admin", "new-temporary-password");
  assert.equal(reset?.mustChangePassword, true);
  assert.equal(store.getSessionUser("existing-session"), null);

  const passwordHash = store.getPasswordHash(user.id);
  assert.ok(passwordHash);
  assert.equal(await verifyPassword("new-temporary-password", passwordHash), true);
  assert.equal(await verifyPassword("previous-strong-password", passwordHash), false);

  const audit = store.db
    .prepare("SELECT action, target_id FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(user.tenantId) as { action: string; target_id: string };
  assert.equal(audit.action, "auth.bootstrap_password_reset");
  assert.equal(audit.target_id, user.id);
});

test("bootstrap reset refuses non-admin and unknown usernames", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-admin-reset-"));
  const store = new HarnessStore(join(directory, "harness.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const admin = await store.bootstrapAdmin("reset-owner", "temporary-password");
  const entitlement = store.getLatestEntitlementSnapshot(admin.tenantId)!;
  store.createEntitlementSnapshot({
    tenantId: admin.tenantId,
    plan: entitlement.plan,
    status: entitlement.status,
    seatLimit: 2,
    activeRunLimit: entitlement.activeRunLimit,
    requestLimit: entitlement.requestLimit,
    periodStart: entitlement.periodStart,
    periodEnd: entitlement.periodEnd,
    allowedRouteIds: entitlement.allowedRouteIds,
  });
  await store.createUser({
    tenantId: admin.tenantId,
    username: "reset-member",
    displayName: "Reset member",
    password: "member-password",
    role: "member",
  });

  assert.equal(await store.resetBootstrapAdminPassword("reset-member", "replacement-password"), null);
  assert.equal(await store.resetBootstrapAdminPassword("missing", "replacement-password"), null);
});
