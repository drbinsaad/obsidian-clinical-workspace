/**
 * UI, mobile and accessibility review fixes: form Return-key behaviour,
 * focus across redraws, card action layout, ward-round paging, Today order,
 * date defaults, patient sheet entry points, filters, paging scroll, search
 * folding, modal safe areas, identity inputs, RTL isolation, contrast,
 * accessible names, audit times, the identity label of a patient with no
 * MRN, and statuses shown in words.
 *
 * Synthetic data only; MRNs use the 9000 series.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { App } from "obsidian";
import type { ClinicalRepository } from "../src/data/repository";
import type { TaskBundle } from "../src/data/templates";
import { formatLocalDateTime, isoDateWithOffset, todayIso } from "../src/domain/schema";
import type {
  ClinicalSnapshot,
  CompleteProcedureInput,
  EpisodeRecord,
  EventRecord,
  PatientRecord,
  TaskRecord
} from "../src/domain/types";
import type { ClinicalService } from "../src/services/clinical-service";
import { buildHandoverNote } from "../src/services/handover";
import type { IntegrityService } from "../src/services/integrity";
import {
  ApplyTemplateModal,
  ArchiveEpisodeModal,
  CancelTaskModal,
  ClinicalSearchModal,
  DuplicatePatientModal,
  EpisodeHistoryModal,
  IntegrityReportModal,
  MrnOwnerConflictModal,
  NewEpisodeModal,
  NewTaskModal,
  PatientDetailModal,
  ProcedureModal,
  QuickEntryEpisodeModal,
  RescheduleTaskModal,
  UpdateEpisodeModal,
  patientIdentityLabel,
  type QuickEntryEpisodeChoice
} from "../src/ui/modals";
import { CLINICAL_PAGE_SIZE, ClinicalWorkspaceView } from "../src/ui/workspace-view";
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

function auditEvent(id: string, createdAt: string): EventRecord {
  return {
    schema_version: 3,
    entity: "event",
    id,
    created_at: createdAt,
    updated_at: createdAt,
    tags: ["clinical/event"],
    action: "task-completed",
    actor: "Synthetic clinician",
    patient_id: "PAT-alpha",
    episode_id: "EPI-alpha",
    target_id: "TSK-alpha",
    target_entity: "task",
    summary: "Synthetic audit entry",
    previous_state: "open",
    new_state: "completed"
  };
}

function snapshotOf(parts: Partial<ClinicalSnapshot>): ClinicalSnapshot {
  return { patients: [], episodes: [], tasks: [], procedures: [], ...parts };
}

/** Arabic-Indic digits for an ASCII digit string, as the iPhone Arabic keyboard types them. */
function arabicIndic(digits: string): string {
  return digits.replace(/\d/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------- harness ----- */

type WorkspaceTab = "today" | "patients" | "tasks" | "surgery" | "more";

type ViewInternals = {
  activeTab: WorkspaceTab;
  contentEl: HTMLElement;
  render: (snapshot: ClinicalSnapshot) => void;
  refresh: () => Promise<void>;
  taskTypeFilter: string;
  taskPriorityFilter: string;
  patientPathwayFilter: string;
  patientPriorityFilter: string;
  pendingPageContext: { scrollTop: number } | null;
  selectListPage: (key: string, page: number, action: "previous" | "next", keyboard: boolean) => void;
  openReschedule: (task: TaskRecord) => void;
  openSearch: () => Promise<void>;
};

function createView(
  tab: WorkspaceTab,
  snapshot: ClinicalSnapshot,
  options: { repository?: Record<string, unknown>; service?: Record<string, unknown> } = {}
): { root: TestElement; view: ViewInternals } {
  const root = new TestElement();
  const repository = {
    snapshot: async () => snapshot,
    getWriteBlockReason: () => null,
    list: async () => [],
    findById: async () => null,
    ...options.repository
  };
  const view = new ClinicalWorkspaceView(
    {} as never,
    repository as unknown as ClinicalRepository,
    (options.service ?? {}) as unknown as ClinicalService,
    {} as IntegrityService
  ) as unknown as ViewInternals;
  view.activeTab = tab;
  view.contentEl = root as unknown as HTMLElement;
  return { root, view };
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

function openModal(modal: object): { content: TestElement; closes: () => number } {
  const content = new TestElement();
  const target = modal as OpenableModal;
  target.contentEl = content as unknown as HTMLElement;
  target.modalEl = new TestElement() as unknown as HTMLElement;
  let closes = 0;
  target.close = () => {
    closes += 1;
  };
  target.onOpen();
  return { content, closes: () => closes };
}

function pressEnter(
  content: TestElement,
  target: TestElement,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}
): boolean {
  let prevented = false;
  const event = {
    key: "Enter",
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
    target,
    preventDefault: () => {
      prevented = true;
    }
  };
  for (const listener of content.listeners.get("keydown") ?? []) listener(event as unknown as Event);
  return prevented;
}

function buttonNamed(root: TestElement, pattern: RegExp): TestElement {
  const button = root
    .findAll("button")
    .find((candidate) => pattern.test(candidate.getAttribute("aria-label") ?? candidate.textContent));
  assert.ok(button, `expected a button matching ${pattern}`);
  return button;
}

/** The list rendered directly under a section header, for a paged list key. */
function listUnder(root: TestElement, pageKey: string): TestElement {
  const header = root.find(`[data-page-section="${pageKey}"]`);
  assert.ok(header?.parent, `expected a ${pageKey} header`);
  const siblings = header.parent.children;
  const list = siblings.slice(siblings.indexOf(header) + 1).find((child) => child.classes.has("clinical-list"));
  assert.ok(list, `expected a list under ${pageKey}`);
  return list;
}

const stylesPromise = readFile(new URL("../styles.css", import.meta.url), "utf8");

/* ------------------------------------------------ 1. Return key in forms ----- */

test("Return on the first procedure field moves on instead of logging the surgery", async () => {
  const submitted: CompleteProcedureInput[] = [];
  const modal = new ProcedureModal(new App(), episode("EPI-alpha", "PAT-alpha", { case: "Synthetic booking" }),
    patientIdentityLabel(MRN_ALPHA, "Synthetic Alpha"), async (input) => {
      submitted.push(input);
    });
  const { content } = openModal(modal);
  await flush();
  // Obsidian's toggle carries a hidden checkbox input; Return must never land on it.
  const hiddenToggleInput = content.find(".checkbox-container")?.find("input");
  assert.ok(hiddenToggleInput, "the stub renders Obsidian's toggle DOM");
  const [procedureName, surgeryDate, outcome, followUpDate, followUpPlan] = content
    .findAll("input")
    .filter((input) => input !== hiddenToggleInput);
  assert.ok(procedureName && surgeryDate && outcome && followUpDate && followUpPlan);
  assert.equal(procedureName.focused, true, "the first field takes focus");

  assert.equal(pressEnter(content, procedureName), true, "Return is handled, not left to the browser");
  await flush();
  assert.equal(submitted.length, 0, "one Return after the procedure name must not write the procedure");
  assert.equal(surgeryDate.focused, true, "Return moves to the next field");

  assert.equal(procedureName.getAttribute("enterkeyhint"), "next");
  assert.equal(outcome.getAttribute("enterkeyhint"), "done", "the last visible text field submits");
  assert.equal(followUpDate.getAttribute("enterkeyhint"), null, "date fields have no Return key");

  // Showing the follow-up fields makes the plan the last text field.
  const toggle = content.find(".checkbox-container");
  assert.ok(toggle);
  toggle.dispatch("click");
  content.dispatch("focusin");
  assert.equal(outcome.getAttribute("enterkeyhint"), "next");
  assert.equal(followUpPlan.getAttribute("enterkeyhint"), "done");
  pressEnter(content, outcome);
  await flush();
  assert.equal(submitted.length, 0);
  assert.equal(hiddenToggleInput.focused, false, "a second Return there would switch follow-up off");
  assert.equal(followUpDate.focused, true);

  pressEnter(content, followUpPlan);
  await flush();
  assert.equal(submitted.length, 1, "Return on the last text field submits");
});

test("Ctrl or Cmd+Return submits from any field; other forms move on too", async () => {
  const submitted: unknown[] = [];
  const procedure = new ProcedureModal(new App(), episode("EPI-alpha", "PAT-alpha"), "Synthetic", async (input) => {
    submitted.push(input);
  });
  const { content } = openModal(procedure);
  await flush();
  const first = content.find("input");
  assert.ok(first);
  pressEnter(content, first, { metaKey: true });
  await flush();
  assert.equal(submitted.length, 1);

  const created: unknown[] = [];
  const taskForm = new NewTaskModal(new App(), episode("EPI-alpha", "PAT-alpha"), "Synthetic", async (input) => {
    created.push(input);
  });
  const opened = openModal(taskForm);
  await flush();
  const taskText = opened.content.find("input");
  assert.ok(taskText);
  pressEnter(opened.content, taskText);
  await flush();
  assert.equal(created.length, 0, "Return after the task text must not file the task with default fields");
});

/* ---------------------------------------------- 2. Focus across redraws ----- */

function focusDocument(root: TestElement): { activeElement: TestElement | null; body: TestElement } {
  const document = { activeElement: null as TestElement | null, body: new TestElement("body") };
  (root as unknown as { ownerDocument: unknown }).ownerDocument = document;
  return document;
}

test("a redraw hands focus back to the rebuilt control, and only when focus was in the view", () => {
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha")],
    tasks: [task("TSK-one", "EPI-alpha", { task: "Synthetic dressing" })]
  });
  const { root, view } = createView("tasks", snapshot);
  const document = focusDocument(root);
  view.render(snapshot);

  const reschedule = buttonNamed(root, /^Reschedule — /);
  document.activeElement = reschedule;
  view.render(snapshot);
  const rebuilt = buttonNamed(root, /^Reschedule — /);
  assert.notEqual(rebuilt, reschedule, "the redraw replaced the control");
  assert.equal(rebuilt.focused, true, "Sync redraws must not drop keyboard focus to the body");

  // A tab keeps focus when activated; the rebuilt tab is found by its id.
  const tab = root.findAll("button").find((button) => button.textContent === "Today");
  assert.ok(tab);
  document.activeElement = tab;
  view.activeTab = "today";
  view.render(snapshot);
  const today = root.findAll("button").find((button) => button.textContent === "Today");
  assert.ok(today && today !== tab);
  assert.equal(today.focused, true);

  // When the control went with its record, focus stays in the view.
  view.activeTab = "tasks";
  view.render(snapshot);
  document.activeElement = buttonNamed(root, /^Complete — /);
  view.render({ ...snapshot, tasks: [] });
  assert.equal(root.find(".clinical-workspace-title")?.focused, true);

  // Focus in the editor or a form: a background redraw leaves it alone.
  document.activeElement = new TestElement("input");
  view.render(snapshot);
  assert.equal(root.findAll("button").some((button) => button.focused), false);
  assert.equal(root.find(".clinical-workspace-title")?.focused, false);
});

