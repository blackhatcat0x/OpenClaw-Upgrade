import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

type ActivityEntry = {
  id: string;
  agentId: string;
  taskId?: string;
  message: string;
  createdAt: string;
};

/**
 * Agent Activity Feed panel for the OpenClaw dashboard.
 *
 * Usage:
 *   <agent-activity-feed agent-id="my-agent" poll-interval-ms="30000"></agent-activity-feed>
 *
 * Polls GET /api/agents/:id/activity every pollIntervalMs.
 * Shows the last 20 one-liner status updates in reverse-chronological order.
 */
@customElement("agent-activity-feed")
export class AgentActivityFeed extends LitElement {
  /** If set, shows activity for a specific agent only */
  @property({ attribute: "agent-id" }) agentId = "";

  /** Polling interval in milliseconds (default 30s) */
  @property({ type: Number, attribute: "poll-interval-ms" }) pollIntervalMs = 30_000;

  @state() private entries: ActivityEntry[] = [];
  @state() private loading = false;
  @state() private error = "";

  private _pollTimer?: ReturnType<typeof setInterval>;

  static styles = css`
    :host {
      display: block;
      font-family: var(--font-mono, monospace);
      font-size: 0.82rem;
      color: var(--text, #ccc);
      background: var(--bg-surface, #1a1a1a);
      border: 1px solid var(--border, #333);
      border-radius: 6px;
      padding: 12px;
      min-width: 240px;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted, #888);
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent, #4caf50);
      flex-shrink: 0;
    }

    .dot.idle {
      background: var(--text-muted, #555);
    }

    .entry-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .entry {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 6px;
      align-items: baseline;
      line-height: 1.4;
    }

    .entry-time {
      color: var(--text-muted, #666);
      font-size: 0.72rem;
      white-space: nowrap;
    }

    .entry-msg {
      color: var(--text, #ccc);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .empty {
      color: var(--text-muted, #666);
      font-style: italic;
    }

    .error-msg {
      color: var(--error, #e57373);
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    void this.fetchEntries();
    this._pollTimer = setInterval(() => void this.fetchEntries(), this.pollIntervalMs);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  private async fetchEntries(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      const url = this.agentId
        ? `/api/agents/${encodeURIComponent(this.agentId)}/activity?limit=20`
        : `/api/agents/activity?limit=20`;

      const res = await fetch(url);
      if (!res.ok) {
        this.error = `HTTP ${res.status}`;
        return;
      }

      const data = (await res.json()) as { entries: ActivityEntry[] };
      this.entries = data.entries ?? [];
    } catch (err) {
      this.error = String((err as Error)?.message ?? err);
    } finally {
      this.loading = false;
    }
  }

  private formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso;
    }
  }

  render() {
    const isActive = this.entries.length > 0 && !this.loading;

    return html`
      <div class="header">
        <span class="dot ${isActive ? "" : "idle"}"></span>
        <span>Agent Activity</span>
        ${this.loading ? html`<span style="margin-left:auto;opacity:0.5">…</span>` : nothing}
      </div>

      ${this.error
        ? html`<p class="error-msg">${this.error}</p>`
        : this.entries.length === 0
          ? html`<p class="empty">No activity yet.</p>`
          : html`
              <ul class="entry-list">
                ${this.entries.map(
                  (e) => html`
                    <li class="entry">
                      <span class="entry-time">${this.formatTime(e.createdAt)}</span>
                      <span class="entry-msg">${e.message}</span>
                    </li>
                  `,
                )}
              </ul>
            `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-activity-feed": AgentActivityFeed;
  }
}
