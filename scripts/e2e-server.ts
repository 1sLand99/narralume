import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../apps/server/src/app.js";
import type { ServerConfig } from "../apps/server/src/config.js";
import type { NarrativeModelClient } from "@narralume/narrative";

const workspace = mkdtempSync(join(tmpdir(), "narrative-e2e-"));
const dataDirectory = join(workspace, "data");
const port = Number(process.env.NARRATIVE_E2E_API_PORT ?? 14317);
const config: ServerConfig = {
  dataDirectory,
  databasePath: join(dataDirectory, "narralume.sqlite"),
  backupDirectory: join(workspace, "backups"),
  backupRetention: 4,
  host: "127.0.0.1",
  port,
  environment: "test",
};
const app = await buildApp({
  config,
  environment: {
    NARRATIVE_LLM_API_KEY: "e2e-placeholder-key",
    NARRATIVE_LLM_BASE_URL: "https://e2e.example.com/v1",
    NARRATIVE_LLM_MODEL: "e2e-scripted-model",
    NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
    NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
  },
  narrativeModelClient: scriptedE2eModel(),
  enableRunWorker: false,
  logger: false,
});
await app.listen({ host: config.host, port: config.port });

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

function scriptedE2eModel(): NarrativeModelClient {
  const usage = {
    inputTokens: 120,
    outputTokens: 80,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 10,
  };
  const fatal = () => {
    throw {
      code: "model.authentication",
      message: "The E2E model intentionally rejected this workflow.",
      retryable: false,
    };
  };
  return {
    async text() {
      return fatal();
    },
    async structured(run, _step, purpose, request, _contract, validate) {
      let value: unknown;
      if (purpose === "project-assistant") {
        const stagesFoundation = JSON.stringify(request).includes("待确认任务");
        value = stagesFoundation
          ? {
              reply: "已整理为待确认的故事方向任务，确认后才会执行。",
              toolCall: {
                name: "foundation.start",
                arguments: {
                  braindump: "灯塔每次熄灭，港口都会失去一段共同记忆。",
                },
              },
            }
          : {
              reply: "已读取当前作品；下一步先收紧创作承诺，再推进章节。",
              toolCall: null,
            };
      } else if (purpose === "canon-revision") {
        value = {
          summary: "把创作承诺收紧到灯塔失明的代价。",
          items: [
            {
              operation: "update",
              targetId: "intent",
              title: "收紧失灯代价",
              rationale: "让后续章节有一致的因果约束。",
              impact: ["后续章节必须展示可见代价"],
              afterJson: JSON.stringify({
                promise: "每次灯塔熄灭，都有人失去一段不能复原的记忆。",
                currentFocus: "确认第一次熄灯造成的记忆代价",
              }),
            },
          ],
        };
      } else if (purpose === "cocreate-response") {
        const speakerPersonaId = String(run.policy.speakerPersonaId ?? "");
        if (!speakerPersonaId) {
          throw new Error("The E2E room run did not resolve a speaker.");
        }
        const receivedLore = JSON.stringify(request).includes(
          "E2E_WORLD_LORE_SENTINEL",
        );
        value = {
          speakerPersonaId,
          content: receivedLore
            ? "她把灯芯压低，信纸随即析出一圈细盐。"
            : "她看着信纸，没有发现新的变化。",
          intent: "让背景规则通过可观察动作显现",
          emotionalShift: "试探转为确信",
          suggestedCanonFacts: [],
        };
      } else {
        return fatal();
      }
      const checked = validate(value);
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return {
        value: checked.data,
        usage,
        mode: "native",
        attempts: 1,
      };
    },
  } as NarrativeModelClient;
}
