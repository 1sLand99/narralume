import { randomUuid } from "@narralume/domain";
import type { RouteApp } from "@narralume/services";

import {
  CloneHarnessTemplateRequestSchema,
  HarnessTemplateSchema,
  RestoreHarnessTemplateRequestSchema,
  UpdateHarnessTemplateRequestSchema,
} from "@narralume/contracts";
import { validateRecipeTemplateContent } from "@narralume/harness";
import {
  PROMPT_TEMPLATE_DEFINITIONS,
  serializeBilingualPromptText,
  validatePromptTemplateContent,
} from "@narralume/harness";
import {
  SqliteTemplateRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

const ParamsSchema = z.object({ key: z.string().min(1) });

export function seedHarnessTemplates(
  database: NarrativeDatabase,
  now = new Date().toISOString(),
): void {
  const promptSeeds = PROMPT_TEMPLATE_DEFINITIONS.map((definition) => ({
    id: definition.id,
    kind: "prompt" as const,
    key: definition.key,
    name: definition.name,
    description: definition.description,
    systemInvariants: serializeBilingualPromptText(definition.invariants),
    defaultContent: serializeBilingualPromptText(definition.instructions),
    updatedAt: now,
  }));
  new SqliteTemplateRepository(database).seed([
    ...promptSeeds,
    CHAPTER_PRODUCTION_RECIPE(now),
    COCREATE_REPLY_RECIPE(now),
  ]);
}

export function registerTemplateRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
): void {
  const templates = new SqliteTemplateRepository(database);
  app.route("GET", "/api/harness/templates", async () =>
    templates.list().map((template) => HarnessTemplateSchema.parse(template)),
  );
  app.route("PUT", "/api/harness/templates/:key", async (request) => {
    const { key } = ParamsSchema.parse(request.params);
    const input = UpdateHarnessTemplateRequestSchema.parse(request.body);
    const current = templates.getByKey(key);
    if (current?.kind === "recipe")
      validateRecipeTemplateContent(key, input.content);
    if (current?.kind === "prompt") validatePromptTemplateContent(input.content);
    return HarnessTemplateSchema.parse(
      templates.updateOverride(
        key,
        input.content,
        input.expectedVersion,
        new Date().toISOString(),
      ),
    );
  });
  app.route("POST", "/api/harness/templates/:key/restore", async (request) => {
    const { key } = ParamsSchema.parse(request.params);
    const input = RestoreHarnessTemplateRequestSchema.parse(request.body);
    return HarnessTemplateSchema.parse(
      templates.restoreDefault(
        key,
        input.expectedVersion,
        new Date().toISOString(),
      ),
    );
  });
  app.route("POST", "/api/harness/templates/:key/clone", async (request) => {
    const { key } = ParamsSchema.parse(request.params);
    const input = CloneHarnessTemplateRequestSchema.parse(request.body);
    return {
      status: 201,
      body: HarnessTemplateSchema.parse(
        templates.clone(key, {
          id: randomUuid(),
          ...input,
          updatedAt: new Date().toISOString(),
        }),
      ),
    };
  });
}

const CHAPTER_PRODUCTION_RECIPE = (now: string) => ({
  id: "recipe-chapter-production",
  kind: "recipe" as const,
  key: "recipe.chapter-production",
  name: "章节生产配方",
  description: "上下文、规划、正文、双重检查、修订、结算与提交。",
  systemInvariants: "commit 永远位于门禁和 settle 之后；不得移除确定性检查。",
  defaultContent: JSON.stringify(
    {
      steps: [
        "context.compile",
        "scene.plan",
        "draft.generate",
        "deterministic.check",
        "semantic.review",
        "revision.generate?",
        "chapter.settle",
        "chapter.commit",
      ],
      maxRevisionCycles: 2,
    },
    null,
    2,
  ),
  updatedAt: now,
});

const COCREATE_REPLY_RECIPE = (now: string) => ({
  id: "recipe-cocreate-reply",
  kind: "recipe" as const,
  key: "recipe.cocreate-reply",
  name: "共同创作回复配方",
  description: "编译故事房上下文、回复并暂存候选。",
  systemInvariants: "回复不得自动进入正典或正文；采纳必须走独立配方。",
  defaultContent: JSON.stringify(
    { steps: ["cocreate.context", "cocreate.respond", "cocreate.stage"] },
    null,
    2,
  ),
  updatedAt: now,
});
