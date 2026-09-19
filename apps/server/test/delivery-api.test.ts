import { createHash } from "node:crypto";

import type { NarrativeModelClient } from "@narralume/narrative";
import { createDocument } from "@narralume/domain";
import { SqliteDocumentRepository } from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
};
const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
}[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop();
    await resource?.app.close();
    resource?.database.close();
  }
});

describe("delivery API", () => {
  it("replays a completed chunked upload without creating another batch", async () => {
    const { app, database } = await setup();
    const bytes = Buffer.from(
      `# 第一章\n\n${"潮声越过旧邮局，灯塔在雾里熄灭。".repeat(8_000)}`,
      "utf8",
    );
    const chunkSize = 64 * 1024;
    const upload = await request<{
      id: string;
      batchId: string | null;
      status: string;
    }>(app, "POST", "/api/import-uploads", {
      targetProjectId: null,
      filename: "chunked.md",
      format: "markdown",
      totalBytes: bytes.length,
      chunkSize,
      expectedHash: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(upload).toMatchObject({ batchId: null, status: "uploading" });

    for (let offset = 0, index = 0; offset < bytes.length; index += 1) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      offset += chunk.length;
      await request(
        app,
        "PUT",
        `/api/import-uploads/${upload.id}/chunks/${index}`,
        {
          contentBase64: chunk.toString("base64"),
          chunkHash: createHash("sha256").update(chunk).digest("hex"),
        },
        200,
      );
    }

    const completed = await request<{
      session: { id: string; batchId: string; status: string };
      detail: ImportDetail;
    }>(app, "POST", `/api/import-uploads/${upload.id}/complete`, {}, 201);
    expect(completed.session).toMatchObject({
      id: upload.id,
      batchId: completed.detail.batch.id,
      status: "completed",
    });

    const replayed = await request<typeof completed>(
      app,
      "POST",
      `/api/import-uploads/${upload.id}/complete`,
      {},
      201,
    );
    expect(replayed).toEqual(completed);
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM import_batches")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM import_upload_chunks WHERE session_id = ?",
        )
        .get(upload.id),
    ).toEqual({ count: 0 });
  });

  it("imports, validates, and exports scoped SKILL.md packages with hashed references", async () => {
    const { app } = await setup();
    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "技能样本",
        premise: "一座城只允许说真话。",
      },
    );
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      [
        "---",
        "name: 因果场景",
        "description: 每场戏形成可验证后果",
        "scopes: [chapter, review]",
        "priority: 85",
        "---",
        "",
        "检查目标、阻力、选择和不可逆后果；不要用总结代替人物行动。",
      ].join("\n"),
    );
    zip.file("references/checklist.md", "# 检查表\n- 选择是否改变局面");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const imported = await request<{
      skill: { id: string; name: string; scopes: string[]; source: string };
      references: { path: string; contentHash: string }[];
    }>(
      app,
      "POST",
      `/api/projects/${project.id}/writing-skills/import`,
      {
        filename: "causality.skill.zip",
        contentBase64: bytes.toString("base64"),
      },
      201,
    );
    expect(imported.skill).toMatchObject({
      name: "因果场景",
      scopes: ["chapter", "review"],
      source: "skill-package:causality.skill.zip",
    });
    expect(imported.references).toEqual([
      expect.objectContaining({
        path: "references/checklist.md",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(
      await request(
        app,
        "POST",
        `/api/writing-skills/${imported.skill.id}/validate`,
        { scope: "chapter" },
        200,
      ),
    ).toMatchObject({ valid: true, applicable: true });

    const exported = await app.inject({
      method: "GET",
      url: `/api/writing-skills/${imported.skill.id}/package`,
    });
    expect(exported.statusCode).toBe(200);
    const roundTrip = await JSZip.loadAsync(exported.rawPayload);
    expect(await roundTrip.file("SKILL.md")?.async("string")).toContain(
      "name: 因果场景",
    );
    expect(
      await roundTrip.file("references/checklist.md")?.async("string"),
    ).toContain("选择是否改变局面");
  });

  it("rejects duplicate normalized Skill references without leaving a partial skill", async () => {
    const { app } = await setup();
    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "原子技能导入",
        premise: "所有引用必须同时入库。",
      },
    );
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      [
        "---",
        "name: 重复引用技能",
        "scopes: [chapter]",
        "---",
        "",
        "这是一段长度足够的技能指令，用来验证导入失败不会留下半成品。",
      ].join("\n"),
    );
    zip.file("references/a.md", "正斜杠路径");
    zip.file("references\\a.md", "反斜杠路径");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/writing-skills/import`,
      payload: {
        filename: "duplicate.skill.zip",
        contentBase64: bytes.toString("base64"),
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "skill.package.duplicate_reference" },
    });
    expect(
      await request(
        app,
        "GET",
        `/api/projects/${project.id}/writing-skills`,
        undefined,
        200,
      ),
    ).toEqual([]);
  });

  it("rejects highly compressed Writing Skill references", async () => {
    const { app } = await setup();
    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "压缩边界技能",
        premise: "异常压缩包不能占满服务内存。",
      },
    );
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      "---\nname: 压缩边界\nscopes: [chapter]\n---\n\n检查每个场景的因果结果。",
    );
    zip.file("references/oversized.md", "重复引用。".repeat(450_000));
    const bytes = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    expect(bytes.length).toBeLessThan(32 * 1024);

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/writing-skills/import`,
      payload: {
        filename: "compressed-bomb.skill.zip",
        contentBase64: bytes.toString("base64"),
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "skill.package.too_large" },
    });
  });

  it("previews, analyzes, applies, exports, backs up, and restores a portable story", async () => {
    const { app } = await setup();
    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "潮汐档案",
        premise: "退潮后，人们遗忘一封没有寄出的信。",
      },
    );

    const style = await request<{ id: string; version: number }>(
      app,
      "POST",
      `/api/projects/${project.id}/styles`,
      {
        name: "克制潮声",
        description: "让意象服从人物动作。",
        rules: ["动作先于解释", "每段只保留一个主意象"],
        examples: [],
        negativeRules: ["不替人物总结情绪"],
        active: true,
      },
    );
    await request(app, "PUT", `/api/styles/${style.id}`, {
      name: "克制潮声",
      description: "让意象服从人物动作。",
      rules: ["动作先于解释", "每段只保留一个主意象"],
      examples: [],
      negativeRules: ["不替人物总结情绪"],
      active: true,
      status: "active",
      expectedVersion: style.version,
    });
    await request(app, "POST", `/api/projects/${project.id}/writing-skills`, {
      name: "不可逆场景",
      description: "为场景建立可检验的变化。",
      instructions: "场景末尾必须出现选择、发现或代价之一。",
      scopes: ["chapter", "cocreate"],
      priority: 80,
      enabled: true,
    });

    const source = [
      "# 第一章 退潮信",
      "沈砚在邮局地板上发现一封覆着盐粒的空白信。",
      "",
      "# 第二章 无名地址",
      "她把信举到灯前，收件人的名字才从纸纤维里浮出。",
    ].join("\n");
    const preview = await request<ImportDetail>(
      app,
      "POST",
      "/api/imports/preview",
      {
        targetProjectId: project.id,
        filename: "退潮信.md",
        format: "markdown",
        contentBase64: Buffer.from(source).toString("base64"),
      },
    );
    expect(
      preview.candidates.filter((item) => item.kind === "document"),
    ).toHaveLength(2);
    expect(preview.batch.status).toBe("previewed");

    const analysis = await request<{
      run: {
        id: string;
        policy: Record<string, unknown>;
      };
      origin: { surface: string };
    }>(
      app,
      "POST",
      `/api/imports/${preview.batch.id}/analyze`,
      {
        requestId: "analyze-import-main",
        policy: {
          maxRetries: 0,
          minChapterCharacters: 500,
        },
      },
      202,
    );
    expect(analysis.run.policy).toMatchObject({
      maxRetries: 0,
      minChapterCharacters: 500,
      qualityPreset: "standard",
    });
    const analysisReplay = await app.inject({
      method: "POST",
      url: `/api/imports/${preview.batch.id}/analyze`,
      payload: {
        requestId: "analyze-import-main",
        policy: { maxRetries: 0, minChapterCharacters: 500 },
      },
    });
    expect(analysisReplay.statusCode, analysisReplay.body).toBe(202);
    expect((analysisReplay.json() as { run: { id: string } }).run.id).toBe(
      analysis.run.id,
    );
    const analysisConflict = await app.inject({
      method: "POST",
      url: `/api/imports/${preview.batch.id}/analyze`,
      payload: {
        requestId: "analyze-import-main",
        policy: { maxRetries: 1, minChapterCharacters: 500 },
      },
    });
    expect(analysisConflict.statusCode).toBe(409);
    expect(analysisConflict.json()).toMatchObject({
      error: { code: "import.analysis.idempotency_conflict" },
    });
    const parallelAnalysis = await app.inject({
      method: "POST",
      url: `/api/imports/${preview.batch.id}/analyze`,
      payload: {
        requestId: "analyze-import-parallel",
        policy: { maxRetries: 0, minChapterCharacters: 500 },
      },
    });
    expect(parallelAnalysis.statusCode).toBe(409);
    expect(parallelAnalysis.json()).toMatchObject({
      error: { code: "import.analysis.not_available" },
    });
    expect(analysis.origin).toMatchObject({ surface: "import" });
    expect(await finishRun(app, project.id, analysis.run.id)).toBe("completed");
    expect(
      await request<Record<string, unknown>>(
        app,
        "GET",
        `/api/runs/${analysis.run.id}?projectId=${project.id}`,
        undefined,
        200,
      ),
    ).toMatchObject({ result: { importBatchId: preview.batch.id } });
    const ready = await request<ImportDetail>(
      app,
      "GET",
      `/api/imports/${preview.batch.id}`,
      undefined,
      200,
    );
    expect(ready.batch.status).toBe("ready");
    expect(ready.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "intent" }),
        expect.objectContaining({ kind: "entity", title: "沈砚" }),
        expect.objectContaining({ kind: "skill" }),
      ]),
    );
    expect(ready.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "relationship" }),
        expect.objectContaining({ kind: "timeline" }),
        expect.objectContaining({ kind: "foreshadow" }),
        expect.objectContaining({ kind: "character-arc" }),
        expect.objectContaining({ kind: "scene-analysis" }),
      ]),
    );
    const evidence = ready.candidates.find(
      (candidate) => candidate.kind === "timeline",
    )?.payload?.evidence as
      | Array<{
          start: number;
          end: number;
          contentHash: string;
          paragraphOrdinal: number;
        }>
      | undefined;
    expect(evidence?.[0]).toMatchObject({
      start: expect.any(Number),
      end: expect.any(Number),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      paragraphOrdinal: 1,
    });

    const applied = await request<{ projectId: string; detail: ImportDetail }>(
      app,
      "POST",
      `/api/imports/${preview.batch.id}/actions`,
      { action: "apply", selectedCandidateIds: [] },
      200,
    );
    expect(applied.projectId).toBe(project.id);
    expect(applied.detail.batch.status).toBe("applied");

    const bible = await request<{
      intent: { promise: string };
      outline: { kind: string }[];
      entities: { name: string }[];
    }>(app, "GET", `/api/projects/${project.id}/story-bible`, undefined, 200);
    expect(bible.intent.promise).toContain("沈砚");
    expect(
      bible.outline.filter((item) => item.kind === "chapter"),
    ).toHaveLength(2);
    expect(bible.entities.map((entity) => entity.name)).toContain("沈砚");

    const quality = await request<{
      score: number;
      readiness: string;
      gates: { id: string; passed: boolean }[];
      metrics: Record<string, number>;
    }>(app, "GET", `/api/projects/${project.id}/quality`, undefined, 200);
    expect(quality.score).toBeGreaterThan(40);
    expect(quality.readiness).toBe("blocked");
    expect(quality.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "chapter-commitment", passed: true }),
      ]),
    );
    expect(quality.metrics.manuscriptCharacters).toBeGreaterThan(20);

    const markdown = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/exports/markdown`,
    });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.body).toContain("第一章 退潮信");
    const text = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/exports/text`,
    });
    expect(text.statusCode).toBe(200);
    expect(text.headers["content-type"]).toContain("text/plain");
    const epub = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/exports/epub`,
    });
    expect(epub.statusCode).toBe(200);
    expect(epub.rawPayload.subarray(0, 2).toString()).toBe("PK");
    const portablePersona = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/personas`,
      {
        kind: "character",
        name: "潮汐观察员",
        description: "记录潮痕的旅人。",
        instructions: "不猜测未知事实。",
        profile: {
          personality: "审慎、敏锐。",
          scenario: "旧邮局夜间。",
          exampleDialogue: "这道水痕比潮位高。",
          greetings: ["先看窗台的盐。"],
          creator: {
            name: "测试作者",
            notes: "备份必须保留",
            version: "1.0",
            tags: ["潮汐"],
          },
          source: {
            format: "character-card-v3",
            importedAt: "2026-08-30T00:00:00.000Z",
          },
        },
      },
    );
    const bundleResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/exports/narrative-bundle`,
    });
    expect(bundleResponse.statusCode).toBe(200);
    const bundle = JSON.parse(bundleResponse.body) as {
      manifest: { format: string };
      personas: Array<{ id: string; profile: Record<string, unknown> }>;
      styles: unknown[];
      skills: unknown[];
    };
    expect(bundle.manifest.format).toBe("narralume");
    expect(bundle.personas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: portablePersona.id,
          profile: expect.objectContaining({
            personality: "审慎、敏锐。",
          }),
        }),
      ]),
    );
    expect(bundle.styles.length).toBeGreaterThanOrEqual(2);
    expect(bundle.skills.length).toBeGreaterThanOrEqual(2);

    const backup = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/backups`,
      { label: "交付前快照" },
    );
    const restored = await request<{ projectId: string }>(
      app,
      "POST",
      `/api/backups/${backup.id}/restore`,
      { requestId: "restore-main", title: "潮汐档案 · 校验副本" },
    );
    expect(restored.projectId).not.toBe(project.id);
    const replayed = await request<{ projectId: string }>(
      app,
      "POST",
      `/api/backups/${backup.id}/restore`,
      { requestId: "restore-main", title: "潮汐档案 · 校验副本" },
    );
    expect(replayed.projectId).toBe(restored.projectId);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/backups/${backup.id}/restore`,
      payload: { requestId: "restore-main", title: "另一个副本标题" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "backup.restore.idempotency_conflict" },
    });
    expect(
      await request<unknown[]>(
        app,
        "GET",
        `/api/projects/${restored.projectId}/styles`,
        undefined,
        200,
      ),
    ).toHaveLength(bundle.styles.length);
    expect(
      await request<unknown[]>(
        app,
        "GET",
        `/api/projects/${restored.projectId}/writing-skills`,
        undefined,
        200,
      ),
    ).toHaveLength(bundle.skills.length);
    const restoredPersonas = await request<
      Array<{ profile: { personality: string | null; greetings: string[] } }>
    >(
      app,
      "GET",
      `/api/projects/${restored.projectId}/personas`,
      undefined,
      200,
    );
    expect(restoredPersonas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: expect.objectContaining({
            personality: "审慎、敏锐。",
            greetings: ["先看窗台的盐。"],
          }),
        }),
      ]),
    );

    const bundlePreview = await request<ImportDetail>(
      app,
      "POST",
      "/api/imports/preview",
      {
        targetProjectId: null,
        filename: "潮汐档案.narrative.json",
        format: "narrative-bundle",
        contentBase64: bundleResponse.rawPayload.toString("base64"),
      },
    );
    expect(bundlePreview.candidates).toHaveLength(1);
    const roundTrip = await request<{ projectId: string }>(
      app,
      "POST",
      `/api/imports/${bundlePreview.batch.id}/actions`,
      { action: "apply", selectedCandidateIds: [] },
      200,
    );
    expect(roundTrip.projectId).not.toBe(project.id);
  });

  it("rejects corrupt backups without mutating project state", async () => {
    const { app, database } = await setup();
    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "校验测试",
      },
    );
    const backup = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/backups`,
      { label: "将被损坏" },
    );
    database.raw
      .prepare("UPDATE project_backups SET bundle_json = '{}' WHERE id = ?")
      .run(backup.id);
    const response = await app.inject({
      method: "POST",
      url: `/api/backups/${backup.id}/restore`,
      payload: { requestId: "restore-corrupt" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "backup.integrity.failed" },
    });
  });

  it("rejects malformed bundles and EPUB containers with excessive entries", async () => {
    const { app } = await setup();
    const malformed = await app.inject({
      method: "POST",
      url: "/api/imports/preview",
      payload: {
        targetProjectId: null,
        filename: "broken.narrative.json",
        format: "narrative-bundle",
        contentBase64: Buffer.from("{not json").toString("base64"),
      },
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json()).toMatchObject({
      error: { code: "import.bundle.invalid_json" },
    });

    const zip = new JSZip();
    for (let index = 0; index < 2_001; index += 1) {
      zip.file(`OEBPS/p${index}.xhtml`, "<p>x</p>");
    }
    const oversized = await app.inject({
      method: "POST",
      url: "/api/imports/preview",
      payload: {
        targetProjectId: null,
        filename: "too-many.epub",
        format: "epub",
        contentBase64: (
          await zip.generateAsync({ type: "nodebuffer" })
        ).toString("base64"),
      },
    });
    expect(oversized.statusCode).toBe(422);
    expect(oversized.json()).toMatchObject({
      error: { code: "import.epub.entry_limit" },
    });

    const invalidHref = new JSZip();
    invalidHref.file(
      "META-INF/container.xml",
      '<container><rootfile full-path="content.opf" /></container>',
    );
    invalidHref.file(
      "content.opf",
      '<package><manifest><item id="chapter" href="%ZZ" media-type="application/xhtml+xml" /></manifest><spine><itemref idref="chapter" /></spine></package>',
    );
    invalidHref.file("chapter.xhtml", "<html><body>正文</body></html>");
    const invalidHrefResponse = await app.inject({
      method: "POST",
      url: "/api/imports/preview",
      payload: {
        targetProjectId: null,
        filename: "invalid-href.epub",
        format: "epub",
        contentBase64: (
          await invalidHref.generateAsync({ type: "nodebuffer" })
        ).toString("base64"),
      },
    });
    expect(invalidHrefResponse.statusCode).toBe(422);
    expect(invalidHrefResponse.json()).toMatchObject({
      error: { code: "import.epub.invalid_href" },
    });
  });

  it("reports quality and exports a 200-document manuscript within the delivery budget", async () => {
    const { app, database } = await setup();
    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "长篇性能样本",
        premise: "验证交付路径不会随章节数量线性退化到不可用。",
      },
    );
    const documents = new SqliteDocumentRepository(database);
    const now = "2026-08-10T00:00:00.000Z";
    database.transaction(() => {
      for (let index = 0; index < 200; index += 1) {
        const document = documents.insert(
          createDocument({
            id: `performance-document-${index}`,
            projectId: project.id,
            kind: "chapter",
            title: `第 ${index + 1} 章`,
            now,
          }),
        );
        documents.appendVersion(project.id, document.id, {
          id: `performance-version-${index}`,
          content: `第 ${index + 1} 章正文。${"潮声穿过旧邮局。".repeat(80)}`,
          source: "performance-fixture",
          expectedCurrentVersionId: null,
          now,
        });
      }
    });

    const started = performance.now();
    const quality = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/quality`,
    });
    const markdown = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/exports/markdown`,
    });
    const elapsed = performance.now() - started;
    expect(quality.statusCode).toBe(200);
    expect(quality.json()).toMatchObject({ metrics: { documents: 200 } });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.rawPayload.length).toBeGreaterThan(100_000);
    expect(elapsed).toBeLessThan(2_500);
  });

  it("never reports a high soft score as deliverable when hard gates fail", async () => {
    const { app } = await setup();
    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "门禁样本",
        premise: "一部尚未完成的小说。",
      },
    );
    const bible = await request<{
      outline: { id: string; kind: string }[];
    }>(app, "GET", `/api/projects/${project.id}/story-bible`, undefined, 200);
    const book = bible.outline.find((node) => node.kind === "book");
    expect(book).toBeDefined();
    const manuscript = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/documents`,
      {
        requestId: "gate-manuscript",
        kind: "manuscript",
        title: "正文总稿",
        outlineNodeId: null,
      },
      201,
    );
    await request(app, "POST", `/api/projects/${project.id}/outline`, {
      parentId: book?.id,
      kind: "chapter",
      ordinal: 0,
      title: "第一章",
      metadata: {},
    });
    await request(
      app,
      "POST",
      `/api/projects/${project.id}/documents/${manuscript.id}/versions`,
      {
        content: "尚未完成。".repeat(14),
        source: "manual",
        expectedCurrentVersionId: null,
      },
      201,
    );

    const report = await request<{
      score: number;
      readiness: string;
      gates: { id: string; passed: boolean }[];
    }>(app, "GET", `/api/projects/${project.id}/quality`, undefined, 200);

    expect(report.score).toBeGreaterThanOrEqual(80);
    expect(report.readiness).toBe("blocked");
    expect(report.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "author-promise", passed: false }),
        expect.objectContaining({ id: "chapter-commitment", passed: false }),
        expect.objectContaining({ id: "manuscript-present", passed: false }),
      ]),
    );
  });

  it("keeps a discarded import discarded while analysis is in flight (CR-40)", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const model = deliveryModel({
      beforeStructured: async (purpose, signal) => {
        if (!purpose.startsWith("import-analysis")) return;
        markStarted();
        await new Promise<never>((_resolve, reject) => {
          const abort = () =>
            reject(new DOMException("import discarded", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    });
    const { app } = await setup(model);
    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "分析期间丢弃",
      },
    );
    const preview = await request<ImportDetail>(
      app,
      "POST",
      "/api/imports/preview",
      {
        targetProjectId: project.id,
        filename: "discard.md",
        format: "markdown",
        contentBase64:
          Buffer.from("# 第一章\n潮声越过空码头。").toString("base64"),
      },
    );
    const analysis = await request<{ run: { id: string } }>(
      app,
      "POST",
      `/api/imports/${preview.batch.id}/analyze`,
      { requestId: "discard-in-flight" },
      202,
    );

    const advancing = app.inject({
      method: "POST",
      url: `/api/runs/${analysis.run.id}/advance`,
      payload: { projectId: project.id },
    });
    await within(started, "import analysis did not start");
    const discarded = await app.inject({
      method: "POST",
      url: `/api/imports/${preview.batch.id}/actions`,
      payload: { action: "discard", selectedCandidateIds: [] },
    });
    expect(discarded.statusCode, discarded.body).toBe(200);
    expect(discarded.json()).toMatchObject({ batch: { status: "discarded" } });
    const interrupted = await within(
      advancing,
      "import analysis did not unwind after discard",
    );
    expect(interrupted.statusCode, interrupted.body).toBe(200);
    expect(await finishRun(app, project.id, analysis.run.id)).toBe("cancelled");

    const detail = await request<ImportDetail>(
      app,
      "GET",
      `/api/imports/${preview.batch.id}`,
      undefined,
      200,
    );
    expect(detail.batch.status).toBe("discarded");
    expect(
      detail.candidates.some((candidate) => candidate.kind === "intent"),
    ).toBe(false);
  });

  it.each(["applied", "discarded"])(
    "keeps import candidates immutable after the batch is %s (CR-62)",
    async (status) => {
      const { app, database } = await setup();
      const project = await request<{ id: string }>(
        app,
        "POST",
        "/api/projects",
        {
          requestId: globalThis.crypto.randomUUID(),
          title: `终态导入-${status}`,
        },
      );
      const preview = await request<ImportDetail>(
        app,
        "POST",
        "/api/imports/preview",
        {
          targetProjectId: project.id,
          filename: `${status}.md`,
          format: "markdown",
          contentBase64:
            Buffer.from("# 第一章\n潮声越过空码头。").toString("base64"),
        },
      );
      const candidate = preview.candidates[0]!;
      database.raw
        .prepare("UPDATE import_batches SET status = ? WHERE id = ?")
        .run(status, preview.batch.id);

      const changed = await app.inject({
        method: "PUT",
        url: `/api/import-candidates/${candidate.id}`,
        payload: {
          status: candidate.status === "discarded" ? "selected" : "discarded",
        },
      });
      expect(changed.statusCode, changed.body).toBe(409);
      expect(changed.json()).toMatchObject({
        error: { code: "import.candidate.batch_terminal" },
      });
      const detail = await request<ImportDetail>(
        app,
        "GET",
        `/api/imports/${preview.batch.id}`,
        undefined,
        200,
      );
      expect(
        detail.candidates.find((item) => item.id === candidate.id)?.status,
      ).toBe(candidate.status);
    },
  );

  it("exports chapter sections in outline order even when updated_at disagrees", async () => {
    const { app, database } = await setup();
    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "章节顺序样本",
      },
    );
    const bible = await request<{
      outline: { id: string; kind: string }[];
    }>(app, "GET", `/api/projects/${project.id}/story-bible`, undefined, 200);
    const book = bible.outline.find((node) => node.kind === "book");
    expect(book).toBeDefined();
    const chapterOne = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/outline`,
      {
        parentId: book?.id,
        kind: "chapter",
        ordinal: 0,
        title: "第一章",
        metadata: {},
      },
    );
    const chapterTwo = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/outline`,
      {
        parentId: book?.id,
        kind: "chapter",
        ordinal: 1,
        title: "第二章",
        metadata: {},
      },
    );
    const documentOne = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/documents`,
      {
        requestId: globalThis.crypto.randomUUID(),
        kind: "chapter",
        title: "第一章",
        outlineNodeId: chapterOne.id,
      },
    );
    const documentTwo = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/documents`,
      {
        requestId: globalThis.crypto.randomUUID(),
        kind: "chapter",
        title: "第二章",
        outlineNodeId: chapterTwo.id,
      },
    );
    await request(
      app,
      "POST",
      `/api/projects/${project.id}/documents/${documentOne.id}/versions`,
      {
        content: "第一章正文：潮起。",
        source: "manual",
        expectedCurrentVersionId: null,
      },
      201,
    );
    await request(
      app,
      "POST",
      `/api/projects/${project.id}/documents/${documentTwo.id}/versions`,
      {
        content: "第二章正文：潮落。",
        source: "manual",
        expectedCurrentVersionId: null,
      },
      201,
    );
    // 人为让 updated_at 与大纲顺序相反：文档列表先返回第二章
    database.raw
      .prepare("UPDATE documents SET updated_at = ? WHERE id = ?")
      .run("2026-08-10T00:00:00.000Z", documentOne.id);
    database.raw
      .prepare("UPDATE documents SET updated_at = ? WHERE id = ?")
      .run("2026-08-11T00:00:00.000Z", documentTwo.id);
    const listed = await request<{ id: string; kind: string }[]>(
      app,
      "GET",
      `/api/projects/${project.id}/documents`,
      undefined,
      200,
    );
    const chapterList = listed.filter(
      (document) => document.kind === "chapter",
    );
    expect(chapterList.map((document) => document.id)).toEqual([
      documentTwo.id,
      documentOne.id,
    ]);

    const markdown = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/exports/markdown`,
    });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.body.indexOf("潮起")).toBeGreaterThanOrEqual(0);
    expect(markdown.body.indexOf("潮起")).toBeLessThan(
      markdown.body.indexOf("潮落"),
    );
  });
});

