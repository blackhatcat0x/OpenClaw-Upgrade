/**
 * BrowserManager: manages persistent, per-agent Chromium browser sessions.
 *
 * Each agent gets its own Chromium user-data-dir so cookies, local storage,
 * and auth state persist between runs.
 *
 * Uses playwright-core (already a dependency). Attach-on-demand: the browser
 * is only launched when the agent needs it and is reused until explicitly closed.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { chromium } from "playwright-core";

type AgentSession = {
  browser: Browser;
  context: BrowserContext;
  profileDir: string;
  lastUsedAt: number;
};

/** How long an idle browser session is kept alive before auto-closing */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export class BrowserManager {
  private sessions = new Map<string, AgentSession>();
  private gcTimer?: ReturnType<typeof setInterval>;
  private readonly profilesBaseDir: string;

  constructor(profilesBaseDir: string) {
    this.profilesBaseDir = profilesBaseDir;
    // Periodically close idle sessions to free resources
    this.gcTimer = setInterval(() => void this.gcIdleSessions(), 60_000);
  }

  /** Return (launching if needed) the BrowserContext for a given agentId */
  async getContext(agentId: string): Promise<BrowserContext> {
    const existing = this.sessions.get(agentId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.context;
    }

    const profileDir = this.resolveProfileDir(agentId);
    await mkdir(profileDir, { recursive: true });

    // Launch persistent context so login state is preserved across runs
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
      viewport: { width: 1280, height: 800 },
    });

    // Playwright persistent contexts don't expose a separate Browser object;
    // we use a sentinel value for compatibility.
    const session: AgentSession = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      browser: null as any,
      context,
      profileDir,
      lastUsedAt: Date.now(),
    };

    this.sessions.set(agentId, session);
    return context;
  }

  /** Close the browser session for an agent */
  async closeSession(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;
    this.sessions.delete(agentId);
    try {
      await session.context.close();
    } catch {
      // Ignore close errors
    }
  }

  /** Close all sessions */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.allSettled(ids.map((id) => this.closeSession(id)));
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
  }

  private resolveProfileDir(agentId: string): string {
    const hash = createHash("sha256").update(agentId).digest("hex").slice(0, 16);
    return join(this.profilesBaseDir, `agent-profile-${hash}`);
  }

  private async gcIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [agentId, session] of this.sessions.entries()) {
      if (now - session.lastUsedAt > IDLE_TIMEOUT_MS) {
        await this.closeSession(agentId);
      }
    }
  }
}

/** Singleton manager; initialized lazily */
let _manager: BrowserManager | undefined;

export function getBrowserManager(profilesBaseDir: string): BrowserManager {
  if (!_manager) _manager = new BrowserManager(profilesBaseDir);
  return _manager;
}
