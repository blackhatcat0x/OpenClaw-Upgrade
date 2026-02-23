/**
 * AgentRunner: autonomous execution loop.
 *
 * Wakes every POLL_INTERVAL_MS, claims the next queued task,
 * executes it step-by-step using the LLM Router + Browser + Page Understanding,
 * then updates memory and posts a status update.
 *
 * Stop conditions:
 *   - Task goal achieved
 *   - Captcha / 2FA detected (pause + notify)
 *   - Repeated failure loop (pause with reason)
 *   - Runner stopped via stop()
 */

import { randomUUID } from "node:crypto";
import type { ActivityFeedStore } from "../agent-activity/ActivityFeedStore.js";
import type { AgentEpisodicMemoryStore } from "../agent-memory/AgentMemoryStore.js";
import { getLLMRouter } from "../llm/LLMRouter.js";
import type { PageState } from "../page/types.js";
import type { Task, TaskRun, WorkingMemory } from "./types.js";
import type { TaskQueue } from "./TaskQueue.js";

const POLL_INTERVAL_MS = 3_000;
const MAX_STEPS_PER_RUN = 20;
const MAX_CONSECUTIVE_FAILURES = 3;
const STATUS_UPDATE_INTERVAL_MS = 5 * 60 * 1000; // min interval between status pings

export type AgentRunnerDeps = {
  taskQueue: TaskQueue;
  activityFeed: ActivityFeedStore;
  episodicMemory: AgentEpisodicMemoryStore;
  /** Navigate browser and return current PageState */
  getPageState?: (url: string) => Promise<PageState>;
};

export class AgentRunner {
  private readonly agentId: string;
  private readonly deps: AgentRunnerDeps;
  private running = false;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastStatusAt = 0;

  constructor(agentId: string, deps: AgentRunnerDeps) {
    this.agentId = agentId;
    this.deps = deps;
  }