/* ---------------------------------------------- 3. Card action layout ----- */

test("task cards emit Complete first and pair the rest, with no dense packing", async () => {
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha")],
    tasks: [task("TSK-one", "EPI-alpha"), task("TSK-orphan", "EPI-missing")]
  });
  const { root, view } = createView("tasks", snapshot);
  view.render(snapshot);
  const rows = root.findAll(".clinical-card-actions").map((actions) =>
    actions.children.map((button) => ({
      label: button.textContent,
      cta: button.classes.has("mod-cta"),
      danger: button.classes.has("is-danger")
    }))
  );
  const withEpisode = rows.find((buttons) => buttons.length === 5);
  const orphan = rows.find((buttons) => buttons.length === 4);
  assert.deepEqual(withEpisode?.map((button) => button.label), ["Complete", "Reschedule", "+ Task", "Open", "Cancel"]);
  assert.deepEqual(orphan?.map((button) => button.label), ["Complete", "Reschedule", "Open", "Cancel"]);

  const rules = parseCssRules(await stylesPromise);
  const phone = { width: 390, height: 844 };
  const spanning = (selector: string): boolean =>
    computedDeclarations(rules, [selector], phone).get("grid-column") === "1 / -1";
  for (const scope of [".is-mobile .clinical-card-actions", ".clinical-workspace-view.is-narrow .clinical-card-actions"]) {
    assert.equal(spanning(`${scope} > .mod-cta:first-child ~ .clinical-card-button:last-child:nth-child(even)`), true);
    assert.equal(
      spanning(`${scope} > .clinical-card-button:first-child:not(.mod-cta) ~ .clinical-card-button:last-child:nth-child(odd)`),
      true
    );
  }
  assert.equal(spanning(".is-mobile .clinical-card-actions .clinical-card-button.is-danger"), false);
  assert.ok(rules.every((rule) => rule.declarations.get("grid-auto-flow") !== "dense"),
    "dense packing would put visual order out of step with focus order");
  for (const selector of [
    ".is-mobile .clinical-card-actions .clinical-card-button",
    ".clinical-workspace-view.is-narrow .clinical-card-button"
  ]) {
    assert.equal(computedDeclarations(rules, [selector], phone).get("overflow-wrap"), "break-word");
  }

  // Sparse two-column auto-placement under those rules: no half-empty rows.
  const place = (buttons: Array<{ cta: boolean }>): number[][] => {
    const rows: Array<{ cells: number[]; full: boolean }> = [];
    const firstIsCta = buttons[0]?.cta === true;
    buttons.forEach((button, index) => {
      const position = index + 1;
      const lone = index === buttons.length - 1 && index > 0 &&
        (firstIsCta ? position % 2 === 0 : position % 2 === 1);
      const spans = button.cta || lone;
      const open = rows.at(-1);
      if (!spans && open && !open.full && open.cells.length === 1) open.cells.push(index);
      else rows.push({ cells: [index], full: spans });
    });
    return rows.map((row) => row.cells);
  };
  assert.deepEqual(place(withEpisode ?? []), [[0], [1, 2], [3, 4]],
    "three full rows: Complete / Reschedule + Task / Open + Cancel, with Complete and Cancel apart");
  assert.deepEqual(place(orphan ?? []), [[0], [1, 2], [3]], "a lone final button fills its row");
});

/* ---------------------------------------------- 4. Ward round paging ----- */

test("the ward round pages instead of silently stopping at 30", () => {
  const total = CLINICAL_PAGE_SIZE + 5;
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: Array.from({ length: total }, (_value, index) =>
      episode(`EPI-${String(index).padStart(3, "0")}`, "PAT-alpha", {
        care_setting: "inpatient",
        case: `Synthetic ward case ${index}`
      }))
  });
  const { root, view } = createView("today", snapshot);
  view.render(snapshot);
  assert.equal(root.findAll(".clinical-ward-row").length, CLINICAL_PAGE_SIZE);
  const header = root.find('[data-page-section="today-ward"]');
  assert.match(header?.textContent ?? "", new RegExp(`${total} inpatients`));
  const pager = root.find('[data-page-key="today-ward"]');
  assert.ok(pager, "the ward round gets its own pager");
  assert.equal(pager.getAttribute("aria-label"), "Ward round pages");
  assert.match(pager.textContent, new RegExp(`Page 1 of 2 · ${total} total`));
});

