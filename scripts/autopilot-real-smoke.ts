import { resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import { config as loadDotEnv } from "dotenv";

import { buildApp } from "../apps/server/src/app.js";
import type { ServerConfig } from "../apps/server/src/config.js";
import {
  SqliteDocumentRepository,
  SqliteLlmCallRepository,
  SqliteRunRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";

import {
  configureSmokeModelTarget,
  createSmokeWorkspace,
  currentGitCommit,
  finalizeSmokeWorkspace,
  installSignalFlush,
  interruptOrphanedWork,
  originOf,
  parseRealSmokeArgs,
  RunWatcher,
  RunStateTracker,
  SmokeLogger,
  writeSmokeSummary,
  type SmokeCheck,
} from "./real-smoke-harness.js";

loadDotEnv({ path: resolve(process.cwd(), ".env.local"), quiet: true });

const scenario = "autopilot-real";
const args = parseRealSmokeArgs(process.argv.slice(2), {
  script: "autopilot-real-smoke.ts",
  defaultProtocols: ["openai-responses"],
  singleProtocol: true,
  chaptersDefault: 5,
});
const protocol = args.protocols[0]!;
const chapters = args.chapters ?? 5;
const modelIds: Record<string, string> = {
  "openai-chat": "environment-chat",
  "openai-responses": "environment-responses",
  "anthropic-messages": "environment-anthropic",
};
const modelId = modelIds[protocol];
if (!modelId) {
  throw new Error(`Unsupported protocol: ${protocol}`);
}

const workspace = createSmokeWorkspace(scenario, { outputDir: args.outputDir });
const logger = new SmokeLogger(workspace.jsonlPath, scenario, {
  diagnostic: args.diagnostic,
});
installSignalFlush(logger);
const startedAt = new Date().toISOString();
const checks: SmokeCheck[] = [];
let success = false;

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: workspace.dbPath,
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
};
const database = new NodeNarrativeDatabase(workspace.dbPath);
database.migrate();
interruptOrphanedWork(logger, database);
const tracker = new RunStateTracker(logger, database, {
  diagnostic: args.diagnostic,
});
const watcher = new RunWatcher(tracker);
watcher.startPolling();
let app = await createApp(database);
const wallStart = Date.now();
let steerRunId: string | null = null;
let recoveryAttempts = 0;

logger.event("scenario.start", {
  protocols: args.protocols,
  chapters,
  workspace: workspace.dir,
  gitCommit: currentGitCommit(),
});

function recordCheck(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
  logger.event("scenario.check", { name, ok, ...(detail ? { detail } : {}) });
}

try {
  const target = configureSmokeModelTarget(database, modelId);
  if (!target) {
    throw new Error(`${protocol} model limits/credential are not configured`);
  }
  process.stdout.write(`model ${protocol}: configured\n`);
  logger.event("model.resolved", {
    modelId,
    protocol,
    model: target.model.modelId,
    baseUrlOrigin: originOf(target.provider.baseUrl),
  });

  const project = await jsonRequest<{ id: string }>(
    app,
    "POST",
    "/api/projects",
    {
      requestId: globalThis.crypto.randomUUID(),
      title: "回声邮局",
      premise:
        "一座只在退潮时营业的邮局，会把未寄出的信送到收件人失去某段记忆之前。",
    },
    [201],
  );
  const projectId = project.id;
  const foundation = await jsonRequest<RunSnapshot>(
    app,
    "POST",
    `/api/projects/${projectId}/foundation/generate`,
    {
      requestId: globalThis.crypto.randomUUID(),
      braindump: [
        "海边旧城的退潮区藏着一座回声邮局，只在月末最低潮的九十分钟内营业。",
        "二十七岁的修复师沈砚收到已故姐姐寄来的空白信，发现加热后会显出未来三天的字。",
        "每寄出一封信，寄信人就会永久失去与收件人有关的一段真实记忆；失去的记忆会变成邮局墙里的回声。",
        "沈砚想阻止父亲在三天后失踪，但姐姐留下的信暗示，父亲正是当年建立这条规则的人。",
        "基调克制、潮湿、悬疑；超自然规则必须可观察、可复验、有代价，不用梦境或失忆反转糊弄因果。",
      ].join("\n"),
      preferences: {
        genre: "都市奇幻悬疑",
        tone: "克制、具象、带海潮般逐步逼近的压迫感",
        targetChapters: Math.max(24, chapters * 3),
        wordsPerChapter: 350,
      },
    },
    [202],
  );
  logger.event("run.created", {
    runId: foundation.run.id,
    projectId,
    kind: "foundation",
  });
  watcher.track(foundation.run.id);
  await finishRun(app, foundation.run.id, projectId, "foundation");
  recordCheck("foundation completed", true);
  const candidateSets = await jsonRequest<CandidateSet[]>(
    app,
    "GET",
    `/api/projects/${projectId}/foundation/candidates`,
    undefined,
    [200],
  );
  const candidateSet = candidateSets[0];
  if (!candidateSet || candidateSet.candidates.length < 3) {
    throw new Error("Foundation did not stage enough reviewable candidates");
  }
  await jsonRequest(
    app,
    "POST",
    `/api/candidate-sets/${candidateSet.set.id}/actions`,
    { action: "adopt-all" },
    [200],
  );
  process.stdout.write(
    `foundation: adopted ${candidateSet.candidates.length} candidates\n`,
  );

  const session = await jsonRequest<AutopilotSession>(
    app,
    "POST",
    `/api/projects/${projectId}/autopilot/sessions`,
    {
      requestId: globalThis.crypto.randomUUID(),
      approvalMode: "continuous",
      targetChapters: chapters,
      windowSize: 3,
      maxRevisionCycles: 1,
      chapterPolicy: {
        requestStartTimeoutMs: 120_000,
        maxRetries: 1,
        maxRepairAttempts: 2,
        // Multi-chapter context includes prior summaries/canon/state and can
        // exceed the single-chapter 16k smoke window by chapter three.
        contextWindow: 128_000,
        // 推理模型 reasoning token 计入输出预算，结构化预算需留足（M5 基线）
        draftMaxOutputTokens: 32_000,
        reviewMaxOutputTokens: 24_000,
        settlementMaxOutputTokens: 24_000,
        minChapterCharacters: 180,
      },
    },
    [202],
  );

  await advanceSession(app, session.id);
  let detail = await getSession(app, session.id);
  trackSessionRuns(detail);
  const interruptedRunId = detail.session.currentRunId;
  if (!interruptedRunId) throw new Error("Autopilot did not create a plan run");
  await jsonRequest(
    app,
    "POST",
    `/api/autopilot/sessions/${session.id}/actions`,
    { action: "pause" },
    [200],
  );
  await advanceSession(app, session.id);
  await advanceRun(app, interruptedRunId, "rolling-plan/pause");
  await advanceSession(app, session.id);
  detail = await getSession(app, session.id);
  trackSessionRuns(detail);
  if (detail.session.status !== "paused") {
    throw new Error(`Expected paused session, got ${detail.session.status}`);
  }
  recordCheck("session paused", true);

  await app.close();
  app = await createApp(database);
  detail = await getSession(app, session.id);
  if (
    detail.session.status !== "paused" ||
    detail.session.currentRunId !== interruptedRunId
  ) {
    throw new Error("Durable session state was not recovered after restart");
  }
  recordCheck("session survived app restart", true);
  await jsonRequest(
    app,
    "POST",
    `/api/autopilot/sessions/${session.id}/actions`,
    { action: "resume" },
    [200],
  );
  process.stdout.write(
    "recovery: paused child survived app restart and resumed\n",
  );

  let lastProgress = "";
  for (
    let index = 0;
    index < 20_000 && Date.now() - wallStart < 3_600_000;
    index += 1
  ) {
    detail = await getSession(app, session.id);
    trackSessionRuns(detail);
    const currentLink = detail.links.find(
      (link) => link.runId === detail.session.currentRunId,
    );
    const progress = [
      detail.session.status,
      `${detail.session.completedChapters}/${chapters}`,
      currentLink?.role ?? "coordinator",
    ].join(" · ");
    if (progress !== lastProgress) {
      process.stdout.write(`autopilot: ${progress}\n`);
      lastProgress = progress;
    }

    if (detail.session.status === "completed") break;
    if (detail.session.status === "cancelled") {
      throw new Error("Autopilot session was unexpectedly cancelled");
    }
    if (
      detail.session.status === "failed" ||
      detail.session.status === "awaiting_user"
    ) {
      if (recoveryAttempts >= Math.max(5, chapters)) {
        throw new Error(
          `Autopilot exhausted recovery exits: ${safeError(detail.session.lastError)}`,
        );
      }
      recoveryAttempts += 1;
      process.stdout.write(
        `recovery: retry-current after ${detail.session.status}\n`,
      );
      await jsonRequest(
        app,
        "POST",
        `/api/autopilot/sessions/${session.id}/resolutions`,
        { action: "retry-current" },
        [200],
      );
      continue;
    }

    if (
      !steerRunId &&
      detail.session.completedChapters >= 1 &&
      currentLink?.role === "chapter"
    ) {
      const steer = await jsonRequest<{ classificationRunId: string | null }>(
        app,
        "POST",
        `/api/autopilot/sessions/${session.id}/steers`,
        {
          requestId: globalThis.crypto.randomUUID(),
          content:
            "从下一场开始，让沈砚发现姐姐的回声故意漏掉了一个潮汐时间，但不要改写已经提交的事实。",
        },
        [202],
      );
      if (!steer.classificationRunId) {
        throw new Error("Steer classification run was not created");
      }
      steerRunId = steer.classificationRunId;
      logger.event("run.created", {
        runId: steerRunId,
        projectId,
        kind: "steer-classification",
      });
      watcher.track(steerRunId);
      await finishRun(app, steerRunId, projectId, "steer-classification");
      process.stdout.write("steer: classified and queued at a safe boundary\n");
    }

    if (detail.session.currentRunId) {
      const run = detail.runs.find(
        (candidate) => candidate.id === detail.session.currentRunId,
      );
      if (
        run &&
        ![
          "completed",
          "failed",
          "cancelled",
          "paused",
          "awaiting_user",
        ].includes(run.status)
      ) {
        await advanceRun(app, run.id, currentLink?.role ?? "autopilot-child");
      }
    }
    await advanceSession(app, session.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  detail = await getSession(app, session.id);
  trackSessionRuns(detail);
  watcher.diffAll();
  const bible = await jsonRequest<StoryBible>(
    app,
    "GET",
    `/api/projects/${projectId}/story-bible`,
    undefined,
    [200],
  );
  const committedChapters = bible.outline.filter(
    (node) => node.kind === "chapter" && node.status === "committed",
  );
  const rollingPlans = detail.links.filter(
    (link) => link.role === "rolling-plan" && link.outcome === "completed",
  );
  const closingReviews = detail.links.filter(
    (link) => link.role === "closing-review" && link.outcome === "completed",
  );
  const appliedSteers = detail.steers.filter(
    (steer) => steer.status === "applied",
  );
  if (
    detail.session.status !== "completed" ||
    detail.session.completedChapters !== chapters ||
    committedChapters.length !== chapters ||
    rollingPlans.length < 2 ||
    closingReviews.length < 2 ||
    detail.reviews.length < 2 ||
    appliedSteers.length !== 1
  ) {
    throw new Error(
      `Autopilot verification failed: status=${detail.session.status}, committed=${committedChapters.length}, plans=${rollingPlans.length}, closing=${closingReviews.length}, reviews=${detail.reviews.length}, steers=${appliedSteers.length}`,
    );
  }
  checks.push({
    name: "autopilot verification",
    ok: true,
    detail: `${committedChapters.length} chapters, ${rollingPlans.length} plans, ${appliedSteers.length} steers`,
  });
  logger.event("scenario.check", {
    name: "autopilot verification",
    ok: true,
    committedChapters: committedChapters.length,
    rollingPlans: rollingPlans.length,
    closingReviews: closingReviews.length,
    reviews: detail.reviews.length,
    appliedSteers: appliedSteers.length,
  });

  const runIds = new Set([
    foundation.run.id,
    ...(steerRunId ? [steerRunId] : []),
    ...detail.links.map((link) => link.runId),
  ]);
  const callRepository = new SqliteLlmCallRepository(database);
  const calls = [...runIds].flatMap((runId) =>
    callRepository.listForRun(runId),
  );
  const documents = new SqliteDocumentRepository(database);
  const manuscriptCharacters = documents
    .list(projectId, "chapter")
    .flatMap((document) =>
      document.currentVersionId
        ? [
            documents.getVersion(
              projectId,
              document.id,
              document.currentVersionId,
            ),
          ]
        : [],
    )
    .reduce(
      (total, version) => total + (version ? [...version.content].length : 0),
      0,
    );
  process.stdout.write(
    [
      "autopilot-real: COMPLETED",
      `${chapters} chapters`,
      `${rollingPlans.length} rolling plans`,
      `${detail.reviews.length} closing reviews`,
      `${calls.length} model calls`,
      `${manuscriptCharacters} chars`,
      `${recoveryAttempts} automatic failure recoveries`,
      `${Date.now() - wallStart} ms`,
    ].join(" · ") + "\n",
  );
  success = true;
} catch (error) {
  logger.event("scenario.error", {
    message: error instanceof Error ? error.message : String(error),
  });
  checks.push({
    name: "scenario completed",
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  watcher.stop();
  logger.event("scenario.end", {
    success,
    durationMs: Date.now() - Date.parse(startedAt),
  });
  writeSmokeSummary({
    workspace,
    database,
    scenario,
    protocols: args.protocols,
    startedAt,
    success,
    checks,
    extra: { chapters, recoveryAttempts },
  });
  await app.close();
  database.close();
  finalizeSmokeWorkspace(workspace, {
    success,
    keepArtifacts: args.keepArtifacts,
  });
}

function trackSessionRuns(detail: AutopilotDetail) {
  for (const link of detail.links) watcher.track(link.runId);
  if (detail.session.currentRunId) watcher.track(detail.session.currentRunId);
}

async function createApp(database: NodeNarrativeDatabase) {
  return buildApp({
    config,
    database,
    environment: process.env,
    logger: false,
    enableRunWorker: false,
  });
}

async function finishRun(
  target: FastifyInstance,
  runId: string,
  projectId: string,
  label: string,
): Promise<RunSnapshot> {
  let snapshot = await jsonRequest<RunSnapshot>(
    target,
    "GET",
    `/api/runs/${runId}?projectId=${projectId}`,
    undefined,
    [200],
  );
  let lastStep = "";
  for (let index = 0; index < 5_000; index += 1) {
    if (
      ["completed", "failed", "cancelled", "awaiting_user"].includes(
        snapshot.run.status,
      )
    ) {
      break;
    }
    const currentStep =
      snapshot.steps.find((step) => step.status === "running")?.kind ??
      snapshot.steps.find((step) => step.status === "pending")?.kind ??
      "finalize";
    if (currentStep !== lastStep) {
      process.stdout.write(`${label}: ${currentStep}\n`);
      lastStep = currentStep;
    }
    snapshot = await advanceRun(target, runId, label);
    if (snapshot.run.status === "failed_recoverable") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (snapshot.run.status !== "completed") {
    const failedStep = snapshot.steps.find((step) => step.status === "failed");
    throw new Error(
      `${label} ended as ${snapshot.run.status}: ${safeError(failedStep?.error)}`,
    );
  }
  return snapshot;
}

async function advanceRun(
  target: FastifyInstance,
  runId: string,
  label: string,
): Promise<RunSnapshot> {
  const result = await jsonRequest<{ snapshot: RunSnapshot }>(
    target,
    "POST",
    `/api/runs/${runId}/advance`,
    { projectId: new SqliteRunRepository(database).getRun(runId)!.projectId },
    [200],
  );
  tracker.diff(runId);
  const failedStep = result.snapshot.steps.find(
    (step) => step.status === "failed",
  );
  if (failedStep && result.snapshot.run.status === "failed") {
    process.stdout.write(
      `${label}: ${failedStep.kind} failed (${safeError(failedStep.error)})\n`,
    );
  }
  return result.snapshot;
}

async function advanceSession(target: FastifyInstance, sessionId: string) {
  const result = await jsonRequest(
    target,
    "POST",
    `/api/autopilot/sessions/${sessionId}/advance`,
    undefined,
    [200],
  );
  watcher.diffAll();
  return result;
}

async function getSession(target: FastifyInstance, sessionId: string) {
  return jsonRequest<AutopilotDetail>(
    target,
    "GET",
    `/api/autopilot/sessions/${sessionId}`,
    undefined,
    [200],
  );
}

async function jsonRequest<T = unknown>(
  target: FastifyInstance,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload: Record<string, unknown> | undefined,
  expected: readonly number[],
): Promise<T> {
  const response =
    payload === undefined
      ? await target.inject({ method, url })
      : await target.inject({ method, url, payload });
  if (!expected.includes(response.statusCode)) {
    let error: unknown;
    try {
      error = response.json();
    } catch {
      error = { statusCode: response.statusCode };
    }
    throw new Error(
      `${method} ${url} returned ${response.statusCode}: ${safeError(error)}`,
    );
  }
  return response.json() as T;
}

function safeError(value: unknown): string {
  if (!value || typeof value !== "object") return "no structured error";
  const record = value as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : record;
  return (
    [nested.code, nested.message]
      .filter((item) => typeof item === "string")
      .join(" · ") || "unknown error"
  );
}

interface RunSnapshot {
  run: {
    id: string;
    status: string;
  };
  steps: {
    kind: string;
    status: string;
    error: Readonly<Record<string, unknown>> | null;
  }[];
}

interface CandidateSet {
  set: { id: string };
  candidates: unknown[];
}

interface AutopilotSession {
  id: string;
}

interface AutopilotDetail {
  session: {
    status: string;
    currentRunId: string | null;
    completedChapters: number;
    lastError: Readonly<Record<string, unknown>> | null;
  };
  links: {
    runId: string;
    role: "rolling-plan" | "chapter" | "closing-review";
    outcome: string | null;
  }[];
  runs: { id: string; status: string }[];
  steers: { status: string }[];
  reviews: unknown[];
}

interface StoryBible {
  outline: { kind: string; status: string }[];
}
