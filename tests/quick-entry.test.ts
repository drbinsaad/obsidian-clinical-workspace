import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { App } from "obsidian";
import ClinicalWorkspacePlugin from "../src/main";
import { wikilink } from "../src/data/paths";
import { mrnMatchKey } from "../src/domain/schema";
import type {
  ClinicalRecord,
  EntityType,
  EpisodeRecord,
  PatientRecord,
  ProcedureRecord,
  TaskRecord
} from "../src/domain/types";
import {
  QUICK_ENTRY_ACTIONS,
  QUICK_ENTRY_COMMAND_IDS,
  QUICK_ENTRY_PROTOCOL_ACTIONS,
  isSafeQuickEntryProtocolInvocation
} from "../src/quick-entry";
import { quickEntryEpisodeChoices } from "../src/ui/workspace-view";
import type { ClinicalWorkspaceView } from "../src/ui/workspace-view";
import { episodeInput, harness } from "./support/harness";
import { TFile as StubTFile } from "./support/obsidian-stub";

type TestRepository = Awaited<ReturnType<typeof harness>>["repository"];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Pauses one record creation after the service has acquired its logical locks. */
function pauseNextRecordCreation(
  repository: TestRepository,
  entity: ClinicalRecord["entity"]
): { entered: Promise<void>; release: () => void } {
  const entered = deferred();
  const release = deferred();
  const original = repository.create.bind(repository);
  let paused = false;
  repository.create = (async <T extends ClinicalRecord>(record: T) => {
    if (!paused && record.entity === entity) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return original(record);
  }) as typeof repository.create;
  return { entered: entered.promise, release: release.resolve };
}

/** Pauses the archive write while its Episode lifecycle lock is held. */
function pauseEpisodeArchive(
  repository: TestRepository,
  episodePath: string
): { entered: Promise<void>; release: () => void } {
  return pauseNextRecordUpdate(
    repository,
    (path, changes) => path === episodePath && changes.status === "archived"
  );
}

type TestChanges = Record<string, string | number | boolean | string[]>;

/** Pauses the first record update matching a forced-interleaving predicate. */
function pauseNextRecordUpdate(
  repository: TestRepository,
  matches: (path: string, changes: TestChanges) => boolean
): { entered: Promise<void>; release: () => void } {
  const entered = deferred();
  const release = deferred();
  const original = repository.update.bind(repository);
  let paused = false;
  repository.update = (async <T extends ClinicalRecord>(
    path: string,
    changes: TestChanges
  ) => {
    if (!paused && matches(path, changes)) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return original<T>(path, changes);
  }) as typeof repository.update;
  return { entered: entered.promise, release: release.resolve };
}

/** Signals when the next operation attempts this patient-merge lock. */
function observeNextPatientLockAttempt(
  repository: TestRepository,
  patientId: string
): Promise<void> {
  return observeNextLockAttempt(repository, `patient-merge:${patientId}`);
}

/** Signals when the next operation attempts an exact logical lock key. */
function observeNextLockAttempt(
  repository: TestRepository,
  expectedKey: string
): Promise<void> {
  const attempted = deferred();
  const original = repository.withLock.bind(repository);
  repository.withLock = (async <T>(key: string, operation: () => Promise<T>) => {
    if (key === expectedKey) attempted.resolve();
    return original(key, operation);
  }) as typeof repository.withLock;
  return attempted.promise;
}

/** Pauses before the next exact logical lock is delegated to the repository. */
function pauseNextLockAttempt(
  repository: TestRepository,
  expectedKey: string
): { entered: Promise<void>; release: () => void } {
  const entered = deferred();
  const release = deferred();
  const original = repository.withLock.bind(repository);
  let paused = false;
  repository.withLock = (async <T>(key: string, operation: () => Promise<T>) => {
    if (!paused && key === expectedKey) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return original(key, operation);
  }) as typeof repository.withLock;
  return { entered: entered.promise, release: release.resolve };
}

/** Reports whether queued merge work reached its first patient read. */
function observePatientRead(
  repository: TestRepository,
  patientId: string
): () => boolean {
  const original = repository.findById.bind(repository);
  let entered = false;
  repository.findById = (async (entity: EntityType, id: string) => {
    if (entity === "patient" && id === patientId) entered = true;
    return original(entity, id);
  }) as typeof repository.findById;
  return () => entered;
}

/** Reports whether MRN collision resolution reached the repository lookup. */
function observeMrnLookup(repository: TestRepository): () => boolean {
  const original = repository.findPatientByMrn.bind(repository);
  let entered = false;
  repository.findPatientByMrn = async (mrn: string) => {
    entered = true;
    return original(mrn);
  };
  return () => entered;
}

/** Reports whether a new record of this entity reached repository creation. */
function observeRecordCreation(
  repository: TestRepository,
  entity: ClinicalRecord["entity"]
): () => boolean {
  const original = repository.create.bind(repository);
  let entered = false;
  repository.create = (async <T extends ClinicalRecord>(record: T) => {
    if (record.entity === entity) entered = true;
    return original(record);
  }) as typeof repository.create;
  return () => entered;
}

test("Quick Entry command and protocol names are unique and complete", () => {
  assert.deepEqual(Object.keys(QUICK_ENTRY_COMMAND_IDS).sort(), [...QUICK_ENTRY_ACTIONS].sort());
  assert.deepEqual(Object.keys(QUICK_ENTRY_PROTOCOL_ACTIONS).sort(), [...QUICK_ENTRY_ACTIONS].sort());
  assert.equal(new Set(Object.values(QUICK_ENTRY_COMMAND_IDS)).size, QUICK_ENTRY_ACTIONS.length);
  assert.equal(new Set(Object.values(QUICK_ENTRY_PROTOCOL_ACTIONS)).size, QUICK_ENTRY_ACTIONS.length);
  for (const action of Object.values(QUICK_ENTRY_PROTOCOL_ACTIONS)) {
    assert.match(action, /^clinical-workspace-[a-z-]+$/);
    assert.doesNotMatch(`obsidian://${action}`, /\?/);
  }
  assert.equal(
    QUICK_ENTRY_COMMAND_IDS["new-patient-episode"],
    "add-patient-episode",
    "existing hotkeys and mobile-toolbar mappings must retain their command id"
  );
});

