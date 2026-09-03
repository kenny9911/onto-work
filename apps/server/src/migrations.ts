import { createHash } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

interface DatabaseMigration {
  version: number;
  name: string;
  sql: string;
}

const INITIAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
    status TEXT NOT NULL CHECK(status IN ('active', 'suspended')),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_digest TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS provider_connections (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL,
    name TEXT NOT NULL,
    adapter TEXT NOT NULL CHECK(adapter IN ('responses', 'litellm', 'ollama')),
    base_url TEXT,
    default_model TEXT,
    credential_ciphertext TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant_id, catalog_id, name)
  );
  CREATE INDEX IF NOT EXISTS providers_tenant_id ON provider_connections(tenant_id);

  CREATE TABLE IF NOT EXISTS subscriptions (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    plan TEXT NOT NULL CHECK(plan IN ('free', 'pro', 'team', 'enterprise')),
    status TEXT NOT NULL,
    seats INTEGER NOT NULL DEFAULT 1,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    current_period_end TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_tenant_created ON audit_logs(tenant_id, created_at DESC);
`;

const PRODUCTION_FOUNDATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS entitlement_snapshots (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK(version > 0),
    plan TEXT NOT NULL CHECK(plan IN ('free', 'pro', 'team', 'enterprise')),
    status TEXT NOT NULL CHECK(status IN ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'none')),
    seat_limit INTEGER NOT NULL CHECK(seat_limit > 0),
    active_run_limit INTEGER NOT NULL CHECK(active_run_limit > 0),
    request_limit INTEGER NOT NULL CHECK(request_limit > 0),
    period_start TEXT NOT NULL,
    period_end TEXT,
    allowed_route_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, version)
  );
  CREATE INDEX IF NOT EXISTS entitlement_tenant_version
    ON entitlement_snapshots(tenant_id, version DESC);

  CREATE TABLE IF NOT EXISTS workspace_grants (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    root_path TEXT NOT NULL,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE(tenant_id, root_path)
  );
  CREATE INDEX IF NOT EXISTS workspace_grants_tenant
    ON workspace_grants(tenant_id, root_path);

  CREATE TABLE IF NOT EXISTS usage_reservations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_connection_id TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
    route_catalog_id TEXT NOT NULL,
    model TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('thread_start', 'turn_start')),
    workspace_path TEXT,
    thread_id TEXT,
    turn_id TEXT,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reserved', 'completed', 'failed', 'expired')),
    response_json TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(tenant_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS usage_reservations_active
    ON usage_reservations(tenant_id, status, expires_at);
  CREATE INDEX IF NOT EXISTS usage_reservations_period
    ON usage_reservations(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    reservation_id TEXT NOT NULL REFERENCES usage_reservations(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(reservation_id, event_key)
  );
  CREATE INDEX IF NOT EXISTS usage_events_tenant_created
    ON usage_events(tenant_id, created_at);

  INSERT INTO entitlement_snapshots (
    tenant_id, version, plan, status, seat_limit, active_run_limit, request_limit,
    period_start, period_end, allowed_route_ids_json, created_at
  )
  SELECT
    subscriptions.tenant_id,
    1,
    subscriptions.plan,
    CASE
      WHEN subscriptions.plan = 'free' AND subscriptions.status = 'none' THEN 'active'
      ELSE subscriptions.status
    END,
    MAX(1, subscriptions.seats),
    CASE subscriptions.plan
      WHEN 'free' THEN 1
      WHEN 'pro' THEN 4
      WHEN 'team' THEN 16
      ELSE 64
    END,
    CASE subscriptions.plan
      WHEN 'free' THEN 1000
      WHEN 'pro' THEN 10000
      WHEN 'team' THEN 100000
      ELSE 1000000
    END,
    subscriptions.created_at,
    subscriptions.current_period_end,
    '["*"]',
    subscriptions.updated_at
  FROM subscriptions
  WHERE NOT EXISTS (
    SELECT 1 FROM entitlement_snapshots
    WHERE entitlement_snapshots.tenant_id = subscriptions.tenant_id
  );
`;

const THREAD_OWNERSHIP_AND_USAGE_SAFETY_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_id_id
    ON users(tenant_id, id);

  CREATE TABLE IF NOT EXISTS thread_workspace_bindings (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, user_id, thread_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS thread_workspace_bindings_workspace
    ON thread_workspace_bindings(tenant_id, workspace_path);

  CREATE UNIQUE INDEX IF NOT EXISTS usage_reservation_turn_correlation
    ON usage_reservations(tenant_id, user_id, thread_id, turn_id)
    WHERE operation = 'turn_start' AND turn_id IS NOT NULL;

  CREATE TRIGGER IF NOT EXISTS usage_events_tenant_guard_insert
  BEFORE INSERT ON usage_events
  WHEN NOT EXISTS (
    SELECT 1
    FROM usage_reservations
    WHERE id = NEW.reservation_id AND tenant_id = NEW.tenant_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'usage event tenant mismatch');
  END;

  CREATE TRIGGER IF NOT EXISTS usage_events_tenant_guard_update
  BEFORE UPDATE OF tenant_id, reservation_id ON usage_events
  WHEN NOT EXISTS (
    SELECT 1
    FROM usage_reservations
    WHERE id = NEW.reservation_id AND tenant_id = NEW.tenant_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'usage event tenant mismatch');
  END;
`;

const BILLING_DURABILITY_SCHEMA = `
  ALTER TABLE subscriptions ADD COLUMN current_period_start TEXT;
  ALTER TABLE subscriptions ADD COLUMN last_stripe_event_created INTEGER;
  ALTER TABLE subscriptions ADD COLUMN last_stripe_event_id TEXT;

  UPDATE subscriptions
  SET current_period_start = COALESCE(
    (
      SELECT period_start
      FROM entitlement_snapshots
      WHERE entitlement_snapshots.tenant_id = subscriptions.tenant_id
      ORDER BY version DESC
      LIMIT 1
    ),
    created_at
  )
  WHERE current_period_start IS NULL;

  CREATE TABLE billing_webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    object_id TEXT,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
    stripe_created INTEGER NOT NULL CHECK(stripe_created >= 0),
    outcome TEXT NOT NULL CHECK(outcome IN ('applied', 'stale', 'ignored')),
    processed_at TEXT NOT NULL
  );
  CREATE INDEX billing_webhook_events_tenant_processed
    ON billing_webhook_events(tenant_id, processed_at DESC);
`;

const BILLING_UNIQUENESS_SCHEMA = `
  CREATE UNIQUE INDEX subscriptions_stripe_subscription_unique
    ON subscriptions(stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;
  CREATE UNIQUE INDEX subscriptions_stripe_customer_unique
    ON subscriptions(stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;
`;

const SAVED_PROJECTS_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS projects_workspace_grants_tenant_id_id
    ON workspace_grants(tenant_id, id);

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant_id, id)
  );
  CREATE INDEX projects_tenant_enabled_updated
    ON projects(tenant_id, enabled, updated_at DESC);

  CREATE TABLE project_workspaces (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    workspace_grant_id TEXT REFERENCES workspace_grants(id) ON DELETE SET NULL,
    canonical_path TEXT NOT NULL CHECK(length(canonical_path) > 0),
    kind TEXT NOT NULL DEFAULT 'existing' CHECK(kind = 'existing'),
    is_primary INTEGER NOT NULL DEFAULT 1 CHECK(is_primary IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (tenant_id, project_id)
      REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
    UNIQUE(tenant_id, canonical_path)
  );
  CREATE UNIQUE INDEX project_workspaces_primary
    ON project_workspaces(tenant_id, project_id)
    WHERE is_primary = 1;
  CREATE INDEX project_workspaces_project
    ON project_workspaces(tenant_id, project_id, is_primary);

  CREATE TRIGGER project_workspaces_scope_guard_insert
  BEFORE INSERT ON project_workspaces
  WHEN NOT EXISTS (
    SELECT 1 FROM projects
    WHERE id = NEW.project_id AND tenant_id = NEW.tenant_id
  ) OR NEW.workspace_grant_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM workspace_grants
    WHERE id = NEW.workspace_grant_id AND tenant_id = NEW.tenant_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'project workspace tenant or grant mismatch');
  END;

  CREATE TRIGGER project_workspaces_scope_guard_update
  BEFORE UPDATE OF tenant_id, project_id, workspace_grant_id ON project_workspaces
  WHEN NOT EXISTS (
    SELECT 1 FROM projects
    WHERE id = NEW.project_id AND tenant_id = NEW.tenant_id
  ) OR (
    NEW.workspace_grant_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM workspace_grants
      WHERE id = NEW.workspace_grant_id AND tenant_id = NEW.tenant_id
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'project workspace tenant or grant mismatch');
  END;
`;

const TASK_MUTATION_IDEMPOTENCY_SCHEMA = `
  CREATE TABLE task_mutations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 255),
    action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 128),
    target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 256),
    request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
    status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
    response_json TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (tenant_id, user_id)
      REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    UNIQUE(tenant_id, user_id, idempotency_key)
  );
  CREATE INDEX task_mutations_pending
    ON task_mutations(tenant_id, user_id, status, expires_at);
`;

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  { version: 1, name: "initial_control_plane", sql: INITIAL_SCHEMA },
  { version: 2, name: "production_foundation", sql: PRODUCTION_FOUNDATION_SCHEMA },
  {
    version: 3,
    name: "thread_ownership_and_usage_safety",
    sql: THREAD_OWNERSHIP_AND_USAGE_SAFETY_SCHEMA,
  },
  {
    version: 4,
    name: "billing_durability",
    sql: BILLING_DURABILITY_SCHEMA,
  },
  {
    version: 5,
    name: "billing_uniqueness",
    sql: BILLING_UNIQUENESS_SCHEMA,
  },
  {
    version: 6,
    name: "saved_projects",
    sql: SAVED_PROJECTS_SCHEMA,
  },
  {
    version: 7,
    name: "task_mutation_idempotency",
    sql: TASK_MUTATION_IDEMPOTENCY_SCHEMA,
  },
] as const;

function migrationChecksum(migration: DatabaseMigration): string {
  return createHash("sha256")
    .update(String(migration.version))
    .update("\0")
    .update(migration.name)
    .update("\0")
    .update(migration.sql)
    .digest("hex");
}

export function applyDatabaseMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = database
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as unknown as Array<{ version: number; name: string; checksum: string }>;
  const byVersion = new Map(applied.map((migration) => [migration.version, migration]));
  const knownVersions = new Set(DATABASE_MIGRATIONS.map((migration) => migration.version));
  const unknown = applied.find((migration) => !knownVersions.has(migration.version));
  if (unknown) {
    throw new Error(
      `Database migration ${unknown.version} is newer than or unknown to this Agent Harness build`,
    );
  }

  for (const migration of DATABASE_MIGRATIONS) {
    const checksum = migrationChecksum(migration);
    const existing = byVersion.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== checksum) {
        throw new Error(`Database migration ${migration.version} no longer matches its applied checksum`);
      }
      continue;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have applied this migration while this connection
      // was waiting for the write lock. Re-check after acquiring it so
      // concurrent server startups remain safe.
      const concurrentlyApplied = database
        .prepare("SELECT name, checksum FROM schema_migrations WHERE version = ?")
        .get(migration.version) as unknown as { name: string; checksum: string } | undefined;
      if (concurrentlyApplied) {
        if (
          concurrentlyApplied.name !== migration.name ||
          concurrentlyApplied.checksum !== checksum
        ) {
          throw new Error(
            `Database migration ${migration.version} no longer matches its applied checksum`,
          );
        }
        database.exec("COMMIT");
        continue;
      }

      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, checksum, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
