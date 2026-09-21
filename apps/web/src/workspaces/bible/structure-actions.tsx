import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { movablePlannedChapterIds } from "@narralume/domain";
import { Link } from "react-router";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorNote } from "../../components/error-note";
import { useI18n } from "../../i18n";
import {
  applyOutlineChange,
  previewOutlineChange,
  type OutlineChangeRequest,
  type OutlineNode,
  type StoryBible,
} from "../../lib/api";
import { projectWorkspacePath } from "../../lib/project-route";

export function StructureActions({
  bible,
  chapter,
  filtered,
}: {
  bible: StoryBible;
  chapter: OutlineNode;
  filtered: boolean;
}) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<{
    change: OutlineChangeRequest | null;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const siblings = bible.outline.filter(
    (node) => node.parentId === chapter.parentId,
  );
  const index = siblings.findIndex((node) => node.id === chapter.id);
  const movable = movablePlannedChapterIds(
    bible.outline,
    bible.occupiedOutlineNodeIds,
  );
  if (!movable.has(chapter.id)) return null;
  const open = (change: OutlineChangeRequest | null) => {
    setSaved(false);
    setDialog({ change });
  };
  return (
    <>
      <div className="story-board__filters">
        {([-1, 1] as const).map((direction) => {
          const other = siblings[index + direction];
          return (
            <button
              type="button"
              className="btn"
              key={direction}
              disabled={filtered || !other || !movable.has(other.id)}
              aria-label={t(
                direction === -1
                  ? "bible.board.moveEarlierLabel"
                  : "bible.board.moveLaterLabel",
                { title: chapter.title },
              )}
              onClick={() => {
                if (!other || !chapter.parentId) return;
                const nodes = [...siblings];
                nodes[index] = other;
                nodes[index + direction] = chapter;
                open({
                  kind: "reorder",
                  parentId: chapter.parentId,
                  nodes: nodes.map((node) => ({
                    id: node.id,
                    expectedUpdatedAt: node.updatedAt,
                  })),
                });
              }}
            >
              {t(
                direction === -1
                  ? "bible.board.moveEarlier"
                  : "bible.board.moveLater",
              )}
            </button>
          );
        })}
        <button
          type="button"
          className="btn"
          disabled={filtered}
          aria-label={t("bible.board.moveToLabel", { title: chapter.title })}
          onClick={() => open(null)}
        >
          {t("bible.board.moveTo")}
        </button>
      </div>
      {saved ? <p role="status">{t("bible.board.reorderSaved")}</p> : null}
      {dialog ? (
        <StructureChangeDialog
          bible={bible}
          chapter={chapter}
          initialChange={dialog.change}
          onCancel={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setSaved(true);
          }}
        />
      ) : null}
    </>
  );
}

