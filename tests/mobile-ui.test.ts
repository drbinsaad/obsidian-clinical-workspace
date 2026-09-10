import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { App } from "obsidian";
import type { ClinicalSnapshot } from "../src/domain/types";
import type { ClinicalRepository } from "../src/data/repository";
import type { ClinicalService } from "../src/services/clinical-service";
import type { IntegrityService } from "../src/services/integrity";
import {
  calculateClinicalModalViewportLayout,
  ClinicalSearchModal,
  InitializeWorkspaceModal,
  QuickEntryModal
} from "../src/ui/modals";
import { ClinicalWorkspaceView } from "../src/ui/workspace-view";
import {
  computedDeclarations,
  gridTrackCount,
  installTestDomGlobals,
  parseCssRules,
  TestElement,
  type CssRule
} from "./support/dom-harness";

installTestDomGlobals();

const EMPTY_SNAPSHOT: ClinicalSnapshot = {
  patients: [],
  episodes: [],
  tasks: [],
  procedures: []
};

type WorkspaceTab = "today" | "patients" | "tasks" | "surgery" | "more";

type RenderableWorkspace = {
  activeTab: WorkspaceTab;
  contentEl: HTMLElement;
  refresh: () => Promise<void>;
  render: (snapshot: ClinicalSnapshot) => void;
};

type RenderableModal = {
  contentEl: HTMLElement;
  modalEl: HTMLElement;
  onOpen: () => void;
};

const stylesPromise = readFile(new URL("../styles.css", import.meta.url), "utf8");

function createWorkspace(tab: WorkspaceTab): { root: TestElement; view: RenderableWorkspace } {
  const root = new TestElement();
  const workspace = new ClinicalWorkspaceView(
    {} as never,
    { snapshot: async () => EMPTY_SNAPSHOT } as unknown as ClinicalRepository,
    {} as ClinicalService,
    {} as IntegrityService
  ) as unknown as RenderableWorkspace;
  workspace.activeTab = tab;
  workspace.contentEl = root as unknown as HTMLElement;
  return { root, view: workspace };
}

function renderWorkspace(tab: WorkspaceTab): TestElement {
  const { root, view } = createWorkspace(tab);
  view.render(EMPTY_SNAPSHOT);
  return root;
}

function styleFor(rules: readonly CssRule[], ...selectors: string[]): Map<string, string> {
  return styleForViewport(rules, { width: 390, height: 844 }, ...selectors);
}

function styleForViewport(
  rules: readonly CssRule[],
  viewport: { width: number; height: number },
  ...selectors: string[]
): Map<string, string> {
  return computedDeclarations(rules, selectors, viewport);
}

function required(style: ReadonlyMap<string, string>, property: string): string {
  const value = style.get(property);
  assert.ok(value, `expected computed ${property}`);
  return value;
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function numericPx(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)px$/.exec(value.trim());
  assert.ok(match, `expected a fixed pixel value, got ${value}`);
  return Number(match[1]);
}

function largestPixelLiteral(value: string): number {
  const values = [...value.matchAll(/([0-9]+(?:\.[0-9]+)?)px/g)].map((match) => Number(match[1]));
  assert.ok(values.length > 0, `expected at least one pixel length, got ${value}`);
  return Math.max(...values);
}

function searchSnapshot(patientNames: readonly string[]): ClinicalSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    patients: patientNames.map((patientName, index) => ({
      id: `patient-${index}`,
      mrn: `MRN-${index}`,
      patient_name: patientName,
      status: "active"
    })) as ClinicalSnapshot["patients"]
  };
}

function accessibleName(element: TestElement): string {
  return element.getAttribute("aria-label") ?? element.textContent.trim();
}

function assertNearestInlineReveal(element: TestElement, direction: "ltr" | "rtl"): void {
  assert.ok(element.scrollIntoViewCalls.length > 0, `${direction} active tab was not brought into view`);
  const options = element.scrollIntoViewCalls.at(-1);
  assert.equal(typeof options, "object");
  assert.equal((options as ScrollIntoViewOptions).inline, "nearest");
  assert.equal(
    (options as ScrollIntoViewOptions).block,
    "nearest",
    "horizontal reveal must not jump the outer vertical reading position"
  );
}

