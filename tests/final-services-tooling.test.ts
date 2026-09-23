/**
 * Final-review fixes in the services and tooling: a reworded next action
 * under a new pathway, closing tasks at discharge, undoing a recurring
 * completion on an on-hold episode, the MRN-owner confirmation, the patient
 * list's Opened date, and the CI gates for NUL bytes and identifier-shaped
 * literals. Synthetic data only; MRNs are 9000-series, and every other long
 * digit run is built at runtime so the identifier gate never sees it.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "yaml";
import { formatLocalDateTime, isoDateWithOffset, todayIso } from "../src/domain/schema";
import type { EpisodeRecord, PatientRecord, TaskRecord } from "../src/domain/types";
import { MrnIdentityConflictError } from "../src/services/clinical-service";
import {
  buildPatientListCsv,
  buildPatientListMarkdown,
  DEFAULT_PATIENT_LIST_FILTER,
  selectPatientListRows
} from "../src/services/patient-list";
import { episodeInput, harness, type Harness } from "./support/harness";

const run = promisify(execFile);

const tasksOf = async (h: Harness, episodeId: string): Promise<TaskRecord[]> =>
  (await h.repository.list<TaskRecord>("task"))
    .map((item) => item.record)
    .filter((task) => task.episode_id === episodeId);

const episodeOf = async (h: Harness, episodeId: string): Promise<EpisodeRecord> => {
  const found = await h.repository.findById<EpisodeRecord>("episode", episodeId);
  assert.ok(found);
  return found.record;
};

// --- services-data F1: reword plus pathway change -----------------------------

test("rewording a repeating task while switching to OR booking starts new work that the procedure closes", async () => {
  const h = await harness();
  const today = todayIso();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000710001",
      patientName: "Synthetic Juliet",
      caseName: "Leg wound",
      pathway: "opd-follow-up",
      nextAction: "Clinic review",
      dueDate: isoDateWithOffset(10, today)
    })
  );
  const episodeId = created.episode.record.id;
  // The clinic follow-up became a weekly repeating dressing check.
  assert.ok(created.task);
  await h.service.cancelTask(created.task.record.id, "Replaced by the dressing series");
  const dressing = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId,
    task: "Weekly dressing check",
    taskType: "wound-care",
    priority: "routine",
    dueDate: isoDateWithOffset(1, today),
    owner: "Dr Synthetic",
    repeatEveryDays: 7
  });
  assert.equal((await episodeOf(h, episodeId)).next_action, "Weekly dressing check");

  const updated = await h.service.updateEpisode(episodeId, {
    careSetting: "outpatient",
    pathway: "or-booking",
    priority: "routine",
    nextAction: "Book OR for debridement",
    dueDate: isoDateWithOffset(5, today)
  });
  assert.equal(updated.task.kind, "created");
  if (updated.task.kind !== "created") return;
  const booking = updated.task.task.record;
  assert.equal(booking.task_type, "book-or", "the new pathway's type");
  assert.equal(booking.repeat_every_days ?? 0, 0, "the old series is not carried onto new work");
  assert.equal(booking.owner, "", "nor is the old owner");
  const replaced = await h.repository.findById<TaskRecord>("task", dressing.task.record.id);
  assert.equal(replaced?.record.status, "cancelled");

  await h.service.completeProcedure({
    patientId: created.patient.record.id,
    episodeId,
    procedure: "Debridement",
    procedureDate: today,
    role: "Primary surgeon",
    outcome: "",
    followUpRequired: false,
    followUpDate: "",
    followUpPlan: ""
  });
  const open = (await tasksOf(h, episodeId)).filter(
    (task) => task.status === "open" || task.status === "in-progress" || task.status === "waiting"
  );
  assert.deepEqual(open, [], "no phantom OR booking comes back after the procedure");
  const episode = await episodeOf(h, episodeId);
  assert.equal(episode.status, "ready-to-close");
  assert.equal(episode.next_action, "");
});

test("rewording without a pathway change still carries the type, owner and series", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({ mrn: "9000710002", patientName: "Synthetic Kilo", caseName: "Arm wound" })
  );
  const episodeId = created.episode.record.id;
  await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId,
    task: "Weekly dressing check",
    taskType: "wound-care",
    priority: "routine",
    dueDate: isoDateWithOffset(1, todayIso()),
    owner: "Dr Synthetic",
    repeatEveryDays: 7
  });
  const updated = await h.service.updateEpisode(episodeId, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    nextAction: "Weekly dressing and swab",
    dueDate: isoDateWithOffset(2, todayIso())
  });
  assert.equal(updated.task.kind, "created");
  if (updated.task.kind !== "created") return;
  assert.equal(updated.task.task.record.task_type, "wound-care");
  assert.equal(updated.task.task.record.owner, "Dr Synthetic");
  assert.equal(updated.task.task.record.repeat_every_days, 7);
});

// --- services-data F2: closing tasks at discharge -----------------------------

async function episodeWithTwoTasks(h: Harness, mrn: string) {
  const today = todayIso();
  const created = await h.service.createEpisode(
    episodeInput({ mrn, patientName: "Synthetic Lima", caseName: "Ward stay", nextAction: "First check", dueDate: today })
  );
  const second = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Second check",
    taskType: "other",
    priority: "routine",
    dueDate: isoDateWithOffset(2, today),
    owner: ""
  });
  assert.ok(created.task);
  return { created, first: created.task, second: second.task };
}

test("a task filed under another patient refuses close-at-discharge before any task is cancelled", async () => {
  const h = await harness();
  const { created, second } = await episodeWithTwoTasks(h, "9000710003");
  const episodeId = created.episode.record.id;
  const other = await h.service.createEpisode(
    episodeInput({ mrn: "9000710004", patientName: "Synthetic Mike", caseName: "Other case" })
  );
  // What Sync can leave behind after a merge on another device.
  await h.repository.update<TaskRecord>(second.path, { patient_id: other.patient.record.id });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true }),
      (error: Error) => {
        assert.match(error.message, /filed under a different patient, so no task was closed/);
        assert.match(error.message, /integrity check/);
        assert.doesNotMatch(error.message, /Retry/, "a retry cannot succeed, so it is not suggested");
        assert.doesNotMatch(error.message, /Synthetic|\d{4,}|TSK-|PAT-/, "the message is identifier-free");
        return true;
      }
    );
  }
  const tasks = await tasksOf(h, episodeId);
  assert.deepEqual(
    tasks.map((task) => task.status).sort(),
    ["open", "open"],
    "nothing was cancelled"
  );
  const episode = await episodeOf(h, episodeId);
  assert.equal(episode.status, "active");
  assert.equal(episode.next_action, "First check");

  // Repaired as the integrity check says, the same discharge goes through.
  await h.repository.update<TaskRecord>(second.path, { patient_id: created.patient.record.id });
  const archived = await h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true });
  assert.equal(archived.record.status, "archived");
  assert.equal(archived.cancelledTasks, 2);
});

test("close-at-discharge interrupted part-way still re-points the episode away from the cancelled task", async () => {
  const h = await harness();
  const { created, first, second } = await episodeWithTwoTasks(h, "9000710005");
  const episodeId = created.episode.record.id;
  const realUpdate = h.repository.update.bind(h.repository);
  // The first cancellation lands; the second fails, whichever task it is.
  let cancellations = 0;
  (h.repository as unknown as { update: typeof realUpdate }).update = async (target, changes) => {
    if (changes.status === "cancelled" && ++cancellations === 2) throw new Error("EIO: simulated failure");
    return realUpdate(target, changes);
  };

  await assert.rejects(
    () => h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true }),
    /simulated failure/
  );
  const tasks = await tasksOf(h, episodeId);
  assert.deepEqual(tasks.map((task) => task.status).sort(), ["cancelled", "open"]);
  const stillOpen = tasks.find((task) => task.status === "open");
  assert.ok(stillOpen && [first.record.id, second.record.id].includes(stillOpen.id));
  const episode = await episodeOf(h, episodeId);
  assert.equal(episode.status, "active");
  assert.equal(episode.next_action, stillOpen.task, "the episode mirrors the task still open");
  assert.equal(episode.due_date, stillOpen.due_date);

  (h.repository as unknown as { update: typeof realUpdate }).update = realUpdate;
  const retried = await h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true });
  assert.equal(retried.record.status, "archived");
  assert.equal(retried.cancelledTasks, 1);
});

// --- services-data F3: undo on an on-hold episode -----------------------------

test("undoing a recurring completion on an on-hold episode keeps it on hold, with no ready-to-close write", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({ mrn: "9000710006", patientName: "Synthetic November", caseName: "Awaiting results" })
  );
  const episodeId = created.episode.record.id;
  const daily = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId,
    task: "Weekly observations",
    taskType: "clinical-review",
    priority: "routine",
    dueDate: isoDateWithOffset(1, todayIso()),
    owner: "",
    repeatEveryDays: 7
  });
  await h.repository.update<EpisodeRecord>(created.episode.path, { status: "on-hold" });
  await h.service.completeTask(daily.task.record.id);
  assert.equal((await episodeOf(h, episodeId)).status, "on-hold", "the next occurrence keeps it on hold");

  const statusesWritten: unknown[] = [];
  const realUpdate = h.repository.update.bind(h.repository);
  (h.repository as unknown as { update: typeof realUpdate }).update = async (target, changes) => {
    if (target === created.episode.path && "status" in changes) statusesWritten.push(changes.status);
    return realUpdate(target, changes);
  };
  const reopened = await h.service.reopenTask(daily.task.record.id);
  assert.equal(reopened.nextOccurrence, "cancelled");
  assert.equal(reopened.record.status, "open");
  assert.ok(!statusesWritten.includes("ready-to-close"), `episode status writes: ${statusesWritten.join(", ")}`);
  assert.ok(!statusesWritten.includes("active"), `episode status writes: ${statusesWritten.join(", ")}`);
  const episode = await episodeOf(h, episodeId);
  assert.equal(episode.status, "on-hold");
  assert.equal(episode.next_action, "Weekly observations");
  const open = (await tasksOf(h, episodeId)).filter((task) => task.status === "open");
  assert.deepEqual(open.map((task) => task.id), [daily.task.record.id], "the series runs once");
});

// --- services-data F4: the MRN-owner confirmation names a record --------------

test("an MRN-owner confirmation applies only to the record the user was shown", async () => {
  const h = await harness();
  const shown = await h.service.createEpisode(
    episodeInput({ mrn: "9000710007", patientName: "Synthetic Oscar", caseName: "Case A" })
  );
  const typed = { mrn: "9000710007", patientName: "Synthetic Papa", caseName: "Case B" };
  let conflict: MrnIdentityConflictError | undefined;
  await assert.rejects(
    () => h.service.createEpisode(episodeInput(typed)),
    (error: unknown) => {
      assert.ok(error instanceof MrnIdentityConflictError);
      conflict = error;
      return true;
    }
  );
  assert.equal(conflict?.patient.id, shown.patient.record.id);

  // While the question was open, Sync corrected the shown chart's MRN and
  // another chart now holds the typed one.
  await h.repository.update<PatientRecord>(shown.patient.path, { mrn: "9000710008" });
  const newOwner = await h.service.createEpisode(
    episodeInput({ mrn: "9000710007", patientName: "Synthetic Quebec", caseName: "Case C" })
  );
  assert.notEqual(newOwner.patient.record.id, shown.patient.record.id);

  await assert.rejects(
    () => h.service.createEpisode(episodeInput({ ...typed, confirmMrnOwner: shown.patient.record.id })),
    (error: unknown) => {
      assert.ok(error instanceof MrnIdentityConflictError, "asked again, about the new owner");
      assert.equal(error.patient.id, newOwner.patient.record.id);
      return true;
    }
  );
  const caseB = (await h.repository.list<EpisodeRecord>("episode")).filter(({ record }) => record.case === "Case B");
  assert.equal(caseB.length, 0, "nothing was filed under a chart the user never saw");

  const confirmed = await h.service.createEpisode(
    episodeInput({ ...typed, confirmMrnOwner: newOwner.patient.record.id })
  );
  assert.equal(confirmed.patient.record.id, newOwner.patient.record.id);
  assert.equal(confirmed.patient.record.patient_name, "Synthetic Quebec", "the stored name is kept");
});

// --- services-data F5: the patient list's Opened date -------------------------

test("the patient list's Opened column is the local date, not the UTC one", () => {
  const previous = process.env.TZ;
  // UTC+3 all year: 22:30 UTC on the 22nd is 01:30 on the 23rd.
  process.env.TZ = "Asia/Riyadh";
  try {
    const openedAt = "2026-09-22T22:30:00.000Z";
    assert.equal(formatLocalDateTime(openedAt).slice(0, 10), "2026-09-23", "the zone took effect");
    const patient: PatientRecord = {
      schema_version: 3,
      entity: "patient",
      id: "PAT-opened",
      created_at: openedAt,
      updated_at: openedAt,
      tags: ["clinical/patient"],
      mrn: "9000710009",
      mrn_status: "confirmed",
      patient_name: "Synthetic Romeo",
      phone: "",
      phone_status: "not-found",
      status: "active",
      merged_into: ""
    };
    const episode: EpisodeRecord = {
      schema_version: 3,
      entity: "episode",
      id: "EPI-opened",
      created_at: openedAt,
      updated_at: openedAt,
      tags: ["clinical/episode"],
      patient_id: patient.id,
      patient: "",
      case: "Night admission",
      care_setting: "inpatient",
      pathway: "assessment",
      priority: "routine",
      status: "active",
      next_action: "",
      due_date: "",
      opened_at: openedAt,
      closed_at: "",
      outcome: "",
      pathway_before_archive: "",
      status_before_archive: ""
    };
    const rows = selectPatientListRows(
      { patients: [patient], episodes: [episode], tasks: [], procedures: [] },
      DEFAULT_PATIENT_LIST_FILTER,
      "2026-09-23"
    );
    const csv = buildPatientListCsv(rows);
    const [header, row] = csv.replace(/^\uFEFF/, "").split("\r\n");
    const opened = (header ?? "").split(",").indexOf('"Opened"');
    assert.ok(opened >= 0);
    assert.equal((row ?? "").split(",")[opened], '"2026-09-23"');
    const markdown = buildPatientListMarkdown(rows, DEFAULT_PATIENT_LIST_FILTER, "2026-09-23");
    assert.match(markdown, /\| 2026-09-23 \|/);
    assert.doesNotMatch(markdown, /2026-09-22/);

    // A bare date is shown as written.
    const bare = selectPatientListRows(
      { patients: [patient], episodes: [{ ...episode, opened_at: "2026-09-20" }], tasks: [], procedures: [] },
      DEFAULT_PATIENT_LIST_FILTER,
      "2026-09-23"
    );
    assert.match(buildPatientListCsv(bare), /"2026-09-20"/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

// --- tooling-tests F2 and F3: the CI text gates -------------------------------

interface WorkflowStep {
  name?: string;
  run?: string;
}

async function ciGates(): Promise<{ paths: string[]; nul: string; identifiers: string }> {
  const workflow = parse(await readFile(path.resolve(".github/workflows/ci.yml"), "utf8")) as {
    jobs: { check: { env?: Record<string, string>; steps: WorkflowStep[] } };
  };
  const job = workflow.jobs.check;
  const script = (name: string): string => {
    const found = job.steps.find((step) => step.name === name)?.run;
    assert.ok(found, `CI step "${name}"`);
    return found;
  };
  return {
    paths: String(job.env?.PUBLIC_TEXT_PATHS ?? "").split(/\s+/).filter(Boolean),
    nul: script("Assert no NUL bytes in tracked text"),
    identifiers: script("Assert no unapproved identifier-shaped literals in public text")
  };
}

/** Runs one CI step in a scratch repository whose tracked files are `files`. */
async function runGate(
  script: string,
  paths: string[],
  files: Record<string, string>
): Promise<{ ok: boolean; output: string }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "clinical-ci-gate-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PUBLIC_TEXT_PATHS: paths.join(" ") };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  try {
    await run("git", ["init", "-q"], { cwd: repo, env });
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
      await writeFile(path.join(repo, name), content, "utf8");
    }
    await run("git", ["add", "-A"], { cwd: repo, env });
    try {
      const result = await run("bash", ["-c", script], { cwd: repo, env });
      return { ok: true, output: `${result.stdout}${result.stderr}` };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

/** Why the CI gates cannot run here (they need bash, perl and git with PCRE), or null. */
async function gateToolsMissing(): Promise<string | null> {
  if (process.platform === "win32") return "the CI gates run under bash";
  try {
    const probe = await runGate("command -v perl >/dev/null && git grep -qP -e 'x'", [], { "probe.md": "text\n" });
    return probe.ok ? null : `perl or git with PCRE is unavailable: ${probe.output}`;
  } catch (error) {
    return `bash or git is unavailable: ${String(error)}`;
  }
}

/** Arabic-Indic (U+0660-0669) or Persian (U+06F0-06F9) spelling of ASCII digits. */
const arabicIndic = (digits: string): string =>
  digits.replace(/[0-9]/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));