test("Quick Entry protocols accept only the fixed action and no query parameters", () => {
  for (const action of Object.values(QUICK_ENTRY_PROTOCOL_ACTIONS)) {
    assert.equal(isSafeQuickEntryProtocolInvocation(action, { action }), true);
    assert.equal(isSafeQuickEntryProtocolInvocation(action, {}), false);
    assert.equal(
      isSafeQuickEntryProtocolInvocation(action, { action: `${action}-different` }),
      false
    );
    for (const unsafeKey of [
      "patient",
      "patientName",
      "mrn",
      "episode",
      "id",
      "file",
      "path",
      "note",
      "case",
      "text",
      "content",
      "vault"
    ]) {
      assert.equal(
        isSafeQuickEntryProtocolInvocation(action, { action, [unsafeKey]: "synthetic-value" }),
        false,
        `${unsafeKey} must reject the complete URI invocation`
      );
    }
  }
});

test("episode Quick Entry choices are active, valid, explicit, and current-first", async () => {
  const { service, repository } = await harness();
  const first = await service.createEpisode(
    episodeInput({ mrn: "9000007101", patientName: "Synthetic Patient Alpha", caseName: "Case A" })
  );
  const current = await service.createEpisode(
    episodeInput({ mrn: "9000007102", patientName: "Synthetic Patient Beta", caseName: "Case B" })
  );
  const snapshot = await repository.snapshot();
  snapshot.episodes.push({
    ...first.episode.record,
    id: "EPI-ARCHIVED-SYNTHETIC",
    case: "Archived synthetic case",
    status: "archived"
  });

  const choices = quickEntryEpisodeChoices(snapshot, current.episode.record.id);

  assert.equal(choices.length, 2);
  assert.equal(choices[0]?.episode.id, current.episode.record.id);
  assert.equal(choices[0]?.isCurrent, true);
  assert.equal(choices[1]?.isCurrent, false);
  assert.ok(choices.every((choice) => choice.patientLabel.includes("Synthetic Patient")));
  assert.ok(choices.every((choice) => choice.episode.status !== "archived"));
});

test("a current Episode hint is never inferred for a missing or retired patient", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ mrn: "9000007103", patientName: "Synthetic Patient Gamma" })
  );
  const snapshot = await repository.snapshot();
  snapshot.patients[0]!.status = "entered-in-error";

  assert.deepEqual(quickEntryEpisodeChoices(snapshot, created.episode.record.id), []);

  snapshot.patients[0]!.status = "active";
  snapshot.patients[0]!.merge_in_progress = "PAT-SYNTHETIC-MERGE-TARGET";
  assert.deepEqual(
    quickEntryEpisodeChoices(snapshot, created.episode.record.id),
    [],
    "an interrupted merge must not be offered as writable context"
  );
});

test("procedure choices stay within OR booking while task choices remain broad", async () => {
  const { service, repository } = await harness();
  const assessment = await service.createEpisode(
    episodeInput({
      mrn: "9000007104",
      patientName: "Synthetic Patient Delta",
      caseName: "Synthetic assessment",
      pathway: "assessment"
    })
  );
  const booking = await service.createEpisode(
    episodeInput({
      mrn: "9000007104",
      patientName: "Synthetic Patient Delta",
      caseName: "Synthetic OR booking",
      pathway: "or-booking"
    })
  );
  const snapshot = await repository.snapshot();

  const taskChoices = quickEntryEpisodeChoices(snapshot, assessment.episode.record.id, "task");
  const procedureChoices = quickEntryEpisodeChoices(
    snapshot,
    assessment.episode.record.id,
    "procedure"
  );

  assert.deepEqual(
    taskChoices.map((choice) => choice.episode.id).sort(),
    [assessment.episode.record.id, booking.episode.record.id].sort()
  );
  assert.deepEqual(
    procedureChoices.map((choice) => choice.episode.id),
    [booking.episode.record.id]
  );
  assert.equal(procedureChoices[0]?.isCurrent, false);
});

test("a retired Episode selected earlier cannot receive a procedure", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({
      mrn: "9000007105",
      patientName: "Synthetic Patient Epsilon",
      caseName: "Synthetic OR booking",
      pathway: "or-booking"
    })
  );
  const choicesBeforeRetirement = quickEntryEpisodeChoices(
    await repository.snapshot(),
    created.episode.record.id,
    "procedure"
  );
  assert.equal(choicesBeforeRetirement.length, 1, "the picker could select the Episode");

  await service.archiveEpisode(created.episode.record.id, "Synthetic retirement");

  await assert.rejects(
    () => service.completeProcedure({
      patientId: created.patient.record.id,
      episodeId: created.episode.record.id,
      procedure: "Synthetic procedure",
      procedureDate: "2026-08-10",
      role: "Primary surgeon",
      outcome: "",
      followUpRequired: false,
      followUpDate: "",
      followUpPlan: ""
    }),
    /active episode/i
  );

  assert.equal((await repository.list<ProcedureRecord>("procedure")).length, 0);
  const retired = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(retired?.record.status, "archived");
});

