import assert from "node:assert/strict";
import test from "node:test";
import { CARE_SETTINGS, PATHWAYS, PRIORITIES } from "../src/domain/types";
import {
  auditActor,
  DEFAULT_SETTINGS,
  normalizeFolderPath,
  normalizeSettings,
  validateRootFolder
} from "../src/domain/settings";
import {
  clinicalFolder,
  clinicalRootFolder,
  folderForEntity,
  pathForRecord,
  setClinicalRoot
} from "../src/data/paths";
import { baseFiles, baseSourceFolders, homeNote } from "../src/data/bases";
import { episodeInput, harness } from "./support/harness";

const ALLOWED = { careSettings: CARE_SETTINGS, pathways: PATHWAYS, priorities: PRIORITIES };

test("settings fall back to defaults when data.json is absent or junk", () => {
  assert.deepEqual(normalizeSettings(undefined, ALLOWED), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(null, ALLOWED), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings("not an object", ALLOWED), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(42, ALLOWED), DEFAULT_SETTINGS);
});

test("a hand-edited enum value is rejected rather than propagated", () => {
  const settings = normalizeSettings(
    { defaultCareSetting: "inpatient", defaultPathway: "nonsense", defaultPriority: "urgent" },
    ALLOWED
  );
  assert.equal(settings.defaultCareSetting, "inpatient", "a valid value is kept");
  assert.equal(settings.defaultPathway, "assessment", "an invalid value falls back");
  assert.equal(settings.defaultPriority, "urgent");
});

test("the refresh delay is clamped to a sane range", () => {
  assert.equal(normalizeSettings({ refreshDebounceMs: -500 }, ALLOWED).refreshDebounceMs, 0);
  assert.equal(normalizeSettings({ refreshDebounceMs: 999999 }, ALLOWED).refreshDebounceMs, 2000);
  assert.equal(normalizeSettings({ refreshDebounceMs: "abc" }, ALLOWED).refreshDebounceMs, 180);
  assert.equal(normalizeSettings({ refreshDebounceMs: 250.6 }, ALLOWED).refreshDebounceMs, 251);
});

test("toggles only accept a real boolean", () => {
  assert.equal(normalizeSettings({ confirmBeforeDischarge: "yes" }, ALLOWED).confirmBeforeDischarge, false);
  assert.equal(normalizeSettings({ confirmBeforeDischarge: true }, ALLOWED).confirmBeforeDischarge, true);
  assert.equal(normalizeSettings({ runIntegrityOnStartup: 1 }, ALLOWED).runIntegrityOnStartup, false);
});

test("the audit actor falls back only when no name is set", () => {
  assert.equal(auditActor({ ...DEFAULT_SETTINGS, clinicianName: "" }), "local-user");
  assert.equal(auditActor({ ...DEFAULT_SETTINGS, clinicianName: "A. Alshahrani" }), "A. Alshahrani");
  assert.equal(normalizeSettings({ clinicianName: "  A.  Alshahrani  " }, ALLOWED).clinicianName, "A. Alshahrani");
});

test("folder paths are normalised", () => {
  assert.equal(normalizeFolderPath("/Clinical//Workspace/"), "Clinical/Workspace");
  assert.equal(normalizeFolderPath("  "), "Clinical Workspace");
  assert.equal(normalizeFolderPath("Records"), "Records");
});

test("invalid root folders are rejected", () => {
  assert.equal(validateRootFolder("Clinical Records"), null);
  assert.equal(validateRootFolder("Nested/Clinical"), null);
  assert.match(String(validateRootFolder("bad:name")), /cannot contain/);
  assert.match(String(validateRootFolder("has[bracket]")), /cannot contain/);
  assert.match(String(validateRootFolder(".hidden")), /cannot start with a dot/);
});

test("every derived path follows the configured root", () => {
  const original = clinicalRootFolder();
  try {
    setClinicalRoot("Ward Records");
    assert.equal(clinicalRootFolder(), "Ward Records");
    assert.equal(clinicalFolder("patients"), "Ward Records/Patients");
    assert.equal(folderForEntity("event"), "Ward Records/Events");
    assert.equal(pathForRecord("task", "TSK-1"), "Ward Records/Tasks/TSK-1.md");

    // Bases embed folder strings that Obsidian will not rewrite on a rename.
    const bases = baseFiles();
    const patients = bases["Ward Records/Bases/Patients.base"];
    assert.ok(patients, "the base is keyed under the new root");
    assert.match(patients, /file\.inFolder\("Ward Records\/Patients"\)/);
    assert.equal(baseSourceFolders()["Ward Records/Bases/Patients.base"], "Ward Records/Patients");
    assert.match(homeNote(), /Ward Records\/Bases\/Patients\.base#All patients/);
  } finally {
    setClinicalRoot(original);
  }
});

test("records are written under the configured root", async () => {
  const original = clinicalRootFolder();
  try {
    setClinicalRoot("Ward Records");
    const { service, repository } = await harness();
    const created = await service.createEpisode(episodeInput({ nextAction: "Chase result", dueDate: "2026-08-10" }));
    assert.match(created.patient.path, /^Ward Records\/Patients\//);
    assert.match(created.episode.path, /^Ward Records\/Episodes\//);
    assert.match(created.task!.path, /^Ward Records\/Tasks\//);
    // Wikilinks must point at the configured root too, or restore breaks.
    assert.match(created.episode.record.patient, /^\[\[Ward Records\/Patients\//);
    assert.equal((await repository.list("event")).length > 0, true);
  } finally {
    setClinicalRoot(original);
  }
});

test("the audit actor set from settings reaches the event note", async () => {
  const { service, repository } = await harness();
  repository.setActor("A. Alshahrani");
  await service.createEpisode(episodeInput());
  const events = await repository.list("event");
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal((event.record as { actor?: string }).actor, "A. Alshahrani");
  }
});

test("an empty clinician name still records something useful", async () => {
  const { service, repository } = await harness();
  repository.setActor("");
  await service.createEpisode(episodeInput());
  const events = await repository.list("event");
  assert.equal((events[0]!.record as { actor?: string }).actor, "local-user");
});
