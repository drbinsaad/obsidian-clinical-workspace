import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RULES, mergeRules } from "../tools/noteplan-rules";
import { isExcluded, parseNote } from "../tools/noteplan-parse";
import { harness } from "./support/harness";
import type { EpisodeRecord, PatientRecord, TaskRecord } from "../src/domain/types";

const R = DEFAULT_RULES;
const parse = (name: string, body: string) => parseNote(`/staging/Notes/${name}`, body, R);

// --- Refusing to invent patients ---------------------------------------------

test("a note with neither MRN nor name is not a patient", () => {
  assert.equal(parse("scratch.md", "# Notes to self\n* [ ] buy milk"), null);
});

test("templates and other non-clinical notes are skipped", () => {
  assert.equal(parse("t.md", "# {{title}}\n#template\nMRN:"), null);
  assert.equal(parse("m.md", "# Dept meeting\n#meeting\nMRN: 9000001\n"), null);
  assert.equal(parse("x.md", "# ENT teaching\n#teaching\n* [ ] slides"), null);
});

test("calendar and archive notes are excluded before parsing", () => {
  assert.equal(isExcluded("/staging/Calendar/20260805.md", R), true);
  assert.equal(isExcluded("/staging/Calendar/20260805.txt", R), true);
  assert.equal(isExcluded("/staging/Calendar/2026-W32.md", R), true);
  assert.equal(isExcluded("/staging/@Templates/patient.md", R), true);
  assert.equal(isExcluded("/staging/@Archive/old.md", R), true);
  assert.equal(isExcluded("/staging/Notes/9000001 - Someone.md", R), false);
});

// --- Reading a patient --------------------------------------------------------

test("MRN, name, phone and case are read from a typical note", () => {
  const note = parse(
    "9000002001 - Omar Testpatient.md",
    [
      "# 9000002001 - Omar Testpatient",
      "Phone: 0500000201",
      "Diagnosis: Chronic otitis media, left",
      "",
      "## Plan",
      "* [ ] Book audiogram >2026-08-12"
    ].join("\n")
  )!;
  assert.equal(note.mrn, "9000002001");
  assert.equal(note.patientName, "Omar Testpatient");
  assert.equal(note.phone, "0500000201");
  assert.equal(note.caseName, "Chronic otitis media, left");
  assert.deepEqual(note.problems, []);
});

test("an MRN written as a labelled field is found too", () => {
  const note = parse("layla.md", "# Layla Testpatient\nMRN: 9000002002\nReason: Post-tonsillectomy bleed\n")!;
  assert.equal(note.mrn, "9000002002");
  assert.equal(note.patientName, "Layla Testpatient");
  assert.equal(note.caseName, "Post-tonsillectomy bleed");
});

test("a hyphenated or spaced MRN is normalised", () => {
  assert.equal(parse("a.md", "# Test Name\nMRN: 9000-0020 03\n")!.mrn, "9000002003");
});

test("a missing MRN is reported, not invented", () => {
  const note = parse("c.md", "# Yousef Testpatient\nComplaint: Hoarseness\n* [ ] Arrange laryngoscopy")!;
  assert.equal(note.mrn, "");
  assert.ok(note.problems.includes("no MRN found"));
});

test("a missing case uses an explicit review placeholder, not the patient title", () => {
  const note = parse("d.md", "# 9000002004 - Sara Testpatient\n* [ ] Chase result")!;
  assert.equal(note.caseName, "Imported patient follow-up");
  assert.ok(note.problems.some((p) => p.includes("review placeholder")));
});

// --- To-dos -------------------------------------------------------------------

test("open, done and cancelled to-dos are told apart", () => {
  const note = parse(
    "e.md",
    [
      "# 9000002005 - Test Name",
      "* [ ] Check Hb this evening >2026-08-05",
      "* [x] Consented for surgery",
      "* [-] Repeat FBC",
      "- [ ] Chase swab"
    ].join("\n")
  )!;
  assert.equal(note.openTasks.length, 2, "only open to-dos become tasks");
  assert.equal(note.doneTasks, 1);
  assert.equal(note.cancelledTasks, 1);
  assert.deepEqual(
    note.openTasks.map((t) => t.text),
    ["Check Hb this evening", "Chase swab"]
  );
});

test("a scheduled date is lifted off the task text", () => {
  const note = parse("f.md", "# 9000002006 - Test Name\n* [ ] Book audiogram >2026-08-12")!;
  assert.equal(note.openTasks[0]!.due, "2026-08-12");
  assert.equal(note.openTasks[0]!.text, "Book audiogram", "the date must not stay in the task text");
});

