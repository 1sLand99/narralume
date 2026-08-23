import { describe, expect, it } from "vitest";

import { proseLintIssues } from "../src/prose-lint.js";

/** 干净段落：无命中词、密度正常，不应产生任何发现。 */
const CLEAN = [
  "太阳落下去，屋里的光变成橘色的。她把凉掉的茶倒掉，重新烧上水。",
  "“你疯了？”她把签好的合同抽回去，“行，你自己玩。”",
  "他把手机扣在桌上，又拿起来看一眼，再扣回去。窗外有人喊孩子回家吃饭。",
].join("\n\n");

function repeat(fragment: string, times: number): string {
  return Array.from({ length: times }, () => fragment).join("");
}

describe("proseLintIssues", () => {
  it("reports nothing for clean prose", () => {
    expect(proseLintIssues(CLEAN)).toEqual([]);
  });

  it("ignores single hits of tic terms", () => {
    const prose = `${CLEAN}\n\n他不禁回头看了眼门口，又把目光收回来。`;
    expect(proseLintIssues(prose)).toEqual([]);
  });

  it("ignores weak adverbs below the per-1000-char budget", () => {
    const prose = [
      CLEAN,
      "他缓缓坐下，又觉得不对，站起来把椅子挪了挪。",
      "她轻轻带上门。灯还亮着，她也没回去关。",
    ].join("\n\n");
    expect(proseLintIssues(prose)).toEqual([]);
  });

  it("reports major when a single cliche term repeats three times", () => {
    const prose = `${repeat("他眼中闪过一丝犹豫。", 3)}${CLEAN}`;
    const issues = proseLintIssues(prose);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("draft.ai_cliche_density");
    expect(issues[0].severity).toBe("major");
    expect(issues[0].message).toContain("眼中闪过×3");
    expect(issues[0].evidence).toContain("眼中闪过");
  });

  it("reports major when five distinct tic terms accumulate", () => {
    const prose = [
      CLEAN,
      "他不禁停下了脚步。",
      "人群中不由自主地安静下来。",
      "深吸一口气，他推开了那扇门。",
      "远处传来取而代之的轰鸣。",
      "她显得有些不知所措。",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("draft.ai_cliche_density");
  });

  it("reports major when weak adverbs exceed three per thousand chars", () => {
    const prose = [
      repeat("他缓缓开口，又缓缓合上嘴。", 3),
      "她微微点头，轻轻放下杯子，淡淡补了一句。",
      CLEAN,
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("draft.ai_adverb_density");
    expect(issues[0].severity).toBe("major");
  });

  it("reports major when negation flips reach three", () => {
    const prose = [
      CLEAN,
      "他不是生气，是把话咽了回去。",
      "那不是道歉，而是一种了结。",
      "她要的不是答案，而是有人肯听完。",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("draft.ai_negation_flip");
    expect(issues[0].evidence).toContain("不是");
  });

  it("ignores negation flips below three", () => {
    const prose = `${CLEAN}\n\n他不是生气，是把话咽了回去。`;
    expect(proseLintIssues(prose)).toEqual([]);
  });
});