test("procedure and archive races never revive a retired Episode", async () => {
  for (const first of ["archive", "procedure"] as const) {
    const { service, repository } = await harness();
    const created = await service.createEpisode(
      episodeInput({
        mrn: first === "archive" ? "9000007106" : "9000007107",
        patientName: "Synthetic Race Patient",
        caseName: `Synthetic ${first}-first procedure race`,
        pathway: "or-booking"
      })
    );
    const archive = () => service.archiveEpisode(created.episode.record.id, "Synthetic retirement");
    const procedure = () => service.completeProcedure({
      patientId: created.patient.record.id,
      episodeId: created.episode.record.id,
      procedure: "Synthetic procedure",
      procedureDate: "2026-08-10",
      role: "Primary surgeon",
      outcome: "",
      followUpRequired: false,
      followUpDate: "",
      followUpPlan: ""
    });
    let results: PromiseSettledResult<unknown>[];
    if (first === "archive") {
      const pause = pauseEpisodeArchive(repository, created.episode.path);
      const archiveResult = archive();
      await pause.entered;
      const procedureResult = procedure();
      await new Promise<void>((resolve) => setImmediate(resolve));
      pause.release();
      results = await Promise.allSettled([archiveResult, procedureResult]);
    } else {
      const pause = pauseNextRecordCreation(repository, "procedure");
      const procedureResult = procedure();
      await pause.entered;
      const archiveResult = archive();
      await new Promise<void>((resolve) => setImmediate(resolve));
      pause.release();
      results = await Promise.allSettled([procedureResult, archiveResult]);
    }
    const archiveResult = results[first === "archive" ? 0 : 1];
    const procedureResult = results[first === "archive" ? 1 : 0];
    const latest = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);

    assert.equal(archiveResult?.status, "fulfilled");
    assert.equal(latest?.record.status, "archived");
    if (first === "archive") {
      assert.equal(procedureResult?.status, "rejected");
      assert.equal((await repository.list<ProcedureRecord>("procedure")).length, 0);
    } else {
      assert.equal(procedureResult?.status, "fulfilled");
      assert.equal((await repository.list<ProcedureRecord>("procedure")).length, 1);
    }
  }
});

test("task and archive races never revive a retired Episode", async () => {
  for (const first of ["archive", "task"] as const) {
    const { service, repository } = await harness();
    const created = await service.createEpisode(
      episodeInput({
        mrn: first === "archive" ? "9000007108" : "9000007109",
        patientName: "Synthetic Task Race Patient",
        caseName: `Synthetic ${first}-first task race`
      })
    );
    const archive = () => service.archiveEpisode(created.episode.record.id, "Synthetic retirement");
    const task = () => service.createTask({
      patientId: created.patient.record.id,
      episodeId: created.episode.record.id,
      task: "Synthetic follow-up",
      taskType: "clinical-review",
      priority: "routine",
      dueDate: "2026-08-11",
      owner: ""
    });
    let results: PromiseSettledResult<unknown>[];
    if (first === "archive") {
      const pause = pauseEpisodeArchive(repository, created.episode.path);
      const archiveResult = archive();
      await pause.entered;
      const taskResult = task();
      await new Promise<void>((resolve) => setImmediate(resolve));
      pause.release();
      results = await Promise.allSettled([archiveResult, taskResult]);
    } else {
      const pause = pauseNextRecordCreation(repository, "task");
      const taskResult = task();
      await pause.entered;
      const archiveResult = archive();
      await new Promise<void>((resolve) => setImmediate(resolve));
      pause.release();
      results = await Promise.allSettled([taskResult, archiveResult]);
    }
    const archiveResult = results[first === "archive" ? 0 : 1];
    const taskResult = results[first === "archive" ? 1 : 0];
    const latest = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);

    if (first === "archive") {
      assert.equal(archiveResult?.status, "fulfilled");
      assert.equal(taskResult?.status, "rejected");
      assert.equal(latest?.record.status, "archived");
      assert.equal((await repository.list("task")).length, 0);
    } else {
      assert.equal(taskResult?.status, "fulfilled");
      assert.equal(archiveResult?.status, "rejected", "open work must block the later archive");
      assert.equal(latest?.record.status, "active");
      assert.equal((await repository.list("task")).length, 1);
    }
  }
});