async function setup(model: NarrativeModelClient = deliveryModel()) {
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    config,
    database,
    environment: {
      NARRATIVE_LLM_API_KEY: "server-only-test-key",
      NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
      NARRATIVE_LLM_MODEL: "test-model",
      NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
      NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
    },
    narrativeModelClient: model,
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  return { app, database };
}

async function finishRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  runId: string,
) {
  let status = "pending";
  for (let index = 0; index < 20; index += 1) {
    const response = await request<{ snapshot: { run: { status: string } } }>(
      app,
      "POST",
      `/api/runs/${runId}/advance`,
      { projectId },
      200,
    );
    status = response.snapshot.run.status;
    if (["completed", "failed", "cancelled", "awaiting_user"].includes(status))
      break;
  }
  return status;
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function request<T = unknown>(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: Record<string, unknown>,
  expected = method === "POST" ? 201 : 200,
): Promise<T> {
  const response =
    payload === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload });
  expect(response.statusCode, response.body).toBe(expected);
  return response.json() as T;
}

function deliveryModel(
  options: {
    beforeStructured?: (purpose: string, signal: AbortSignal) => Promise<void>;
  } = {},
): NarrativeModelClient {
  const usage = {
    inputTokens: 120,
    outputTokens: 240,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 8,
  };
  return {
    async text() {
      return { text: "unused", usage };
    },
    async structured(
      _run,
      _step,
      purpose,
      _request,
      _contract,
      validate,
      signal,
    ) {
      await options.beforeStructured?.(purpose, signal);
      if (!purpose.startsWith("import-analysis"))
        throw new Error(`unexpected purpose ${purpose}`);
      const checked = validate({
        title: "退潮信",
        synopsis: "沈砚追查一封会在灯下显名的信，并发现遗忘具有可追踪的代价。",
        themes: ["记忆与责任"],
        audience: "偏好悬疑奇幻的成年读者",
        tone: "克制、潮湿、带有物证感",
        boundaries: ["不使用无代价复活"],
        entities: [
          {
            type: "character",
            name: "沈砚",
            aliases: [],
            description: "在旧邮局追查失踪亲人的年轻修复师。",
          },
          {
            type: "location",
            name: "旧邮局",
            aliases: ["邮局"],
            description: "沈砚发现空白信的地点。",
          },
        ],
        style: {
          name: "潮湿物证感",
          description: "通过可触摸细节承载超自然规则。",
          rules: ["规则通过动作显现", "意象必须推动判断"],
          negativeRules: ["不堆叠形容词"],
          examples: ["盐粒从纸纤维里浮出。"],
        },
        skills: [
          {
            name: "规则证据链",
            description: "让奇幻规则能够被人物复验。",
            instructions: "每次揭示规则时同时给出动作、结果与代价。",
            scopes: ["chapter", "review"],
            priority: 75,
          },
        ],
        relationships: [
          {
            fromName: "沈砚",
            toName: "旧邮局",
            relation: "调查",
            description: "沈砚在旧邮局寻找失踪亲人的线索。",
            evidenceParagraphs: [1],
          },
        ],
        timeline: [
          {
            title: "发现空白信",
            description: "沈砚在邮局发现异常信件。",
            sequence: 0,
            participantNames: ["沈砚", "旧邮局"],
            evidenceParagraphs: [1],
          },
        ],
        foreshadows: [
          {
            title: "灯下显名",
            description: "收件人名字需要灯光才会出现。",
            evidenceParagraphs: [2],
          },
        ],
        characterArcs: [
          {
            characterName: "沈砚",
            startState: "只把信当作物证",
            turningPoint: "名字在灯下浮现",
            direction: "从修复物件转向追查遗忘规则",
            evidenceParagraphs: [2],
          },
        ],
        scenes: [
          {
            title: "灯下验信",
            goal: "确认空白信是否藏有信息",
            conflict: "常规观察看不到名字",
            outcome: "灯光令收件人名字浮现",
            evidenceParagraphs: [2],
          },
        ],
      });
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return { value: checked.data, usage, mode: "native", attempts: 1 };
    },
  } as NarrativeModelClient;
}

interface ImportDetail {
  batch: { id: string; status: string };
  candidates: {
    id: string;
    kind: string;
    title: string;
    status: string;
    payload?: Record<string, unknown>;
  }[];
}
