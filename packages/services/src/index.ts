export { ServiceError } from "./service-error.js";
export type {
  RouteApp,
  RouteHandler,
  RouteMethod,
  RouteOptions,
  RouteRequest,
  RouteResponse,
} from "./route-app.js";
export { normalizeRouteResult } from "./route-app.js";
export {
  deterministicRequestId,
  deterministicUuid,
  hashRequest,
} from "./request-idempotency.js";
export {
  computeSetupHint,
  extractEffectivePolicy,
  hasWritingAssignment,
  isRecord,
  isTerminalSessionStatus,
  committedChangeSetId,
  latestAwaitReason,
  requireAwaitReason,
  requireRunInProject,
  requireViablePartial,
  requireWritingAssignment,
  runProductProjection,
  withRuntimeModelPolicy,
  RunServiceError,
} from "./run-policy.js";
export {
  requestManuscriptRevision,
  type RequestedRevisionResult,
} from "./requested-revision.js";
export {
  adoptCandidate,
  AutomationServiceError,
  createFoundationRun,
  currentBlockingReview,
  keepBlockedManuscript,
  latestRunReason,
  requestSessionCancellation,
  resolveSessionEffectivePolicy,
  resolveSessionFailure,
  sessionAvailableActions,
  sessionProductProjection,
  sessionStopReason,
} from "./automation-service.js";
export { startManualSettlementRun } from "./manual-settlement.js";
export {
  acceptEditProposal,
  cancelRunsInvalidatedByRevert,
  createReplyRun,
  createSelectionEditRun,
  requireActiveCoCreateParticipants,
  requireActiveCoCreateSession,
  requireProject,
  requireSelectionRange,
  StudioServiceError,
} from "./studio-service.js";
export {
  applyCoverMutation,
  commitDocumentVersion,
  promoteCanonFact,
  reviseCanonFact,
  softDeleteProject,
  StoryServiceError,
  withdrawCanonFact,
} from "./story-service.js";
export {
  AssistantServiceError,
  requireAliveAssistantModel,
  requireProject as requireAssistantProject,
  requireSwitchableAssistantModel,
  validateAssistantContext,
} from "./assistant-service.js";
export {
  ProviderServiceError,
  requireProviderDeletable,
  requireProviderDisablable,
} from "./provider-service.js";
export {
  buildWritingSkillZip,
  parseWritingSkillPackage,
  renderSkillMarkdown,
  WritingSkillPackageError,
} from "./writing-skill-package.js";

// ---- 自 apps/server 迁入的运行时无关模块（M3 阶段 A）----
export * from "./run-coordinator.js";
export * from "./event-hub.js";
export * from "./autopilot-coordinator.js";
export * from "./long-goal-coordinator.js";
export * from "./assistant-tool-executor.js";
export * from "./project-bootstrap.js";
export * from "./story-context.js";
export * from "./project-overview-service.js";
export * from "./assistant-tool-registry.js";
export * from "./assistant-retry.js";
export * from "./assistant-task-projection.js";
export * from "./agent-skill-registry.js";
export * from "./agent-skill-import.js";
export * from "./connection-tester.js";
export * from "./model-config.js";
export * from "./demo-relay-seed.js";
export * from "./provider-defaults.js";
export * from "./delivery-service.js";
export * from "./task-classification.js";

// ---- 路由注册器（Fastify 与浏览器内核双宿主）----
export * from "./route-error.js";
export * from "./agent-skill-routes.js";
export * from "./assistant-routes.js";
export * from "./automation-routes.js";
export * from "./canon-candidate-routes.js";
export * from "./delivery-routes.js";
export * from "./long-novel-routes.js";
export * from "./project-cover-routes.js";
export * from "./provider-routes.js";
export * from "./review-routes.js";
export * from "./run-routes.js";
export * from "./story-routes.js";
export * from "./studio-routes.js";
export * from "./template-routes.js";
export { mapRouteError, type ApiErrorPayload } from "./route-error-mapper.js";
export { RouteTable } from "./route-dispatch.js";
