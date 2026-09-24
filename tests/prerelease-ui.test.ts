/**
 * Pre-release UI fixes: focus after completing a recurring task, Return in
 * destructive single-field forms, opening forms at their title, the patient
 * sheet's entry points, stable list order across devices, focus across a
 * banner-only redraw, pathway chips, task-type labels, and card layout rules.
 *
 * Synthetic data only; MRNs use the 9000 series.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { App } from "obsidian";
import type { ClinicalRepository } from "../src/data/repository";
import { taskTypeLabel } from "../src/domain/schema";
import type {
  ClinicalSnapshot,
  EpisodeRecord,
  PatientRecord,
  TaskRecord
} from "../src/domain/types";
import type { ClinicalService } from "../src/services/clinical-service";
import type { IntegrityService } from "../src/services/integrity";
import {
  ArchiveEpisodeModal,
  CancelTaskModal,
  NewTaskModal,
  PatientDetailModal,
  UpdateEpisodeModal
} from "../src/ui/modals";
import {
  ClinicalWorkspaceView,
  type ClinicalWorkspaceRecoveryHost
} from "../src/ui/workspace-view";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import {
  computedDeclarations,
  installTestDomGlobals,
  parseCssRules,
  TestElement
} from "./support/dom-harness";
import { Notice as StubNotice } from "./support/obsidian-stub";

installTestDomGlobals();
// esbuild defines this flag in real builds; the More tab reads it.
(globalThis as { __DEV_TOOLS__?: boolean }).__DEV_TOOLS__ = false;
// Obsidian's global fragment builder; the Undo notice is built with it.
(globalThis as { createFragment?: unknown }).createFragment = (build?: (fragment: TestElement) => void) => {
  const fragment = new TestElement("#document-fragment");
  build?.(fragment);
  return fragment;
};

const MRN_ALPHA = "9000000101";
const MRN_BETA = "9000000102";
const STAMP = "2026-09-01T08:00:00.000Z";

/* ------------------------------------------------------------ fixtures ----- */

function patient(id: string, overrides: Partial<PatientRecord> = {}): PatientRecord {
  return {
    schema_version: 3,
    entity: "patient",
    id,
    created_at: STAMP,
    updated_at: STAMP,
    tags: ["clinical/patient"],
    mrn: MRN_ALPHA,
    mrn_status: "confirmed",
    patient_name: "Synthetic Alpha",
    phone: "",
    phone_status: "not-found",
    status: "active",
    merged_into: "",
    ...overrides
  };
}

function episode(id: string, patientId: string, overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    schema_version: 3,
    entity: "episode",
    id,
    created_at: STAMP,
    updated_at: STAMP,
    tags: ["clinical/episode"],
    patient_id: patientId,
    patient: "",
    case: "Synthetic case",
    care_setting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    status: "active",
    next_action: "",
    due_date: "",
    opened_at: STAMP,
    closed_at: "",
    outcome: "",
    pathway_before_archive: "",
    status_before_archive: "",
    ...overrides
  };
}

function task(id: string, episodeId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schema_version: 3,
    entity: "task",
    id,
    created_at: STAMP,
    updated_at: STAMP,
    tags: ["clinical/task"],
    patient_id: "PAT-alpha",
    patient: "",
    episode_id: episodeId,
    episode: "",
    task: "Synthetic task",
    task_type: "clinical-review",
    status: "open",
    priority: "routine",
    due_date: "",
    owner: "",
    completed_at: "",
    cancelled_at: "",
    cancel_reason: "",
    idempotency_key: `key-${id}`,
    ...overrides
  };
}

function snapshotOf(parts: Partial<ClinicalSnapshot>): ClinicalSnapshot {
  return { patients: [], episodes: [], tasks: [], procedures: [], ...parts };
}

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await flush();
  }
  assert.fail(`timed out waiting for ${what}`);
}

/* ------------------------------------------------------------- harness ----- */

