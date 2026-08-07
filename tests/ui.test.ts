import assert from "node:assert/strict";
import test from "node:test";
import { App } from "obsidian";
import type { ClinicalSnapshot, NewEpisodeInput } from "../src/domain/types";
import type { ClinicalRepository } from "../src/data/repository";
import type { ClinicalService } from "../src/services/clinical-service";
import type { IntegrityService } from "../src/services/integrity";
import { NewEpisodeModal, patientIdentityLabel } from "../src/ui/modals";
import { CLINICAL_WORKSPACE_VIEW, ClinicalWorkspaceView } from "../src/ui/workspace-view";

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