test("task completion and cancellation serialize with a competing Episode update", { timeout: 3000 }, async () => {
  for (const transition of ["complete", "cancel"] as const) {
    const { service, repository } = await harness();
    const created = await service.createEpisode(
      episodeInput({
        mrn: transition === "complete" ? "9000007131" : "9000007132",
        patientName: "Synthetic Task Transition Patient",
        caseName: `Synthetic ${transition} transition`,
        nextAction: "Synthetic original task",
        dueDate: "2026-08-11"
      })
    );
    assert.ok(created.task);
    const pause = pauseNextRecordUpdate(
      repository,
      (path, changes) =>
        path === created.episode.path &&
        changes.status === "ready-to-close" &&
        changes.next_action === ""
    );
    const taskTransition = transition === "complete"
      ? service.completeTask(created.task.record.id)
      : service.cancelTask(created.task.record.id, "Synthetic cancellation");
    await pause.entered;

    const taskCreationEntered = observeRecordCreation(repository, "task");
    const update = service.updateEpisode(created.episode.record.id, {
      careSetting: "outpatient",
      pathway: "assessment",
      priority: "routine",
      nextAction: "Synthetic replacement task",
      dueDate: "2026-08-12"
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      taskCreationEntered(),
      false,
      `Episode update must wait for task ${transition} reconciliation`
    );

    pause.release();
    await Promise.all([taskTransition, update]);
    const latestEpisode = await repository.findById<EpisodeRecord>(
      "episode",
      created.episode.record.id
    );
    const openTasks = (await repository.list<TaskRecord>("task")).filter(
      ({ record }) =>
        record.episode_id === created.episode.record.id &&
        ["open", "in-progress", "waiting"].includes(record.status)
    );
    assert.equal(openTasks.length, 1);
    assert.equal(openTasks[0]?.record.task, "Synthetic replacement task");
    assert.equal(latestEpisode?.record.status, "active");
    assert.equal(latestEpisode?.record.next_action, "Synthetic replacement task");
    assert.equal(latestEpisode?.record.due_date, "2026-08-12");
  }
});

test("nested task transitions in Episode update and procedure flows do not deadlock", { timeout: 3000 }, async () => {
  const { service, repository } = await harness();
  const updatedCase = await service.createEpisode(
    episodeInput({
      mrn: "9000007133",
      patientName: "Synthetic Nested Update Patient",
      caseName: "Synthetic nested update",
      nextAction: "Synthetic superseded task",
      dueDate: "2026-08-11"
    })
  );
  await service.updateEpisode(updatedCase.episode.record.id, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    nextAction: "Synthetic current task",
    dueDate: "2026-08-12"
  });

  const procedureCase = await service.createEpisode(
    episodeInput({
      mrn: "9000007134",
      patientName: "Synthetic Nested Procedure Patient",
      caseName: "Synthetic nested procedure",
      pathway: "or-booking",
      nextAction: "Synthetic operating-room booking",
      dueDate: "2026-08-11"
    })
  );
  await service.completeProcedure({
    patientId: procedureCase.patient.record.id,
    episodeId: procedureCase.episode.record.id,
    procedure: "Synthetic nested procedure",
    procedureDate: "2026-08-10",
    role: "Primary surgeon",
    outcome: "",
    followUpRequired: false,
    followUpDate: "",
    followUpPlan: ""
  });

  const tasks = await repository.list<TaskRecord>("task");
  const superseded = tasks.find(({ record }) => record.task === "Synthetic superseded task");
  const booking = tasks.find(({ record }) => record.task === "Synthetic operating-room booking");
  assert.equal(superseded?.record.status, "cancelled");
  assert.equal(booking?.record.status, "completed");
});

test("persisted merge intent blocks every patient-owned Quick Entry write", async () => {
  const { service, repository } = await harness();
  const source = await service.createEpisode(
    episodeInput({
      mrn: "9000007110",
      patientName: "Synthetic Merge Source",
      caseName: "Synthetic source booking",
      pathway: "or-booking"
    })
  );
  const target = await service.createEpisode(
    episodeInput({
      mrn: "9000007111",
      patientName: "Synthetic Merge Target",
      caseName: "Synthetic target case"
    })
  );
  await repository.update(source.patient.path, {
    merge_in_progress: target.patient.record.id
  });

  await assert.rejects(
    () => service.createTask({
      patientId: source.patient.record.id,
      episodeId: source.episode.record.id,
      task: "Synthetic unsafe task",
      taskType: "clinical-review",
      priority: "routine",
      dueDate: "2026-08-11",
      owner: ""
    }),
    /active patient/i
  );
  await assert.rejects(
    () => service.updateEpisode(source.episode.record.id, {
      careSetting: "outpatient",
      pathway: "assessment",
      priority: "routine",
      nextAction: "Synthetic unsafe update",
      dueDate: "2026-08-11"
    }),
    /active patient/i
  );
  await assert.rejects(
    () => service.completeProcedure({
      patientId: source.patient.record.id,
      episodeId: source.episode.record.id,
      procedure: "Synthetic unsafe procedure",
      procedureDate: "2026-08-10",
      role: "Primary surgeon",
      outcome: "",
      followUpRequired: false,
      followUpDate: "",
      followUpPlan: ""
    }),
    /active patient/i
  );
  await assert.rejects(
    () => service.createEpisode(episodeInput({
      mrn: "",
      patientName: "Synthetic Merge Source",
      caseName: "Synthetic unsafe new episode",
      existingPatientId: source.patient.record.id
    })),
    /patient context changed/i
  );

  assert.equal((await repository.list<TaskRecord>("task")).length, 0);
  assert.equal((await repository.list<ProcedureRecord>("procedure")).length, 0);
});

test("task and procedure writes cannot cross a patient merge", async () => {
  for (const entity of ["task", "procedure"] as const) {
    const { service, repository } = await harness();
    const source = await service.createEpisode(
      episodeInput({
        mrn: entity === "task" ? "9000007112" : "9000007113",
        patientName: "Synthetic Locked Source",
        caseName: `Synthetic ${entity} source`,
        pathway: entity === "procedure" ? "or-booking" : "assessment"
      })
    );
    const target = await service.createEpisode(
      episodeInput({
        mrn: entity === "task" ? "9000007114" : "9000007115",
        patientName: "Synthetic Locked Target",
        caseName: `Synthetic ${entity} target`
      })
    );
    const pause = pauseNextRecordCreation(repository, entity);
    const write = entity === "task"
      ? service.createTask({
          patientId: source.patient.record.id,
          episodeId: source.episode.record.id,
          task: "Synthetic merge-race task",
          taskType: "clinical-review",
          priority: "routine",
          dueDate: "2026-08-11",
          owner: ""
        })
      : service.completeProcedure({
          patientId: source.patient.record.id,
          episodeId: source.episode.record.id,
          procedure: "Synthetic merge-race procedure",
          procedureDate: "2026-08-10",
          role: "Primary surgeon",
          outcome: "",
          followUpRequired: false,
          followUpDate: "",
          followUpPlan: ""
        });
    await pause.entered;

    const attempted = observeNextPatientLockAttempt(repository, source.patient.record.id);
    const mergeEntered = observePatientRead(repository, source.patient.record.id);
    const merge = service.mergePatients(source.patient.record.id, target.patient.record.id);
    await attempted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      mergeEntered(),
      false,
      `${entity} must retain the patient lock until its linked write is complete`
    );

    pause.release();
    await Promise.all([write, merge]);

    const latestEpisode = await repository.findById<EpisodeRecord>(
      "episode",
      source.episode.record.id
    );
    const linked = entity === "task"
      ? await repository.list<TaskRecord>("task")
      : await repository.list<ProcedureRecord>("procedure");
    assert.equal(latestEpisode?.record.patient_id, target.patient.record.id);
    assert.equal(linked.length, 1);
    assert.equal(linked[0]?.record.patient_id, target.patient.record.id);
    assert.equal(linked[0]?.record.episode_id, source.episode.record.id);
  }
});

