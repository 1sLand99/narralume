import type { NarrativeRunStep, RunSnapshot } from "@narralume/domain";

import {
  classifyStepError,
  computeRetryBackoffMs,
  resolveHarnessRetryPolicy,
  RETRY_SCHEDULED_EVENT,
} from "./retry.js";

/** Extra context for a fail_run caused by a fatal error classification. */
export interface FatalShortcutInfo {
  stepId: string;
  category: string;
  message: string;
}

/** Extra context for a fail_run caused by an exhausted retry budget. */
export interface RetryExhaustedInfo {
  stepId: string;
  attempts: number;
  reason: "attempts_exhausted" | "run_deadline_exceeded";
}

export type HarnessAction =
  | { type: "start_step"; stepId: string }
  | {
      type: "retry_step";
      stepId: string;
      delayMs: number;
      reason: string;
      category: string | null;
      /** Attempts already consumed (the attempt that just failed). */
      attempt: number;
      /** Effective cap: min(step.maxAttempts, policy.maxRetries + 1). */
      maxAttempts: number;
      nextAttemptAt: string;
    }
  | { type: "skip_steps"; stepIds: readonly string[]; reason: string }
  | { type: "pause_run" }
  | { type: "cancel_run" }
  | { type: "await_user"; reason: string; stepId: string | null }
  | {
      type: "fail_run";
      reason: string;
      stepId: string | null;
      fatalShortcut?: FatalShortcutInfo;
      retryExhausted?: RetryExhaustedInfo;
    }
  | { type: "complete_run" }
  | { type: "wait"; reason: string };

export interface RouteOptions {
  now?: () => Date;
  random?: () => number;
}

const TERMINAL = new Set(["failed", "cancelled", "completed"]);

