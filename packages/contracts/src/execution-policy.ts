import { z } from "zod";

/**
 * Shared execution-policy input schema. Every field is optional; unresolved
 * fields are filled by resolveEffectivePolicy. The schema is strict so the
 * server can reject typos with a 422 `policy.unknown_field` (see
 * POLICY_UNKNOWN_FIELD / extractPolicyUnknownFields).
 */
export const ModelExecutionPolicySchema = z
  .object({
    // Deadlines & timeouts (ms).
    requestStartTimeoutMs: z.number().int().positive().max(600_000).optional(),
    streamIdleTimeoutMs: z.number().int().positive().max(1_800_000).optional(),
    logicalCallDeadlineMs: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .optional(),
    stepDeadlineMs: z.number().int().positive().max(7_200_000).optional(),
    runDeadlineMs: z.number().int().positive().max(86_400_000).optional(),
    // Retry / repair budgets.
    maxRetries: z.number().int().min(0).max(5).optional(),
    retryBaseDelayMs: z.number().int().positive().max(60_000).optional(),
    maxRepairAttempts: z.number().int().min(0).max(3).optional(),
    minChapterCharacters: z.number().int().min(100).max(100_000).optional(),
  })
  .strict();
export type ModelExecutionPolicy = z.infer<typeof ModelExecutionPolicySchema>;

export const EffectivePolicySchema = z.object({
  maxRevisionCycles: z.number().int().nonnegative(),
  semanticReview: z.boolean(),
  requestStartTimeoutMs: z.number().int().positive(),
  streamIdleTimeoutMs: z.number().int().positive(),
  logicalCallDeadlineMs: z.number().int().positive(),
  stepDeadlineMs: z.number().int().positive(),
  runDeadlineMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0).max(5),
  retryBaseDelayMs: z.number().int().positive(),
  maxRepairAttempts: z.number().int().min(0).max(3),
  minChapterCharacters: z.number().int().positive(),
});
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

export interface PolicyWarning {
  code: string;
  message: string;
}

export interface ResolvedPolicy {
  effectivePolicy: EffectivePolicy;
  warnings: PolicyWarning[];
}

/**
 * Built-in policy defaults. The deadline/retry numbers are initial values and
 * will be calibrated against real latency baselines in M5.
 */
const BUILT_IN_DEFAULTS = {
  maxRevisionCycles: 2,
  semanticReview: true,
  // 慢推理网关的首字节延迟常态在 30-60s（本地账本实测成功调用 TTFT 最高
  // 40.5s），45s 会贴线误杀；首字节预算放宽到 120s，总期限仍由
  // logicalCallDeadlineMs 兜底。
  requestStartTimeoutMs: 120_000,
  streamIdleTimeoutMs: 120_000,
  logicalCallDeadlineMs: 360_000,
  stepDeadlineMs: 480_000,
  runDeadlineMs: 3_600_000,
  // 每步最多 1+4=5 次尝试，与配方里的 maxAttempts=5 对齐。
  maxRetries: 4,
  retryBaseDelayMs: 1_000,
  maxRepairAttempts: 1,
  minChapterCharacters: 1_200,
} as const;

/** Resolve operational safeguards; model capacity belongs to model configuration. */
export function resolveEffectivePolicy(
  input: ModelExecutionPolicy = {},
  defaults: ModelExecutionPolicy = {},
): ResolvedPolicy {
  return {
    effectivePolicy: EffectivePolicySchema.parse({
      ...BUILT_IN_DEFAULTS,
      ...definedFields(defaults),
      ...definedFields(input),
    }),
    warnings: [],
  };
}

function definedFields(policy: ModelExecutionPolicy): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(policy).filter((entry) => entry[1] !== undefined),
  );
}

/** Error code the server uses for 422 responses on unknown policy keys. */
export const POLICY_UNKNOWN_FIELD = "policy.unknown_field" as const;

/**
 * Extracts the unrecognized-key field names from a ZodError produced by the
 * strict ModelExecutionPolicySchema, so the server can build a 422
 * `policy.unknown_field` response.
 */
export function extractPolicyUnknownFields(error: z.ZodError): string[] {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) fields.add(key);
    }
  }
  return [...fields];
}