/* ---------------------------------------------- 5. Today order ----- */

test("Today, Overdue and No date lists are ordered by priority, then date, then wording", () => {
  const today = todayIso();
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha")],
    tasks: [
      task("TSK-c", "EPI-alpha", { task: "Routine today", priority: "routine", due_date: today }),
      task("TSK-a", "EPI-alpha", { task: "Emergency today", priority: "emergency", due_date: today }),
      task("TSK-b", "EPI-alpha", { task: "Urgent today", priority: "urgent", due_date: today }),
      task("TSK-d", "EPI-alpha", { task: "Urgent recent", priority: "urgent", due_date: isoDateWithOffset(-1) }),
      task("TSK-e", "EPI-alpha", { task: "Urgent oldest", priority: "urgent", due_date: isoDateWithOffset(-6) }),
      task("TSK-f", "EPI-alpha", { task: "Routine overdue", priority: "routine", due_date: isoDateWithOffset(-9) }),
      task("TSK-h", "EPI-alpha", { task: "Same wording", priority: "routine", owner: "Owner H" }),
      task("TSK-g", "EPI-alpha", { task: "Same wording", priority: "routine", owner: "Owner G" }),
      task("TSK-i", "EPI-alpha", { task: "Emergency undated", priority: "emergency" })
    ]
  });
  const { root, view } = createView("today", snapshot);
  view.render(snapshot);
  const titles = (key: string): string[] => listUnder(root, key).findAll("h4").map((heading) => heading.textContent);
  assert.deepEqual(titles("today-due"), ["Emergency today", "Urgent today", "Routine today"]);
  assert.deepEqual(titles("today-overdue"), ["Urgent oldest", "Urgent recent", "Routine overdue"]);
  assert.deepEqual(titles("today-undated"), ["Emergency undated", "Same wording", "Same wording"]);
  // Equal priority and wording: the id decides, identically on every device.
  const owners = (container: TestElement): string[] =>
    listUnder(container, "today-undated").findAll(".clinical-badge").filter((badge) => badge.classes.has("is-owner")).map((badge) => badge.textContent);
  assert.deepEqual(owners(root), ["Owner G", "Owner H"]);
  const reversedSnapshot = { ...snapshot, tasks: [...snapshot.tasks].reverse() };
  const reversed = createView("today", reversedSnapshot);
  reversed.view.render(reversedSnapshot);
  assert.deepEqual(owners(reversed.root), ["Owner G", "Owner H"]);
});

/* ---------------------------------------------- 6. Date defaults ----- */

test("a new task defaults to the later of the episode date and today", () => {
  const valueOf = (dueDate: string): string =>
    (new NewTaskModal(new App(), episode("EPI-alpha", "PAT-alpha", { due_date: dueDate }), "Synthetic", async () => undefined) as unknown as {
      value: () => { dueDate: string };
    }).value().dueDate;
  assert.equal(valueOf(isoDateWithOffset(-3)), todayIso(), "an overdue episode date must not file new work overdue");
  assert.equal(valueOf(isoDateWithOffset(5)), isoDateWithOffset(5), "a planned future date is kept");
  assert.equal(valueOf(""), todayIso());
  assert.equal(valueOf("not a date"), todayIso());
});

test("date chips offer Today, +1d and +2d, and a past date is named before submit", async () => {
  const modal = new UpdateEpisodeModal(
    new App(),
    episode("EPI-alpha", "PAT-alpha", { due_date: isoDateWithOffset(-3) }),
    async () => undefined
  );
  const { content } = openModal(modal);
  await flush();
  const chips = content.find(".clinical-date-chips");
  assert.deepEqual(chips?.children.map((chip) => chip.textContent), ["Today", "+1d", "+2d", "+1w", "+2w", "+1m", "+3m"]);
  const hint = content.find(".clinical-date-hint");
  assert.equal(hint?.textContent, "This date is in the past.");
  const dateInput = content.findAll("input").find((input) => (input as unknown as { type: string }).type === "date");
  assert.ok(dateInput && hint);
  assert.equal(dateInput.getAttribute("aria-describedby"), hint.getAttribute("id"));

  const tomorrow = chips?.children.find((chip) => chip.textContent === "+1d");
  tomorrow?.dispatch("click");
  assert.equal(dateInput.value, isoDateWithOffset(1));
  assert.equal(hint.textContent, "", "the hint clears once the date is not in the past");
  assert.equal(
    (modal as unknown as { value: () => { dueDate: string } }).value().dueDate,
    isoDateWithOffset(1)
  );

  // The surgery date looks back, so it gets neither chips nor the hint.
  const procedure = openModal(new ProcedureModal(new App(), episode("EPI-alpha", "PAT-alpha"), "Synthetic", async () => undefined));
  await flush();
  assert.equal(procedure.content.findAll(".clinical-date-hint").length, 1, "only the follow-up date has the hint");
});

test("Reschedule starts at tomorrow and says when the date did not change", async () => {
  const current = task("TSK-one", "EPI-alpha", { due_date: isoDateWithOffset(-2), updated_at: STAMP });
  const form = new RescheduleTaskModal(new App(), current, async () => undefined) as unknown as { value: () => string };
  assert.equal(form.value(), isoDateWithOffset(1));

  let stored: TaskRecord = current;
  const snapshot = snapshotOf({ patients: [patient("PAT-alpha")], episodes: [episode("EPI-alpha", "PAT-alpha")], tasks: [current] });
  const { view } = createView("tasks", snapshot, {
    service: {
      rescheduleTask: async (_id: string, dueDate: string) => {
        if (dueDate !== stored.due_date) stored = { ...stored, due_date: dueDate, updated_at: "2026-09-23T09:00:00.000Z" };
        return { path: "synthetic.md", record: stored };
      }
    }
  });
  const forms = captureOpen(RescheduleTaskModal);
  try {
    view.openReschedule(current);
    const opened = forms.opened[0] as unknown as { onSubmit: (value: string) => Promise<void> };
    assert.ok(opened);
    await opened.onSubmit(current.due_date);
    assert.equal(StubNotice.history.at(-1)?.message, "Date unchanged.", "re-saving the same date is not a move");
    await opened.onSubmit(isoDateWithOffset(1));
    assert.equal(StubNotice.history.at(-1)?.message, `Task moved to ${isoDateWithOffset(1)}.`);
  } finally {
    forms.restore();
  }
});

/* ------------------------------- 7. Patient sheet from the round and search ----- */

