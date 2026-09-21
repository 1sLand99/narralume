import { useQuery } from "@tanstack/react-query";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { useI18n } from "../../i18n";
import { getCanonCandidates } from "../../lib/api";
import { CanonCandidateSetReview } from "../bible/candidate-panel";
import "../../styles/bible.css";

export function PlanningEntities({ projectId, runId, pending, onContinue }: {
  projectId: string; runId: string; pending: boolean; onContinue: () => void;
}) {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ["project", projectId, "canon-candidates", "entities"],
    queryFn: ({ signal }) => getCanonCandidates(projectId, "entities", signal),
    refetchInterval: 3_000,
  });
  const sets = (query.data ?? []).filter((set) => set.runId === runId);
  const rejected = sets.some((set) => set.items.some((item) => item.decision?.action === "reject"));
  const ready = sets.length > 0 && sets.every((set) => !set.stale && set.items.length > 0 && set.items.every((item) => item.decision?.action === "apply"));
  return <section className="bible-ai" aria-label={t("autopilot.entities.title")}>
    <h3>{t("autopilot.entities.title")}</h3>
    <p className="bible-ai__intro">{t("autopilot.entities.hint")}</p>
    {query.isPending ? <Skeleton lines={3} /> : query.isError ? <ErrorNote error={query.error} title={t("bible.candidates.loadError")} /> : sets.length === 0 ? <p>{t("autopilot.entities.unavailable")}</p> : null}
    <div className="bible-ai__sets">{sets.map((set) => <CanonCandidateSetReview key={set.id} projectId={projectId} value={set} disableApply={pending || set.stale} />)}</div>
    <p role="status">{t(rejected ? "autopilot.entities.rejected" : ready ? "autopilot.entities.ready" : "autopilot.entities.pending")}</p>
    <button type="button" className="btn btn--primary" disabled={!ready || pending || query.isError} onClick={onContinue}>{t("labels.taskAction.acceptEntities")}</button>
  </section>;
}
