// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import type {
  CoCreateParticipant,
  CoCreateSession,
  CoCreateSessionDetail,
  StoryPersona,
  StoryTurn,
  TurnSwipe,
} from "../src/lib/api";
import { CoCreateWorkspace } from "../src/workspaces/studio/cocreate";

const PERSONA: StoryPersona = {
  id: "persona-1",
  projectId: "p-1",
  kind: "narrator",
  entityId: null,
  name: "旁白",
  description: null,
  instructions: "克制、具体",
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
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
  version: 0,
};

const AUTHOR: StoryPersona = {
  ...PERSONA,
  id: "author-1",
  kind: "author",
  name: "我",
  instructions: "以作者身份参与",
};

const CHARACTER: StoryPersona = {
  ...PERSONA,
  id: "persona-2",
  kind: "character",
  name: "阿灯",
  instructions: "谨慎而敏锐",
};

function makeSession(
  id: string,
  title: string,
  status: CoCreateSession["status"] = "active",
): CoCreateSession {
  return {
    id,
    projectId: "p-1",
    title,
    status,
    speakerPolicy: "manual",
    activeBranchId: `branch-${id}`,
    targetOutlineNodeId: null,
    authorPersonaId: null,
    directorNote: null,
    contextTurns: 20,
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    version: 1,
  };
}

function makeSwipe(
  turnId: string,
  id: string,
  ordinal: number,
  content: string,
  status: TurnSwipe["status"],
): TurnSwipe {
  return {
    id,
    turnId,
    ordinal,
    content,
    speakerPersonaId: PERSONA.id,
    sourceRunId: `run-${id}`,
    status,
    metadata: {},
    createdAt: "2026-08-10T10:00:00.000Z",
  };
}

function makeTurn(
  sessionId: string,
  id: string,
  ordinal: number,
  role: StoryTurn["role"],
  content: string,
): StoryTurn {
  return {
    id,
    projectId: "p-1",
    sessionId,
    branchId: `branch-${sessionId}`,
    parentTurnId: null,
    ordinal,
    role,
    personaId: role === "assistant" ? PERSONA.id : null,
    content,
    status: "active",
    selectedSwipeId: null,
    sourceRunId: null,
    metadata: {},
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    swipes: [],
  };
}

function participant(
  sessionId: string,
  persona: StoryPersona,
  position: number,
  enabled = true,
  talkativeness = 0.5,
): CoCreateParticipant {
  return {
    sessionId,
    personaId: persona.id,
    position,
    enabled,
    talkativeness,
    createdAt: "2026-08-10T10:00:00.000Z",
    persona,
  };
}

function makeDetail(
  sessionId: string,
  title: string,
  turns: StoryTurn[],
  status: CoCreateSession["status"] = "active",
): CoCreateSessionDetail {
  const linkedTurns = turns.map((turn, index) => ({
    ...turn,
    parentTurnId: turns[index - 1]?.id ?? null,
  }));
  return {
    session: makeSession(sessionId, title, status),
    participants: [participant(sessionId, PERSONA, 0)],
    branches: [
      {
        id: `branch-${sessionId}`,
        sessionId,
        parentBranchId: null,
        forkedFromTurnId: null,
        name: "主线",
        status: "active",
        headTurnId: linkedTurns.at(-1)?.id ?? null,
        createdAt: "2026-08-10T10:00:00.000Z",
        updatedAt: "2026-08-10T10:00:00.000Z",
      },
    ],
    turns: linkedTurns,
    adoptions: [],
  };
}

const DETAILS: Record<string, CoCreateSessionDetail> = {
  "s-a": makeDetail("s-a", "房间A", [
    makeTurn("s-a", "t-a-0", 0, "user", "第一段。"),
    makeTurn("s-a", "t-a-1", 1, "assistant", "旁白接一段。"),
  ]),
  "s-b": makeDetail("s-b", "房间B", [
    makeTurn("s-b", "t-b-0", 0, "user", "另一本书。"),
  ]),
};