test("ward rows and patient search open the patient sheet; the note stays one tap away", async () => {
  const alpha = patient("PAT-alpha");
  const merged = patient("PAT-merged", { mrn: MRN_BETA, patient_name: "Synthetic Merged", merged_into: "PAT-alpha" });
  const snapshot = snapshotOf({
    patients: [alpha, merged],
    episodes: [episode("EPI-alpha", "PAT-alpha", { care_setting: "inpatient", case: "Synthetic airway watch" })]
  });
  const { root, view } = createView("today", snapshot);
  view.render(snapshot);
  const row = root.find(".clinical-ward-row");
  assert.ok(row);
  assert.deepEqual(row.findAll("button").map((button) => button.textContent), ["View", "Open"]);

  const sheets = captureOpen(PatientDetailModal);
  const searches = captureOpen(ClinicalSearchModal);
  try {
    buttonNamed(row, /^View — /).dispatch("click");
    await flush();
    assert.equal(sheets.opened.length, 1);
    assert.equal((sheets.opened[0] as unknown as { data: { patient: PatientRecord } }).data.patient.id, "PAT-alpha");

    await view.openSearch();
    const search = searches.opened[0] as unknown as { onOpenRecord: (entity: string, id: string) => void };
    assert.ok(search);
    search.onOpenRecord("patient", "PAT-alpha");
    await flush();
    assert.equal(sheets.opened.length, 2, "a patient result opens the sheet, not the note");

    StubNotice.history.length = 0;
    search.onOpenRecord("patient", "PAT-merged");
    await flush();
    assert.equal(sheets.opened.length, 2, "a merged patient has no sheet of its own");
    assert.equal(StubNotice.history.at(-1)?.message, "That record could not be found.", "it falls back to the note lookup");
  } finally {
    sheets.restore();
    searches.restore();
  }
});

test("the patient sheet completes or reschedules open work by closing and handing over", () => {
  const openTask = task("TSK-one", "EPI-alpha", { task: "Synthetic drain review" });
  const completed: string[] = [];
  const rescheduled: string[] = [];
  const modal = new PatientDetailModal(
    new App(),
    { patient: patient("PAT-alpha"), episodes: [], tasks: [openTask], procedures: [], events: [] },
    () => undefined,
    () => undefined,
    {
      complete: (item) => completed.push(item.id),
      reschedule: (item) => rescheduled.push(item.id)
    }
  );
  const { content, closes } = openModal(modal);
  buttonNamed(content, /^Complete task /).dispatch("click");
  assert.equal(closes(), 1, "the sheet closes before the action, so it never shows stale work");
  assert.deepEqual(completed, ["TSK-one"]);
  buttonNamed(content, /^Reschedule task /).dispatch("click");
  assert.deepEqual(rescheduled, ["TSK-one"]);
});

/* ---------------------------------------------- 8. Filters that hide everything ----- */

test("a task-type filter keeps its chip and the empty list offers Clear filters", async () => {
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha")],
    tasks: [task("TSK-one", "EPI-alpha", { task_type: "clinical-review" })]
  });
  const { root, view } = createView("tasks", snapshot);
  view.taskTypeFilter = "wound-care";
  view.render(snapshot);
  const active = root.findAll(".clinical-chip.is-active").map((chip) => chip.textContent);
  assert.ok(active.includes("Wound Care"), "the filter that hides the list stays visible");
  assert.match(root.find(".clinical-empty")?.textContent ?? "", /No open tasks match these filters\./);

  buttonNamed(root, /^Clear filters — /).dispatch("click");
  await flush();
  assert.equal(view.taskTypeFilter, "all");
  assert.equal(view.taskPriorityFilter, "all");
  assert.equal(root.findAll(".clinical-card").length, 1, "the task is listed again");
});

test("Patients-tab filters that hide a care setting say so and can be cleared", async () => {
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha", { care_setting: "inpatient", priority: "routine" })]
  });
  const { root, view } = createView("patients", snapshot);
  view.patientPriorityFilter = "emergency";
  view.render(snapshot);
  const empties = root.findAll(".clinical-empty").map((element) => element.textContent);
  assert.ok(empties.some((text) => text.startsWith("No inpatients match these filters.")));
  assert.ok(empties.includes("No patients in this care setting."), "an unfiltered empty list keeps its wording");
  buttonNamed(root, /^Clear filters — show every inpatient$/).dispatch("click");
  await flush();
  assert.equal(view.patientPriorityFilter, "all");
  assert.equal(root.findAll(".clinical-card").length, 1);
});

/* ---------------------------------------------- 9. Paging scroll ----- */

test("a tapped pager starts the new page at its heading; a keyboard press stays on the pager", async () => {
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha")],
    tasks: Array.from({ length: CLINICAL_PAGE_SIZE + 3 }, (_value, index) =>
      task(`TSK-${String(index).padStart(3, "0")}`, "EPI-alpha", {
        task: `Synthetic task ${String(index).padStart(3, "0")}`,
        due_date: todayIso()
      }))
  });
  const { root, view } = createView("tasks", snapshot);
  view.render(snapshot);
  const next =root.find('[data-page-key="tasks-open"]')?.findAll("button").find((button) => button.dataset.pageAction === "next");
  assert.ok(next);
  next.dispatch("click");
  await flush();
  const header = root.find('[data-page-section="tasks-open"]');
  assert.deepEqual(header?.scrollIntoViewCalls.at(-1), { block: "start" });
  const firstHeading = listUnder(root, "tasks-open").find("h4");
  assert.equal(firstHeading?.textContent, `Synthetic task ${String(CLINICAL_PAGE_SIZE).padStart(3, "0")}`);
  assert.equal(firstHeading?.focused, true);
  assert.equal(firstHeading?.getAttribute("tabindex"), "-1");

  // A Sync redraw while that card is being read keeps focus on it.
  const document = focusDocument(root);
  document.activeElement = firstHeading ?? null;
  view.render(snapshot);
  const redrawn = listUnder(root, "tasks-open").find("h4");
  assert.ok(redrawn && redrawn !== firstHeading);
  assert.equal(redrawn.focused, true);
  assert.equal(redrawn.getAttribute("tabindex"), "-1");

  const scroller = root.find(".clinical-workspace-scroll");
  assert.ok(scroller);
  scroller.scrollTop = 900;
  const previous = root.find('[data-page-key="tasks-open"]')?.findAll("button").find((button) => button.dataset.pageAction === "previous");
  assert.ok(previous);
  for (const listener of previous.listeners.get("click") ?? []) listener({ detail: 0 } as unknown as Event);
  await flush();
  const pagerButtons = root.find('[data-page-key="tasks-open"]')?.findAll("button") ?? [];
  assert.equal(pagerButtons.find((button) => button.dataset.pageAction === "next")?.focused, true,
    "Previous is disabled on page 1, so focus lands on Next");
  assert.equal(root.find(".clinical-workspace-scroll")?.scrollTop, 900, "keyboard paging keeps the reading position");
});

test("paging reads the scroll position of a scroller from a pop-out window", () => {
  const { root, view } = createView("tasks", snapshotOf({}));
  // Another window's element: Obsidian's instanceOf accepts it, instanceof does not.
  const foreignScroller = { scrollTop: 250, instanceOf: () => true };
  const original = root.querySelector.bind(root);
  root.querySelector = ((selector: string) =>
    selector === ".clinical-workspace-scroll" ? foreignScroller : original(selector)) as unknown as typeof root.querySelector;
  view.refresh = async () => undefined;
  view.selectListPage("tasks-open", 1, "next", true);
  assert.equal(view.pendingPageContext?.scrollTop, 250);
});

/* ---------------------------------------------- 10. Search folding ----- */

function searchFor(modalRoot: TestElement, query: string): { labels: string[]; metas: string[]; status: string } {
  const input = modalRoot.find("input");
  assert.ok(input);
  input.value = query;
  input.dispatch("input");
  const options = modalRoot.findAll(".clinical-quick-entry-option");
  return {
    labels: options.map((option) => option.find("strong")?.textContent ?? ""),
    metas: options.map((option) => option.find("span")?.textContent ?? ""),
    status: modalRoot.find(".clinical-search-status")?.textContent ?? ""
  };
}

