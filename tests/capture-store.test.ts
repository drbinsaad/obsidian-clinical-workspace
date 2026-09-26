import test from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { CaptureStore } from "../src/capture/store";
import { captureInboxPath, captureTemplates, parseCaptureDraft } from "../src/capture/drafts";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import { PossibleDuplicatePatientError } from "../src/services/clinical-service";
import { episodeInput, harness } from "./support/harness";

const source = '---\nclinical_capture: 1\ncapture_kind: "task"\n---\nSynthetic draft\n';
async function fixture() {
  const h = await harness();
  const store = new CaptureStore(h.app as unknown as App, h.repository);
  await store.setup();
  const path = `${captureInboxPath(clinicalRootFolder())}/synthetic.md`;
  await h.app.vault.create(path, source);
  return { ...h, store, path, item: await store.read(path) };
}

test("capture setup preserves customized templates and list reads only bounded direct children", async () => {
  const h = await fixture();
  const template = Object.keys(captureTemplates(clinicalRootFolder()))[0]!;
  h.app.vault.writeRaw(template, "Custom template");
  await h.store.setup();
  assert.equal(h.app.vault.files.get(template), "Custom template");
  h.app.vault.writeRaw(`${captureInboxPath(clinicalRootFolder())}/nested/ignored.md`, source);
  h.app.vault.writeRaw(`${clinicalRootFolder()}/Inbox/ignored.md`, source);
  for (let i = 0; i < 205; i++) h.app.vault.writeRaw(`${captureInboxPath(clinicalRootFolder())}/${i}.md`, source);
  const reads: string[] = [];
  const read = h.app.vault.read.bind(h.app.vault);
  h.app.vault.read = async (file) => { reads.push(file.path); return read(file); };
  assert.equal((await h.store.list()).length, 200);
  assert.equal(reads.length, 200);
  assert.ok(reads.every((path) => path.startsWith(`${captureInboxPath(clinicalRootFolder())}/`) && !path.includes("nested")));
  await assert.rejects(() => h.store.read(`${clinicalRootFolder()}/Patients/ignored.md`));
  assert.equal(reads.length, 200);
});

test("capture rejects stale source, renamed source and write barriers without conversion", async () => {
  const h = await fixture();
  let calls = 0;
  const convert = () => h.store.run(h.item, async () => ++calls, String);
  h.app.vault.writeRaw(h.path, source + "edited");
  await assert.rejects(convert);
  h.app.vault.deleteRaw(h.path);
  await assert.rejects(convert);
  h.app.vault.writeRaw(h.path, source);
  h.repository.setWriteBlock("Synthetic write barrier");
  await assert.rejects(convert);
  assert.equal(calls, 0);
  assert.equal(h.app.vault.files.get(h.path), source);
});