type WorkspaceTab = "today" | "patients" | "tasks" | "surgery" | "more";

type ViewInternals = {
  activeTab: WorkspaceTab;
  contentEl: HTMLElement;
  render: (snapshot: ClinicalSnapshot) => void;
  refresh: () => Promise<void>;
  syncWriteBlockBanner: () => void;
  patientPathwayFilter: string;
};

function createView(
  tab: WorkspaceTab,
  snapshot: ClinicalSnapshot | (() => ClinicalSnapshot | Promise<ClinicalSnapshot>),
  options: {
    repository?: Record<string, unknown>;
    service?: Record<string, unknown>;
    recovery?: ClinicalWorkspaceRecoveryHost;
  } = {}
): { root: TestElement; view: ViewInternals } {
  const root = new TestElement();
  const repository = {
    snapshot: async () => (typeof snapshot === "function" ? snapshot() : snapshot),
    getWriteBlockReason: () => null,
    list: async () => [],
    findById: async () => null,
    ...options.repository
  };
  const view = new ClinicalWorkspaceView(
    {} as never,
    repository as unknown as ClinicalRepository,
    (options.service ?? {}) as unknown as ClinicalService,
    {} as IntegrityService,
    () => DEFAULT_SETTINGS,
    options.recovery ?? null
  ) as unknown as ViewInternals;
  view.activeTab = tab;
  view.contentEl = root as unknown as HTMLElement;
  return { root, view };
}

function focusDocument(root: TestElement): { activeElement: TestElement | null; body: TestElement } {
  const document = { activeElement: null as TestElement | null, body: new TestElement("body") };
  (root as unknown as { ownerDocument: unknown }).ownerDocument = document;
  return document;
}

/** Records instances instead of opening them; the stub Modal has no open(). */
function captureOpen<T extends object>(modalClass: { prototype: T }): { opened: T[]; restore: () => void } {
  const prototype = modalClass.prototype as { open?: () => void };
  const original = Object.getOwnPropertyDescriptor(prototype, "open");
  const opened: T[] = [];
  prototype.open = function (this: T) {
    opened.push(this);
  };
  return {
    opened,
    restore: () => {
      if (original) Object.defineProperty(prototype, "open", original);
      else delete prototype.open;
    }
  };
}

type OpenableModal = {
  contentEl: HTMLElement;
  modalEl: HTMLElement;
  onOpen: () => void;
  close: () => void;
};

function openModal(modal: object): { content: TestElement } {
  const content = new TestElement();
  const target = modal as OpenableModal;
  target.contentEl = content as unknown as HTMLElement;
  target.modalEl = new TestElement() as unknown as HTMLElement;
  target.close = () => undefined;
  target.onOpen();
  return { content };
}

/** What the modal's keyboard layout sets while the iPhone keyboard is up. */
function keyboardOpen(modal: object): void {
  (modal as unknown as { modalEl: TestElement }).modalEl.addClass("is-virtual-keyboard-open");
}

function pressEnter(
  content: TestElement,
  target: TestElement,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}
): void {
  const event = {
    key: "Enter",
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
    target,
    preventDefault: () => undefined
  };
  for (const listener of content.listeners.get("keydown") ?? []) listener(event as unknown as Event);
}

function buttonNamed(root: TestElement, pattern: RegExp): TestElement {
  const button = root
    .findAll("button")
    .find((candidate) => pattern.test(candidate.getAttribute("aria-label") ?? candidate.textContent));
  assert.ok(button, `expected a button matching ${pattern}`);
  return button;
}

function buttonsNamed(root: TestElement, pattern: RegExp): TestElement[] {
  return root
    .findAll("button")
    .filter((candidate) => pattern.test(candidate.getAttribute("aria-label") ?? candidate.textContent));
}

/** Tracks blur() on a harness element, which the DOM harness does not model. */
function trackBlur(element: TestElement): () => number {
  let blurs = 0;
  (element as unknown as { blur: () => void }).blur = () => {
    blurs += 1;
    element.focused = false;
  };
  return () => blurs;
}

