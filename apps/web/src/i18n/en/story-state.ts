import type { storyState as storyStateZh } from "../zh/story-state";
export const storyState: typeof storyStateZh = {
  title: "Chapter state",
  hint: "Inspect records through the end of this chapter, including its scenes, in manuscript order. These records help you check the story; they are not a line-by-line verification of the prose.",
  chapter: "Through chapter",
  audience: "Knowledge perspective",
  author: "Author overview",
  reader: "Reader",
  character: "Character · {name}",
  retired: "Retired",
  position: "Through the end of “{title}”",
  noChapters: "Add a chapter to inspect the story state by chapter.",
  unavailableChapter: "Selected chapter unavailable",
  unavailableCharacter: "Selected character unavailable",
  loadError: "Could not load chapter state",
  openChapterState: "View chapter state",
  knowledge: "Knowledge records",
  knowledgeOf: "Knowledge of {name}",
  knowledgeHint:
    "Each claim shows its latest recorded belief through this chapter. A fact changing does not mean a character learned the change. Belief, suspicion, and false belief do not establish truth.",
  noKnowledge:
    "No relevant knowledge is recorded through this chapter. This does not establish that the character or reader is unaware.",
  beliefs: {
    known: "Known",
    believed: "Believed",
    suspected: "Suspected",
    false_belief: "False belief",
  },
  falseBeliefHint:
    "This is a mistaken belief held by this person or reader, not an established fact.",
  learnedAt: "Recorded as learned at:",
  recordedAt: "Recorded at:",
  relationships: "Recorded relationships",
  relationshipsHint:
    "Active relationships recorded by the author, reconstructed at this chapter. A character view lists relationships involving that character; it does not establish either participant’s awareness.",
  noRelationships:
    "No relevant active relationships are recorded through this chapter.",
  intensity: "Intensity {value}",
  editRelationships: "Manage relationships",
  foreshadows: "Foreshadow plans and evidence",
  foreshadowsHint:
    "Plan status reflects the author’s current setting, not its historical status at this chapter. Evidence below is limited to nodes through this chapter; future plans are not past events.",
  noForeshadows: "No foreshadows are recorded.",
  currentPlan: "Current plan status:",
  evidence: "Clue evidence through this chapter:",
  noEvidence: "Not recorded",
  resolution: "Resolution evidence through this chapter:",
  noResolution: "Not recorded",
  editForeshadows: "Manage foreshadows",
  authorPlansHidden:
    "Foreshadow plans appear only in the author overview and are not treated as reader or character knowledge.",
  reference: "View accessible records · {facts} facts / {events} events",
  referenceHint:
    "Records filtered by visibility and chapter boundary. Records without a linked node are treated as global settings. Explicit reader and character knowledge is listed above.",
  facts: "Accessible facts",
  noFacts: "No other accessible facts.",
  editFacts: "Manage facts",
  validFrom: "Effective from:",
  events: "Accessible events",
  noEvents: "No accessible events.",
  editEvents: "Manage events",
  noNode: "No linked node",
  unavailableEvidence: "Linked node unavailable",
};
