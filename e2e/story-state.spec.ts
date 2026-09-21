import { expect, test } from "@playwright/test";

test("按章核对认知、关系与伏笔证据，刷新和导航保留定位", async ({
  page,
}, testInfo) => {
  await page.goto(
    "/projects/state-fixture/bible?spread=outline&view=state&chapter=state-c2",
  );
  const view = page.getByRole("region", { name: "章节状态", exact: true });
  const knowledge = () =>
    view.getByRole("region", { name: "认知记录", exact: true });
  await expect(knowledge().getByRole("article")).toHaveCount(4);
  const clue = view.getByRole("article", { name: "两份证词的矛盾" });
  await expect(clue.getByText("当前计划状态： 已回收")).toBeVisible();
  await expect(
    clue.getByRole("link", { name: "第1章 · 旧证词" }),
  ).toBeVisible();
  await expect(
    clue.getByRole("link", { name: "第2章 · 熄灯之夜 / 塔下的目击者" }),
  ).toBeVisible();
  await expect(
    clue.getByRole("link", { name: "第12章 · 证词翻转" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("chapter-state-author.png"),
    fullPage: true,
  });
  await view.getByRole("link", { name: "维护伏笔", exact: true }).click();
  await expect(page).toHaveURL(
    /spread=foreshadows&view=state&chapter=state-c2/,
  );
  await page.getByRole("button", { name: "查看大纲", exact: true }).click();
  await expect(view.getByLabel("查看到哪一章")).toHaveValue("state-c2");

  await view.getByLabel("认知视角").selectOption("character:state-hero");
  await expect(knowledge().getByRole("article")).toHaveCount(2);
  await expect(knowledge().getByText("误信", { exact: true })).toBeVisible();
  await expect(knowledge().getByText("怀疑", { exact: true })).toBeVisible();
  await expect(knowledge().getByText("林澈 · 灯塔控制者 · 议会")).toBeVisible();
  await expect(view.getByText("守灯人", { exact: false })).toHaveCount(0);
  await expect(clue).toHaveCount(0);
  const relationships = view.getByRole("region", {
    name: "登记关系",
    exact: true,
  });
  await expect(relationships.getByRole("article")).toHaveCount(1);
  await expect(
    relationships.getByText("互相怀疑", { exact: false }),
  ).toBeVisible();
  const evidence = knowledge().getByRole("link", {
    name: "第2章 · 熄灯之夜 / 塔下的目击者",
  });
  await expect(evidence).toHaveAttribute(
    "href",
    "/projects/state-fixture/studio?outline=state-c2",
  );
  await evidence.click();
  await expect(page).toHaveURL(/studio\?outline=state-c2$/);
  await page.goBack();
  await expect(view.getByLabel("认知视角")).toHaveValue("character:state-hero");

  await view.getByLabel("查看到哪一章").selectOption("state-c12");
  await expect(knowledge().getByText("已知", { exact: true })).toHaveCount(2);
  await expect(knowledge().getByText("误信", { exact: true })).toHaveCount(0);
  await expect(
    knowledge().getByText("林澈 · 灯塔控制者 · 守灯人"),
  ).toBeVisible();
  await expect(
    relationships.getByText("交换证据后结盟", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(view.getByLabel("查看到哪一章")).toHaveValue("state-c12");
  await expect(view.getByLabel("认知视角")).toHaveValue("character:state-hero");
  await expect(knowledge().getByText("已知", { exact: true })).toHaveCount(2);
  await view.getByLabel("查看到哪一章").selectOption("state-c2");
  await view.getByLabel("认知视角").selectOption("reader");
  await expect(knowledge().getByRole("article")).toHaveCount(1);
  await expect(knowledge().getByText("相信", { exact: true })).toBeVisible();
  await view.getByLabel("认知视角").selectOption("character:state-outsider");
  await expect(
    knowledge().getByText(
      "截至本章尚未登记相关认知，不能据此判断人物或读者不知道。",
    ),
  ).toBeVisible();

  await view.getByLabel("认知视角").selectOption("character:state-hero");
  await expect(knowledge().getByText("误信", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("chapter-state-character.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => localStorage.setItem("narralume:ui-locale", "en"));
  await page.reload();
  const englishView = page.getByRole("region", {
    name: "Chapter state",
    exact: true,
  });
  await expect(
    englishView.getByText("False belief", { exact: true }),
  ).toBeVisible();
  await expect(
    englishView.getByText("Suspected", { exact: true }),
  ).toBeVisible();
  await expect(englishView.getByLabel("Through chapter")).toHaveValue(
    "state-c2",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("章节状态空作品入口与看板直达", async ({ page, request }) => {
  const response = await request.post("/api/projects", {
    data: { requestId: crypto.randomUUID(), title: "空作品状态" },
  });
  expect(response.ok()).toBe(true);
  const project = (await response.json()) as { id: string };
  await page.goto(`/projects/${project.id}/bible?spread=outline&view=state`);
  await expect(
    page.getByText("先添加章节，再按章节查看故事状态。"),
  ).toBeVisible();
  await page.goto("/projects/state-fixture/bible?spread=outline&view=board");
  await page
    .getByRole("link", { name: "查看本章状态", exact: true })
    .nth(1)
    .click();
  await expect(page.getByLabel("查看到哪一章")).toHaveValue("state-c2");
  await expect(
    page
      .getByRole("region", { name: "认知记录", exact: true })
      .getByRole("article"),
  ).toHaveCount(4);
  await page.goto(
    "/projects/state-fixture/bible?spread=outline&view=state&chapter=missing",
  );
  await expect(
    page.getByText("所选章节不存在或已废弃，请重新选择。"),
  ).toBeVisible();
  await page.getByLabel("查看到哪一章").selectOption("state-c1");
  await expect(
    page
      .getByRole("region", { name: "认知记录", exact: true })
      .getByRole("article"),
  ).toHaveCount(1);
});
