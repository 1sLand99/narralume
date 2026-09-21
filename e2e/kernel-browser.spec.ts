import { expect, test } from "@playwright/test";

const KERNEL_READY_TIMEOUT = 40_000;

/**
 * M3 验收：浏览器本地内核（Worker + OPFS）承载 UI 主链。
 * 显式把驱动锁到 local（localStorage 覆盖），全程不依赖 Node API——
 * 尽管Playwright webServer 仍在，页面请求一律走内核 RouteTable。
 * 链路：建项目 → 大纲 → 写作台手写并保存版本 → 交付备份 → reload 持久
 * → 运行中心可访问。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("narralume:driver", "local"),
  );
});

test("本地内核 UI 主链：建项目 → 大纲 → 写作 → 版本持久 → 运行中心", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}`;
  const title = `内核潮汐-${suffix}`;
  const chapterTitle = `雾港内核-${suffix}`;
  const body =
    "林昇回港当夜，灯塔突然熄灭。退潮前，他在石阶下找到一封没有署名的信。";

  await page.goto("/");
  await expect(page.locator(".status-pill__label").first()).toHaveText(
    "内核在线",
    { timeout: KERNEL_READY_TIMEOUT },
  );

  // 空白建书（无模型也可用的纯项目创建）。
  await page.getByRole("button", { name: /空白建书/ }).click();
  await page.getByLabel("书名").fill(title);
  await page.getByLabel(/卷首语/).fill("失灯的守塔人必须在退潮前找回一封信。");
  await page.getByRole("button", { name: "创建并入藏" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/overview$/);
  const projectId = new URL(page.url()).pathname.split("/")[2];
  expect(projectId).toBeTruthy();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  // 大纲：创建章节节点。
  await page.getByRole("link", { name: "前往故事" }).click();
  await page.getByRole("button", { name: "查看大纲" }).click();
  await page.getByLabel("类型").selectOption({ label: "章节" });
  await page.getByLabel("标题").fill(chapterTitle);
  await page.getByLabel("摘要").fill("林昇回港当夜，灯塔突然熄灭。");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toContainText("已写入服务端");
  await page.getByLabel("编辑对象").selectOption({ label: chapterTitle });
  await page.getByRole("link", { name: "去写作台写本章" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectId}/studio\\?outline=`),
  );
  const chapterId = new URL(page.url()).searchParams.get("outline")!;
  expect(chapterId).toBeTruthy();

  // 写作台：创建文档 + 手写正文并保存版本（手动创作永远可用）。
  await page.getByRole("button", { name: "创建" }).click();
  const editor = page.getByLabel("Markdown 正文编辑器");
  await expect(editor).toBeVisible();
  await editor.fill(body);
  await page.getByRole("button", { name: "保存新版本" }).click();
  await expect(page.getByRole("status")).toContainText(/已保存|版本/);

  // 重启持久性：reload 后内核从 OPFS 重开，章节文档与正文仍在。
  await page.reload();
  await expect(page.locator(".status-pill__label").first()).toHaveText(
    "内核在线",
    { timeout: KERNEL_READY_TIMEOUT },
  );
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(/灯塔突然熄灭/);

  // The same chapter-state route also runs in the browser's local database.
  await page.goto(
    `/projects/${projectId}/bible?spread=outline&view=state&chapter=${encodeURIComponent(chapterId)}`,
  );
  const stateView = page.getByRole("region", { name: "章节状态", exact: true });
  await expect(stateView.getByLabel("查看到哪一章")).toHaveValue(chapterId);
  await expect(
    stateView.getByText(
      "截至本章尚未登记相关认知，不能据此判断人物或读者不知道。",
    ),
  ).toBeVisible();

  // runs 账本在 local 驱动下可用（运行中心空态；窄屏导航折叠，直接按地址访问）。
  await page.goto(`/projects/${projectId}/runs`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/runs`));

  // 下载我的库（D6）：local 驱动从内核导出完整 SQLite bytes。
  const download = page.waitForEvent("download");
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: /下载我的库/ })).toBeVisible();
  await page.getByRole("button", { name: /下载我的库/ }).click();
  const library = await download;
  expect(library.suggestedFilename()).toMatch(/\.sqlite$/);
});