const stylesPromise = readFile(new URL("../styles.css", import.meta.url), "utf8");

/* ------------------------------------ focus after a recurring completion ----- */

test("completing a recurring task leaves focus on the title, not the next occurrence's Complete", async () => {
  const wording = "Synthetic daily wound check";
  const today = task("TSK-daily-1", "EPI-alpha", { task: wording, due_date: isoDaysFromToday(-1) });
  const next = task("TSK-daily-2", "EPI-alpha", { task: wording, due_date: isoDaysFromToday(0) });
  const parts = { patients: [patient("PAT-alpha")], episodes: [episode("EPI-alpha", "PAT-alpha")] };
  let current = snapshotOf({ ...parts, tasks: [today] });
  const completed: string[] = [];
  const service = {
    completeTask: async (id: string) => {
      completed.push(id);
      // The service writes the completion and creates the next occurrence.
      current = snapshotOf({ ...parts, tasks: [next] });
      return { path: "", record: { ...today, status: "completed", completed_at: new Date().toISOString() } };
    }
  };
  const { root, view } = createView("tasks", () => current, { service });
  const document = focusDocument(root);
  view.render(current);

  const complete = buttonNamed(root, /^Complete — /);
  document.activeElement = complete;
  const noticesBefore = StubNotice.history.length;
  complete.dispatch("click");
  await waitFor(() => StubNotice.history.length > noticesBefore, "the completion notice");
  await flush();
  await flush();

  const successors = buttonsNamed(root, /^Complete — /);
  assert.equal(successors.length, 1, "the next occurrence is listed");
  const successor = successors[0];
  assert.ok(successor);
  assert.notEqual(successor, complete);
  assert.equal(successor.focused, false, "a second keypress must not complete the next occurrence");
  assert.equal(root.find(".clinical-workspace-title")?.focused, true, "focus stays in the view");
  assert.deepEqual(completed, ["TSK-daily-1"]);

  // A control whose record is still listed gets focus back after a redraw.
  const reschedule = buttonNamed(root, /^Reschedule — /);
  document.activeElement = reschedule;
  view.render(current);
  const rebuilt = buttonNamed(root, /^Reschedule — /);
  assert.notEqual(rebuilt, reschedule);
  assert.equal(rebuilt.focused, true);
});

/* ---------------------------------- Return in destructive single-field forms ----- */

test("Return in the Discharge outcome hides the keyboard; only the button or Ctrl/Cmd+Enter archives", async () => {
  const archived: unknown[] = [];
  const modal = new ArchiveEpisodeModal(new App(), episode("EPI-alpha", "PAT-alpha"), async (request) => {
    archived.push(request);
  });
  const { content } = openModal(modal);
  await flush();
  const outcome = content.find("input");
  assert.ok(outcome);
  assert.equal(outcome.getAttribute("enterkeyhint"), "done");
  const blurs = trackBlur(outcome);
  // With a hardware keyboard there is nothing to hide: focus stays in the form.
  pressEnter(content, outcome);
  await flush();
  assert.equal(archived.length, 0, "one Return must not archive the episode");
  assert.equal(blurs(), 0, "no on-screen keyboard, so focus stays on the field");

  keyboardOpen(modal);
  pressEnter(content, outcome);
  await flush();
  assert.equal(archived.length, 0, "one Return must not archive the episode");
  assert.equal(blurs(), 1, "Return hides the on-screen keyboard instead");

  pressEnter(content, outcome, { ctrlKey: true });
  await flush();
  assert.equal(archived.length, 1, "Ctrl+Enter still submits");

  const again: unknown[] = [];
  const second = openModal(new ArchiveEpisodeModal(new App(), episode("EPI-alpha", "PAT-alpha"), async (request) => {
    again.push(request);
  }));
  await flush();
  const submit = second.content.findAll("button").find((button) => button.textContent === "Archive episode");
  assert.ok(submit);
  submit.dispatch("click");
  await flush();
  assert.equal(again.length, 1, "the explicit button still submits");
});

