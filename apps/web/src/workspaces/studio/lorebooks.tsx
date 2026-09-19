import { useQuery } from "@tanstack/react-query";
import { BookOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { useI18n } from "../../i18n";
import {
  createLorebook,
  createLoreEntry,
  deleteLorebook,
  deleteLoreEntry,
  getPersonaLorebookBindings,
  getSessionLorebookBindings,
  replacePersonaLorebookBindings,
  replaceSessionLorebookBindings,
  updateLorebook,
  updateLoreEntry,
  type CoCreateSession,
  type LoreEntry,
  type LorebookDetail,
  type StoryPersona,
} from "../../lib/api";

export function LorebookManager({
  projectId,
  lorebooks,
  personas,
  session,
  pending,
  onRun,
}: {
  projectId: string;
  lorebooks: LorebookDetail[];
  personas: StoryPersona[];
  session: CoCreateSession | null;
  pending: boolean;
  onRun: (work: () => Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const [selectedBookId, setSelectedBookId] = useState("new");
  const [selectedPersonaId, setSelectedPersonaId] = useState(
    personas.find((persona) => persona.kind !== "author")?.id ?? "",
  );
  const selectedBook = lorebooks.find(
    ({ lorebook }) => lorebook.id === selectedBookId,
  );
  const bindablePersonas = personas.filter(
    (persona) => persona.kind !== "author",
  );
  const effectivePersonaId = bindablePersonas.some(
    (persona) => persona.id === selectedPersonaId,
  )
    ? selectedPersonaId
    : (bindablePersonas[0]?.id ?? "");
  const personaBinding = useQuery({
    queryKey: [
      "project",
      projectId,
      "personas",
      effectivePersonaId,
      "lorebooks",
    ],
    queryFn: ({ signal }) =>
      getPersonaLorebookBindings(effectivePersonaId, signal),
    enabled: Boolean(effectivePersonaId && selectedBook),
  });
  const sessionBinding = useQuery({
    queryKey: ["cocreate", "session", session?.id, "lorebooks"],
    queryFn: ({ signal }) =>
      getSessionLorebookBindings(session!.id, signal),
    enabled: Boolean(session && selectedBook),
  });
  const toggleBinding = (
    currentIds: string[],
    lorebookId: string,
    checked: boolean,
  ) =>
    checked
      ? [...new Set([...currentIds, lorebookId])]
      : currentIds.filter((id) => id !== lorebookId);

  return (
    <section className="cocreate__lore-manager">
      <header>
        <p className="mono">{t("studio.cocreate.lore.eyebrow")}</p>
        <h3>{t("studio.cocreate.lore.title")}</h3>
        <p>{t("studio.cocreate.lore.note")}</p>
      </header>
      <label>
        {t("studio.cocreate.lore.editTarget")}
        <select
          value={selectedBook?.lorebook.id ?? "new"}
          onChange={(event) => setSelectedBookId(event.target.value)}
        >
          <option value="new">{t("studio.cocreate.lore.newOption")}</option>
          {lorebooks.map(({ lorebook }) => (
            <option key={lorebook.id} value={lorebook.id}>
              {lorebook.name}
            </option>
          ))}
        </select>
      </label>
      <LorebookForm
        key={selectedBook?.lorebook.id ?? "new"}
        projectId={projectId}
        detail={selectedBook ?? null}
        pending={pending}
        onRun={onRun}
        onDeleted={() => setSelectedBookId("new")}
      />
      {selectedBook ? (
        <>
          <section className="cocreate__lore-bindings">
            <h4>{t("studio.cocreate.lore.bindings")}</h4>
            {session ? (
              sessionBinding.isPending ? (
                <Skeleton lines={1} />
              ) : sessionBinding.isError ? (
                <ErrorNote
                  error={sessionBinding.error}
                  title={t("studio.errors.loreBindingsLoad")}
                />
              ) : (
                <label>
                  <input
                    type="checkbox"
                    checked={sessionBinding.data.lorebookIds.includes(
                      selectedBook.lorebook.id,
                    )}
                    disabled={pending || session.status !== "active"}
                    onChange={(event) =>
                      onRun(() =>
                        replaceSessionLorebookBindings(
                          session.id,
                          toggleBinding(
                            sessionBinding.data.lorebookIds,
                            selectedBook.lorebook.id,
                            event.target.checked,
                          ),
                          sessionBinding.data.version,
                        ),
                      )
                    }
                  />
                  {t("studio.cocreate.lore.bindRoom", {
                    room: session.title,
                  })}
                </label>
              )
            ) : (
              <p>{t("studio.cocreate.lore.bindRoomUnavailable")}</p>
            )}
            {bindablePersonas.length ? (
              <>
                <label>
                  {t("studio.cocreate.lore.bindPersonaTarget")}
                  <select
                    value={effectivePersonaId}
                    onChange={(event) =>
                      setSelectedPersonaId(event.target.value)
                    }
                  >
                    {bindablePersonas.map((persona) => (
                      <option key={persona.id} value={persona.id}>
                        {persona.name}
                      </option>
                    ))}
                  </select>
                </label>
                {personaBinding.isPending ? (
                  <Skeleton lines={1} />
                ) : personaBinding.isError ? (
                  <ErrorNote
                    error={personaBinding.error}
                    title={t("studio.errors.loreBindingsLoad")}
                  />
                ) : personaBinding.data ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={personaBinding.data.lorebookIds.includes(
                        selectedBook.lorebook.id,
                      )}
                      disabled={pending}
                      onChange={(event) =>
                        onRun(() =>
                          replacePersonaLorebookBindings(
                            effectivePersonaId,
                            toggleBinding(
                              personaBinding.data.lorebookIds,
                              selectedBook.lorebook.id,
                              event.target.checked,
                            ),
                            personaBinding.data.version,
                          ),
                        )
                      }
                    />
                    {t("studio.cocreate.lore.bindPersona")}
                  </label>
                ) : null}
              </>
            ) : null}
          </section>
          <section className="cocreate__lore-entries">
            <header>
              <h4>{t("studio.cocreate.lore.entries")}</h4>
              <span>
                {t("studio.cocreate.lore.entryCount", {
                  count: selectedBook.entries.length,
                })}
              </span>
            </header>
            <details>
              <summary>
                <Plus size={12} />
                {t("studio.cocreate.lore.newEntry")}
              </summary>
              <LoreEntryForm
                key={"new:" + selectedBook.lorebook.id}
                lorebookId={selectedBook.lorebook.id}
                entry={null}
                pending={pending}
                onRun={onRun}
              />
            </details>
            {selectedBook.entries.map((entry) => (
              <details key={entry.id}>
                <summary>
                  <BookOpen size={12} />
                  {entry.title}
                </summary>
                <LoreEntryForm
                  lorebookId={selectedBook.lorebook.id}
                  entry={entry}
                  pending={pending}
                  onRun={onRun}
                />
              </details>
            ))}
          </section>
        </>
      ) : null}
    </section>
  );
}

function LorebookForm({
  projectId,
  detail,
  pending,
  onRun,
  onDeleted,
}: {
  projectId: string;
  detail: LorebookDetail | null;
  pending: boolean;
  onRun: (work: () => Promise<unknown>) => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(detail?.lorebook.name ?? "");
  const [description, setDescription] = useState(
    detail?.lorebook.description ?? "",
  );
  const [scanTurns, setScanTurns] = useState(
    String(detail?.lorebook.scanTurns ?? 24),
  );
  const [enabledGlobally, setEnabledGlobally] = useState(
    detail?.lorebook.enabledGlobally ?? false,
  );
  const [enabled, setEnabled] = useState(detail?.lorebook.enabled ?? true);
  return (
    <form
      className="cocreate__lore-form"
      onSubmit={(event) => {
        event.preventDefault();
        const input = {
          name: name.trim(),
          description: description.trim() || null,
          enabledGlobally,
          scanTurns: Number(scanTurns),
          enabled,
        };
        onRun(() =>
          detail
            ? updateLorebook(detail.lorebook.id, {
                ...input,
                expectedVersion: detail.lorebook.version,
              })
            : createLorebook(projectId, input),
        );
      }}
    >
      <label>
        {t("studio.cocreate.lore.name")}
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        {t("studio.cocreate.lore.description")}
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        {t("studio.cocreate.lore.scanTurns")}
        <input
          type="number"
          min={0}
          max={200}
          value={scanTurns}
          onChange={(event) => setScanTurns(event.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={enabledGlobally}
          onChange={(event) => setEnabledGlobally(event.target.checked)}
        />
        {t("studio.cocreate.lore.enabledGlobally")}
      </label>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("studio.cocreate.lore.enabled")}
      </label>
      <div className="cocreate__form-actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={pending || !name.trim()}
        >
          {detail
            ? t("studio.cocreate.lore.update")
            : t("studio.cocreate.lore.create")}
        </button>
        {detail ? (
          <button
            type="button"
            className="btn btn--danger"
            disabled={pending}
            onClick={() =>
              onRun(() =>
                deleteLorebook(
                  detail.lorebook.id,
                  detail.lorebook.version,
                ).then((result) => {
                  onDeleted();
                  return result;
                }),
              )
            }
          >
            <Trash2 size={12} />
            {t("studio.cocreate.lore.delete")}
          </button>
        ) : null}
      </div>
    </form>
  );
}

function LoreEntryForm({
  lorebookId,
  entry,
  pending,
  onRun,
}: {
  lorebookId: string;
  entry: LoreEntry | null;
  pending: boolean;
  onRun: (work: () => Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(entry?.title ?? "");
  const [content, setContent] = useState(entry?.content ?? "");
  const [keys, setKeys] = useState(entry?.keys.join("\n") ?? "");
  const [constant, setConstant] = useState(entry?.constant ?? false);
  const [priority, setPriority] = useState(String(entry?.priority ?? 0));
  const [enabled, setEnabled] = useState(entry?.enabled ?? true);
  const parsedKeys = keys
    .split(/[\n,，]/u)
    .map((key) => key.trim())
    .filter(Boolean);
  return (
    <form
      className="cocreate__lore-form"
      onSubmit={(event) => {
        event.preventDefault();
        const input = {
          title: title.trim(),
          content,
          keys: parsedKeys,
          constant,
          priority: Number(priority),
          enabled,
        };
        onRun(() =>
          entry
            ? updateLoreEntry(entry.id, {
                ...input,
                expectedVersion: entry.version,
              })
            : createLoreEntry(lorebookId, input),
        );
      }}
    >
      <label>
        {t("studio.cocreate.lore.entryTitle")}
        <input
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        {t("studio.cocreate.lore.content")}
        <textarea
          required
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>
      <label>
        {t("studio.cocreate.lore.keys")}
        <textarea
          value={keys}
          placeholder={t("studio.cocreate.lore.keysPlaceholder")}
          onChange={(event) => setKeys(event.target.value)}
        />
      </label>
      <label>
        {t("studio.cocreate.lore.priority")}
        <input
          type="number"
          min={-1_000_000}
          max={1_000_000}
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={constant}
          onChange={(event) => setConstant(event.target.checked)}
        />
        {t("studio.cocreate.lore.constant")}
      </label>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("studio.cocreate.lore.enabled")}
      </label>
      <div className="cocreate__form-actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={
            pending ||
            !title.trim() ||
            !content.trim() ||
            (!constant && parsedKeys.length === 0)
          }
        >
          {entry
            ? t("studio.cocreate.lore.updateEntry")
            : t("studio.cocreate.lore.createEntry")}
        </button>
        {entry ? (
          <button
            type="button"
            className="btn btn--danger"
            disabled={pending}
            onClick={() =>
              onRun(() => deleteLoreEntry(entry.id, entry.version))
            }
          >
            <Trash2 size={12} />
            {t("studio.cocreate.lore.deleteEntry")}
          </button>
        ) : null}
      </div>
    </form>
  );
}
