import { sha256Hex } from "@narralume/domain";
import {
  StoryCompassSchema,
  StoryLineProposalChangesSchema,
} from "@narralume/contracts";
import {
  StoryLineProposalService,
  storyLineReviewEvidence,
  storyLineProposalIssues,
} from "./story-line-proposals.js";
import { ContextCompiler, type ContextSource } from "@narralume/context";

import {
  createOutlineNode,
  type NarrativeRunStep,
  type OutlineNode,
  type RunBudgetUsage,
  type RunSnapshot,
} from "@narralume/domain";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@narralume/harness";
import {
  promptDefaultInstructions,
  promptInvariants,
} from "@narralume/harness";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteContextReceiptRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
  SqliteTemplateRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import type { NarrativeModelClient } from "./model-client.js";
import {
  automationValidator,
  FOUNDATION_CONTRACT,
  FoundationGenerationArtifactSchema,
  FoundationProposalSchema,
  PLANNING_REVIEW_CONTRACT,
  PlanningReviewResultSchema,
  ROLLING_OUTLINE_CONTRACT,
  RollingOutlineProposalSchema,
  STEER_CLASSIFICATION_CONTRACT,
  SteerClassificationResultSchema,
} from "./automation-schemas.js";
import {
  outlineFingerprint,
  planningEntityIssues,
  planningRejections,
  requirePlanningEntitiesReady,
  stagePlanningEntities,
} from "./planning-entities.js";
import {
  authoredInstructions,
  instructionsFor,
  promptLanguageOf,
} from "./prompt-language.js";
import { StoryStatePacketBuilder } from "./story-state-packet.js";
import { outlineContextSources } from "./outline-context.js";
import {
  requireActiveProject,
  requireActiveRunCommit,
} from "./project-guard.js";