test("Return in the Cancel task reason hides the keyboard; Cmd+Enter cancels", async () => {
  const cancelled: string[] = [];
  const modal = new CancelTaskModal(new App(), task("TSK-one", "EPI-alpha"), async (reason) => {
    cancelled.push(reason);
  });
  const { content } = openModal(modal);
  await flush();
  const reason = content.find("input");
  assert.ok(reason);
  assert.equal(reason.getAttribute("enterkeyhint"), "done");
  const blurs = trackBlur(reason);
  keyboardOpen(modal);
  pressEnter(content, reason);
  await flush();
  assert.deepEqual(cancelled, [], "one Return must not cancel the task");
  assert.equal(blurs(), 1);

  pressEnter(content, reason, { metaKey: true });
  await flush();
  assert.equal(cancelled.length, 1);
});

/* --------------------------------------------- forms open at their title ----- */

test("a form focuses its first field without scrolling past its title", async () => {
  const calls: Array<{ element: TestElement; options: unknown }> = [];
  const prototype = TestElement.prototype as unknown as { focus: (options?: unknown) => void };
  const original = prototype.focus;
  prototype.focus = function (this: TestElement, options?: unknown) {
    calls.push({ element: this, options });
    original.call(this);
  };
  try {
    const { content } = openModal(new ArchiveEpisodeModal(
      new App(),
      episode("EPI-alpha", "PAT-alpha", { case: "Synthetic case with a long name ".repeat(6) }),
      async () => undefined
    ));
    await flush();
    const outcome = content.find("input");
    assert.ok(outcome?.focused);
    const opening = calls.find((call) => call.element === outcome);
    assert.deepEqual(opening?.options, { preventScroll: true });
  } finally {
    prototype.focus = original;
  }
});

/* ------------------------------------------------------ patient sheet ----- */

test("the ward round offers View only for patients with a sheet of their own", () => {
  const inpatient = { care_setting: "inpatient" as const };
  const snapshot = snapshotOf({
    patients: [
      patient("PAT-alpha"),
      patient("PAT-merging", { mrn: MRN_BETA, merge_in_progress: "PAT-alpha" } as Partial<PatientRecord>),
      patient("PAT-merged", { mrn: "9000000103", merged_into: "PAT-alpha" }),
      patient("PAT-retired", { mrn: "9000000104", status: "archived" })
    ],
    episodes: [
      episode("EPI-alpha", "PAT-alpha", { ...inpatient, case: "Synthetic a" }),
      episode("EPI-merging", "PAT-merging", { ...inpatient, case: "Synthetic b" }),
      episode("EPI-merged", "PAT-merged", { ...inpatient, case: "Synthetic c" }),
      episode("EPI-retired", "PAT-retired", { ...inpatient, case: "Synthetic d" })
    ]
  });
  const { root, view } = createView("today", snapshot);
  view.render(snapshot);
  const rows = root.findAll(".clinical-ward-row");
  assert.equal(rows.length, 4);
  const withView = rows.filter((row) => row.findAll("button").some((button) => button.textContent === "View"));
  assert.equal(withView.length, 1, "only the active, unmerged patient gets View");
  assert.ok(withView[0]?.textContent.includes("Synthetic a"));
  for (const row of rows) {
    assert.ok(row.findAll("button").some((button) => button.textContent === "Open"), "every row keeps Open");
  }
});