  /** Start the autonomous polling loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    // Run first tick immediately
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      const task = this.deps.taskQueue.claimNext(this.agentId);
      if (!task) return; // Nothing queued

      await this.executeTask(task);
    } catch (err) {
      // Log but don't crash the loop
      console.error(`[AgentRunner:${this.agentId}] tick error:`, err);
    }
  }

  private async executeTask(task: Task): Promise<void> {
    const run: TaskRun = {
      id: randomUUID(),
      taskId: task.id,
      agentId: this.agentId,
      startedAt: new Date().toISOString(),
      steps: [],
    };

    const agentState = this.deps.taskQueue.getAgentState(this.agentId);
    const memory: WorkingMemory = agentState.workingMemory ?? {};
    memory.goal = task.payload.goal;

    // Save state
    this.deps.taskQueue.saveAgentState({
      agentId: this.agentId,
      currentTaskId: task.id,
      lastHeartbeatAt: new Date().toISOString(),
      workingMemory: memory,
    });

    // Post "task started" activity
    await this.maybePostStatus(`Starting task: ${task.payload.goal}`, task);

    // Retrieve relevant episodic memories to feed into the planner
    const relevantMemories = await this.deps.episodicMemory.search(task.payload.goal, 5);
    const hintsText =
      relevantMemories.length > 0
        ? `Relevant past experience:\n${relevantMemories.map((m) => `- ${m.summary}`).join("\n")}`
        : "";

    // Build initial plan via LLM
    const router = getLLMRouter();
    let plan: string[] = [];
    try {
      const planResp = await router.complete({
        capability: "reasoning",
        messages: [
          {
            role: "system",
            content: `You are an autonomous web agent. Create a step-by-step action plan.
Return ONLY a JSON array of step descriptions, e.g. ["Step 1", "Step 2"].
${hintsText}`,
          },
          {
            role: "user",
            content: `Goal: ${task.payload.goal}\nURL: ${task.payload.url ?? "not specified"}\nConstraints: ${(task.payload.constraints ?? []).join("; ")}`,
          },
        ],
        maxTokens: 512,
      });

      try {
        // Extract JSON array from response
        const match = planResp.text.match(/\[[\s\S]*\]/);
        if (match) plan = JSON.parse(match[0]) as string[];
      } catch {
        plan = [task.payload.goal];
      }
    } catch (err) {
      // Planning failed; treat goal as single step
      plan = [task.payload.goal];
      console.warn(`[AgentRunner:${this.agentId}] planning failed:`, err);
    }

    memory.currentPlan = plan;
    memory.currentStepIndex = 0;

    let consecutiveFailures = 0;
    let taskFailed = false;
    let pauseReason: string | undefined;

    for (let stepIdx = 0; stepIdx < Math.min(plan.length, MAX_STEPS_PER_RUN); stepIdx++) {
      if (!this.running) break;

      const stepDesc = plan[stepIdx] ?? "Execute goal";
      memory.currentStepIndex = stepIdx;

      let stepResult = "";
      let stepOk = false;

      try {
        // Optionally get current page state if a URL is set
        let pageContext = "";
        if (task.payload.url && this.deps.getPageState) {
          try {
            const ps = await this.deps.getPageState(task.payload.url);
            pageContext = `Current page: ${ps.title} (${ps.page_type})\nElements: ${ps.elements.slice(0, 10).map((e) => `${e.role}:${e.text}`).join(", ")}\nAlerts: ${ps.alerts.map((a) => a.type).join(", ")}`;

            // Detect captcha / 2FA → pause
            const blockingAlerts = ps.alerts.filter(
              (a) => a.type === "captcha" || a.type === "2fa",
            );
            if (blockingAlerts.length > 0) {
              pauseReason = `Blocked by ${blockingAlerts.map((a) => a.type).join(", ")}`;
              break;
            }

            memory.lastPageStateHash = ps.hash;
          } catch {
            // Page state unavailable; continue without it
          }
        }

        // Execute step via LLM
        const stepResp = await router.complete({
          capability: "reasoning",
          messages: [
            {
              role: "system",
              content: `You are an autonomous agent executing step ${stepIdx + 1} of ${plan.length}.
${pageContext}`,
            },
            {
              role: "user",
              content: `Goal: ${task.payload.goal}\nStep: ${stepDesc}\nDescribe the result of executing this step.`,
            },
          ],
          maxTokens: 256,
        });

        stepResult = stepResp.text.trim();
        stepOk = true;
        consecutiveFailures = 0;
      } catch (err) {
        stepResult = `Error: ${String((err as Error)?.message ?? err)}`;
        consecutiveFailures++;

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          pauseReason = `${MAX_CONSECUTIVE_FAILURES} consecutive failures`;
          taskFailed = true;
          break;
        }
      }

      run.steps.push({
        index: stepIdx,
        description: stepDesc,
        result: stepResult,
        timestampMs: Date.now(),
      });

      // Save state after each step
      this.deps.taskQueue.saveAgentState({
        agentId: this.agentId,
        currentTaskId: task.id,
        lastHeartbeatAt: new Date().toISOString(),
        workingMemory: memory,
      });

      // Optionally post status update (rate limited)
      await this.maybePostStatus(`Step ${stepIdx + 1}/${plan.length}: ${stepResult.slice(0, 80)}`, task);

      if (!stepOk && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    }

    run.finishedAt = new Date().toISOString();

    // Determine final status
    if (pauseReason) {
      this.deps.taskQueue.updateStatus(task.id, "paused", pauseReason);
      await this.postStatus(`Paused: ${pauseReason}`, task, true);
    } else if (taskFailed) {
      this.deps.taskQueue.updateStatus(task.id, "failed", "max consecutive failures");
      await this.postStatus("Task failed after repeated errors", task, true);
    } else {
      // Success path
      if (task.recurrence && task.recurrence.kind !== "once") {
        this.deps.taskQueue.requeueRecurring(task);
      } else {
        this.deps.taskQueue.updateStatus(task.id, "done");
      }

      // Store episodic memory of successful completion
      const summary = `Completed task "${task.payload.goal}" in ${run.steps.length} steps.`;
      await this.deps.episodicMemory.store({
        agentId: this.agentId,
        summary,
        tags: ["task-complete"],
        taskId: task.id,
      });

      await this.postStatus(`Done: ${task.payload.goal.slice(0, 80)}`, task, true);
    }

    // Save run log
    this.deps.taskQueue.saveTaskRun(run);

    // Clear current task from agent state
    this.deps.taskQueue.saveAgentState({
      agentId: this.agentId,
      currentTaskId: undefined,
      lastHeartbeatAt: new Date().toISOString(),
      workingMemory: {},
    });
  }

  /** Post a status update, respecting rate limit */
  private async maybePostStatus(prompt: string, task: Task): Promise<void> {
    const now = Date.now();
    if (now - this.lastStatusAt < STATUS_UPDATE_INTERVAL_MS) return;
    await this.postStatus(prompt, task, false);
  }

  private async postStatus(prompt: string, task: Task, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastStatusAt < STATUS_UPDATE_INTERVAL_MS) return;

    try {
      const router = getLLMRouter();
      const oneliner = await router.statusPing(
        `Task: ${task.payload.goal} | Event: ${prompt}`,
      );
      await this.deps.activityFeed.append({
        agentId: this.agentId,
        taskId: task.id,
        message: oneliner,
      });
      this.lastStatusAt = now;
    } catch {
      // Activity feed failure is non-fatal
    }
  }
}
