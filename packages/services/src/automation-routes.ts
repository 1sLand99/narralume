import {
  StoryLineProposalService,
  requireCurrentChapterOutline,
  requirePlanningEntitiesReady,
} from "@narralume/narrative";
import {
  AutopilotSessionDetailSchema,
  AutopilotSessionCreatedSchema,
  AutopilotSessionSchema,
  BackgroundRunCreatedSchema,
  CandidateActionRequestSchema,
  CandidateSetActionRequestSchema,
  CreateAutopilotSessionRequestSchema,
  CreateProjectWithFoundationRequestSchema,
  CreateSteerRequestSchema,
  FoundationCandidateSchema,
  FoundationCandidateSetSchema,
  GenerateFoundationRequestSchema,
  NarrativeRunSchema,
  ProjectFoundationTaskCreatedSchema,
  resolveEffectivePolicy,
  SessionActionRequestSchema,
  SessionResolutionRequestSchema,
  StoryCompassSchema,
  StoryDevelopmentReviewSchema,
  StorySteerSchema,
  SteerDecisionRequestSchema,
  PutCompassRequestSchema,
} from "@narralume/contracts";
import { type AutopilotSession, randomUuid } from "@narralume/domain";
import { buildSteerClassificationRecipe } from "@narralume/harness";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteProjectRepository,
  SqliteProjectCreationRepository,
  SqliteRequestReplayRepository,
  SqliteRunRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
  SqliteNarrativeStateRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import type { AutopilotCoordinator, RouteApp } from "@narralume/services";
import type { RunCoordinator } from "@narralume/services";
import {
  adoptCandidate,
  AutomationServiceError,
  createFoundationRun,
  currentBlockingReview,
  deterministicRequestId,
  hashRequest,
  isRecord,
  isTerminalSessionStatus,
  keepBlockedManuscript,
  latestRunReason,
  requestManuscriptRevision,
  requestSessionCancellation,
  requireWritingAssignment,
  resolveSessionEffectivePolicy,
  resolveSessionFailure,
  sessionProductProjection,
  runProductProjection,
  withRuntimeModelPolicy,
} from "@narralume/services";
import { bootstrapProject } from "@narralume/services";
import { RunRouteError } from "./route-error.js";
import { validateLongLineReferences } from "./story-compass.js";

const ProjectParamsSchema = z.object({ projectId: z.string().trim().min(1) });
const CandidateParamsSchema = z.object({
  candidateId: z.string().trim().min(1),
});
const CandidateSetParamsSchema = z.object({ setId: z.string().trim().min(1) });
const SessionParamsSchema = z.object({ sessionId: z.string().trim().min(1) });

export interface RegisterAutomationRouteOptions {
  coordinator: AutopilotCoordinator;
  runCoordinator: RunCoordinator;
  enableBackgroundWorker: boolean;
  environment: Readonly<Record<string, string | undefined>>;
  beforeCreateAutopilotSession?: (
    input: z.infer<typeof CreateAutopilotSessionRequestSchema>,
  ) => void | Promise<void>;
}