test("the patient sheet re-reads the patient and falls back to the note once a merge has started", async () => {
  const drawn = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha", { care_setting: "inpatient" })]
  });
  let current = drawn;
  const lookups: Array<[string, string]> = [];
  const { root, view } = createView("today", () => current, {
    repository: {
      findById: async (entity: string, id: string) => {
        lookups.push([entity, id]);
        return null;
      }
    }
  });
  view.render(drawn);
  const sheets = captureOpen(PatientDetailModal);
  try {
    // Corrected on another device since the row was drawn: the sheet shows
    // the fresh identity, not the one captured at render time.
    current = snapshotOf({
      ...drawn,
      patients: [patient("PAT-alpha", { patient_name: "Synthetic Corrected" })]
    });
    buttonNamed(root, /^View — /).dispatch("click");
    await waitFor(() => sheets.opened.length === 1, "the patient sheet");
    const data = (sheets.opened[0] as unknown as { data: { patient: PatientRecord } }).data;
    assert.equal(data.patient.patient_name, "Synthetic Corrected");

    // A merge started since the row was drawn: no sheet, the note opens.
    current = snapshotOf({
      ...drawn,
      patients: [patient("PAT-alpha", { merge_in_progress: "PAT-other" } as Partial<PatientRecord>)]
    });
    StubNotice.history.length = 0;
    buttonNamed(root, /^View — /).dispatch("click");
    await waitFor(() => lookups.length === 1, "the note lookup");
    await flush();
    assert.equal(sheets.opened.length, 1, "no sheet for a patient in a merge");
    assert.deepEqual(lookups, [["patient", "PAT-alpha"]]);
    for (const notice of StubNotice.history) {
      assert.doesNotMatch(String(notice.message), new RegExp(`${MRN_ALPHA}|Synthetic`), "no identifiers in a Notice");
    }
  } finally {
    sheets.restore();
  }
});

test("a double tap on the episode card's patient line opens one patient sheet", async () => {
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha")]
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { root, view } = createView("patients", async () => {
    await gate;
    return snapshot;
  });
  view.render(snapshot);
  const link = root.find(".clinical-card-patient-link");
  assert.ok(link);
  const sheets = captureOpen(PatientDetailModal);
  try {
    link.dispatch("click");
    link.dispatch("click");
    release();
    await waitFor(() => sheets.opened.length > 0, "the patient sheet");
    await flush();
    await flush();
    assert.equal(sheets.opened.length, 1);
    assert.equal(link.disabled, false, "the line is usable again once the sheet is open");
  } finally {
    sheets.restore();
  }
});

/* ---------------------------------------------------- stable list order ----- */

test("tied inpatients and tasks page the same way whatever order the vault lists them in", () => {
  const count = 45;
  const ids = Array.from({ length: count }, (_, index) => String(index).padStart(3, "0"));
  const episodes = ids.map((id) =>
    episode(`EPI-${id}`, "PAT-alpha", { care_setting: "inpatient", case: "Synthetic post-op review" })
  );
  const due = isoDaysFromToday(3);
  const tasks = ids.map((id) => task(`TSK-${id}`, `EPI-${id}`, { task: "Synthetic dressing", due_date: due }));
  const firstPage = (tab: WorkspaceTab, snapshot: ClinicalSnapshot, action: string): string[] => {
    const { root, view } = createView(tab, snapshot);
    view.render(snapshot);
    return root
      .findAll("button")
      .filter((button) => button.dataset.action === action)
      .map((button) => button.dataset.recordId ?? "");
  };
  const forward = snapshotOf({ patients: [patient("PAT-alpha")], episodes, tasks });
  const reversed = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [...episodes].reverse(),
    tasks: [...tasks].reverse()
  });
  const wardForward = firstPage("today", forward, "Open").filter((id) => id.startsWith("EPI-"));
  assert.ok(wardForward.length > 0 && wardForward.length < count, "the ward round is paged");
  assert.deepEqual(firstPage("today", reversed, "Open").filter((id) => id.startsWith("EPI-")), wardForward);
  const tasksForward = firstPage("tasks", forward, "Complete");
  assert.ok(tasksForward.length > 0 && tasksForward.length < count, "the task list is paged");
  assert.deepEqual(firstPage("tasks", reversed, "Complete"), tasksForward);
});

