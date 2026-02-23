/**
 * AgentMemoryStore: working memory (in-memory + SQLite) and episodic memory
 * for per-agent autonomous tasks.
 *
 * Three layers:
 *   1. Working memory: current goal/plan/step — kept in agent_state via TaskQueue
 *   2. Episodic memory: important events stored in SQLite, searchable by text
 *   3. Semantic (vector) memory: interface defined; pgvector/Pinecone wired separately
 *
 * This file covers layers 1 and 2. Layer 3 is in VectorMemoryStore.ts.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../memory/sqlite.js";

export type EpisodicMemory = {
  id: string;
  agentId: string;
  /** One-line summary of the event */
  summary: string;
  /** ISO timestamp */
  recordedAt: string;
  /** Tag set for filtering (e.g. ["task-complete", "twitter", "blocked"]) */
  tags: string[];
  /** Optional link back to a task */
  taskId?: string;
  /** Optional JSON context blob */
  context?: Record<string, unknown>;
};

export type EpisodicMemoryInput = Omit<EpisodicMemory, "id" | "recordedAt">;

export class AgentEpisodicMemoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodic_memory (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        task_id TEXT,
        context TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_em_agent_time
        ON episodic_memory (agent_id, recorded_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS episodic_memory_fts
        USING fts5(id, agent_id, summary, tags, content=episodic_memory, content_rowid=rowid);

      CREATE TRIGGER IF NOT EXISTS em_insert AFTER INSERT ON episodic_memory BEGIN
        INSERT INTO episodic_memory_fts(rowid, id, agent_id, summary, tags)
        VALUES (new.rowid, new.id, new.agent_id, new.summary, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS em_delete BEFORE DELETE ON episodic_memory BEGIN
        INSERT INTO episodic_memory_fts(episodic_memory_fts, rowid, id, agent_id, summary, tags)
        VALUES ('delete', old.rowid, old.id, old.agent_id, old.summary, old.tags);
      END;
    `);
  }

  async store(input: EpisodicMemoryInput): Promise<EpisodicMemory> {
    const memory: EpisodicMemory = {
      id: randomUUID(),
      agentId: input.agentId,
      summary: input.summary,
      recordedAt: new Date().toISOString(),
      tags: input.tags ?? [],
      taskId: input.taskId,
      context: input.context,
    };

    this.db
      .prepare(
        `INSERT INTO episodic_memory (id, agent_id, summary, recorded_at, tags, task_id, context)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.agentId,
        memory.summary,
        memory.recordedAt,
        JSON.stringify(memory.tags),
        memory.taskId ?? null,
        memory.context ? JSON.stringify(memory.context) : null,
      );

    return memory;
  }

  /**
   * Full-text search over summaries for a given agent.
   * Falls back to LIKE scan if FTS fails.
   */
  async search(query: string, limit = 5, agentId?: string): Promise<EpisodicMemory[]> {
    let rows: Record<string, unknown>[];
    try {
      if (agentId) {
        rows = this.db
          .prepare(
            `SELECT em.* FROM episodic_memory em
             JOIN episodic_memory_fts fts ON em.rowid = fts.rowid
             WHERE fts.summary MATCH ? AND em.agent_id = ?
             ORDER BY em.recorded_at DESC LIMIT ?`,
          )
          .all(query, agentId, limit) as Record<string, unknown>[];
      } else {
        rows = this.db
          .prepare(
            `SELECT em.* FROM episodic_memory em
             JOIN episodic_memory_fts fts ON em.rowid = fts.rowid
             WHERE fts.summary MATCH ?
             ORDER BY em.recorded_at DESC LIMIT ?`,
          )
          .all(query, limit) as Record<string, unknown>[];
      }
    } catch {
      // FTS unavailable; fall back to LIKE
      const likeQuery = `%${query}%`;
      if (agentId) {
        rows = this.db
          .prepare(
            `SELECT * FROM episodic_memory WHERE summary LIKE ? AND agent_id = ?
             ORDER BY recorded_at DESC LIMIT ?`,
          )
          .all(likeQuery, agentId, limit) as Record<string, unknown>[];
      } else {
        rows = this.db
          .prepare(
            `SELECT * FROM episodic_memory WHERE summary LIKE ?
             ORDER BY recorded_at DESC LIMIT ?`,
          )
          .all(likeQuery, limit) as Record<string, unknown>[];
      }
    }

    return rows.map((r) => this.rowToMemory(r));
  }

  /** Return recent memories for an agent */
  recent(agentId: string, limit = 10): EpisodicMemory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM episodic_memory WHERE agent_id = ? ORDER BY recorded_at DESC LIMIT ?`,
      )
      .all(agentId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMemory(r));
  }

  private rowToMemory(row: Record<string, unknown>): EpisodicMemory {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      summary: row.summary as string,
      recordedAt: row.recorded_at as string,
      tags: JSON.parse((row.tags as string) || "[]") as string[],
      taskId: (row.task_id as string) || undefined,
      context: row.context ? (JSON.parse(row.context as string) as Record<string, unknown>) : undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}

/** Open or create an episodic memory store at baseDir */
export async function openEpisodicMemoryStore(
  baseDir: string,
  agentId: string,
): Promise<AgentEpisodicMemoryStore> {
  await mkdir(baseDir, { recursive: true });
  // Shared DB across agents (agent_id column partitions)
  const dbPath = join(baseDir, "episodic-memory.db");
  return new AgentEpisodicMemoryStore(dbPath);
}
