import type { knowledge as zh } from "../zh/knowledge";
export const knowledge: typeof zh = {
  manage: "Register and correct knowledge",
  title: "Author knowledge maintenance",
  hint: "This view includes all book records, future chapters and revision history, regardless of the perspective above. Records inform chapter inspection and future generation; they do not edit prose or facts.",
  add: "Register knowledge change",
  addHint:
    "Record where a reader or character learns, believes or suspects an existing claim. Register later changes separately; backdated entries retain later knowledge.",
  correct: "Correct registration",
  correctHint:
    "Correct a registration error for the affected chapters. The original and reason remain in history. To change the knower or claim, withdraw this record and register a new one.",
  withdraw: "Withdraw registration",
  withdrawHint:
    "Withdrawing an incorrect entry may expose earlier valid knowledge. This does not represent forgetting in the story and does not withdraw facts or prose.",
  knower: "Whose knowledge",
  claim: "Knowledge claim",
  chooseClaim: "Select an existing fact or event",
  facts: "Facts (including past versions)",
  events: "Events",
  belief: "Belief state",
  node: "Learning evidence node",
  nodeHint:
    "Choose a committed chapter or one of its scenes. Uncommitted plans are not evidence of events that happened.",
  chooseNode: "Select a committed chapter or scene",
  noNodes:
    "No committed chapters are available. Commit the relevant chapter first.",
  reason: "Reason for correction or withdrawal",
  save: "Save knowledge registration",
  saved:
    "Knowledge saved. Chapter inspection and future generation will use the updated records.",
  saveError: "Could not save knowledge",
  loadError: "Could not load knowledge maintenance records",
  reload: "Discard changes and reload",
  conflictHint:
    "Your input is preserved. Copy anything you want to keep, then reload and review the other changes.",
  history: "Book registrations and revision history",
  allKnowers: "All knowers",
  filter: "Filter by knower",
  empty: "No registrations match this filter.",
  active: "Valid registration",
  corrected: "Corrected",
  withdrawn: "Withdrawn",
  unavailable: "Claim withdrawn or unavailable",
  manual: "Manual registration",
  automatic: "Registered during creation",
  recorded: "Recorded: {time}",
  revised: "Revised: {time}",
  replacement: "Corrected to: {belief} · {node}",
};