/* ------------------------------------------------- banner-only redraw ----- */

test("a banner-only redraw keeps focus that was on Recheck now", () => {
  let reason: string | null = "Editing is paused while Sync delivers changes.";
  const recovery: ClinicalWorkspaceRecoveryHost = {
    recordsMayBeIncomplete: () => false,
    recheck: async () => undefined
  };
  const snapshot = snapshotOf({});
  const { root, view } = createView("today", snapshot, {
    repository: { getWriteBlockReason: () => reason },
    recovery
  });
  const document = focusDocument(root);
  view.render(snapshot);
  const recheck = () => root.findAll("button").find((button) => button.textContent === "Recheck now");
  const first = recheck();
  assert.ok(first);

  // The reason changes: the rebuilt button takes focus.
  document.activeElement = first;
  reason = "Editing is paused until the record is repaired.";
  view.syncWriteBlockBanner();
  const rebuilt = recheck();
  assert.ok(rebuilt && rebuilt !== first);
  assert.equal(rebuilt.focused, true);

  // The barrier clears: focus goes to the workspace title.
  document.activeElement = rebuilt;
  reason = null;
  view.syncWriteBlockBanner();
  assert.equal(recheck(), undefined);
  assert.equal(root.find(".clinical-workspace-title")?.focused, true);

  // Focus elsewhere is left alone.
  const title = root.find(".clinical-workspace-title");
  assert.ok(title);
  title.focused = false;
  document.activeElement = new TestElement("input");
  reason = "Editing is paused while Sync delivers changes.";
  view.syncWriteBlockBanner();
  assert.equal(recheck()?.focused, false);
  assert.equal(title.focused, false);
});

/* ------------------------------------------------------- pathway chips ----- */

test("pathway chips are offered only for recognised pathways", () => {
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [
      episode("EPI-a", "PAT-alpha", { pathway: "assessment" }),
      episode("EPI-b", "PAT-alpha", { pathway: "or-booking" }),
      episode("EPI-c", "PAT-alpha", { pathway: "surgery" as EpisodeRecord["pathway"] })
    ]
  });
  const { root, view } = createView("patients", snapshot);
  view.render(snapshot);
  const row = root.find('[aria-label="Filter by pathway"]');
  assert.ok(row);
  const chips = row.findAll("button").map((button) => button.textContent);
  assert.deepEqual(chips, ["All pathways", "Assessment", "OR Booking"]);
  assert.ok(!chips.includes("Unknown pathway"), "Export list could not represent that filter");
  assert.equal(root.findAll("h4").length, 3, "the hand-edited episode stays listed under All pathways");
});

/* ---------------------------------------------------- task-type labels ----- */

test("task types read as clinicians write them", async () => {
  assert.equal(taskTypeLabel("book-or"), "Book OR");
  assert.equal(taskTypeLabel("postop-follow-up"), "Post-op Follow-Up");
  assert.equal(taskTypeLabel("clinical-review"), "Clinical Review");
  assert.equal(taskTypeLabel("hand-edited-type"), "Hand Edited Type", "unknown values keep the title-case rule");

  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha")],
    tasks: [
      task("TSK-a", "EPI-alpha", { task_type: "book-or" }),
      task("TSK-b", "EPI-alpha", { task_type: "clinical-review" })
    ]
  });
  const { root, view } = createView("tasks", snapshot);
  view.render(snapshot);
  const row = root.find('[aria-label="Filter by task type"]');
  assert.ok(row);
  assert.ok(row.findAll("button").some((button) => button.textContent === "Book OR"));

  // A hand-typed "Book OR" would render a second, identical-looking chip that
  // filters only half the tasks; only recognised types get a chip.
  const typed = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha")],
    tasks: [
      task("TSK-a", "EPI-alpha", { task_type: "book-or" }),
      task("TSK-c", "EPI-alpha", { task_type: "Book OR" as TaskRecord["task_type"] }),
      task("TSK-b", "EPI-alpha", { task_type: "clinical-review" })
    ]
  });
  view.render(typed);
  const labels = root
    .find('[aria-label="Filter by task type"]')
    ?.findAll("button")
    .map((button) => button.textContent);
  assert.deepEqual(labels, ["All types", "Book OR", "Clinical Review"]);

  const { content } = openModal(new NewTaskModal(new App(), episode("EPI-alpha", "PAT-alpha"), "Synthetic", async () => undefined));
  await flush();
  const options = content.findAll("OPTION").map((option) => option.textContent);
  assert.ok(options.includes("Book OR"), "the task-type dropdown uses the same label");
  assert.ok(!options.includes("Book Or"));
});

