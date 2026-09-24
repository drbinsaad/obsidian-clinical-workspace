import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeMrn } from "../src/domain/schema";
import { CARE_SETTINGS, EPISODE_STATUSES, PATHWAYS, PRIORITIES } from "../src/domain/types";
import { PROCEDURE_STATUSES, validateRecord } from "../src/domain/validate";
import { episodeInput, harness } from "./support/harness";

const run = promisify(execFile);
const script = path.resolve("scripts/export-logbook.mjs");

async function writeRecord(vault: string, folder: string, name: string, frontmatter: string): Promise<void> {
  const target = path.join(vault, "Clinical Workspace", folder);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, name), `---\n${frontmatter.trim()}\n---\n`, "utf8");
}

interface Fixture {
  home: string;
  vault: string;
  output: string;
}

async function syntheticVault(): Promise<Fixture> {
  const home = await mkdtemp(path.join(os.tmpdir(), "clinical-logbook-test-"));
  const vault = path.join(home, "vault");
  const output = path.join(home, "logbook.csv");
  await mkdir(vault);
  await writeRecord(vault, "Patients", "PAT-test.md", `
entity: patient
id: PAT-test
mrn: "9000000001"
patient_name: Synthetic Patient
`);
  await writeRecord(vault, "Episodes", "EPI-test.md", `
entity: episode
id: EPI-test
patient_id: PAT-test
care_setting: inpatient
pathway: or-booking
priority: urgent
case: Synthetic indication
status: active
`);
  await writeRecord(vault, "Procedures", "PRC-test.md", `
entity: procedure
id: PRC-test
episode_id: EPI-test
patient_id: PAT-test
procedure_date: 2026-08-08
procedure: '=HYPERLINK("https://invalid.example","Synthetic")'
role: primary-surgeon
outcome: Completed
follow_up_required: false
follow_up_date: ""
created_at: 2026-08-08T08:00:00Z
status: completed
`);
  await writeRecord(vault, "Procedures", "PRC-planned.md", `
entity: procedure
id: PRC-planned
episode_id: EPI-test
patient_id: PAT-test
procedure_date: 2026-08-09
procedure: Planned procedure
role: observer
status: cancelled
`);
  return { home, vault, output };
}

async function expectFailure(args: string[], pattern: RegExp): Promise<string> {
  let output = "";
  await assert.rejects(
    run(process.execPath, [script, ...args]),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      assert.match(stderr, pattern);
      output = stderr;
      return true;
    }
  );
  return output;
}

