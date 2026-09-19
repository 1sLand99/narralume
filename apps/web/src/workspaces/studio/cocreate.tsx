import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileUp,
  GitBranch,
  Menu,
  PencilLine,
  Plus,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import {
  adoptStoryRange,
  createCoCreateSession,
  createPersona,
  createStoryBranch,
  generateTurnSwipe,
  getCoCreateSession,
  getCoCreateSessions,
  getLorebooks,
  getPersonaCard,
  getPersonas,
  getRunDetail,
  getStoryBible,
  importPersonaCardJson,
  importPersonaCardPng,
  postStoryTurn,
  replaceCoCreateParticipants,
  revertStoryTurn,
  selectStoryBranch,
  selectTurnSwipe,
  updateCoCreateSession,
  updatePersona,
  type CoCreateSession,
  type CoCreateSessionDetail,
  type CoCreateParticipant,
  type OutlineNode,
  type PersonaCardImportReasonCode,
  type PersonaCardImportResponse,
  type PersonaCardImportTarget,
  type PersonaCardProfile,
  type StoryPersona,
  type StoryTurn,
} from "../../lib/api";
import { useI18n } from "../../i18n";
import { projectWorkspacePath } from "../../lib/project-route";
import { LorebookManager } from "./lorebooks";

export function CoCreateWorkspace({
  projectId,
  requestedSessionId,
  initialTargetOutlineNodeId = null,
  initialTargetTitle = null,
  startCreating = false,
  onSessionChange = () => undefined,
}: {
  projectId: string;
  requestedSessionId?: string | null;
  initialTargetOutlineNodeId?: string | null;
  initialTargetTitle?: string | null;
  startCreating?: boolean;
  onSessionChange?: (sessionId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [localSessionId, setLocalSessionId] = useState<string | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(startCreating);
  const [mobilePanel, setMobilePanel] = useState<"navigation" | "settings" | null>(
    null,
  );
  const requestedId =
    requestedSessionId === undefined ? localSessionId : requestedSessionId;
  const selectSession = useCallback(
    (sessionId: string | null) => {
      if (requestedSessionId === undefined) setLocalSessionId(sessionId);
      if (sessionId) setCreatingRoom(false);
      setMobilePanel(null);
      onSessionChange(sessionId);
    },
    [onSessionChange, requestedSessionId],
  );
  const personasQuery = useQuery({
    queryKey: ["project", projectId, "personas"],
    queryFn: ({ signal }) => getPersonas(projectId, signal),
  });
  const sessionsQuery = useQuery({
    queryKey: ["project", projectId, "cocreate", "sessions"],
    queryFn: ({ signal }) => getCoCreateSessions(projectId, signal),
  });
  const lorebooksQuery = useQuery({
    queryKey: ["project", projectId, "lorebooks"],
    queryFn: ({ signal }) => getLorebooks(projectId, signal),
  });
  const outlineQuery = useQuery({
    queryKey: ["project", projectId, "story-bible"],
    queryFn: ({ signal }) => getStoryBible(projectId, signal),
  });
  const outlineNodes = useMemo(
    () =>
      (outlineQuery.data?.outline ?? []).filter(
        (node) => node.kind === "chapter" || node.kind === "scene",
      ),
    [outlineQuery.data?.outline],
  );
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const sessions = useMemo(
    () =>
      (sessionsQuery.data ?? []).filter(
        (session) => showArchivedSessions || session.status !== "archived",
      ),
    [sessionsQuery.data, showArchivedSessions],
  );
  const selectedSessionId =
    creatingRoom && !requestedId
      ? null
      : sessions.some((session) => session.id === requestedId)
        ? requestedId
        : (sessions[0]?.id ?? null);
  useEffect(() => {
    if (
      creatingRoom ||
      requestedSessionId === undefined ||
      sessionsQuery.isPending ||
      selectedSessionId === requestedId
    )
      return;
    onSessionChange(selectedSessionId);
  }, [
    onSessionChange,
    requestedId,
    requestedSessionId,
    selectedSessionId,
    sessionsQuery.isPending,
    creatingRoom,
  ]);
  const detailQuery = useQuery({
    queryKey: ["cocreate", "session", selectedSessionId],
    queryFn: ({ signal }) => getCoCreateSession(selectedSessionId!, signal),
    enabled: Boolean(selectedSessionId),
  });
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [watchedRuns, setWatchedRuns] = useState<WatchedRun[]>([]);
  const actionMutation = useMutation({
    mutationFn: (action: CoCreateAction) => action.work(),
    onSuccess: (value, action) => {
      if (value && typeof value === "object") {
        const object = value as {
          run?: { id?: string };
          id?: string;
          session?: { id?: string };
          turn?: { sessionId?: string };
        };
        if (object.run?.id) {
          const runId = object.run.id;
          const sessionId = object.turn?.sessionId ?? action.sessionId;
          setLastRunId(runId);
          if (sessionId) {
            setWatchedRuns((current) =>
              current.some((item) => item.runId === runId)
                ? current
                : [...current, { runId, sessionId }],
            );
          }
        }
        if (object.session?.id) {
          setCreatingRoom(false);
          selectSession(object.session.id);
        }
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "cocreate"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["cocreate", "session", selectedSessionId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "personas"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "lorebooks"],
      });
    },
  });
  const run = (work: () => Promise<unknown>) =>
    actionMutation.mutate({ work, sessionId: selectedSessionId });
  const personaUnavailable = personasQuery.isError;
  const detail = detailQuery.data;
  return (
    <div className="cocreate">
      <aside
        className="cocreate__setup"
        data-mobile-open={mobilePanel === "navigation"}
        aria-label={t("studio.cocreate.navigationAria")}
      >
        <header className="cocreate__panel-head">
          <div>
            <p className="mono">{t("studio.cocreate.navigationEyebrow")}</p>
            <h2>{t("studio.cocreate.navigationTitle")}</h2>
          </div>
          <button
            type="button"
            className="cocreate__mobile-close"
            aria-label={t("studio.cocreate.closePanel")}
            onClick={() => setMobilePanel(null)}
          >
            <X size={16} />
          </button>
        </header>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setCreatingRoom(true);
            if (requestedSessionId === undefined) setLocalSessionId(null);
            onSessionChange(null);
          }}
        >
          {t("studio.cocreate.session.new")}
        </button>
        <nav className="cocreate__session-list" aria-label={t("studio.cocreate.pickerAria")}>
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              data-active={session.id === selectedSessionId && !creatingRoom}
              onClick={() => selectSession(session.id)}
            >
              <strong>{session.title}</strong>
              <span>
                {sessionStatusLabel(t, session.status)}
                {session.status === "archived"
                  ? t("studio.cocreate.archivedSuffix")
                  : ""}
              </span>
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="studio__text-button"
          onClick={() => setShowArchivedSessions((value) => !value)}
        >
          {showArchivedSessions
            ? t("studio.cocreate.hideArchived")
            : t("studio.cocreate.showArchived")}
        </button>
        {detail && !creatingRoom ? (
          <section className="cocreate__branch-nav">
            <h3>{t("studio.cocreate.branch.title")}</h3>
            {detail.branches.map((branch) => (
              <button
                key={branch.id}
                type="button"
                disabled={
                  actionMutation.isPending ||
                  detail.session.status !== "active" ||
                  branch.id === detail.session.activeBranchId
                }
                data-active={branch.id === detail.session.activeBranchId}
                onClick={() =>
                  run(() =>
                    selectStoryBranch(
                      detail.session.id,
                      branch.id,
                      detail.session.version,
                    ),
                  )
                }
              >
                <GitBranch size={12} />
                <span>{branch.name}</span>
              </button>
            ))}
          </section>
        ) : null}
        <details className="cocreate__persona-drawer">
          <summary>
            <Users size={13} />
            {t("studio.cocreate.persona.manage")}
          </summary>
          {personasQuery.isPending ? (
            <Skeleton lines={6} />
          ) : personaUnavailable ? (
            <ErrorNote
              error={personasQuery.error}
              title={t("studio.errors.personasLoad")}
            />
          ) : (
            <PersonaManager
              projectId={projectId}
              personas={personasQuery.data}
              pending={actionMutation.isPending}
              onSave={run}
            />
          )}
        </details>
        <details className="cocreate__persona-drawer">
          <summary>
            <BookOpen size={13} />
            {t("studio.cocreate.lore.manage")}
          </summary>
          {lorebooksQuery.isPending ? (
            <Skeleton lines={6} />
          ) : lorebooksQuery.isError ? (
            <ErrorNote
              error={lorebooksQuery.error}
              title={t("studio.errors.lorebooksLoad")}
            />
          ) : (
            <LorebookManager
              projectId={projectId}
              lorebooks={lorebooksQuery.data}
              personas={personasQuery.data ?? []}
              session={detail?.session ?? null}
              pending={actionMutation.isPending}
              onRun={run}
            />
          )}
        </details>
      </aside>
      {creatingRoom ? (
        <main className="cocreate__room cocreate__room--create">
          <MobilePanelButtons
            panel={mobilePanel}
            onPanelChange={setMobilePanel}
          />
          {personasQuery.isPending ? (
            <Skeleton lines={8} />
          ) : personaUnavailable ? (
            <ErrorNote
              error={personasQuery.error}
              title={t("studio.errors.personasLoad")}
            />
          ) : (
            <SessionCreator
              key={`${initialTargetOutlineNodeId ?? "none"}:${initialTargetTitle ?? ""}`}
              projectId={projectId}
              personas={personasQuery.data}
              pending={actionMutation.isPending}
              targetOutlineNodeId={initialTargetOutlineNodeId}
              targetTitle={initialTargetTitle}
              onCancel={() => {
                setCreatingRoom(false);
                if (!selectedSessionId && sessions[0]) selectSession(sessions[0].id);
              }}
              onSave={run}
            />
          )}
          {actionMutation.isError ? (
            <ErrorNote
              error={actionMutation.error}
              title={t("studio.errors.cocreateActionFailed")}
            />
          ) : null}
        </main>
      ) : sessionsQuery.isPending ||
        (Boolean(selectedSessionId) && detailQuery.isPending) ? (
        <main className="cocreate__room">
          <Skeleton lines={8} />
        </main>
      ) : sessionsQuery.isError ? (
        <main className="cocreate__room">
          <ErrorNote
            error={sessionsQuery.error}
            title={t("studio.errors.sessionsLoad")}
          />
        </main>
      ) : detailQuery.isError ? (
        <main className="cocreate__room">
          <ErrorNote
            error={detailQuery.error}
            title={t("studio.errors.roomLoad")}
          />
        </main>
      ) : detail ? (
        <Room
          key={detail.session.id}
          detail={detail}
          personas={personasQuery.data ?? []}
          outlineNodes={outlineNodes}
          outlinePending={outlineQuery.isPending}
          pending={actionMutation.isPending || personaUnavailable}
          actionError={actionMutation.error}
          projectId={projectId}
          lastRunId={lastRunId}
          mobilePanel={mobilePanel}
          onMobilePanelChange={setMobilePanel}
          onRun={run}
        />
      ) : (
        <main className="cocreate__room">
          <MobilePanelButtons
            panel={mobilePanel}
            onPanelChange={setMobilePanel}
          />
          <p className="cocreate__empty">{t("studio.cocreate.empty")}</p>
        </main>
      )}
      {watchedRuns.map((item) => (
        <RunCompletionWatcher
          key={item.runId}
          projectId={projectId}
          value={item}
          onSettled={() => {
            void queryClient.invalidateQueries({
              queryKey: ["cocreate", "session", item.sessionId],
            });
            setWatchedRuns((current) =>
              current.filter((candidate) => candidate.runId !== item.runId),
            );
          }}
        />
      ))}
    </div>
  );
}

