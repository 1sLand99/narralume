import {
  StoryStateQuerySchema,
  StoryStateSnapshotSchema,
} from "@narralume/contracts";
import { StoryStatePacketBuilder } from "@narralume/narrative";
import {
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";
import type { RouteApp } from "./route-app.js";
import { StoryServiceError } from "./story-service.js";

const ParamsSchema = z.object({ projectId: z.string().min(1) });

export function registerStoryStateRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
): void {
  const projects = new SqliteProjectRepository(database);
  const canon = new SqliteCanonRepository(database);
  const story = new SqliteStoryRepository(database);
  const state = new SqliteNarrativeStateRepository(database, canon, story);
  const builder = new StoryStatePacketBuilder(canon, state, story);
  app.route("GET", "/api/projects/:projectId/story-state", async (request) => {
    const { projectId } = ParamsSchema.parse(request.params);
    const input = StoryStateQuerySchema.parse(request.query);
    if (!projects.get(projectId))
      throw new StoryServiceError(
        "project.not_found",
        "Project not found",
        404,
      );
    const nodes = new Map(
      story.listOutline(projectId).map((node) => [node.id, node]),
    );
    let cursor = nodes.get(input.chapterId);
    if (!cursor || cursor.kind !== "chapter")
      throw new StoryServiceError(
        "story_state.chapter_unavailable",
        "The selected chapter is not available in this project",
        404,
      );
    while (cursor) {
      if (cursor.status === "abandoned")
        throw new StoryServiceError(
          "story_state.chapter_unavailable",
          "The selected chapter is abandoned",
          409,
        );
      cursor = cursor.parentId ? nodes.get(cursor.parentId) : undefined;
    }
    const characterId =
      input.audience === "character" ? input.characterId : null;
    if (characterId) {
      const character = canon.getEntity(projectId, characterId);
      if (!character || character.type !== "character")
        throw new StoryServiceError(
          "story_state.character_unavailable",
          "The selected character is not available in this project",
          404,
        );
    }
    return StoryStateSnapshotSchema.parse({
      chapterId: input.chapterId,
      audience: input.audience,
      characterId,
      ...builder.snapshot({
        projectId,
        audience: input.audience,
        characterId,
        targetOutlineNodeId: input.chapterId,
      }),
    });
  });
}
