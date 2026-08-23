/** AI 腔确定性检测：内置词表与密度阈值。
 *
 *  设计原则：单词命中不报，密度或计数超标才报 major——既避免为一次口癖
 *  烧一轮全文修订，也天然消化世界观术语的偶发误报。词表为 zh 子串，
 *  英文正文无命中，恒惰性。阈值校准参考网文语料统计
 *  （弱化副词每千字 ≤3，oh-story-claudecode，MIT）。 */

export interface ProseLintIssue {
  code: string;
  severity: "major" | "critical";
  message: string;
  evidence: string | null;
}

const WEAK_ADVERBS = ["缓缓", "微微", "轻轻", "淡淡"] as const;

const CLICHE_TERMS = [
  "不禁",
  "不由自主",
  "映入眼帘",
  "深吸一口气",
  "嘴角勾起",
  "眼中闪过",
  "眼底闪过",
  "心中暗道",
  "心中一凛",
  "心头一震",
  "心中一动",
  "瞳孔微缩",
  "瞳孔一缩",
  "仿佛",
  "宛如",
  "犹如",
  "一丝",
  "一抹",
  "取而代之",
  "显得有些",
  "声音不大",
  "沉声道",
] as const;

/** “不是A，（而）是B”式否定翻转（“而”可省略）：不少于 3 次才报。 */
const NEGATION_FLIP = /不是[^，。！？\n“”‘’]{1,12}，?而?是/gu;

function countOccurrences(content: string, term: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(term, offset)) >= 0) {
    count += 1;
    offset += term.length;
  }
  return count;
}

function evidenceAround(content: string, term: string): string | null {
  const index = content.indexOf(term);
  return index < 0 ? null : content.slice(index, index + 40);
}

/** 弱化副词：合计每千字超过 3 个且绝对数不少于 4 个才报。 */
function weakAdverbIssue(content: string): ProseLintIssue | null {
  const hits = WEAK_ADVERBS.reduce(
    (sum, term) => sum + countOccurrences(content, term),
    0,
  );
  const characters = [...content].length;
  if (hits < 4 || hits * 1000 <= 3 * characters) return null;
  const first = WEAK_ADVERBS.find((term) => content.includes(term));
  return {
    code: "draft.ai_adverb_density",
    severity: "major",
    message: `弱化副词（缓缓/微微/轻轻/淡淡）密度过高：${hits} 次`,
    evidence: first ? evidenceAround(content, first) : null,
  };
}

/** 套话词表：单项命中不少于 3 次或总数不少于 5 次才报。 */
function clicheIssue(content: string): ProseLintIssue | null {
  const hits = CLICHE_TERMS.map((term) => ({
    term,
    count: countOccurrences(content, term),
  })).filter((hit) => hit.count > 0);
  if (hits.length === 0) return null;
  const total = hits.reduce((sum, hit) => sum + hit.count, 0);
  hits.sort((a, b) => b.count - a.count);
  if (total < 5 && hits[0].count < 3) return null;
  const summary = hits
    .filter((hit) => hit.count >= 2)
    .map((hit) => `${hit.term}×${hit.count}`)
    .join("、");
  return {
    code: "draft.ai_cliche_density",
    severity: "major",
    message: `AI 腔套话密度过高：${summary || `${hits[0].term}×${hits[0].count}`}`,
    evidence: evidenceAround(content, hits[0].term),
  };
}

/** “不是A，（而）是B”式否定翻转：不少于 3 次才报。 */
function negationFlipIssue(content: string): ProseLintIssue | null {
  const matches = content.match(NEGATION_FLIP);
  if (!matches || matches.length < 3) return null;
  const locator = /不是[^，。！？\n“”‘’]{1,12}，?而?是/u;
  const first = locator.exec(content);
  return {
    code: "draft.ai_negation_flip",
    severity: "major",
    message: `“不是…而是”式否定翻转过多：${matches.length} 次`,
    evidence: first ? content.slice(first.index, first.index + 40) : null,
  };
}

export function proseLintIssues(content: string): ProseLintIssue[] {
  return [
    weakAdverbIssue(content),
    clicheIssue(content),
    negationFlipIssue(content),
  ].filter((issue): issue is ProseLintIssue => issue !== null);
}
