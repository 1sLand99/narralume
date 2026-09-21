import "../../styles/story-state.css";
import { useQuery } from "@tanstack/react-query";
import type {
  StoryStateQuery,
  StoryStateSnapshotDto,
} from "@narralume/contracts";
import { Link, useSearchParams } from "react-router";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { useI18n } from "../../i18n";
import { getStoryState, type StoryBible } from "../../lib/api";
import {
  factAuthorityLabel,
  foreshadowStatusLabel,
  outlineStatusLabel,
} from "../../lib/labels";
import { projectWorkspacePath } from "../../lib/project-route";

export function StoryState({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const nodes = new Map(bible.outline.map((node) => [node.id, node]));
  const chapters = bible.outline.filter((node) => {
    if (node.kind !== "chapter") return false;
    let cursor = nodes.get(node.id);
    while (cursor) {
      if (cursor.status === "abandoned") return false;
      cursor = cursor.parentId ? nodes.get(cursor.parentId) : undefined;
    }
    return true;
  });
  const chapterId =
    params.get("chapter") ??
    chapters.findLast((node) => node.status === "committed")?.id ??
    chapters[0]?.id ??
    "";
  const audience =
    params.get("audience") === "character"
      ? "character"
      : params.get("audience") === "reader"
        ? "reader"
        : "author";
  const input: StoryStateQuery =
    audience === "character"
      ? { chapterId, audience, characterId: params.get("character") ?? "" }
      : { chapterId, audience };
  const query = useQuery({
    queryKey: ["project", bible.project.id, "bible", "story-state", input],
    queryFn: ({ signal }) => getStoryState(bible.project.id, input, signal),
    enabled: Boolean(chapterId),
    staleTime: 0,
  });
  const entities = query.data?.entities ?? bible.entities;
  const characters = entities.filter((entity) => entity.type === "character");
  const view =
    audience === "character"
      ? `character:${input.audience === "character" ? input.characterId : ""}`
      : audience;
  const chapter = nodes.get(chapterId);
  const pathLabel = (id: string) => {
    const titles: string[] = [];
    let cursor = nodes.get(id);
    while (cursor && cursor.kind !== "book") {
      titles.unshift(cursor.title);
      cursor = cursor.parentId ? nodes.get(cursor.parentId) : undefined;
    }
    return titles.join(" / ");
  };
  const change = (field: "chapter" | "view", value: string) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("chapter", field === "chapter" ? value : chapterId);
      if (field === "view") {
        next.set(
          "audience",
          value.startsWith("character:") ? "character" : value,
        );
        if (value.startsWith("character:"))
          next.set("character", value.slice("character:".length));
        else next.delete("character");
      }
      return next;
    });
  };
  return (
    <section className="story-state" aria-label={t("bible.state.title")}>
      <header>
        <h2>{t("bible.state.title")}</h2>
        <p>{t("bible.state.hint")}</p>
      </header>
      {!chapters.length ? (
        <p>{t("bible.state.noChapters")}</p>
      ) : (
        <>
          <div className="story-state__filters">
            <label>
              {t("bible.state.chapter")}
              <select
                value={chapterId}
                onChange={(event) => change("chapter", event.target.value)}
              >
                {!chapters.some((node) => node.id === chapterId) ? (
                  <option value={chapterId}>
                    {t("bible.state.unavailableChapter")}
                  </option>
                ) : null}
                {chapters.map((node) => (
                  <option key={node.id} value={node.id}>
                    {pathLabel(node.id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("bible.state.audience")}
              <select
                value={view}
                onChange={(event) => change("view", event.target.value)}
              >
                <option value="author">{t("bible.state.author")}</option>
                <option value="reader">{t("bible.state.reader")}</option>
                {audience === "character" &&
                !characters.some(
                  (entity) => `character:${entity.id}` === view,
                ) ? (
                  <option value={view}>
                    {t("bible.state.unavailableCharacter")}
                  </option>
                ) : null}
                {characters.map((entity) => (
                  <option key={entity.id} value={`character:${entity.id}`}>
                    {t("bible.state.character", { name: entity.name })}
                    {entity.status === "retired"
                      ? ` · ${t("bible.state.retired")}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {chapter ? (
            <p className="story-state__position">
              {t("bible.state.position", { title: chapter.title })} ·{" "}
              {outlineStatusLabel(chapter.status)}
            </p>
          ) : null}
          {query.isPending ? (
            <Skeleton lines={6} />
          ) : query.isError ? (
            <ErrorNote error={query.error} title={t("bible.state.loadError")} />
          ) : (
            <StateRecords bible={bible} snapshot={query.data} />
          )}
        </>
      )}
    </section>
  );
}

function StateRecords({
  bible,
  snapshot,
}: {
  bible: StoryBible;
  snapshot: StoryStateSnapshotDto;
}) {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const entityName = (id: string) =>
    snapshot.entities.find((entity) => entity.id === id)?.name ?? id;
  const editLink = (spread: string) => {
    const next = new URLSearchParams(params);
    next.set("spread", spread);
    next.set("chapter", snapshot.chapterId);
    return `${projectWorkspacePath(bible.project.id, "bible")}?${next}`;
  };
  const factText = (fact: StoryStateSnapshotDto["facts"][number]) =>
    `${entityName(fact.subjectId)} · ${fact.predicate} · ${fact.objectEntityId ? entityName(fact.objectEntityId) : typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value)}`;
  return (
    <>
      <section aria-label={t("bible.state.knowledge")}>
        <h3>
          {t("bible.state.knowledge")}{" "}
          <span className="story-state__count">
            {snapshot.knowledge.length}
          </span>
        </h3>
        <p className="story-state__hint">{t("bible.state.knowledgeHint")}</p>
        {!snapshot.knowledge.length ? (
          <p className="story-state__empty">{t("bible.state.noKnowledge")}</p>
        ) : null}
        <div className="story-state__cards">
          {snapshot.knowledge.map(({ record, fact, event }) => (
            <article
              key={record.id}
              className="story-state__card"
              aria-label={t("bible.state.knowledgeOf", {
                name:
                  record.knowerType === "reader"
                    ? t("bible.state.reader")
                    : entityName(record.knowerEntityId!),
              })}
            >
              <header>
                <strong>
                  {record.knowerType === "reader"
                    ? t("bible.state.reader")
                    : entityName(record.knowerEntityId!)}
                </strong>
                <span
                  className="story-state__belief"
                  data-belief={record.belief}
                >
                  {t(`bible.state.beliefs.${record.belief}`)}
                </span>
              </header>
              <p>{fact ? factText(fact) : event?.title}</p>
              {record.belief === "false_belief" ? (
                <p className="story-state__hint">
                  {t("bible.state.falseBeliefHint")}
                </p>
              ) : null}
              <div className="story-state__evidence">
                {t("bible.state.learnedAt")}{" "}
                <EvidenceLink bible={bible} id={record.learnedAtNodeId} />
              </div>
            </article>
          ))}
        </div>
      </section>
      <section aria-label={t("bible.state.relationships")}>
        <div className="story-state__section-head">
          <h3>
            {t("bible.state.relationships")}{" "}
            <span className="story-state__count">
              {snapshot.relationships.length}
            </span>
          </h3>
          <Link to={editLink("relations")}>
            {t("bible.state.editRelationships")}
          </Link>
        </div>
        <p className="story-state__hint">
          {t("bible.state.relationshipsHint")}
        </p>
        {!snapshot.relationships.length ? (
          <p className="story-state__empty">
            {t("bible.state.noRelationships")}
          </p>
        ) : null}
        <div className="story-state__cards">
          {snapshot.relationships.map((item) => (
            <article key={item.id} className="story-state__card">
              <strong>
                {entityName(item.fromEntityId)} → {entityName(item.toEntityId)}
              </strong>
              <p>
                {item.relation}
                {item.intensity === null
                  ? ""
                  : ` · ${t("bible.state.intensity", { value: item.intensity })}`}
              </p>
              <div className="story-state__evidence">
                {t("bible.state.recordedAt")}{" "}
                <EvidenceLink bible={bible} id={item.outlineNodeId} />
              </div>
            </article>
          ))}
        </div>
      </section>
      {snapshot.audience === "author" ? (
        <section aria-label={t("bible.state.foreshadows")}>
          <div className="story-state__section-head">
            <h3>
              {t("bible.state.foreshadows")}{" "}
              <span className="story-state__count">
                {snapshot.foreshadows.length}
              </span>
            </h3>
            <Link to={editLink("foreshadows")}>
              {t("bible.state.editForeshadows")}
            </Link>
          </div>
          <p className="story-state__hint">
            {t("bible.state.foreshadowsHint")}
          </p>
          {!snapshot.foreshadows.length ? (
            <p className="story-state__empty">
              {t("bible.state.noForeshadows")}
            </p>
          ) : null}
          <div className="story-state__cards">
            {snapshot.foreshadows.map((item) => (
              <article
                key={item.id}
                className="story-state__card"
                aria-label={item.title}
              >
                <strong>{item.title}</strong>
                <p>{item.description}</p>
                <p>
                  {t("bible.state.currentPlan")}{" "}
                  {foreshadowStatusLabel(item.currentStatus)}
                </p>
                <div className="story-state__evidence">
                  {t("bible.state.evidence")}
                  {!item.evidenceNodeIds.length ? (
                    <span>{t("bible.state.noEvidence")}</span>
                  ) : (
                    item.evidenceNodeIds.map((id) => (
                      <EvidenceLink key={id} bible={bible} id={id} />
                    ))
                  )}
                </div>
                <div className="story-state__evidence">
                  {t("bible.state.resolution")}
                  {item.resolutionNodeId ? (
                    <EvidenceLink bible={bible} id={item.resolutionNodeId} />
                  ) : (
                    <span>{t("bible.state.noResolution")}</span>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <p className="story-state__hint">
          {t("bible.state.authorPlansHidden")}
        </p>
      )}
      <details className="story-state__reference">
        <summary>
          {t("bible.state.reference", {
            facts: snapshot.facts.length,
            events: snapshot.timeline.length,
          })}
        </summary>
        <p className="story-state__hint">{t("bible.state.referenceHint")}</p>
        <div className="story-state__section-head">
          <h3>{t("bible.state.facts")}</h3>
          <Link to={editLink("facts")}>{t("bible.state.editFacts")}</Link>
        </div>
        {!snapshot.facts.length ? <p>{t("bible.state.noFacts")}</p> : null}
        <ul className="story-state__reference-list">
          {snapshot.facts.map((fact) => (
            <li key={fact.id}>
              <p>
                {factText(fact)} · {factAuthorityLabel(fact.authority)}
              </p>
              <div className="story-state__evidence">
                {t("bible.state.validFrom")}{" "}
                <EvidenceLink bible={bible} id={fact.validFromNodeId} />
              </div>
            </li>
          ))}
        </ul>
        <div className="story-state__section-head">
          <h3>{t("bible.state.events")}</h3>
          <Link to={editLink("timeline")}>{t("bible.state.editEvents")}</Link>
        </div>
        {!snapshot.timeline.length ? <p>{t("bible.state.noEvents")}</p> : null}
        <ul className="story-state__reference-list">
          {snapshot.timeline.map((event) => (
            <li key={event.id}>
              <strong>{event.title}</strong>
              {event.description ? <p>{event.description}</p> : null}
              <div className="story-state__evidence">
                {t("bible.state.recordedAt")}{" "}
                <EvidenceLink bible={bible} id={event.outlineNodeId} />
              </div>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function EvidenceLink({ bible, id }: { bible: StoryBible; id: string | null }) {
  const { t } = useI18n();
  if (!id) return <span>{t("bible.state.noNode")}</span>;
  const nodes = new Map(bible.outline.map((node) => [node.id, node]));
  const node = nodes.get(id);
  if (!node || node.status === "abandoned")
    return <span>{t("bible.state.unavailableEvidence")}</span>;
  let chapter = node;
  while (
    chapter.kind !== "chapter" &&
    chapter.parentId &&
    nodes.has(chapter.parentId)
  )
    chapter = nodes.get(chapter.parentId)!;
  const label =
    node.id === chapter.id || chapter.kind !== "chapter"
      ? node.title
      : `${chapter.title} / ${node.title}`;
  return (
    <span>
      {chapter.kind === "chapter" ? (
        <Link
          to={`${projectWorkspacePath(bible.project.id, "studio")}?outline=${encodeURIComponent(chapter.id)}`}
        >
          {label}
        </Link>
      ) : (
        label
      )}{" "}
      · {outlineStatusLabel(chapter.status)}
    </span>
  );
}
