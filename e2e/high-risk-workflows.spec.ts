import { expect, test, type Page } from "@playwright/test";

const TERMINAL_RUN_STATUSES = new Set([
  "awaiting_user",
  "cancelled",
  "completed",
  "failed",
]);

test("项目助手调度完成后，备份恢复保留完整协作历史", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1440",
    "高风险流程只跑一次桌面基线",
  );
  const projectId = await createProject(page, `协作恢复-${Date.now()}`);
  const userMessage = "帮我整理故事方向，并保留为待确认任务。";
  const assistantReply = "已整理为待确认的故事方向任务，确认后才会执行。";
  const backupLabel = `协作全量恢复-${Date.now()}`;

  await page.goto(`/projects/${projectId}/overview`);
  await page.getByRole("button", { name: "打开项目协作" }).click();
  const composer = page.getByLabel("给项目助手的消息");
  await composer.fill(userMessage);
  const acceptedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/assistant\/conversations\/[^/]+\/messages$/u.test(
        new URL(response.url()).pathname,
      ),
  );
  await page.getByRole("button", { name: "发送消息" }).click();
  const accepted = (await (await acceptedResponse).json()) as { runId: string };
  await advanceRunToTerminal(page, projectId, accepted.runId, "completed");
  await expect(page.getByText(assistantReply, { exact: true })).toBeVisible({
    timeout: 12_000,
  });
  await expect(page.getByRole("button", { name: "确认执行" })).toBeVisible();
  await page.getByRole("button", { name: "关闭项目协作" }).click();

  await page.goto(`/projects/${projectId}/delivery`);
  await page.getByLabel("备份标签").fill(backupLabel);
  await page.getByRole("button", { name: "创建内容快照" }).click();
  const backupRow = page.locator(".delivery__backup-row", {
    hasText: backupLabel,
  });
  await expect(backupRow).toBeVisible();
  await backupRow.getByRole("button", { name: "恢复内容副本" }).click();
  await page
    .getByRole("alertdialog", { name: "恢复创作内容快照" })
    .getByRole("button", { name: "恢复内容副本" })
    .click();
  const restoredLink = page.getByRole("link", { name: "打开恢复副本" });
  await expect(restoredLink).toBeVisible();
  await restoredLink.click();
  const restoredProjectId = new URL(page.url()).pathname.split("/")[2]!;
  const conversations = await apiGet<{ id: string }[]>(
    page,
    `/api/projects/${restoredProjectId}/assistant/conversations`,
  );
  const collaboration = await apiGet<{
    messages: { role: string; content: string }[];
    activities: { status: string }[];
  }>(page, `/api/assistant/conversations/${conversations[0]!.id}`);
  expect(collaboration.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: "user", content: userMessage }),
      expect.objectContaining({ role: "assistant", content: assistantReply }),
    ]),
  );
  expect(collaboration.activities).toContainEqual(
    expect.objectContaining({ status: "proposed" }),
  );

  await page.getByRole("button", { name: "打开项目协作" }).click();
  await expect(page.getByText(userMessage, { exact: true })).toBeVisible();
  await expect(page.getByText(assistantReply, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认执行" })).toBeVisible();
});

test("Canon 候选经 UI 生成、裁定并写入作者意图", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1440",
    "高风险流程只跑一次桌面基线",
  );
  const projectId = await createProject(page, `Canon候选-${Date.now()}`);

  await page.goto(`/projects/${projectId}/bible?spread=intent`);
  await page.getByLabel("Canon 修改指示").fill("收紧第一次熄灯的记忆代价。 ");
  const startedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(
        `/api/projects/${projectId}/canon-spreads/intent/candidates`,
      ),
  );
  await page.getByRole("button", { name: "生成候选修改" }).click();
  const started = (await (await startedResponse).json()) as { runId: string };
  await advanceRunToTerminal(page, projectId, started.runId, "completed");

  await expect(page.getByText("收紧失灯代价", { exact: true })).toBeVisible({
    timeout: 12_000,
  });
  await page.getByRole("button", { name: "采纳此项" }).click();
  await expect(
    page.getByText("每次灯塔熄灭，都有人失去一段不能复原的记忆。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("已采纳", { exact: true })).toBeVisible();
});

