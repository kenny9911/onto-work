import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { HarnessStore } from "../database.js";
import { requireAdmin } from "../http.js";

const auditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().uuid().optional(),
  })
  .strict();

export function registerAuditRoutes(
  app: FastifyInstance,
  input: { store: HarnessStore },
): void {
  const { store } = input;
  app.get("/api/audit", async (request) => {
    const actor = requireAdmin(request, store);
    const { limit, cursor } = auditQuerySchema.parse(request.query);
    return store.listAuditEventPage(actor.tenantId, limit, cursor);
  });
}