test("capture concurrent taps and reopened filed receipts invoke service once", async () => {
  const h = await fixture();
  let calls = 0;
  const run = () => h.store.run(h.item, async () => ++calls, (n) => `Task ${n}`);
  const results = await Promise.allSettled([run(), run()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
  const restarted = new CaptureStore(h.app as unknown as App, h.repository);
  const filed = await restarted.read(h.path);
  assert.equal(filed.draft?.state, "filed");
  await assert.rejects(() => restarted.run(filed, async () => ++calls, String));
  assert.equal(calls, 1);
});

test("partial conversion remains processing after restart and requires explicit review", async () => {
  const h = await fixture();
  await assert.rejects(() => h.store.run(h.item, async () => { throw new Error("SYNTHETIC PRIVATE DETAIL"); }, String), (error: Error) => {
    assert.match(error.message, /Filing may be incomplete/);
    assert.doesNotMatch(error.message, /PRIVATE|synthetic.md/);
    return true;
  });
  const restarted = new CaptureStore(h.app as unknown as App, h.repository);
  const pending = await restarted.read(h.path);
  assert.equal(pending.draft?.state, "processing");
  await assert.rejects(() => restarted.run(pending, async () => 1, String));
  h.app.vault.writeRaw(h.path, h.app.vault.files.get(h.path)! + "Review notes\n");
  await restarted.markReviewed(pending);
  const reviewed = await restarted.read(h.path);
  assert.equal(reviewed.draft?.state, "reviewed");
  assert.match(reviewed.source, /Review notes/);
});

test("failed completion receipt leaves processing and does not repeat clinical operation", async () => {
  const h = await fixture();
  const process = h.app.vault.process.bind(h.app.vault);
  let writes = 0;
  h.app.vault.process = async (file, fn) => {
    if (++writes === 2) throw new Error("Synthetic receipt failure");
    return process(file, fn);
  };
  let calls = 0;
  await assert.rejects(() => h.store.run(h.item, async () => ++calls, String), /Filing may be incomplete/);
  assert.equal((await h.store.read(h.path)).draft?.state, "processing");
  assert.equal(calls, 1);
});

test("completion preserves body edits and known prewrite identity errors reset draft", async () => {
  const h = await fixture();
  await assert.rejects(() => h.store.run(h.item, async () => {
    throw new PossibleDuplicatePatientError([]);
  }, String), PossibleDuplicatePatientError);
  const retry = await h.store.read(h.path);
  assert.equal(retry.draft?.state, "draft");
  assert.equal(retry.draft?.attemptId, "");
  assert.equal(retry.source, h.item.source);
  await h.store.run(retry, async () => {
    h.app.vault.writeRaw(h.path, h.app.vault.files.get(h.path)! + "During service\n");
    return "TSK-synthetic";
  }, String);
  const saved = await h.store.read(h.path);
  assert.equal(saved.draft?.state, "filed");
  assert.match(saved.source, /During service/);
});

test("identity rollback refuses intervening edits and leaves processing for review", async () => {
  const h = await fixture();
  await assert.rejects(() => h.store.run(h.item, async () => {
    h.app.vault.writeRaw(h.path, h.app.vault.files.get(h.path)! + "New unseen instructions\n");
    throw new PossibleDuplicatePatientError([]);
  }, String), /Filing may be incomplete/);
  const pending = await h.store.read(h.path);
  assert.equal(pending.draft?.state, "processing");
  assert.match(pending.source, /New unseen instructions/);
});

test("root change after claim blocks service and leaves durable processing receipt", async () => {
  const h = await fixture();
  const root = clinicalRootFolder();
  const process = h.app.vault.process.bind(h.app.vault);
  let called = false;
  h.app.vault.process = async (file, fn) => {
    const result = await process(file, fn);
    setClinicalRoot("Synthetic moved root");
    return result;
  };
  try {
    await assert.rejects(() => h.store.run(h.item, async () => { called = true; }, String));
    assert.equal(called, false);
    assert.equal(parseCaptureDraft(h.app.vault.files.get(h.path)!).state, "processing");
  } finally { setClinicalRoot(root); }
});

test("capture refuses out-of-scope conversion before reading and migration pause before claiming", async () => {
  const h = await fixture();
  let reads = 0;
  const read = h.app.vault.read.bind(h.app.vault);
  h.app.vault.read = async (file) => { reads++; return read(file); };
  await assert.rejects(() => h.store.run({ ...h.item, path: `${clinicalRootFolder()}/Patients/private.md` }, async () => 1, String));
  assert.equal(reads, 0);
  const paused = await h.repository.pauseManagedRecordMutations();
  try {
    await assert.rejects(() => h.store.run(h.item, async () => 1, String));
    assert.equal(h.app.vault.files.get(h.path), source);
  } finally { paused.release(); }
});

test("capture preserves a replaced receipt and blocks service when claim readback changes", async () => {
  const h = await fixture();
  const process = h.app.vault.process.bind(h.app.vault);
  let called = false;
  h.app.vault.process = async (file, fn) => {
    const next = await process(file, fn);
    h.app.vault.writeRaw(file.path, next + "Changed after claim\n");
    return next;
  };
  await assert.rejects(() => h.store.run(h.item, async () => { called = true; }, String), /Filing may be incomplete/);
  assert.equal(called, false);
  assert.match(h.app.vault.files.get(h.path)!, /Changed after claim/);
});

test("oversized and invalid drafts produce neutral errors and cannot invoke clinical writes", async () => {
  const h = await fixture();
  h.app.vault.writeRaw(h.path, source + "x".repeat(65536));
  const oversized = await h.store.read(h.path);
  assert.equal(oversized.source, "");
  assert.ok(oversized.error);
  h.app.vault.writeRaw(h.path, "SYNTHETIC PRIVATE PARSE ERROR");
  const invalid = await h.store.read(h.path);
  assert.doesNotMatch(invalid.error!, /PRIVATE/);
  let called = false;
  await assert.rejects(() => h.store.run(invalid, async () => { called = true; }, String));
  assert.equal(called, false);
});

test("capture wrapper settles nested clinical services with inventory observation", { timeout: 3000 }, async () => {
  const h = await fixture();
  let observations = 0;
  h.repository.setManagedRecordWriteObserver(async () => { observations++; });
  const episode = await h.store.run(h.item,
    () => h.service.createEpisode(episodeInput()), (saved) => saved.episode.record.id);
  assert.equal((await h.store.read(h.path)).draft?.state, "filed");
  const capture = async (name: string) => {
    const path = `${captureInboxPath(clinicalRootFolder())}/${name}.md`;
    await h.app.vault.create(path, source);
    return h.store.read(path);
  };
  const task = await h.store.run(await capture("task"), () => h.service.createTask({
    patientId: episode.patient.record.id, episodeId: episode.episode.record.id,
    task: "Synthetic action", taskType: "clinical-review", priority: "routine", dueDate: "2026-09-28", owner: ""
  }), (saved) => saved.task.record.id);
  assert.equal(task.task.record.status, "open");
  const current = await h.repository.findById("episode", episode.episode.record.id);
  const booking = await h.store.run(await capture("booking"), () => h.service.updateEpisode(episode.episode.record.id, {
    careSetting: "outpatient", pathway: "or-booking", priority: "routine", nextAction: "Book synthetic theatre", dueDate: "2026-09-29",
    expectedUpdatedAt: current!.record.updated_at
  }), (saved) => saved.episode.record.id);
  assert.equal(booking.episode.record.pathway, "or-booking");
  const procedure = await h.store.run(await capture("procedure"), () => h.service.completeProcedure({
    patientId: episode.patient.record.id, episodeId: episode.episode.record.id,
    procedure: "Synthetic operation", procedureDate: "2026-09-27", role: "Primary surgeon", outcome: "",
    followUpRequired: false, followUpDate: "", followUpPlan: ""
  }), (saved) => saved.record.id);
  assert.equal(procedure.record.status, "completed");
  assert.ok(observations >= 4);
});

test("capture setup rejects a directory at a template destination without replacing it", async () => {
  const h = await harness();
  const store = new CaptureStore(h.app as unknown as App, h.repository);
  const path = Object.keys(captureTemplates(clinicalRootFolder()))[0]!;
  await h.app.vault.createFolder(path);
  await assert.rejects(() => store.setup(), /Capture setup could not finish/);
  assert.ok(h.app.vault.folders.has(path));
  assert.equal(h.app.vault.files.has(path), false);
});

test("capture setup requires both existing workspace parents before creating anything", async () => {
  for (const suffix of ["Inbox", "Templates"]) {
    const h = await harness();
    const store = new CaptureStore(h.app as unknown as App, h.repository);
    const parent = `${clinicalRootFolder()}/${suffix}`;
    h.app.vault.folders.delete(parent);
    const files = new Map(h.app.vault.files);
    const folders = new Set(h.app.vault.folders);
    await assert.rejects(() => store.setup(), /Capture setup could not finish/);
    assert.deepEqual(h.app.vault.files, files);
    assert.deepEqual(h.app.vault.folders, folders);
  }
});