test("Episode updates that create tasks cannot cross a patient merge", async () => {
  const { service, repository } = await harness();
  const source = await service.createEpisode(
    episodeInput({
      mrn: "9000007116",
      patientName: "Synthetic Update Source",
      caseName: "Synthetic update source"
    })
  );
  const target = await service.createEpisode(
    episodeInput({
      mrn: "9000007117",
      patientName: "Synthetic Update Target",
      caseName: "Synthetic update target"
    })
  );
  const pause = pauseNextRecordCreation(repository, "task");
  const update = service.updateEpisode(source.episode.record.id, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    nextAction: "Synthetic update task",
    dueDate: "2026-08-11"
  });
  await pause.entered;

  const attempted = observeNextPatientLockAttempt(repository, source.patient.record.id);
  const mergeEntered = observePatientRead(repository, source.patient.record.id);
  const merge = service.mergePatients(source.patient.record.id, target.patient.record.id);
  await attempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(mergeEntered(), false, "the merge must wait for the Episode update");

  pause.release();
  await Promise.all([update, merge]);

  const latestEpisode = await repository.findById<EpisodeRecord>(
    "episode",
    source.episode.record.id
  );
  const tasks = await repository.list<TaskRecord>("task");
  assert.equal(latestEpisode?.record.patient_id, target.patient.record.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.record.patient_id, target.patient.record.id);
});

test("explicit and automatic patient reuse cannot create an Episode behind a merge scan", async () => {
  for (const resolution of ["explicit", "automatic"] as const) {
    const { service, repository } = await harness();
    const sourceMrn = resolution === "explicit" ? "9000007118" : "9000007119";
    const source = await service.createEpisode(
      episodeInput({
        mrn: sourceMrn,
        patientName: "Synthetic Episode Source",
        caseName: `Synthetic ${resolution} baseline`
      })
    );
    const target = await service.createEpisode(
      episodeInput({
        mrn: resolution === "explicit" ? "9000007120" : "9000007121",
        patientName: "Synthetic Episode Target",
        caseName: `Synthetic ${resolution} target`
      })
    );
    const pause = pauseNextRecordCreation(repository, "episode");
    const create = service.createEpisode(episodeInput({
      mrn: resolution === "automatic" ? sourceMrn : "",
      patientName: "Synthetic Episode Source",
      caseName: `Synthetic ${resolution} concurrent episode`,
      ...(resolution === "explicit"
        ? { existingPatientId: source.patient.record.id }
        : {})
    }));
    await pause.entered;

    const attempted = observeNextPatientLockAttempt(repository, source.patient.record.id);
    const mergeEntered = observePatientRead(repository, source.patient.record.id);
    const merge = service.mergePatients(source.patient.record.id, target.patient.record.id);
    await attempted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(mergeEntered(), false, `${resolution} reuse must hold the source patient lock`);

    pause.release();
    const [created] = await Promise.all([create, merge]);
    const latest = await repository.findById<EpisodeRecord>(
      "episode",
      created.episode.record.id
    );
    assert.equal(latest?.record.patient_id, target.patient.record.id);
  }
});

test("archiving the last Episode cannot cross creation of a new Episode", async () => {
  const { service, repository } = await harness();
  const source = await service.createEpisode(
    episodeInput({
      mrn: "9000007122",
      patientName: "Synthetic Archive Source",
      caseName: "Synthetic last Episode"
    })
  );
  const pause = pauseNextRecordUpdate(
    repository,
    (path, changes) => path === source.patient.path && changes.status === "archived"
  );
  const archive = service.archiveEpisode(source.episode.record.id, "Synthetic closure");
  await pause.entered;

  const attempted = observeNextPatientLockAttempt(repository, source.patient.record.id);
  const episodeCreationEntered = observeRecordCreation(repository, "episode");
  const create = service.createEpisode(episodeInput({
    mrn: "",
    patientName: "Synthetic Archive Source",
    caseName: "Synthetic newly active Episode",
    existingPatientId: source.patient.record.id
  }));
  await attempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    episodeCreationEntered(),
    false,
    "new Episode creation must wait until last-Episode archiving finishes"
  );

  pause.release();
  const [, created] = await Promise.all([archive, create]);
  const patient = await repository.findById<PatientRecord>("patient", source.patient.record.id);
  const oldEpisode = await repository.findById<EpisodeRecord>(
    "episode",
    source.episode.record.id
  );
  const newEpisode = await repository.findById<EpisodeRecord>(
    "episode",
    created.episode.record.id
  );
  assert.equal(patient?.record.status, "active");
  assert.equal(oldEpisode?.record.status, "archived");
  assert.equal(newEpisode?.record.status, "active");
});