/* ---------------------------------------------------------- card layout ----- */

test("a card's status or date never shrinks to one glyph per line", async () => {
  const rules = parseCssRules(await stylesPromise);
  const phone = { width: 320, height: 568 };
  const top = computedDeclarations(rules, [".clinical-card-top"], phone);
  assert.equal(top.get("flex-wrap"), "wrap", "a long heading pushes the label onto its own line");
  const meta = computedDeclarations(rules, [".clinical-card-meta", ".clinical-card-top > .clinical-card-meta"], phone);
  assert.equal(meta.get("flex"), "0 0 auto", "the label keeps its own width");
  assert.equal(meta.get("max-width"), "100%", "and never overflows the card");
  const heading = computedDeclarations(rules, [".clinical-card-top > h4"], phone);
  assert.match(heading.get("flex") ?? "", /^1 1 /);
});

test("a lone card action spans the whole row on phones and in narrow panes", async () => {
  const rules = parseCssRules(await stylesPromise);
  const phone = { width: 320, height: 568 };
  const mobile = computedDeclarations(rules, [".is-mobile .clinical-card-actions > .clinical-card-button:only-child"], phone);
  assert.equal(mobile.get("grid-column"), "1 / -1");
  const narrow = computedDeclarations(rules, [".clinical-workspace-view.is-narrow .clinical-card-actions > .clinical-card-button:only-child"], phone);
  assert.equal(narrow.get("grid-column"), "1 / -1");
});

test("the discharge checkbox keeps its square; the label carries the touch target", async () => {
  const rules = parseCssRules(await stylesPromise);
  const checkbox = computedDeclarations(rules, [
    ".clinical-form-section input",
    ".clinical-confirm-check input[type=\"checkbox\"]"
  ]);
  assert.equal(checkbox.get("min-height"), "0");
  assert.equal(checkbox.get("block-size"), "20px");
  const label = computedDeclarations(rules, [".clinical-confirm-check"]);
  assert.equal(label.get("min-height"), "44px");
});

test("the Update form keeps a hand-typed priority, care setting and pathway instead of resetting them", async () => {
  const modal = new UpdateEpisodeModal(
    new App(),
    // Hand-typed values as the Properties panel stores them; the record types do not allow them.
    episode("EPI-typed", "PAT-typed", {
      priority: "Emergency",
      care_setting: " Inpatient ",
      pathway: "OR booking"
    } as unknown as Partial<EpisodeRecord>),
    async () => undefined
  );
  openModal(modal);
  await flush();
  const value = (modal as unknown as { value: () => { priority: string; careSetting: string; pathway: string } }).value();
  assert.equal(value.priority, "emergency", "saving the form must not lower an emergency to routine");
  assert.equal(value.careSetting, "inpatient");
  assert.equal(value.pathway, "or-booking");

  const unknown = new UpdateEpisodeModal(
    new App(),
    episode("EPI-unknown", "PAT-unknown", { priority: "whenever" } as unknown as Partial<EpisodeRecord>),
    async () => undefined
  );
  openModal(unknown);
  await flush();
  assert.equal(
    (unknown as unknown as { value: () => { priority: string } }).value().priority,
    "routine",
    "a value that matches no option still falls back"
  );
});
