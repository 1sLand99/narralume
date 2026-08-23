import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, RotateCcw, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import {
  getLocale,
  translate,
  useI18n,
  type Locale,
  type MessageKey,
} from "../../i18n";
import {
  getHarnessTemplates,
  restoreHarnessTemplate,
  updateHarnessTemplate,
  type HarnessTemplate,
} from "../../lib/api";

/* 提示词模板（生成类步骤）：呈现官方默认写作法，允许整体替换并随时恢复官方版本。
 * 结构不变量（锁定正典、输出格式等）由服务端代码强制追加，不在此暴露。 */

const EXPOSED_PROMPT_KEYS: readonly string[] = [
  "prompt.chapter-draft",
  "prompt.chapter-revision",
  "prompt.line-edit",
  "prompt.cocreate-adoption",
  "prompt.book-foundation",
];

interface BilingualDraft {
  "zh-CN": string;
  en: string;
}

/** 面板展示的名称与描述走 i18n 字典（数据库字段仅作未知模板的回退）。 */
const ITEM_COPY: Record<
  string,
  { name: MessageKey; description: MessageKey }
> = {
  "prompt.chapter-draft": {
    name: "settings.prompts.items.chapterDraft.name",
    description: "settings.prompts.items.chapterDraft.description",
  },
  "prompt.chapter-revision": {
    name: "settings.prompts.items.chapterRevision.name",
    description: "settings.prompts.items.chapterRevision.description",
  },
  "prompt.line-edit": {
    name: "settings.prompts.items.lineEdit.name",
    description: "settings.prompts.items.lineEdit.description",
  },
  "prompt.cocreate-adoption": {
    name: "settings.prompts.items.cocreateAdoption.name",
    description: "settings.prompts.items.cocreateAdoption.description",
  },
  "prompt.book-foundation": {
    name: "settings.prompts.items.bookFoundation.name",
    description: "settings.prompts.items.bookFoundation.description",
  },
};

function itemCopy(
  key: string,
): { name: string; description: string } | null {
  const entry = ITEM_COPY[key];
  if (!entry) return null;
  const locale = getLocale();
  return {
    name: translate(locale, entry.name),
    description: translate(locale, entry.description),
  };
}

/** 结构不变量存为双语 JSON；按界面语言取对应版本展示。 */
function invariantText(template: HarnessTemplate, locale: Locale): string {
  const trimmed = template.systemInvariants.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const text = parsed[locale];
    if (typeof text === "string" && text.trim()) return text.trim();
  } catch {
    /* 纯文本原样展示 */
  }
  return trimmed;
}

function parseBilingual(template: HarnessTemplate): BilingualDraft {
  const trimmed = template.effectiveContent.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      typeof parsed["zh-CN"] === "string" &&
      typeof parsed.en === "string"
    ) {
      return { "zh-CN": parsed["zh-CN"], en: parsed.en };
    }
  } catch {
    /* 纯文本内容按中文处理 */
  }
  return { "zh-CN": trimmed, en: "" };
}

function serializeBilingual(draft: BilingualDraft): string {
  return JSON.stringify({ "zh-CN": draft["zh-CN"], en: draft.en }, null, 2);
}

export function PromptTemplatesSection() {
  const { t } = useI18n();
  const templatesQuery = useQuery({
    queryKey: ["harness-templates"],
    queryFn: ({ signal }) => getHarnessTemplates(signal),
    staleTime: 10_000,
  });
  const templates = useMemo(
    () =>
      (templatesQuery.data ?? []).filter(
        (template) =>
          template.kind === "prompt" &&
          EXPOSED_PROMPT_KEYS.includes(template.key),
      ),
    [templatesQuery.data],
  );

  return (
    <section className="settings__section" aria-label={t("settings.prompts.label")}>
      <header className="settings__section-head">
        <div><p className="mono">PROMPTS</p><h2>{t("settings.prompts.label")}</h2></div>
        <p className="settings__section-note">{t("settings.prompts.hint")}</p>
      </header>
      {templatesQuery.isPending ? (
        <Skeleton lines={4} />
      ) : templatesQuery.isError ? (
        <ErrorNote error={templatesQuery.error} title={t("settings.prompts.loadError")} />
      ) : (
        <div className="settings__prompts">
          {templates.map((template) => (
            <PromptTemplateCard
              key={`${template.key}:${template.version}`}
              template={template}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PromptTemplateCard({ template }: { template: HarnessTemplate }) {
  const { t, locale } = useI18n();
  const copy = itemCopy(template.key);
  const name = copy?.name ?? template.name;
  const description = copy?.description ?? template.description;
  const queryClient = useQueryClient();
  // 父级以 `${key}:${version}` 为 key 挂载本卡片：服务端版本变化（保存/恢复/其他
  // 窗口写入）即整体重挂载，本地草稿自然回到最新生效内容，且不受无关刷新影响。
  const initial = useMemo(() => parseBilingual(template), [template]);
  const [draft, setDraft] = useState<BilingualDraft>(initial);

  const dirty =
    draft["zh-CN"] !== initial["zh-CN"] || draft.en !== initial.en;

  const saveMutation = useMutation({
    mutationFn: () =>
      updateHarnessTemplate(template, serializeBilingual(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["harness-templates"] });
    },
  });
  const restoreMutation = useMutation({
    mutationFn: () => restoreHarnessTemplate(template),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["harness-templates"] });
    },
  });

  const error = saveMutation.error ?? restoreMutation.error;
  const pending = saveMutation.isPending || restoreMutation.isPending;

  return (
    <details className="settings__prompt-card" data-modified={Boolean(template.overrideContent)}>
      <summary>
        <span className="settings__prompt-summary-copy">
          <span className="mono">{template.key}</span>
          <strong>{name}</strong>
          <span className="settings__prompt-description">{description}</span>
        </span>
        <span className="settings__prompt-state">
          {template.overrideContent
            ? t("settings.prompts.modified")
            : t("settings.prompts.officialDefault")}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="settings__prompt-body">
        <p className="settings__prompt-invariants">
          <strong>{t("settings.prompts.invariantLabel")}</strong>{" "}
          {invariantText(template, locale)}
        </p>
        <label className="settings__prompt-field">
          {t("settings.prompts.zhLabel")}
          <textarea
            value={draft["zh-CN"]}
            rows={12}
            spellCheck={false}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                "zh-CN": event.target.value,
              }))
            }
          />
        </label>
        <label className="settings__prompt-field">
          {t("settings.prompts.enLabel")}
          <textarea
            value={draft.en}
            rows={8}
            spellCheck={false}
            onChange={(event) =>
              setDraft((current) => ({ ...current, en: event.target.value }))
            }
          />
        </label>
        {error ? (
          <ErrorNote error={error} title={t("settings.prompts.saveErrorTitle")} />
        ) : null}
        <div className="settings__prompt-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!dirty || pending}
            onClick={() => saveMutation.mutate()}
          >
            <Save size={13} aria-hidden="true" /> {t("settings.prompts.saveAction")}
          </button>
          {template.overrideContent ? (
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => restoreMutation.mutate()}
            >
              <RotateCcw size={13} aria-hidden="true" />{" "}
              {t("settings.prompts.restoreAction")}
            </button>
          ) : null}
        </div>
      </div>
    </details>
  );
}