export function registerAutomationRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
  options: RegisterAutomationRouteOptions,
): void {
  const automation = new SqliteAutomationRepository(database);
  const projects = new SqliteProjectRepository(database);
  const projectCreations = new SqliteProjectCreationRepository(database);
  const runs = new SqliteRunRepository(database);
  const story = new SqliteStoryRepository(database);
  const canon = new SqliteCanonRepository(database);
  const reviews = new SqliteReviewRepository(database);
  const requestReplays = new SqliteRequestReplayRepository(database);

  app.route("POST", "/api/projects/with-foundation", async (request) => {
    const input = CreateProjectWithFoundationRequestSchema.parse(request.body);
    const requestHash = hashRequest(input);
    const replay = projectCreations.get(input.requestId);
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new AutomationServiceError(
          "project_foundation.idempotency_conflict",
          "The same requestId was already used for different creation content",
          409,
        );
      }
      const project = requireProject(projects, replay.projectId);
      const snapshot = runs.getSnapshot(replay.runId);
      return {
        status: 202,
        body: ProjectFoundationTaskCreatedSchema.parse({
          project,
          task: {
            ...snapshot,
            ...runProductProjection(snapshot),
          },
          idempotentReplay: true,
        }),
      };
    }

    requireWritingAssignment(database, options.environment);
    const now = new Date().toISOString();
    const projectId = randomUuid();
    const rootOutlineNodeId = randomUuid();
    const runId = randomUuid();
    const snapshot = database.transaction(() => {
      const project = bootstrapProject(database, {
        projectId,
        rootOutlineNodeId,
        title: input.title,
        subtitle: input.subtitle ?? null,
        premise: input.premise ?? input.braindump.slice(0, 2_000),
        language: input.language,
        now,
      });
      const createdRun = createFoundationRun({
        runs,
        runId,
        projectId,
        rootOutlineNodeId,
        braindump: input.braindump,
        preferences: input.preferences,
        policy: input.policy ?? {},
        environment: options.environment,
        now,
      });
      projects.update({ ...project, phase: "foundation", updatedAt: now });
      projectCreations.insert({
        requestId: input.requestId,
        requestHash,
        projectId,
        runId,
        createdAt: now,
      });
      return createdRun;
    });
    if (options.enableBackgroundWorker) options.runCoordinator.wake();
    return {
      status: 202,
      body: ProjectFoundationTaskCreatedSchema.parse({
        project: requireProject(projects, projectId),
        task: {
          ...snapshot,
          ...runProductProjection(snapshot),
        },
        idempotentReplay: false,
      }),
    };
  });

  app.route(
    "POST",
    "/api/projects/:projectId/foundation/generate",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      const project = requireProject(projects, projectId);
      const input = GenerateFoundationRequestSchema.parse(request.body);
      const requestHash = hashRequest(input);
      const runId = deterministicRequestId(
        "foundation-run",
        projectId,
        input.requestId,
      );
      const replay = runs.getRun(runId) ? runs.getSnapshot(runId) : null;
      if (replay) {
        if (replay.run.policy.creationRequestHash !== requestHash) {
          throw new AutomationServiceError(
            "foundation.idempotency_conflict",
            "The same requestId was already used for a different foundation request",
            409,
          );
        }
        return {
          status: 202,
          body: BackgroundRunCreatedSchema.parse({
            ...replay,
            ...runProductProjection(replay),
          }),
        };
      }
      requireWritingAssignment(database, options.environment);
      const root = story
        .listOutline(projectId)
        .find((node) => node.kind === "book");
      const now = new Date().toISOString();
      const snapshot = database.transaction(() => {
        const created = createFoundationRun({
          runs,
          runId,
          projectId,
          rootOutlineNodeId: root?.id ?? null,
          braindump: input.braindump,
          preferences: input.preferences,
          policy: {
            ...(input.policy ?? {}),
            creationRequestId: input.requestId,
            creationRequestHash: requestHash,
          },
          environment: options.environment,
          now,
        });
        if (project.phase === "idea") {
          projects.update({
            ...project,
            premise: project.premise ?? input.braindump.slice(0, 2_000),
            phase: "foundation",
            updatedAt: now,
          });
        }
        return created;
      });
      if (options.enableBackgroundWorker) options.runCoordinator.wake();
      return {
        status: 202,
        body: BackgroundRunCreatedSchema.parse({
          ...snapshot,
          ...runProductProjection(snapshot),
        }),
      };
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/foundation/candidates",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      return automation
        .listCandidateSets(projectId)
        .map((detail) => FoundationCandidateSetSchema.parse(detail));
    },
  );

  app.route("POST", "/api/candidates/:candidateId/actions", async (request) => {
    const { candidateId } = CandidateParamsSchema.parse(request.params);
    const input = CandidateActionRequestSchema.parse(request.body);
    if (input.action === "discard") {
      return FoundationCandidateSchema.parse(
        automation.resolveCandidate(candidateId, {
          status: "discarded",
          ...(input.payload ? { editedPayload: input.payload } : {}),
          now: new Date().toISOString(),
        }),
      );
    }
    return FoundationCandidateSchema.parse(
      adoptCandidate(
        database,
        automation,
        projects,
        story,
        canon,
        candidateId,
        input.payload,
      ),
    );
  });

  app.route("POST", "/api/candidate-sets/:setId/actions", async (request) => {
    const { setId } = CandidateSetParamsSchema.parse(request.params);
    const input = CandidateSetActionRequestSchema.parse(request.body);
    if (input.action === "discard-all") {
      return FoundationCandidateSetSchema.parse(
        automation.discardPendingCandidates(setId, new Date().toISOString()),
      );
    }
    database.transaction(() => {
      for (const candidate of automation.requireCandidateSet(setId)
        .candidates) {
        if (candidate.status === "pending") {
          adoptCandidate(
            database,
            automation,
            projects,
            story,
            canon,
            candidate.id,
          );
        }
      }
    });
    return FoundationCandidateSetSchema.parse(
      automation.requireCandidateSet(setId),
    );
  });

  app.route("GET", "/api/projects/:projectId/compass", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    const compass = automation.getCompass(projectId);
    if (!compass) {
      return {
        status: 404,
        body: {
          error: {
            code: "story_compass.not_found",
            message: "No story compass has been established yet",
          },
        },
      };
    }
    return StoryCompassSchema.parse(compass);
  });

  app.route("PUT", "/api/projects/:projectId/compass", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    const input = PutCompassRequestSchema.parse(request.body);
    return database.transaction(() => {
      const current = automation.getCompass(projectId);
      if ((current?.version ?? null) !== input.expectedVersion) {
        throw new AutomationServiceError(
          "compass.version.conflict",
          "The story compass was updated by another process; refresh and save again",
          409,
        );
      }
      const { expectedVersion, ...fields } = input;
      void expectedVersion;
      validateLongLineReferences(story.listOutline(projectId), input.longLines);
      return StoryCompassSchema.parse(
        automation.upsertCompass({
          projectId,
          ...fields,
          version: current?.version ?? 1,
          updatedAt: new Date().toISOString(),
        }),
      );
    });
  });

  app.route(
    "GET",
    "/api/projects/:projectId/compass/proposals",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      return new StoryLineProposalService(database).list(projectId);
    },
  );
  app.route(
    "POST",
    "/api/projects/:projectId/compass/proposals/:setId/items/:itemId/decision",
    async (request) => {
      const { projectId, setId, itemId } = ProjectParamsSchema.extend({
        setId: z.string().min(1),
        itemId: z.string().min(1),
      }).parse(request.params);
      requireProject(projects, projectId);
      const { action } = z
        .object({ action: z.enum(["apply", "reject"]) })
        .strict()
        .parse(request.body);
      return new StoryLineProposalService(database).decide(
        projectId,
        setId,
        itemId,
        action,
      );
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/compass/reviews",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const state = new SqliteNarrativeStateRepository(database, canon, story);
      return [
        ...state.listLatestSummaries(projectId, "arc"),
        ...state.listLatestSummaries(projectId, "volume"),
      ]
        .toSorted(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
        )
        .map((review) =>
          StoryDevelopmentReviewSchema.parse({
            id: review.id,
            scopeType: review.scopeType,
            outlineNodeId: review.scopeId,
            summary: review.summary,
            recommendations: review.stateDelta.recommendations ?? [],
            compassAdjustments: review.stateDelta.compassAdjustments ?? [],
            createdAt: review.createdAt,
          }),
        );
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/autopilot/sessions",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const input = CreateAutopilotSessionRequestSchema.parse(request.body);
      await options.beforeCreateAutopilotSession?.(input);
      const requestHash = hashRequest(input);
      const sessionId = deterministicRequestId(
        "autopilot-session",
        projectId,
        input.requestId,
      );
      const replay = automation.getSession(sessionId);
      if (replay) {
        if (replay.chapterPolicy.creationRequestHash !== requestHash) {
          throw new AutomationServiceError(
            "autopilot.session.idempotency_conflict",
            "The same requestId was already used for a different autopilot request",
            409,
          );
        }
        return {
          status: 202,
          body: AutopilotSessionCreatedSchema.parse({
            ...toSessionResponse(replay),
            idempotentReplay: true,
          }),
        };
      }
      const activeSession = automation
        .listSessions(projectId)
        .find((session) => !isTerminalSessionStatus(session.status));
      if (activeSession) {
        throw new AutomationServiceError(
          "autopilot.session.active",
          `The project already has an active autopilot session: ${activeSession.id}`,
          409,
        );
      }
      const activeRun = runs
        .listActiveRuns(projectId)
        .find((run) => run.targetOutlineNodeId !== null);
      if (activeRun) {
        throw new AutomationServiceError(
          "project.writing_task.active",
          `The project already has an active chapter run: ${activeRun.id}`,
          409,
        );
      }
      requireWritingAssignment(database, options.environment);
      const policyInput = { ...input.chapterPolicy };
      const { effectivePolicy, warnings } = resolveEffectivePolicy(policyInput);
      for (const warning of warnings) {
        request.log.warn({ code: warning.code }, warning.message);
      }
      const session = automation.createSession({
        id: sessionId,
        projectId,
        mode:
          input.approvalMode === "continuous" ? "autopilot" : "chapter-gate",
        targetChapters: input.targetChapters,
        windowSize: input.windowSize,
        maxRevisionCycles: input.maxRevisionCycles,
        chapterPolicy: {
          ...effectivePolicy,
          explicitPolicyFields: Object.keys(policyInput).sort(),
          planningMode: input.planningMode,
          origin: input.origin,
          creationRequestId: input.requestId,
          creationRequestHash: requestHash,
        },
        now: new Date().toISOString(),
      });
      if (options.enableBackgroundWorker) options.coordinator.wake();
      return {
        status: 202,
        body: AutopilotSessionCreatedSchema.parse({
          ...toSessionResponse(session),
          idempotentReplay: false,
        }),
      };
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/autopilot/sessions",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      return automation
        .listSessions(projectId)
        .map((session) => toSessionResponse(session));
    },
  );

  app.route("GET", "/api/autopilot/sessions/:sessionId", async (request) => {
    const { sessionId } = SessionParamsSchema.parse(request.params);
    return sessionDetail(automation, runs, story, reviews, sessionId);
  });

  app.route(
    "POST",
    "/api/autopilot/sessions/:sessionId/actions",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const input = SessionActionRequestSchema.parse(request.body);
      if (
        input.action === "accept_entities" ||
        input.action === "accept_plan" ||
        input.action === "accept_manuscript" ||
        input.action === "keep_manuscript"
      ) {
        const scope = `autopilot-session:${sessionId}:action`;
        const requestHash = hashRequest(input);
        const detail = database.transaction(() => {
          const replay = requestReplays.get(scope, input.requestId);
          if (replay) {
            if (replay.requestHash !== requestHash) {
              throw new AutomationServiceError(
                "autopilot.action.idempotency_conflict",
                "The same requestId was already used for a different autopilot confirmation",
                409,
              );
            }
            return sessionDetail(automation, runs, story, reviews, sessionId);
          }

          const session = automation.requireSession(sessionId);
          const now = new Date().toISOString();
          if (input.action === "accept_entities") {
            const child = session.currentRunId
              ? runs.getSnapshot(session.currentRunId)
              : null;
            if (
              !child ||
              session.status !== "awaiting_user" ||
              child.run.status !== "awaiting_user" ||
              child.run.cancelRequested ||
              latestRunReason(child) !== "planning_entities_require_decision"
            ) {
              throw new AutomationServiceError(
                "planning.entities.not_awaiting",
                "The session is not waiting for planning entity decisions",
                409,
              );
            }
            requirePlanningEntitiesReady(database, child);
            runs.mergePolicy(
              child.run.id,
              { entityCandidatesApproved: true },
              now,
            );
            runs.resume(child.run.id, now);
            automation.resumeSession(sessionId, now);
          } else if (input.action === "accept_plan") {
            if (!session.currentRunId) {
              throw new AutomationServiceError(
                "autopilot.chapter.none",
                "There is no chapter plan awaiting confirmation",
                409,
              );
            }
            const child = runs.getSnapshot(session.currentRunId);
            requireCurrentChapterOutline(database, child);
            if (
              child.run.status !== "awaiting_user" ||
              latestRunReason(child) !== "scene_plan_approval_required"
            ) {
              throw new AutomationServiceError(
                "autopilot.plan.not_awaiting_approval",
                "The current chapter plan has not reached the confirmation boundary yet",
                409,
              );
            }
            runs.mergePolicy(child.run.id, { planApproved: true }, now);
            runs.resume(child.run.id, now);
            automation.resumeSession(sessionId, now);
          } else if (input.action === "accept_manuscript") {
            if (!session.currentRunId) {
              throw new AutomationServiceError(
                "autopilot.chapter.none",
                "There is no chapter awaiting acceptance",
                409,
              );
            }
            const child = runs.getSnapshot(session.currentRunId).run;
            requireCurrentChapterOutline(database, runs.getSnapshot(child.id));
            if (
              child.status !== "awaiting_user" ||
              child.mode !== "chapter-gate"
            ) {
              throw new AutomationServiceError(
                "autopilot.chapter.not_awaiting_approval",
                "The current chapter has not reached the acceptance boundary yet",
                409,
              );
            }
            runs.mergePolicy(
              child.id,
              { chapterApproved: true, autoApplySettlement: true },
              now,
            );
            runs.resume(child.id, now);
            automation.resumeSession(sessionId, now);
          } else {
            keepBlockedManuscript({
              automation,
              runs,
              reviews,
              sessionId,
              now,
            });
          }

          const result = sessionDetail(
            automation,
            runs,
            story,
            reviews,
            sessionId,
          );
          requestReplays.insert({
            scope,
            requestId: input.requestId,
            requestHash,
            result,
            createdAt: now,
          });
          return result;
        });
        if (options.enableBackgroundWorker) {
          options.runCoordinator.wake();
          options.coordinator.wake();
        }
        return detail;
      }

      const session = automation.requireSession(sessionId);
      const now = new Date().toISOString();
      if (input.action === "pause") {
        automation.requestSessionControl(sessionId, input.action, now);
      } else if (input.action === "cancel") {
        const interruptRunId = database.transaction(() =>
          requestSessionCancellation(
            automation,
            runs,
            story,
            reviews,
            sessionId,
            now,
          ),
        );
        if (interruptRunId) {
          options.runCoordinator.interrupt(interruptRunId, "session_cancelled");
        }
      } else if (input.action === "resume") {
        if (session.currentRunId) {
          const child = runs.getSnapshot(session.currentRunId).run;
          if (child.status === "paused") runs.resume(child.id, now);
        }
        automation.resumeSession(sessionId, now);
      } else if (input.action === "request_revision") {
        if (!session.currentRunId) {
          throw new AutomationServiceError(
            "autopilot.chapter.none",
            "There is no chapter manuscript awaiting acceptance",
            409,
          );
        }
        const current = runs.getSnapshot(session.currentRunId);
        if (current.run.policy.revisionRequestId === input.requestId) {
          if (current.run.policy.revisionInstruction !== input.instruction) {
            throw new AutomationServiceError(
              "revision.idempotency_conflict",
              "The same requestId was already used for a different revision request",
              409,
            );
          }
        } else {
          requestManuscriptRevision(database, {
            sourceRunId: current.run.id,
            requestId: input.requestId,
            instruction: input.instruction,
            now,
          });
        }
      }
      if (options.enableBackgroundWorker) {
        options.runCoordinator.wake();
        options.coordinator.wake();
      }
      return sessionDetail(automation, runs, story, reviews, sessionId);
    },
  );

  app.route(
    "POST",
    "/api/autopilot/sessions/:sessionId/resolutions",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const input = SessionResolutionRequestSchema.parse(request.body);
      const session = automation.requireSession(sessionId);
      if (
        session.lastError?.code === "child.fatal" &&
        input.action !== "stop"
      ) {
        requireWritingAssignment(database, options.environment);
      }
      resolveSessionFailure(
        automation,
        runs,
        story,
        reviews,
        sessionId,
        input.action,
      );
      if (options.enableBackgroundWorker) options.coordinator.wake();
      return sessionDetail(automation, runs, story, reviews, sessionId);
    },
  );

  app.route(
    "POST",
    "/api/autopilot/sessions/:sessionId/steers",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const input = CreateSteerRequestSchema.parse(request.body);
      const session = automation.requireSession(sessionId);
      const requestHash = hashRequest(input);
      const steerId = deterministicRequestId(
        "autopilot-steer",
        sessionId,
        input.requestId,
      );
      const replay = automation.getSteer(steerId);
      if (replay) {
        if (replay.content !== input.content) {
          throw new AutomationServiceError(
            "autopilot.steer.idempotency_conflict",
            "The same requestId was already used for a different steer instruction",
            409,
          );
        }
        return { status: 202, body: StorySteerSchema.parse(replay) };
      }
      if (isTerminalSessionStatus(session.status)) {
        throw new AutomationServiceError(
          "autopilot.steer.session_terminal",
          "The autopilot session has ended and no longer accepts new steer instructions",
          409,
        );
      }
      const now = new Date().toISOString();
      const effectivePolicy = resolveSessionEffectivePolicy(session);
      const runId = deterministicRequestId(
        "autopilot-steer-run",
        sessionId,
        input.requestId,
      );
      const recipe = buildSteerClassificationRecipe(runId);
      const updated = database.transaction(() => {
        const steer = automation.createSteer({
          id: steerId,
          projectId: session.projectId,
          sessionId,
          targetRunId: session.currentRunId,
          content: input.content,
          now,
        });
        runs.create({
          id: runId,
          projectId: session.projectId,
          recipe: recipe.name,
          recipeVersion: recipe.version,
          mode: "manual",
          targetOutlineNodeId: session.currentOutlineNodeId,
          policy: withRuntimeModelPolicy(
            {
              ...effectivePolicy,
              steerId: steer.id,
              creationRequestId: input.requestId,
              creationRequestHash: requestHash,
            },
            options.environment,
          ),
          steps: recipe.steps,
          now,
          priority: 10,
        });
        return automation.setSteerClassificationRun(steer.id, runId, now);
      });
      if (options.enableBackgroundWorker) options.runCoordinator.wake();
      return { status: 202, body: StorySteerSchema.parse(updated) };
    },
  );

  app.route(
    "POST",
    "/api/autopilot/sessions/:sessionId/steers/:steerId/decisions",
    async (request) => {
      const { sessionId, steerId } = z
        .object({
          sessionId: z.string().trim().min(1),
          steerId: z.string().trim().min(1),
        })
        .parse(request.params);
      const input = SteerDecisionRequestSchema.parse(request.body);
      const now = new Date().toISOString();
      const decision = database.transaction(() => {
        const session = automation.requireSession(sessionId);
        const steer = automation.requireSteer(steerId);
        if (steer.sessionId !== sessionId) {
          throw new AutomationServiceError(
            "autopilot.steer.scope_mismatch",
            "The steer instruction does not belong to the current autopilot session",
            404,
          );
        }
        if (
          steer.status !== "awaiting_confirmation" ||
          !["canon_change", "rewrite_existing"].includes(
            steer.classification ?? "",
          )
        ) {
          throw new AutomationServiceError(
            "autopilot.steer.not_decidable",
            "This steer instruction does not need a decision right now",
            409,
          );
        }
        if (session.status !== "awaiting_user") {
          throw new AutomationServiceError(
            "autopilot.session.not_awaiting_steer",
            "The autopilot session is not waiting for a steer decision",
            409,
          );
        }
        if (input.action === "apply") {
          automation.appendActiveNote(sessionId, steer.content, now);
          automation.requestSessionControl(sessionId, "replan", now);
          automation.resolveSteer(steerId, "applied", now);
        } else {
          automation.resolveSteer(steerId, "rejected", now);
        }
        automation.setSessionStatus(sessionId, "running", now, null);
        return {
          cancelRunId: input.action === "apply" ? session.currentRunId : null,
          steer: automation.requireSteer(steerId),
        };
      });
      if (decision.cancelRunId) {
        const child = runs.getRun(decision.cancelRunId);
        if (
          child &&
          !["completed", "failed", "cancelled"].includes(child.status)
        ) {
          runs.requestCancel(child.id, now);
          options.runCoordinator.interrupt(child.id, "steer_replan_accepted");
          options.runCoordinator.wake();
        }
      }
      if (options.enableBackgroundWorker) options.coordinator.wake();
      return {
        steer: StorySteerSchema.parse(decision.steer),
        detail: sessionDetail(automation, runs, story, reviews, sessionId),
      };
    },
  );

  app.route(
    "POST",
    "/api/autopilot/sessions/:sessionId/advance",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const processed = await options.coordinator.advanceSession(sessionId);
      return {
        processed,
        detail: sessionDetail(automation, runs, story, reviews, sessionId),
      };
    },
  );
}

