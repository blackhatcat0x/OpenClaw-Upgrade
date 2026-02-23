/**
 * Express route handlers for the agent activity feed API.
 *
 * Routes (registered server-side only):
 *   GET  /api/agents/:id/activity       → list recent activity for an agent
 *   GET  /api/agents/activity           → list recent activity for all agents
 *
 * These endpoints are read-only for the UI. The POST path is internal
 * (ActivityFeedStore.append) and NOT exposed to clients.
 */

import type { Request, Response, Router } from "express";
import type { ActivityFeedStore } from "./ActivityFeedStore.js";

export function registerActivityRoutes(router: Router, feed: ActivityFeedStore): void {
  // GET /api/agents/:id/activity?limit=20
  router.get("/agents/:id/activity", (req: Request, res: Response) => {
    const agentId = req.params.id;
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);

    if (!agentId) {
      res.status(400).json({ error: "agentId required" });
      return;
    }

    const entries = feed.list(agentId, limit);
    res.json({ agentId, entries });
  });

  // GET /api/agents/activity?limit=50
  router.get("/agents/activity", (_req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(_req.query.limit ?? "50"), 10), 200);
    const entries = feed.listAll(limit);
    res.json({ entries });
  });
}