export class AutomationWorkerSuite {
  private readonly automation: SqliteAutomationRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly state: SqliteNarrativeStateRepository;
  private readonly templates: SqliteTemplateRepository;
  private readonly storyState: StoryStatePacketBuilder;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.automation = new SqliteAutomationRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.state = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
    this.templates = new SqliteTemplateRepository(database);
    this.storyState = new StoryStatePacketBuilder(
      this.canon,
      this.state,
      this.story,
    );
  }

  /** 替换式指令组装：模板生效内容（override ?? 官方默认）整体替换写作层，
   *  结构不变量由代码追加，不受模板影响。 */
  private authoredInstructions(projectId: string, key: string): string {
    return authoredInstructions({
      language: promptLanguageOf(
        this.projects.get(projectId)?.language ?? null,
      ),
      templateContent: this.templates.getByKey(key)?.effectiveContent ?? null,
      fallback: promptDefaultInstructions(key),
      invariants: promptInvariants(key),
    });
  }

  registry(): WorkerRegistry {
    return {
      "foundation.generate": this.worker(this.generateFoundation.bind(this)),
      "foundation.stage": this.worker(this.stageFoundation.bind(this)),
      "outline.generate": this.worker(this.generateOutline.bind(this)),
      "outline.entities": this.worker(this.stageOutlineEntities.bind(this)),
      "outline.commit": this.worker(this.commitOutline.bind(this)),
      "steer.classify": this.worker(this.classifySteer.bind(this)),
      "arc.review": this.worker(this.reviewArc.bind(this)),
      "volume.review": this.worker(this.reviewVolume.bind(this)),
    };
  }

  private worker(
    execute: (
      snapshot: RunSnapshot,
      step: NarrativeRunStep,
      signal: AbortSignal,
    ) => Promise<StepExecutionResult>,
  ): StepWorker {
    return {
      execute: (snapshot, step, signal) => {
        requireActiveProject(this.database, snapshot.run.projectId);
        return execute(snapshot, step, signal);
      },
    };
  }

  private async generateFoundation(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const project = this.projects.get(snapshot.run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const braindump = policyString(snapshot.run.policy, "braindump");
    const preferences = policyRecord(snapshot.run.policy, "preferences");
    const creativePreferences = {
      genre: preferences.genre ?? null,
      audience: preferences.audience ?? null,
      tone: preferences.tone ?? null,
    };
    const planningTarget = {
      chapters: policyNumber(preferences, "targetChapters", 12),
      wordsPerChapter: policyNumber(preferences, "wordsPerChapter", 3_000),
      volumes: policyNumber(preferences, "volumes", 1),
    };
    const baseline = {
      intentUpdatedAt:
        this.story.getAuthorIntent(snapshot.run.projectId)?.updatedAt ?? null,
      compassVersion:
        this.automation.getCompass(snapshot.run.projectId)?.version ?? null,
    };
    const result = await this.model.structured(
      snapshot.run,
      step,
      "book-foundation",
      {
        instructions: this.authoredInstructions(
          project.id,
          "prompt.book-foundation",
        ),
        messages: [
          {
            role: "user",
            content: [
              `作品暂定名：${project.title}`,
              project.premise ? `已有命题：${project.premise}` : "",
              `作者素材：\n${braindump}`,
              `创作偏好：${JSON.stringify(creativePreferences)}`,
              `规划规模（仅写入故事指南针 compass.target）：${JSON.stringify(planningTarget)}`,
              "给出一组相互协调、但仍可逐条采纳或丢弃的建书候选。",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "foundationMaxOutputTokens",
          8_000,
        ),
      },
      FOUNDATION_CONTRACT,
      automationValidator(FoundationProposalSchema),
      signal,
    );
    return {
      artifactKind: "foundation-proposal",
      output: {
        ...result.value,
        compass: {
          ...result.value.compass,
          target: planningTarget,
        },
        baseline,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async stageFoundation(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const proposal = FoundationGenerationArtifactSchema.parse(
      requiredArtifact(snapshot, "foundation.generate"),
    );
    const setId = `${snapshot.run.id}:foundation-set`;
    const now = this.now().toISOString();
    const candidates = [
      {
        id: `${setId}:intent`,
        kind: "intent" as const,
        label: "作者意图",
        payload: {
          ...proposal.intent,
          baseline: {
            intentUpdatedAt: proposal.baseline.intentUpdatedAt,
          },
        },
      },
      {
        id: `${setId}:compass`,
        kind: "compass" as const,
        label: "故事指南针",
        payload: {
          ...proposal.compass,
          baseline: {
            compassVersion: proposal.baseline.compassVersion,
          },
        },
      },
      ...proposal.entities.map((entity, index) => ({
        id: `${setId}:entity:${index}`,
        kind: "entity" as const,
        label: entity.name,
        payload: { ...entity },
      })),
    ];
    const detail = this.automation.stageCandidateSet({
      id: setId,
      projectId: snapshot.run.projectId,
      sourceRunId: snapshot.run.id,
      title: proposal.title,
      candidates,
      now,
    });
    return {
      artifactKind: "foundation-candidate-set",
      output: {
        candidateSetId: detail.set.id,
        candidateCount: detail.candidates.length,
        rationale: proposal.rationale,
      },
      usage: zeroUsage(),
    };
  }

  private async generateOutline(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const session = this.automation.requireSession(sessionId);
    const project = this.projects.get(session.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const compass = this.automation.getCompass(session.projectId);
    const intent = this.story.getAuthorIntent(session.projectId);
    const outline = this.story.listOutline(session.projectId);
    const entities = this.canon.listEntities(session.projectId, {
      includeRetired: true,
    });
    const steers = this.automation
      .listSteers(sessionId)
      .filter(
        (steer) =>
          steer.status === "applied" &&
          ["future_plan", "canon_change", "rewrite_existing"].includes(
            steer.classification ?? "",
          ),
      )
      .map((steer) => ({
        content: steer.content,
        classification: steer.classification,
        status: steer.status,
      }));
    const continuationState = this.storyState.build({
      projectId: session.projectId,
      audience: "author",
      maxTimelineEvents: 120,
      maxRelationships: 120,
    });
    const remaining = Math.max(
      1,
      session.targetChapters - session.completedChapters,
    );
    const windowSize = Math.min(session.windowSize, remaining);
    const contextWindow =
      this.model.effectiveContextWindow?.(snapshot.run, "rolling-outline") ??
      64_000;
    const outputReserve = Math.min(
      policyNumber(snapshot.run.policy, "planningMaxOutputTokens", 10_000),
      this.model.effectiveOutputLimit?.(snapshot.run, "rolling-outline") ??
        10_000,
      Math.floor(contextWindow * 0.4),
    );
    const latestChapter = outline
      .filter((node) => node.kind === "chapter" && node.status === "committed")
      .at(-1);
    const sources: ContextSource[] = [
      {
        id: "planning-task",
        kind: "task",
        label: "本次规划任务",
        authority: "locked",
        priority: 100,
        required: true,
        compressible: false,
        sourceType: "autopilot_session",
        sourceId: session.id,
        content: JSON.stringify({
          title: project.title,
          windowChapters: windowSize,
          runRemainingChapters: remaining,
          activeStructure: outline
            .filter(
              (node) =>
                ["arc", "volume"].includes(node.kind) &&
                node.status !== "abandoned",
            )
            .slice(-6)
            .map(compactOutline),
        }),
      },
      {
        id: "planning-intent",
        kind: "author-intent",
        label: "作者意图与全书方向",
        authority: "locked",
        priority: 99,
        required: true,
        compressible: false,
        sourceType: "author_intent",
        sourceId: project.id,
        content: JSON.stringify({ intent, compass }),
      },
      ...outlineContextSources({
        projectId: project.id,
        outline,
        chapterSummaries: this.state.listLatestSummaries(project.id, "chapter"),
        targetOutlineNodeId: latestChapter?.id ?? null,
      }),
      {
        id: "planning-entities",
        kind: "canon",
        label: "实体目录与作者拒绝记录",
        authority: "confirmed",
        priority: 98,
        required: true,
        compressible: false,
        sourceType: "canon_entities",
        sourceId: project.id,
        content: JSON.stringify({
          entities: entities.map(
            ({ id, type, name, aliases, description, status }) => ({
              id,
              type,
              name,
              aliases,
              description: description?.slice(0, 240) ?? null,
              status,
            }),
          ),
          rejectedProposals: planningRejections(this.database, project.id),
        }),
      },
      ...continuationState.sources,
      ...new StoryLineProposalService(this.database)
        .list(project.id)
        .slice(0, 12)
        .map((set, index): ContextSource => ({
          id: `story-line-decisions:${set.id}`,
          kind: "author-intent",
          label: "故事线建议与作者逐项裁定",
          content: JSON.stringify({
            scopeNodeId: set.scopeNodeId,
            stale: set.stale,
            items: set.items.map((item) => ({
              title: item.before.title,
              proposal: item.after,
              decision: item.decision ?? "pending",
            })),
          }),
          authority: "reference",
          priority: Math.max(50, 97 - index),
          compressible: false,
          sourceType: "canon_change_set",
          sourceId: set.id,
        })),
      ...[
        ...this.state.listLatestSummaries(project.id, "arc"),
        ...this.state.listLatestSummaries(project.id, "volume"),
      ]
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((review, index): ContextSource => ({
          id: `planning-review:${review.id}`,
          kind: "summary",
          label: "阶段复盘建议（不是已发生事实）",
          content: JSON.stringify({
            scopeId: review.scopeId,
            summary: review.summary,
            suggestions: review.stateDelta,
          }),
          summary: review.summary,
          authority: "reference",
          priority: Math.max(50, 96 - index),
          required: index < 2,
          sourceType: "narrative_summary",
          sourceId: review.id,
        })),
      ...steers.map((steer, index): ContextSource => ({
        id: `planning-steer:${index}`,
        kind: "author-intent",
        label: "作者已确认的后续规划指示",
        content: steer.content,
        authority: "locked",
        priority: 99,
        required: true,
        compressible: false,
        sourceType: "story_steer",
        sourceId: session.id,
      })),
    ];
    const compiled = new ContextCompiler(this.now).compile({
      projectId: project.id,
      purpose: "rolling-outline",
      sources,
      budget: {
        contextWindow,
        outputReserve,
        fixedInstructionReserve: 1_500,
        schemaReserve: 1_500,
        toolReserve: 0,
      },
    });
    new SqliteContextReceiptRepository(this.database).insert(compiled.receipt, {
      runId: snapshot.run.id,
      stepId: step.id,
    });
    const result = await this.model.structured(
      snapshot.run,
      step,
      "rolling-outline",
      {
        instructions: instructionsFor(project.language, {
          "zh-CN": [
            "你是长篇小说滚动规划师。只详细规划当前可见窗口，不要一次冻结整部长篇。",
            "计划必须承接已提交章节，兑现指南针，尊重作者锁定意图与 steer。",
            "故事线候选中的 pending 尚未采纳，reject 已被作者拒绝，均不得当成作者方向。apply 的 result 是当时实际写入记录，当前指南针优先；不要重复被拒绝的变化。",
            "指南针 longLines 的 development 是作者维护的阶段记录：scopeNodeId 指定当前卷或弧，stageGoal 是阶段目标，progress 是作者对进展的记录，openPromises 是尚未兑现的承诺，nextDevelopment 是后续方向。结合当前阶段选择本窗口推进的线，不要求每条线每章出场，也不为完成窗口而全部解决。evidenceChapterIds 指向已定稿章节；核对摘要和事实，不把计划目标或缺少证据的进展记录变成已经发生的事实。",
            "每章要有目标、阻力、转折、结果与结尾钩子；结果必须推动因果链。",
            "先判断既有角色、关系变化与场景能否承担剧情功能；新人物、地点或组织只在本窗口确有需要时提出，entityProposals 可以为空，不设新增数量指标，也不要因为初始名单有限就强迫每段剧情围绕同几个人。每项提案说明 narrativeRole 和 rationale，尊重拒绝记录，不换名重复被拒绝的功能。",
            "章节 pov 和 entityRefs 显式使用 {kind: existing, id: 实体ID} 或 {kind: proposed, id: 提案key}；POV 只能引用人物。复用目录里的稳定 ID，不按名字猜测，不重复已有名字或别名；退役条目不可引用。每项提案必须服务本窗口至少一章，角色描述和剧情功能不是已经发生的事件。",
            "运行剩余章数只表示本次委托的工作量，不表示故事弧、卷或全书必须结束。全书结局只由作者意图与已建立的叙事进展决定，不为用完窗口而提前收束。",
            "volumeId/arcId 填写要继续的现有卷/弧 ID；只有剧情进入新阶段时才填 null 创建新卷/弧。一弧可以跨多个窗口，换窗口不等于换弧。继续已有结构时保留其目标和已经发生的结果。arcId 必须属于选定的 volumeId。",
            "准确输出本次窗口要求的章节数量。nextArc 是可调整的远期骨架，不能当作已发生的事实；复盘建议需评估后落实到本次计划，不得当作作者命令或正典。",
          ],
          en: [
            "You are the rolling planner of a long-form novel. Plan only the currently visible window in detail; never freeze an entire long novel at once.",
            "The plan must continue from committed chapters, honor the compass, and respect the author's locked intent and steers.",
            "For story line proposals, pending is unaccepted and reject is an author rejection; neither is author direction. An apply result records the actual write at that time; the current compass takes precedence. Do not repeat rejected changes.",
            "Each longLines.development entry is an author-maintained stage record: scopeNodeId identifies its volume or arc, stageGoal is the current objective, progress is the author's progress note, openPromises lists outstanding promises, and nextDevelopment gives future direction. Select lines relevant to this window; not every line must appear in every chapter or resolve by the window's end. evidenceChapterIds reference committed chapters. Check summaries and facts; planned goals and unsupported progress notes are not established events.",
            "Each chapter needs a goal, resistance, a turn, an outcome, and a closing hook; outcomes must advance the causal chain.",
            "First consider whether existing characters, changing relationships, and settings can serve the story. Propose a new character, location, or organization only when this window needs one. entityProposals may be empty: there is no quota, and the initial cast need not carry every future conflict. Explain each narrativeRole and rationale, honor rejected proposals, and do not rename a rejected idea to repeat it.",
            "Chapter pov and entityRefs must use {kind: existing, id: entity ID} or {kind: proposed, id: proposal key}. POV must reference a character. Reuse stable catalog IDs, never infer identity from a name or duplicate an existing name or alias. Retired entries cannot be referenced. Every proposal must serve at least one chapter in this window. Descriptions and narrative roles are not events that have already occurred.",
            "Remaining run chapters describe this assignment's workload, not the end of an arc, volume, or book. Resolve the book only when author intent and established narrative progress call for it, never just to finish a window.",
            "Set volumeId/arcId to the existing volume/arc to continue, or null to create one only when the story enters a new phase. An arc may span several windows. Preserve existing goals and established outcomes. arcId must belong to volumeId.",
            "Return exactly the requested window chapter count. nextArc is a revisable future outline, not a past event. Evaluate retrospective suggestions and incorporate useful ones; they are neither author commands nor canon.",
          ],
        }),
        messages: [
          {
            role: "user",
            content: compiled.text,
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: outputReserve,
      },
      ROLLING_OUTLINE_CONTRACT,
      automationValidator(RollingOutlineProposalSchema, (plan) =>
        planningEntityIssues(
          { ...plan, chapters: plan.chapters.slice(0, windowSize) },
          entities,
        ),
      ),
      signal,
    );
    const value = {
      ...result.value,
      chapters: result.value.chapters.slice(0, windowSize),
    };
    return {
      artifactKind: "rolling-outline-proposal",
      output: {
        ...value,
        generation: {
          mode: result.mode,
          attempts: result.attempts,
          // 保存生成时的大纲基线；commit 时比对，防止后台规划覆盖期间的人工编辑。
          outlineFingerprint: outlineFingerprint(outline),
          compassVersion: compass?.version ?? null,
          contextReceiptId: compiled.receipt.id,
        },
      },
      usage: result.usage,
    };
  }

  private async stageOutlineEntities(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const output = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      return stagePlanningEntities(
        this.database,
        snapshot,
        step.id,
        this.now().toISOString(),
      );
    });
    return {
      artifactKind: "planning-entity-candidates",
      output,
      usage: zeroUsage(),
    };
  }

  private async commitOutline(
    snapshot: RunSnapshot,
    _step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const artifact = requiredArtifact(snapshot, "outline.generate");
    const plan = RollingOutlineProposalSchema.parse(artifact);
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const session = this.automation.requireSession(sessionId);
    const now = this.now().toISOString();
    const result = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      const bindings = requirePlanningEntitiesReady(this.database, snapshot);
      const outline = this.story.listOutline(session.projectId);
      const root = outline.find((node) => node.kind === "book");
      if (!root)
        throw permanent(
          "outline.root.missing",
          "Project is missing the book root node",
        );
      let volume = plan.volumeId
        ? this.story.getOutlineNode(session.projectId, plan.volumeId)
        : null;
      if (
        plan.volumeId &&
        (!volume || volume.kind !== "volume" || volume.status === "abandoned")
      ) {
        throw permanent(
          "outline.structure.invalid",
          "The selected volume is unavailable",
        );
      }
      if (!volume) {
        volume = this.story.insertOutlineNode(
          createOutlineNode({
            id: `${snapshot.run.id}:volume`,
            projectId: session.projectId,
            parent: root,
            kind: "volume",
            ordinal: nextOrdinal(outline, root.id),
            title: plan.volume.title,
            summary: plan.volume.summary,
            goal: plan.volume.goal,
            metadata: { detail: "active", sourceRunId: snapshot.run.id },
            now,
          }),
        );
      }
      const volumeChildren = this.story.listOutlineChildren(
        session.projectId,
        volume.id,
      );
      let arc = plan.arcId
        ? this.story.getOutlineNode(session.projectId, plan.arcId)
        : null;
      if (
        plan.arcId &&
        (!arc ||
          arc.kind !== "arc" ||
          arc.parentId !== volume.id ||
          arc.status === "abandoned")
      ) {
        throw permanent(
          "outline.structure.invalid",
          "The selected arc must belong to the selected volume",
        );
      }
      if (arc) {
        arc = this.story.updateOutlineDetails(
          session.projectId,
          arc.id,
          {
            title: plan.arc.title,
            summary: plan.arc.summary,
            goal: plan.arc.goal,
            conflict: plan.arc.conflict,
            outcome: plan.arc.outcome,
            metadata: {
              ...arc.metadata,
              detail: "active",
              sourceRunId: snapshot.run.id,
            },
          },
          now,
        );
      } else {
        arc = this.story.insertOutlineNode(
          createOutlineNode({
            id: `${snapshot.run.id}:arc`,
            projectId: session.projectId,
            parent: volume,
            kind: "arc",
            ordinal: nextOrdinal(volumeChildren, volume.id),
            title: plan.arc.title,
            summary: plan.arc.summary,
            goal: plan.arc.goal,
            conflict: plan.arc.conflict,
            outcome: plan.arc.outcome,
            metadata: { detail: "active", sourceRunId: snapshot.run.id },
            now,
          }),
        );
      }
      const resolveEntity = (ref: {
        kind: "existing" | "proposed";
        id: string;
      }) => (ref.kind === "existing" ? ref.id : bindings.get(ref.id)!);
      const existingChapters = this.story.listOutlineChildren(
        session.projectId,
        arc.id,
      );
      const chapterIds: string[] = [];
      plan.chapters.forEach((chapter, index) => {
        const id = `${snapshot.run.id}:chapter:${index}`;
        const existing = this.story.getOutlineNode(session.projectId, id);
        if (existing) {
          chapterIds.push(existing.id);
          return;
        }
        const node = this.story.insertOutlineNode(
          createOutlineNode({
            id,
            projectId: session.projectId,
            parent: arc!,
            kind: "chapter",
            ordinal: nextOrdinal(existingChapters, arc!.id) + index,
            title: chapter.title,
            summary: chapter.summary,
            goal: chapter.goal,
            conflict: chapter.conflict,
            outcome: chapter.outcome,
            povEntityId: chapter.pov ? resolveEntity(chapter.pov) : null,
            storyTime: chapter.storyTime,
            metadata: {
              hook: chapter.hook,
              sourceRunId: snapshot.run.id,
              planningRationale: plan.rationale,
              plannedEntityIds: [
                ...new Set(
                  [
                    ...chapter.entityRefs,
                    ...(chapter.pov ? [chapter.pov] : []),
                  ].map(resolveEntity),
                ),
              ],
            },
            now,
          }),
        );
        chapterIds.push(node.id);
      });
      let nextArcId: string | null = null;
      if (
        plan.nextArc &&
        !volumeChildren.some(
          (node) =>
            node.kind === "arc" &&
            node.metadata.detail === "skeleton" &&
            node.status !== "abandoned",
        )
      ) {
        const nextId = `${snapshot.run.id}:next-arc`;
        const existing = this.story.getOutlineNode(session.projectId, nextId);
        const nextArc =
          existing ??
          this.story.insertOutlineNode(
            createOutlineNode({
              id: nextId,
              projectId: session.projectId,
              parent: volume,
              kind: "arc",
              ordinal: nextOrdinal(
                this.story.listOutlineChildren(session.projectId, volume.id),
                volume.id,
              ),
              title: plan.nextArc.title,
              summary: plan.nextArc.summary,
              goal: plan.nextArc.goal,
              metadata: { detail: "skeleton", sourceRunId: snapshot.run.id },
              now,
            }),
          );
        nextArcId = nextArc.id;
      }
      const project = this.projects.get(session.projectId);
      if (project && ["idea", "foundation"].includes(project.phase)) {
        this.projects.update({
          ...project,
          phase: "outlining",
          updatedAt: now,
        });
      }
      return { volumeId: volume.id, arcId: arc.id, chapterIds, nextArcId };
    });
    return {
      artifactKind: "rolling-outline-commit",
      output: result,
      usage: zeroUsage(),
    };
  }

  private async classifySteer(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const steerId = policyString(snapshot.run.policy, "steerId");
    const steer = this.automation.requireSteer(steerId);
    const session = steer.sessionId
      ? this.automation.requireSession(steer.sessionId)
      : null;
    const result = await this.model.structured(
      snapshot.run,
      step,
      "steer-classification",
      {
        instructions: instructionsFor(
          this.projects.get(snapshot.run.projectId)?.language ?? null,
          {
            "zh-CN": [
              "你是小说生产 harness 的 steer 仲裁器，只分类影响范围，不创作正文。",
              "立即影响仅用于作者明确要求停止或改变正在生成的内容；涉及既有正文或正典要提高风险。",
              "输出必须选择唯一分类和最早安全生效边界。",
            ],
            en: [
              "You are the steer arbitrator of the novel production harness; classify impact scope only and never write prose.",
              "Immediate impact applies only when the author explicitly asks to stop or change content being generated; anything touching existing prose or canon raises the risk.",
              "The output must choose exactly one classification and the earliest safe effective boundary.",
            ],
          },
        ),
        messages: [
          {
            role: "user",
            content: `运行状态：${session?.status ?? "无会话"}\n作者 steer：${steer.content}`,
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: 1_200,
      },
      STEER_CLASSIFICATION_CONTRACT,
      automationValidator(SteerClassificationResultSchema),
      signal,
    );
    const classified = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      return this.automation.classifySteer(steer.id, {
        ...result.value,
        now: this.now().toISOString(),
      });
    });
    return {
      artifactKind: "steer-classification",
      output: {
        steerId: classified.id,
        classification: classified.classification,
        effectiveBoundary: classified.effectiveBoundary,
        rationale: classified.rationale,
        risk: classified.risk,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private reviewArc(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    return this.reviewScope(snapshot, step, signal, "arc");
  }

  private reviewVolume(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    return this.reviewScope(snapshot, step, signal, "volume");
  }

  private async reviewScope(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
    scopeType: "arc" | "volume",
  ): Promise<StepExecutionResult> {
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const nodeId = policyString(
      snapshot.run.policy,
      scopeType === "arc" ? "arcId" : "volumeId",
    );
    const node = this.story.requireOutlineNode(snapshot.run.projectId, nodeId);
    if (node.kind !== scopeType) {
      throw permanent(
        "planning_review.scope.invalid",
        `Planning review target kind ${node.kind} is not ${scopeType}`,
      );
    }
    const baselineCompass = this.automation.getCompass(snapshot.run.projectId);
    const evidenceBaseline = storyLineReviewEvidence(
      this.database,
      snapshot.run.projectId,
      node.id,
    );
    const evidence = evidenceBaseline.evidence;
    const source = JSON.stringify(evidence);
    const contextWindow =
      this.model.effectiveContextWindow?.(
        snapshot.run,
        `${scopeType}-review`,
      ) ?? 64_000;
    const outputReserve = Math.min(
      4_000,
      this.model.effectiveOutputLimit?.(snapshot.run, `${scopeType}-review`) ??
        4_000,
      Math.floor(contextWindow * 0.4),
    );
    const compiled = new ContextCompiler(this.now).compile({
      projectId: snapshot.run.projectId,
      purpose: `${scopeType}-review`,
      budget: {
        contextWindow,
        outputReserve,
        fixedInstructionReserve: 1_000,
        schemaReserve: 1_000,
        toolReserve: 0,
      },
      sources: [
        {
          id: "review-task",
          kind: "task",
          label: "复盘范围与全书方向",
          authority: "locked",
          priority: 100,
          required: true,
          compressible: false,
          sourceType: "outline_node",
          sourceId: node.id,
          content: JSON.stringify({
            scope: node.title,
            compass: baselineCompass,
          }),
        },
        ...evidence.map((chapter, index): ContextSource => ({
          id: `review-chapter:${chapter.chapterId}`,
          kind: "summary",
          label: chapter.title,
          content: JSON.stringify(chapter),
          authority: "confirmed",
          compressible: false,
          priority: 60 + 30 * ((index + 1) / evidence.length),
          sourceType: "outline_node",
          sourceId: chapter.chapterId,
        })),
      ],
    });
    new SqliteContextReceiptRepository(this.database).insert(compiled.receipt, {
      runId: snapshot.run.id,
      stepId: step.id,
    });
    const result = await this.model.structured(
      snapshot.run,
      step,
      `${scopeType}-review`,
      {
        instructions: instructionsFor(
          this.projects.get(snapshot.run.projectId)?.language ?? null,
          {
            "zh-CN": [
              `你是长篇小说${scopeType === "arc" ? "故事弧" : "卷"}复盘编辑。`,
              "基于章节摘要评估承诺兑现、因果、人物弧、节奏和连续性。建议服务于下一滚动窗口，不改写已提交事实。",
              "这是当前已写部分的阶段复盘，不意味着故事弧、卷或全书已经结束。区分已兑现、仍在发展和需要后续处理的承诺；不要仅因本次运行结束而要求结局或回收所有伏笔。仅依据所给摘要判断，明确证据不足之处。",
              "对照长期故事线的阶段目标、作者进展记录与未兑现承诺，指出有摘要支持的变化和下一阶段建议。作者记录本身不是正文证据，计划中的 nextDevelopment 尚未发生；调整仅作为 compassAdjustments 建议，不自动修改故事线。",
              "lineProposals 是供作者逐项接受或拒绝的建议。lineIndex 是 compass.longLines 的零基索引，每条线最多一项；仅引用本次实际提供的 chapterId 作为 evidenceChapterIds。progress 概括有摘要支持的进展，openPromises 保留尚未兑现的承诺，nextDevelopment 仅为后续方向。不要仅因阶段结束建议 resolved；无有效证据则返回空数组。",
            ],
            en: [
              `You are the retrospective editor of a long-form novel ${scopeType === "arc" ? "story arc" : "volume"}.`,
              "Assess promise fulfillment, causality, character arcs, pacing, and continuity from chapter summaries. Suggestions serve the next rolling window and never rewrite committed facts.",
              "This reviews progress so far, not an assumed arc, volume, or book ending. Distinguish fulfilled promises, ongoing developments, and future work. Do not demand an ending or resolve every setup because this run is over. State evidence limitations when summaries are insufficient.",
              "Compare long-line stage goals, author progress notes, and open promises with the supplied summaries. Identify supported changes and possible next developments. Author notes are not manuscript evidence, and planned nextDevelopment has not happened. Return adjustments as compassAdjustments suggestions without updating story lines.",
              "Return lineProposals for individual author decisions. lineIndex is the zero-based compass.longLines index; at most one proposal per line. evidenceChapterIds may only reference chapterId values actually supplied. progress records supported developments, openPromises retains outstanding promises, and nextDevelopment is future direction. Never suggest resolved merely because this stage ends. Return an empty array without valid evidence.",
            ],
          },
        ),
        messages: [
          {
            role: "user",
            content: compiled.text,
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: outputReserve,
      },
      PLANNING_REVIEW_CONTRACT,
      automationValidator(PlanningReviewResultSchema, (value) =>
        storyLineProposalIssues(
          value.lineProposals,
          baselineCompass?.longLines.length ?? 0,
          new Set(
            compiled.sections
              .filter((section) => section.id.startsWith("review-chapter:"))
              .map((section) => section.sourceId!),
          ),
        ),
      ),
      signal,
    );
    const now = this.now().toISOString();
    const sourceHash = sha256(source);
    this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      if (result.value.lineProposals.length && baselineCompass) {
        if (
          this.automation.getCompass(snapshot.run.projectId)?.version !==
            baselineCompass.version ||
          storyLineReviewEvidence(
            this.database,
            snapshot.run.projectId,
            node.id,
          ).fingerprint !== evidenceBaseline.fingerprint
        ) {
          throw permanent(
            "story_line_proposal.stale",
            "The compass or evidence changed while reviewing",
          );
        }
        new SqliteReviewRepository(this.database).insertCanonChangeSet({
          id: `${step.id}:story-lines`,
          projectId: snapshot.run.projectId,
          runId: snapshot.run.id,
          stepId: step.id,
          changes: StoryLineProposalChangesSchema.parse({
            kind: "story_line_progress",
            scopeNodeId: node.id,
            compass: StoryCompassSchema.parse(baselineCompass),
            evidenceFingerprint: evidenceBaseline.fingerprint,
            evidence: evidence.filter((chapter) =>
              compiled.sections.some(
                (section) => section.sourceId === chapter.chapterId,
              ),
            ),
            items: result.value.lineProposals,
          }),
          status: "candidate",
          createdAt: now,
        });
      }
      this.automation.insertPlanningReview({
        id: step.id,
        projectId: snapshot.run.projectId,
        sessionId,
        runId: snapshot.run.id,
        scopeType,
        outlineNodeId: node.id,
        summary: result.value.summary,
        scores: result.value.scores,
        recommendations: result.value.recommendations,
        sourceHash,
        createdAt: now,
      });
      this.state.upsertSummary({
        id: `${step.id}:summary`,
        projectId: snapshot.run.projectId,
        scopeType,
        scopeId: node.id,
        summary: result.value.summary,
        stateDelta: {
          recommendations: result.value.recommendations,
          compassAdjustments: result.value.compassAdjustments,
        },
        sourceHash,
        createdAt: now,
      });
    });
    return {
      artifactKind: `${scopeType}-review`,
      output: {
        ...result.value,
        outlineNodeId: node.id,
        sourceHash,
        generation: { mode: result.mode, attempts: result.attempts },
        contextReceiptId: compiled.receipt.id,
      },
      usage: result.usage,
    };
  }
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
): Record<string, unknown> {
  const artifact = snapshot.steps.find(
    (step) => step.kind === kind && step.status === "succeeded",
  )?.outputArtifact;
  if (!artifact)
    throw permanent("artifact.missing", `Missing ${kind} artifact`);
  return { ...artifact };
}

function compactOutline(node: OutlineNode) {
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    title: node.title,
    summary: node.summary,
    status: node.status,
    metadata: node.metadata,
  };
}

function nextOrdinal(nodes: readonly OutlineNode[], parentId: string): number {
  return (
    Math.max(
      -1,
      ...nodes
        .filter((node) => node.parentId === parentId)
        .map((node) => node.ordinal),
    ) + 1
  );
}

function policyString(
  policy: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = policy[key];
  if (typeof value !== "string" || !value.trim()) {
    throw permanent("run.policy.invalid", `Run policy is missing ${key}`);
  }
  return value;
}

function policyRecord(
  policy: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const value = policy[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function policyNumber(
  policy: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = policy[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function zeroUsage(): RunBudgetUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    costUsd: 0,
    wallTimeMs: 0,
  };
}

function sha256(value: string): string {
  return sha256Hex(value);
}

function permanent(code: string, message: string) {
  return { code, message, retryable: false };
}