test("a task with no date imports with no date rather than today", () => {
  const note = parse("g.md", "# 9000002007 - Test Name\n* [ ] Chase histopathology")!;
  assert.equal(note.openTasks[0]!.due, "");
});

test("the same line is not counted twice when two patterns match it", () => {
  const note = parse("h.md", "# 9000002008 - Test Name\n* [ ] Only one task")!;
  assert.equal(note.openTasks.length, 1);
});

test("the same task text on two dates remains two distinct tasks", () => {
  const note = parse(
    "h2.txt",
    "# 9000002013 - Test Name\n* [ ] Review result >2026-08-12\n* [ ] Review result >2026-08-19"
  )!;
  assert.deepEqual(note.openTasks, [
    { text: "Review result", due: "2026-08-12" },
    { text: "Review result", due: "2026-08-19" }
  ]);
});

// --- Classification -----------------------------------------------------------

test("care setting and priority come from tags, defaulting to the safe side", () => {
  const plain = parse("i.md", "# 9000002009 - Test Name\n")!;
  assert.equal(plain.careSetting, "outpatient");
  assert.equal(plain.priority, "routine");

  const ward = parse("j.md", "# 9000002010 - Test Name\n#inpatient #urgent\n")!;
  assert.equal(ward.careSetting, "inpatient");
  assert.equal(ward.priority, "urgent");

  const stat = parse("k.md", "# 9000002011 - Test Name\n#emergency\n")!;
  assert.equal(stat.priority, "emergency");
});

// --- Rules are overridable ----------------------------------------------------

test("a different house style can be described without touching code", () => {
  const rules = mergeRules({
    mrnPatterns: ["File No\\.\\s*([0-9]+)"],
    openTaskPatterns: ["^TODO:\\s*(.+)$"]
  });
  const note = parseNote(
    "/staging/x.md",
    "# Test Name\nFile No. 9000002012\nTODO: Ring the family\n",
    rules
  )!;
  assert.equal(note.mrn, "9000002012");
  assert.equal(note.openTasks[0]!.text, "Ring the family");
});

// --- What the import produces -------------------------------------------------

test("imported notes become records the plugin itself accepts", async () => {
  const { service, repository, integrity } = await harness();
  const notes = [
    parse("a.md", "# 9000002020 - Omar Testpatient\nPhone: 0500000220\nDiagnosis: Otitis media\n* [ ] Book audiogram >2026-08-12\n* [ ] Review after audiogram")!,
    parse("b.md", "# Layla Testpatient\nMRN: 9000002021\nReason: Post-tonsillectomy bleed\n#inpatient #urgent\n* [ ] Check Hb >2026-08-05")!
  ];

  for (const note of notes) {
    const first = note.openTasks[0];
    const result = await service.createEpisode({
      mrn: note.mrn,
      patientName: note.patientName,
      phone: note.phone,
      caseName: note.caseName,
      careSetting: note.careSetting,
      pathway: "assessment",
      priority: note.priority,
      nextAction: first?.text ?? "",
      dueDate: first?.due ?? "",
      forceNewPatient: !note.mrn
    });
    for (const task of note.openTasks.slice(1)) {
      await service.createTask({
        patientId: result.patient.record.id,
        episodeId: result.episode.record.id,
        task: task.text,
        taskType: "other",
        priority: note.priority,
        dueDate: task.due,
        owner: ""
      });
    }
  }

  const patients = await repository.list<PatientRecord>("patient");
  const episodes = await repository.list<EpisodeRecord>("episode");
  const tasks = await repository.list<TaskRecord>("task");
  assert.equal(patients.length, 2);
  assert.equal(episodes.length, 2);
  assert.equal(tasks.length, 3);

  const ward = episodes.find((e) => e.record.care_setting === "inpatient")!;
  assert.equal(ward.record.priority, "urgent");

  // The whole point: an import must not leave the vault in a state the
  // integrity check complains about.
  assert.deepEqual(await integrity.scan(), []);
});

test("two notes sharing an MRN become one patient, not two", async () => {
  const { service, repository } = await harness();
  for (const body of [
    "# 9000002030 - Omar Testpatient\nDiagnosis: Ear discharge\n",
    "# 9000002030 - Omar Testpatient\nCase: Follow-up ear discharge\n"
  ]) {
    const note = parse("x.md", body)!;
    await service.createEpisode({
      mrn: note.mrn,
      patientName: note.patientName,
      phone: note.phone,
      caseName: note.caseName,
      careSetting: note.careSetting,
      pathway: "assessment",
      priority: note.priority,
      nextAction: "",
      dueDate: ""
    });
  }
  assert.equal((await repository.list<PatientRecord>("patient")).length, 1, "one human, one chart");
  assert.equal((await repository.list<EpisodeRecord>("episode")).length, 2, "but both episodes kept");
});