test("iPhone header renders three controls into three non-wrapping narrow tracks", async () => {
  const root = renderWorkspace("today");
  const actions = root.find(".clinical-workspace-header-actions");
  assert.ok(actions);
  assert.equal(actions.children.length, 3);
  assert.deepEqual(actions.children.map(accessibleName), [
    "Search clinical records",
    "Open Clinical Workspace quick entry",
    "Refresh Clinical Workspace"
  ]);

  const rules = parseCssRules(await stylesPromise);
  const actionStyle = styleFor(
    rules,
    ".clinical-workspace-header-actions",
    ".clinical-workspace-view.is-narrow .clinical-workspace-header-actions"
  );
  assert.equal(actionStyle.get("display"), "grid");
  assert.equal(
    gridTrackCount(required(actionStyle, "grid-template-columns")),
    actions.children.length,
    "every header action needs an explicit track; implicit rows caused the iPhone regression"
  );

  const quickEntryStyle = styleFor(
    rules,
    ".clinical-quick-entry-button",
    ".clinical-workspace-view.is-narrow .clinical-quick-entry-button"
  );
  assert.equal(quickEntryStyle.get("white-space"), "nowrap");
});

test("all five workspace tabs use content-aware tracks without clipping enlarged labels", async () => {
  const root = renderWorkspace("today");
  const tabs = root.find(".clinical-workspace-tabs");
  assert.ok(tabs);
  assert.deepEqual(tabs.children.map((tab) => tab.textContent), [
    "Today",
    "Patients",
    "Tasks",
    "Surgery",
    "More"
  ]);
  assert.deepEqual(
    tabs.children.map((tab) => tab.getAttribute("role")),
    ["tab", "tab", "tab", "tab", "tab"]
  );

  const rules = parseCssRules(await stylesPromise);
  const tabListStyle = styleFor(
    rules,
    ".clinical-workspace-tabs",
    ".clinical-workspace-view.is-narrow .clinical-workspace-tabs"
  );
  const template = normalized(required(tabListStyle, "grid-template-columns"));
  assert.equal(gridTrackCount(template), tabs.children.length);
  assert.match(
    template,
    /^repeat\(5,\s*minmax\((?:min|max)-content,\s*1fr\)\)$/,
    "normal labels should share five equal tracks while intrinsic text growth can widen them"
  );
  assert.notEqual(tabListStyle.get("grid-auto-flow"), "column");
  assert.equal(
    tabListStyle.get("overflow-x"),
    "auto",
    "the strip should scroll only when intrinsic large-text widths exceed the pane"
  );

  const tabStyle = styleFor(
    rules,
    ".clinical-workspace-tab",
    ".clinical-workspace-view.is-narrow .clinical-workspace-tab"
  );
  assert.notEqual(tabStyle.get("min-width"), "88px");
  assert.notEqual(tabStyle.get("overflow"), "hidden");
  assert.notEqual(tabStyle.get("overflow-x"), "hidden");
  assert.notEqual(tabStyle.get("text-overflow"), "clip");
  assert.equal(tabStyle.get("white-space"), "nowrap");
});

test("render and refresh reveal the active tab in LTR and RTL without losing vertical position", async () => {
  for (const direction of ["ltr", "rtl"] as const) {
    const { root, view } = createWorkspace("surgery");
    root.addClass("clinical-workspace-view", "is-narrow");
    root.setAttribute("dir", direction);
    if (direction === "rtl") root.addClass("mod-rtl");

    await view.refresh();
    await Promise.resolve();
    const initialActive = root.find(".clinical-workspace-tab.is-active");
    assert.ok(initialActive);
    assert.equal(initialActive.textContent, "Surgery");
    assertNearestInlineReveal(initialActive, direction);

    const previousScroller = root.find(".clinical-workspace-scroll");
    assert.ok(previousScroller);
    previousScroller.scrollTop = 317;

    await view.refresh();
    await Promise.resolve();
    const refreshedScroller = root.find(".clinical-workspace-scroll");
    const refreshedActive = root.find(".clinical-workspace-tab.is-active");
    assert.ok(refreshedScroller && refreshedActive);
    assert.equal(refreshedScroller.scrollTop, 317, `${direction} refresh changed vertical reading position`);
    assertNearestInlineReveal(refreshedActive, direction);
  }
});