export function routeRun(
  snapshot: RunSnapshot,
  options: RouteOptions = {},
): HarnessAction {
  const { run, steps } = snapshot;
  if (TERMINAL.has(run.status)) return { type: "wait", reason: "terminal" };
  if (run.cancelRequested) return { type: "cancel_run" };
  if (run.pauseRequested) return { type: "pause_run" };
  if (run.status === "paused" || run.status === "awaiting_user") {
    return { type: "wait", reason: run.status };
  }
  if (steps.some((step) => step.status === "running")) {
    return { type: "wait", reason: "step_running" };
  }

  const failed = steps.find((step) => step.status === "failed");
  if (failed) return routeFailedStep(snapshot, failed, options);

  const settlementConflict = steps.find(
    (step) =>
      step.kind === "chapter.commit" &&
      step.status === "succeeded" &&
      step.outputArtifact?.settlementConflict &&
      run.policy.settlementConflictResolved !== true,
  );
  if (settlementConflict) {
    return {
      type: "await_user",
      reason: "settlement_conflict_requires_resolution",
      stepId: settlementConflict.id,
    };
  }

  const next = steps.find((step) => step.status === "pending");
  if (!next) {
    return steps.every((step) =>
      ["succeeded", "skipped", "cancelled"].includes(step.status),
    )
      ? { type: "complete_run" }
      : { type: "wait", reason: "no_routable_step" };
  }

  if (
    next.kind === "outline.commit" &&
    steps.some(
      (step) =>
        step.kind === "outline.entities" &&
        step.status === "succeeded" &&
        typeof step.outputArtifact?.candidateSetId === "string",
    ) &&
    run.policy.entityCandidatesApproved !== true
  ) {
    return {
      type: "await_user",
      reason: "planning_entities_require_decision",
      stepId: next.id,
    };
  }

  if (
    next.kind === "draft.generate" &&
    run.policy.planningMode === "confirm" &&
    run.policy.planApproved !== true
  ) {
    return {
      type: "await_user",
      reason: "scene_plan_approval_required",
      stepId: next.id,
    };
  }

  if (
    next.kind === "chapter.commit" &&
    run.mode === "chapter-gate" &&
    run.policy.chapterApproved !== true
  ) {
    return {
      type: "await_user",
      reason: "chapter_commit_approval_required",
      stepId: next.id,
    };
  }

  if (next.kind === "semantic.review") {
    const check = latestSucceededGate(steps, next.cycle);
    const verdict = gateVerdict(check);
    if (verdict === "revise" && hasPendingRevisionBeforeSettle(steps, next)) {
      return {
        type: "skip_steps",
        stepIds: [next.id],
        reason: "deterministic_check_requires_revision",
      };
    }
    if (verdict === "block") {
      return {
        type: "await_user",
        reason: "deterministic_check_blocked",
        stepId: check?.id ?? null,
      };
    }
  }

  if (next.kind === "revision.generate") {
    if (
      run.recipe === "chapter-candidate-revision" &&
      next.id.endsWith(":revise:requested") &&
      typeof run.policy.revisionSourceRunId === "string"
    ) {
      return { type: "start_step", stepId: next.id };
    }
    const gate = latestSucceededGate(steps, next.cycle);
    const verdict = gateVerdict(gate);
    if (verdict === "pass") {
      return {
        type: "skip_steps",
        stepIds: steps
          .filter(
            (step) =>
              step.status === "pending" && step.ordinal < settleOrdinal(steps),
          )
          .map((step) => step.id),
        reason: "quality_gate_passed",
      };
    }
    if (verdict === "block") {
      if (reviewBlockOverridden(run, gate)) {
        return {
          type: "skip_steps",
          stepIds: steps
            .filter(
              (step) =>
                step.status === "pending" &&
                step.ordinal < settleOrdinal(steps),
            )
            .map((step) => step.id),
          reason: "review_block_overridden",
        };
      }
      return {
        type: "await_user",
        reason: "semantic_review_blocked",
        stepId: gate?.id ?? null,
      };
    }
    if (verdict !== "revise") {
      return {
        type: "fail_run",
        reason: "gate_verdict_missing",
        stepId: gate?.id ?? null,
      };
    }
  }

  if (next.kind === "chapter.settle" && run.recipe !== "manual-settlement") {
    /* 审稿闸门只约束 AI 产出的候选稿；手动结算的对象是作者已正式提交
       的正文版本，本身不存在“未过审”状态。 */
    const gate = latestSucceededGate(steps);
    const verdict = gateVerdict(gate);
    if (verdict !== "pass" && !reviewBlockOverridden(run, gate)) {
      const canCommitForReview =
        verdict === "revise" &&
        !gateHasCriticalIssue(gate) &&
        (run.mode === "autopilot" || run.mode === "chapter-gate");
      if (canCommitForReview) {
        return { type: "start_step", stepId: next.id };
      }
      return {
        type: "await_user",
        reason:
          verdict === "revise" && gateHasCriticalIssue(gate)
            ? "critical_review_unresolved"
            : verdict === "revise"
              ? "revision_limit_reached"
              : "quality_gate_blocked",
        stepId: gate?.id ?? null,
      };
    }
  }

  return { type: "start_step", stepId: next.id };
}

/**
 * Decides what to do with a failed step. The harness is the single retry
 * owner: fatal classifications short-circuit the run, cancelled errors never
 * retry, and retryable errors are rescheduled with exponential backoff
 * (persisted as an event by the supervisor) instead of an immediate restart.
 */
