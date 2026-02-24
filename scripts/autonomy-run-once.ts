import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openActivityFeedStore } from "../src/agent-activity/ActivityFeedStore.js";
import { openEpisodicMemoryStore } from "../src/agent-memory/AgentMemoryStore.js";
import { AgentRunner } from "../src/runner/AgentRunner.js";
import { openTaskQueue } from "../src/runner/TaskQueue.js";

type CliOptions = {
  profile: string;
  agentId: string;
  browserProfile: string;
  runnerDir: string;
  timeoutMs: number;
};

function printHelp(): void {
  console.log(`Usage: node --import tsx scripts/autonomy-run-once.ts [options]

Runs one autonomous polling loop for a queued agent task, then prints queue/activity/memory summary.

Options:
  --profile <name>            OpenClaw profile (default: upgrade)
  --agent <id>                Agent id / queue partition (default: ab12-twitterposter)
  --browser-profile <name>    Browser profile for page inspection (default: ab12-twitterposter)
  --runner-dir <path>         Directory for queue/activity/memory DBs
                              (default: C:/Users/Clawbot/.openclaw-upgrade/runner)
  --timeout-ms <n>            Max run time in ms before forced stop (default: 120000)
  -h, --help                  Show help
`);
}

function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = {
    profile: "upgrade",
    agentId: "ab12-twitterposter",
    browserProfile: "ab12-twitterposter",
    runnerDir: "C:/Users/Clawbot/.openclaw-upgrade/runner",
    timeoutMs: 120_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--profile" && next) {
      out.profile = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--agent" && next) {
      out.agentId = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--browser-profile" && next) {
      out.browserProfile = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--runner-dir" && next) {
      out.runnerDir = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        out.timeoutMs = parsed;
      }
      i += 1;
      continue;
    }
  }

  return out;
}

function makeHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return `h${Math.abs(h)}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const execFileAsync = promisify(execFile);
  const cwd = process.cwd();

  async function runOpenclaw(args: string[]): Promise<Record<string, unknown> | null> {
    const { stdout } = await execFileAsync(
      "node",
      ["openclaw.mjs", "--profile", opts.profile, ...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const text = String(stdout || "").trim();
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  }

  const getPageState = async (url: string) => {
    await runOpenclaw(["browser", "--browser-profile", opts.browserProfile, "open", url, "--json"]);

    const tabs = await runOpenclaw([
      "browser",
      "--browser-profile",
      opts.browserProfile,
      "tabs",
      "--json",
    ]);
    const list = Array.isArray(tabs?.tabs)
      ? (tabs.tabs as Array<{ targetId?: string; url?: string; title?: string }>)
      : [];
    const tab =
      [...list].toReversed().find((t) => String(t?.url || "").includes("x.com")) ?? list[0];
    const targetId = typeof tab?.targetId === "string" ? tab.targetId : undefined;

    const snapArgs = [
      "browser",
      "--browser-profile",
      opts.browserProfile,
      "snapshot",
      "--format",
      "ai",
      ...(targetId ? ["--target-id", targetId] : []),
      "--json",
    ];
    const snap = await runOpenclaw(snapArgs);
    const snapshotRaw = snap?.snapshot;
    const snapshotText = (typeof snapshotRaw === "string" ? snapshotRaw : "").toLowerCase();
    const pageUrl = String(tab?.url || url || "");
    const title = String(tab?.title || "");

    const alerts: Array<{ type: "captcha" | "2fa"; text: string }> = [];
    if (/captcha|hcaptcha|recaptcha/.test(snapshotText) || /captcha/.test(pageUrl.toLowerCase())) {
      alerts.push({ type: "captcha", text: "captcha detected" });
    }
    if (/log in|sign in|phone, email, or username|enter your phone/.test(snapshotText)) {
      alerts.push({ type: "2fa", text: "login challenge detected" });
    }

    return {
      url: pageUrl,
      title,
      page_type: /x\.com\/home/i.test(pageUrl) && alerts.length === 0 ? "feed" : "login",
      timestamp: new Date().toISOString(),
      elements: [],
      alerts,
      hash: makeHash(`${pageUrl}|${title}|${snapshotText.slice(0, 4000)}`),
    };
  };

  const queue = await openTaskQueue(opts.runnerDir, opts.agentId);
  const activity = await openActivityFeedStore(opts.runnerDir);
  const memory = await openEpisodicMemoryStore(opts.runnerDir, opts.agentId);
  const runner = new AgentRunner(opts.agentId, {
    taskQueue: queue,
    activityFeed: activity,
    episodicMemory: memory,
    getPageState,
  });

  runner.start();
  const started = Date.now();
  let complete = false;

  while (!complete && Date.now() - started < opts.timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const tasks = queue.listTasks(opts.agentId);
    complete = !tasks.some((task) => task.status === "running" || task.status === "queued");
  }
  runner.stop();

  const finalTasks = queue.listTasks(opts.agentId).map((task) => ({
    id: task.id,
    status: task.status,
    reason: task.statusReason,
    goal: task.payload.goal,
  }));
  const feed = activity.list(opts.agentId, 20);
  const recentMemory = memory.recent(opts.agentId, 20);

  console.log(
    JSON.stringify(
      {
        timedOut: !complete,
        elapsedMs: Date.now() - started,
        finalTasks,
        feed,
        recentMemory,
      },
      null,
      2,
    ),
  );

  queue.close();
  activity.close();
  memory.close();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`autonomy-run-once failed: ${message}`);
  process.exit(1);
});
