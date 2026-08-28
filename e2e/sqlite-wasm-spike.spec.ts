import { expect, test } from "@playwright/test";

/**
 * M2 spike：真实浏览器（Worker + OPFS）里验证 sqlite-wasm 驱动承载完整
 * 持久层——全部 migration、嵌套事务回滚、WAL/pragma、完整性检查。
 * 该测试不依赖后端 API（webServer 仍会起，但本页面零 API 调用）。
 */
test("sqlite-wasm OPFS driver passes the persistence spike", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1440",
    "The persistence probe is viewport-independent.",
  );
  const spikePort = Number(process.env.NARRATIVE_E2E_SPIKE_PORT ?? 14319);
  await page.goto(`http://127.0.0.1:${spikePort}/spike.html`);
  const status = page.locator("#status");
  await expect
    .poll(async () => status.textContent(), { timeout: 30_000 })
    .toContain('"ok":true');
  const result = (await page.evaluate(
    () =>
      (window as unknown as { __spikeResult: Record<string, unknown> })
        .__spikeResult,
  )) as {
    ok: boolean;
    results: Record<string, unknown>;
  };
  expect(result.ok).toBe(true);
  expect(result.results.migrationVersion).toBe(41);
  // sahpool 官方建议 exclusive + WAL；若 WAL 不可接受则退化为 delete 也算过，
  // 但要显式记录（journalMode 进结果便于诊断）。
  expect(["wal", "delete", "truncate"]).toContain(result.results.journalMode);
  expect(result.results.foreignKeys).toBe(1);
  expect(result.results.nestedRollbackVerified).toBe(true);
  expect(result.results.projectCommitted).toBe(true);
  expect(result.results.updateChanges).toBe(1);
  expect(result.results.missChanges).toBe(0);
  expect(result.results.integrityCheck).toBe("ok");
});