test("search folds Arabic spellings and digits, matches padded MRNs, and names each row's patient", () => {
  const snapshot = snapshotOf({
    patients: [
      patient("PAT-alpha", { mrn: MRN_ALPHA, patient_name: "أحمد علي" }),
      patient("PAT-beta", { mrn: MRN_BETA, patient_name: "Synthetic Beta" })
    ],
    episodes: [
      episode("EPI-alpha", "PAT-alpha", { case: "Case 1" }),
      episode("EPI-beta", "PAT-beta", { case: "Case 1" })
    ],
    tasks: Array.from({ length: 10 }, (_value, index) =>
      task(`TSK-${index}`, "EPI-beta", { patient_id: "PAT-beta", task: `Synthetic follow-up ${index}` }))
  });
  const { content } = openModal(new ClinicalSearchModal(new App(), snapshot, () => undefined));

  const variant = searchFor(content, "احمد");
  assert.ok(variant.labels.includes(patientIdentityLabel(MRN_ALPHA, "أحمد علي")), "bare alef finds the hamza spelling");
  assert.ok(variant.labels.includes("Case 1"), "the patient's episodes match their name too");

  assert.ok(searchFor(content, arabicIndic(MRN_ALPHA)).labels.includes(patientIdentityLabel(MRN_ALPHA, "أحمد علي")));
  assert.ok(searchFor(content, `00${MRN_ALPHA}`).labels.includes(patientIdentityLabel(MRN_ALPHA, "أحمد علي")),
    "a zero-padded MRN matches as an MRN");

  const cases = searchFor(content, "case 1");
  assert.equal(cases.labels.filter((label) => label === "Case 1").length, 2);
  assert.ok(cases.metas.some((meta) => meta.startsWith(patientIdentityLabel(MRN_ALPHA, "أحمد علي"))));
  assert.ok(cases.metas.some((meta) => meta.startsWith(patientIdentityLabel(MRN_BETA, "Synthetic Beta"))),
    "two patients' identical cases can be told apart");
  const caseButtons = content.findAll(".clinical-quick-entry-option").map((button) => button.getAttribute("aria-label"));
  assert.equal(new Set(caseButtons).size, caseButtons.length, "accessible names are distinct too");

  const capped = searchFor(content, "follow-up");
  assert.equal(capped.labels.length, 8);
  assert.match(capped.status, /^8 results shown; 2 more match — refine your search\.$/);
  assert.equal(content.find(".clinical-search-more")?.textContent, "+2 more — refine your search");
});

test("the Quick Entry episode picker uses the same folding", async () => {
  const choice = (id: string, name: string, mrn: string): QuickEntryEpisodeChoice => ({
    episode: episode(id, "PAT-alpha", { case: `Synthetic ${id}` }),
    patientLabel: patientIdentityLabel(mrn, name),
    isCurrent: false,
    patientMrn: mrn
  });
  const modal = new QuickEntryEpisodeModal(new App(), "a task / follow-up", [
    choice("EPI-alpha", "فاطمة", MRN_ALPHA),
    choice("EPI-beta", "Synthetic Beta", MRN_BETA)
  ], () => undefined);
  const { content } = openModal(modal);
  const cases = (query: string): string[] => {
    const input = content.find("input");
    assert.ok(input);
    input.value = query;
    input.dispatch("input");
    return content.findAll("h4").map((heading) => heading.textContent);
  };
  assert.deepEqual(cases("فاطمه"), ["Synthetic EPI-alpha"], "ta marbuta and ha fold together");
  assert.deepEqual(cases(arabicIndic(MRN_BETA)), ["Synthetic EPI-beta"]);
  assert.deepEqual(cases(`0${MRN_BETA}`), ["Synthetic EPI-beta"]);
  assert.equal(content.find("h4")?.getAttribute("dir"), "auto");
});

/* ---------------------------------------------- 11. Modal safe area ----- */

test("the bottom safe area is applied once and shrinks while the keyboard is open", async () => {
  const rules = parseCssRules(await stylesPromise);
  const phone = { width: 390, height: 844 };
  const content = computedDeclarations(rules, [".clinical-modal .modal-content", ".is-mobile .clinical-modal > .modal-content"], phone);
  assert.equal(content.has("padding-bottom"), false, "the content no longer pads under the footer");
  const footer = computedDeclarations(rules, [".clinical-modal-actions", ".is-mobile .clinical-modal-actions"], phone);
  assert.match(footer.get("padding-bottom") ?? "", /safe-area-inset-bottom/);
  const keyboardFooter = computedDeclarations(rules, [
    ".clinical-modal-actions",
    ".is-mobile .clinical-modal-actions",
    ".is-mobile .clinical-modal.is-virtual-keyboard-open .clinical-modal-actions"
  ], phone);
  assert.equal(keyboardFooter.get("padding-bottom"), "8px");
  const footerless = computedDeclarations(rules, [".clinical-modal .modal-content > .clinical-modal-body:last-child"], phone);
  assert.match(footerless.get("padding-bottom") ?? "", /safe-area-inset-bottom/, "a sheet with no footer still clears the home indicator");
});

/* ---------------------------------------------- 12-13. Identity inputs and RTL ----- */

test("identity fields turn off autocorrect and autofill; text fields follow their text direction", async () => {
  const { content } = openModal(new NewEpisodeModal(new App(), async () => undefined));
  await flush();
  const [mrn, name, phone, caseName, nextAction, dueDate] = content.findAll("input");
  assert.ok(mrn && name && phone && caseName && nextAction && dueDate);
  assert.equal(mrn.getAttribute("autocorrect"), "off");
  assert.equal(mrn.getAttribute("spellcheck"), "false");
  assert.equal(mrn.getAttribute("autocapitalize"), "off");
  assert.equal(mrn.getAttribute("autocomplete"), "off");
  assert.equal(name.getAttribute("autocorrect"), "off");
  assert.equal(name.getAttribute("spellcheck"), "false");
  assert.equal(name.getAttribute("autocapitalize"), "words");
  assert.equal(phone.getAttribute("autocomplete"), "off");
  assert.equal(caseName.getAttribute("autocorrect"), null, "clinical free text keeps the keyboard's help");
  for (const input of [mrn, name, phone, caseName, nextAction]) assert.equal(input.getAttribute("dir"), "auto");
  assert.equal(dueDate.getAttribute("dir"), null);

  const taskForm = openModal(new NewTaskModal(new App(), episode("EPI-alpha", "PAT-alpha", { case: "حالة" }), "Synthetic", async () => undefined));
  await flush();
  const owner = taskForm.content.findAll("input").at(-1);
  assert.equal(owner?.getAttribute("autocapitalize"), "off");
  assert.equal(owner?.getAttribute("autocorrect"), "off");
  assert.match(taskForm.content.find(".clinical-section-note")?.textContent ?? "", /⁨حالة⁩$/,
    "the case is isolated inside the description");
});

test("case and task headings in forms and pickers take their direction from their text", () => {
  const record = episode("EPI-alpha", "PAT-alpha", { case: "حالة تجريبية" });
  const headings = [
    openModal(new UpdateEpisodeModal(new App(), record, async () => undefined)).content.find("h3"),
    openModal(new ArchiveEpisodeModal(new App(), record, async () => undefined)).content.find("h3"),
    openModal(new CancelTaskModal(new App(), task("TSK-one", "EPI-alpha"), async () => undefined)).content.find("h3"),
    openModal(new DuplicatePatientModal(new App(), [patient("PAT-alpha")], () => undefined)).content.find("h4")
  ];
  for (const heading of headings) assert.equal(heading?.getAttribute("dir"), "auto");
});

