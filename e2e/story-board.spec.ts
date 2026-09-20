import { expect, test } from "@playwright/test";

test("全书看板显示结构、筛选章节并打开正文", async ({
  page,
  request,
}, testInfo) => {
  const projectResponse = await request.post("/api/projects", {
    data: { requestId: crypto.randomUUID(), title: "看清整部故事" },
  });
  expect(projectResponse.ok()).toBe(true);
  const project = (await projectResponse.json()) as { id: string };
  const bible = (await (
    await request.get(`/api/projects/${project.id}/story-bible`)
  ).json()) as { outline: { id: string; kind: string }[] };
  const root = bible.outline.find((node) => node.kind === "book")!;
  const createNode = async (
    parentId: string,
    kind: string,
    title: string,
    ordinal: number,
  ) => {
    const response = await request.post(`/api/projects/${project.id}/outline`, {
      data: {
        parentId,
        kind,
        title,
        ordinal,
        summary: "追索旧港的失踪事件，保留人物选择与后续展开空间。",
        goal: "查明信件来源",
        conflict: "证人不愿透露旧事",
        metadata: {},
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as { id: string };
  };
  const volume = await createNode(root.id, "volume", "第一卷 · 旧港", 0);
  const arc = await createNode(volume.id, "arc", "回声与失踪者", 0);
  const first = await createNode(arc.id, "chapter", "第一章 · 退潮后的信", 0);
  await createNode(arc.id, "chapter", "第二章 · 沉默的证人", 1);
  await page.goto(`/projects/${project.id}/bible?spread=outline&view=board`);
  const board = page.getByRole("region", { name: "看清整部故事", exact: true });
  await expect(
    board.getByRole("heading", { name: "第一章 · 退潮后的信" }),
  ).toBeVisible();
  await expect(board.getByText("第一卷 · 旧港 / 回声与失踪者")).toHaveCount(2);
  await board.getByLabel("章节状态").selectOption("committed");
  await expect(board.getByText("没有符合筛选条件的章节。")).toBeVisible();
  await board.getByLabel("章节状态").selectOption("all");
  await expect(board.getByRole("link", { name: "进入写作" })).toHaveCount(2);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("story-board.png"),
    fullPage: true,
  });
  await board.getByRole("link", { name: "进入写作" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/studio\\?outline=${first.id}`));
});