function MobilePanelButtons({
  panel,
  onPanelChange,
}: {
  panel: "navigation" | "settings" | null;
  onPanelChange: (panel: "navigation" | "settings" | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="cocreate__mobile-tools">
      <button
        type="button"
        className="btn"
        aria-expanded={panel === "navigation"}
        onClick={() =>
          onPanelChange(panel === "navigation" ? null : "navigation")
        }
      >
        <Menu size={13} />
        {t("studio.cocreate.openNavigation")}
      </button>
      <button
        type="button"
        className="btn"
        aria-expanded={panel === "settings"}
        onClick={() => onPanelChange(panel === "settings" ? null : "settings")}
      >
        <Settings size={13} />
        {t("studio.cocreate.openSettings")}
      </button>
    </div>
  );
}

const TERMINAL_RUN_STATUSES = new Set(["failed", "cancelled", "completed"]);
interface WatchedRun {
  runId: string;
  sessionId: string;
}
interface CoCreateAction {
  work: () => Promise<unknown>;
  sessionId: string | null;
}

function RunCompletionWatcher({
  projectId,
  value,
  onSettled,
}: {
  projectId: string;
  value: WatchedRun;
  onSettled: () => void;
}) {
  const query = useQuery({
    queryKey: ["run", value.runId],
    queryFn: ({ signal }) => getRunDetail(projectId, value.runId, signal),
    refetchInterval: (state) =>
      state.state.data && TERMINAL_RUN_STATUSES.has(state.state.data.run.status)
        ? false
        : 1_500,
  });
  useEffect(() => {
    if (query.data && TERMINAL_RUN_STATUSES.has(query.data.run.status))
      onSettled();
  }, [onSettled, query.data]);
  return null;
}

function PersonaManager({
  projectId,
  personas,
  pending,
  onSave,
}: {
  projectId: string;
  personas: StoryPersona[];
  pending: boolean;
  onSave: (work: () => Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("new");
  const [showRetired, setShowRetired] = useState(false);
  const selected = personas.find((persona) => persona.id === selectedId);
  const visible = personas.filter(
    (persona) =>
      showRetired || persona.status === "active" || persona.id === selectedId,
  );
  return (
    <>
      <PersonaFields
        key={selectedId}
        projectId={projectId}
        personas={visible}
        selected={selected}
        pending={pending}
        onSave={onSave}
        onSelect={setSelectedId}
      />
      <button
        type="button"
        className="btn"
        onClick={() => setShowRetired((value) => !value)}
      >
        {showRetired
          ? t("studio.cocreate.persona.hideRetired")
          : t("studio.cocreate.persona.showRetired")}
      </button>
      <PersonaCardImportPanel
        projectId={projectId}
        personas={personas}
        onImported={(result) => {
          setSelectedId(result.persona.id);
          void queryClient.invalidateQueries({
            queryKey: ["project", projectId, "personas"],
          });
        }}
      />
    </>
  );
}

function PersonaFields({
  projectId,
  personas,
  selected,
  pending,
  onSave,
  onSelect,
}: {
  projectId: string;
  personas: StoryPersona[];
  selected: StoryPersona | undefined;
  pending: boolean;
  onSave: (work: () => Promise<unknown>) => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const initialProfile = selected?.profile ?? emptyPersonaCardProfile();
  const [kind, setKind] = useState<StoryPersona["kind"]>(
    selected?.kind ?? "character",
  );
  const [name, setName] = useState(selected?.name ?? "");
  const [description, setDescription] = useState(selected?.description ?? "");
  const [instructions, setInstructions] = useState(
    selected?.instructions ?? "",
  );
  const [personality, setPersonality] = useState(
    initialProfile.personality ?? "",
  );
  const [scenario, setScenario] = useState(initialProfile.scenario ?? "");
  const [exampleDialogue, setExampleDialogue] = useState(
    initialProfile.exampleDialogue ?? "",
  );
  const [greetings, setGreetings] = useState([...initialProfile.greetings]);
  const [status, setStatus] = useState<StoryPersona["status"]>(
    selected?.status ?? "active",
  );
  const exportMutation = useMutation({
    mutationFn: async () => {
      if (!selected) return;
      const card = await getPersonaCard(selected.id);
      downloadPersonaCard(card, selected.name);
    },
  });
  const profile: PersonaCardProfile = {
    personality: personality.trim() || null,
    scenario: scenario.trim() || null,
    exampleDialogue: exampleDialogue.trim() || null,
    greetings: greetings.map((value) => value.trim()).filter(Boolean),
    creator: initialProfile.creator,
    source: initialProfile.source,
  };
  return (
    <form
      className="cocreate__card"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(() =>
          selected
            ? updatePersona(selected.id, {
                kind,
                entityId: selected.entityId,
                name,
                description: description || null,
                instructions,
                voice: selected.voice,
                profile,
                status,
                expectedVersion: selected.version,
              })
            : createPersona(projectId, {
                kind,
                entityId: null,
                name,
                description: description || null,
                instructions,
                voice: {},
                profile,
              }),
        );
      }}
    >
      <header>
        <p className="mono">{t("studio.cocreate.persona.eyebrow")}</p>
        <h3>{t("studio.cocreate.persona.title")}</h3>
      </header>
      <label>
        {t("studio.cocreate.persona.editTarget")}
        <select
          value={selected?.id ?? "new"}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="new">{t("studio.cocreate.persona.newOption")}</option>
          {personas.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name}
              {persona.status === "retired"
                ? t("studio.cocreate.retiredSuffix")
                : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("studio.cocreate.persona.kind")}
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as StoryPersona["kind"])
          }
        >
          <option value="author">
            {t("studio.cocreate.persona.kindAuthor")}
          </option>
          <option value="narrator">
            {t("studio.cocreate.persona.kindNarrator")}
          </option>
          <option value="character">
            {t("studio.cocreate.persona.kindCharacter")}
          </option>
        </select>
      </label>
      <label>
        {t("studio.cocreate.persona.name")}
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        {t("studio.cocreate.persona.description")}
        <textarea
          value={description ?? ""}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        {t("studio.cocreate.persona.instructions")}
        <textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <section className="cocreate__profile-section">
        <header>
          <h4>{t("studio.cocreate.persona.profileTitle")}</h4>
          <p>{t("studio.cocreate.persona.profileNote")}</p>
        </header>
        <label>
          {t("studio.cocreate.persona.personality")}
          <textarea
            value={personality}
            onChange={(event) => setPersonality(event.target.value)}
          />
        </label>
        <label>
          {t("studio.cocreate.persona.scenario")}
          <textarea
            value={scenario}
            onChange={(event) => setScenario(event.target.value)}
          />
        </label>
        <label>
          {t("studio.cocreate.persona.exampleDialogue")}
          <textarea
            value={exampleDialogue}
            onChange={(event) => setExampleDialogue(event.target.value)}
          />
        </label>
        <div className="cocreate__greetings">
          <div className="cocreate__section-heading">
            <span>{t("studio.cocreate.persona.greetings")}</span>
            <button
              type="button"
              className="studio__text-button"
              onClick={() => setGreetings((current) => [...current, ""])}
            >
              <Plus size={12} />
              {t("studio.cocreate.persona.addGreeting")}
            </button>
          </div>
          {greetings.length === 0 ? (
            <p className="cocreate__field-note">
              {t("studio.cocreate.persona.noGreetings")}
            </p>
          ) : (
            greetings.map((greeting, index) => (
              <div className="cocreate__greeting" key={index}>
                <textarea
                  aria-label={t("studio.cocreate.persona.greetingAria", {
                    index: index + 1,
                  })}
                  value={greeting}
                  onChange={(event) =>
                    setGreetings((current) =>
                      current.map((value, candidateIndex) =>
                        candidateIndex === index ? event.target.value : value,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="btn btn--icon"
                  aria-label={t("studio.cocreate.persona.removeGreeting", {
                    index: index + 1,
                  })}
                  onClick={() =>
                    setGreetings((current) =>
                      current.filter((_, candidateIndex) => candidateIndex !== index),
                    )
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </section>
      {selected ? (
        <PersonaMetadata profile={initialProfile} />
      ) : null}
      {selected ? (
        <label>
          {t("studio.cocreate.persona.status")}
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as StoryPersona["status"])
            }
          >
            <option value="active">
              {t("studio.cocreate.persona.statusActive")}
            </option>
            <option value="retired">
              {t("studio.cocreate.persona.statusRetired")}
            </option>
          </select>
        </label>
      ) : null}
      <div className="cocreate__form-actions cocreate__form-actions--wrap">
        {selected && selected.kind !== "author" ? (
          <button
            type="button"
            className="btn"
            disabled={pending || exportMutation.isPending}
            onClick={() => exportMutation.mutate()}
          >
            <Download size={13} />
            {t("studio.cocreate.persona.exportJson")}
          </button>
        ) : null}
        <button
          type="submit"
          className="btn btn--primary"
          disabled={pending || !name.trim()}
        >
          {selected
            ? t("studio.cocreate.persona.update")
            : t("studio.cocreate.persona.create")}
        </button>
      </div>
      {exportMutation.isError ? (
        <ErrorNote
          error={exportMutation.error}
          title={t("studio.errors.personaExportFailed")}
        />
      ) : null}
    </form>
  );
}

function PersonaMetadata({ profile }: { profile: PersonaCardProfile }) {
  const { t } = useI18n();
  const empty = t("studio.cocreate.persona.metadataEmpty");
  return (
    <section className="cocreate__profile-section cocreate__metadata">
      <header>
        <h4>{t("studio.cocreate.persona.metadataTitle")}</h4>
        <p>{t("studio.cocreate.persona.metadataNote")}</p>
      </header>
      <dl>
        <div>
          <dt>{t("studio.cocreate.persona.creatorName")}</dt>
          <dd>{profile.creator.name || empty}</dd>
        </div>
        <div>
          <dt>{t("studio.cocreate.persona.creatorVersion")}</dt>
          <dd>{profile.creator.version || empty}</dd>
        </div>
        <div>
          <dt>{t("studio.cocreate.persona.creatorTags")}</dt>
          <dd>{profile.creator.tags.join(", ") || empty}</dd>
        </div>
        <div>
          <dt>{t("studio.cocreate.persona.creatorNotes")}</dt>
          <dd>{profile.creator.notes || empty}</dd>
        </div>
        <div>
          <dt>{t("studio.cocreate.persona.sourceFormat")}</dt>
          <dd>{personaSourceLabel(t, profile.source.format)}</dd>
        </div>
        <div>
          <dt>{t("studio.cocreate.persona.importedAt")}</dt>
          <dd>
            {profile.source.importedAt ? (
              <time dateTime={profile.source.importedAt}>
                {new Date(profile.source.importedAt).toLocaleString()}
              </time>
            ) : (
              empty
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function PersonaCardImportPanel({
  projectId,
  personas,
  onImported,
}: {
  projectId: string;
  personas: StoryPersona[];
  onImported: (result: PersonaCardImportResponse) => void;
}) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"create" | "replace">("create");
  const [kind, setKind] = useState<"character" | "narrator">("character");
  const [replaceId, setReplaceId] = useState("");
  const [nameOverride, setNameOverride] = useState("");
  const [result, setResult] = useState<PersonaCardImportResponse | null>(null);
  const replaceable = personas.filter((persona) => persona.kind !== "author");
  const validReplaceId = replaceable.some((persona) => persona.id === replaceId)
    ? replaceId
    : (replaceable[0]?.id ?? "");
  const mutation = useMutation({
    mutationFn: async (input: {
      requestId: string;
      file: File;
      target: PersonaCardImportTarget;
      format: "json" | "png";
    }) => {
      const contentBase64 = await fileToBase64(
        input.file,
        t("studio.cocreate.persona.fileReadFailed"),
      );
      const request = {
        requestId: input.requestId,
        filename: input.file.name,
        contentBase64,
        target: input.target,
      };
      return input.format === "json"
        ? importPersonaCardJson(projectId, request)
        : importPersonaCardPng(projectId, request);
    },
    onSuccess: (value) => {
      setResult(value);
      onImported(value);
    },
  });
  const format = file ? personaCardFileFormat(file.name) : null;
  return (
    <section className="cocreate__card cocreate__import-card">
      <header>
        <p className="mono">{t("studio.cocreate.persona.importEyebrow")}</p>
        <h3>{t("studio.cocreate.persona.importTitle")}</h3>
      </header>
      <p className="cocreate__field-note">
        {t("studio.cocreate.persona.importNote")}
      </p>
      <label>
        {t("studio.cocreate.persona.importFile")}
        <input
          type="file"
          accept=".json,.png,.apng,application/json,image/png"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setResult(null);
          }}
        />
      </label>
      {file && !format ? (
        <p className="cocreate__import-warning" role="alert">
          {t("studio.cocreate.persona.importUnsupportedFile")}
        </p>
      ) : null}
      <fieldset>
        <legend>{t("studio.cocreate.persona.importTarget")}</legend>
        <label>
          <input
            type="radio"
            name="persona-card-import-target"
            checked={mode === "create"}
            onChange={() => setMode("create")}
          />
          {t("studio.cocreate.persona.importCreate")}
        </label>
        <label>
          <input
            type="radio"
            name="persona-card-import-target"
            checked={mode === "replace"}
            disabled={replaceable.length === 0}
            onChange={() => setMode("replace")}
          />
          {t("studio.cocreate.persona.importReplace")}
        </label>
      </fieldset>
      {mode === "create" ? (
        <label>
          {t("studio.cocreate.persona.importKind")}
          <select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as "character" | "narrator")
            }
          >
            <option value="character">
              {t("studio.cocreate.persona.kindCharacter")}
            </option>
            <option value="narrator">
              {t("studio.cocreate.persona.kindNarrator")}
            </option>
          </select>
        </label>
      ) : (
        <label>
          {t("studio.cocreate.persona.importReplaceTarget")}
          <select
            value={validReplaceId}
            onChange={(event) => setReplaceId(event.target.value)}
          >
            {replaceable.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t("studio.cocreate.persona.nameOverride")}
        <input
          value={nameOverride}
          placeholder={t("studio.cocreate.persona.nameOverridePlaceholder")}
          onChange={(event) => setNameOverride(event.target.value)}
        />
      </label>
      <p className="cocreate__field-note">
        {t("studio.cocreate.persona.nameConflictHelp")}
      </p>
      <button
        type="button"
        className="btn btn--primary"
        disabled={
          mutation.isPending ||
          !file ||
          !format ||
          (mode === "replace" && !validReplaceId)
        }
        onClick={() => {
          if (!file || !format) return;
          const override = nameOverride.trim();
          const target: PersonaCardImportTarget =
            mode === "create"
              ? {
                  mode: "create",
                  kind,
                  entityId: null,
                  ...(override ? { nameOverride: override } : {}),
                }
              : {
                  mode: "replace",
                  personaId: validReplaceId,
                  expectedVersion: replaceable.find(
                    (persona) => persona.id === validReplaceId,
                  )!.version,
                  ...(override ? { nameOverride: override } : {}),
                };
          mutation.mutate({
            requestId: crypto.randomUUID(),
            file,
            target,
            format,
          });
        }}
      >
        <FileUp size={13} />
        {mutation.isPending
          ? t("studio.cocreate.persona.importing")
          : t("studio.cocreate.persona.importSubmit")}
      </button>
      {mutation.isError ? (
        <ErrorNote
          error={mutation.error}
          title={t("studio.errors.personaImportFailed")}
        />
      ) : null}
      {result ? <PersonaImportReport result={result} /> : null}
    </section>
  );
}

function PersonaImportReport({
  result,
}: {
  result: PersonaCardImportResponse;
}) {
  const { t } = useI18n();
  const dispositions = ["imported", "ignored", "unsupported"] as const;
  return (
    <section className="cocreate__import-report" aria-live="polite">
      <header>
        <h4>{t("studio.cocreate.persona.reportTitle")}</h4>
        <p>
          {t("studio.cocreate.persona.reportSummary", {
            name: result.persona.name,
            format: personaImportFormatLabel(t, result.report.sourceFormat),
            version: result.report.specVersion,
          })}
        </p>
      </header>
      {dispositions.map((disposition) => {
        const items = result.report.items.filter(
          (item) => item.disposition === disposition,
        );
        return (
          <details key={disposition} open={disposition !== "imported"}>
            <summary>
              {personaImportDispositionLabel(t, disposition, items.length)}
            </summary>
            {items.length ? (
              <ul>
                {items.map((item, index) => (
                  <li key={`${item.path}:${item.reasonCode}:${index}`}>
                    <code>{item.path}</code>
                    <span>{personaImportReasonLabel(t, item.reasonCode)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("studio.cocreate.persona.reportEmpty")}</p>
            )}
          </details>
        );
      })}
    </section>
  );
}

function emptyPersonaCardProfile(): PersonaCardProfile {
  return {
    personality: null,
    scenario: null,
    exampleDialogue: null,
    greetings: [],
    creator: { name: null, notes: null, version: null, tags: [] },
    source: { format: "native", importedAt: null },
  };
}

function personaCardFileFormat(filename: string): "json" | "png" | null {
  const normalized = filename.trim().toLocaleLowerCase("en-US");
  if (normalized.endsWith(".json")) return "json";
  if (normalized.endsWith(".png") || normalized.endsWith(".apng")) return "png";
  return null;
}

function fileToBase64(file: File, fallbackError: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(fallbackError));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function downloadPersonaCard(card: unknown, name: string): void {
  const blob = new Blob([JSON.stringify(card, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/[\\/:*?"<>|]/g, "_")}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function SessionCreator({
  projectId,
  personas,
  pending,
  targetOutlineNodeId,
  targetTitle,
  onCancel,
  onSave,
}: {
  projectId: string;
  personas: StoryPersona[];
  pending: boolean;
  targetOutlineNodeId: string | null;
  targetTitle: string | null;
  onCancel: () => void;
  onSave: (work: () => Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(targetTitle ?? "");
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [openingPersonaId, setOpeningPersonaId] = useState("");
  const [openingGreetingIndex, setOpeningGreetingIndex] = useState(0);
  const [authorPersonaId, setAuthorPersonaId] = useState(
    personas.find(
      (persona) => persona.kind === "author" && persona.status === "active",
    )?.id ?? "",
  );
  const aiPersonas = personas.filter(
    (persona) => persona.kind !== "author" && persona.status === "active",
  );
  const openingPersonas = aiPersonas.filter(
    (persona) =>
      participantIds.includes(persona.id) && persona.profile.greetings.length > 0,
  );
  const openingPersona = openingPersonas.find(
    (persona) => persona.id === openingPersonaId,
  );
  const validOpeningPersonaId = openingPersona?.id ?? "";
  const validOpeningGreetingIndex = openingPersona?.profile.greetings[
    openingGreetingIndex
  ]
    ? openingGreetingIndex
    : 0;
  return (
    <form
      className="cocreate__card cocreate__create-card"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(() =>
          createCoCreateSession(projectId, {
            title: title.trim(),
            speakerPolicy: "natural",
            targetOutlineNodeId,
            authorPersonaId: authorPersonaId || null,
            directorNote: null,
            contextTurns: 24,
            participantIds,
            opening: validOpeningPersonaId
              ? {
                  personaId: validOpeningPersonaId,
                  greetingIndex: validOpeningGreetingIndex,
                }
              : null,
          }),
        );
      }}
    >
      <header>
        <p className="mono">{t("studio.cocreate.session.eyebrow")}</p>
        <h3>{t("studio.cocreate.session.title")}</h3>
      </header>
      <p className="cocreate__create-intro">
        {t("studio.cocreate.session.intro")}
      </p>
      {targetOutlineNodeId ? (
        <p className="cocreate__target-note">
          <span>{t("studio.cocreate.session.target")}</span>
          <strong>{targetTitle ?? t("studio.cocreate.session.targetUnknown")}</strong>
        </p>
      ) : null}
      <label>
        {t("studio.cocreate.session.name")}
        <input
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        {t("studio.cocreate.session.authorPersona")}
        <select
          value={authorPersonaId}
          onChange={(event) => setAuthorPersonaId(event.target.value)}
        >
          <option value="">{t("studio.cocreate.session.noAuthorPersona")}</option>
          {personas
            .filter(
              (persona) =>
                persona.kind === "author" && persona.status === "active",
            )
            .map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
        </select>
      </label>
      <fieldset>
        <legend>{t("studio.cocreate.session.participants")}</legend>
        {aiPersonas.length ? (
          aiPersonas.map((persona) => (
            <label key={persona.id}>
              <input
                type="checkbox"
                checked={participantIds.includes(persona.id)}
                disabled={
                  !participantIds.includes(persona.id) &&
                  participantIds.length >= 8
                }
                onChange={() =>
                  setParticipantIds((current) =>
                    current.includes(persona.id)
                      ? current.filter((id) => id !== persona.id)
                      : [...current, persona.id],
                  )
                }
              />
              {persona.name}
            </label>
          ))
        ) : (
          <p>{t("studio.cocreate.session.noAiPersona")}</p>
        )}
      </fieldset>
      <p className="cocreate__field-note">
        {t("studio.cocreate.session.participantLimit", {
          count: participantIds.length,
        })}
      </p>
      {openingPersonas.length ? (
        <section className="cocreate__opening">
          <header>
            <h4>{t("studio.cocreate.session.openingTitle")}</h4>
            <p>{t("studio.cocreate.session.openingNote")}</p>
          </header>
          <label>
            {t("studio.cocreate.session.openingPersona")}
            <select
              value={validOpeningPersonaId}
              onChange={(event) => {
                setOpeningPersonaId(event.target.value);
                setOpeningGreetingIndex(0);
              }}
            >
              <option value="">
                {t("studio.cocreate.session.noOpening")}
              </option>
              {openingPersonas.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.name}
                </option>
              ))}
            </select>
          </label>
          {openingPersona ? (
            <label>
              {t("studio.cocreate.session.openingGreeting")}
              <select
                value={validOpeningGreetingIndex}
                onChange={(event) =>
                  setOpeningGreetingIndex(Number(event.target.value))
                }
              >
                {openingPersona.profile.greetings.map((greeting, index) => (
                  <option key={index} value={index}>
                    {t("studio.cocreate.session.openingGreetingOption", {
                      index: index + 1,
                      text: greeting,
                    })}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </section>
      ) : null}
      <div className="cocreate__form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.action.cancel")}
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={pending || !title.trim() || participantIds.length === 0}
        >
          {t("studio.cocreate.session.create")}
        </button>
      </div>
    </form>
  );
}

function Room({
  detail,
  personas,
  outlineNodes,
  outlinePending,
  pending,
  actionError,
  projectId,
  lastRunId,
  mobilePanel,
  onMobilePanelChange,
  onRun,
}: {
  detail: CoCreateSessionDetail;
  personas: StoryPersona[];
  outlineNodes: OutlineNode[];
  outlinePending: boolean;
  pending: boolean;
  actionError: unknown;
  projectId: string;
  lastRunId: string | null;
  mobilePanel: "navigation" | "settings" | null;
  onMobilePanelChange: (
    panel: "navigation" | "settings" | null,
  ) => void;
  onRun: (work: () => Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const [turnText, setTurnText] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(
    null,
  );
  const [selectionRange, setSelectionRange] = useState<{
    fromId: string;
    toId: string;
  } | null>(null);
  const turnRequestRef = useRef<PendingRequest | null>(null);
  const visibleTurns = detail.turns
    .filter((turn) => turn.status !== "reverted")
    .sort((left, right) => left.ordinal - right.ordinal);
  const speakerParticipants = detail.participants.filter(
    (participant) =>
      participant.enabled && participant.persona.status === "active",
  );
  const active = detail.session.status === "active";
  const targetNode = outlineNodes.find(
    (node) => node.id === detail.session.targetOutlineNodeId,
  );
  const selectRangeTurn = (turn: StoryTurn) => {
    if (!selectionAnchorId) {
      setSelectionAnchorId(turn.id);
      setSelectionRange({ fromId: turn.id, toId: turn.id });
      return;
    }
    const anchorIndex = visibleTurns.findIndex(
      (candidate) => candidate.id === selectionAnchorId,
    );
    const currentIndex = visibleTurns.findIndex(
      (candidate) => candidate.id === turn.id,
    );
    if (anchorIndex < 0 || currentIndex < 0) {
      setSelectionAnchorId(turn.id);
      setSelectionRange({ fromId: turn.id, toId: turn.id });
      return;
    }
    const fromIndex = Math.min(anchorIndex, currentIndex);
    const toIndex = Math.max(anchorIndex, currentIndex);
    setSelectionRange({
      fromId: visibleTurns[fromIndex]!.id,
      toId: visibleTurns[toIndex]!.id,
    });
  };
  const selectedOrdinals = selectionRange
    ? {
        from:
          visibleTurns.find((turn) => turn.id === selectionRange.fromId)
            ?.ordinal ?? -1,
        to:
          visibleTurns.find((turn) => turn.id === selectionRange.toId)
            ?.ordinal ?? -1,
      }
    : null;
  return (
    <>
      <main className="cocreate__room">
        <MobilePanelButtons
          panel={mobilePanel}
          onPanelChange={onMobilePanelChange}
        />
        <header>
          <div>
            <p className="mono">{t("studio.cocreate.roomEyebrow")}</p>
            <h2>{detail.session.title}</h2>
          </div>
          <span className="cocreate__room-state">
            {t("studio.cocreate.roomStats", {
              status: sessionStatusLabel(t, detail.session.status),
              branches: detail.branches.length,
              turns: visibleTurns.length,
            })}
          </span>
        </header>
        {targetNode ? (
          <p className="cocreate__scene-chip">
            {t("studio.cocreate.currentScene", { title: targetNode.title })}
          </p>
        ) : null}
        <div className="cocreate__turns">
          {visibleTurns.length ? (
            visibleTurns.map((turn) => {
              const selected = Boolean(
                selectedOrdinals &&
                  turn.ordinal >= selectedOrdinals.from &&
                  turn.ordinal <= selectedOrdinals.to,
              );
              return (
                <TurnCard
                  key={turn.id}
                  turn={turn}
                  session={detail.session}
                  personas={personas}
                  pending={pending}
                  active={active && turn.status === "active"}
                  selected={selected}
                  onSelect={() => selectRangeTurn(turn)}
                  onRun={onRun}
                />
              );
            })
          ) : (
            <p className="cocreate__empty-turns">
              {t("studio.cocreate.turn.empty")}
            </p>
          )}
        </div>
        <form
          className="cocreate__composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!active) return;
            const content = turnText.trim();
            const requestId = requestIdFor(
              turnRequestRef,
              JSON.stringify({ content, speakerId }),
            );
            onRun(() =>
              postStoryTurn(detail.session.id, {
                requestId,
                role: "user",
                personaId: detail.session.authorPersonaId,
                content,
                generateReply: true,
                speakerPersonaId: speakerId || null,
              }).then((result) => {
                turnRequestRef.current = null;
                setTurnText("");
                return result;
              }),
            );
          }}
        >
          <label className="cocreate__composer-body">
            <span>{t("studio.cocreate.composerLabel")}</span>
            <textarea
              disabled={!active}
              value={turnText}
              onChange={(event) => setTurnText(event.target.value)}
              placeholder={t("studio.cocreate.composerPlaceholder")}
            />
          </label>
          <label>
            <span>{t("studio.cocreate.nextSpeaker")}</span>
            <select
              aria-label={t("studio.cocreate.nextSpeaker")}
              disabled={!active}
              value={speakerId}
              onChange={(event) => setSpeakerId(event.target.value)}
            >
              <option value="">{t("studio.cocreate.naturalSpeaker")}</option>
              {speakerParticipants.map((participant) => (
                <option
                  key={participant.personaId}
                  value={participant.personaId}
                >
                  {participant.persona.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={
              pending ||
              !active ||
              !turnText.trim() ||
              (detail.session.speakerPolicy === "manual" && !speakerId)
            }
          >
            <Send size={12} />
            {t("studio.cocreate.send")}
          </button>
        </form>
        {actionError ? (
          <ErrorNote
            error={actionError}
            title={t("studio.errors.cocreateActionFailed")}
          />
        ) : null}
        {lastRunId ? (
          <Link
            className="cocreate__run-link"
            to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(lastRunId)}`}
          >
            {t("studio.cocreate.lastRunLink")}
          </Link>
        ) : null}
      </main>
      <aside
        className="cocreate__context"
        data-mobile-open={mobilePanel === "settings"}
        aria-label={t("studio.cocreate.settingsAria")}
      >
        <header className="cocreate__panel-head">
          <div>
            <p className="mono">{t("studio.cocreate.settingsEyebrow")}</p>
            <h2>{t("studio.cocreate.settingsTitle")}</h2>
          </div>
          <button
            type="button"
            className="cocreate__mobile-close"
            aria-label={t("studio.cocreate.closePanel")}
            onClick={() => onMobilePanelChange(null)}
          >
            <X size={16} />
          </button>
        </header>
        <RoomSettings
          key={`${detail.session.id}:${detail.session.version}:settings`}
          session={detail.session}
          personas={personas}
          outlineNodes={outlineNodes}
          outlinePending={outlinePending}
          pending={pending}
          onRun={onRun}
        />
        <ParticipantEditor
          key={`${detail.session.id}:${detail.session.version}:participants`}
          detail={detail}
          personas={personas}
          pending={pending}
          onRun={onRun}
        />
        <AdoptionPanel
          key={`${detail.session.id}:${detail.session.version}:adoption`}
          detail={detail}
          targetTitle={targetNode?.title ?? null}
          range={selectionRange}
          pending={pending}
          onRun={onRun}
          onClear={() => {
            setSelectionAnchorId(null);
            setSelectionRange(null);
          }}
        />
      </aside>
    </>
  );
}

type Translator = ReturnType<typeof useI18n>["t"];

function personaSourceLabel(
  t: Translator,
  format: PersonaCardProfile["source"]["format"],
): string {
  if (format === "native") return t("studio.cocreate.persona.sourceNative");
  if (format === "character-card-v2")
    return t("studio.cocreate.persona.sourceCcv2");
  return t("studio.cocreate.persona.sourceCcv3");
}

function personaImportFormatLabel(
  t: Translator,
  format: PersonaCardImportResponse["report"]["sourceFormat"],
): string {
  return format === "character-card-v3-json"
    ? t("studio.cocreate.persona.formatJson")
    : t("studio.cocreate.persona.formatPng");
}

function personaImportDispositionLabel(
  t: Translator,
  disposition: PersonaCardImportResponse["report"]["items"][number]["disposition"],
  count: number,
): string {
  if (disposition === "imported")
    return t("studio.cocreate.persona.reportImported", { count });
  if (disposition === "ignored")
    return t("studio.cocreate.persona.reportIgnored", { count });
  return t("studio.cocreate.persona.reportUnsupported", { count });
}

function personaImportReasonLabel(
  t: Translator,
  reason: PersonaCardImportReasonCode,
): string {
  if (reason === "safe-field")
    return t("studio.cocreate.persona.reasonSafeField");
  if (reason === "creator-metadata")
    return t("studio.cocreate.persona.reasonCreatorMetadata");
  if (reason === "prompt-override-blocked")
    return t("studio.cocreate.persona.reasonPromptOverrideBlocked");
  if (reason === "extension-not-executed")
    return t("studio.cocreate.persona.reasonExtensionNotExecuted");
  if (reason === "character-book-imported")
    return t("studio.cocreate.persona.reasonCharacterBookImported");
  if (reason === "asset-deferred")
    return t("studio.cocreate.persona.reasonAssetDeferred");
  if (reason === "group-greeting-deferred")
    return t("studio.cocreate.persona.reasonGroupGreetingDeferred");
  return t("studio.cocreate.persona.reasonUnknownFieldIgnored");
}

function sessionStatusLabel(
  t: Translator,
  status: CoCreateSession["status"],
): string {
  if (status === "active") return t("studio.cocreate.status.active");
  if (status === "paused") return t("studio.cocreate.status.paused");
  return t("studio.cocreate.status.archived");
}

function RoomSettings({
  session,
  personas,
  outlineNodes,
  outlinePending,
  pending,
  onRun,
}: {
  session: CoCreateSession;
  personas: StoryPersona[];
  outlineNodes: OutlineNode[];
  outlinePending: boolean;
  pending: boolean;
  onRun: (work: () => Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(session.title);
  const [speakerPolicy, setSpeakerPolicy] = useState(session.speakerPolicy);
  const [targetOutlineNodeId, setTargetOutlineNodeId] = useState(
    session.targetOutlineNodeId ?? "",
  );
  const [authorPersonaId, setAuthorPersonaId] = useState(
    session.authorPersonaId ?? "",
  );
  const [directorNote, setDirectorNote] = useState(session.directorNote ?? "");
  const [contextTurns, setContextTurns] = useState(session.contextTurns);
  const editable = session.status === "active";
  const authorPersonas = personas.filter(
    (persona) =>
      persona.kind === "author" &&
      (persona.status === "active" || persona.id === session.authorPersonaId),
  );
  return (
    <details className="cocreate__settings" open>
      <summary>{t("studio.cocreate.settings.room")}</summary>
      <div className="cocreate__status-actions">
        {(["active", "paused", "archived"] as const).map((status) => (
          <button
            key={status}
            type="button"
            className="btn"
            data-active={session.status === status}
            disabled={pending || session.status === status}
            onClick={() =>
              onRun(() =>
                updateCoCreateSession(session.id, {
                  status,
                  expectedVersion: session.version,
                }),
              )
            }
          >
            {sessionStatusLabel(t, status)}
          </button>
        ))}
      </div>
      <label>
        {t("studio.cocreate.session.name")}
        <input
          disabled={!editable}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        {t("studio.cocreate.session.target")}
        <select
          disabled={!editable || outlinePending}
          value={targetOutlineNodeId}
          onChange={(event) => setTargetOutlineNodeId(event.target.value)}
        >
          <option value="">{t("studio.cocreate.session.noTarget")}</option>
          {outlineNodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("studio.cocreate.session.authorPersona")}
        <select
          disabled={!editable}
          value={authorPersonaId}
          onChange={(event) => setAuthorPersonaId(event.target.value)}
        >
          <option value="">{t("studio.cocreate.session.noAuthorPersona")}</option>
          {authorPersonas.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("studio.cocreate.session.speakerPolicy")}
        <select
          disabled={!editable}
          value={speakerPolicy}
          onChange={(event) =>
            setSpeakerPolicy(
              event.target.value as CoCreateSession["speakerPolicy"],
            )
          }
        >
          <option value="natural">
            {t("studio.cocreate.session.policyNatural")}
          </option>
          <option value="round_robin">
            {t("studio.cocreate.session.policyRoundRobin")}
          </option>
          <option value="manual">
            {t("studio.cocreate.session.policyManual")}
          </option>
        </select>
      </label>
      <label>
        {t("studio.cocreate.session.directorNote")}
        <textarea
          disabled={!editable}
          value={directorNote}
          onChange={(event) => setDirectorNote(event.target.value)}
        />
      </label>
      <label>
        {t("studio.cocreate.session.contextTurns")}
        <input
          type="number"
          min={4}
          max={200}
          disabled={!editable}
          value={contextTurns}
          onChange={(event) => setContextTurns(Number(event.target.value))}
        />
      </label>
      <button
        type="button"
        className="btn"
        disabled={
          pending ||
          !editable ||
          !title.trim() ||
          contextTurns < 4 ||
          contextTurns > 200
        }
        onClick={() =>
          onRun(() =>
            updateCoCreateSession(session.id, {
              title: title.trim(),
              speakerPolicy,
              targetOutlineNodeId: targetOutlineNodeId || null,
              authorPersonaId: authorPersonaId || null,
              directorNote: directorNote.trim() || null,
              contextTurns,
              expectedVersion: session.version,
            }),
          )
        }
      >
        {t("studio.cocreate.settings.saveRoom")}
      </button>
    </details>
  );
}

interface ParticipantDraft {
  personaId: string;
  enabled: boolean;
  talkativeness: number;
}

function ParticipantEditor({
  detail,
  personas,
  pending,
  onRun,
}: {
  detail: CoCreateSessionDetail;
  personas: StoryPersona[];
  pending: boolean;
  onRun: (work: () => Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ParticipantDraft[]>(
    detail.participants
      .slice()
      .sort((left, right) => left.position - right.position)
      .map(participantDraft),
  );
  const knownParticipantIds = new Set(
    detail.participants.map((participant) => participant.personaId),
  );
  const visiblePersonas = personas.filter(
    (persona) =>
      persona.kind !== "author" &&
      (persona.status === "active" || knownParticipantIds.has(persona.id)),
  );
  const enabledCount = draft.filter((participant) => participant.enabled).length;
  const editable = detail.session.status === "active";
  const updateParticipant = (
    personaId: string,
    update: (participant: ParticipantDraft) => ParticipantDraft,
  ) => {
    setDraft((current) => {
      const index = current.findIndex(
        (participant) => participant.personaId === personaId,
      );
      if (index < 0)
        return [
          ...current,
          update({ personaId, enabled: false, talkativeness: 0.5 }),
        ];
      return current.map((participant) =>
        participant.personaId === personaId ? update(participant) : participant,
      );
    });
  };
  const moveParticipant = (personaId: string, offset: -1 | 1) => {
    setDraft((current) => {
      const index = current.findIndex(
        (participant) => participant.personaId === personaId,
      );
      const destination = index + offset;
      if (index < 0 || destination < 0 || destination >= current.length)
        return current;
      const next = current.slice();
      const [participant] = next.splice(index, 1);
      next.splice(destination, 0, participant!);
      return next;
    });
  };
  return (
    <details className="cocreate__settings" open>
      <summary>{t("studio.cocreate.settings.participants")}</summary>
      <p className="cocreate__field-note">
        {t("studio.cocreate.session.participantLimit", { count: enabledCount })}
      </p>
      <div className="cocreate__participant-list">
        {visiblePersonas.map((persona) => {
          const participant = draft.find(
            (candidate) => candidate.personaId === persona.id,
          );
          const enabled = participant?.enabled ?? false;
          const draftIndex = participant
            ? draft.findIndex((candidate) => candidate.personaId === persona.id)
            : -1;
          const label = `${persona.name}${
            persona.status === "retired"
              ? t("studio.cocreate.retiredSuffix")
              : ""
          }`;
          return (
            <div key={persona.id} className="cocreate__participant-row">
              <label className="cocreate__participant-toggle">
                <input
                  type="checkbox"
                  aria-label={label}
                  disabled={
                    pending ||
                    !editable ||
                    (!enabled && enabledCount >= 8)
                  }
                  checked={enabled}
                  onChange={() =>
                    updateParticipant(persona.id, (current) => ({
                      ...current,
                      enabled: !current.enabled,
                    }))
                  }
                />
                <span>{label}</span>
              </label>
              {participant ? (
                <>
                  <label className="cocreate__talkativeness">
                    <span>
                      {t("studio.cocreate.participant.talkativenessValue", {
                        value: participant.talkativeness.toFixed(2),
                      })}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      aria-label={t(
                        "studio.cocreate.participant.talkativenessAria",
                        { name: persona.name },
                      )}
                      disabled={pending || !editable}
                      value={participant.talkativeness}
                      onChange={(event) =>
                        updateParticipant(persona.id, (current) => ({
                          ...current,
                          talkativeness: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <div className="cocreate__participant-order">
                    <button
                      type="button"
                      aria-label={t("studio.cocreate.participant.moveUp", {
                        name: persona.name,
                      })}
                      disabled={pending || !editable || draftIndex <= 0}
                      onClick={() => moveParticipant(persona.id, -1)}
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("studio.cocreate.participant.moveDown", {
                        name: persona.name,
                      })}
                      disabled={
                        pending ||
                        !editable ||
                        draftIndex < 0 ||
                        draftIndex === draft.length - 1
                      }
                      onClick={() => moveParticipant(persona.id, 1)}
                    >
                      <ArrowDown size={12} />
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="btn"
        disabled={pending || !editable || enabledCount < 1 || enabledCount > 8}
        onClick={() =>
          onRun(() =>
            replaceCoCreateParticipants(
              detail.session.id,
              detail.session.version,
              draft,
            ),
          )
        }
      >
        {t("studio.cocreate.settings.saveParticipants")}
      </button>
    </details>
  );
}

function participantDraft(participant: CoCreateParticipant): ParticipantDraft {
  return {
    personaId: participant.personaId,
    enabled: participant.enabled,
    talkativeness: participant.talkativeness,
  };
}

function AdoptionPanel({
  detail,
  targetTitle,
  range,
  pending,
  onRun,
  onClear,
}: {
  detail: CoCreateSessionDetail;
  targetTitle: string | null;
  range: { fromId: string; toId: string } | null;
  pending: boolean;
  onRun: (work: () => Promise<unknown>) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(targetTitle ?? detail.session.title);
  const adoptionRequestRef = useRef<PendingRequest | null>(null);
  const from = detail.turns.find((turn) => turn.id === range?.fromId);
  const to = detail.turns.find((turn) => turn.id === range?.toId);
  const canAdopt =
    detail.session.status === "active" &&
    Boolean(detail.session.targetOutlineNodeId) &&
    Boolean(detail.session.activeBranchId && from && to && title.trim());
  return (
    <section className="cocreate__adopt">
      <h3>{t("studio.cocreate.adopt.title")}</h3>
      <p>{t("studio.cocreate.adopt.note")}</p>
      {detail.session.targetOutlineNodeId ? (
        <p className="cocreate__adopt-target">
          {t("studio.cocreate.adopt.target", {
            title: targetTitle ?? detail.session.title,
          })}
        </p>
      ) : (
        <p className="cocreate__adopt-warning">
          {t("studio.cocreate.adopt.missingTarget")}
        </p>
      )}
      {from && to ? (
        <div className="cocreate__range-summary">
          <span>
            {t("studio.cocreate.adopt.range", {
              from: from.ordinal,
              to: to.ordinal,
            })}
          </span>
          <button type="button" onClick={onClear}>
            {t("studio.cocreate.adopt.clearRange")}
          </button>
        </div>
      ) : (
        <p className="cocreate__field-note">
          {t("studio.cocreate.adopt.selectRange")}
        </p>
      )}
      <label>
        {t("studio.cocreate.adopt.sceneTitle")}
        <input
          disabled={detail.session.status !== "active"}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("studio.cocreate.adopt.titlePlaceholder")}
        />
      </label>
      <button
        type="button"
        className="btn btn--primary"
        disabled={pending || !canAdopt}
        onClick={() => {
          const input = {
            branchId: detail.session.activeBranchId!,
            fromTurnId: from!.id,
            toTurnId: to!.id,
            title: title.trim(),
          };
          const requestId = requestIdFor(
            adoptionRequestRef,
            JSON.stringify(input),
          );
          onRun(() =>
            adoptStoryRange(detail.session.id, { requestId, ...input }).then(
              (result) => {
                adoptionRequestRef.current = null;
                return result;
              },
            ),
          );
        }}
      >
        {t("studio.cocreate.adopt.submit")}
      </button>
    </section>
  );
}

function TurnCard({
  turn,
  session,
  personas,
  pending,
  active,
  selected,
  onSelect,
  onRun,
}: {
  turn: StoryTurn;
  session: CoCreateSession;
  personas: StoryPersona[];
  pending: boolean;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
  onRun: (work: () => Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const swipeRequestRef = useRef<PendingRequest | null>(null);
  const rewriteRequestRef = useRef<PendingRequest | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteText, setRewriteText] = useState(turn.content);
  const [copied, setCopied] = useState(false);
  const speaker =
    personas.find((persona) => persona.id === turn.personaId)?.name ??
    turnRoleLabel(t, turn.role);
  const swipes = turn.swipes
    .filter((swipe) => swipe.status !== "rejected")
    .sort((left, right) => left.ordinal - right.ordinal);
  const selectedSwipeIndex = Math.max(
    0,
    swipes.findIndex((swipe) => swipe.id === turn.selectedSwipeId),
  );
  const loreActivation = readTurnLoreActivation(turn.metadata);
  const selectSwipeAt = (index: number) => {
    const swipe = swipes[index];
    if (swipe) onRun(() => selectTurnSwipe(turn.id, swipe.id));
  };
  const stop = (event: { stopPropagation: () => void }) =>
    event.stopPropagation();
  return (
    <article
      className="cocreate__turn"
      data-selected={selected}
      role="button"
      tabIndex={active ? 0 : -1}
      aria-disabled={!active}
      aria-label={t("studio.cocreate.turn.selectAria", {
        ordinal: turn.ordinal,
      })}
      onClick={active ? onSelect : undefined}
      onKeyDown={(event) => {
        if (active && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <header>
        <strong>
          #{turn.ordinal} · {speaker}
        </strong>
        <span>{turnStatusLabel(t, turn.status)}</span>
      </header>
      <p>{turn.content}</p>
      {loreActivation.includedCount > 0 ? (
        <details className="cocreate__lore-hits" onClick={stop}>
          <summary>
            {t("studio.cocreate.lore.turnHits", {
              count: loreActivation.includedCount,
            })}
          </summary>
          <ul>
            {loreActivation.entries
              .filter((entry) => entry.contextStatus !== "excluded")
              .map((entry) => (
                <li key={entry.entryId}>
                  <strong>{entry.title}</strong>
                  {entry.matchedKeys.length
                      ? t("studio.cocreate.lore.matchedKeys", {
                        keys: entry.matchedKeys.join(", "),
                      })
                    : t("studio.cocreate.lore.constantHit")}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
      {swipes.length ? (
        <div className="cocreate__swipes">
          <button
            type="button"
            className="btn"
            aria-label={t("studio.cocreate.turn.previousSwipe")}
            disabled={pending || !active || selectedSwipeIndex <= 0}
            onClick={(event) => {
              stop(event);
              selectSwipeAt(selectedSwipeIndex - 1);
            }}
          >
            <ChevronLeft size={13} />
          </button>
          <span>
            {t("studio.cocreate.turn.swipePosition", {
              current: selectedSwipeIndex + 1,
              total: swipes.length,
            })}
          </span>
          <button
            type="button"
            className="btn"
            aria-label={t("studio.cocreate.turn.nextSwipe")}
            disabled={
              pending || !active || selectedSwipeIndex >= swipes.length - 1
            }
            onClick={(event) => {
              stop(event);
              selectSwipeAt(selectedSwipeIndex + 1);
            }}
          >
            <ChevronRight size={13} />
          </button>
        </div>
      ) : null}
      <div className="cocreate__turn-actions" onClick={stop}>
        {turn.role === "assistant" ? (
          <button
            type="button"
            className="btn"
            disabled={pending || !active}
            onClick={() => {
              const requestId = requestIdFor(
                swipeRequestRef,
                turn.personaId ?? "auto",
              );
              onRun(() =>
                generateTurnSwipe(turn.id, requestId, turn.personaId).then(
                  (result) => {
                    swipeRequestRef.current = null;
                    return result;
                  },
                ),
              );
            }}
          >
            <Sparkles size={11} />
            {t("studio.cocreate.turn.regenSwipe")}
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={pending || !active}
          onClick={() =>
            onRun(() =>
              createStoryBranch(
                session.id,
                turn.id,
                t("studio.cocreate.branch.fromTurnName", {
                  ordinal: turn.ordinal,
                }),
                session.version,
              ),
            )
          }
        >
          <GitBranch size={11} />
          {t("studio.cocreate.turn.branchHere")}
        </button>
        {turn.role === "user" ? (
          <button
            type="button"
            className="btn"
            disabled={pending || !active || !turn.parentTurnId}
            onClick={() => setRewriting((value) => !value)}
          >
            <PencilLine size={11} />
            {t("studio.cocreate.turn.rewrite")}
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={pending || !active || turn.ordinal === 0}
          onClick={() => onRun(() => revertStoryTurn(turn.id))}
        >
          <RotateCcw size={11} />
          {t("studio.cocreate.turn.revertHere")}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void copyText(turn.content).then((didCopy) => {
              if (!didCopy) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            });
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied
            ? t("studio.cocreate.turn.copied")
            : t("studio.cocreate.turn.copy")}
        </button>
      </div>
      {rewriting ? (
        <form
          className="cocreate__rewrite"
          onClick={stop}
          onSubmit={(event) => {
            event.preventDefault();
            if (!turn.parentTurnId) return;
            const content = rewriteText.trim();
            const requestId = requestIdFor(
              rewriteRequestRef,
              JSON.stringify({ turnId: turn.id, content }),
            );
            onRun(async () => {
              await createStoryBranch(
                session.id,
                turn.parentTurnId!,
                t("studio.cocreate.branch.rewriteName", {
                  ordinal: turn.ordinal,
                }),
                session.version,
              );
              const result = await postStoryTurn(session.id, {
                requestId,
                role: "user",
                personaId: session.authorPersonaId,
                content,
                generateReply: false,
                speakerPersonaId: null,
              });
              rewriteRequestRef.current = null;
              setRewriting(false);
              return result;
            });
          }}
        >
          <label>
            {t("studio.cocreate.turn.rewriteLabel")}
            <textarea
              value={rewriteText}
              onChange={(event) => setRewriteText(event.target.value)}
            />
          </label>
          <div>
            <button
              type="button"
              className="btn"
              onClick={() => setRewriting(false)}
            >
              {t("common.action.cancel")}
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={pending || !rewriteText.trim()}
            >
              {t("studio.cocreate.turn.createRewrite")}
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}

interface TurnLoreActivation {
  includedCount: number;
  entries: Array<{
    entryId: string;
    title: string;
    matchedKeys: string[];
    contextStatus: string;
  }>;
}

function readTurnLoreActivation(
  metadata: Record<string, unknown>,
): TurnLoreActivation {
  const value = metadata.loreActivation;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { includedCount: 0, entries: [] };
  }
  const record = value as Record<string, unknown>;
  const entries = Array.isArray(record.entries)
    ? record.entries.flatMap((candidate) => {
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        ) {
          return [];
        }
        const entry = candidate as Record<string, unknown>;
        if (typeof entry.entryId !== "string" || typeof entry.title !== "string")
          return [];
        return [
          {
            entryId: entry.entryId,
            title: entry.title,
            matchedKeys: Array.isArray(entry.matchedKeys)
              ? entry.matchedKeys.filter(
                  (key): key is string => typeof key === "string",
                )
              : [],
            contextStatus:
              typeof entry.contextStatus === "string"
                ? entry.contextStatus
                : "excluded",
          },
        ];
      })
    : [];
  return {
    includedCount:
      typeof record.includedCount === "number" ? record.includedCount : 0,
    entries,
  };
}

function turnRoleLabel(t: Translator, role: StoryTurn["role"]): string {
  if (role === "user") return t("studio.cocreate.role.user");
  if (role === "assistant") return t("studio.cocreate.role.assistant");
  if (role === "director") return t("studio.cocreate.role.director");
  return t("studio.cocreate.role.system");
}

function turnStatusLabel(t: Translator, status: StoryTurn["status"]): string {
  if (status === "active") return t("studio.cocreate.turnStatus.active");
  if (status === "adopted") return t("studio.cocreate.turnStatus.adopted");
  return t("studio.cocreate.turnStatus.reverted");
}

async function copyText(value: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // The desktop WebView may deny Clipboard API access. The browser
      // fallback keeps the message action useful without changing history.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy") ?? false;
  textarea.remove();
  return copied;
}

interface PendingRequest {
  key: string;
  requestId: string;
}
function requestIdFor(
  ref: { current: PendingRequest | null },
  key: string,
): string {
  if (ref.current?.key !== key)
    ref.current = { key, requestId: crypto.randomUUID() };
  return ref.current.requestId;
}
