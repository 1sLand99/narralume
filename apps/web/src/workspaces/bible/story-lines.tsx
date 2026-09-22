import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StoryLineProposals } from "./story-line-proposals";
import { Link } from "react-router";

import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { useI18n } from "../../i18n";
import {
  getStoryCompass,
  getStoryDevelopmentReviews,
  updateStoryCompass,
  type StoryBible,
  type StoryCompass,
  type StoryLongLine,
} from "../../lib/api";
import { formatTime } from "../../lib/fmt";
import { projectWorkspacePath } from "../../lib/project-route";

type EditSession = { compass: StoryCompass; index: number | null };
const STATUSES = ["open", "developing", "resolved"] as const;

export function StoryLines({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  const projectId = bible.project.id;
  const queryClient = useQueryClient();
  const queryKey = ["project", projectId, "compass"];
  const compassQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => getStoryCompass(projectId, signal),
  });
  const reviewsQuery = useQuery({
    queryKey: ["project", projectId, "compass", "reviews"],
    queryFn: ({ signal }) => getStoryDevelopmentReviews(projectId, signal),
  });
  // Capture the complete aggregate and its version when editing begins.
  const [editing, setEditing] = useState<EditSession | null>(null);
  const [removing, setRemoving] = useState<EditSession | null>(null);
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: ({
      base,
      lines,
    }: {
      base: StoryCompass;
      lines: StoryLongLine[];
    }) => {
      const { projectId: _id, version, updatedAt: _time, ...fields } = base;
      void _id;
      void _time;
      return updateStoryCompass(projectId, {
        ...fields,
        longLines: lines,
        expectedVersion: version,
      });
    },
    onSuccess: (compass) => {
      queryClient.setQueryData(queryKey, compass);
      setEditing(null);
      setRemoving(null);
      setSaved(true);
    },
  });
  const reload = useMutation({
    mutationFn: () => getStoryCompass(projectId),
    onSuccess: (compass) => {
      queryClient.setQueryData(queryKey, compass);
      setEditing(null);
      setRemoving(null);
      mutation.reset();
    },
  });
  const compass = compassQuery.data;
  const nodes = new Map(bible.outline.map((node) => [node.id, node]));
  const isActive = (id: string) => {
    let node = nodes.get(id);
    if (!node) return false;
    while (node) {
      if (node.status === "abandoned") return false;
      node = node.parentId ? nodes.get(node.parentId) : undefined;
    }
    return true;
  };
  const scopeLabel = (id: string | null | undefined) => {
    if (!id) return t("bible.lines.wholeBook");
    const names: string[] = [];
    let node = nodes.get(id);
    if (!node || !isActive(id)) return t("bible.lines.unavailableScope");
    while (node && node.kind !== "book") {
      names.unshift(node.title);
      node = node.parentId ? nodes.get(node.parentId) : undefined;
    }
    return names.join(" / ");
  };
  const begin = (index: number | null) => {
    if (!compass) return;
    mutation.reset();
    reload.reset();
    setSaved(false);
    setEditing({ compass, index });
  };
  const busy = mutation.isPending || reload.isPending;
  return (
    <section className="story-lines" aria-label={t("bible.lines.title")}>
      <header className="story-lines__head">
        <div>
          <h2>{t("bible.lines.title")}</h2>
          <p>{t("bible.lines.hint")}</p>
        </div>
        {compass ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={Boolean(editing || removing) || busy}
            onClick={() => begin(null)}
          >
            {t("bible.lines.add")}
          </button>
        ) : null}
      </header>
      {compassQuery.isPending ? (
        <Skeleton lines={4} />
      ) : compassQuery.isError ? (
        <ErrorNote
          error={compassQuery.error}
          title={t("bible.lines.loadError")}
        />
      ) : !compass ? (
        <p>{t("bible.lines.needCompass")}</p>
      ) : (
        <>
          <p className="story-lines__promise">
            <strong>{t("bible.lines.corePromise")}</strong>{" "}
            {compass.corePromise}
          </p>
          {saved ? <p role="status">{t("bible.lines.saved")}</p> : null}
          {editing ? (
            <StoryLineForm
              key={`${editing.compass.version}:${editing.index ?? "new"}`}
              bible={bible}
              line={
                editing.index === null
                  ? null
                  : editing.compass.longLines[editing.index]!
              }
              scopeLabel={scopeLabel}
              pending={busy}
              error={mutation.error ?? reload.error}
              onReload={() => reload.mutate()}
              onCancel={() => {
                setEditing(null);
                mutation.reset();
              }}
              onSave={(line) =>
                mutation.mutate({
                  base: editing.compass,
                  lines:
                    editing.index === null
                      ? [...editing.compass.longLines, line]
                      : editing.compass.longLines.map((current, index) =>
                          index === editing.index ? line : current,
                        ),
                })
              }
            />
          ) : null}
          {compass.longLines.length === 0 && !editing ? (
            <p>{t("bible.lines.empty")}</p>
          ) : null}
          <div className="story-lines__grid">
            {compass.longLines.map((line, index) => (
              <article
                className="story-line"
                key={index}
                aria-labelledby={`story-line-${index}`}
              >
                <p className="story-line__scope">
                  {scopeLabel(line.development?.scopeNodeId)}
                </p>
                <header>
                  <h3 id={`story-line-${index}`}>{line.title}</h3>
                  <span>{t(`bible.lines.statuses.${line.status}`)}</span>
                </header>
                <dl>
                  <div>
                    <dt>{t("bible.lines.promise")}</dt>
                    <dd>{line.promise}</dd>
                  </div>
                  {(["stageGoal", "progress"] as const).map((field) => (
                    <div key={field}>
                      <dt>{t(`bible.lines.${field}`)}</dt>
                      <dd>
                        {line.development?.[field] ||
                          t("bible.lines.notRecorded")}
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>{t("bible.lines.openPromises")}</dt>
                    <dd>
                      {line.development?.openPromises.length ? (
                        <ul>
                          {line.development.openPromises.map((promise, i) => (
                            <li key={i}>{promise}</li>
                          ))}
                        </ul>
                      ) : (
                        t("bible.lines.notRecorded")
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("bible.lines.nextDevelopment")}</dt>
                    <dd>
                      {line.development?.nextDevelopment ||
                        t("bible.lines.notRecorded")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("bible.lines.evidence")}</dt>
                    <dd>
                      {line.development?.evidenceChapterIds.length ? (
                        <ul>
                          {line.development.evidenceChapterIds.map((id) => (
                            <li key={id}>
                              {nodes.has(id) ? (
                                <>
                                  <Link
                                    to={`${projectWorkspacePath(projectId, "studio")}?outline=${encodeURIComponent(id)}`}
                                  >
                                    {nodes.get(id)!.title}
                                  </Link>
                                  {nodes.get(id)!.status !== "committed" ||
                                  !isActive(id) ? (
                                    <p>
                                      {t("bible.lines.unavailableEvidence")}
                                    </p>
                                  ) : null}
                                </>
                              ) : (
                                t("bible.lines.unavailableEvidence")
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        t("bible.lines.noEvidence")
                      )}
                    </dd>
                  </div>
                </dl>
                <div className="story-lines__actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={Boolean(editing || removing) || busy}
                    aria-label={t("bible.lines.editNamed", {
                      title: line.title,
                    })}
                    onClick={() => begin(index)}
                  >
                    {t("bible.lines.edit")}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={Boolean(editing || removing) || busy}
                    aria-label={t("bible.lines.removeNamed", {
                      title: line.title,
                    })}
                    onClick={() => {
                      mutation.reset();
                      reload.reset();
                      setSaved(false);
                      setRemoving({ compass, index });
                    }}
                  >
                    {t("bible.lines.remove")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      <Link
        className="story-lines__compass-link"
        to={projectWorkspacePath(projectId, "autopilot")}
      >
        {t("bible.lines.editCompass")}
      </Link>
      <StoryLineProposals bible={bible} />
      <aside
        className="story-lines__reviews"
        aria-label={t("bible.lines.reviews")}
      >
        <h3>{t("bible.lines.reviews")}</h3>
        <p>{t("bible.lines.reviewsHint")}</p>
        {reviewsQuery.isPending ? (
          <Skeleton lines={2} />
        ) : reviewsQuery.isError ? (
          <ErrorNote
            error={reviewsQuery.error}
            title={t("bible.lines.reviewsError")}
          />
        ) : reviewsQuery.data?.length ? (
          reviewsQuery.data.map((review) => (
            <details key={review.id}>
              <summary>
                {scopeLabel(review.outlineNodeId)} ·{" "}
                {formatTime(review.createdAt)}
              </summary>
              <p>{review.summary}</p>
              {(["recommendations", "compassAdjustments"] as const).map(
                (field) =>
                  review[field].length ? (
                    <div key={field}>
                      <h4>{t(`bible.lines.${field}`)}</h4>
                      <ul>
                        {review[field].map((text, index) => (
                          <li key={index}>{text}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null,
              )}
            </details>
          ))
        ) : (
          <p>{t("bible.lines.noReviews")}</p>
        )}
      </aside>
      {removing ? (
        <ConfirmDialog
          title={t("bible.lines.removeTitle")}
          confirmLabel={t("bible.lines.remove")}
          danger
          pending={busy}
          onCancel={() => {
            setRemoving(null);
            mutation.reset();
          }}
          onConfirm={() =>
            mutation.mutate({
              base: removing.compass,
              lines: removing.compass.longLines.filter(
                (_, index) => index !== removing.index,
              ),
            })
          }
        >
          <p>
            {t("bible.lines.removeHint", {
              title: removing.compass.longLines[removing.index!]!.title,
            })}
          </p>
          {mutation.error || reload.error ? (
            <>
              <ErrorNote
                error={mutation.error ?? reload.error}
                title={t("bible.lines.saveError")}
              />
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => reload.mutate()}
              >
                {t("bible.lines.reload")}
              </button>
            </>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function StoryLineForm({
  bible,
  line,
  scopeLabel,
  pending,
  error,
  onCancel,
  onSave,
  onReload,
}: {
  bible: StoryBible;
  line: StoryLongLine | null;
  scopeLabel: (id: string | null) => string;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSave: (line: StoryLongLine) => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(line?.title ?? "");
  const [promise, setPromise] = useState(line?.promise ?? "");
  const [status, setStatus] = useState<StoryLongLine["status"]>(
    line?.status ?? "open",
  );
  const [scope, setScope] = useState(line?.development?.scopeNodeId ?? "");
  const [goal, setGoal] = useState(line?.development?.stageGoal ?? "");
  const [progress, setProgress] = useState(line?.development?.progress ?? "");
  const [openPromises, setOpenPromises] = useState(
    line?.development?.openPromises.join("\n") ?? "",
  );
  const [next, setNext] = useState(line?.development?.nextDevelopment ?? "");
  const [evidence, setEvidence] = useState(
    line?.development?.evidenceChapterIds ?? [],
  );
  const activeNodes = bible.outline.filter((node) => {
    let current: typeof node | undefined = node;
    while (current) {
      if (current.status === "abandoned") return false;
      current = bible.outline.find((parent) => parent.id === current!.parentId);
    }
    return true;
  });
  const scopes = activeNodes.filter(
    (node) => node.kind === "volume" || node.kind === "arc",
  );
  const chapters = activeNodes.filter(
    (node) => node.kind === "chapter" && node.status === "committed",
  );
  return (
    <form
      className="story-line-form"
      aria-label={t(line ? "bible.lines.edit" : "bible.lines.add")}
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          title: title.trim(),
          promise: promise.trim(),
          status,
          development: {
            scopeNodeId: scope || null,
            stageGoal: goal.trim(),
            progress: progress.trim(),
            openPromises: openPromises
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean),
            nextDevelopment: next.trim(),
            evidenceChapterIds: evidence,
          },
        });
      }}
    >
      <h3>{t(line ? "bible.lines.edit" : "bible.lines.add")}</h3>
      <fieldset disabled={pending}>
        <div className="story-line-form__fields">
          <label>
            {t("bible.lines.name")}
            <input
              value={title}
              required
              maxLength={300}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            {t("bible.lines.status")}
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as StoryLongLine["status"])
              }
            >
              {STATUSES.map((value) => (
                <option value={value} key={value}>
                  {t(`bible.lines.statuses.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("bible.lines.promise")}
            <textarea
              value={promise}
              required
              maxLength={4_000}
              onChange={(event) => setPromise(event.target.value)}
            />
          </label>
          <label>
            {t("bible.lines.scope")}
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="">{t("bible.lines.wholeBook")}</option>
              {scope && !scopes.some((node) => node.id === scope) ? (
                <option value={scope}>
                  {t("bible.lines.unavailableScope")}
                </option>
              ) : null}
              {scopes.map((node) => (
                <option value={node.id} key={node.id}>
                  {scopeLabel(node.id)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("bible.lines.stageGoal")}
            <textarea
              value={goal}
              maxLength={4_000}
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
          <label>
            {t("bible.lines.progress")}
            <textarea
              value={progress}
              maxLength={4_000}
              onChange={(event) => setProgress(event.target.value)}
            />
          </label>
          <label>
            {t("bible.lines.openPromises")}
            <textarea
              value={openPromises}
              onChange={(event) => setOpenPromises(event.target.value)}
            />
            <small>{t("bible.lines.onePerLine")}</small>
          </label>
          <label>
            {t("bible.lines.nextDevelopment")}
            <textarea
              value={next}
              maxLength={4_000}
              onChange={(event) => setNext(event.target.value)}
            />
          </label>
        </div>
        <fieldset className="story-line-form__evidence">
          <legend>{t("bible.lines.evidence")}</legend>
          <p>{t("bible.lines.evidenceHint")}</p>
          {chapters.length === 0 ? (
            <p>{t("bible.lines.noCommittedChapters")}</p>
          ) : null}
          {chapters.map((chapter) => (
            <label key={chapter.id}>
              <input
                type="checkbox"
                checked={evidence.includes(chapter.id)}
                onChange={(event) =>
                  setEvidence(
                    event.target.checked
                      ? [...evidence, chapter.id]
                      : evidence.filter((id) => id !== chapter.id),
                  )
                }
              />
              {chapter.title}
            </label>
          ))}
          {evidence
            .filter((id) => !chapters.some((node) => node.id === id))
            .map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked
                  onChange={() =>
                    setEvidence(evidence.filter((item) => item !== id))
                  }
                />
                {t("bible.lines.unavailableEvidence")}
              </label>
            ))}
        </fieldset>
      </fieldset>
      {error ? (
        <>
          <ErrorNote error={error} title={t("bible.lines.saveError")} />
          <button
            className="btn"
            type="button"
            disabled={pending}
            onClick={onReload}
          >
            {t("bible.lines.reload")}
          </button>
        </>
      ) : null}
      <div className="story-lines__actions">
        <button
          className="btn btn--primary"
          type="submit"
          disabled={pending || !title.trim() || !promise.trim()}
        >
          {t(pending ? "common.state.saving" : "bible.lines.save")}
        </button>
        <button
          className="btn"
          type="button"
          disabled={pending}
          onClick={onCancel}
        >
          {t("common.action.cancel")}
        </button>
      </div>
    </form>
  );
}