function StructureChangeDialog({
  bible,
  chapter,
  initialChange,
  onCancel,
  onSaved,
}: {
  bible: StoryBible;
  chapter: OutlineNode;
  initialChange: OutlineChangeRequest | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const byId = new Map(bible.outline.map((node) => [node.id, node]));
  const destinations = bible.outline.filter((node) => {
    if (
      !["book", "volume", "arc"].includes(node.kind) ||
      node.id === chapter.parentId
    )
      return false;
    let ancestor: OutlineNode | undefined = node;
    while (ancestor) {
      if (ancestor.status === "abandoned") return false;
      ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
    }
    return true;
  });
  const [parentId, setParentId] = useState(destinations[0]?.id ?? "");
  const [beforeId, setBeforeId] = useState("");
  const preview = useMutation({
    mutationFn: (change: OutlineChangeRequest) =>
      previewOutlineChange(bible.project.id, change),
    onError: () =>
      queryClient.invalidateQueries({
        queryKey: ["project", bible.project.id, "bible"],
      }),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["project", bible.project.id] });
  const apply = useMutation({
    mutationFn: () =>
      applyOutlineChange(
        bible.project.id,
        preview.variables!,
        preview.data!.fingerprint,
      ),
    onSuccess: async () => {
      await refresh();
      onSaved();
    },
    onError: refresh,
  });
  const { mutate: startPreview } = preview;
  useEffect(() => {
    if (initialChange) startPreview(initialChange);
  }, [initialChange, startPreview]);
  const pending = preview.isPending || apply.isPending;
  const destination = byId.get(parentId);
  const requestPreview = () => {
    apply.reset();
    if (initialChange) {
      // Refresh timestamps after a rejected preview; the intended order still
      // has to pass the server's complete sibling-set validation.
      if (initialChange.kind === "reorder")
        startPreview({
          ...initialChange,
          nodes: initialChange.nodes.map((node) => ({
            ...node,
            expectedUpdatedAt:
              byId.get(node.id)?.updatedAt ?? node.expectedUpdatedAt,
          })),
        });
    } else if (destination)
      startPreview({
        kind: "move",
        nodeId: chapter.id,
        parentId,
        beforeNodeId: beforeId || null,
        expectedUpdatedAt: chapter.updatedAt,
        expectedParentUpdatedAt: destination.updatedAt,
      });
  };
  const name = (id: string | null) =>
    (id ? byId.get(id)?.title : null) ?? t("bible.board.unknown");
  const pathName = (node: OutlineNode) => {
    const titles = [node.title];
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    while (parent) {
      titles.unshift(parent.title);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return titles.join(" / ");
  };
  const windowNames = (ids: string[]) =>
    ids.length ? ids.map(name).join(" · ") : t("bible.board.windowEmpty");
  return (
    <ConfirmDialog
      title={t("bible.board.previewTitle")}
      confirmLabel={t("bible.board.applyChange")}
      pending={pending}
      confirmDisabled={
        !preview.data ||
        Boolean(apply.error) ||
        !preview.data.changedChapters.length
      }
      onCancel={() => {
        if (!pending) onCancel();
      }}
      onConfirm={() => {
        if (preview.data) apply.mutate();
      }}
    >
      <div className="story-structure-preview">
        {preview.data?.foreshadowWindows.some((clue) => clue.inverted) ? (
          <p role="alert" className="story-structure-preview__warning">
            {t("bible.board.invertedWindow")}
          </p>
        ) : null}
        <p>{chapter.title}</p>
        {!initialChange ? (
          <>
            <label>
              {t("bible.board.destination")}
              <select
                value={parentId}
                disabled={pending}
                onChange={(event) => {
                  setParentId(event.target.value);
                  setBeforeId("");
                  preview.reset();
                  apply.reset();
                }}
              >
                {destinations.map((node) => (
                  <option key={node.id} value={node.id}>
                    {pathName(node)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("bible.board.insertion")}
              <select
                value={beforeId}
                disabled={pending}
                onChange={(event) => {
                  setBeforeId(event.target.value);
                  preview.reset();
                  apply.reset();
                }}
              >
                <option value="">{t("bible.board.atEnd")}</option>
                {bible.outline
                  .filter((node) => node.parentId === parentId)
                  .map((node) => (
                    <option key={node.id} value={node.id}>
                      {t("bible.board.beforeNode", { title: node.title })}
                    </option>
                  ))}
              </select>
            </label>
            {!destinations.length ? (
              <p>{t("bible.board.noDestination")}</p>
            ) : null}
          </>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={pending || (!initialChange && !destination)}
          onClick={requestPreview}
        >
          {t("bible.board.previewChange")}
        </button>
        {preview.error || apply.error ? (
          <ErrorNote error={apply.error ?? preview.error} />
        ) : null}
        {preview.data ? (
          <>
            <h3>{t("bible.board.positionChanges")}</h3>
            <ul>
              {preview.data.changedChapters.map((node) => (
                <li key={node.id}>
                  {node.title}
                  <p>
                    {t("bible.board.positionChange", {
                      from: name(node.fromParentId),
                      to: name(node.toParentId),
                      before: node.fromPosition,
                      after: node.toPosition,
                    })}
                  </p>
                </li>
              ))}
            </ul>
            <h3>{t("bible.board.affectedTasks")}</h3>
            <p>{t("bible.board.affectedTasksHint")}</p>
            {preview.data.affectedRuns.length ? (
              <ul>
                {preview.data.affectedRuns.map((run) => (
                  <li key={run.id}>
                    <Link
                      to={`${projectWorkspacePath(bible.project.id, "runs")}?run=${encodeURIComponent(run.id)}`}
                    >
                      {t(
                        run.reason === "chapter_context"
                          ? "bible.board.chapterTask"
                          : "bible.board.planningTask",
                        { title: name(run.outlineNodeId) },
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("bible.board.noAffectedTasks")}</p>
            )}
            <h3>{t("bible.board.windowChanges")}</h3>
            {preview.data.foreshadowWindows.length ? (
              <ul>
                {preview.data.foreshadowWindows.map((clue) => (
                  <li key={clue.id}>
                    <strong>{clue.title}</strong>
                    <p>
                      {t("bible.board.windowBefore", {
                        chapters: windowNames(clue.beforeChapterIds),
                      })}
                    </p>
                    <p>
                      {t("bible.board.windowAfter", {
                        chapters: windowNames(clue.afterChapterIds),
                      })}
                    </p>
                    {clue.inverted ? (
                      <p>{t("bible.board.invertedWindowLabel")}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("bible.board.noWindowChanges")}</p>
            )}
          </>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