test("restoring an Episode cannot reactivate a patient across a merge", async () => {
  const { service, repository } = await harness();
  const source = await service.createEpisode(
    episodeInput({
      mrn: "9000007123",
      patientName: "Synthetic Restore Source",
      caseName: "Synthetic archived Episode"
    })
  );
  const target = await service.createEpisode(
    episodeInput({
      mrn: "9000007124",
      patientName: "Synthetic Restore Target",
      caseName: "Synthetic surviving Episode"
    })
  );
  await service.archiveEpisode(source.episode.record.id, "Synthetic closure");
  const pause = pauseNextRecordUpdate(
    repository,
    (path, changes) => path === source.patient.path && changes.status === "active"
  );
  const restore = service.restoreEpisode(source.episode.record.id);
  await pause.entered;

  const attempted = observeNextPatientLockAttempt(repository, source.patient.record.id);
  const mergeEntered = observePatientRead(repository, source.patient.record.id);
  const merge = service.mergePatients(source.patient.record.id, target.patient.record.id);
  await attempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(mergeEntered(), false, "the merge must wait until restoration finishes");

  pause.release();
  await Promise.all([restore, merge]);
  const retiredSource = await repository.findById<PatientRecord>(
    "patient",
    source.patient.record.id
  );
  const latestEpisode = await repository.findById<EpisodeRecord>(
    "episode",
    source.episode.record.id
  );
  assert.equal(retiredSource?.record.status, "entered-in-error");
  assert.equal(retiredSource?.record.merged_into, target.patient.record.id);
  assert.equal(latestEpisode?.record.patient_id, target.patient.record.id);
});

test("identity correction cannot leave a source wikilink behind a patient merge", async () => {
  const { service, repository } = await harness();
  const source = await service.createEpisode(
    episodeInput({
      mrn: "9000007125",
      patientName: "Synthetic Identity Source",
      caseName: "Synthetic identity Episode"
    })
  );
  const target = await service.createEpisode(
    episodeInput({
      mrn: "9000007126",
      patientName: "Synthetic Identity Target",
      caseName: "Synthetic target Episode"
    })
  );
  const pause = pauseNextRecordUpdate(
    repository,
    (path, changes) =>
      path === source.episode.path &&
      typeof changes.patient === "string" &&
      !("patient_id" in changes)
  );
  const identity = service.updatePatientIdentity(source.patient.record.id, {
    mrn: source.patient.record.mrn,
    patientName: "Synthetic Corrected Source",
    phone: ""
  });
  await pause.entered;

  const attempted = observeNextPatientLockAttempt(repository, source.patient.record.id);
  const mergeEntered = observePatientRead(repository, source.patient.record.id);
  const merge = service.mergePatients(source.patient.record.id, target.patient.record.id);
  await attempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(mergeEntered(), false, "the merge must wait for identity link correction");

  pause.release();
  await Promise.all([identity, merge]);
  const latestEpisode = await repository.findById<EpisodeRecord>(
    "episode",
    source.episode.record.id
  );
  assert.equal(latestEpisode?.record.patient_id, target.patient.record.id);
  assert.equal(
    latestEpisode?.record.patient,
    wikilink(target.patient.path, target.patient.record.patient_name)
  );
});

test("two identity corrections cannot claim the same normalized MRN", { timeout: 3000 }, async () => {
  const { service, repository } = await harness();
  const first = await service.createEpisode(
    episodeInput({
      mrn: "9000007137",
      patientName: "Synthetic MRN Alpha",
      caseName: "Synthetic MRN Alpha Episode"
    })
  );
  const second = await service.createEpisode(
    episodeInput({
      mrn: "9000007138",
      patientName: "Synthetic MRN Beta",
      caseName: "Synthetic MRN Beta Episode"
    })
  );
  const sharedMrn = "9000007199";
  const sharedKey = mrnMatchKey(sharedMrn);
  const pause = pauseNextRecordUpdate(
    repository,
    (path, changes) => path === first.patient.path && changes.mrn === sharedMrn
  );
  const firstUpdate = service.updatePatientIdentity(first.patient.record.id, {
    mrn: sharedMrn,
    patientName: first.patient.record.patient_name,
    phone: ""
  });
  await pause.entered;

  const identityLockAttempted = observeNextLockAttempt(repository, `patient:${sharedKey}`);
  const secondLookupEntered = observeMrnLookup(repository);
  const secondUpdate = service.updatePatientIdentity(second.patient.record.id, {
    mrn: sharedMrn,
    patientName: second.patient.record.patient_name,
    phone: ""
  });
  await identityLockAttempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    secondLookupEntered(),
    false,
    "the second real collision lookup must wait behind the normalized MRN lock"
  );

  pause.release();
  const results = await Promise.allSettled([firstUpdate, secondUpdate]);
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  const patients = await repository.list<PatientRecord>("patient");
  assert.equal(
    patients.filter(({ record }) => mrnMatchKey(record.mrn) === sharedKey).length,
    1
  );
});

test("Episode creation and identity correction share the normalized MRN lock", { timeout: 3000 }, async () => {
  const { service, repository } = await harness();
  const patient = await service.createEpisode(
    episodeInput({
      mrn: "9000007140",
      patientName: "Synthetic Shared Identity",
      caseName: "Synthetic shared identity baseline"
    })
  );
  const sharedMrn = "9000007141";
  const sharedKey = mrnMatchKey(sharedMrn);
  const pause = pauseNextRecordUpdate(
    repository,
    (path, changes) => path === patient.patient.path && changes.mrn === sharedMrn
  );
  const identity = service.updatePatientIdentity(patient.patient.record.id, {
    mrn: sharedMrn,
    patientName: patient.patient.record.patient_name,
    phone: ""
  });
  await pause.entered;

  const identityLockAttempted = observeNextLockAttempt(repository, `patient:${sharedKey}`);
  const createLookupEntered = observeMrnLookup(repository);
  const create = service.createEpisode(episodeInput({
    mrn: sharedMrn,
    patientName: "Synthetic Shared Identity",
    caseName: "Synthetic shared identity concurrent Episode"
  }));
  await identityLockAttempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    createLookupEntered(),
    false,
    "Episode resolution must wait behind identity correction of the same MRN"
  );

  pause.release();
  const [, created] = await Promise.all([identity, create]);
  assert.equal(created.reusedPatient, true);
  assert.equal(created.patient.record.id, patient.patient.record.id);
  const patients = await repository.list<PatientRecord>("patient");
  assert.equal(
    patients.filter(({ record }) => mrnMatchKey(record.mrn) === sharedKey).length,
    1
  );
});

