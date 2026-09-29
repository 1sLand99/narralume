import { resolve } from "node:path";

import { config as loadDotEnv } from "dotenv";

import { seedEnvironmentModelConfig } from "@narralume/services";
import { resolveEffectivePolicy } from "@narralume/contracts";
import {
  createOutlineNode,
  createProject,
  type RunStatus,
} from "@narralume/domain";
import { buildChapterRecipe, HarnessSupervisor } from "@narralume/harness";
import {
  ChapterWorkerSuite,
  GatewayNarrativeModelClient,
} from "@narralume/narrative";
import {
  SqliteAssignmentRepository,
  SqliteDocumentRepository,
  SqliteLlmCallRepository,
  SqliteModelRepository,
  SqliteProjectRepository,
  SqliteProviderRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  resolveCredential,
  type StoredProvider,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";

import {
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

const scenario = "chapter-real";
const args = parseRealSmokeArgs(process.argv.slice(2), {
  script: "chapter-real-smoke.ts",
  defaultProtocols: ["openai-chat", "openai-responses", "anthropic-messages"],
});
const workspace = createSmokeWorkspace(scenario, { outputDir: args.outputDir });
const logger = new SmokeLogger(workspace.jsonlPath, scenario, {
  diagnostic: args.diagnostic,
});
installSignalFlush(logger);
const startedAt = new Date().toISOString();
const checks: SmokeCheck[] = [];
const chapterResults: Array<{
  protocol: string;
  runId: string;
  status: RunStatus;
  documentVersionId: string | null;
  contentHash: string | null;
  characters: number;
  reviews: number;
}> = [];

const database = new NodeNarrativeDatabase(workspace.dbPath);
database.migrate();
interruptOrphanedWork(logger, database);
seedEnvironmentModelConfig(database, process.env);
const providers = new SqliteProviderRepository(database);
const models = new SqliteModelRepository(database);
const assignments = new SqliteAssignmentRepository(database);
const providerByWireApi = new Map<string, StoredProvider>(
  providers.list(true).map((provider) => [provider.wireApi, provider]),
);
const model = new GatewayNarrativeModelClient(database, process.env);
const suite = new ChapterWorkerSuite(database, model);
const runs = new SqliteRunRepository(database);
const supervisor = new HarnessSupervisor(runs, suite.registry(), {
  retryDelayMs: 10,
});
const tracker = new RunStateTracker(logger, database, {
  diagnostic: args.diagnostic,
});
const watcher = new RunWatcher(tracker);
watcher.startPolling();
const terminal = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
  "awaiting_user",
]);
let failed = false;

logger.event("scenario.start", {
  protocols: args.protocols,
  workspace: workspace.dir,
  gitCommit: currentGitCommit(),
});

