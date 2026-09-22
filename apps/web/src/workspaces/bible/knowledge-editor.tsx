import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  KnowledgeEditorDto,
  KnowledgeWrite,
  StoryStateSnapshotDto,
} from "@narralume/contracts";
import { useRef, useState } from "react";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { useI18n } from "../../i18n";
import { ApiError, getKnowledgeEditor, writeKnowledge } from "../../lib/api";
import { formatTime } from "../../lib/fmt";
import { projectWorkspacePath } from "../../lib/project-route";
import { Link } from "react-router";

type RecordDto = KnowledgeEditorDto["records"][number];
type Position = Pick<
  StoryStateSnapshotDto,
  "chapterId" | "audience" | "characterId"
>;
type Session = {
  base: KnowledgeEditorDto;
  action: KnowledgeWrite["action"];
  record: RecordDto | null;
};

export function KnowledgeEditor({
  projectId,
  snapshot,
}: {
  projectId: string;
  snapshot: Position;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Session | null>(null);
  const [saved, setSaved] = useState(false);
  const [filter, setFilter] = useState("");
  const queryKey = ["project", projectId, "bible", "knowledge"];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getKnowledgeEditor(projectId, signal),
    enabled: open,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const reload = useMutation({
    mutationFn: () => getKnowledgeEditor(projectId),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
      setEditing(null);
    },
  });
  // Freeze both references and version when the user opens the form. Refetches
  // must never silently rebase an in-progress change onto somebody else's work.
  const begin = (action: Session["action"], record: RecordDto | null) => {
    if (!query.data) return;
    setEditing({ base: query.data, action, record });
    setSaved(false);
    reload.reset();
  };
  const data = query.data;
  const labels = useKnowledgeLabels(data);
  const records =
    data?.records.filter(
      (record) => !filter || knowerValue(record) === filter,
    ) ?? [];
  return (
    <div className="knowledge-editor">
      {!open ? (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          {t("bible.knowledge.manage")}
        </button>
      ) : (
        <section aria-label={t("bible.knowledge.title")}>
          <div className="story-state__section-head">
            <h3>{t("bible.knowledge.title")}</h3>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={Boolean(editing)}
              onClick={() => setOpen(false)}
            >
              {t("common.action.close")}
            </button>
          </div>
          <p className="story-state__hint">{t("bible.knowledge.hint")}</p>
          {query.isPending ? (
            <Skeleton lines={4} />
          ) : !data ? (
            <ErrorNote
              error={query.error}
              title={t("bible.knowledge.loadError")}
            />
          ) : data ? (
            <>
              {query.isError ? (
                <ErrorNote
                  error={query.error}
                  title={t("bible.knowledge.loadError")}
                />
              ) : null}
              {saved ? <p role="status">{t("bible.knowledge.saved")}</p> : null}
              <button
                type="button"
                className="btn btn--primary"
                disabled={Boolean(editing) || !data.eligibleNodeIds.length}
                onClick={() => begin("register", null)}
              >
                {t("bible.knowledge.add")}
              </button>
              {!data.eligibleNodeIds.length ? (
                <p>{t("bible.knowledge.noNodes")}</p>
              ) : null}
              {editing ? (
                <KnowledgeForm
                  key={`${editing.base.version}:${editing.action}:${editing.record?.id ?? "new"}`}
                  projectId={projectId}
                  session={editing}
                  snapshot={snapshot}
                  reloading={reload.isPending}
                  reloadError={reload.error}
                  onReload={() => reload.mutate()}
                  onCancel={() => {
                    setEditing(null);
                    reload.reset();
                  }}
                  onSaved={() => {
                    setEditing(null);
                    setSaved(true);
                    void client.invalidateQueries({
                      queryKey: ["project", projectId, "bible"],
                    });
                  }}
                />
              ) : null}
              <details className="knowledge-editor__history" open={!editing}>
                <summary>
                  {t("bible.knowledge.history")} · {data.records.length}
                </summary>
                <label>
                  {t("bible.knowledge.filter")}
                  <select
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    <option value="">{t("bible.knowledge.allKnowers")}</option>
                    <option value="reader">{t("bible.state.reader")}</option>
                    {data.entities
                      .filter((entity) => entity.type === "character")
                      .map((entity) => (
                        <option
                          key={entity.id}
                          value={`character:${entity.id}`}
                        >
                          {entity.name}
                        </option>
                      ))}
                  </select>
                </label>
                {!records.length ? <p>{t("bible.knowledge.empty")}</p> : null}
                <div className="story-state__cards">
                  {[...records].reverse().map((record) => {
                    const correction = data.corrections.find(
                      (item) => item.recordId === record.id,
                    );
                    const replacement = data.records.find(
                      (item) => item.id === correction?.replacementRecordId,
                    );
                    const unavailable = !claimAvailable(data, record);
                    return (
                      <article
                        className="story-state__card"
                        key={record.id}
                        aria-label={`${labels.knower(record)} · ${labels.claim(record)}`}
                      >
                        <header>
                          <strong>{labels.knower(record)}</strong>
                          <span>
                            {t(
                              `bible.knowledge.${correction ? (correction.replacementRecordId ? "corrected" : "withdrawn") : "active"}`,
                            )}
                          </span>
                        </header>
                        <p>{labels.claim(record)}</p>
                        <p>
                          <span
                            className="story-state__belief"
                            data-belief={record.belief}
                          >
                            {t(`bible.state.beliefs.${record.belief}`)}
                          </span>
                        </p>
                        <p>
                          {t("bible.state.learnedAt")}{" "}
                          <NodeLink
                            projectId={projectId}
                            data={data}
                            id={record.learnedAtNodeId}
                          />
                        </p>
                        {unavailable ? (
                          <p>{t("bible.knowledge.unavailable")}</p>
                        ) : null}
                        <p className="story-state__hint">
                          {t(
                            record.sourceId === "manual"
                              ? "bible.knowledge.manual"
                              : "bible.knowledge.automatic",
                          )}{" "}
                          ·{" "}
                          {t("bible.knowledge.recorded", {
                            time: formatTime(record.createdAt),
                          })}
                        </p>
                        {correction ? (
                          <div className="knowledge-editor__revision">
                            <p>{correction.reason}</p>
                            {replacement ? (
                              <p>
                                {t("bible.knowledge.replacement", {
                                  belief: t(
                                    `bible.state.beliefs.${replacement.belief}`,
                                  ),
                                  node: labels.node(
                                    replacement.learnedAtNodeId,
                                  ),
                                })}
                              </p>
                            ) : null}
                            <p className="story-state__hint">
                              {t("bible.knowledge.revised", {
                                time: formatTime(correction.createdAt),
                              })}
                            </p>
                          </div>
                        ) : (
                          <div className="knowledge-editor__actions">
                            <button
                              type="button"
                              className="btn"
                              disabled={Boolean(editing) || unavailable}
                              onClick={() => begin("correct", record)}
                            >
                              {t("bible.knowledge.correct")}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={Boolean(editing)}
                              onClick={() => begin("withdraw", record)}
                            >
                              {t("bible.knowledge.withdraw")}
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </details>
            </>
          ) : null}
        </section>
      )}
    </div>
  );
}

function KnowledgeForm({
  projectId,
  session,
  snapshot,
  reloading,
  reloadError,
  onReload,
  onCancel,
  onSaved,
}: {
  projectId: string;
  session: Session;
  snapshot: Position;
  reloading: boolean;
  reloadError: unknown;
  onReload: () => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { base, action, record } = session;
  const labels = useKnowledgeLabels(base);
  const [knower, setKnower] = useState(
    record
      ? knowerValue(record)
      : snapshot.audience === "character"
        ? `character:${snapshot.characterId}`
        : "reader",
  );
  const [claim, setClaim] = useState(record ? claimValue(record) : "");
  const [belief, setBelief] = useState<RecordDto["belief"]>(
    record?.belief ?? "known",
  );
  const [node, setNode] = useState(
    record?.learnedAtNodeId ??
      (base.eligibleNodeIds.includes(snapshot.chapterId)
        ? snapshot.chapterId
        : ""),
  );
  const [reason, setReason] = useState("");
  const attempt = useRef<{ payload: string; id: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (input: KnowledgeWrite) => writeKnowledge(projectId, input),
    onSuccess: onSaved,
  });
  const busy = mutation.isPending || reloading;
  const conflict =
    mutation.error instanceof ApiError &&
    mutation.error.code === "knowledge.version_conflict";
  const submit = () => {
    const fields =
      action === "withdraw"
        ? { action, recordId: record!.id, reason }
        : action === "correct"
          ? {
              action,
              recordId: record!.id,
              belief,
              learnedAtNodeId: node,
              reason,
            }
          : {
              action,
              knowerType:
                knower === "reader"
                  ? ("reader" as const)
                  : ("character" as const),
              knowerEntityId:
                knower === "reader" ? null : knower.slice("character:".length),
              factId: claim.startsWith("fact:") ? claim.slice(5) : null,
              timelineEventId: claim.startsWith("event:")
                ? claim.slice(6)
                : null,
              belief,
              learnedAtNodeId: node,
            };
    const payload = JSON.stringify(fields);
    // Retrying after a lost response reuses the ID; editing the payload starts a
    // new attempt. Both remain tied to this form's original version.
    if (attempt.current?.payload !== payload)
      attempt.current = { payload, id: crypto.randomUUID() };
    mutation.mutate({
      ...fields,
      expectedVersion: base.version,
      requestId: attempt.current.id,
    });
  };
  return (
    <form
      className="knowledge-editor__form"
      aria-label={t(
        `bible.knowledge.${action === "register" ? "add" : action}`,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h4>{t(`bible.knowledge.${action === "register" ? "add" : action}`)}</h4>
      <p>
        {t(
          `bible.knowledge.${action === "register" ? "addHint" : action === "correct" ? "correctHint" : "withdrawHint"}`,
        )}
      </p>
      <fieldset disabled={busy}>
        {action === "register" ? (
          <>
            <label>
              {t("bible.knowledge.knower")}
              <select
                autoFocus
                value={knower}
                onChange={(event) => setKnower(event.target.value)}
                required
              >
                <option value="reader">{t("bible.state.reader")}</option>
                {base.entities
                  .filter((entity) => entity.type === "character")
                  .map((entity) => (
                    <option key={entity.id} value={`character:${entity.id}`}>
                      {entity.name}
                      {entity.status === "retired"
                        ? ` · ${t("bible.state.retired")}`
                        : ""}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {t("bible.knowledge.claim")}
              <select
                value={claim}
                onChange={(event) => setClaim(event.target.value)}
                required
              >
                <option value="">{t("bible.knowledge.chooseClaim")}</option>
                <optgroup label={t("bible.knowledge.facts")}>
                  {base.facts
                    .filter(
                      (fact) =>
                        fact.authority !== "candidate" &&
                        !base.withdrawnFactIds.includes(fact.id),
                    )
                    .map((fact) => (
                      <option key={fact.id} value={`fact:${fact.id}`}>
                        {labels.fact(fact)} ·{" "}
                        {labels.node(fact.validFromNodeId)}
                      </option>
                    ))}
                </optgroup>
                <optgroup label={t("bible.knowledge.events")}>
                  {base.timeline
                    .filter((event) => !base.voidedEventIds.includes(event.id))
                    .map((event) => (
                      <option key={event.id} value={`event:${event.id}`}>
                        {event.title} · {labels.node(event.outlineNodeId)}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
          </>
        ) : (
          <p>
            <strong>{labels.knower(record!)}</strong> · {labels.claim(record!)}
          </p>
        )}
        {action !== "withdraw" ? (
          <>
            <label>
              {t("bible.knowledge.belief")}
              <select
                autoFocus={action === "correct"}
                value={belief}
                onChange={(event) =>
                  setBelief(event.target.value as RecordDto["belief"])
                }
              >
                {(
                  ["known", "believed", "suspected", "false_belief"] as const
                ).map((value) => (
                  <option key={value} value={value}>
                    {t(`bible.state.beliefs.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("bible.knowledge.node")}
              <select
                required
                value={node}
                onChange={(event) => setNode(event.target.value)}
              >
                <option value="">{t("bible.knowledge.chooseNode")}</option>
                {node && !base.eligibleNodeIds.includes(node) ? (
                  <option value={node} disabled>
                    {labels.node(node)} · {t("bible.state.unavailableEvidence")}
                  </option>
                ) : null}
                {base.eligibleNodeIds.map((id) => (
                  <option key={id} value={id}>
                    {labels.node(id)}
                  </option>
                ))}
              </select>
            </label>
            <p className="story-state__hint">{t("bible.knowledge.nodeHint")}</p>
          </>
        ) : null}
        {action !== "register" ? (
          <label>
            {t("bible.knowledge.reason")}
            <textarea
              autoFocus={action === "withdraw"}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              maxLength={2000}
              rows={3}
            />
          </label>
        ) : null}
        <div className="knowledge-editor__actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={conflict || (action !== "register" && !reason.trim())}
          >
            {t(
              action === "withdraw"
                ? "bible.knowledge.withdraw"
                : "bible.knowledge.save",
            )}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            {t("common.action.cancel")}
          </button>
        </div>
      </fieldset>
      {mutation.error || reloadError ? (
        <>
          <ErrorNote
            error={reloadError ?? mutation.error}
            title={t("bible.knowledge.saveError")}
          />
          {conflict ? <p>{t("bible.knowledge.conflictHint")}</p> : null}
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onReload}
          >
            {t("bible.knowledge.reload")}
          </button>
        </>
      ) : null}
    </form>
  );
}

function useKnowledgeLabels(data: KnowledgeEditorDto | undefined) {
  const { t } = useI18n();
  const entity = (id: string) =>
    data?.entities.find((item) => item.id === id)?.name ?? id;
  const fact = (item: KnowledgeEditorDto["facts"][number]) =>
    `${entity(item.subjectId)} · ${item.predicate} · ${item.objectEntityId ? entity(item.objectEntityId) : typeof item.value === "string" ? item.value : JSON.stringify(item.value)}`;
  const node = (id: string | null) => {
    if (!id) return t("bible.state.noNode");
    const titles: string[] = [];
    let cursor = data?.outline.find((item) => item.id === id);
    if (!cursor) return t("bible.state.unavailableEvidence");
    while (cursor && cursor.kind !== "book") {
      titles.unshift(cursor.title);
      const parent: string | null = cursor.parentId;
      cursor = data?.outline.find((item) => item.id === parent);
    }
    return titles.join(" / ");
  };
  return {
    fact,
    node,
    knower: (record: RecordDto) =>
      record.knowerType === "reader"
        ? t("bible.state.reader")
        : entity(record.knowerEntityId!),
    claim: (record: RecordDto) => {
      const item = data?.facts.find((item) => item.id === record.factId);
      return item
        ? fact(item)
        : (data?.timeline.find((item) => item.id === record.timelineEventId)
            ?.title ?? t("bible.knowledge.unavailable"));
    },
  };
}

function NodeLink({
  projectId,
  data,
  id,
}: {
  projectId: string;
  data: KnowledgeEditorDto;
  id: string;
}) {
  const labels = useKnowledgeLabels(data);
  let chapter = data.outline.find((item) => item.id === id);
  while (chapter && chapter.kind !== "chapter") {
    const parent: string | null = chapter.parentId;
    chapter = data.outline.find((item) => item.id === parent);
  }
  return chapter ? (
    <Link
      to={`${projectWorkspacePath(projectId, "studio")}?outline=${encodeURIComponent(chapter.id)}`}
    >
      {labels.node(id)}
    </Link>
  ) : (
    <span>{labels.node(id)}</span>
  );
}
function knowerValue(record: RecordDto) {
  return record.knowerType === "reader"
    ? "reader"
    : `character:${record.knowerEntityId}`;
}
function claimValue(record: RecordDto) {
  return record.factId
    ? `fact:${record.factId}`
    : `event:${record.timelineEventId}`;
}
function claimAvailable(data: KnowledgeEditorDto, record: RecordDto) {
  return record.factId
    ? data.facts.some(
        (fact) => fact.id === record.factId && fact.authority !== "candidate",
      ) && !data.withdrawnFactIds.includes(record.factId)
    : data.timeline.some((event) => event.id === record.timelineEventId) &&
        !data.voidedEventIds.includes(record.timelineEventId!);
}
