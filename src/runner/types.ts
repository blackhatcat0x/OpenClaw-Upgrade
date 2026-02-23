/**
 * Types for the autonomous agent runner and task queue.
 */

export type TaskStatus = "queued" | "running" | "done" | "failed" | "paused";

export type TaskPriority = 1 | 2 | 3 | 4 | 5;

/** Human-readable recurrence specification */
export type RecurrenceRule =
  | { kind: "once" }
  | { kind: "every"; intervalMs: number }
  | { kind: "cron"; expr: string; tz?: string };

export type TaskPayload = {
  /** High-level goal description passed to the planner */
  goal: string;
  /** Target URL (if browser task) */
  url?: string;
  /** Arbitrary key-value parameters */
  params?: Record<string, unknown>;
  /** Optional system constraints (e.g. "do not follow links") */
  constraints?: string[];
};

export type Task = {
  id: string;
  agentId: string;
  status: TaskStatus;
  /** 1=highest, 5=lowest */
  priority: TaskPriority;
  payload: TaskPayload;
  /** Optional recurrence; if set, task re-queues itself after completion */
  recurrence?: RecurrenceRule;
  /** ISO timestamp for next scheduled run (if recurrence is set) */
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
  /** Short human-readable reason for current status (e.g. "captcha detected") */
  statusReason?: string;
};

export type TaskRun = {
  id: string;
  taskId: string;
  agentId: string;
  startedAt: string;
  finishedAt?: string;
  /** Steps executed in this run */
  steps: RunStep[];
  /** Estimated tokens used */
  tokensEstimate?: number;
  error?: string;
};

export type RunStep = {
  index: number;
  description: string;
  result: string;
  timestampMs: number;
};

/** Per-agent working state persisted between runs */
export type AgentState = {
  agentId: string;
  currentTaskId?: string;
  lastHeartbeatAt?: string;
  /** Compact JSON of current working memory */
  workingMemory?: WorkingMemory;
};

export type WorkingMemory = {
  goal?: string;
  currentPlan?: string[];
  currentStepIndex?: number;
  /** SHA-256 hash of the last observed PageState */
  lastPageStateHash?: string;
  /** Key-value scratchpad for the current task */
  context?: Record<string, unknown>;
};