function routeFailedStep(
  snapshot: RunSnapshot,
  failed: NarrativeRunStep,
  options: RouteOptions,
): HarnessAction {
  const error = failed.error;
  const classification = classifyStepError(error);
  const code = error?.code ?? "step_failed";

  if (classification.kind === "fatal") {
    return {
      type: "fail_run",
      reason: code,
      stepId: failed.id,
      fatalShortcut: {
        stepId: failed.id,
        category: classification.category ?? "unknown",
        message: error?.message ?? "",
      },
    };
  }
  if (classification.kind === "cancelled") {
    return { type: "fail_run", reason: code, stepId: failed.id };
  }

  const retryable =
    classification.kind === "retryable" ? true : (error?.retryable ?? false);
  if (!retryable) {
    return { type: "fail_run", reason: code, stepId: failed.id };
  }

  const policy = resolveHarnessRetryPolicy(snapshot.run.policy);
  const maxAttempts = Math.min(failed.maxAttempts, policy.maxRetries + 1);
  if (failed.attempt >= maxAttempts) {
    return {
      type: "fail_run",
      reason: code,
      stepId: failed.id,
      retryExhausted: {
        stepId: failed.id,
        attempts: failed.attempt,
        reason: "attempts_exhausted",
      },
    };
  }

  // A retry was already scheduled for this attempt (event persisted before
  // the delayed requeue); the delayed job is now due, so run the step.
  if (hasScheduledRetry(snapshot, failed)) {
    return { type: "start_step", stepId: failed.id };
  }

  const now = options.now?.() ?? new Date();
  const delayMs = computeRetryBackoffMs(
    failed.attempt,
    policy.retryBaseDelayMs,
    options.random,
  );
  const nextAttemptAt = new Date(now.getTime() + delayMs);
  if (policy.runDeadlineMs !== null) {
    const deadlineAt =
      new Date(snapshot.run.createdAt).getTime() + policy.runDeadlineMs;
    if (nextAttemptAt.getTime() > deadlineAt) {
      return {
        type: "fail_run",
        reason: "run_deadline_exceeded",
        stepId: failed.id,
        retryExhausted: {
          stepId: failed.id,
          attempts: failed.attempt,
          reason: "run_deadline_exceeded",
        },
      };
    }
  }
  return {
    type: "retry_step",
    stepId: failed.id,
    delayMs,
    reason: code,
    category: classification.category,
    attempt: failed.attempt,
    maxAttempts,
    nextAttemptAt: nextAttemptAt.toISOString(),
  };
}

function hasScheduledRetry(
  snapshot: RunSnapshot,
  step: NarrativeRunStep,
): boolean {
  return snapshot.events.some(
    (event) =>
      event.type === RETRY_SCHEDULED_EVENT &&
      event.payload["stepId"] === step.id &&
      event.payload["attempt"] === step.attempt,
  );
}

function reviewBlockOverridden(
  run: RunSnapshot["run"],
  gate: NarrativeRunStep | undefined,
): boolean {
  return (
    gate?.kind === "semantic.review" &&
    gate.outputArtifact?.verdict === "block" &&
    run.policy.reviewOverrideStepId === gate.id
  );
}

function latestSucceededGate(
  steps: readonly NarrativeRunStep[],
  cycle?: number,
): NarrativeRunStep | undefined {
  return [...steps]
    .reverse()
    .find(
      (step) =>
        step.status === "succeeded" &&
        (step.kind === "deterministic.check" ||
          step.kind === "semantic.review") &&
        (cycle === undefined || step.cycle === cycle),
    );
}

function gateVerdict(
  step: NarrativeRunStep | undefined,
): "pass" | "revise" | "block" | null {
  const verdict = step?.outputArtifact?.verdict;
  return verdict === "pass" || verdict === "revise" || verdict === "block"
    ? verdict
    : null;
}

function gateHasCriticalIssue(step: NarrativeRunStep | undefined): boolean {
  const issues = step?.outputArtifact?.issues;
  return (
    Array.isArray(issues) &&
    issues.some(
      (issue) =>
        Boolean(issue) &&
        typeof issue === "object" &&
        !Array.isArray(issue) &&
        (issue as Record<string, unknown>).severity === "critical",
    )
  );
}

function hasPendingRevisionBeforeSettle(
  steps: readonly NarrativeRunStep[],
  review: NarrativeRunStep,
): boolean {
  const settlement = settleOrdinal(steps);
  return steps.some(
    (step) =>
      step.status === "pending" &&
      step.kind === "revision.generate" &&
      step.ordinal > review.ordinal &&
      step.ordinal < settlement,
  );
}

function settleOrdinal(steps: readonly NarrativeRunStep[]): number {
  return (
    steps.find((step) => step.kind === "chapter.settle")?.ordinal ??
    Number.MAX_SAFE_INTEGER
  );
}
