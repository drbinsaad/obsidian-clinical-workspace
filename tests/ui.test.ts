import assert from "node:assert/strict";
import test from "node:test";
import { App } from "obsidian";
import type { ClinicalSnapshot, NewEpisodeInput } from "../src/domain/types";
import type { ClinicalRepository } from "../src/data/repository";
import type { ClinicalService } from "../src/services/clinical-service";
import type { IntegrityService } from "../src/services/integrity";
import {
  calculateClinicalModalViewportLayout,
  CLINICAL_MODAL_VIEWPORT_SYNC_DELAYS,
  ClinicalModalViewportController,
  type ClinicalModalViewportHost,
  type ClinicalModalViewportLayout,
  episodeChoiceAccessibleLabel,
  NewEpisodeModal,
  patientIdentityLabel
} from "../src/ui/modals";
import {
  CLINICAL_PAGE_SIZE,
  CLINICAL_WORKSPACE_VIEW,
  ClinicalWorkspaceView,
  pageWindow
} from "../src/ui/workspace-view";

const EMPTY_SNAPSHOT: ClinicalSnapshot = {
  patients: [],
  episodes: [],
  tasks: [],
  procedures: []
};

test("workspace view exposes stable Obsidian identity", () => {
  const repository = { snapshot: async () => EMPTY_SNAPSHOT } as unknown as ClinicalRepository;
  const view = new ClinicalWorkspaceView(
    {} as never,
    repository,
    {} as ClinicalService,
    {} as IntegrityService
  );
  assert.equal(view.getViewType(), CLINICAL_WORKSPACE_VIEW);
  assert.equal(view.getDisplayText(), "Clinical Workspace");
  assert.equal(view.getIcon(), "stethoscope");
});

test("mobile lists render one bounded page and clamp after synced deletions", () => {
  const values = Array.from({ length: CLINICAL_PAGE_SIZE * 2 + 3 }, (_, index) => index);
  const middle = pageWindow(values, 1);
  assert.equal(middle.items.length, CLINICAL_PAGE_SIZE);
  assert.equal(middle.items[0], CLINICAL_PAGE_SIZE);
  assert.equal(middle.page, 1);
  assert.equal(middle.pages, 3);
  assert.equal(middle.total, values.length);

  const clamped = pageWindow(values.slice(0, 2), 99);
  assert.deepEqual(clamped.items, [0, 1]);
  assert.equal(clamped.page, 0);
  assert.equal(clamped.pages, 1);

  assert.equal(pageWindow(values, Number.NaN).page, 0);
});

test("clinical modal sheets follow the iPhone visual viewport when the keyboard opens", () => {
  assert.deepEqual(CLINICAL_MODAL_VIEWPORT_SYNC_DELAYS, [0, 60, 180, 420]);
  assert.deepEqual(calculateClinicalModalViewportLayout(844, 844), {
    height: 844,
    keyboardOpen: false,
    shift: 0
  });
  assert.deepEqual(calculateClinicalModalViewportLayout(844, 430, 20), {
    height: 430,
    keyboardOpen: true,
    shift: -187
  });
  assert.deepEqual(calculateClinicalModalViewportLayout(844, 844, 0, 414), {
    height: 430,
    keyboardOpen: true,
    shift: -207
  });
  assert.deepEqual(calculateClinicalModalViewportLayout(844, 430, 20, 414), {
    height: 410,
    keyboardOpen: true,
    shift: -197
  });
  assert.deepEqual(calculateClinicalModalViewportLayout(844, 844, 0, Number.NaN), {
    height: 844,
    keyboardOpen: false,
    shift: 0
  });
});