test("archive outcomes and owner badges are isolated; the breakdown table pads logically", async () => {
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [
      episode("EPI-alpha", "PAT-alpha"),
      episode("EPI-closed", "PAT-alpha", { status: "archived", outcome: "خروج" })
    ],
    tasks: [task("TSK-one", "EPI-alpha", { owner: "د. سارة" })]
  });
  const more = createView("more", snapshot);
  more.view.render(snapshot);
  assert.ok(more.root.findAll("p").some((paragraph) => paragraph.textContent === "Outcome: ⁨خروج⁩"));
  const tasks = createView("tasks", snapshot);
  tasks.view.render(snapshot);
  assert.equal(tasks.root.find(".clinical-badge.is-owner")?.getAttribute("dir"), "auto");

  const rules = parseCssRules(await stylesPromise);
  const cell = computedDeclarations(rules, [".clinical-breakdown-table td"]);
  assert.equal(cell.get("padding-inline"), "0 12px");
  assert.equal(cell.has("padding"), false);
});

/* ---------------------------------------------- 14. Danger contrast ----- */

test("danger and error text is mixed toward the body colour; the red cue stays in the border", async () => {
  const rules = parseCssRules(await stylesPromise);
  for (const selector of [".clinical-card-button.is-danger", ".clinical-modal-error", ".clinical-settings-blocked"]) {
    const style = computedDeclarations(rules, [selector]);
    assert.match(style.get("color") ?? "", /^color-mix\(in srgb, var\(--text-error\) \d+%, var\(--text-normal\)\)$/, selector);
  }
  assert.match(computedDeclarations(rules, [".clinical-card-button.is-danger"]).get("border-color") ?? "", /--text-error/);
  assert.match(computedDeclarations(rules, [".clinical-modal-error"]).get("border") ?? "", /--text-error/);
});

/* ---------------------------------------------- 15-16. Names and hints ----- */

test("field hints are linked to their fields and repeated buttons name their record", async () => {
  const { content } = openModal(new NewEpisodeModal(new App(), async () => undefined));
  await flush();
  const mrn = content.find("input");
  const hintId = mrn?.getAttribute("aria-describedby") ?? "";
  assert.ok(hintId);
  assert.equal(content.find(`#${hintId}`)?.textContent, "Numbers only; leading zeroes are preserved.");
  assert.equal(content.findAll("input")[1]?.getAttribute("aria-describedby"), null, "no hint, no link");

  const duplicate = openModal(new DuplicatePatientModal(new App(), [
    patient("PAT-alpha"),
    patient("PAT-beta", { mrn: MRN_BETA, patient_name: "Synthetic Beta" })
  ], () => undefined)).content;
  assert.deepEqual(
    duplicate.findAll("button").filter((button) => button.textContent === "Use this patient").map((button) => button.getAttribute("aria-label")),
    [
      `Use this patient — ${patientIdentityLabel(MRN_ALPHA, "Synthetic Alpha")}`,
      `Use this patient — ${patientIdentityLabel(MRN_BETA, "Synthetic Beta")}`
    ]
  );

  const integrity = openModal(new IntegrityReportModal(new App(), [
    { code: "missing-folder", severity: "error", message: "A managed folder is missing: Synthetic/Folder.", recordId: "", path: "Synthetic/Folder" },
    { code: "broken-link", severity: "warning", message: "Synthetic warning.", recordId: "TSK-one", path: "Synthetic/Tasks/TSK-one.md" }
  ], () => undefined)).content;
  const openLabels = integrity.findAll("button").filter((button) => button.textContent === "Open record").map((button) => button.getAttribute("aria-label") ?? "");
  assert.deepEqual(openLabels, ["Open record — issue 1 of 2", "Open record — issue 2 of 2, TSK-one"]);
  for (const label of openLabels) assert.doesNotMatch(label, /Synthetic\/|\.md/, "no paths in accessible names");

  const snapshot = snapshotOf({ patients: [patient("PAT-alpha"), patient("PAT-beta", { mrn: MRN_BETA, patient_name: "Synthetic Beta" })] });
  const more = createView("more", snapshot);
  more.view.render(snapshot);
  const merges = more.root.findAll("button").filter((button) => button.textContent === "Merge").map((button) => button.getAttribute("aria-label"));
  assert.deepEqual(merges, [
    `Merge — ${patientIdentityLabel(MRN_ALPHA, "Synthetic Alpha")}`,
    `Merge — ${patientIdentityLabel(MRN_BETA, "Synthetic Beta")}`
  ]);
});

test("filter chips are named by their visible text inside labelled groups, and keep focus", async () => {
  const snapshot = snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha")],
    tasks: [
      task("TSK-one", "EPI-alpha", { task_type: "wound-care", priority: "urgent" }),
      task("TSK-two", "EPI-alpha", { task_type: "clinical-review" })
    ]
  });
  const { root, view } = createView("tasks", snapshot);
  view.render(snapshot);
  const chips = root.findAll(".clinical-chip");
  assert.ok(chips.length > 0);
  assert.ok(chips.every((chip) => chip.getAttribute("aria-label") === null), "the visible label is the name");
  assert.ok(chips.some((chip) => chip.textContent === "Wound Care"));
  const groups = root.findAll(".clinical-chip-row").map((row) => [row.getAttribute("role"), row.getAttribute("aria-label")]);
  assert.deepEqual(groups, [["group", "Filter by priority"], ["group", "Filter by task type"]]);

  const urgent = chips.find((chip) => chip.textContent === "Urgent");
  urgent?.dispatch("click");
  await flush();
  const replaced = root.findAll(".clinical-chip").find((chip) => chip.textContent === "Urgent");
  assert.ok(replaced && replaced !== urgent);
  assert.equal(replaced.getAttribute("aria-pressed"), "true");
  assert.equal(replaced.focused, true, "focus follows the chip across the redraw");

  const patients = createView("patients", snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha"), episode("EPI-two", "PAT-alpha", { pathway: "or-booking" })]
  }));
  patients.view.render(snapshotOf({
    patients: [patient("PAT-alpha")],
    episodes: [episode("EPI-alpha", "PAT-alpha"), episode("EPI-two", "PAT-alpha", { pathway: "or-booking" })]
  }));
  assert.deepEqual(
    patients.root.findAll(".clinical-chip-row").map((row) => row.getAttribute("aria-label")),
    ["Filter by pathway", "Filter by priority"]
  );
});

/* ---------------------------------------------- 17. Obsidian guidelines ----- */