test("Episode creation rejects a stale MRN resolution after identity changes", { timeout: 3000 }, async () => {
  const { service, repository } = await harness();
  const originalMrn = "9000007142";
  const patient = await service.createEpisode(
    episodeInput({
      mrn: originalMrn,
      patientName: "Synthetic Stale Resolution",
      caseName: "Synthetic stale baseline"
    })
  );
  const pause = pauseNextLockAttempt(
    repository,
    `patient-merge:${patient.patient.record.id}`
  );
  const create = service.createEpisode(episodeInput({
    mrn: originalMrn,
    patientName: "Synthetic Stale Resolution",
    caseName: "Synthetic stale concurrent Episode"
  }));
  await pause.entered;

  await service.updatePatientIdentity(patient.patient.record.id, {
    mrn: "9000007143",
    patientName: patient.patient.record.patient_name,
    phone: ""
  });
  pause.release();
  await assert.rejects(create, /patient identity changed/i);

  const episodes = await repository.list<EpisodeRecord>("episode");
  assert.equal(
    episodes.filter(({ record }) => record.case === "Synthetic stale concurrent Episode").length,
    0
  );
});

test("opposite patient merges serialize on both patient keys without a cycle", { timeout: 3000 }, async () => {
  const { service, repository } = await harness();
  const first = await service.createEpisode(
    episodeInput({
      mrn: "9000007127",
      patientName: "Synthetic Merge Alpha",
      caseName: "Synthetic Alpha Episode"
    })
  );
  const second = await service.createEpisode(
    episodeInput({
      mrn: "9000007128",
      patientName: "Synthetic Merge Beta",
      caseName: "Synthetic Beta Episode"
    })
  );
  const pause = pauseNextRecordUpdate(
    repository,
    (path, changes) =>
      path === first.patient.path && changes.merge_in_progress === second.patient.record.id
  );
  const alphaIntoBeta = service.mergePatients(first.patient.record.id, second.patient.record.id);
  await pause.entered;

  const firstLockId = [first.patient.record.id, second.patient.record.id]
    .sort((left, right) => left.localeCompare(right))[0]!;
  const attempted = observeNextPatientLockAttempt(repository, firstLockId);
  const secondMergeEntered = observePatientRead(repository, second.patient.record.id);
  const betaIntoAlpha = service.mergePatients(second.patient.record.id, first.patient.record.id);
  await attempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondMergeEntered(), false, "the opposite merge must wait for both patient locks");

  pause.release();
  const results = await Promise.allSettled([alphaIntoBeta, betaIntoAlpha]);
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  const alpha = await repository.findById<PatientRecord>("patient", first.patient.record.id);
  const beta = await repository.findById<PatientRecord>("patient", second.patient.record.id);
  assert.equal(alpha?.record.merged_into, second.patient.record.id);
  assert.equal(beta?.record.merged_into, "");
  const episodes = await repository.list<EpisodeRecord>("episode");
  assert.ok(episodes.every(({ record }) => record.patient_id === second.patient.record.id));
});

test("an archived patient cannot be selected as the surviving merge target", async () => {
  const { service, repository } = await harness();
  const source = await service.createEpisode(
    episodeInput({
      mrn: "9000007129",
      patientName: "Synthetic Active Merge Source",
      caseName: "Synthetic active source"
    })
  );
  const target = await service.createEpisode(
    episodeInput({
      mrn: "9000007130",
      patientName: "Synthetic Archived Merge Target",
      caseName: "Synthetic archived target"
    })
  );
  await service.archiveEpisode(target.episode.record.id, "Synthetic target closure");

  await assert.rejects(
    () => service.previewPatientMerge(source.patient.record.id, target.patient.record.id),
    /selected to keep/i
  );
  await assert.rejects(
    () => service.mergePatients(source.patient.record.id, target.patient.record.id),
    /selected to keep/i
  );
  const latestSource = await repository.findById<PatientRecord>(
    "patient",
    source.patient.record.id
  );
  const latestEpisode = await repository.findById<EpisodeRecord>(
    "episode",
    source.episode.record.id
  );
  assert.equal(latestSource?.record.status, "active");
  assert.equal(latestSource?.record.merged_into, "");
  assert.equal(latestEpisode?.record.patient_id, source.patient.record.id);

  const viewSource = await readFile(new URL("../src/ui/workspace-view.ts", import.meta.url), "utf8");
  assert.match(viewSource, /patient\.status === "active"/);
  assert.match(viewSource, /!patient\.merge_in_progress/);
});

test("a merge cannot cross archiving of its surviving target", { timeout: 3000 }, async () => {
  const { service, repository } = await harness();
  const source = await service.createEpisode(
    episodeInput({
      mrn: "9000007135",
      patientName: "Synthetic Merge Source During Archive",
      caseName: "Synthetic source during target archive"
    })
  );
  const target = await service.createEpisode(
    episodeInput({
      mrn: "9000007136",
      patientName: "Synthetic Merge Target During Archive",
      caseName: "Synthetic target being archived"
    })
  );
  const pause = pauseNextRecordUpdate(
    repository,
    (path, changes) => path === target.patient.path && changes.status === "archived"
  );
  const archive = service.archiveEpisode(target.episode.record.id, "Synthetic target closure");
  await pause.entered;

  const targetLockAttempted = observeNextPatientLockAttempt(
    repository,
    target.patient.record.id
  );
  const mergeEntered = observePatientRead(repository, source.patient.record.id);
  const merge = service.mergePatients(source.patient.record.id, target.patient.record.id);
  await targetLockAttempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(mergeEntered(), false, "the merge must wait for the target patient lock");

  pause.release();
  const results = await Promise.allSettled([archive, merge]);
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  const latestSource = await repository.findById<PatientRecord>(
    "patient",
    source.patient.record.id
  );
  const latestEpisode = await repository.findById<EpisodeRecord>(
    "episode",
    source.episode.record.id
  );
  assert.equal(latestSource?.record.status, "active");
  assert.equal(latestSource?.record.merged_into, "");
  assert.equal(latestEpisode?.record.patient_id, source.patient.record.id);
});