test("clinical viewport lifecycle follows the complete iOS keyboard animation and cleans up", () => {
  type ListenerName = "viewportResize" | "viewportScroll" | "windowResize" | "focusIn";
  const listeners: Record<ListenerName, Set<() => void>> = {
    viewportResize: new Set(),
    viewportScroll: new Set(),
    windowResize: new Set(),
    focusIn: new Set()
  };
  let metrics = {
    innerHeight: 844,
    viewportHeight: 844,
    viewportOffsetTop: 0,
    keyboardHeight: 0
  };
  let nextTimer = 0;
  const timers = new Map<number, { delay: number; listener: () => void }>();
  const clearedTimers: number[] = [];
  const layouts: ClinicalModalViewportLayout[] = [];
  let reveals = 0;
  let resets = 0;
  const register = (name: ListenerName) => (listener: () => void) => {
    listeners[name].add(listener);
    return () => listeners[name].delete(listener);
  };
  const host: ClinicalModalViewportHost = {
    readMetrics: () => metrics,
    applyLayout: (layout) => layouts.push(layout),
    resetLayout: () => { resets += 1; },
    revealFocusedControl: () => { reveals += 1; },
    onViewportResize: register("viewportResize"),
    onViewportScroll: register("viewportScroll"),
    onWindowResize: register("windowResize"),
    onFocusIn: register("focusIn"),
    setTimer: (listener, delay) => {
      nextTimer += 1;
      timers.set(nextTimer, { delay, listener });
      return nextTimer;
    },
    clearTimer: (timer) => {
      clearedTimers.push(timer);
      timers.delete(timer);
    }
  };
  const controller = new ClinicalModalViewportController(host);
  controller.start();
  assert.deepEqual([...timers.values()].map(({ delay }) => delay), [0, 60, 180, 420]);
  assert.equal(Object.values(listeners).every((set) => set.size === 1), true);

  metrics = {
    innerHeight: 844,
    viewportHeight: 430,
    viewportOffsetTop: 20,
    keyboardHeight: 414
  };
  const focus = [...listeners.focusIn][0];
  assert.ok(focus);
  focus();
  assert.equal(clearedTimers.length, 4);
  const scheduled = [...timers.entries()].sort((left, right) => left[1].delay - right[1].delay);
  for (const [timer, task] of scheduled) {
    timers.delete(timer);
    task.listener();
  }
  assert.equal(reveals, 4);
  assert.equal(layouts.length, 4);
  assert.deepEqual(layouts.at(-1), { height: 410, keyboardOpen: true, shift: -197 });
  assert.equal(scheduled.at(-1)?.[1].delay, 420);

  const resize = [...listeners.viewportResize][0];
  assert.ok(resize);
  resize();
  assert.equal(reveals, 5);
  controller.stop();
  assert.equal(Object.values(listeners).every((set) => set.size === 0), true);
  assert.equal(resets, 1);
  resize();
  assert.equal(reveals, 5);
});

test("Episode picker controls have context-specific accessible names", () => {
  const makeChoice = (id: string) => ({
    episode: {
      id,
      case: "Synthetic airway review"
    },
    patientLabel: "MRN 9000000 · Synthetic Patient",
    isCurrent: false
  }) as Parameters<typeof episodeChoiceAccessibleLabel>[1];
  const first = episodeChoiceAccessibleLabel("a task / follow-up", makeChoice("EPI-SYNTHETIC-1"));
  const second = episodeChoiceAccessibleLabel("a task / follow-up", makeChoice("EPI-SYNTHETIC-2"));
  assert.notEqual(first, second);
  assert.match(first, /Synthetic airway review/);
  assert.match(first, /Synthetic Patient/);
  assert.match(first, /EPI-SYNTHETIC-1/);
});

test("a refresh requested during rendering is queued rather than dropped", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let snapshots = 0;
  const repository = {
    snapshot: async () => {
      snapshots += 1;
      if (snapshots === 1) await firstGate;
      return EMPTY_SNAPSHOT;
    }
  } as unknown as ClinicalRepository;
  const view = new ClinicalWorkspaceView(
    {} as never,
    repository,
    {} as ClinicalService,
    {} as IntegrityService
  ) as unknown as {
    refresh: () => Promise<void>;
    render: (snapshot: ClinicalSnapshot) => void;
  };
  let renders = 0;
  view.render = () => {
    renders += 1;
  };

  const first = view.refresh();
  await Promise.resolve();
  const queued = view.refresh();
  await queued;
  releaseFirst?.();
  await first;

  assert.equal(snapshots, 2);
  assert.equal(renders, 2);
});

test("new-episode modal retains its seeded mobile form values", () => {
  const app = new App();
  const modal = new NewEpisodeModal(
    app,
    async () => undefined,
    {
      mrn: "9000123",
      patientName: "Synthetic Patient",
      careSetting: "inpatient",
      pathway: "or-booking",
      priority: "urgent"
    }
  ) as unknown as { value: () => NewEpisodeInput };

  const value = modal.value();
  assert.equal(value.mrn, "9000123");
  assert.equal(value.patientName, "Synthetic Patient");
  assert.equal(value.careSetting, "inpatient");
  assert.equal(value.pathway, "or-booking");
  assert.equal(value.priority, "urgent");
});

test("modal identity labels remain explicit when fields are missing", () => {
  assert.equal(patientIdentityLabel("", ""), "MRN MRN needed · Name not recorded");
  assert.equal(patientIdentityLabel("9000123", "Synthetic Patient"), "MRN 9000123 · Synthetic Patient");
});
