import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { ErrorNote } from "../../components/error-note";
import { useI18n } from "../../i18n";
import { getStoryLineProposals, decideStoryLineProposal, type StoryBible } from "../../lib/api";
import { formatTime } from "../../lib/fmt";
import { projectWorkspacePath } from "../../lib/project-route";

export function StoryLineProposals({ bible }: { bible: StoryBible }) {
  const projectId = bible.project.id;
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["project", projectId, "compass", "proposals"], queryFn: ({ signal }) => getStoryLineProposals(projectId, signal) });
  const mutation = useMutation({
    mutationFn: ({ setId, itemId, action }: { setId: string; itemId: string; action: "apply" | "reject" }) => decideStoryLineProposal(projectId, setId, itemId, action),
    onSuccess: () => client.invalidateQueries({ queryKey: ["project", projectId] }),
    onError: () => client.invalidateQueries({ queryKey: ["project", projectId, "compass", "proposals"] }),
  });
  return <section className="story-lines__reviews" aria-label={t("bible.lineProposals.title")}>
    <h3>{t("bible.lineProposals.title")}</h3>
    <p>{t("bible.lineProposals.hint")}</p>
    {query.isPending ? <p>{t("common.state.loading")}</p> : query.isError ? <ErrorNote error={query.error} title={t("bible.lines.reviewsError")} /> : !query.data?.length ? <p>{t("bible.lineProposals.empty")}</p> : null}
    {mutation.error ? <ErrorNote error={mutation.error} title={t("bible.lines.saveError")} /> : null}
    {query.data?.map(set => <div key={set.id}>
      <h4>{bible.outline.find(node => node.id === set.scopeNodeId)?.title ?? t("bible.lines.unavailableScope")} · {formatTime(set.createdAt)}</h4>
      {set.stale && set.items.some(item => !item.decision) ? <p role="status">{t("bible.lineProposals.stale")}</p> : null}
      {set.items.map(item => <article className="story-line" key={item.id}>
        <h4>{item.before.title}</h4><p>{item.rationale}</p>
        <div className="story-lines__grid">
          {(["before", "after"] as const).map(side => <div key={side}>
            <h5>{t(`bible.lineProposals.${side}`)}</h5>
            <dl>
              <dt>{t("bible.lines.status")}</dt><dd>{t(`bible.lines.statuses.${item[side].status}`)}</dd>
              {(["progress", "openPromises", "nextDevelopment"] as const).map(field => <div key={field}>
                <dt>{t(`bible.lines.${field}`)}</dt><dd>{Array.isArray(item[side].development?.[field]) ? (item[side].development?.[field] as string[]).join(" · ") || t("bible.lines.notRecorded") : item[side].development?.[field] || t("bible.lines.notRecorded")}</dd>
              </div>)}
            </dl>
          </div>)}
        </div>
        <details><summary>{t("bible.lineProposals.evidence")}</summary>
          {set.evidence.filter(evidence => item.after.development?.evidenceChapterIds.includes(evidence.chapterId)).map(evidence => <div key={evidence.chapterId}>
            <Link to={`${projectWorkspacePath(projectId, "studio")}?outline=${encodeURIComponent(evidence.chapterId)}`}>{evidence.title}</Link>
            <p>{evidence.summary}</p>
          </div>)}
        </details>
        {item.decision ? <p role="status">{t(item.decision.action === "apply" ? "bible.lineProposals.applied" : "bible.lineProposals.rejected")}</p> : <div className="story-lines__actions">
          <button type="button" className="btn btn--primary" disabled={mutation.isPending || set.stale} onClick={() => mutation.mutate({ setId: set.id, itemId: item.id, action: "apply" })}>{t("bible.lineProposals.apply")}</button>
          <button type="button" className="btn" disabled={mutation.isPending} onClick={() => mutation.mutate({ setId: set.id, itemId: item.id, action: "reject" })}>{t("bible.lineProposals.reject")}</button>
        </div>}
      </article>)}
    </div>)}
  </section>;
}
