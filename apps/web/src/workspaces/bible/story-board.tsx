import { useState } from "react";
import { outlineChapterSpan } from "@narralume/domain";
import { Link } from "react-router";
import { useI18n } from "../../i18n";
import type { OutlineNode, StoryBible } from "../../lib/api";
import { StructureActions } from "./structure-actions";
import { foreshadowStatusLabel, outlineStatusLabel } from "../../lib/labels";
import { projectWorkspacePath } from "../../lib/project-route";

/** This is a view of the manuscript outline, not a separate planning model. */
export function StoryBoard({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  const [status, setStatus] = useState("all");
  const [pov, setPov] = useState("all");
  const chapters = bible.outline.filter(
    (node) => node.kind === "chapter" && node.status !== "abandoned",
  );
  const byId = new Map(bible.outline.map((node) => [node.id, node]));
  const current =
    chapters.find((node) => ["drafting", "review"].includes(node.status)) ??
    chapters.find((node) => node.status === "planned");
  const visible = chapters.filter(
    (node) =>
      (status === "all" || node.status === status) &&
      (pov === "all" ||
        (pov === "unknown" ? !node.povEntityId : node.povEntityId === pov)),
  );
  const chapterLink = (id: string) =>
    `${projectWorkspacePath(bible.project.id, "studio")}?outline=${encodeURIComponent(id)}`;
  const span = (id: string | null) => outlineChapterSpan(bible.outline, id);
  const invertedClues = bible.foreshadows.filter((clue) => {
    const from = span(clue.targetFromNodeId),
      to = span(clue.targetToNodeId);
    return (
      !["resolved", "abandoned"].includes(clue.status) &&
      from &&
      to &&
      from[0] > to[1]
    );
  });
  const pathLabel = (chapter: OutlineNode) => {
    const titles: string[] = [];
    let parent = chapter.parentId ? byId.get(chapter.parentId) : undefined;
    while (parent) {
      if (["volume", "arc"].includes(parent.kind)) titles.unshift(parent.title);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return titles.join(" / ") || t("bible.board.noStructure");
  };
  const boundLabel = (id: string | null) =>
    (id ? byId.get(id)?.title : null) ?? t("bible.board.unknown");
  const unplaced = bible.foreshadows.filter(
    (clue) =>
      !clue.targetFromNodeId &&
      !clue.targetToNodeId &&
      !["resolved", "abandoned"].includes(clue.status),
  );
  return (
    <section className="story-board" aria-label={t("bible.board.title")}>
      <header>
        <h2>{t("bible.board.title")}</h2>
        <p>
          {t("bible.board.progress", {
            total: chapters.length,
            committed: chapters.filter((node) => node.status === "committed")
              .length,
          })}
        </p>
        <p>
          {current
            ? t("bible.board.current", { title: current.title })
            : t("bible.board.noCurrent")}
        </p>
      </header>
      <div className="story-board__filters">
        <label>
          {t("bible.board.status")}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">{t("bible.board.all")}</option>
            {(["planned", "drafting", "review", "committed"] as const).map(
              (value) => (
                <option key={value} value={value}>
                  {outlineStatusLabel(value)}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          {t("bible.board.pov")}
          <select value={pov} onChange={(event) => setPov(event.target.value)}>
            <option value="all">{t("bible.board.all")}</option>
            <option value="unknown">{t("bible.board.unknown")}</option>
            {bible.entities
              .filter((entity) => entity.type === "character")
              .map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p>{t("bible.board.reorderHint")}</p>
      {status !== "all" || pov !== "all" ? (
        <p>{t("bible.board.reorderFiltered")}</p>
      ) : null}
      {invertedClues.length ? (
        <aside
          className="story-board__window-warning"
          aria-label={t("bible.board.windowWarnings")}
        >
          <h3>{t("bible.board.windowWarnings")}</h3>
          <p>{t("bible.board.invertedWindow")}</p>
          <ul>
            {invertedClues.map((clue) => (
              <li key={clue.id}>
                {clue.title} ·{" "}
                {t("bible.board.window", {
                  from: boundLabel(clue.targetFromNodeId),
                  to: boundLabel(clue.targetToNodeId),
                })}
              </li>
            ))}
          </ul>
          <Link
            to={`${projectWorkspacePath(bible.project.id, "bible")}?spread=foreshadows`}
          >
            {t("bible.board.editWindows")}
          </Link>
        </aside>
      ) : null}
      {!chapters.length ? (
        <p>{t("bible.board.empty")}</p>
      ) : !visible.length ? (
        <p>{t("bible.board.noMatches")}</p>
      ) : null}
      <div className="story-board__cards">
        {visible.map((chapter) => {
          const index = chapters.indexOf(chapter);
          const clues = bible.foreshadows.filter((clue) => {
            const from = span(clue.targetFromNodeId),
              to = span(clue.targetToNodeId);
            const evidence = [
              ...clue.evidenceNodeIds,
              clue.resolutionNodeId,
            ].some((id) => {
              const range = span(id);
              return range && range[0] <= index && index <= range[1];
            });
            return (
              evidence ||
              ((from !== null || to !== null) &&
                index >= (from?.[0] ?? 0) &&
                index <= (to?.[1] ?? chapters.length - 1))
            );
          });
          return (
            <article
              className="story-board__card"
              key={chapter.id}
              data-current={chapter.id === current?.id ? "true" : undefined}
            >
              <p className="story-board__path">{pathLabel(chapter)}</p>
              <h3>{chapter.title}</h3>
              <StructureActions
                bible={bible}
                chapter={chapter}
                filtered={status !== "all" || pov !== "all"}
              />
              <p>
                {outlineStatusLabel(chapter.status)} ·{" "}
                {t("bible.board.povValue", {
                  name:
                    bible.entities.find(
                      (entity) => entity.id === chapter.povEntityId,
                    )?.name ?? t("bible.board.unknown"),
                })}
              </p>
              <p>{chapter.summary || t("bible.board.noSummary")}</p>
              <dl>
                {(["goal", "conflict", "outcome"] as const).map((field) => (
                  <div key={field}>
                    <dt>{t(`bible.board.${field}`)}</dt>
                    <dd>{chapter[field] || t("bible.board.unknown")}</dd>
                  </div>
                ))}
              </dl>
              <Link className="btn" to={chapterLink(chapter.id)}>
                {t("bible.board.openChapter")}
              </Link>
              {clues.length ? (
                <details>
                  <summary>
                    {t("bible.board.clues", { count: clues.length })}
                  </summary>
                  <ul>
                    {clues.map((clue) => (
                      <li key={clue.id}>
                        <strong>{clue.title}</strong> ·{" "}
                        {foreshadowStatusLabel(clue.status)}
                        <p>
                          {t("bible.board.window", {
                            from: boundLabel(clue.targetFromNodeId),
                            to: boundLabel(clue.targetToNodeId),
                          })}
                        </p>
                        {clue.evidenceNodeIds.length ? (
                          <div className="story-board__evidence">
                            {t("bible.board.evidence")}
                            {clue.evidenceNodeIds.map((id) => {
                              const range = span(id);
                              return range ? (
                                <Link
                                  key={id}
                                  to={chapterLink(chapters[range[0]]!.id)}
                                >
                                  {boundLabel(id)}
                                </Link>
                              ) : (
                                <span key={id}>{t("bible.board.unknown")}</span>
                              );
                            })}
                          </div>
                        ) : (
                          <p>{t("bible.board.noEvidence")}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : (
                <p>{t("bible.board.noClues")}</p>
              )}
            </article>
          );
        })}
      </div>
      {unplaced.length ? (
        <details>
          <summary>{t("bible.board.unplacedClues")}</summary>
          <ul>
            {unplaced.map((clue) => (
              <li key={clue.id}>
                {clue.title} · {foreshadowStatusLabel(clue.status)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
