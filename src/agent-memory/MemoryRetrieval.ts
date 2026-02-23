/**
 * MemoryRetrieval: combines episodic (text FTS) and semantic (vector) memory
 * retrieval to build a "hints" section for the agent planner.
 *
 * Called before each planning or action step to inject relevant past experience.
 */

import { getLLMRouter } from "../llm/LLMRouter.js";
import type { AgentEpisodicMemoryStore } from "./AgentMemoryStore.js";
import type { VectorMemoryStore } from "./VectorMemoryStore.js";

export type MemoryHints = {
  /** Short text block ready to inject into the LLM system prompt */
  hintsText: string;
  /** Number of memories retrieved */
  count: number;
};

export class MemoryRetrieval {
  constructor(
    private readonly episodic: AgentEpisodicMemoryStore,
    private readonly vector: VectorMemoryStore,
  ) {}

  /**
   * Retrieve and combine relevant memories for the given context.
   * @param agentId - Filter to a specific agent
   * @param query - Text query (usually goal + page context)
   * @param topK - Max results from each source
   */
  async retrieve(agentId: string, query: string, topK = 5): Promise<MemoryHints> {
    // 1. Episodic text search
    const episodicResults = await this.episodic.search(query, topK, agentId);

    // 2. Vector search (if available and embeddings configured)
    let vectorResults: Array<{ text: string; score: number }> = [];
    try {
      const router = getLLMRouter();
      const embResp = await router.embed({ texts: [query] });
      const embedding = embResp.embeddings[0];
      if (embedding) {
        const vr = await this.vector.search(embedding, topK, agentId);
        vectorResults = vr.map((r) => ({ text: r.text, score: r.score }));
      }
    } catch {
      // Vector retrieval is optional; fail silently
    }

    // Deduplicate and combine
    const seen = new Set<string>();
    const lines: string[] = [];

    for (const m of episodicResults) {
      if (!seen.has(m.summary)) {
        seen.add(m.summary);
        lines.push(`[episodic] ${m.summary}`);
      }
    }

    for (const v of vectorResults) {
      if (!seen.has(v.text)) {
        seen.add(v.text);
        lines.push(`[semantic] ${v.text}`);
      }
    }

    if (lines.length === 0) {
      return { hintsText: "", count: 0 };
    }

    return {
      hintsText: `Relevant past experience:\n${lines.join("\n")}`,
      count: lines.length,
    };
  }

  /**
   * Store a new fact or lesson in the vector store so it's retrievable.
   */
  async storeFact(agentId: string, fact: string, tags: string[] = []): Promise<void> {
    try {
      const router = getLLMRouter();
      const embResp = await router.embed({ texts: [fact] });
      const embedding = embResp.embeddings[0];
      if (embedding) {
        await this.vector.upsert({
          id: `${agentId}-${Date.now()}`,
          agentId,
          text: fact,
          tags,
          embedding,
        });
      }
    } catch {
      // Non-fatal; vector store may not be configured
    }
  }
}
