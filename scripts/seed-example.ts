import { randomUUID } from "node:crypto";

import {
  createCanonEntity,
  createCanonFact,
  createDefaultPersonaCardProfile,
  createDocument,
  createOutlineNode,
  createProject,
  transitionProjectPhase,
} from "@narralume/domain";
import {
  SqliteCanonRepository,
  SqliteCreativeRepository,
  SqliteDeliveryRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";

import { readServerConfig } from "../apps/server/src/config.js";

const config = readServerConfig();
const database = new NodeNarrativeDatabase(config.databasePath);
database.migrate();

const projectId = "example-tidal-post-office";
const projects = new SqliteProjectRepository(database);
if (projects.get(projectId)) {
  process.stdout.write(`示例作品已存在：${projectId}\n`);
  database.close();
  process.exit(0);
}

const now = new Date().toISOString();
database.transaction(() => {
  let project = projects.insert(
    createProject({
      id: projectId,
      title: "回声邮局 · 示例",
      premise:
        "退潮时营业的邮局能把未寄出的信送到记忆消失之前；每寄一封，寄信人会失去一段相关记忆。",
      now,
    }),
  );
  for (const phase of ["foundation", "outlining", "writing"] as const) {
    project = projects.update(transitionProjectPhase(project, phase, now));
  }

  const story = new SqliteStoryRepository(database);
  story.upsertAuthorIntent({
    projectId,
    promise: "每一次取回记忆，都要让人物付出可见且不可逆的代价。",
    themes: ["记忆与责任", "失去与见证"],
    audience: "偏好人物驱动悬疑奇幻的成年读者",
    tone: "克制、潮湿、带有物证感",
    boundaries: ["不使用无代价复活", "不靠旁白解释超自然规则"],
    endingDirection: "沈砚选择保留他人的记忆，接受自己被遗忘。",
    currentFocus: "验证空白信受热显名的规则",
    lockedFields: ["promise", "boundaries"],
    updatedAt: now,
  });

  const canon = new SqliteCanonRepository(database);
  const hero = canon.insertEntity(
    createCanonEntity({
      id: "example-entity-shenyan",
      projectId,
      type: "character",
      name: "沈砚",
      description: "二十七岁的纸张修复师，先验证证据，再允许自己相信。",
      attributes: { pov: true, habit: "紧张时用指腹确认纸张边缘" },
      now,
    }),
  );
  const postOffice = canon.insertEntity(
    createCanonEntity({
      id: "example-entity-post-office",
      projectId,
      type: "location",
      name: "回声邮局",
      aliases: ["退潮邮局"],
      description: "只在退潮后的四十七分钟内开门。",
      now,
    }),
  );
  canon.insertFact(
    createCanonFact({
      id: "example-fact-hours",
      projectId,
      subjectId: postOffice.id,
      predicate: "营业窗口",
      value: "退潮后四十七分钟",
      authority: "locked",
      sourceType: "example-seed",
      now,
    }),
  );

  const root = story.insertOutlineNode(
    createOutlineNode({
      id: "example-outline-book",
      projectId,
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "回声邮局",
      now,
    }),
  );
  const chapter = story.insertOutlineNode(
    createOutlineNode({
      id: "example-outline-chapter-1",
      projectId,
      parent: root,
      kind: "chapter",
      ordinal: 0,
      title: "第一章 灯下潮痕",
      summary: "沈砚用煤油灯验证姐姐留下的空白信。",
      goal: "建立信纸受热显名的可复验规则",
      conflict: "每次显名都会抹去沈砚的一段相关记忆",
      povEntityId: hero.id,
      storyTime: "第 1 日 23:17",
      now,
    }),
  );
  story.updateOutlineStatus(projectId, chapter.id, "committed", now);

  const documents = new SqliteDocumentRepository(database);
  const document = documents.insert(
    createDocument({
      id: "example-document-chapter-1",
      projectId,
      kind: "chapter",
      title: "第一章 灯下潮痕",
      outlineNodeId: chapter.id,
      now,
    }),
  );
  documents.appendVersion(projectId, document.id, {
    id: randomUUID(),
    content:
      "沈砚把空白信移到煤油灯上方，没有立刻拆开。她先在桌角放了一小碟海盐，又用铜夹固定信封边缘。\n\n热气穿过纸纤维时，盐粒没有融化，反而沿着一道看不见的笔画缓慢析出。收件人的姓先浮出来：沈。\n\n她伸手去记姐姐写字时压低的手腕，却只摸到一片干净的空白。代价已经发生。",
    source: "example-seed",
    expectedCurrentVersionId: null,
    now,
  });

  const state = new SqliteNarrativeStateRepository(database, canon, story);
  state.insertRelationship({
    id: randomUUID(),
    projectId,
    fromEntityId: hero.id,
    toEntityId: postOffice.id,
    relation: "调查",
    intensity: 0.7,
    state: { trust: "conditional" },
    outlineNodeId: chapter.id,
    storyTime: "第 1 日 23:17",
    sourceId: "example-seed",
    supersedesEventId: null,
    createdAt: now,
  });
  state.insertTimelineEvent({
    id: "example-event-letter-reveals-name",
    projectId,
    title: "空白信在灯下显名",
    description: "盐粒沿隐形笔画析出，沈砚随即失去一段关于姐姐的动作记忆。",
    outlineNodeId: chapter.id,
    storyTimeStart: "第 1 日 23:17",
    storyTimeEnd: "第 1 日 23:19",
    sequence: 1,
    participants: [hero.id],
    causes: [],
    visibility: "reader",
    sourceId: "example-seed",
    createdAt: now,
    updatedAt: now,
  });
  state.insertForeshadow({
    id: "example-foreshadow-surname",
    projectId,
    title: "收件人与沈砚同姓",
    description: "信上只显出一个“沈”字，暗示收件人可能是被家族刻意抹去的人。",
    status: "planted",
    importance: 4,
    targetFromNodeId: chapter.id,
    targetToNodeId: null,
    dependencies: [],
    evidenceNodeIds: [chapter.id],
    resolutionNodeId: null,
    createdAt: now,
    updatedAt: now,
  });

  new SqliteCreativeRepository(database).insertPersona({
    id: "example-persona-narrator",
    projectId,
    kind: "narrator",
    entityId: null,
    name: "潮声旁白",
    description: "贴近沈砚的有限视角叙述者",
    instructions: "只写可感知的动作与物证，不替人物解释主题。",
    voice: { distance: "close-third", cadence: "restrained" },
    profile: createDefaultPersonaCardProfile(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    version: 0,
  });

  const delivery = new SqliteDeliveryRepository(database);
  delivery.insertStyleProfile({
    id: "example-style-evidence",
    projectId,
    name: "潮湿物证感",
    description: "让超自然规则通过可触摸、可复验的细节显现。",
    rules: ["动作先于解释", "每段只保留一个主意象", "规则出现时同步展示代价"],
    examples: ["盐粒沿着一道看不见的笔画缓慢析出。"],
    negativeRules: ["不堆叠形容词", "不让旁白宣布人物情绪"],
    source: "example-seed",
    active: true,
    status: "active",
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
  delivery.insertWritingSkill({
    id: "example-skill-rule-chain",
    projectId,
    name: "规则证据链",
    description: "建立动作、结果、代价三段式证据。",
    instructions:
      "每次揭示超自然规则时，必须同时写出人物动作、可观察结果与不可逆代价。",
    scopes: ["chapter", "cocreate", "review"],
    priority: 85,
    enabled: true,
    source: "example-seed",
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
});

database.close();
process.stdout.write(
  `示例作品已写入：${projectId}\n数据库：${config.databasePath}\n`,
);