test("default export is explicitly pseudonymized/confidential and never reads Patients", async () => {
  const fixture = await syntheticVault();
  try {
    await writeFile(path.join(fixture.vault, "Clinical Workspace", "Patients", "invalid.md"), "not frontmatter", "utf8");
    const result = await run(process.execPath, [script, fixture.vault, "--out", fixture.output]);
    const csv = await readFile(fixture.output, "utf8");

    assert.match(result.stdout, /Exported 1 completed procedure record/);
    assert.match(result.stdout, /Pseudonymized confidential CSV created/);
    assert.match(result.stdout, /not anonymous and may be re-identifiable/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /[Dd]e-identified/);
    assert.match(csv, /^﻿case_ref,date,procedure,role,/);
    assert.match(csv, /"PRC-test"/);
    assert.doesNotMatch(csv, /9000000001|Synthetic Patient|patient_name|mrn/);
    assert.doesNotMatch(csv, /PRC-planned/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("identified export is opt-in, warns before export, validates Patients, and includes identifiers", async () => {
  const fixture = await syntheticVault();
  try {
    const result = await run(process.execPath, [
      script,
      fixture.vault,
      "--out",
      fixture.output,
      "--identifiers"
    ]);
    const csv = await readFile(fixture.output, "utf8");

    assert.match(result.stderr, /WARNING: identified export requested/);
    assert.match(result.stderr, /MRNs and patient names/);
    assert.match(csv, /,mrn,patient_name\n/);
    assert.match(csv, /"9000000001","Synthetic Patient"/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("CLI rejects missing output values, unknown flags, duplicate flags, and extra positional paths", async () => {
  const fixture = await syntheticVault();
  try {
    await expectFailure([fixture.vault], /Option --out is required/);
    await expectFailure([fixture.vault, "--out"], /Option --out requires a value/);
    await expectFailure([fixture.vault, "--out", fixture.output, "--mystery"], /Unknown command-line option/);
    await expectFailure(
      [fixture.vault, "--out", fixture.output, "--force", "--force"],
      /Flag --force may be supplied only once/
    );
    await expectFailure([fixture.vault, fixture.home, "--out", fixture.output], /Supply exactly one vault path/);
    const direct = path.join(fixture.home, "direct.csv");
    await run(process.execPath, [script, "--", fixture.vault, "--out", direct]);
    assert.match(await readFile(direct, "utf8"), /^﻿case_ref,date,/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("CLI requires a CSV extension and an existing output parent", async () => {
  const fixture = await syntheticVault();
  try {
    await expectFailure([fixture.vault, "--out", path.join(fixture.home, "logbook.txt")], /must use the \.csv extension/);
    await expectFailure(
      [fixture.vault, "--out", path.join(fixture.home, "missing", "logbook.csv")],
      /output parent directory does not exist/
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("root traversal and roots resolving through symlinks outside the vault are rejected", async (context) => {
  const fixture = await syntheticVault();
  const outside = path.join(fixture.home, "outside");
  await mkdir(outside);
  try {
    await expectFailure(
      [fixture.vault, "--out", fixture.output, "--root", "../outside"],
      /may not contain traversal segments/
    );

    const link = path.join(fixture.vault, "Linked Clinical Workspace");
    try {
      await symlink(outside, link, "dir");
    } catch (error) {
      context.skip(`Symbolic links unavailable: ${String(error)}`);
      return;
    }
    await expectFailure(
      [fixture.vault, "--out", fixture.output, "--root", "Linked Clinical Workspace"],
      /must remain inside the supplied vault/
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("a symbolic link inside a record folder is rejected rather than followed", async (context) => {
  const fixture = await syntheticVault();
  try {
    const external = path.join(fixture.home, "external.md");
    await writeFile(external, "---\nentity: procedure\nid: external\n---\n", "utf8");
    try {
      await symlink(external, path.join(fixture.vault, "Clinical Workspace", "Procedures", "linked.md"));
    } catch (error) {
      context.skip(`Symbolic links unavailable: ${String(error)}`);
      return;
    }
    await expectFailure([fixture.vault, "--out", fixture.output], /Procedures folder contains a symbolic link/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("output inside the supplied vault is rejected even with --force and through a symlinked parent", async (context) => {
  const fixture = await syntheticVault();
  try {
    const inside = path.join(fixture.vault, "logbook.csv");
    await writeFile(inside, "preserve", "utf8");
    await expectFailure([fixture.vault, "--out", inside, "--force"], /must be outside the supplied vault/);
    assert.equal(await readFile(inside, "utf8"), "preserve");

    const linkedParent = path.join(fixture.home, "linked-parent");
    try {
      await symlink(fixture.vault, linkedParent, "dir");
    } catch (error) {
      context.skip(`Symbolic links unavailable: ${String(error)}`);
      return;
    }
    await expectFailure(
      [fixture.vault, "--out", path.join(linkedParent, "another.csv"), "--force"],
      /must be outside the supplied vault/
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("relative and custom-named output inside the source checkout is rejected", async () => {
  const fixture = await syntheticVault();
  const outputs = ["private-cases.csv", path.join("scripts", "custom-clinical-export.csv")];
  try {
    for (const output of outputs) {
      await expectFailure(
        [fixture.vault, "--out", output],
        /output CSV must be outside this source checkout/
      );
      await assert.rejects(lstat(path.resolve(output)), { code: "ENOENT" });
    }
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("a symlinked parent cannot make the source checkout look like an external output", async (context) => {
  const fixture = await syntheticVault();
  const linkedCheckout = path.join(fixture.home, "approved-output");
  try {
    try {
      await symlink(path.resolve("."), linkedCheckout, "dir");
    } catch (error) {
      context.skip(`Symbolic links unavailable: ${String(error)}`);
      return;
    }

    const disguised = path.join(linkedCheckout, "custom-clinical-export.csv");
    const errorOutput = await expectFailure(
      [fixture.vault, "--out", disguised],
      /output CSV must be outside this source checkout/
    );
    await assert.rejects(lstat(path.resolve("custom-clinical-export.csv")), { code: "ENOENT" });
    assert.doesNotMatch(errorOutput, /approved-output|custom-clinical-export|clinical-logbook-test/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("existing output is preserved unless --force is explicit", async () => {
  const fixture = await syntheticVault();
  try {
    await writeFile(fixture.output, "existing confidential export", "utf8");
    await expectFailure([fixture.vault, "--out", fixture.output], /already exists/);
    assert.equal(await readFile(fixture.output, "utf8"), "existing confidential export");

    await run(process.execPath, [script, fixture.vault, "--out", fixture.output, "--force"]);
    assert.match(await readFile(fixture.output, "utf8"), /^﻿case_ref,date,/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("concurrent exports without --force publish exactly one complete CSV", async () => {
  const fixture = await syntheticVault();
  try {
    const attempts = await Promise.allSettled([
      run(process.execPath, [script, fixture.vault, "--out", fixture.output]),
      run(process.execPath, [script, fixture.vault, "--out", fixture.output])
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    assert.match(await readFile(fixture.output, "utf8"), /^﻿case_ref,date,/);
    assert.equal((await readdir(fixture.home)).some((entry) => entry.endsWith(".tmp")), false);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("output symlinks are never replaced", async (context) => {
  const fixture = await syntheticVault();
  const original = path.join(fixture.home, "original.csv");
  await writeFile(original, "preserve", "utf8");
  try {
    try {
      await symlink(original, fixture.output);
    } catch (error) {
      context.skip(`Symbolic links unavailable: ${String(error)}`);
      return;
    }
    await expectFailure([fixture.vault, "--out", fixture.output, "--force"], /may not be a symbolic link/);
    assert.equal(await readFile(original, "utf8"), "preserve");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("duplicate IDs fail closed without writing a CSV", async () => {
  const fixture = await syntheticVault();
  try {
    await writeRecord(fixture.vault, "Episodes", "duplicate.md", `
entity: episode
id: EPI-test
patient_id: PAT-test
`);
    await expectFailure([fixture.vault, "--out", fixture.output], /Episodes contains duplicate record IDs/);
    await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("orphaned episode relationships fail closed", async () => {
  const fixture = await syntheticVault();
  try {
    const record = path.join(fixture.vault, "Clinical Workspace", "Procedures", "PRC-test.md");
    const content = await readFile(record, "utf8");
    await writeFile(record, content.replace("episode_id: EPI-test", "episode_id: EPI-missing"), "utf8");
    await expectFailure([fixture.vault, "--out", fixture.output], /integrity validation found 1 invalid/);
    await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("procedure-to-episode patient mismatches fail closed", async () => {
  const fixture = await syntheticVault();
  try {
    const record = path.join(fixture.vault, "Clinical Workspace", "Procedures", "PRC-test.md");
    const content = await readFile(record, "utf8");
    await writeFile(record, content.replace("patient_id: PAT-test", "patient_id: PAT-other"), "utf8");
    await expectFailure([fixture.vault, "--out", fixture.output], /integrity validation found 1 invalid/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("identified export fails when an episode references a missing patient", async () => {
  const fixture = await syntheticVault();
  try {
    const patient = path.join(fixture.vault, "Clinical Workspace", "Patients", "PAT-test.md");
    await rm(patient);
    await expectFailure(
      [fixture.vault, "--out", fixture.output, "--identifiers"],
      /integrity validation found [1-9]\d* invalid/
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("missing required folders and invalid Markdown records fail closed", async () => {
  const fixture = await syntheticVault();
  try {
    await rm(path.join(fixture.vault, "Clinical Workspace", "Episodes"), { recursive: true });
    await expectFailure([fixture.vault, "--out", fixture.output], /required Episodes folder does not exist/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }

  const invalidFixture = await syntheticVault();
  try {
    await writeFile(
      path.join(invalidFixture.vault, "Clinical Workspace", "Procedures", "invalid.md"),
      "---\nentity: [unterminated\n---\n",
      "utf8"
    );
    await expectFailure(
      [invalidFixture.vault, "--out", invalidFixture.output],
      /1 Markdown record in Procedures had invalid or unreadable frontmatter/
    );
  } finally {
    await rm(invalidFixture.home, { recursive: true, force: true });
  }
});

test("completed procedure fields reject malformed types without leaking record details", async () => {
  const fixture = await syntheticVault();
  try {
    const record = path.join(fixture.vault, "Clinical Workspace", "Procedures", "PRC-test.md");
    const content = await readFile(record, "utf8");
    await writeFile(record, content
      .replace(/^procedure:.*$/m, "procedure: [unsafe]")
      .replace("role: primary-surgeon", "role: { unsafe: private-role }")
      .replace("follow_up_required: false", "follow_up_required: [false]"), "utf8");

    const errorOutput = await expectFailure(
      [fixture.vault, "--out", fixture.output],
      /Export schema validation rejected .*completed-procedure field values/
    );
    await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
    assert.doesNotMatch(errorOutput, /PRC-test|private-role|Procedures\/PRC-test/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("completed procedures fail closed when required CSV source fields are missing", async () => {
  const fixture = await syntheticVault();
  try {
    const record = path.join(fixture.vault, "Clinical Workspace", "Procedures", "PRC-test.md");
    const content = await readFile(record, "utf8");
    await writeFile(
      record,
      content
        .replace(/^procedure_date:.*\n/m, "")
        .replace(/^role:.*\n/m, "")
        .replace(/^outcome:.*\n/m, "")
        .replace(/^created_at:.*\n/m, ""),
      "utf8"
    );
    await expectFailure(
      [fixture.vault, "--out", fixture.output],
      /Export schema validation rejected 4 completed-procedure field values/
    );
    await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("completed procedures reject impossible or non-UTC timestamps", async () => {
  for (const timestamp of ["2026-02-30T00:00:00Z", "2026-08-08T08:00:00"]) {
    const fixture = await syntheticVault();
    try {
      const record = path.join(fixture.vault, "Clinical Workspace", "Procedures", "PRC-test.md");
      const content = await readFile(record, "utf8");
      await writeFile(
        record,
        content.replace("created_at: 2026-08-08T08:00:00Z", `created_at: ${timestamp}`),
        "utf8"
      );
      await expectFailure(
        [fixture.vault, "--out", fixture.output],
        /Export schema validation rejected 1 completed-procedure field value/
      );
      await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  }
});

test("joined episode fields require schema-valid strings and enum values", async () => {
  const fixture = await syntheticVault();
  try {
    const record = path.join(fixture.vault, "Clinical Workspace", "Episodes", "EPI-test.md");
    const content = await readFile(record, "utf8");
    await writeFile(
      record,
      content
        .replace("care_setting: inpatient", "care_setting: [inpatient]")
        .replace("pathway: or-booking", "pathway: unknown-pathway")
        .replace(/^priority:.*\n/m, "")
        .replace("case: Synthetic indication", "case: { private: text }"),
      "utf8"
    );
    await expectFailure(
      [fixture.vault, "--out", fixture.output],
      /Export schema validation rejected 4 joined-episode field values/
    );
    await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("identified export requires typed identifiers and at least MRN or patient name", async () => {
  const fixture = await syntheticVault();
  try {
    const record = path.join(fixture.vault, "Clinical Workspace", "Patients", "PAT-test.md");
    const content = await readFile(record, "utf8");
    await writeFile(
      record,
      content.replace('mrn: "9000000001"', "mrn: [9000000001]").replace("patient_name: Synthetic Patient", 'patient_name: ""'),
      "utf8"
    );
    await expectFailure(
      [fixture.vault, "--out", fixture.output, "--identifiers"],
      /Export schema validation rejected 2 joined-patient identifier field values/
    );
    await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("identified export accepts an explicitly empty string MRN", async () => {
  const fixture = await syntheticVault();
  try {
    const record = path.join(fixture.vault, "Clinical Workspace", "Patients", "PAT-test.md");
    const content = await readFile(record, "utf8");
    await writeFile(record, content.replace('mrn: "9000000001"', 'mrn: ""'), "utf8");
    await run(process.execPath, [script, fixture.vault, "--out", fixture.output, "--identifiers"]);
    const csv = await readFile(fixture.output, "utf8");
    assert.match(csv, /"","Synthetic Patient"/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("identified export accepts an MRN-only patient identity", async () => {
  const fixture = await syntheticVault();
  try {
    const record = path.join(fixture.vault, "Clinical Workspace", "Patients", "PAT-test.md");
    const content = await readFile(record, "utf8");
    await writeFile(record, content.replace("patient_name: Synthetic Patient", 'patient_name: ""'), "utf8");
    await run(process.execPath, [script, fixture.vault, "--out", fixture.output, "--identifiers"]);
    const csv = await readFile(fixture.output, "utf8");
    assert.match(csv, /"9000000001",""/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("CSV cells neutralize formula prefixes, control whitespace, and quotes", async () => {
  const fixture = await syntheticVault();
  const procedureFolder = path.join(fixture.vault, "Clinical Workspace", "Procedures");
  try {
    await rm(procedureFolder, { recursive: true });
    const values = [
      ["equals", "  =2+2"],
      ["plus", "+SUM(1,2)"],
      ["minus", "-10"],
      ["at", "@cmd"],
      ["quote", 'Safe "quoted" value'],
      ["mark", "Arabic\u061Cletter mark"]
    ];
    for (const [id, value] of values) {
      await writeRecord(fixture.vault, "Procedures", `${id}.md`, `
entity: procedure
id: PRC-${id}
episode_id: EPI-test
patient_id: PAT-test
procedure_date: 2026-08-08
procedure: ${JSON.stringify(value)}
role: primary-surgeon
outcome: ""
follow_up_required: false
follow_up_date: ""
created_at: 2026-08-08T08:00:00Z
status: completed
`);
    }

    await run(process.execPath, [script, fixture.vault, "--out", fixture.output]);
    const csv = await readFile(fixture.output, "utf8");
    assert.match(csv, /"'=2\+2"/);
    assert.match(csv, /"'\+SUM\(1,2\)"/);
    assert.match(csv, /"'-10"/);
    assert.match(csv, /"'@cmd"/);
    assert.match(csv, /"Safe ""quoted"" value"/);
    assert.match(csv, /"Arabicletter mark"/, "the Arabic Letter Mark is a bidi control and is stripped");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("atomic output has owner-only permissions, leaves no temporary residue, and console omits paths/free text", async () => {
  const fixture = await syntheticVault();
  try {
    const result = await run(process.execPath, [script, fixture.vault, "--out", fixture.output]);
    const mode = (await stat(fixture.output)).mode & 0o777;
    if (process.platform !== "win32") assert.equal(mode, 0o600);

    const entries = await readdir(fixture.home);
    assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Synthetic indication|HYPERLINK|PRC-test|clinical-logbook-test/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("schema failures are broken down per property and point to the in-app integrity check", async () => {
  const fixture = await syntheticVault();
  try {
    const record = path.join(fixture.vault, "Clinical Workspace", "Procedures", "PRC-test.md");
    const content = await readFile(record, "utf8");
    await writeFile(
      record,
      content.replace(/^role:.*\n/m, "").replace("outcome: Completed", "outcome:").replace(/^created_at:.*\n/m, ""),
      "utf8"
    );
    const errorOutput = await expectFailure(
      [fixture.vault, "--out", fixture.output],
      /rejected 3 completed-procedure field values \(role: 1, outcome: 1, created_at: 1\)\. No CSV was written\./
    );
    assert.match(errorOutput, /Run "Clinical Workspace: Run clinical data integrity check" in Obsidian/);
    assert.doesNotMatch(errorOutput, /PRC-test|Synthetic/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("the exporter's enum lists match the plugin's domain types", async () => {
  const enums = (await import(pathToFileURL(path.resolve("scripts/export-logbook-enums.mjs")).href)) as Record<
    string,
    Set<string>
  >;
  const sorted = (values: Iterable<string>): string[] => [...values].sort();
  assert.deepEqual(sorted(enums.CARE_SETTINGS!), sorted(CARE_SETTINGS));
  assert.deepEqual(sorted(enums.PATHWAYS!), sorted(PATHWAYS));
  assert.deepEqual(sorted(enums.PRIORITIES!), sorted(PRIORITIES));
  assert.deepEqual(sorted(enums.EPISODE_STATUSES!), sorted(EPISODE_STATUSES));
  assert.deepEqual(sorted(enums.PROCEDURE_STATUSES!), sorted(PROCEDURE_STATUSES));
});

/** Writes every note the in-memory plugin vault holds to a real temporary vault. */
async function pluginWrittenVault(): Promise<Fixture> {
  const { app, service } = await harness();
  const logged = [
    {
      mrn: "9000000601",
      name: "Synthetic Roundtrip One",
      procedure: "Synthetic appendicectomy",
      date: "2026-08-08",
      role: "Primary surgeon"
    },
    {
      mrn: "9000000602",
      name: "Synthetic Roundtrip Two",
      procedure: "Synthetic hernia repair",
      date: "2026-07-01",
      role: "Assistant"
    }
  ];
  for (const entry of logged) {
    const created = await service.createEpisode(
      episodeInput({
        mrn: entry.mrn,
        patientName: entry.name,
        caseName: `Indication for ${entry.procedure}`,
        careSetting: "inpatient",
        pathway: "or-booking"
      })
    );
    await service.completeProcedure({
      patientId: created.patient.record.id,
      episodeId: created.episode.record.id,
      procedure: entry.procedure,
      procedureDate: entry.date,
      role: entry.role,
      outcome: "Uneventful",
      followUpRequired: true,
      followUpDate: "2026-09-20",
      followUpPlan: "Clinic review"
    });
  }
  const home = await mkdtemp(path.join(os.tmpdir(), "clinical-logbook-roundtrip-"));
  const vault = path.join(home, "vault");
  for (const [file, content] of app.vault.files) {
    await mkdir(path.join(vault, path.dirname(file)), { recursive: true });
    await writeFile(path.join(vault, file), content, "utf8");
  }
  return { home, vault, output: path.join(home, "logbook.csv") };
}

function csvRows(csv: string): string[] {
  return csv.replace(/^﻿/, "").trim().split("\n").slice(1);
}

test("notes written by the plugin export correctly, with and without identifiers", async () => {
  const fixture = await pluginWrittenVault();
  try {
    await run(process.execPath, [script, fixture.vault, "--out", fixture.output]);
    const rows = csvRows(await readFile(fixture.output, "utf8"));
    assert.equal(rows.length, 2);
    assert.match(
      rows[0]!,
      /^"PRC-[0-9a-f]+","2026-08-08","Synthetic appendicectomy","Primary surgeon","inpatient","[a-z-]+","routine","Indication for Synthetic appendicectomy","Uneventful","yes","2026-09-20",/
    );
    assert.match(rows[1]!, /"2026-07-01","Synthetic hernia repair","Assistant"/);
    assert.doesNotMatch(rows.join("\n"), /9000000601|Synthetic Roundtrip/);

    const identified = path.join(fixture.home, "identified.csv");
    await run(process.execPath, [script, fixture.vault, "--out", identified, "--identifiers"]);
    const identifiedRows = csvRows(await readFile(identified, "utf8"));
    assert.match(identifiedRows[0]!, /,"9000000601","Synthetic Roundtrip One"$/);
    assert.match(identifiedRows[1]!, /,"9000000602","Synthetic Roundtrip Two"$/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("date and role filters narrow the CSV after full validation and report counts only", async () => {
  const fixture = await pluginWrittenVault();
  try {
    const period = await run(process.execPath, [
      script,
      fixture.vault,
      "--out",
      fixture.output,
      "--from",
      "2026-08-01",
      "--to",
      "2026-08-31"
    ]);
    assert.deepEqual(
      csvRows(await readFile(fixture.output, "utf8")).map((row) => row.split(",")[1]),
      ['"2026-08-08"']
    );
    assert.match(period.stdout, /Exported 1 completed procedure record\./);
    assert.match(period.stdout, /Excluded 1 completed procedure record outside the requested dates or role\./);
    assert.doesNotMatch(period.stdout, /2026-08|Primary surgeon|appendicectomy/);

    const byRole = path.join(fixture.home, "role.csv");
    await run(process.execPath, [script, fixture.vault, "--out", byRole, "--role", "  primary SURGEON "]);
    const roleRows = csvRows(await readFile(byRole, "utf8"));
    assert.equal(roleRows.length, 1);
    assert.match(roleRows[0]!, /"Primary surgeon"/);

    // A damaged record outside the requested period still blocks the export.
    const procedures = path.join(fixture.vault, "Clinical Workspace", "Procedures");
    for (const name of await readdir(procedures)) {
      const file = path.join(procedures, name);
      const content = await readFile(file, "utf8");
      if (content.includes("2026-07-01")) {
        await writeFile(file, content.replace(/^role: .*$/m, 'role: ""'), "utf8");
      }
    }
    await expectFailure(
      [fixture.vault, "--out", path.join(fixture.home, "filtered.csv"), "--from", "2026-08-01"],
      /rejected 1 completed-procedure field value \(role: 1\)/
    );

    await expectFailure(
      [fixture.vault, "--out", fixture.output, "--from", "2026-02-30"],
      /--from must be a real calendar date/
    );
    await expectFailure([fixture.vault, "--out", fixture.output, "--to", "08/31/2026"], /--to must be a real calendar date/);
    await expectFailure(
      [fixture.vault, "--out", fixture.output, "--from", "2026-09-01", "--to", "2026-08-01"],
      /--from must not be later than --to/
    );
    await expectFailure([fixture.vault, "--out", fixture.output, "--role", " "], /--role must name a role/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("without --root the exporter uses the folder saved in the plugin settings", async () => {
  const fixture = await syntheticVault();
  try {
    await rename(path.join(fixture.vault, "Clinical Workspace"), path.join(fixture.vault, "Ward Records"));
    const settingsFolder = path.join(fixture.vault, ".obsidian", "plugins", "clinical-workspace");
    await mkdir(settingsFolder, { recursive: true });
    const settings = path.join(settingsFolder, "data.json");

    await writeFile(settings, JSON.stringify({ rootFolder: "/Ward Records/" }), "utf8");
    const result = await run(process.execPath, [script, fixture.vault, "--out", fixture.output]);
    assert.match(result.stdout, /Exported 1 completed procedure record/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Ward Records/);

    await writeFile(
      settings,
      JSON.stringify({ rootFolder: "Ward Records", migrationInProgress: { from: "Ward Records", to: "Elsewhere" } }),
      "utf8"
    );
    await expectFailure(
      [fixture.vault, "--out", path.join(fixture.home, "moving.csv")],
      /folder move that has not finished/
    );
    // An explicit --root is the operator's own decision.
    await run(process.execPath, [
      script,
      fixture.vault,
      "--out",
      path.join(fixture.home, "explicit.csv"),
      "--root",
      "Ward Records"
    ]);

    await writeFile(settings, JSON.stringify({ rootFolder: "../Outside" }), "utf8");
    await expectFailure(
      [fixture.vault, "--out", path.join(fixture.home, "outside.csv")],
      /clinical folder in the plugin settings must name a child folder/
    );
    await writeFile(settings, "{ not json", "utf8");
    await expectFailure([fixture.vault, "--out", path.join(fixture.home, "broken.csv")], /not valid JSON/);

    // No saved folder: the documented default applies.
    await writeFile(settings, JSON.stringify({ clinicianName: "" }), "utf8");
    await expectFailure(
      [fixture.vault, "--out", path.join(fixture.home, "default.csv")],
      /clinical root does not exist/
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("without --root the exporter refuses while the plugin records an unfinished recovery check or review", async () => {
  const fixture = await syntheticVault();
  try {
    await rename(path.join(fixture.vault, "Clinical Workspace"), path.join(fixture.vault, "Ward Records"));
    const settingsFolder = path.join(fixture.vault, ".obsidian", "plugins", "clinical-workspace");
    await mkdir(settingsFolder, { recursive: true });
    const settings = path.join(settingsFolder, "data.json");
    const safety = {
      version: 1,
      initialized: true,
      rootRecoveryRequired: false,
      recoveryValidationRequired: false,
      baselineReviewRequired: false,
      // More procedures than have arrived: what a partial Sync looks like.
      expectedEntityCounts: { patient: 1, episode: 1, task: 0, procedure: 3 }
    };

    for (const state of ["rootRecoveryRequired", "baselineReviewRequired"]) {
      await writeFile(
        settings,
        JSON.stringify({ rootFolder: "Ward Records", workspaceSafety: { ...safety, [state]: true } }),
        "utf8"
      );
      const output = path.join(fixture.home, `${state}.csv`);
      const stderr = await expectFailure(
        [fixture.vault, "--out", output],
        /recovery check or review that has not finished, so the records may be incomplete\. Finish it in Obsidian first, or pass --root explicitly\./
      );
      assert.doesNotMatch(stderr, /Ward Records|Synthetic|PRC-/, state);
      await assert.rejects(lstat(output), { code: "ENOENT" }, `${state}: no CSV was written`);
    }

    // With every flag clear, fewer procedures on disk than the plugin last
    // confirmed still means the workspace is incomplete: refuse, naming nothing.
    await writeFile(settings, JSON.stringify({ rootFolder: "Ward Records", workspaceSafety: safety }), "utf8");
    const partialOutput = path.join(fixture.home, "partial.csv");
    const partial = await expectFailure(
      [fixture.vault, "--out", partialOutput],
      /the workspace looks incomplete \(for example, still syncing\)\. Open the vault in Obsidian and let it finish/
    );
    assert.doesNotMatch(partial, /Ward Records|Synthetic|PRC-|EPI-|PAT-/);
    await assert.rejects(lstat(partialOutput), { code: "ENOENT" }, "partial: no CSV was written");

    // Once every committed record is present the saved folder is used as
    // before. A healthy workspace also carries recoveryValidationRequired
    // after any restart, because the plugin sets it at startup and never
    // clears it; that alone must not block an export.
    const complete = { ...safety, expectedEntityCounts: { patient: 1, episode: 1, task: 0, procedure: 2 } };
    await writeFile(settings, JSON.stringify({ rootFolder: "Ward Records", workspaceSafety: complete }), "utf8");
    const clear = await run(process.execPath, [script, fixture.vault, "--out", path.join(fixture.home, "clear.csv")]);
    assert.match(clear.stdout, /Exported 1 completed procedure record/);
    await writeFile(
      settings,
      JSON.stringify({ rootFolder: "Ward Records", workspaceSafety: { ...complete, recoveryValidationRequired: true } }),
      "utf8"
    );
    const restarted = await run(process.execPath, [
      script,
      fixture.vault,
      "--out",
      path.join(fixture.home, "restarted.csv")
    ]);
    assert.match(restarted.stdout, /Exported 1 completed procedure record/);
    // A state the plugin itself would not read (another version) is not a refusal either.
    await writeFile(
      settings,
      JSON.stringify({ rootFolder: "Ward Records", workspaceSafety: { ...safety, version: 2, baselineReviewRequired: true } }),
      "utf8"
    );
    await run(process.execPath, [script, fixture.vault, "--out", path.join(fixture.home, "other-version.csv")]);

    // An explicit --root is the operator's own decision, even when the saved
    // counts say records are missing.
    await writeFile(settings, JSON.stringify({ rootFolder: "Ward Records", workspaceSafety: safety }), "utf8");
    await run(process.execPath, [
      script,
      fixture.vault,
      "--out",
      path.join(fixture.home, "explicit-partial.csv"),
      "--root",
      "Ward Records"
    ]);
    await writeFile(
      settings,
      JSON.stringify({ rootFolder: "Ward Records", workspaceSafety: { ...safety, baselineReviewRequired: true } }),
      "utf8"
    );
    await run(process.execPath, [
      script,
      fixture.vault,
      "--out",
      path.join(fixture.home, "explicit.csv"),
      "--root",
      "Ward Records"
    ]);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("without --root the exporter refuses when episodes or read patients fall below the saved counts", async () => {
  const fixture = await syntheticVault();
  try {
    const settingsFolder = path.join(fixture.vault, ".obsidian", "plugins", "clinical-workspace");
    await mkdir(settingsFolder, { recursive: true });
    const settings = path.join(settingsFolder, "data.json");
    const safety = (counts: Record<string, number>, initialized = true) => JSON.stringify({
      workspaceSafety: {
        version: 1,
        initialized,
        rootRecoveryRequired: false,
        baselineReviewRequired: false,
        expectedEntityCounts: { patient: 1, episode: 1, task: 0, procedure: 2, ...counts }
      }
    });
    const incomplete = /the workspace looks incomplete \(for example, still syncing\)/;

    await writeFile(settings, safety({ episode: 2 }), "utf8");
    await expectFailure([fixture.vault, "--out", path.join(fixture.home, "episodes.csv")], incomplete);

    // Patients are read, and so compared, only for an identified export.
    await writeFile(settings, safety({ patient: 2 }), "utf8");
    await run(process.execPath, [script, fixture.vault, "--out", path.join(fixture.home, "pseudonymized.csv")]);
    const stderr = await expectFailure(
      [fixture.vault, "--out", path.join(fixture.home, "identified.csv"), "--identifiers"],
      incomplete
    );
    assert.doesNotMatch(stderr, /9000000001|Synthetic|PAT-|EPI-|PRC-/);
    await assert.rejects(lstat(path.join(fixture.home, "identified.csv")), { code: "ENOENT" });

    // Counts from a workspace the plugin has not initialized are not a commitment.
    await writeFile(settings, safety({ episode: 2 }, false), "utf8");
    await run(process.execPath, [script, fixture.vault, "--out", path.join(fixture.home, "uninitialized.csv")]);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("identified export reads a hand-edited MRN the way the plugin does", async () => {
  const fixture = await syntheticVault();
  try {
    const record = path.join(fixture.vault, "Clinical Workspace", "Patients", "PAT-test.md");
    const content = await readFile(record, "utf8");
    // Typed on an Arabic keyboard, with a space, a hyphen and a direction mark.
    const arabic = "\u200F\u0669\u0660\u0660\u0660 \u0660\u0660\u0660-\u0660\u0660\u0661";
    await writeFile(record, content.replace('mrn: "9000000001"', `mrn: "${arabic}"`), "utf8");

    // The in-app integrity check accepts it, so the exporter must too.
    const problems = validateRecord({
      schema_version: 3,
      entity: "patient",
      id: "PAT-test",
      created_at: "2026-08-08T08:00:00.000Z",
      updated_at: "2026-08-08T08:00:00.000Z",
      tags: ["clinical/patient"],
      mrn: arabic,
      mrn_status: "confirmed",
      patient_name: "Synthetic Patient",
      phone: "",
      phone_status: "not-found",
      status: "active",
      merged_into: ""
    });
    assert.ok(!problems.some((problem) => problem.code === "invalid-mrn"));

    await run(process.execPath, [script, fixture.vault, "--out", fixture.output, "--identifiers"]);
    const csv = await readFile(fixture.output, "utf8");
    assert.equal(normalizeMrn(arabic), "9000000001");
    assert.match(csv, /,"9000000001","Synthetic Patient"\n/, "written in the plugin's stored form");

    // Letters are still refused, by both.
    await writeFile(record, content.replace('mrn: "9000000001"', 'mrn: "MRN-X"'), "utf8");
    await expectFailure(
      [fixture.vault, "--out", path.join(fixture.home, "letters.csv"), "--identifiers"],
      /rejected 1 joined-patient identifier field value \(mrn: 1\)/
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("a plugin settings file resolving outside the vault is refused without naming the outside path", async (context) => {
  const fixture = await syntheticVault();
  try {
    const outside = path.join(fixture.home, "outside-settings.json");
    await writeFile(outside, JSON.stringify({ rootFolder: "Clinical Workspace" }), "utf8");
    const settingsFolder = path.join(fixture.vault, ".obsidian", "plugins", "clinical-workspace");
    await mkdir(settingsFolder, { recursive: true });
    const settings = path.join(settingsFolder, "data.json");
    try {
      await symlink(outside, settings);
    } catch (error) {
      context.skip(`Symbolic links unavailable: ${String(error)}`);
      return;
    }
    const stderr = await expectFailure(
      [fixture.vault, "--out", fixture.output],
      /plugin settings file resolves outside the supplied vault\. Pass --root explicitly\./
    );
    assert.ok(!stderr.includes(outside), "the outside path is not echoed");
    assert.ok(!stderr.includes(fixture.home), "nor any part of the fixture path");
    await assert.rejects(lstat(fixture.output), { code: "ENOENT" }, "no CSV was written");

    // A settings path that cannot be read as a file is refused as well.
    await rm(settings);
    await mkdir(settings);
    await expectFailure([fixture.vault, "--out", fixture.output], /plugin settings file could not be read/);
    await assert.rejects(lstat(fixture.output), { code: "ENOENT" });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});
