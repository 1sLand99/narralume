import { randomUuid } from "@narralume/domain";

import {
  BackgroundRunCreatedSchema,
  CharacterCardV3ExportSchema,
  CoCreateSessionDetailSchema,
  CoCreateSessionSchema,
  CreateBranchRequestSchema,
  CreateCoCreateSessionRequestSchema,
  CreateDocumentCommentRequestSchema,
  CreateLorebookRequestSchema,
  CreateLoreEntryRequestSchema,
  CreatePersonaRequestSchema,
  CreateSceneAdoptionRequestSchema,
  CreateSelectionEditRequestSchema,
  CreateStoryTurnRequestSchema,
  CreativeRunCreatedSchema,
  DecideEditProposalRequestSchema,
  DeleteLorebookRequestSchema,
  DeleteLoreEntryRequestSchema,
  DocumentCommentSchema,
  EditProposalSchema,
  GenerateSwipeRequestSchema,
  ImportPersonaCardJsonRequestSchema,
  ImportPersonaCardPngRequestSchema,
  LorebookBindingStateSchema,
  LorebookDetailSchema,
  LorebookSchema,
  LoreEntrySchema,
  NarrativeRunSchema,
  PERSONA_CARD_LIMITS,
  PersonaCardImportResponseSchema,
  ReplaceLorebookBindingsRequestSchema,
  ReplaceParticipantsRequestSchema,
  RevertTurnRequestSchema,
  SaveDocumentDraftRequestSchema,
  SetDocumentArchivedRequestSchema,
  SelectBranchRequestSchema,
  SelectSwipeRequestSchema,
  StoryBranchSchema,
  StoryPersonaSchema,
  StoryTurnSchema,
  StudioDocumentDetailSchema,
  UpdateCoCreateSessionRequestSchema,
  UpdateDocumentCommentRequestSchema,
  UpdateLorebookRequestSchema,
  UpdateLoreEntryRequestSchema,
  UpdatePersonaRequestSchema,
  type PersonaCardImportReport,
  type PersonaCardImportTarget,
  type CharacterCardV3Lorebook,
} from "@narralume/contracts";
import type { StoryPersona } from "@narralume/domain";
import { buildSceneAdoptionRecipe } from "@narralume/harness";
import {
  CreativePersistenceError,
  SqliteCreativeRepository,
  SqliteDocumentRepository,
  SqliteLoreRepository,
  SqliteProjectRepository,
  SqliteRequestReplayRepository,
  SqliteRunRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import type { RunCoordinator, RouteApp } from "@narralume/services";
import {
  acceptEditProposal,
  cancelRunsInvalidatedByRevert,
  createReplyRun,
  createSelectionEditRun,
  decodePersonaCardBase64,
  deterministicRequestId,
  hashRequest,
  exportCharacterCardV3,
  extractCcv3Base64FromPng,
  parseCharacterCardV3,
  parsePersonaCardJsonBytes,
  PersonaCardFileError,
  PersonaCardPngError,
  requireActiveCoCreateSession,
  requireProject as requireStudioProject,
  requireWritingAssignment,
  resolveCoCreateSpeaker,
  runProductProjection,
  withRuntimeModelPolicy,
} from "@narralume/services";
import { StudioRouteError } from "./route-error.js";

const ProjectParamsSchema = z.object({ projectId: z.string().trim().min(1) });
const PersonaParamsSchema = z.object({ personaId: z.string().trim().min(1) });
const SessionParamsSchema = z.object({ sessionId: z.string().trim().min(1) });
const LorebookParamsSchema = z.object({
  lorebookId: z.string().trim().min(1),
});
const LoreEntryParamsSchema = z.object({
  entryId: z.string().trim().min(1),
});
const TurnParamsSchema = z.object({ turnId: z.string().trim().min(1) });
const DocumentParamsSchema = z.object({
  projectId: z.string().trim().min(1),
  documentId: z.string().trim().min(1),
});
const CommentParamsSchema = z.object({ commentId: z.string().trim().min(1) });
const ProposalParamsSchema = z.object({ proposalId: z.string().trim().min(1) });
const StudioDocumentQuerySchema = z.object({
  includeArchived: z.coerce.boolean().default(false),
});

function requirePersonaCardExtension(
  filename: string,
  extensions: readonly string[],
): void {
  const normalized = filename.trim().toLocaleLowerCase("en-US");
  if (extensions.some((extension) => normalized.endsWith(extension))) return;
  throw new StudioRouteError(
    "persona_card.file.extension_invalid",
    `Expected a ${extensions.join(" or ")} character card file`,
    422,
  );
}

export function registerStudioRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
  options: {
    coordinator: RunCoordinator;
    enableBackgroundWorker: boolean;
    environment: Readonly<Record<string, string | undefined>>;
  },
): void {
  const creative = new SqliteCreativeRepository(database);
  const documents = new SqliteDocumentRepository(database);
  const lore = new SqliteLoreRepository(database);
  const projects = new SqliteProjectRepository(database);
  const runs = new SqliteRunRepository(database);
  const requestReplays = new SqliteRequestReplayRepository(database);

  const importCharacterBook = (
    persona: StoryPersona,
    characterBook: CharacterCardV3Lorebook,
    now: string,
  ): StoryPersona => {
    const lorebook = lore.insertLorebook({
      id: randomUuid(),
      projectId: persona.projectId,
      name: characterBook.name?.trim() || `${persona.name} · Character Book`,
      description: characterBook.description?.trim() || null,
      enabledGlobally: false,
      scanTurns: Math.min(200, Math.floor(characterBook.scan_depth ?? 24)),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
    const usedTitles = new Set<string>();
    characterBook.entries.forEach((entry, index) => {
      if (
        entry.use_regex ||
        entry.selective ||
        (entry.secondary_keys?.length ?? 0) > 0 ||
        !entry.content.trim()
      ) {
        return;
      }
      const keys = uniqueLoreKeys(entry.keys);
      const constant = entry.constant === true;
      if (!constant && keys.length === 0) return;
      lore.insertLoreEntry({
        id: randomUuid(),
        lorebookId: lorebook.id,
        title: uniqueLoreEntryTitle(
          entry.name?.trim() || entry.comment?.trim() || `Entry ${index + 1}`,
          usedTitles,
        ),
        content: entry.content,
        keys,
        constant,
        priority: Math.max(
          -1_000_000,
          Math.min(
            1_000_000,
            Math.trunc(entry.priority ?? entry.insertion_order),
          ),
        ),
        enabled: entry.enabled,
        createdAt: now,
        updatedAt: now,
        version: 0,
      });
    });
    const bindingIds = [
      ...lore.listPersonaLorebooks(persona.id).map(({ id }) => id),
      lorebook.id,
    ];
    lore.replacePersonaLorebooks(persona.id, bindingIds, persona.version, now);
    return creative.requirePersona(persona.id);
  };

  const importPersonaCard = (args: {
    projectId: string;
    input: {
      requestId: string;
      filename: string;
      contentBase64: string;
      target: PersonaCardImportTarget;
    };
    sourceFormat: "character-card-v3-json" | "character-card-v3-png";
    read: () => unknown;
  }) =>
    database.transaction(() => {
      const scope = `persona-card:${args.projectId}:import`;
      const requestHash = hashRequest({
        sourceFormat: args.sourceFormat,
        filename: args.input.filename,
        target: args.input.target,
        contentBase64: args.input.contentBase64,
      });
      const replay = requestReplays.get<{
        persona: StoryPersona;
        report: PersonaCardImportReport;
      }>(scope, args.input.requestId);
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new StudioRouteError(
            "persona_card.import.idempotency_conflict",
            "The same requestId was already used for a different character card import",
            409,
          );
        }
        return PersonaCardImportResponseSchema.parse({
          ...replay.result,
          idempotentReplay: true,
        });
      }

      let raw: unknown;
      try {
        raw = args.read();
      } catch (error) {
        if (
          error instanceof PersonaCardFileError ||
          error instanceof PersonaCardPngError
        ) {
          throw new StudioRouteError(error.code, error.message, 422);
        }
        throw error;
      }
      const now = new Date().toISOString();
      const imported = parseCharacterCardV3(raw, {
        sourceFormat: args.sourceFormat,
        importedAt: now,
      });
      const name = args.input.target.nameOverride ?? imported.name;
      let persona: StoryPersona;
      if (args.input.target.mode === "create") {
        persona = creative.insertPersona({
          id: randomUuid(),
          projectId: args.projectId,
          kind: args.input.target.kind,
          entityId: args.input.target.entityId,
          name,
          description: imported.description,
          instructions: "",
          voice: {},
          profile: imported.profile,
          status: "active",
          createdAt: now,
          updatedAt: now,
          version: 0,
        });
      } else {
        const current = creative.requirePersona(args.input.target.personaId);
        if (current.projectId !== args.projectId) {
          throw new StudioRouteError(
            "persona_card.target.mismatch",
            "The replacement target does not belong to this project",
            422,
          );
        }
        if (current.kind === "author") {
          throw new StudioRouteError(
            "persona_card.kind_invalid",
            "An author identity cannot be replaced with a character card",
            422,
          );
        }
        persona = creative.updatePersona(current.id, {
          kind: current.kind,
          entityId:
            args.input.target.entityId === undefined
              ? current.entityId
              : args.input.target.entityId,
          name,
          description: imported.description,
          instructions: current.instructions,
          voice: current.voice,
          profile: imported.profile,
          status: current.status,
          expectedVersion: args.input.target.expectedVersion,
          updatedAt: now,
        });
      }
      if (imported.characterBook) {
        persona = importCharacterBook(persona, imported.characterBook, now);
      }
      const result = { persona, report: imported.report };
      requestReplays.insert({
        scope,
        requestId: args.input.requestId,
        requestHash,
        result,
        createdAt: now,
      });
      return PersonaCardImportResponseSchema.parse({
        ...result,
        idempotentReplay: false,
      });
    });

  app.route("GET", "/api/projects/:projectId/personas", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireStudioProject(projects, projectId);
    return creative
      .listPersonas(projectId, true)
      .map((persona) => StoryPersonaSchema.parse(persona));
  });

  app.route("POST", "/api/projects/:projectId/personas", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireStudioProject(projects, projectId);
    const input = CreatePersonaRequestSchema.parse(request.body);
    const now = new Date().toISOString();
    const persona: StoryPersona = {
      id: randomUuid(),
      projectId,
      ...input,
      status: "active",
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    return {
      status: 201,
      body: StoryPersonaSchema.parse(creative.insertPersona(persona)),
    };
  });

  app.route("PUT", "/api/personas/:personaId", async (request) => {
    const { personaId } = PersonaParamsSchema.parse(request.params);
    const input = UpdatePersonaRequestSchema.parse(request.body);
    return StoryPersonaSchema.parse(
      creative.updatePersona(personaId, {
        ...input,
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  app.route(
    "POST",
    "/api/projects/:projectId/persona-card-imports/json",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireStudioProject(projects, projectId);
      const input = ImportPersonaCardJsonRequestSchema.parse(request.body);
      requirePersonaCardExtension(input.filename, [".json"]);
      return {
        status: 201,
        body: importPersonaCard({
          projectId,
          input,
          sourceFormat: "character-card-v3-json",
          read: () =>
            parsePersonaCardJsonBytes(
              decodePersonaCardBase64(
                input.contentBase64,
                PERSONA_CARD_LIMITS.jsonBytes,
              ),
            ),
        }),
      };
    },
    { bodyLimit: 3_000_000 },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/persona-card-imports/png",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireStudioProject(projects, projectId);
      const input = ImportPersonaCardPngRequestSchema.parse(request.body);
      requirePersonaCardExtension(input.filename, [".png", ".apng"]);
      return {
        status: 201,
        body: importPersonaCard({
          projectId,
          input,
          sourceFormat: "character-card-v3-png",
          read: () => {
            const png = decodePersonaCardBase64(
              input.contentBase64,
              PERSONA_CARD_LIMITS.pngBytes,
            );
            const encodedJson = extractCcv3Base64FromPng(png);
            return parsePersonaCardJsonBytes(
              decodePersonaCardBase64(
                encodedJson,
                PERSONA_CARD_LIMITS.jsonBytes,
              ),
            );
          },
        }),
      };
    },
    { bodyLimit: 15_000_000 },
  );

  app.route("GET", "/api/personas/:personaId/card", async (request) => {
    const { personaId } = PersonaParamsSchema.parse(request.params);
    const persona = creative.requirePersona(personaId);
    if (persona.kind === "author") {
      throw new StudioRouteError(
        "persona_card.kind_invalid",
        "An author identity cannot be exported as a character card",
        422,
      );
    }
    return {
      status: 200,
      body: CharacterCardV3ExportSchema.parse(exportCharacterCardV3(persona)),
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${persona.name}.json`)}`,
      },
    };
  });

  app.route("GET", "/api/projects/:projectId/lorebooks", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireStudioProject(projects, projectId);
    return lore
      .listLorebooks(projectId)
      .map(({ id }) =>
        LorebookDetailSchema.parse(lore.requireLorebookDetail(id)),
      );
  });

  app.route("POST", "/api/projects/:projectId/lorebooks", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireStudioProject(projects, projectId);
    const input = CreateLorebookRequestSchema.parse(request.body);
    const now = new Date().toISOString();
    return {
      status: 201,
      body: LorebookSchema.parse(
        lore.insertLorebook({
          id: randomUuid(),
          projectId,
          ...input,
          createdAt: now,
          updatedAt: now,
          version: 0,
        }),
      ),
    };
  });

  app.route("PUT", "/api/lorebooks/:lorebookId", async (request) => {
    const { lorebookId } = LorebookParamsSchema.parse(request.params);
    const input = UpdateLorebookRequestSchema.parse(request.body);
    return LorebookSchema.parse(
      lore.updateLorebook(lorebookId, {
        ...input,
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  app.route("DELETE", "/api/lorebooks/:lorebookId", async (request) => {
    const { lorebookId } = LorebookParamsSchema.parse(request.params);
    const input = DeleteLorebookRequestSchema.parse(request.body);
    lore.deleteLorebook(lorebookId, input.expectedVersion);
    return { deleted: true };
  });

  app.route("POST", "/api/lorebooks/:lorebookId/entries", async (request) => {
    const { lorebookId } = LorebookParamsSchema.parse(request.params);
    const input = CreateLoreEntryRequestSchema.parse(request.body);
    const now = new Date().toISOString();
    return {
      status: 201,
      body: LoreEntrySchema.parse(
        lore.insertLoreEntry({
          id: randomUuid(),
          lorebookId,
          ...input,
          createdAt: now,
          updatedAt: now,
          version: 0,
        }),
      ),
    };
  });

  app.route("PUT", "/api/lore-entries/:entryId", async (request) => {
    const { entryId } = LoreEntryParamsSchema.parse(request.params);
    const input = UpdateLoreEntryRequestSchema.parse(request.body);
    return LoreEntrySchema.parse(
      lore.updateLoreEntry(entryId, {
        ...input,
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  app.route("DELETE", "/api/lore-entries/:entryId", async (request) => {
    const { entryId } = LoreEntryParamsSchema.parse(request.params);
    const input = DeleteLoreEntryRequestSchema.parse(request.body);
    lore.deleteLoreEntry(entryId, input.expectedVersion);
    return { deleted: true };
  });

  app.route("GET", "/api/personas/:personaId/lorebooks", async (request) => {
    const { personaId } = PersonaParamsSchema.parse(request.params);
    const persona = creative.requirePersona(personaId);
    return LorebookBindingStateSchema.parse({
      targetId: persona.id,
      lorebookIds: lore.listPersonaLorebooks(persona.id).map(({ id }) => id),
      version: persona.version,
      updatedAt: persona.updatedAt,
    });
  });

  app.route("PUT", "/api/personas/:personaId/lorebooks", async (request) => {
    const { personaId } = PersonaParamsSchema.parse(request.params);
    const input = ReplaceLorebookBindingsRequestSchema.parse(request.body);
    return LorebookBindingStateSchema.parse(
      lore.replacePersonaLorebooks(
        personaId,
        input.lorebookIds,
        input.expectedVersion,
        new Date().toISOString(),
      ),
    );
  });

  app.route(
    "GET",
    "/api/cocreate/sessions/:sessionId/lorebooks",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const session = creative.requireSession(sessionId);
      return LorebookBindingStateSchema.parse({
        targetId: session.id,
        lorebookIds: lore.listSessionLorebooks(session.id).map(({ id }) => id),
        version: session.version,
        updatedAt: session.updatedAt,
      });
    },
  );

  app.route(
    "PUT",
    "/api/cocreate/sessions/:sessionId/lorebooks",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const input = ReplaceLorebookBindingsRequestSchema.parse(request.body);
      requireActiveCoCreateSession(creative, sessionId);
      return LorebookBindingStateSchema.parse(
        lore.replaceSessionLorebooks(
          sessionId,
          input.lorebookIds,
          input.expectedVersion,
          new Date().toISOString(),
        ),
      );
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/cocreate/sessions",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireStudioProject(projects, projectId);
      return creative
        .listSessions(projectId, true)
        .map((session) => CoCreateSessionSchema.parse(session));
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/cocreate/sessions",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireStudioProject(projects, projectId);
      const input = CreateCoCreateSessionRequestSchema.parse(request.body);
      if (input.participantIds.length === 0) {
        throw new StudioRouteError(
          "cocreate.participants.required",
          "A story room requires at least one AI participant",
          422,
        );
      }
      requireWritingAssignment(database, options.environment);
      const detail = database.transaction(() => {
        const now = new Date().toISOString();
        const created = creative.createSession({
          id: randomUuid(),
          branchId: randomUuid(),
          projectId,
          title: input.title,
          speakerPolicy: input.speakerPolicy,
          targetOutlineNodeId: input.targetOutlineNodeId,
          authorPersonaId: input.authorPersonaId,
          directorNote: input.directorNote,
          contextTurns: input.contextTurns,
          participantIds: input.participantIds,
          now,
        });
        if (input.opening) {
          const persona = creative.requirePersona(input.opening.personaId);
          if (!input.participantIds.includes(persona.id)) {
            throw new StudioRouteError(
              "cocreate.opening.persona_invalid",
              "The opening greeting must belong to a selected AI participant",
              422,
            );
          }
          if (!persona.profile.greetings[input.opening.greetingIndex]) {
            throw new StudioRouteError(
              "cocreate.opening.selection_invalid",
              "The selected opening greeting does not exist",
              422,
            );
          }
          creative.insertOpeningGreeting({
            turnId: randomUuid(),
            swipeIds: persona.profile.greetings.map(() => randomUuid()),
            sessionId: created.session.id,
            branchId: created.session.activeBranchId!,
            personaId: persona.id,
            greetings: persona.profile.greetings,
            selectedIndex: input.opening.greetingIndex,
            now,
          });
        }
        return creative.requireSessionDetail(created.session.id);
      });
      return { status: 201, body: CoCreateSessionDetailSchema.parse(detail) };
    },
  );

  app.route("GET", "/api/cocreate/sessions/:sessionId", async (request) => {
    const { sessionId } = SessionParamsSchema.parse(request.params);
    return CoCreateSessionDetailSchema.parse(
      creative.requireSessionDetail(sessionId),
    );
  });

  app.route("PUT", "/api/cocreate/sessions/:sessionId", async (request) => {
    const { sessionId } = SessionParamsSchema.parse(request.params);
    const input = UpdateCoCreateSessionRequestSchema.parse(request.body);
    return CoCreateSessionSchema.parse(
      creative.updateSession(sessionId, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.speakerPolicy === undefined
          ? {}
          : { speakerPolicy: input.speakerPolicy }),
        ...(input.targetOutlineNodeId === undefined
          ? {}
          : { targetOutlineNodeId: input.targetOutlineNodeId }),
        ...(input.authorPersonaId === undefined
          ? {}
          : { authorPersonaId: input.authorPersonaId }),
        ...(input.directorNote === undefined
          ? {}
          : { directorNote: input.directorNote }),
        ...(input.contextTurns === undefined
          ? {}
          : { contextTurns: input.contextTurns }),
        expectedVersion: input.expectedVersion,
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  app.route(
    "PUT",
    "/api/cocreate/sessions/:sessionId/participants",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const input = ReplaceParticipantsRequestSchema.parse(request.body);
      return database.transaction(() => {
        requireActiveCoCreateSession(creative, sessionId);
        creative.replaceParticipants(
          sessionId,
          input.participants,
          input.expectedVersion,
          new Date().toISOString(),
        );
        return CoCreateSessionDetailSchema.parse(
          creative.requireSessionDetail(sessionId),
        );
      });
    },
  );

  app.route(
    "POST",
    "/api/cocreate/sessions/:sessionId/turns",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const input = CreateStoryTurnRequestSchema.parse(request.body);
      const session = creative.requireSession(sessionId);
      const requestHash = hashRequest(input);
      const turnId = deterministicRequestId(
        "cocreate-turn",
        sessionId,
        input.requestId,
      );
      const replayTurn = creative.getTurn(turnId);
      if (replayTurn) {
        if (replayTurn.metadata.creationRequestHash !== requestHash) {
          throw new StudioRouteError(
            "cocreate.turn.idempotency_conflict",
            "The same requestId was already used for a different co-creation turn",
            409,
          );
        }
        const turn = StoryTurnSchema.parse({
          ...replayTurn,
          swipes: creative.listSwipes(replayTurn.id),
        });
        if (!input.generateReply) {
          return { status: 201, body: { turn, run: null } };
        }
        const runId = deterministicRequestId(
          "cocreate-turn-run",
          sessionId,
          input.requestId,
        );
        const snapshot = runs.getSnapshot(runId);
        return {
          status: 202,
          body: CreativeRunCreatedSchema.parse({
            turn,
            run: NarrativeRunSchema.parse(snapshot.run),
            ...runProductProjection(snapshot),
          }),
        };
      }
      if (session.status !== "active" || !session.activeBranchId) {
        throw new StudioRouteError(
          "cocreate.session.inactive",
          "The session is not active or has no active branch",
          409,
        );
      }
      if (!input.generateReply) {
        const turn = creative.insertTurn({
          id: turnId,
          sessionId,
          branchId: session.activeBranchId,
          role: input.role,
          personaId:
            input.role === "user" ? session.authorPersonaId : input.personaId,
          content: input.content,
          metadata: {
            creationRequestId: input.requestId,
            creationRequestHash: requestHash,
          },
          now: new Date().toISOString(),
        });
        return {
          status: 201,
          body: {
            turn: StoryTurnSchema.parse({ ...turn, swipes: [] }),
            run: null,
          },
        };
      }
      const runId = deterministicRequestId(
        "cocreate-turn-run",
        sessionId,
        input.requestId,
      );
      const { turn, snapshot } = database.transaction(() => {
        const selection = resolveCoCreateSpeaker(creative, {
          sessionId: session.id,
          branchId: session.activeBranchId!,
          requestId: input.requestId,
          requestedPersonaId: input.speakerPersonaId,
          recentAuthorInput: input.content,
        });
        requireWritingAssignment(database, options.environment);
        const turn = creative.insertTurn({
          id: turnId,
          sessionId,
          branchId: session.activeBranchId!,
          role: input.role,
          personaId:
            input.role === "user" ? session.authorPersonaId : input.personaId,
          content: input.content,
          metadata: {
            creationRequestId: input.requestId,
            creationRequestHash: requestHash,
          },
          now: new Date().toISOString(),
        });
        const snapshot = createReplyRun(
          database,
          session,
          {
            runId,
            branchId: session.activeBranchId!,
            speakerPersonaId: selection.speakerPersonaId,
            speakerSelectionReason: selection.reason,
            speakerSelectionHash: selection.stableHash,
            targetTurnId: null,
            creationRequestId: input.requestId,
            creationRequestHash: requestHash,
          },
          options.environment,
          input.policy,
        );
        return { turn, snapshot };
      });
      wake(options);
      return {
        status: 202,
        body: CreativeRunCreatedSchema.parse({
          turn: StoryTurnSchema.parse({ ...turn, swipes: [] }),
          run: NarrativeRunSchema.parse(snapshot.run),
          ...runProductProjection(snapshot),
        }),
      };
    },
  );

  app.route("POST", "/api/turns/:turnId/swipes", async (request) => {
    const { turnId } = TurnParamsSchema.parse(request.params);
    const input = GenerateSwipeRequestSchema.parse(request.body);
    const requestHash = hashRequest(input);
    const runId = deterministicRequestId(
      "cocreate-swipe-run",
      turnId,
      input.requestId,
    );
    const replay = runs.getRun(runId) ? runs.getSnapshot(runId) : null;
    if (replay) {
      if (replay.run.policy.creationRequestHash !== requestHash) {
        throw new StudioRouteError(
          "cocreate.swipe.idempotency_conflict",
          "The same requestId was already used for a different Swipe request",
          409,
        );
      }
      return {
        status: 202,
        body: BackgroundRunCreatedSchema.parse({
          ...replay,
          ...runProductProjection(replay),
        }),
      };
    }
    const snapshot = database.transaction(() => {
      const turn = creative.requireTurn(turnId);
      if (turn.role !== "assistant") {
        throw new StudioRouteError(
          "swipe.turn.not_assistant",
          "Swipes can only be generated for AI turns",
          409,
        );
      }
      const session = requireActiveCoCreateSession(creative, turn.sessionId);
      const visibleTurns = creative.listBranchTurns(turn.branchId);
      const selection = resolveCoCreateSpeaker(creative, {
        sessionId: session.id,
        branchId: turn.branchId,
        requestId: input.requestId,
        requestedPersonaId: input.speakerPersonaId ?? turn.personaId,
        recentAuthorInput:
          [...visibleTurns]
            .reverse()
            .find((candidate) => candidate.role === "user")?.content ?? null,
      });
      requireWritingAssignment(database, options.environment);
      return createReplyRun(
        database,
        session,
        {
          runId,
          branchId: turn.branchId,
          speakerPersonaId: selection.speakerPersonaId,
          speakerSelectionReason: selection.reason,
          speakerSelectionHash: selection.stableHash,
          targetTurnId: turn.id,
          creationRequestId: input.requestId,
          creationRequestHash: requestHash,
        },
        options.environment,
      );
    });
    wake(options);
    return {
      status: 202,
      body: BackgroundRunCreatedSchema.parse({
        ...snapshot,
        ...runProductProjection(snapshot),
      }),
    };
  });

  app.route("POST", "/api/turns/:turnId/swipe-selection", async (request) => {
    const { turnId } = TurnParamsSchema.parse(request.params);
    const input = SelectSwipeRequestSchema.parse(request.body);
    return database.transaction(() => {
      const source = creative.requireTurn(turnId);
      requireActiveCoCreateSession(creative, source.sessionId);
      const turn = creative.selectSwipe(
        turnId,
        input.swipeId,
        new Date().toISOString(),
      );
      return StoryTurnSchema.parse({
        ...turn,
        swipes: creative.listSwipes(turn.id),
      });
    });
  });

  app.route("POST", "/api/turns/:turnId/actions", async (request) => {
    const { turnId } = TurnParamsSchema.parse(request.params);
    RevertTurnRequestSchema.parse(request.body);
    const now = new Date().toISOString();
    const result = database.transaction(() => {
      const turn = creative.requireTurn(turnId);
      requireActiveCoCreateSession(creative, turn.sessionId);
      creative.revertFromTurn(turnId, now);
      // 撤回必须真正阻止后续写入（CR-103/CR-106）：失效 Run 的取消规则在服务层。
      const affected = cancelRunsInvalidatedByRevert(database, {
        sessionId: turn.sessionId,
        branchId: turn.branchId,
        turnOrdinal: turn.ordinal,
        now,
      });
      return {
        affected,
        detail: CoCreateSessionDetailSchema.parse(
          creative.requireSessionDetail(turn.sessionId),
        ),
      };
    });
    for (const run of result.affected) {
      options.coordinator.interrupt(run.id);
    }
    return result.detail;
  });

  app.route(
    "POST",
    "/api/cocreate/sessions/:sessionId/branches",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const input = CreateBranchRequestSchema.parse(request.body);
      const branch = database.transaction(() => {
        requireActiveCoCreateSession(creative, sessionId);
        return creative.createBranch({
          id: randomUuid(),
          sessionId,
          fromTurnId: input.fromTurnId,
          name: input.name,
          expectedVersion: input.expectedVersion,
          now: new Date().toISOString(),
        });
      });
      return { status: 201, body: StoryBranchSchema.parse(branch) };
    },
  );

  app.route(
    "POST",
    "/api/cocreate/sessions/:sessionId/branch-selection",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const input = SelectBranchRequestSchema.parse(request.body);
      return database.transaction(() => {
        requireActiveCoCreateSession(creative, sessionId);
        creative.setActiveBranch(
          sessionId,
          input.branchId,
          input.expectedVersion,
          new Date().toISOString(),
        );
        return CoCreateSessionDetailSchema.parse(
          creative.requireSessionDetail(sessionId),
        );
      });
    },
  );

  app.route(
    "POST",
    "/api/cocreate/sessions/:sessionId/adoptions",
    async (request) => {
      const { sessionId } = SessionParamsSchema.parse(request.params);
      const input = CreateSceneAdoptionRequestSchema.parse(request.body);
      const requestHash = hashRequest(input);
      const runId = deterministicRequestId(
        "cocreate-adoption-run",
        sessionId,
        input.requestId,
      );
      const replay = runs.getRun(runId) ? runs.getSnapshot(runId) : null;
      if (replay) {
        if (replay.run.policy.creationRequestHash !== requestHash) {
          throw new StudioRouteError(
            "adoption.idempotency_conflict",
            "The same requestId was already used for a different scene adoption request",
            409,
          );
        }
        return {
          status: 202,
          body: BackgroundRunCreatedSchema.parse({
            ...replay,
            ...runProductProjection(replay),
          }),
        };
      }
      const recipe = buildSceneAdoptionRecipe(runId);
      const snapshot = database.transaction(() => {
        const session = requireActiveCoCreateSession(creative, sessionId);
        // 分支与回合必须属于该会话，防止用其他会话/作品的资源构造采纳。
        const branch = creative.requireBranch(input.branchId);
        const fromTurn = creative.requireTurn(input.fromTurnId);
        const toTurn = creative.requireTurn(input.toTurnId);
        if (
          branch.sessionId !== sessionId ||
          fromTurn.sessionId !== sessionId ||
          toTurn.sessionId !== sessionId
        ) {
          throw new StudioRouteError(
            "adoption.scope.mismatch",
            "The branch or turn in the adoption range does not belong to the current session",
            422,
          );
        }
        requireWritingAssignment(database, options.environment);
        return runs.create({
          id: runId,
          projectId: session.projectId,
          recipe: recipe.name,
          recipeVersion: recipe.version,
          mode: "co-create",
          targetOutlineNodeId: session.targetOutlineNodeId,
          policy: withRuntimeModelPolicy(
            {
              sessionId,
              branchId: input.branchId,
              fromTurnId: input.fromTurnId,
              toTurnId: input.toTurnId,
              title: input.title,
              creationRequestId: input.requestId,
              creationRequestHash: requestHash,
              adoptionMaxOutputTokens: 8_000,
              origin: {
                surface: "cocreate",
                documentId: null,
                selection: null,
                sessionId,
                branchId: input.branchId,
              },
            },
            options.environment,
          ),
          steps: recipe.steps,
          now: new Date().toISOString(),
        });
      });
      wake(options);
      return {
        status: 202,
        body: BackgroundRunCreatedSchema.parse({
          ...snapshot,
          ...runProductProjection(snapshot),
        }),
      };
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/studio/documents",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireStudioProject(projects, projectId);
      const query = StudioDocumentQuerySchema.parse(request.query);
      return documents.list(projectId, undefined, query.includeArchived);
    },
  );

  app.route(
    "PUT",
    "/api/projects/:projectId/studio/documents/:documentId/archive",
    async (request) => {
      const { projectId, documentId } = DocumentParamsSchema.parse(
        request.params,
      );
      const input = SetDocumentArchivedRequestSchema.parse(request.body);
      const current = documents.get(projectId, documentId);
      if (!current)
        throw new StudioRouteError(
          "document.not_found",
          "Document not found",
          404,
        );
      if (current.updatedAt !== input.expectedUpdatedAt)
        throw new StudioRouteError(
          "document.version.conflict",
          "The document has changed; refresh before moving it",
          409,
        );
      return documents.setArchived(
        projectId,
        documentId,
        input.archived,
        input.expectedUpdatedAt,
        new Date().toISOString(),
      );
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/studio/documents/:documentId",
    async (request) => {
      const { projectId, documentId } = DocumentParamsSchema.parse(
        request.params,
      );
      const document = documents.get(projectId, documentId);
      if (!document)
        throw new StudioRouteError(
          "document.not_found",
          "Document not found",
          404,
        );
      return StudioDocumentDetailSchema.parse({
        document,
        currentVersion: document.currentVersionId
          ? documents.getVersion(
              projectId,
              documentId,
              document.currentVersionId,
            )
          : null,
        draft: documents.getDraft(projectId, documentId),
        versions: documents.listVersions(projectId, documentId),
        comments: creative.listComments(documentId),
        proposals: creative.listEditProposals(documentId),
      });
    },
  );

  app.route(
    "PUT",
    "/api/projects/:projectId/studio/documents/:documentId/draft",
    async (request) => {
      const { projectId, documentId } = DocumentParamsSchema.parse(
        request.params,
      );
      const input = SaveDocumentDraftRequestSchema.parse(request.body);
      const document = documents.get(projectId, documentId);
      if (!document)
        throw new StudioRouteError(
          "document.not_found",
          "Document not found",
          404,
        );
      if (input.baseVersionId !== document.currentVersionId) {
        throw new StudioRouteError(
          "draft.base_version.conflict",
          "The manuscript version has changed; refresh before saving the draft",
          409,
        );
      }
      const existingDraft = documents.getDraft(projectId, documentId);
      if ((existingDraft?.updatedAt ?? null) !== input.expectedDraftUpdatedAt) {
        throw new StudioRouteError(
          "draft.updated_at.conflict",
          "The draft was updated in another page; refresh before saving",
          409,
        );
      }
      const currentContent = document.currentVersionId
        ? (documents.getVersion(
            projectId,
            documentId,
            document.currentVersionId,
          )?.content ?? "")
        : "";
      if (input.content === currentContent) {
        documents.deleteDraft(projectId, documentId);
        return null;
      }
      return documents.upsertDraft(projectId, documentId, {
        baseVersionId: input.baseVersionId,
        content: input.content,
        now: new Date().toISOString(),
      });
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/studio/documents/:documentId/comments",
    async (request) => {
      const { projectId, documentId } = DocumentParamsSchema.parse(
        request.params,
      );
      const input = CreateDocumentCommentRequestSchema.parse(request.body);
      const version = documents.getVersion(
        projectId,
        documentId,
        input.versionId,
      );
      if (!version)
        throw new StudioRouteError(
          "document.version.not_found",
          "The version referenced by the comment does not exist",
          404,
        );
      const now = new Date().toISOString();
      return {
        status: 201,
        body: DocumentCommentSchema.parse(
          creative.insertComment(
            {
              id: randomUuid(),
              projectId,
              documentId,
              versionId: input.versionId,
              startOffset: input.startOffset,
              endOffset: input.endOffset,
              quote: input.quote,
              body: input.body,
              status: "open",
              createdAt: now,
              updatedAt: now,
            },
            version.content,
          ),
        ),
      };
    },
  );

  app.route("PUT", "/api/studio/comments/:commentId", async (request) => {
    const { commentId } = CommentParamsSchema.parse(request.params);
    const input = UpdateDocumentCommentRequestSchema.parse(request.body);
    return DocumentCommentSchema.parse(
      creative.setCommentStatus(
        commentId,
        input.status,
        new Date().toISOString(),
      ),
    );
  });

  app.route(
    "POST",
    "/api/projects/:projectId/studio/documents/:documentId/selection-edits",
    async (request) => {
      const { projectId, documentId } = DocumentParamsSchema.parse(
        request.params,
      );
      const input = CreateSelectionEditRequestSchema.parse(request.body);
      // 版本/草稿一致性检查与 run 创建都在服务层；失败不得产生版本副作用。
      const snapshot = createSelectionEditRun(database, {
        projectId,
        documentId,
        baseVersionId: input.baseVersionId,
        draftContentHash: input.draftContentHash,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        instruction: input.instruction,
        requestPolicy: input.policy,
        environment: options.environment,
      });
      wake(options);
      return {
        status: 202,
        body: BackgroundRunCreatedSchema.parse({
          ...snapshot,
          ...runProductProjection(snapshot),
        }),
      };
    },
  );

  app.route(
    "POST",
    "/api/studio/edit-proposals/:proposalId/actions",
    async (request) => {
      const { proposalId } = ProposalParamsSchema.parse(request.params);
      const input = DecideEditProposalRequestSchema.parse(request.body);
      return database.transaction(() => {
        const scope = `edit-proposal:${proposalId}:action`;
        const requestHash = hashRequest(input);
        const proposal = creative.requireEditProposal(proposalId);
        const replay = requestReplays.get(scope, input.requestId);
        if (replay) {
          if (replay.requestHash !== requestHash) {
            throw new StudioRouteError(
              "edit_proposal.idempotency_conflict",
              "The same requestId was already used for a different selection proposal adjudication",
              409,
            );
          }
          return EditProposalSchema.parse(replay.result);
        }

        if (proposal.status !== "proposed") {
          const sameDecision =
            (proposal.status === "accepted" && input.action === "accept") ||
            (proposal.status === "rejected" && input.action === "reject");
          if (!sameDecision) {
            throw new StudioRouteError(
              "edit_proposal.already_decided",
              `The selection proposal is already ${proposal.status}; cannot perform ${input.action}`,
              409,
            );
          }
          const result = EditProposalSchema.parse(proposal);
          requestReplays.insert({
            scope,
            requestId: input.requestId,
            requestHash,
            result,
            createdAt: new Date().toISOString(),
          });
          return result;
        }

        const now = new Date().toISOString();
        if (input.action === "reject") {
          const result = EditProposalSchema.parse(
            creative.decideEditProposal(proposalId, "rejected", null, now),
          );
          requestReplays.insert({
            scope,
            requestId: input.requestId,
            requestHash,
            result,
            createdAt: now,
          });
          return result;
        }
        // 版本追加/检索段/大纲状态/操作日志/手动结算的完整组装在服务层。
        const decided = acceptEditProposal(database, {
          proposal,
          now,
          environment: options.environment,
          coordinatorWake: () => wake(options),
        });
        const result = EditProposalSchema.parse(decided);
        requestReplays.insert({
          scope,
          requestId: input.requestId,
          requestHash,
          result,
          createdAt: now,
        });
        return result;
      });
    },
  );

  void CreativePersistenceError;
}

function uniqueLoreKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    const trimmed = key.trim();
    const normalized = trimmed.normalize("NFKC").toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

function uniqueLoreEntryTitle(
  requested: string,
  usedTitles: Set<string>,
): string {
  const base = requested.slice(0, 300) || "Entry";
  let title = base;
  let suffix = 2;
  while (usedTitles.has(title.normalize("NFKC").toLowerCase())) {
    const marker = ` (${suffix})`;
    title = `${base.slice(0, 300 - marker.length)}${marker}`;
    suffix += 1;
  }
  usedTitles.add(title.normalize("NFKC").toLowerCase());
  return title;
}

function wake(options: {
  coordinator: RunCoordinator;
  enableBackgroundWorker: boolean;
}) {
  if (options.enableBackgroundWorker) options.coordinator.wake();
}
