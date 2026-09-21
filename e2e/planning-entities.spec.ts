import { expect, test, type APIRequestContext } from "@playwright/test";

async function start(request: APIRequestContext) {
  const project = await request.post("/api/projects", {
    data: { requestId: crypto.randomUUID(), title: "实体候选端到端" },
  });
  expect(project.ok()).toBe(true);
  const projectId = (await project.json()).id as string;
  const session = await request.post(
    `/api/projects/${projectId}/autopilot/sessions`,
    {
      data: {
        requestId: crypto.randomUUID(),
        targetChapters: 1,
        windowSize: 1,
      },
    },
  );
  expect(session.ok()).toBe(true);
  const sessionId = (await session.json()).id as string;
  await request.post(`/api/autopilot/sessions/${sessionId}/advance`);
  const detail = await request.get(`/api/autopilot/sessions/${sessionId}`);
  const runId = (await detail.json()).session.currentRunId as string;
  for (let i = 0; i < 3; i++) {
    const response = await request.post(`/api/runs/${runId}/advance`, {
      data: { projectId },
    });
    expect(response.ok()).toBe(true);
  }
  await request.post(`/api/autopilot/sessions/${sessionId}/advance`);
  return { projectId, sessionId, runId };
}

test("规划的新设定经作者采纳后才创建章节", async ({
  page,
  request,
}, testInfo) => {
  const { projectId, sessionId, runId } = await start(request);
  await page.goto(`/projects/${projectId}/autopilot?session=${sessionId}`);
  const panel = page.getByRole("region", {
    name: "后续规划的新设定",
    exact: true,
  });
  const continueButton = panel.getByRole("button", {
    name: "按已采纳设定继续规划",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "沈渡", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("带来外港视角并质疑调查者动机", { exact: true }),
  ).toBeVisible();
  await expect(continueButton).toBeDisabled();
  await expect(panel.getByText("人物", { exact: true })).toBeVisible();
  if (testInfo.project.name === "mobile-375")
    expect(
      await page
        .locator(".autopilot__compass-body")
        .evaluate((element) => element.getBoundingClientRect().width),
    ).toBeGreaterThan(220);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("planning-entities-review.png"),
    fullPage: true,
  });
  await panel
    .getByRole("button", { name: "采纳此项", exact: true })
    .first()
    .click();
  await expect(panel.getByText("已采纳", { exact: true })).toHaveCount(1);
  await expect(continueButton).toBeDisabled();
  await page.reload();
  await expect(panel.getByText("已采纳", { exact: true })).toHaveCount(1);
  await page.evaluate(() => localStorage.setItem("narralume:ui-locale", "en"));
  await page.reload();
  const englishPanel = page.getByRole("region", {
    name: "New story elements in the plan",
    exact: true,
  });
  await expect(
    englishPanel.getByText("Character", { exact: true }),
  ).toBeVisible();
  await expect(
    englishPanel.getByRole("heading", { name: "沈渡", exact: true }),
  ).toBeVisible();
  await englishPanel
    .getByRole("button", { name: "Adopt this item", exact: true })
    .click();
  const englishContinue = englishPanel.getByRole("button", {
    name: "Continue with adopted story elements",
    exact: true,
  });
  await expect(englishContinue).toBeEnabled();
  await englishPanel.screenshot({
    path: testInfo.outputPath("planning-entities-adopted-en.png"),
  });
  await englishContinue.click();
  for (let i = 0; i < 2; i++)
    expect(
      (
        await request.post(`/api/runs/${runId}/advance`, {
          data: { projectId },
        })
      ).ok(),
    ).toBe(true);
  const bible = await (
    await request.get(`/api/projects/${projectId}/story-bible`)
  ).json();
  const pilot = bible.entities.find(
    (entity: { name: string }) => entity.name === "沈渡",
  );
  expect(
    bible.outline.find((node: { kind: string }) => node.kind === "chapter")
      .povEntityId,
  ).toBe(pilot.id);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("拒绝新设定后保留裁定并提供重新规划", async ({
  page,
  request,
}, testInfo) => {
  const { projectId, sessionId } = await start(request);
  await page.goto(`/projects/${projectId}/autopilot?session=${sessionId}`);
  const panel = page.getByRole("region", {
    name: "后续规划的新设定",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "拒绝", exact: true })
    .first()
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "有候选被拒绝，请重新规划。已采纳的设定会保留，拒绝记录会带入下一轮。",
  );
  await expect(
    panel.getByRole("button", { name: "按已采纳设定继续规划", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(panel.getByText("已拒绝", { exact: true })).toHaveCount(1);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("planning-entities-rejected.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "重新规划", exact: true }).click();
  await expect(panel).toHaveCount(0);
  const bible = await (
    await request.get(`/api/projects/${projectId}/story-bible`)
  ).json();
  expect(bible.entities).toHaveLength(0);
  expect(bible.outline).toHaveLength(1);
  expect(bible.outline[0].status).not.toBe("abandoned");
});
