import { expect, test } from "@playwright/test";

test("故事线建议逐项裁定、证据跳转、刷新保留与过期保护", async ({
  page,
  request,
}, testInfo) => {
  const projectId = `line-proposals-${testInfo.project.name}`;
  const url = `/projects/${projectId}/bible?spread=outline&view=lines`;
  await page.goto(url);
  const panel = page.getByRole("region", {
    name: "故事线进展建议",
    exact: true,
  });
  await expect(panel.getByRole("button", { name: "采纳进展建议" })).toHaveCount(
    3,
  );
  await panel.getByText("复盘时的证据摘要", { exact: true }).first().click();
  await expect(
    panel
      .getByText("见证者交出了旧信，潮声之谜仍未解决。", { exact: true })
      .first(),
  ).toBeVisible();
  await panel.getByRole("link", { name: "旧信的去向" }).first().click();
  await expect(page).toHaveURL(new RegExp(`outline=${projectId}-chapter`));
  await page.goto(url);
  await panel.getByRole("button", { name: "采纳进展建议" }).first().click();
  await expect(
    panel.getByText("已采纳并更新故事线", { exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "拒绝此建议" }).first().click();
  await expect(
    panel.getByText("已拒绝，故事线未修改", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    panel.getByText("已采纳并更新故事线", { exact: true }),
  ).toBeVisible();
  const compassUrl = `/api/projects/${projectId}/compass`;
  const {
    projectId: _id,
    version,
    updatedAt: _time,
    ...compass
  } = await (await request.get(compassUrl)).json();
  void _id;
  void _time;
  expect(
    (
      await request.put(compassUrl, {
        data: {
          ...compass,
          corePromise: "作者刚修改的方向",
          expectedVersion: version,
        },
      })
    ).ok(),
  ).toBe(true);
  await panel.getByRole("button", { name: "采纳进展建议" }).click();
  await expect(
    panel.getByText("故事线或正文证据已变化，请核对新的阶段复盘建议。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "采纳进展建议" }),
  ).toBeDisabled();
  await expect(panel.getByRole("button", { name: "拒绝此建议" })).toBeEnabled();
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    testInfo.project.use.viewport!.width,
  );
  await page.screenshot({
    path: testInfo.outputPath("story-line-proposals.png"),
    fullPage: true,
  });
  await page.evaluate(() => localStorage.setItem("narralume:ui-locale", "en"));
  await page.reload();
  const english = page.getByRole("region", {
    name: "Story line progress proposals",
    exact: true,
  });
  await expect(
    english.getByText("Accepted and story line updated", { exact: true }),
  ).toBeVisible();
  await expect(
    english.getByRole("button", { name: "Accept progress proposal" }),
  ).toBeDisabled();
  await expect(
    english.getByRole("button", { name: "Reject proposal" }),
  ).toBeEnabled();
});