const persian = (digits: string): string =>
  digits.replace(/[0-9]/g, (digit) => String.fromCharCode(0x06f0 + Number(digit)));

test("the NUL-byte gate scans exactly the paths the identifier gate scans", async (context) => {
  const gates = await ciGates();
  for (const entry of ["src", "tests", "scripts", "docs", "README.md", "CHANGELOG.md", "SECURITY.md", "manifest.json"]) {
    assert.ok(gates.paths.includes(entry), `${entry} is in the shared list`);
  }
  assert.match(gates.nul, /git grep -lP '\\x00' -- \$PUBLIC_TEXT_PATHS /);
  assert.match(gates.identifiers, /git grep -hI '' -- \$PUBLIC_TEXT_PATHS /);
  for (const script of [gates.nul, gates.identifiers]) {
    assert.doesNotMatch(script, /README\.md|CHANGELOG\.md|manifest\.json/, "no step keeps a list of its own");
  }

  const missing = await gateToolsMissing();
  if (missing) {
    context.skip(missing);
    return;
  }
  // A NUL in any listed path, file or folder, fails the gate and is named.
  const files: Record<string, string> = {};
  for (const entry of gates.paths) {
    const probe = /\.[a-z]+$/.test(entry) ? entry : `${entry}/probe.md`;
    files[probe] = "Pasted debugging output\u0000 with a stray NUL.\n";
  }
  const result = await runGate(gates.nul, gates.paths, files);
  assert.equal(result.ok, false, result.output);
  for (const probe of Object.keys(files)) assert.ok(result.output.includes(probe), `${probe} is reported`);

  const clean = await runGate(gates.nul, gates.paths, { "README.md": "Plain text.\n" });
  assert.equal(clean.ok, true, clean.output);
});

test("the identifier gate reads Arabic-Indic and Persian digits as MRN digits", async (context) => {
  const gates = await ciGates();
  const missing = await gateToolsMissing();
  if (missing) {
    context.skip(missing);
    return;
  }
  // The approved synthetic fixtures still pass in either script.
  const fixtures = {
    "tests/arabic.test.ts": `const mrn = "${arabicIndic("9000000103")}";\nconst padded = "${persian("0090000077")}";\n`
  };
  const approved = await runGate(gates.identifiers, gates.paths, fixtures);
  assert.equal(approved.ok, true, approved.output);

  // Anything else is refused, and named in ASCII.
  const unapproved = "5".repeat(8);
  for (const spell of [arabicIndic, persian]) {
    const leaked = await runGate(gates.identifiers, gates.paths, {
      ...fixtures,
      "docs/notes.md": `MRN ${spell(unapproved)} was pasted here.\n`
    });
    assert.equal(leaked.ok, false, leaked.output);
    assert.ok(leaked.output.includes(unapproved), leaked.output);
  }
});
