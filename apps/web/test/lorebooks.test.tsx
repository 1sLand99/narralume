// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import type {
  CoCreateSession,
  LorebookDetail,
  StoryPersona,
} from "../src/lib/api";
import { LorebookManager } from "../src/workspaces/studio/lorebooks";

const PERSONA: StoryPersona = {
  id: "persona-1",
  projectId: "project-1",
  kind: "character",
  entityId: null,
  name: "守灯人",
  description: null,
  instructions: "守住知识边界",
  voice: {},
  profile: {
    personality: null,
    scenario: null,
    exampleDialogue: null,
    greetings: [],
    creator: { name: null, notes: null, version: null, tags: [] },
    source: { format: "native", importedAt: null },
  },
  status: "active",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  version: 0,
};

const SESSION: CoCreateSession = {
  id: "session-1",
  projectId: "project-1",
  title: "潮汐房",
  status: "active",
  speakerPolicy: "natural",
  activeBranchId: "branch-1",
  targetOutlineNodeId: null,
  authorPersonaId: null,
  directorNote: null,
  contextTurns: 24,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  version: 0,
};

const BOOK: LorebookDetail = {
  lorebook: {
    id: "book-1",
    projectId: "project-1",
    name: "潮汐规则",
    description: "非正典参考",
    enabledGlobally: false,
    scanTurns: 24,
    enabled: true,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    version: 0,
  },
  entries: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => setLocale("zh-CN"));

describe("世界书编辑器", () => {
  it("保存房间绑定并创建关键词条目", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/personas/persona-1/lorebooks" && !init?.method) {
        return json({
          targetId: PERSONA.id,
          lorebookIds: [],
          version: 0,
          updatedAt: PERSONA.updatedAt,
        });
      }
      if (
        url === "/api/cocreate/sessions/session-1/lorebooks" &&
        !init?.method
      ) {
        return json({
          targetId: SESSION.id,
          lorebookIds: [],
          version: 0,
          updatedAt: SESSION.updatedAt,
        });
      }
      if (
        url === "/api/cocreate/sessions/session-1/lorebooks" &&
        init?.method === "PUT"
      ) {
        return json({
          targetId: SESSION.id,
          lorebookIds: ["book-1"],
          version: 1,
          updatedAt: SESSION.updatedAt,
        });
      }
      if (url === "/api/lorebooks/book-1/entries" && init?.method === "POST") {
        return json({ id: "entry-1" }, 201);
      }
      throw new Error("unexpected request " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRun = (work: () => Promise<unknown>) => void work();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LorebookManager
          projectId="project-1"
          lorebooks={[BOOK]}
          personas={[PERSONA]}
          session={SESSION}
          pending={false}
          onRun={onRun}
        />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("编辑对象"), {
      target: { value: "book-1" },
    });
    const roomBinding = await screen.findByLabelText(
      "绑定到当前故事房：潮汐房",
    );
    fireEvent.click(roomBinding);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/cocreate/sessions/session-1/lorebooks" &&
          init?.method === "PUT",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        lorebookIds: ["book-1"],
        expectedVersion: 0,
      });
    });

    fireEvent.click(screen.getByText("添加世界信息"));
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "盐钟" },
    });
    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: "盐钟只在退潮时走动。" },
    });
    fireEvent.change(screen.getByLabelText("触发关键词"), {
      target: { value: "盐钟\n退潮" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建条目" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/lorebooks/book-1/entries" &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        title: "盐钟",
        content: "盐钟只在退潮时走动。",
        keys: ["盐钟", "退潮"],
        constant: false,
      });
    });
  });
});

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}