test("the modal viewport controller sets its properties through setCssProps", async () => {
  const source = await readFile(new URL("../src/ui/modals.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.style\.(setProperty|removeProperty)\(/);
  assert.match(source, /setCssProps\(\{\s*"--clinical-modal-visual-height": `\$\{layout\.height\}px`/);
  assert.match(source, /setCssProps\(\{\s*"--clinical-modal-visual-height": "",/);
  const view = await readFile(new URL("../src/ui/workspace-view.ts", import.meta.url), "utf8");
  assert.doesNotMatch(view, / instanceof HTMLElement/);
});

/* ---------------------------------------------- 18. Local audit times ----- */

test("episode history and the patient sheet show audit times in local time", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "Asia/Riyadh";
    const stored = "2026-09-22T22:30:00.000Z";
    const history = openModal(new EpisodeHistoryModal(new App(), "Synthetic case", [auditEvent("EVT-one", stored)])).content;
    const detail = openModal(new PatientDetailModal(
      new App(),
      { patient: patient("PAT-alpha"), episodes: [], tasks: [], procedures: [], events: [auditEvent("EVT-one", stored)] },
      () => undefined,
      () => undefined
    )).content;
    for (const root of [history, detail]) {
      const times = root.findAll(".clinical-integrity-issue").map((row) => row.find("span")?.textContent);
      assert.deepEqual(times, ["2026-09-23 01:30"], "UTC 22:30 is 01:30 the next day in Riyadh");
      assert.equal(times[0], formatLocalDateTime(stored));
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("episode history spells out statuses without rewriting free-form audit states", () => {
  const events = [
    { ...auditEvent("EVT-status", STAMP), previous_state: "in-progress", new_state: "ready-to-close" },
    { ...auditEvent("EVT-text", STAMP), previous_state: "custom-state: Keep THIS", new_state: "completed|opd-follow-up" }
  ];
  const root = openModal(new EpisodeHistoryModal(new App(), "Synthetic case", events)).content;
  const changes = root.findAll(".clinical-integrity-issue").map((row) => row.find("p")?.textContent);
  assert.match(changes[0]!, /In Progress → Ready to Close/);
  assert.match(changes[1]!, /custom-state: Keep THIS → completed\|opd-follow-up/);
});

/* ---------------------------------------------- 19. Template preview ----- */

test("the template preview shows each item's type, priority and date, and the bundle's warnings", () => {
  const bundle: TaskBundle = {
    name: "Synthetic tonsillectomy",
    path: "Synthetic/Templates/Tonsillectomy.md",
    pathway: null,
    tasks: [
      { task: "Synthetic consent", taskType: "clinical-review", priority: "urgent", dueInDays: 3 },
      { task: "Synthetic call", taskType: "other", priority: null, dueInDays: null }
    ],
    warnings: ["Item 3 has no task text and was skipped."]
  };
  const { content } = openModal(new ApplyTemplateModal(new App(), "Synthetic case", [bundle], () => undefined));
  const lines = content.findAll("p").map((paragraph) => paragraph.textContent);
  assert.ok(lines.includes("• ⁨Synthetic consent⁩ — Clinical Review · Urgent · due in 3 days"));
  assert.ok(lines.includes("• ⁨Synthetic call⁩ — Other · episode's priority · no due date"),
    "a defaulted type, priority or date is visible before applying");
  assert.deepEqual(
    content.find(".clinical-template-warnings")?.findAll("li").map((item) => item.textContent),
    bundle.warnings
  );
});

test("an episode card's patient line opens the patient sheet without adding a button row", async () => {
  const alpha = patient("PAT-alpha");
  const merged = patient("PAT-merged", { mrn: MRN_BETA, patient_name: "Synthetic Merged", merged_into: "PAT-alpha" });
  const snapshot = snapshotOf({
    patients: [alpha, merged],
    episodes: [
      episode("EPI-alpha", "PAT-alpha", { case: "Synthetic clinic review" }),
      episode("EPI-merged", "PAT-merged", { case: "Synthetic stray case" })
    ]
  });
  const { root, view } = createView("patients", snapshot);
  view.render(snapshot);
  const links = root.findAll(".clinical-card-patient-link");
  assert.equal(links.length, 1, "a merged-away patient has no sheet, so its line stays plain text");
  const link = links[0];
  assert.ok(link);
  assert.equal(link.tagName, "button");
  assert.match(link.attributes.get("aria-label") ?? "", /^MRN .+ — view patient$/, "the name starts with the visible text");
  const card = link.closest(".clinical-card");
  assert.ok(card);
  assert.ok(
    !card.find(".clinical-card-actions")?.findAll("button").some((button) => /view/i.test(button.textContent)),
    "no extra View button in the card's action grid"
  );

  const sheets = captureOpen(PatientDetailModal);
  try {
    link.dispatch("click");
    await flush();
    assert.equal(sheets.opened.length, 1);
    assert.equal((sheets.opened[0] as unknown as { data: { patient: PatientRecord } }).data.patient.id, "PAT-alpha");
  } finally {
    sheets.restore();
  }

  const rules = parseCssRules(await readFile(new URL("../styles.css", import.meta.url), "utf8"));
  const mobile = computedDeclarations(rules, [".clinical-card-patient-link", ".is-mobile .clinical-card-patient-link"], { width: 390, height: 844 });
  assert.equal(mobile.get("min-height"), "44px", "a touch-sized target on phones");
});

/* ---------------------------------------------- 20. Identity without an MRN ----- */

/** Every visible text and accessible name under a rendered element. */
function spokenText(root: TestElement): string[] {
  const out: string[] = [];
  const visit = (node: TestElement): void => {
    if (node.text) out.push(node.text);
    const label = node.getAttribute("aria-label");
    if (label) out.push(label);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

test("a patient without an MRN reads \"MRN needed\" once wherever the patient is named", () => {
  const withMrn = `MRN ${MRN_ALPHA} · ⁨Synthetic Alpha⁩`;
  const withoutMrn = "MRN needed · ⁨Synthetic Beta⁩";
  assert.equal(patientIdentityLabel(MRN_ALPHA, "Synthetic Alpha"), withMrn);
  assert.equal(patientIdentityLabel("", "Synthetic Beta"), withoutMrn);
  assert.equal(patientIdentityLabel("", ""), "MRN needed · Name not recorded");

  const alpha = patient("PAT-alpha");
  const beta = patient("PAT-beta", { mrn: "", mrn_status: "missing", patient_name: "Synthetic Beta" });
  const snapshot = snapshotOf({
    patients: [alpha, beta],
    episodes: [
      episode("EPI-alpha", "PAT-alpha", { care_setting: "inpatient", case: "Synthetic alpha case" }),
      episode("EPI-beta", "PAT-beta", { care_setting: "inpatient", case: "Synthetic beta case" }),
      episode("EPI-orphan", "PAT-missing", { care_setting: "inpatient", case: "Synthetic orphan case" })
    ],
    tasks: [
      task("TSK-beta", "EPI-beta", { patient_id: "PAT-beta", task: "Synthetic beta review", due_date: todayIso() })
    ]
  });
  const rendered: TestElement[] = [];

  // Today: the ward-round row, its buttons' names, and the task card.
  const today = createView("today", snapshot);
  today.view.render(snapshot);
  rendered.push(today.root);
  const wardNames = today.root.findAll(".clinical-ward-row").map((row) => row.find("strong")?.textContent);
  assert.ok(wardNames.includes(withoutMrn), `ward rows: ${wardNames.join(" | ")}`);
  assert.ok(wardNames.includes(withMrn), "a recorded MRN keeps its label");
  assert.ok(
    wardNames.includes("MRN needed · Patient identity missing"),
    "an episode whose patient note is gone keeps its fallback"
  );
  buttonNamed(today.root, /^View — ⁨Synthetic beta case⁩, MRN needed · ⁨Synthetic Beta⁩$/);
  const taskCard = today.root
    .findAll(".clinical-card")
    .find((card) => card.find("h4")?.textContent === "Synthetic beta review");
  assert.ok(taskCard);
  assert.ok(taskCard.findAll("p").some((line) => line.textContent === withoutMrn), "the task card names the patient");
  buttonNamed(taskCard, /^Complete — ⁨Synthetic beta review⁩, MRN needed · ⁨Synthetic Beta⁩$/);

  // Patients: the tappable patient line on the episode card and its name.
  const patients = createView("patients", snapshot);
  patients.view.render(snapshot);
  rendered.push(patients.root);
  const link = patients.root
    .findAll(".clinical-card-patient-link")
    .find((candidate) => candidate.textContent === withoutMrn);
  assert.ok(link, "the patient line reads MRN needed and the name");
  assert.equal(link.getAttribute("aria-label"), `${withoutMrn} — view patient`);

  // Search: the patient row, a record row's patient, and their names.
  const search = openModal(new ClinicalSearchModal(new App(), snapshot, () => undefined)).content;
  const found = searchFor(search, "Synthetic Beta");
  rendered.push(search);
  assert.ok(found.labels.includes(withoutMrn));
  assert.ok(found.metas.some((meta) => meta.startsWith(`${withoutMrn} · `)));
  assert.ok(
    search
      .findAll(".clinical-quick-entry-option")
      .some((row) => row.getAttribute("aria-label") === `Open patient: ${withoutMrn}`)
  );

  // The patient sheet's identity line.
  const sheet = openModal(new PatientDetailModal(
    new App(),
    { patient: beta, episodes: [], tasks: [], procedures: [], events: [] },
    () => undefined,
    () => undefined
  )).content;
  rendered.push(sheet);
  assert.ok(sheet.find(".clinical-section-note")?.textContent.startsWith(`${withoutMrn} · Phone NFN`));

  // Possible duplicate and Check the MRN: the card line and the button's name.
  const duplicate = openModal(new DuplicatePatientModal(new App(), [beta], () => undefined)).content;
  rendered.push(duplicate);
  assert.ok(duplicate.findAll("p").some((line) => line.textContent === "MRN needed"));
  buttonNamed(duplicate, new RegExp(`^Use this patient — ${withoutMrn}$`));
  const conflict = openModal(new MrnOwnerConflictModal(new App(), alpha, "Synthetic Gamma", () => undefined)).content;
  rendered.push(conflict);
  assert.ok(conflict.findAll("p").some((line) => line.textContent === `MRN ${MRN_ALPHA}`));
  buttonNamed(conflict, new RegExp(`^Use this patient — ${withMrn}$`));

  for (const root of rendered) {
    for (const line of spokenText(root)) assert.doesNotMatch(line, /MRN MRN/, line);
  }

  // The ward handover note names the patient the same way.
  const handover = buildHandoverNote(snapshot, todayIso());
  assert.match(handover, /\*\*MRN needed · Synthetic Beta\*\*/);
  assert.match(handover, new RegExp(`\\*\\*MRN ${MRN_ALPHA} · Synthetic Alpha\\*\\*`));
  assert.doesNotMatch(handover, /MRN MRN/);
});

/* ---------------------------------------------- 21. Statuses in words ----- */

test("the patient sheet, Search and Patient records show statuses in words, including a hand-edited one", () => {
  const opened = (day: number): string => `2026-09-${String(day).padStart(2, "0")}T08:00:00.000Z`;
  const statusByCase: Record<string, string> = {
    "Synthetic active case": "Active",
    "Synthetic on-hold case": "On Hold",
    "Synthetic ready case": "Ready to Close",
    "Synthetic archived case": "Archived",
    "Synthetic cancelled case": "Cancelled",
    "Synthetic error case": "Entered in Error",
    "Synthetic hand-edited case": "Awaiting Bed",
    "Synthetic blank case": "Unknown"
  };
  const records = {
    patient: patient("PAT-alpha"),
    episodes: [
      episode("EPI-active", "PAT-alpha", { case: "Synthetic active case", opened_at: opened(8) }),
      episode("EPI-hold", "PAT-alpha", { case: "Synthetic on-hold case", status: "on-hold", opened_at: opened(7) }),
      episode("EPI-ready", "PAT-alpha", { case: "Synthetic ready case", status: "ready-to-close", opened_at: opened(6) }),
      episode("EPI-archived", "PAT-alpha", { case: "Synthetic archived case", status: "archived", opened_at: opened(5) }),
      episode("EPI-cancelled", "PAT-alpha", { case: "Synthetic cancelled case", status: "cancelled", opened_at: opened(4) }),
      episode("EPI-error", "PAT-alpha", { case: "Synthetic error case", status: "entered-in-error", opened_at: opened(3) }),
      // Typed by hand in the Properties panel: not a status the plugin writes.
      episode("EPI-hand", "PAT-alpha", {
        case: "Synthetic hand-edited case",
        status: "awaiting-bed" as never,
        opened_at: opened(2)
      }),
      episode("EPI-blank", "PAT-alpha", { case: "Synthetic blank case", status: "" as never, opened_at: opened(1) })
    ],
    tasks: [
      task("TSK-done", "EPI-active", { task: "Synthetic done task", status: "completed", completed_at: opened(9) }),
      task("TSK-dropped", "EPI-active", { task: "Synthetic dropped task", status: "cancelled", cancelled_at: opened(8) }),
      task("TSK-waiting", "EPI-active", { task: "Synthetic waiting task", status: "waiting" })
    ],
    procedures: [],
    events: []
  };
  const sheet = openModal(new PatientDetailModal(new App(), records, () => undefined, () => undefined)).content;
  assert.ok(sheet.find(".clinical-section-note")?.textContent.endsWith(" · Active"), "the patient's own status");
  const cardStatus = (heading: string): string | undefined =>
    sheet
      .findAll(".clinical-card")
      .find((card) => card.find("h4")?.textContent === heading)
      ?.find(".clinical-card-top")
      ?.children.find((child) => child.classes.has("clinical-card-meta"))?.textContent;
  for (const [caseName, label] of Object.entries(statusByCase)) {
    assert.equal(cardStatus(caseName), label, caseName);
  }
  assert.equal(cardStatus("Synthetic done task"), "Completed");
  assert.equal(cardStatus("Synthetic dropped task"), "Cancelled");

  const search = openModal(new ClinicalSearchModal(
    new App(),
    snapshotOf({ patients: [records.patient], episodes: records.episodes, tasks: records.tasks }),
    () => undefined
  )).content;
  const found = searchFor(search, "Synthetic");
  assert.ok(found.metas.includes("Active"), "the patient row");
  assert.ok(found.metas.some((meta) => meta.endsWith("· Assessment · Ready to Close")), found.metas.join(" | "));
  assert.ok(found.metas.some((meta) => meta.endsWith("· Assessment · Entered in Error")));
  assert.ok(found.metas.some((meta) => meta.endsWith("· Waiting")), "an open task's status");

  // More → Patient records names each patient's status the same way.
  const onFile = snapshotOf({ patients: [records.patient] });
  const more = createView("more", onFile);
  more.view.render(onFile);
  const recordTop = listUnder(more.root, "more-patients").find(".clinical-card-top");
  assert.equal(recordTop?.children.find((child) => child.classes.has("clinical-card-meta"))?.textContent, "Active");

  // No stored value leaks through as the label.
  const stored = /^(?:active|on-hold|ready-to-close|archived|cancelled|entered-in-error|awaiting-bed|completed|waiting)$|· (?:active|on-hold|ready-to-close|archived|cancelled|entered-in-error|awaiting-bed|completed|waiting)\b/;
  for (const root of [sheet, search]) {
    for (const line of spokenText(root)) assert.doesNotMatch(line, stored, line);
  }
});