try {
  for (const protocol of args.protocols) {
    const provider = providerByWireApi.get(protocol);
    const writingModel = provider
      ? models.listByProvider(provider.id, true)[0]
      : undefined;
    const credential = provider
      ? resolveCredential(provider, process.env)
      : null;
    if (!provider || !writingModel || !credential?.ok) {
      process.stdout.write(
        `${protocol}: SKIPPED (missing local configuration)\n`,
      );
      checks.push({
        name: `${protocol} configured`,
        ok: false,
        detail: "missing local configuration",
      });
      failed = true;
      continue;
    }
    // The runtime resolves calls through the writing assignment; point it at
    // this protocol's environment model for the duration of the run.
    assignments.set("writing", writingModel.id, new Date().toISOString());
    logger.event("model.resolved", {
      protocol: provider.wireApi,
      model: writingModel.modelId,
      baseUrlOrigin: originOf(provider.baseUrl),
    });
    const now = new Date().toISOString();
    const projectId = `real-${protocol}`;
    const chapterId = `${projectId}-chapter`;
    new SqliteProjectRepository(database).insert(
      createProject({
        id: projectId,
        title: `真实协议试写 · ${protocol}`,
        premise:
          "守夜人发现，每当废弃车站的钟走慢一分钟，就会有人提前忘记明天。",
        now,
      }),
    );
    const story = new SqliteStoryRepository(database);
    const root = story.insertOutlineNode(
      createOutlineNode({
        id: `${projectId}-book`,
        projectId,
        parent: null,
        kind: "book",
        ordinal: 0,
        title: "迟钟站",
        now,
      }),
    );
    story.insertOutlineNode(
      createOutlineNode({
        id: chapterId,
        projectId,
        parent: root,
        kind: "chapter",
        ordinal: 0,
        title: "慢下的一分钟",
        summary: "守夜人苏砚第一次目睹站钟逆走，并发现旅客忘记了明日的约定。",
        goal: "用可见行动建立钟与遗忘的因果规则",
        conflict: "唯一的旅客坚持车站从来没有钟",
        outcome: "苏砚留下可复验的记号，决定继续调查",
        now,
      }),
    );
    story.upsertAuthorIntent({
      projectId,
      promise: "超自然规则必须可观察、有代价且前后一致。",
      themes: ["记忆", "时间", "责任"],
      audience: "成年类型小说读者",
      tone: "克制、具体、带微弱悬疑",
      boundaries: ["不使用模型自述", "不以总结段解释主题"],
      endingDirection: null,
      currentFocus: "建立第一条可验证规则",
      lockedFields: ["promise", "boundaries"],
      updatedAt: now,
    });

    const runId = `${projectId}-run`;
    const recipe = buildChapterRecipe(runId, 2);
    runs.create({
      id: runId,
      projectId,
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: chapterId,
      policy: resolveEffectivePolicy({
        requestStartTimeoutMs: 45_000,
        maxRetries: 1,
        // 小模型审稿引文需要多一轮带反馈的修复机会（M6 实测）
        maxRepairAttempts: 2,
        // 推理模型会将 reasoning token 计入输出预算；
        // 结构化/修订调用预算过低会截断 JSON（M5 基线发现）。
        minChapterCharacters: 180,
      }).effectivePolicy,
      steps: recipe.steps,
      now,
    });
    logger.event("run.created", { runId, projectId, protocol });
    watcher.track(runId);

    const started = Date.now();
    for (let index = 0; index < 200; index += 1) {
      const status = runs.getRun(runId)?.status;
      if (status && terminal.has(status)) break;
      const processed = await supervisor.processRun(
        runId,
        `real-smoke-${protocol}`,
      );
      tracker.diff(runId);
      if (!processed) {
        // M3 起步骤重试带退避：job 的 available_at 在未来时 processRun
        // 返回 false。运行仍处于 failed_recoverable/running 时等待退避
        // 窗口后继续驱动，而不是误判为停滞退出。
        const current = runs.getRun(runId)?.status;
        if (current === "failed_recoverable" || current === "running") {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        break;
      }
    }
    tracker.diff(runId);
    const snapshot = runs.getSnapshot(runId);
    const documents = new SqliteDocumentRepository(database).list(
      projectId,
      "chapter",
    );
    const document = documents[0];
    const version = document?.currentVersionId
      ? new SqliteDocumentRepository(database).getVersion(
          projectId,
          document.id,
          document.currentVersionId,
        )
      : null;
    const calls = new SqliteLlmCallRepository(database).listForRun(runId);
    const reviews = new SqliteReviewRepository(database).listReports(runId);
    chapterResults.push({
      protocol,
      runId,
      status: snapshot.run.status,
      documentVersionId: version?.id ?? null,
      contentHash: version?.contentHash ?? null,
      characters: version ? [...version.content].length : 0,
      reviews: reviews.length,
    });
    process.stdout.write(
      `${protocol}: ${snapshot.run.status.toUpperCase()} · ${calls.length} calls · ${version ? [...version.content].length : 0} chars · ${reviews.length} reviews · ${Date.now() - started} ms\n`,
    );
    const ok = snapshot.run.status === "completed" && Boolean(version?.content);
    checks.push({
      name: `${protocol} chapter completed`,
      ok: snapshot.run.status === "completed",
      detail: `status=${snapshot.run.status}`,
    });
    checks.push({
      name: `${protocol} chapter content`,
      ok: Boolean(version?.content),
      detail: `${version ? [...version.content].length : 0} chars`,
    });
    logger.event("scenario.check", {
      protocol,
      ok,
      status: snapshot.run.status,
      calls: calls.length,
      characters: version ? [...version.content].length : 0,
    });
    if (!ok) {
      failed = true;
      const failedStep = snapshot.steps.find(
        (step) => step.status === "failed",
      );
      if (failedStep?.error) {
        process.stdout.write(
          `  ${failedStep.kind}: ${failedStep.error.code} · ${failedStep.error.message.slice(0, 300)}\n`,
        );
        if (failedStep.error.details) {
          process.stdout.write(
            `  details: ${JSON.stringify(failedStep.error.details).slice(0, 1_000)}\n`,
          );
        }
      }
      for (const call of calls) {
        process.stdout.write(
          `  call ${call.purpose}: ${call.status} · ${call.finishReason ?? "no-finish"} · output ${call.usage?.outputTokens ?? 0} · reasoning ${call.usage?.reasoningTokens ?? 0}\n`,
        );
      }
      const lastEvent = snapshot.events.at(-1);
      if (lastEvent) {
        process.stdout.write(`  last event: ${lastEvent.type}\n`);
      }
    }
  }
} catch (error) {
  failed = true;
  logger.event("scenario.error", {
    message: error instanceof Error ? error.message : String(error),
  });
  checks.push({
    name: "scenario completed",
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  });
} finally {
  watcher.stop();
  const success = !failed;
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
    extra: { chapters: chapterResults },
  });
  database.close();
  finalizeSmokeWorkspace(workspace, {
    success,
    keepArtifacts: args.keepArtifacts,
  });
}

if (failed) {
  process.stderr.write(
    "One or more real chapter pipelines did not complete.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write("All selected real chapter pipelines completed.\n");
}
