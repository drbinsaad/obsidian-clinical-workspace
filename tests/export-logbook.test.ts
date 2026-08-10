import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

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
      ["quote", 'Safe "quoted" value']
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
