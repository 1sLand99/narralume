import { expect, test } from "@playwright/test";
import type { KnowledgeEditorDto } from "@narralume/contracts";

test("人工认知维护：历史变化、更正撤销、并发保护与双语重试", async ({
  page,
  request,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  // Each viewport gets a separate copy; the shared read-only fixture stays intact.
  const clone = await request.post("/api/projects/state-fixture/duplicate", {
    data: { title: `认知维护-${testInfo.project.name}` },
  });
  expect(clone.ok()).toBe(true);
  const project = (await clone.json()) as { id: string };
  const endpoint = `/api/projects/${project.id}/knowledge`;
  const initial = (await (
    await request.get(endpoint)
  ).json()) as KnowledgeEditorDto;
  const hero = initial.entities.find((entity) => entity.name === "林澈")!;
  const chapter = (number: number) =>
    initial.outline.find((node) => node.title.startsWith(`第${number}章`))!.id;
  const oldFact = initial.facts.find((fact) => fact.value === "议会")!;
  const event = initial.timeline.find((event) => event.title === "灯塔熄灭")!;
  const url = `/projects/${project.id}/bible?spread=outline&view=state&chapter=${chapter(4)}&audience=character&character=${hero.id}`;
  await page.goto(url);
  const state = page.getByRole("region", { name: "章节状态", exact: true });
  const current = state.getByRole("region", { name: "认知记录", exact: true });
  await state.getByRole("button", { name: "人工登记与更正" }).click();
  const editor = state.getByRole("region", {
    name: "作者维护认知记录",
    exact: true,
  });
  await editor
    .getByRole("button", { name: "登记认知变化", exact: true })
    .click();
  let form = editor.getByRole("form", { name: "登记认知变化", exact: true });
  await expect(form.getByLabel("谁的认知")).toHaveValue(`character:${hero.id}`);
  await form.getByLabel("认知命题").selectOption(`fact:${oldFact.id}`);
  await form.getByLabel("认知状态").selectOption("suspected");
  await form.getByRole("button", { name: "保存认知登记" }).click();
  await expect(editor.getByRole("status")).toContainText("认知记录已保存");
  await expect(
    current
      .getByRole("article")
      .filter({ hasText: "议会" })
      .getByText("怀疑", { exact: true }),
  ).toBeVisible();

  const manual = () =>
    editor
      .getByRole("article")
      .filter({ hasText: "人工登记" })
      .filter({ hasText: "议会" })
      .filter({ hasText: "有效登记" });
  await manual().getByRole("button", { name: "更正登记", exact: true }).click();
  form = editor.getByRole("form", { name: "更正登记", exact: true });
  await form.getByLabel("认知状态").selectOption("believed");
  await form.getByLabel("习得的证据节点").selectOption(chapter(3));
  await form
    .getByLabel("更正或撤销原因")
    .fill("核对第三章，人物此时只是相信证词");
  await form.getByRole("button", { name: "保存认知登记" }).click();
  await expect(
    current
      .getByRole("article")
      .filter({ hasText: "议会" })
      .getByText("相信", { exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByText("核对第三章，人物此时只是相信证词"),
  ).toBeVisible();
  await manual().getByRole("button", { name: "撤销登记", exact: true }).click();
  form = editor.getByRole("form", { name: "撤销登记", exact: true });
  await expect(form).toContainText("可能重新显示该主体更早的有效认知");
  await form
    .getByLabel("更正或撤销原因")
    .fill("这次补录关联错了命题，保留原来的早期认知");
  await form.getByRole("button", { name: "撤销登记", exact: true }).click();
  await expect(
    current
      .getByRole("article")
      .filter({ hasText: "议会" })
      .getByText("误信", { exact: true }),
  ).toBeVisible();
  await state.getByLabel("查看到哪一章").selectOption(chapter(12));
  await expect(
    current
      .getByRole("article")
      .filter({ hasText: "守灯人" })
      .getByText("已知", { exact: true }),
  ).toBeVisible();
  await state.getByLabel("查看到哪一章").selectOption(chapter(4));

  const original = () =>
    editor
      .getByRole("article")
      .filter({ hasText: "创作流程登记" })
      .filter({ hasText: "议会" })
      .filter({ hasText: "有效登记" });
  await original()
    .getByRole("button", { name: "更正登记", exact: true })
    .click();
  form = editor.getByRole("form", { name: "更正登记", exact: true });
  await form.getByLabel("认知状态").selectOption("suspected");
  await form
    .getByLabel("更正或撤销原因")
    .fill("本页正在输入，发生冲突也要保留");

  const second = await context.newPage();
  await second.goto(url);
  await second.getByRole("button", { name: "人工登记与更正" }).click();
  const secondEditor = second.getByRole("region", {
    name: "作者维护认知记录",
    exact: true,
  });
  await secondEditor
    .getByRole("article")
    .filter({ hasText: "创作流程登记" })
    .filter({ hasText: "议会" })
    .filter({ hasText: "有效登记" })
    .getByRole("button", { name: "更正登记", exact: true })
    .click();
  const secondForm = secondEditor.getByRole("form", {
    name: "更正登记",
    exact: true,
  });
  await secondForm.getByLabel("认知状态").selectOption("believed");
  await secondForm
    .getByLabel("更正或撤销原因")
    .fill("另一个页面已经核对并保存");
  await secondForm.getByRole("button", { name: "保存认知登记" }).click();
  await expect(secondEditor.getByRole("status")).toContainText(
    "认知记录已保存",
  );
  await second.close();
  await page.bringToFront();
  // Force a focus refetch too: an arriving fresh catalog must not update the
  // baseline or reset fields in the already-open form.
  const refetched = page.waitForResponse(
    (response) =>
      response.url().endsWith(endpoint) &&
      response.request().method() === "GET",
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("visibilitychange")),
  );
  await refetched;
  await expect(form.getByLabel("更正或撤销原因")).toHaveValue(
    "本页正在输入，发生冲突也要保留",
  );
  await form.getByRole("button", { name: "保存认知登记" }).click();
  await expect(form.getByRole("alert")).toContainText(
    "认知记录或其引用资料已发生变化",
  );
  await expect(form.getByLabel("认知状态")).toHaveValue("suspected");
  await expect(form.getByLabel("更正或撤销原因")).toHaveValue(
    "本页正在输入，发生冲突也要保留",
  );
  await page.screenshot({
    path: testInfo.outputPath("knowledge-conflict.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await form.getByRole("button", { name: "放弃本次修改，重新载入" }).click();
  await expect(form).toHaveCount(0);
  await expect(editor.getByText("另一个页面已经核对并保存")).toBeVisible();

  await page.evaluate(() => localStorage.setItem("narralume:ui-locale", "en"));
  await page.reload();
  await page
    .getByRole("button", { name: "Register and correct knowledge" })
    .click();
  const englishEditor = page.getByRole("region", {
    name: "Author knowledge maintenance",
    exact: true,
  });
  await englishEditor
    .getByRole("button", { name: "Register knowledge change", exact: true })
    .click();
  const englishForm = englishEditor.getByRole("form", {
    name: "Register knowledge change",
    exact: true,
  });
  await englishForm.getByLabel("Whose knowledge").selectOption("reader");
  await englishForm
    .getByLabel("Knowledge claim")
    .selectOption(`event:${event.id}`);
  await englishForm.getByLabel("Belief state").selectOption("known");
  await page.screenshot({
    path: testInfo.outputPath("knowledge-english.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const requestIds: string[] = [];
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requestIds.push(
      (route.request().postDataJSON() as { requestId: string }).requestId,
    );
    if (requestIds.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      return route.abort("failed");
    }
    return route.continue();
  });
  await englishForm
    .getByRole("button", { name: "Save knowledge registration" })
    .click();
  await expect(englishForm.getByRole("alert")).toContainText(
    "Could not save knowledge",
  );
  await expect(englishForm.getByLabel("Knowledge claim")).toHaveValue(
    `event:${event.id}`,
  );
  await englishForm
    .getByRole("button", { name: "Save knowledge registration" })
    .click();
  await expect(englishEditor.getByRole("status")).toContainText(
    "Knowledge saved",
  );
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  const final = (await (
    await request.get(endpoint)
  ).json()) as KnowledgeEditorDto;
  expect(final.records).toHaveLength(initial.records.length + 4);
  expect(final.corrections).toHaveLength(3);
});
