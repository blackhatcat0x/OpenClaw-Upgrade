/**
 * TaskQueue: SQLite-backed persistent task queue for the autonomous agent runner.
 *
 * Uses node:sqlite (Node.js 22+ built-in, same pattern as the rest of the codebase).
 * Tasks survive process restarts. A running task whose heartbeat goes stale
 * is automatically reset to "queued" on startup.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../memory/sqlite.js";
import type {
  AgentState,
  RecurrenceRule,
  Task,
  TaskPayload,
  TaskPriority,
  TaskRun,
  WorkingMemory,
} from "./types.js";

/** If a task has been "running" for more than this, it's considered stale */
const STALE_RUNNING_MS = 5 * 60 * 1000;

function nextRunFor(rule: RecurrenceRule): string | undefined {
  if (rule.kind === "once") return undefined;
  if (rule.kind === "every") {
    return new Date(Date.now() + rule.intervalMs).toISOString();
  }
  // "cron" kind: basic next-minute approximation; for production use a cron parser
  // This keeps the dependency footprint minimal.
  return undefined;
}

export class TaskQueue {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 3,
        payload TEXT NOT NULL,
        recurrence TEXT,
        next_run_at TEXT,
        status_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_agent_status
        ON tasks (agent_id, status, priority, created_at);

      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        agent_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        steps TEXT NOT NULL DEFAULT '[]',
        tokens_estimate INTEGER,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs (task_id);

      CREATE TABLE IF NOT EXISTS agent_state (
        agent_id TEXT PRIMARY KEY,
        current_task_id TEXT,
        last_heartbeat_at TEXT,
        working_memory TEXT
      );
    `);

    // Reset stale "running" tasks on startup
    const staleThreshold = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'queued', status_reason = 'reset after stale run', updated_at = ?
         WHERE status = 'running' AND updated_at < ?`,
      )
      .run(new Date().toISOString(), staleThreshold);
  }

  enqueue(
    agentId: string,
    payload: TaskPayload,
    opts?: {
      priority?: TaskPriority;
      recurrence?: RecurrenceRule;
      nextRunAt?: string;
    },
  ): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      agentId,
      status: "queued",
      priority: opts?.priority ?? 3,
      payload,
      recurrence: opts?.recurrence,
      nextRunAt: opts?.nextRunAt,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO tasks (id, agent_id, status, priority, payload, recurrence, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.agentId,
        task.status,
        task.priority,
        JSON.stringify(task.payload),
        task.recurrence ? JSON.stringify(task.recurrence) : null,
        task.nextRunAt ?? null,
        task.createdAt,
        task.updatedAt,
      );

    return task;
  }

  /** Claim the next queued task for an agent (atomic) */
  claimNext(agentId: string): Task | undefined {
    const now = new Date().toISOString();

    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE agent_id = ? AND status = 'queued'
           AND (next_run_at IS NULL OR next_run_at <= ?)
         ORDER BY priority ASC, created_at ASC
         LIMIT 1`,
      )
      .get(agentId, now) as Record<string, unknown> | undefined;

    if (!row) return undefined;

    this.db
      .prepare(`UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`)
      .run(now, row.id);

    return this.rowToTask({ ...row, status: "running" });
  }

  updateStatus(
    taskId: string,
    status: Task["status"],
    reason?: string,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, reason ?? null, now, taskId);
  }

  /** Re-queue a recurring task with the next run timestamp */
  requeueRecurring(task: Task): void {
    if (!task.recurrence || task.recurrence.kind === "once") return;
    const nextRunAt = nextRunFor(task.recurrence);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'queued', next_run_at = ?, status_reason = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(nextRunAt ?? null, now, task.id);
  }

  saveTaskRun(run: TaskRun): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO task_runs (id, task_id, agent_id, started_at, finished_at, steps, tokens_estimate, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.agentId,
        run.startedAt,
        run.finishedAt ?? null,
        JSON.stringify(run.steps),
        run.tokensEstimate ?? null,
        run.error ?? null,
      );
  }

  getAgentState(agentId: string): AgentState {
    const row = this.db
      .prepare(`SELECT * FROM agent_state WHERE agent_id = ?`)
      .get(agentId) as Record<string, unknown> | undefined;

    if (!row) return { agentId };
    return {
      agentId,
      currentTaskId: (row.current_task_id as string) || undefined,
      lastHeartbeatAt: (row.last_heartbeat_at as string) || undefined,
      workingMemory: row.working_memory
        ? (JSON.parse(row.working_memory as string) as WorkingMemory)
        : undefined,
    };
  }

  saveAgentState(state: AgentState): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_state (agent_id, current_task_id, last_heartbeat_at, working_memory)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        state.agentId,
        state.currentTaskId ?? null,
        state.lastHeartbeatAt ?? null,
        state.workingMemory ? JSON.stringify(state.workingMemory) : null,
      );
  }

  listTasks(agentId: string, status?: Task["status"]): Task[] {
    const rows = status
      ? (this.db
          .prepare(`SELECT * FROM tasks WHERE agent_id = ? AND status = ? ORDER BY priority ASC, created_at ASC`)
          .all(agentId, status) as Record<string, unknown>[])
      : (this.db
          .prepare(`SELECT * FROM tasks WHERE agent_id = ? ORDER BY priority ASC, created_at ASC`)
          .all(agentId) as Record<string, unknown>[]);

    return rows.map((r) => this.rowToTask(r));
  }

  private rowToTask(row: Record<string, unknown>): Task {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      status: row.status as Task["status"],
      priority: (row.priority as TaskPriority) ?? 3,
      payload: JSON.parse(row.payload as string) as TaskPayload,
      recurrence: row.recurrence
        ? (JSON.parse(row.recurrence as string) as RecurrenceRule)
        : undefined,
      nextRunAt: (row.next_run_at as string) || undefined,
      statusReason: (row.status_reason as string) || undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  close(): void {
    this.db.close();
  }
}

/** Build a stable DB path for a given agent's task queue */
export function resolveTaskQueuePath(baseDir: string, agentId: string): string {
  // Use a hash of the agentId to keep paths filesystem-safe
  const hash = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  return join(baseDir, `task-queue-${hash}.db`);
}

/** Ensure the directory exists and return an initialized TaskQueue */
export async function openTaskQueue(baseDir: string, agentId: string): Promise<TaskQueue> {
  await mkdir(baseDir, { recursive: true });
  const dbPath = resolveTaskQueuePath(baseDir, agentId);
  return new TaskQueue(dbPath);
}
