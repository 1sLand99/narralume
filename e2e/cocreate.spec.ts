import { expect, test, type Page } from "@playwright/test";

const TERMINAL_RUN_STATUSES = new Set([
  "awaiting_user",
  "cancelled",
  "completed",
  "failed",
]);

test("故事房经 UI 生成 Swipe，并解释本回合命中的世界书", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1440",
    "故事房高风险流程只跑一次桌面基线",
  );
  const projectId = await createProject(page, `故事房验收-${Date.now()}`);
  const author = await createPersona(page, projectId, {
    kind: "author",
    name: "执灯人",
    description: "作者在故事房里的身份",
    instructions: "只描述可观察的动作。",
  });
  const narrator = await createPersona(page, projectId, {
    kind: "narrator",
    name: "潮声旁白",
    description: "贴近角色的有限视角叙述者",
    instructions: "使用克制、具体的中文。",
  });
  const lorebook = await apiPost<{ id: string }>(
    page,
    `/api/projects/${projectId}/lorebooks`,
    {
      name: "退潮信件规则",
      description: "只在灯火相关回合启用",
      enabledGlobally: false,
      scanTurns: 24,
      enabled: true,
    },
    201,
  );
  await apiPost(
    page,
    `/api/lorebooks/${lorebook.id}/entries`,
    {
      title: "煤油灯显字",
      content: "E2E_WORLD_LORE_SENTINEL：煤油灯会让未寄出的信析出细盐。",
      keys: ["煤油灯"],
      constant: false,
      priority: 80,
      enabled: true,
    },
    201,
  );
  await apiPut(page, `/api/personas/${narrator.id}/lorebooks`, {
    lorebookIds: [lorebook.id],
    expectedVersion: 0,
  });

  await page.goto(`/projects/${projectId}/studio?mode=cocreate&newRoom=1`);
  await expect(
    page.getByRole("heading", { name: "建立故事房", level: 3 }),
  ).toBeVisible();
  await page.getByLabel("房间名").fill("空白信试演");
  await page.getByLabel("我的身份（可选）").selectOption(author.id);
  await page.getByLabel(narrator.name, { exact: true }).check();
  await page.getByRole("button", { name: "创建故事房" }).click();
  await expect(
    page.getByRole("heading", { name: "空白信试演", level: 2 }),
  ).toBeVisible();

  const loreManager = page.locator(".cocreate__lore-manager");
  await page.getByText("管理世界书", { exact: true }).click();
  await loreManager.getByLabel("编辑对象").selectOption(lorebook.id);
  await expect(
    loreManager.getByText("煤油灯显字", { exact: true }),
  ).toBeVisible();
  await expect(
    loreManager.getByLabel("当前说话者为这张角色卡时启用"),
  ).toBeChecked();

  const turnAccepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/cocreate\/sessions\/[^/]+\/turns$/u.test(
        new URL(response.url()).pathname,
      ),
  );
  await page
    .getByLabel("你的回合")
    .fill("煤油灯下，沈砚把姐姐留下的空白信推到火光边缘。");
  await page.getByRole("button", { name: "发送并生成回复" }).click();
  const accepted = (await (await turnAccepted).json()) as {
    run: { id: string };
  };
  await advanceRunToTerminal(page, projectId, accepted.run.id);
  await expect(
    page.getByText("她把灯芯压低，信纸随即析出一圈细盐。", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 12_000 });
  const loreHits = page.getByText("本回合使用了 1 条世界信息", {
    exact: true,
  });
  await expect(loreHits).toBeVisible();
  await loreHits.click();
  await expect(page.locator(".cocreate__lore-hits")).toContainText(
    "命中：煤油灯",
  );

  const swipeAccepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/turns\/[^/]+\/swipes$/u.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "再生成回应" }).click();
  const swipe = (await (await swipeAccepted).json()) as { run: { id: string } };
  await advanceRunToTerminal(page, projectId, swipe.run.id);
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible({
    timeout: 12_000,
  });
  await page.getByRole("button", { name: "上一个回应版本" }).click();
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
});

test("移动端故事房可切换房间导航与设置面板", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-375",
    "移动端核心交互只跑手机视口",
  );
  const projectId = await createProject(page, `移动故事房-${Date.now()}`);
  const narrator = await createPersona(page, projectId, {
    kind: "narrator",
    name: "雾港旁白",
    description: "移动端验收角色",
    instructions: "保持有限视角。",
  });
  const detail = await apiPost<{ session: { id: string } }>(
    page,
    `/api/projects/${projectId}/cocreate/sessions`,
    {
      title: "移动端试演",
      speakerPolicy: "natural",
      participantIds: [narrator.id],
    },
    201,
  );

  await page.goto(
    `/projects/${projectId}/studio?mode=cocreate&session=${detail.session.id}`,
  );
  await expect(
    page.getByRole("heading", { name: "移动端试演", level: 2 }),
  ).toBeVisible();
  const navigation = page.locator(".cocreate__setup");
  const settings = page.locator(".cocreate__context");
  await page.getByRole("button", { name: "房间与分支" }).click();
  await expect(navigation).toHaveAttribute("data-mobile-open", "true");
  await expect(
    navigation.getByText("移动端试演", { exact: true }),
  ).toBeVisible();
  await navigation.getByRole("button", { name: "关闭面板" }).click();
  await expect(navigation).toHaveAttribute("data-mobile-open", "false");

  await page.getByRole("button", { name: "房间设置" }).click();
  await expect(settings).toHaveAttribute("data-mobile-open", "true");
  await expect(settings.getByText("房间设置", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "关闭面板" }).click();
  await expect(settings).toHaveAttribute("data-mobile-open", "false");
  await expect(page.getByLabel("你的回合")).toBeVisible();
});

async function createProject(page: Page, title: string): Promise<string> {
  const project = await apiPost<{ id: string }>(
    page,
    "/api/projects",
    {
      requestId: crypto.randomUUID(),
      title,
      premise: "退潮时，未寄出的信会显露隐藏的盐痕。",
    },
    201,
  );
  return project.id;
}

function createPersona(
  page: Page,
  projectId: string,
  input: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  return apiPost(page, `/api/projects/${projectId}/personas`, input, 201);
}

async function advanceRunToTerminal(
  page: Page,
  projectId: string,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await apiPost<{
      snapshot: { run: { status: string } };
    }>(page, `/api/runs/${runId}/advance`, { projectId });
    const status = result.snapshot.run.status;
    if (TERMINAL_RUN_STATUSES.has(status)) {
      expect(status).toBe("completed");
      return;
    }
  }
  throw new Error(`Run ${runId} did not reach a terminal status.`);
}

async function apiPost<T>(
  page: Page,
  path: string,
  data: unknown,
  expectedStatus = 200,
): Promise<T> {
  const response = await page.request.post(path, { data });
  if (response.status() !== expectedStatus) {
    throw new Error(
      `POST ${path} returned ${response.status()}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function apiPut<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.put(path, { data });
  if (response.status() !== 200) {
    throw new Error(
      `PUT ${path} returned ${response.status()}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}
