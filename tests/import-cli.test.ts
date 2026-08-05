import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = process.cwd();

async function runImporter(args: string[]): Promise<string> {
  const result = await exec(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/support/register.mjs",
      "tools/import-noteplan.ts",
      ...args
    ],
    { cwd: root }
  );
  return result.stdout;
}

test("CLI import is target-aware, rerunnable, and preserves the home note", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "clinical-noteplan-import-"));
  const staging = path.join(temporary, "staging");
  const vault = path.join(temporary, "vault");
  const home = path.join(vault, "Clinical Workspace", "00 Home", "Clinical Workspace.md");
  await mkdir(staging, { recursive: true });
  await mkdir(path.join(vault, ".obsidian", "plugins", "clinical-workspace"), { recursive: true });
  await mkdir(path.dirname(home), { recursive: true });
  await writeFile(home, "# My customized clinical home\n", "utf8");
  await writeFile(
    path.join(staging, "patient.txt"),
    "# 9000002999 - Synthetic Testpatient\nPhone: 0500000999\nDiagnosis: Synthetic case\n* [ ] Review >2026-08-20\n",
    "utf8"
  );

  const dryRun = await runImporter(["--from", staging, "--to", vault]);
  assert.match(dryRun, /new patients\s+1/);
  assert.match(dryRun, /existing files changed\s+0/);

  await runImporter(["--from", staging, "--to", vault, "--apply"]);
  assert.equal(await readFile(home, "utf8"), "# My customized clinical home\n");
  assert.equal((await readdir(path.join(vault, "Clinical Workspace", "Patients"))).length, 1);
  assert.equal((await readdir(path.join(vault, "Clinical Workspace", "Episodes"))).length, 1);
  assert.equal((await readdir(path.join(vault, "Clinical Workspace", "Tasks"))).length, 1);

  const rerun = await runImporter(["--from", staging, "--to", vault]);
  assert.match(rerun, /source notes already imported\s+1/);
  assert.match(rerun, /new patients\s+0/);
  assert.match(rerun, /new episodes\s+0/);
  assert.match(rerun, /existing files changed\s+0/);
});

test("CLI import skips an entire same-name cluster with conflicting MRNs", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "clinical-noteplan-conflict-"));
  const staging = path.join(temporary, "staging");
  const vault = path.join(temporary, "vault");
  await mkdir(staging, { recursive: true });
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });

  const notes = [
    ["one.txt", "# 9000003001 - Same Synthetic Name\nDiagnosis: First case\n"],
    ["two.txt", "# 9000003002 - Same Synthetic Name\nDiagnosis: Second case\n"],
    ["three.txt", "# Same Synthetic Name\nDiagnosis: Third case\n"],
    ["safe.txt", "# 9000003003 - Other Synthetic Name\nDiagnosis: Safe case\n"]
  ] as const;
  for (const [name, body] of notes) await writeFile(path.join(staging, name), body, "utf8");

  const dryRun = await runImporter([
    "--from",
    staging,
    "--to",
    vault,
    "--allow-problems",
    "--skip-identity-conflicts"
  ]);
  assert.match(dryRun, /identity-conflict notes skipped\s+3/);
  assert.match(dryRun, /new patients\s+1/);
  assert.match(dryRun, /new episodes\s+1/);
});
