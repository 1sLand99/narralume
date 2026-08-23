import type { ProjectLanguage } from "@narralume/contracts";

/** AI 指令与产出跟随作品语言（project.language），与界面语言无关。
 *  未知值回落中文，覆盖存量数据与缺省路径。 */
export function promptLanguageOf(
  language: string | null | undefined,
): ProjectLanguage {
  return language === "en" ? "en" : "zh-CN";
}

/** 按项目语言取双语指令表并拼接为 system instructions。 */
export function instructionsFor(
  language: string | null | undefined,
  table: Record<ProjectLanguage, readonly string[]>,
): string {
  return table[promptLanguageOf(language)].join("\n");
}

/** 解析模板生效内容：双语 JSON（{"zh-CN": "...", "en": "..."}）；纯文本视为中文。 */
export function editableInstructionOf(
  content: string,
  language: ProjectLanguage,
): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const text = parsed[language];
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return language === "en" ? null : trimmed;
  }
}

/** 替换式指令组装：模板生效内容整体替换默认写作层；结构不变量始终由代码追加，
 *  不受模板内容影响。 */
export function authoredInstructions(options: {
  language: ProjectLanguage;
  templateContent: string | null;
  fallback: Record<ProjectLanguage, string>;
  invariants: Record<ProjectLanguage, string>;
}): string {
  const { language, templateContent, fallback, invariants } = options;
  const authored =
    templateContent === null ? null : editableInstructionOf(templateContent, language);
  return [
    authored ?? fallback[language],
    invariants[language],
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}