test("快速创作致命失败会停靠，并可从 UI 重试为新任务", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1440",
    "高风险流程只跑一次桌面基线",
  );
  const projectId = await createProject(page, `失败恢复-${Date.now()}`);
  const created = await apiPost<{ id: string }>(
    page,
    `/api/projects/${projectId}/autopilot/sessions`,
    {
      requestId: crypto.randomUUID(),
      approvalMode: "continuous",
      targetChapters: 2,
      windowSize: 2,
      maxRevisionCycles: 0,
    },
    202,
  );
  await apiPost(
    page,
    `/api/autopilot/sessions/${created.id}/advance`,
    undefined,
  );
  let detail = await apiGet<AutopilotDetail>(
    page,
    `/api/autopilot/sessions/${created.id}`,
  );
  const failedRunId = detail.session.currentRunId!;
  await advanceRunToTerminal(page, projectId, failedRunId, "failed");
  await apiPost(
    page,
    `/api/autopilot/sessions/${created.id}/advance`,
    undefined,
  );
  detail = await apiGet<AutopilotDetail>(
    page,
    `/api/autopilot/sessions/${created.id}`,
  );
  expect(detail.session.status).toBe("awaiting_user");

  await page.goto(`/projects/${projectId}/autopilot?session=${created.id}`);
  await expect(page.getByText("这次创作中断了，请选择下一步：")).toBeVisible();
  const retriedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(
        `/api/autopilot/sessions/${created.id}/resolutions`,
      ),
  );
  await page.getByRole("button", { name: "重试当前章节" }).click();
  const retried = (await (await retriedResponse).json()) as AutopilotDetail;
  expect(retried.session.status).toBe("running");

  await apiPost(
    page,
    `/api/autopilot/sessions/${created.id}/advance`,
    undefined,
  );
  detail = await apiGet<AutopilotDetail>(
    page,
    `/api/autopilot/sessions/${created.id}`,
  );
  expect(detail.session.status).toBe("planning");
  expect(detail.session.currentRunId).not.toBe(failedRunId);
  await page.reload();
  await expect(
    page.getByText("正在规划", { exact: true }).first(),
  ).toBeVisible();
});

interface AutopilotDetail {
  session: {
    status: string;
    currentRunId: string | null;
  };
}

async function createProject(page: Page, title: string): Promise<string> {
  const project = await apiPost<{ id: string }>(
    page,
    "/api/projects",
    {
      requestId: crypto.randomUUID(),
      title,
      premise: "灯塔每次熄灭，港口都会失去一段共同记忆。",
    },
    201,
  );
  return project.id;
}

async function advanceRunToTerminal(
  page: Page,
  projectId: string,
  runId: string,
  expectedStatus: string,
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await apiPost<{
      snapshot: { run: { status: string } };
    }>(page, `/api/runs/${runId}/advance`, { projectId });
    const status = result.snapshot.run.status;
    if (TERMINAL_RUN_STATUSES.has(status)) {
      expect(status).toBe(expectedStatus);
      return;
    }
  }
  throw new Error(`Run ${runId} did not reach a terminal status.`);
}

async function apiGet<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  if (response.status() !== 200) {
    throw new Error(
      `GET ${path} returned ${response.status()}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function apiPost<T>(
  page: Page,
  path: string,
  data: unknown,
  expectedStatus = 200,
): Promise<T> {
  const response = await page.request.post(path, {
    ...(data === undefined ? {} : { data }),
  });
  if (response.status() !== expectedStatus) {
    throw new Error(
      `POST ${path} returned ${response.status()}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}