function sessionDetail(
  automation: SqliteAutomationRepository,
  runs: SqliteRunRepository,
  story: SqliteStoryRepository,
  reviews: SqliteReviewRepository,
  sessionId: string,
) {
  automation.reconcileSteerClassifications(sessionId, new Date().toISOString());
  const session = automation.requireSession(sessionId);
  const links = automation.listRunLinks(sessionId);
  return AutopilotSessionDetailSchema.parse({
    session: toSessionResponse(session),
    links,
    runs: links
      .map((link) => runs.getRun(link.runId))
      .filter((run): run is NonNullable<typeof run> => Boolean(run))
      .map((run) => NarrativeRunSchema.parse(run)),
    steers: automation
      .listSteers(sessionId)
      .map((steer) => StorySteerSchema.parse(steer)),
    reviews: automation.listPlanningReviews(sessionId),
    blockingReview: currentBlockingReview(session, runs, reviews),
    ...sessionProductProjection(session, runs, story),
  });
}

function toSessionResponse(session: AutopilotSession) {
  return AutopilotSessionSchema.parse({
    ...session,
    approvalMode: session.mode === "autopilot" ? "continuous" : "per_chapter",
    origin: isRecord(session.chapterPolicy.origin)
      ? session.chapterPolicy.origin
      : null,
    chapterPolicy: resolveSessionEffectivePolicy(session),
  });
}

/** 读取候选生成时保存的基线值；缺失时返回 null（等价于“生成时尚不存在”）。 */

function requireProject(projects: SqliteProjectRepository, projectId: string) {
  const project = projects.get(projectId);
  if (!project) {
    throw new RunRouteError("project.not_found", "Project not found", 404);
  }
  return project;
}