const STORY_BIBLE = {
  outline: [
    {
      id: "outline-1",
      projectId: "p-1",
      parentId: null,
      kind: "chapter",
      ordinal: 0,
      title: "雨夜来客",
      summary: null,
      goal: null,
      conflict: null,
      status: "planned",
      metadata: {},
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:00.000Z",
    },
  ],
};

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function stubFetch(
  sessions: CoCreateSession[],
  details: Record<string, CoCreateSessionDetail> = DETAILS,
  personas: StoryPersona[] = [PERSONA],
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/personas") return json(personas);
    if (url === "/api/projects/p-1/lorebooks") return json([]);
    if (url === "/api/projects/p-1/story-bible") return json(STORY_BIBLE);
    if (url === "/api/projects/p-1/cocreate/sessions") return json(sessions);
    const detailMatch = url.match(/^\/api\/cocreate\/sessions\/([^/]+)$/);
    if (detailMatch && init?.method === "PUT" && details[detailMatch[1]!]) {
      return json({
        ...details[detailMatch[1]!]!.session,
        status: "paused",
        version: 2,
      });
    }
    if (detailMatch && details[detailMatch[1]!])
      return json(details[detailMatch[1]!]);
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderCoCreate(
  requestedSessionId?: string | null,
  options: {
    startCreating?: boolean;
    targetOutlineNodeId?: string | null;
    targetTitle?: string | null;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Harness() {
    const [sessionId, setSessionId] = useState(requestedSessionId);
    return (
      <CoCreateWorkspace
        projectId="p-1"
        requestedSessionId={sessionId}
        startCreating={options.startCreating}
        initialTargetOutlineNodeId={options.targetOutlineNodeId}
        initialTargetTitle={options.targetTitle}
        onSessionChange={setSessionId}
      />
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => setLocale("zh-CN"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("作品内角色共创沙盒", () => {
  it("角色卡查询失败时显示错误并阻止依赖写入", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas")
        return json(
          {
            error: {
              code: "storage.unavailable",
              message: "personas unavailable",
            },
          },
          500,
        );
      if (url === "/api/projects/p-1/story-bible") return json(STORY_BIBLE);
      if (url === "/api/projects/p-1/cocreate/sessions") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate();

    expect(await screen.findByText("角色设定暂时无法加载")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建故事房" }));
    expect(
      screen.queryByRole("button", { name: "创建故事房" }),
    ).not.toBeInTheDocument();
  });

  it("按 URL 恢复房间，并在切换房间后清空草稿", async () => {
    stubFetch([makeSession("s-a", "房间A"), makeSession("s-b", "房间B")]);
    renderCoCreate("s-b");

    expect(await screen.findByText("另一本书。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /房间B/ })).toHaveAttribute(
      "data-active",
      "true",
    );
    fireEvent.change(screen.getByPlaceholderText(/写下一回合/), {
      target: { value: "未发送草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: /房间A/ }));
    await screen.findByText("第一段。");
    expect(screen.getByPlaceholderText(/写下一回合/)).toHaveValue("");
  });

  it("暂停房间只允许阅读与重新激活", async () => {
    const paused = makeDetail(
      "s-paused",
      "暂停房间",
      [
        makeTurn("s-paused", "t-paused-0", 0, "user", "第一段。"),
        makeTurn("s-paused", "t-paused-1", 1, "assistant", "旁白接一段。"),
      ],
      "paused",
    );
    stubFetch([paused.session], { "s-paused": paused });
    renderCoCreate();

    await screen.findByText(/已暂停 · 分支/);
    expect(screen.getByRole("button", { name: "进行中" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "已暂停" })).toBeDisabled();
    expect(screen.getByPlaceholderText(/写下一回合/)).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /发送并生成回复/ }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /再生成回应/ })).toBeDisabled();
    expect(
      screen.getAllByRole("button", { name: /回退到此/ }).at(-1),
    ).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "旁白" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "采纳范围" })).toBeDisabled();
  });

  it("从场景进入时预填目标与名称，最小表单默认自然接话", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas") return json([PERSONA, AUTHOR]);
      if (url === "/api/projects/p-1/story-bible") return json(STORY_BIBLE);
      if (url === "/api/projects/p-1/cocreate/sessions" && init?.method === "POST")
        return json(makeDetail("s-new", "雨夜来客", []), 201);
      if (url === "/api/projects/p-1/cocreate/sessions") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate(null, {
      startCreating: true,
      targetOutlineNodeId: "outline-1",
      targetTitle: "雨夜来客",
    });

    expect(await screen.findByLabelText("房间名")).toHaveValue("雨夜来客");
    expect(screen.getByText("雨夜来客")).toBeInTheDocument();
    expect(screen.queryByLabelText("发言策略")).not.toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "创建故事房" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "旁白" }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/projects/p-1/cocreate/sessions" &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        title: "雨夜来客",
        speakerPolicy: "natural",
        targetOutlineNodeId: "outline-1",
        authorPersonaId: AUTHOR.id,
        directorNote: null,
        contextTurns: 24,
        participantIds: [PERSONA.id],
        opening: null,
      });
    });
  });

  it("参与者编辑保留顺序、启停与 talkativeness", async () => {
    const detail = makeDetail("s-cast", "群像房", []);
    detail.participants = [
      participant("s-cast", PERSONA, 0, true, 0.2),
      participant("s-cast", CHARACTER, 1, false, 0.8),
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas") return json([PERSONA, CHARACTER]);
      if (url === "/api/projects/p-1/story-bible") return json(STORY_BIBLE);
      if (url === "/api/projects/p-1/cocreate/sessions") return json([detail.session]);
      if (url === "/api/cocreate/sessions/s-cast") return json(detail);
      if (
        url === "/api/cocreate/sessions/s-cast/participants" &&
        init?.method === "PUT"
      )
        return json(detail);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate();

    fireEvent.click(await screen.findByRole("checkbox", { name: "阿灯" }));
    fireEvent.click(screen.getByRole("button", { name: "将阿灯前移" }));
    fireEvent.click(screen.getByRole("button", { name: "保存角色安排" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/cocreate/sessions/s-cast/participants" &&
          init?.method === "PUT",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        expectedVersion: 1,
        participants: [
          { personaId: CHARACTER.id, enabled: true, talkativeness: 0.8 },
          { personaId: PERSONA.id, enabled: true, talkativeness: 0.2 },
        ],
      });
    });
  });

  it("达到八位启用角色后不能继续启用第九位", async () => {
    const extraPersonas = Array.from({ length: 9 }, (_, index) => ({
      ...CHARACTER,
      id: `persona-${index + 10}`,
      name: `角色${index + 1}`,
    }));
    const detail = makeDetail("s-limit", "八人房", []);
    detail.participants = extraPersonas
      .slice(0, 8)
      .map((persona, index) => participant("s-limit", persona, index));
    stubFetch([detail.session], { "s-limit": detail }, extraPersonas);
    renderCoCreate();

    expect(
      await screen.findByRole("checkbox", { name: "角色9" }),
    ).toBeDisabled();
    expect(screen.getByText("已启用 8/8 位 AI 角色")).toBeInTheDocument();
  });

  it("AI 回合用左右按钮切换回应版本，作者回合不显示再生成", async () => {
    const detail = makeDetail("s-swipe", "版本房", [
      makeTurn("s-swipe", "t-user", 0, "user", "推门。"),
      makeTurn("s-swipe", "t-ai", 1, "assistant", "风先涌进来。"),
    ]);
    detail.session.speakerPolicy = "natural";
    detail.turns[1]!.swipes = [
      makeSwipe("t-ai", "swipe-1", 0, "风先涌进来。", "selected"),
      makeSwipe("t-ai", "swipe-2", 1, "门后没有人。", "candidate"),
    ];
    detail.turns[1]!.selectedSwipeId = "swipe-1";
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas") return json([PERSONA]);
      if (url === "/api/projects/p-1/story-bible") return json(STORY_BIBLE);
      if (url === "/api/projects/p-1/cocreate/sessions") return json([detail.session]);
      if (url === "/api/cocreate/sessions/s-swipe") return json(detail);
      if (url === "/api/turns/t-ai/swipe-selection" && init?.method === "POST")
        return json(detail.turns[1]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate();

    const userCard = (await screen.findByText("#0 · 作者")).closest("article")!;
    const assistantCard = screen.getByText("#1 · 旁白").closest("article")!;
    expect(
      within(userCard).queryByRole("button", { name: "再生成回应" }),
    ).not.toBeInTheDocument();
    expect(within(assistantCard).getByText("1 / 2")).toBeInTheDocument();
    fireEvent.click(
      within(assistantCard).getByRole("button", { name: "下一个回应版本" }),
    );
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/turns/t-ai/swipe-selection" &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ swipeId: "swipe-2" });
    });
  });

  it("AI 回合显示实际进入上下文的世界书命中", async () => {
    const turn = makeTurn(
      "s-lore",
      "t-lore-1",
      1,
      "assistant",
      "盐粒在灯下连成潮线。",
    );
    turn.metadata = {
      loreActivation: {
        includedCount: 1,
        entries: [
          {
            entryId: "lore-entry-1",
            lorebookId: "lorebook-1",
            title: "煤油灯规则",
            scope: "persona",
            matchedKeys: ["煤油灯"],
            contextStatus: "included",
          },
        ],
      },
    };
    const detail = makeDetail("s-lore", "世界书房间", [turn]);
    stubFetch([detail.session], { "s-lore": detail });
    renderCoCreate("s-lore");

    const summary = await screen.findByText("本回合使用了 1 条世界信息");
    fireEvent.click(summary);
    expect(screen.getByText("煤油灯规则")).toBeVisible();
    expect(screen.getByText("命中：煤油灯")).toBeVisible();
  });

  it("消息上可直接建分支，并使用当前房间版本", async () => {
    const detail = DETAILS["s-a"]!;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas") return json([PERSONA]);
      if (url === "/api/projects/p-1/story-bible") return json(STORY_BIBLE);
      if (url === "/api/projects/p-1/cocreate/sessions") return json([detail.session]);
      if (url === "/api/cocreate/sessions/s-a") return json(detail);
      if (url === "/api/cocreate/sessions/s-a/branches" && init?.method === "POST")
        return json(detail.branches[0], 201);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate();

    const card = (await screen.findByText("#1 · 旁白")).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "从这里分支" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/cocreate/sessions/s-a/branches" &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        fromTurnId: "t-a-1",
        name: "从第 1 回合分支",
        expectedVersion: 1,
      });
    });
  });

  it("作者换一种说法时建立父节点分支，再追加新回合", async () => {
    const detail = makeDetail("s-rewrite", "改写房", [
      makeTurn("s-rewrite", "t-ai-0", 0, "assistant", "你终于来了。"),
      makeTurn("s-rewrite", "t-user-1", 1, "user", "我只是路过。"),
    ]);
    detail.session.authorPersonaId = AUTHOR.id;
    detail.turns[1]!.personaId = AUTHOR.id;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas") return json([PERSONA, AUTHOR]);
      if (url === "/api/projects/p-1/story-bible") return json(STORY_BIBLE);
      if (url === "/api/projects/p-1/cocreate/sessions") return json([detail.session]);
      if (url === "/api/cocreate/sessions/s-rewrite") return json(detail);
      if (
        url === "/api/cocreate/sessions/s-rewrite/branches" &&
        init?.method === "POST"
      )
        return json(detail.branches[0], 201);
      if (
        url === "/api/cocreate/sessions/s-rewrite/turns" &&
        init?.method === "POST"
      )
        return json({ turn: detail.turns[1], run: null }, 201);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate();

    const card = (await screen.findByText("#1 · 我")).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "换一种说法" }));
    fireEvent.change(within(card).getByLabelText("新的说法"), {
      target: { value: "我是来赴约的。" },
    });
    fireEvent.click(
      within(card).getByRole("button", { name: "建立改写分支" }),
    );

    await waitFor(() => {
      const branchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/cocreate/sessions/s-rewrite/branches" &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(branchCall?.[1]?.body))).toMatchObject({
        fromTurnId: "t-ai-0",
        expectedVersion: 1,
      });
      const turnCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/cocreate/sessions/s-rewrite/turns" &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(turnCall?.[1]?.body))).toMatchObject({
        role: "user",
        personaId: AUTHOR.id,
        content: "我是来赴约的。",
        generateReply: false,
      });
    });
    expect(screen.getByText("我只是路过。")).toBeInTheDocument();
  });

  it("点击两个回合选择连续范围，并从侧栏整理到目标场景", async () => {
    const detail = makeDetail("s-adopt", "雨夜试演", [
      makeTurn("s-adopt", "t-0", 0, "user", "敲门声响起。"),
      makeTurn("s-adopt", "t-1", 1, "assistant", "她没有开灯。"),
      makeTurn("s-adopt", "t-2", 2, "user", "谁在外面？"),
    ]);
    detail.session.targetOutlineNodeId = "outline-1";
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas") return json([PERSONA]);
      if (url === "/api/projects/p-1/story-bible") return json(STORY_BIBLE);
      if (url === "/api/projects/p-1/cocreate/sessions") return json([detail.session]);
      if (url === "/api/cocreate/sessions/s-adopt") return json(detail);
      if (
        url === "/api/cocreate/sessions/s-adopt/adoptions" &&
        init?.method === "POST"
      )
        return json({ run: { id: "run-adopt", status: "pending" } }, 202);
      if (url === "/api/runs/run-adopt?projectId=p-1")
        return json({ run: { id: "run-adopt", status: "completed" } });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "选择第 0 回合作为场景范围",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "选择第 2 回合作为场景范围" }),
    );
    expect(screen.getByText("已选择第 0–2 回合")).toBeInTheDocument();
    expect(screen.getByLabelText("场景标题")).toHaveValue("雨夜来客");
    fireEvent.click(screen.getByRole("button", { name: "采纳范围" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/cocreate/sessions/s-adopt/adoptions" &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        branchId: "branch-s-adopt",
        fromTurnId: "t-0",
        toTurnId: "t-2",
        title: "雨夜来客",
      });
    });
  });

  it("发送作者回合时绑定房间中的我的身份", async () => {
    const detail = makeDetail("s-author", "身份房", []);
    detail.session.authorPersonaId = AUTHOR.id;
    detail.session.speakerPolicy = "natural";
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas") return json([PERSONA, AUTHOR]);
      if (url === "/api/projects/p-1/story-bible") return json(STORY_BIBLE);
      if (url === "/api/projects/p-1/cocreate/sessions") return json([detail.session]);
      if (url === "/api/cocreate/sessions/s-author") return json(detail);
      if (
        url === "/api/cocreate/sessions/s-author/turns" &&
        init?.method === "POST"
      )
        return json(
          {
            turn: makeTurn("s-author", "t-new", 0, "user", "继续。"),
            run: null,
          },
          201,
        );
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate();

    fireEvent.change(await screen.findByPlaceholderText(/写下一回合/), {
      target: { value: "继续。" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送并生成回复/ }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/cocreate/sessions/s-author/turns" &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        role: "user",
        personaId: AUTHOR.id,
        content: "继续。",
        generateReply: true,
      });
    });
  });
});
