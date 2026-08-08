import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function syntheticVault(): Promise<string> {
  const vault = await mkdtemp(path.join(os.tmpdir(), "clinical-logbook-"));
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
status: planned
`);
  return vault;
}

test("logbook export is de-identified by default and neutralises spreadsheet formulas", async () => {
  const vault = await syntheticVault();
  const output = path.join(vault, "logbook.csv");
  try {
    const result = await run(process.execPath, [script, vault, "--out", output]);
    const csv = await readFile(output, "utf8");

    assert.match(result.stdout, /Wrote 1 completed procedure/);
    assert.match(result.stdout, /De-identified: no MRN or patient name/);
    assert.match(csv, /^﻿case_ref,date,procedure,role,/);
    assert.match(csv, /"PRC-test"/);
    assert.match(csv, /"'=HYPERLINK\(""https:\/\/invalid\.example"",""Synthetic""\)"/);
    assert.doesNotMatch(csv, /9000000001|Synthetic Patient/);
    assert.doesNotMatch(csv, /PRC-planned/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("identified logbook export requires the explicit flag", async () => {
  const vault = await syntheticVault();
  const output = path.join(vault, "identified.csv");
  try {
    const result = await run(process.execPath, [script, vault, "--out", output, "--identifiers"]);
    const csv = await readFile(output, "utf8");

    assert.match(result.stdout, /WARNING: this CSV contains MRNs and patient names/);
    assert.match(csv, /,mrn,patient_name\n/);
    assert.match(csv, /"9000000001","Synthetic Patient"/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});