test("Quick entry remains contained at extreme narrow width with a complete accessible name", async () => {
  const root = renderWorkspace("today");
  const actions = root.find(".clinical-workspace-header-actions");
  const quickEntry = root.find(".clinical-quick-entry-button");
  assert.ok(actions && quickEntry);
  assert.equal(quickEntry.getAttribute("aria-label"), "Open Clinical Workspace quick entry");
  const visualLabel = quickEntry
    .findAll("span")
    .find((span) => span.textContent.trim() === "Quick entry");
  assert.ok(visualLabel, "the visible short label must remain independently containable");

  const rules = parseCssRules(await stylesPromise);
  const viewport = { width: 240, height: 844 };
  const actionsStyle = styleForViewport(
    rules,
    viewport,
    ".clinical-workspace-header-actions",
    ".clinical-workspace-view.is-narrow .clinical-workspace-header-actions"
  );
  const template = normalized(required(actionsStyle, "grid-template-columns"));
  assert.equal(gridTrackCount(template), 3);
  assert.equal(actionsStyle.get("width"), "100%");

  const quickEntryStyle = styleForViewport(
    rules,
    viewport,
    ".clinical-quick-entry-button",
    ".clinical-workspace-view.is-narrow .clinical-quick-entry-button",
    ".is-mobile .clinical-workspace-view.is-narrow .clinical-quick-entry-button"
  );
  assert.equal(quickEntryStyle.get("width"), "100%");
  assert.equal(quickEntryStyle.get("min-width"), "0");

  const centerTrack = /^44px\s+(.+)\s+44px$/.exec(template)?.[1] ?? "";
  const centerHasUsableFloor = Boolean(centerTrack) &&
    !/^minmax\(\s*0(?:px)?\s*,/i.test(centerTrack);
  const buttonContainsOverflow = ["clip", "hidden"].includes(
    quickEntryStyle.get("overflow-x") ?? quickEntryStyle.get("overflow") ?? ""
  );

  const labelClasses = [...visualLabel.classes];
  const labelSelectors = rules.flatMap((rule) =>
    rule.selectors.filter((selector) =>
      labelClasses.some((className) => selector.includes(`.${className}`)) ||
      (selector.includes(".clinical-quick-entry-button") && /span|last-child/.test(selector))
    )
  );
  const labelStyle = styleForViewport(rules, viewport, ...labelSelectors);
  const labelIsHidden = labelStyle.get("display") === "none";
  const labelIsEllipsized = labelStyle.get("min-width") === "0" &&
    ["clip", "hidden"].includes(labelStyle.get("overflow-x") ?? labelStyle.get("overflow") ?? "") &&
    labelStyle.get("text-overflow") === "ellipsis";
  const labelCanWrap = labelStyle.get("white-space") === "normal" &&
    ["anywhere", "break-word"].includes(labelStyle.get("overflow-wrap") ?? "");

  assert.ok(
    centerHasUsableFloor || buttonContainsOverflow || labelIsHidden || labelIsEllipsized || labelCanWrap,
    "extreme narrow/large-text geometry needs a usable middle track or an explicit label containment strategy"
  );
});

test("four surgery summaries form a compact 2-by-2 grid on iPhone", async () => {
  const root = renderWorkspace("surgery");
  const summary = root.find(".clinical-summary-grid");
  assert.ok(summary);
  assert.equal(summary.children.length, 4);

  const rules = parseCssRules(await stylesPromise);
  const summaryStyle = styleFor(
    rules,
    ".clinical-summary-grid",
    ".clinical-workspace-view.is-narrow .clinical-summary-grid"
  );
  assert.equal(gridTrackCount(required(summaryStyle, "grid-template-columns")), 2);
});

test("mobile card actions use two touch-safe columns instead of a full-width stack", async () => {
  const rules = parseCssRules(await stylesPromise);
  const actions = styleFor(
    rules,
    ".clinical-card-actions",
    ".clinical-workspace-view.is-narrow .clinical-card-actions",
    ".is-mobile .clinical-card-actions"
  );
  assert.equal(actions.get("display"), "grid");
  assert.equal(gridTrackCount(required(actions, "grid-template-columns")), 2);

  const button = styleFor(
    rules,
    ".clinical-card-button",
    ".clinical-workspace-view.is-narrow .clinical-card-button",
    ".is-mobile .clinical-card-actions .clinical-card-button"
  );
  assert.ok(
    numericPx(required(button, "min-height")) >= 44,
    "card controls need their own touch target; tab declarations must not satisfy this assertion"
  );

  for (const selector of [
    ".clinical-workspace-view.is-narrow .clinical-card-button.mod-cta",
    ".clinical-workspace-view.is-narrow .clinical-card-button.is-danger"
  ]) {
    assert.equal(styleFor(rules, selector).get("grid-column"), "1 / -1");
  }
});

test("mobile Add patient is explicit and cannot float over clinical content", async () => {
  const patients = renderWorkspace("patients");
  const today = renderWorkspace("today");
  const addControls = patients
    .findAll("button")
    .filter((button) => accessibleName(button).toLocaleLowerCase().includes("add patient"));
  assert.ok(addControls.length > 0, "Patients needs an Add patient control");
  assert.ok(
    addControls.some((button) => /add patient/i.test(button.textContent)),
    "the mobile action must show its purpose instead of displaying an ambiguous plus"
  );
  assert.equal(today.find(".clinical-mobile-add-button"), null, "the contextual mobile action belongs only in Patients");

  const rules = parseCssRules(await stylesPromise);
  const mobileAction = styleFor(
    rules,
    ".clinical-primary-action",
    ".is-mobile .clinical-primary-action"
  );
  const overlayPosition = ["absolute", "fixed"].includes(mobileAction.get("position") ?? "");
  assert.ok(
    mobileAction.get("display") === "none" || !overlayPosition,
    "the mobile Add patient control must be hidden or participate in layout rather than mask a card"
  );

  const contextAction = styleFor(
    rules,
    ".clinical-mobile-context-action",
    ".is-mobile .clinical-mobile-context-action"
  );
  assert.equal(contextAction.get("display"), "flex");
  assert.equal(["absolute", "fixed"].includes(contextAction.get("position") ?? ""), false);
  const addButton = styleFor(rules, ".clinical-mobile-add-button");
  assert.ok(numericPx(required(addButton, "min-height")) >= 44);

  const shell = styleFor(rules, ".clinical-workspace-shell", ".is-mobile .clinical-workspace-shell");
  assert.match(required(shell, "padding-bottom"), /--clinical-mobile-bottom-clearance/);
  assert.match(required(shell, "padding-bottom"), /safe-area-inset-bottom/);

  const mobileWorkspace = styleFor(rules, ".is-mobile .clinical-workspace-view");
  const bottomClearance = required(mobileWorkspace, "--clinical-mobile-bottom-clearance");
  assert.match(bottomClearance, /var\(--navbar-height\b/);
  assert.match(bottomClearance, /var\(--mobile-toolbar-height\b/);
  assert.doesNotMatch(bottomClearance, /--mobile-navbar-height\b/);
});

test("phone and iPad both replace the overlay FAB with the in-flow Patients action", async () => {
  const rules = parseCssRules(await stylesPromise);
  const primarySelectors = [
    ".clinical-primary-action",
    ".is-mobile .clinical-primary-action"
  ];
  const contextSelectors = [
    ".clinical-mobile-context-action",
    ".is-mobile .clinical-mobile-context-action"
  ];

  const phoneFab = styleForViewport(rules, { width: 390, height: 844 }, ...primarySelectors);
  const phoneContextAction = styleForViewport(rules, { width: 390, height: 844 }, ...contextSelectors);
  assert.equal(phoneFab.get("display"), "none");
  assert.equal(phoneContextAction.get("display"), "flex");

  const ipadFab = styleForViewport(rules, { width: 768, height: 1024 }, ...primarySelectors);
  const ipadContextAction = styleForViewport(rules, { width: 768, height: 1024 }, ...contextSelectors);
  assert.equal(
    ipadFab.get("display"),
    "none",
    "an iPad running Obsidian mobile must not fall through to the desktop overlay"
  );
  assert.equal(ipadContextAction.get("display"), "flex");

  const ipadCardActions = styleForViewport(
    rules,
    { width: 768, height: 1024 },
    ".clinical-card-actions",
    ".is-mobile .clinical-card-actions"
  );
  assert.equal(ipadCardActions.get("display"), "flex", "two-column card compression remains phone-only");
  assert.equal(ipadCardActions.has("grid-template-columns"), false);
});

test("mobile modal content honors the top safe area", async () => {
  const rules = parseCssRules(await stylesPromise);
  const modalStyle = styleFor(rules, ".is-mobile .clinical-modal");
  const closeTopToken = required(modalStyle, "--clinical-modal-close-top");
  assert.match(closeTopToken, /safe-area-inset-top/);
  const closeReserveToken = required(modalStyle, "--clinical-modal-close-reserve");
  assert.match(closeReserveToken, /--clinical-modal-close-top/);
  assert.ok(largestPixelLiteral(closeReserveToken) >= 44);

  const closeStyle = styleFor(
    rules,
    ".is-mobile .clinical-modal > .modal-close-button"
  );
  assert.match(required(closeStyle, "top"), /--clinical-modal-close-top|safe-area-inset-top/);

  const contentStyle = styleFor(
    rules,
    ".is-mobile .clinical-modal > .modal-content"
  );
  const topReservation = contentStyle.get("padding-block-start") ?? contentStyle.get("padding-top");
  assert.ok(topReservation, "mobile modal content must reserve space below the status area and close control");
  assert.match(topReservation, /--clinical-modal-close-reserve|safe-area-inset-top/);
});

test("Quick Entry renders four packed actions rather than stretching rows across the sheet", async () => {
  const content = new TestElement();
  const modalElement = new TestElement();
  const modal = new QuickEntryModal(new App(), () => undefined) as unknown as RenderableModal;
  modal.contentEl = content as unknown as HTMLElement;
  modal.modalEl = modalElement as unknown as HTMLElement;
  modal.onOpen();
  assert.equal(modalElement.classes.has("clinical-quick-entry-modal"), true);
  assert.equal(modalElement.classes.has("clinical-search-modal"), false);

  const grid = content.find(".clinical-quick-entry-grid");
  assert.ok(grid);
  const options = grid.findAll(".clinical-quick-entry-option");
  assert.equal(options.length, 4);
  assert.deepEqual(options.map((option) => option.tagName), ["button", "button", "button", "button"]);

  const rules = parseCssRules(await stylesPromise);
  const gridStyle = styleFor(
    rules,
    ".clinical-quick-entry-grid",
    ".is-mobile .clinical-quick-entry-modal .clinical-quick-entry-grid"
  );
  const packedByAlignment = ["start", "flex-start"].includes(gridStyle.get("align-content") ?? "");
  const packedByTracks = ["max-content", "min-content"].includes(gridStyle.get("grid-auto-rows") ?? "");
  assert.ok(
    packedByAlignment || packedByTracks,
    "a flex-growing grid needs start-packed content or intrinsic rows to avoid giant iPhone gaps"
  );
  assert.equal(gridStyle.get("overflow-y"), "auto");

  const optionStyle = styleFor(
    rules,
    ".clinical-modal button.clinical-quick-entry-option",
    ".is-mobile .clinical-quick-entry-modal button.clinical-quick-entry-option"
  );
  const minimumOptionHeight = numericPx(required(optionStyle, "min-height"));
  const gap = numericPx(required(gridStyle, "gap"));
  assert.ok(
    minimumOptionHeight * options.length + gap * (options.length - 1) <= 320,
    "the four minimum-height options and gaps should remain compact"
  );
});

test("unrelated safety modals do not inherit Quick Entry or Search sizing", () => {
  const content = new TestElement();
  const modalElement = new TestElement();
  const modal = new InitializeWorkspaceModal(new App(), false, () => undefined) as unknown as RenderableModal;
  modal.contentEl = content as unknown as HTMLElement;
  modal.modalEl = modalElement as unknown as HTMLElement;
  modal.onOpen();

  assert.equal(modalElement.classes.has("clinical-modal"), true);
  assert.equal(modalElement.classes.has("clinical-quick-entry-modal"), false);
  assert.equal(modalElement.classes.has("clinical-search-modal"), false);
});

test("Search announces threshold, no-match, and capped match transitions without duplicate live updates", async () => {
  const content = new TestElement();
  const modalElement = new TestElement();
  const snapshot = searchSnapshot(
    Array.from({ length: 10 }, (_value, index) => `Needle Patient ${index + 1}`)
  );
  const modal = new ClinicalSearchModal(new App(), snapshot, () => undefined) as unknown as RenderableModal;
  modal.contentEl = content as unknown as HTMLElement;
  modal.modalEl = modalElement as unknown as HTMLElement;
  modal.onOpen();
  assert.equal(modalElement.classes.has("clinical-search-modal"), true);
  assert.equal(modalElement.classes.has("clinical-quick-entry-modal"), false);
  assert.equal(modalElement.classes.has("is-search-compact"), true);

  const body = content.find(".clinical-modal-body");
  const input = content.find("input");
  const status = content.find(".clinical-search-status");
  const results = content.find(".clinical-quick-entry-results");
  const footer = content.find(".clinical-modal-actions");
  assert.ok(body && input && status && results && footer);
  assert.equal(input.getAttribute("type"), "search");
  assert.equal(input.getAttribute("enterkeyhint"), "search");
  assert.equal(input.parent, body);
  assert.equal(results.parent, body);
  assert.equal(footer.parent, content);
  assert.equal(content.findAll(".clinical-search-status").length, 1);
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(status.getAttribute("aria-atomic"), "true");

  assert.equal(status.textContent, "Type at least two characters to search.");
  assert.equal(status.classes.has("clinical-empty"), true);
  assert.equal(results.children.length, 0);
  const thresholdWrites = status.textWriteCount;

  input.value = "x";
  input.dispatch("input");
  assert.equal(status.textContent, "Type at least two characters to search.");
  assert.equal(status.textWriteCount, thresholdWrites, "unchanged announcements must be deduplicated");
  assert.equal(modalElement.classes.has("is-search-compact"), true);

  input.value = "zz";
  input.dispatch("input");
  assert.equal(status.textContent, "Nothing matches this search.");
  assert.equal(status.classes.has("clinical-empty"), true);
  assert.equal(results.children.length, 0);
  assert.equal(modalElement.classes.has("is-search-compact"), true);

  input.value = "needle";
  input.dispatch("input");
  assert.equal(modalElement.classes.has("is-search-compact"), false);
  assert.equal(status.classes.has("clinical-empty"), false);
  assert.equal(results.findAll(".clinical-quick-entry-option").length, 8, "each result group is capped at eight rows");
  assert.match(status.textContent, /^8 results shown\b/);
  const matchWrites = status.textWriteCount;

  input.dispatch("input");
  assert.equal(status.textWriteCount, matchWrites, "re-rendering an unchanged result count must stay silent");

  const rules = parseCssRules(await stylesPromise);
  const bodyStyle = styleFor(rules, ".clinical-modal-body");
  const footerStyle = styleFor(rules, ".clinical-modal-actions", ".is-mobile .clinical-modal-actions");
  assert.equal(bodyStyle.get("overflow-y"), "auto");
  assert.match(required(footerStyle, "flex"), /^0 0 /);
  assert.equal(required(footerStyle, "padding-bottom").includes("safe-area-inset-bottom"), true);

  assert.deepEqual(calculateClinicalModalViewportLayout(844, 430, 20, 414), {
    height: 410,
    keyboardOpen: true,
    shift: -197
  });
});
