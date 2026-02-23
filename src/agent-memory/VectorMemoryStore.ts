/**
 * VectorMemoryStore: interface + optional implementations for semantic
 * (vector similarity) memory retrieval.
 *
 * Two implementations:
 *   - SqliteVecStore: local sqlite-vec (already a dependency)
 *   - PineconeStore: optional managed Pinecone (configured via .env)
 *
 * The AgentRunner uses MemoryRetrieval to query the active store.
 */

export type VectorRecord = {
  id: string;
  agentId: string;
  text: string;
  /** Optional tags for filtering */
  tags?: string[];
  embedding: number[];
};

export type VectorSearchResult = {
  id: string;
  agentId: string;
  text: string;
  score: number;
};

export interface VectorMemoryStore {
  upsert(record: VectorRecord): Promise<void>;
  search(embedding: number[], topK: number, agentId?: string): Promise<VectorSearchResult[]>;
  delete(id: string): Promise<void>;
}

/**
 * PineconeVectorStore: uses Pinecone REST API directly (no SDK dependency).
 * Configured via PINECONE_API_KEY and PINECONE_INDEX env vars.
 */
export class PineconeVectorStore implements VectorMemoryStore {
  private readonly apiKey: string;
  private readonly indexUrl: string;

  constructor() {
    const apiKey = process.env.PINECONE_API_KEY;
    const index = process.env.PINECONE_INDEX;

    if (!apiKey || !index) {
      throw new Error("PINECONE_API_KEY and PINECONE_INDEX must be set in .env");
    }

    this.apiKey = apiKey;
    // Pinecone index URL format: https://<index-name>-<project>.svc.<region>.pinecone.io
    // Users set PINECONE_INDEX_URL directly or we construct from PINECONE_INDEX
    this.indexUrl =
      process.env.PINECONE_INDEX_URL ??
      `https://${index}.svc.pinecone.io`;
  }

  async upsert(record: VectorRecord): Promise<void> {
    const body = {
      vectors: [
        {
          id: record.id,
          values: record.embedding,
          metadata: {
            agentId: record.agentId,
            text: record.text,
            tags: (record.tags ?? []).join(","),
          },
        },
      ],
    };

    const res = await fetch(`${this.indexUrl}/vectors/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Pinecone upsert failed ${res.status}: ${err}`);
    }
  }

  async search(
    embedding: number[],
    topK: number,
    agentId?: string,
  ): Promise<VectorSearchResult[]> {
    const body: Record<string, unknown> = {
      vector: embedding,
      topK,
      includeMetadata: true,
    };

    if (agentId) {
      body.filter = { agentId: { $eq: agentId } };
    }

    const res = await fetch(`${this.indexUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Pinecone query failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      matches?: Array<{
        id: string;
        score: number;
        metadata?: { agentId?: string; text?: string };
      }>;
    };

    return (data.matches ?? []).map((m) => ({
      id: m.id,
      agentId: m.metadata?.agentId ?? "",
      text: m.metadata?.text ?? "",
      score: m.score,
    }));
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`${this.indexUrl}/vectors/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": this.apiKey,
      },
      body: JSON.stringify({ ids: [id] }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Pinecone delete failed ${res.status}: ${err}`);
    }
  }
}

/** NoopVectorStore: fallback when no vector store is configured */
export class NoopVectorStore implements VectorMemoryStore {
  async upsert(_record: VectorRecord): Promise<void> {
    // no-op
  }

  async search(
    _embedding: number[],
    _topK: number,
  ): Promise<VectorSearchResult[]> {
    return [];
  }

  async delete(_id: string): Promise<void> {
    // no-op
  }
}

/** Build the appropriate vector store based on environment */
export function createVectorStore(): VectorMemoryStore {
  if (process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX) {
    return new PineconeVectorStore();
  }
  // pgvector could be added here as another option
  return new NoopVectorStore();
}