test("commands intentionally ship without default hotkeys", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /hotkeys\s*:/);
  assert.match(source, /QUICK_ENTRY_COMMAND_IDS\.hub/);
  assert.match(source, /QUICK_ENTRY_COMMAND_IDS\["new-patient-episode"\]/);
  assert.match(source, /QUICK_ENTRY_COMMAND_IDS\["add-task-follow-up"\]/);
  assert.match(source, /QUICK_ENTRY_COMMAND_IDS\["record-procedure"\]/);
  assert.match(source, /QUICK_ENTRY_COMMAND_IDS\.today/);
  assert.match(source, /addRibbonIcon\("square-pen", "Clinical Workspace quick entry"/);
});

test("active Markdown context is captured before workspace activation", async () => {
  const app = new App();
  const episodePath = "Clinical Workspace/Episodes/EPI-SYNTHETIC-CONTEXT.md";
  let activeView: { file: StubTFile } | null = { file: new StubTFile(episodePath) };
  Object.assign(app, {
    workspace: {
      getActiveViewOfType: () => activeView
    }
  });

  const received: string[] = [];
  const fakeView = {
    openQuickEntry: (path: string) => received.push(`hub:${path}`),
    openAddTaskQuickEntry: (path: string) => received.push(`task:${path}`),
    openProcedureQuickEntry: (path: string) => received.push(`procedure:${path}`)
  } as unknown as ClinicalWorkspaceView;
  const plugin = new ClinicalWorkspacePlugin(app, {} as never) as unknown as {
    app: App;
    openQuickEntry: () => Promise<void>;
    openAddTask: () => Promise<void>;
    openRecordProcedure: () => Promise<void>;
    runWorkspaceEntry: (
      action: (view: ClinicalWorkspaceView) => void | Promise<void>,
      fallbackMessage: string
    ) => Promise<void>;
  };
  plugin.app = app;
  plugin.runWorkspaceEntry = async (action) => {
    // Activation replaces the active Markdown view with the custom workspace.
    // The path must already be captured before this point.
    activeView = null;
    await action(fakeView);
  };

  await plugin.openAddTask();
  activeView = { file: new StubTFile(episodePath) };
  await plugin.openRecordProcedure();
  activeView = { file: new StubTFile(episodePath) };
  await plugin.openQuickEntry();

  assert.deepEqual(received, [
    `task:${episodePath}`,
    `procedure:${episodePath}`,
    `hub:${episodePath}`
  ]);
});

test("the Episode picker requires a visible confirmation click even for current context", async () => {
  const modalSource = await readFile(new URL("../src/ui/modals.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const viewSource = await readFile(new URL("../src/ui/workspace-view.ts", import.meta.url), "utf8");
  assert.match(modalSource, /Current episode/);
  assert.match(modalSource, /Confirm current episode/);
  assert.match(modalSource, /shortcut never chooses or attaches a record automatically/);
  assert.match(modalSource, /choose\.addEventListener\("click"/);
  assert.match(modalSource, /calculateClinicalModalViewportLayout/);
  assert.match(modalSource, /CLINICAL_MODAL_VIEWPORT_SYNC_DELAYS = \[0, 60, 180, 420\]/);
  assert.match(modalSource, /ClinicalModalViewportController/);
  assert.match(modalSource, /this\.host\.applyLayout[\s\S]*this\.host\.revealFocusedControl\(\)/);
  assert.match(styles, /\.clinical-modal button\.clinical-quick-entry-option\s*\{[^}]*white-space: normal;/s);
  assert.match(styles, /\.is-mobile \.clinical-modal > \.modal-content\s*\{[^}]*flex: 1 1 0;[^}]*height: 0;/s);
  assert.match(styles, /\.is-mobile \.clinical-modal\s*\{[^}]*--clinical-modal-visual-height[^}]*translate:/s);
  assert.match(styles, /--clinical-modal-visual-height/);
  assert.match(modalSource, /--keyboard-height/);
  assert.match(modalSource, /clinical-episode-picker-body/);
  assert.match(modalSource, /episodeChoiceAccessibleLabel\(this\.actionLabel, choice\)/);
  assert.match(modalSource, /DuplicatePatientModal[\s\S]*clinical-modal-body/);
  assert.match(modalSource, /MergePatientsModal[\s\S]*clinical-modal-body/);
  const mobileGeometry = styles.indexOf(".is-mobile .clinical-modal {");
  const portraitMedia = styles.indexOf("@media (max-width: 600px)");
  assert.ok(mobileGeometry >= 0 && portraitMedia > mobileGeometry, "mobile geometry must not be portrait-width gated");
  assert.match(styles, /\.clinical-modal-body\s*\{[^}]*overflow-y: auto;[^}]*overflow-x: hidden;/s);
  assert.match(styles, /\.clinical-quick-entry-option > \*\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/s);
  assert.match(mainSource, /getActiveViewOfType\(MarkdownView\)/);
  assert.doesNotMatch(mainSource, /getActiveFile\(\)\?\.path/);
  assert.match(viewSource, /item\.path === activeEpisodePath/);
});
