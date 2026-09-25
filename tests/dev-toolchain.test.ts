/**
 * The repository's development toolchain: every Node.js release that
 * package.json's engines.node accepts must also be one that each locked
 * package accepts. Reads package.json and package-lock.json only; installs
 * and runs nothing.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

// semver is the range library npm itself uses to check engines. It ships no
// types of its own, so only the calls made here are declared.
const semver = createRequire(import.meta.url)("semver") as {
  subset(subRange: string, superRange: string): boolean;
};

interface LockEntry {
  version?: string;
  engines?: { node?: string };
}

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const projectNodeRange = async (): Promise<string> => {
  const manifest = JSON.parse(await read("package.json")) as { engines?: { node?: string } };
  const range = manifest.engines?.node;
  assert.ok(range, "package.json declares engines.node");
  return range;
};

const lockedPackages = async (): Promise<Record<string, LockEntry>> =>
  (JSON.parse(await read("package-lock.json")) as { packages: Record<string, LockEntry> }).packages;

test("every locked package supports every Node.js release package.json accepts", async () => {
  // ESLint 10 and its packages need 22.13 on the 22 line while package.json
  // still accepted any 22; a grouped Dependabot bump that raises a floor again
  // must fail here rather than at a contributor's first lint.
  const range = await projectNodeRange();
  const packages = await lockedPackages();
  assert.equal(packages[""]?.engines?.node, range, "package-lock.json records the same engines.node");
  const narrower: string[] = [];
  for (const [location, entry] of Object.entries(packages)) {
    const required = entry.engines?.node;
    if (location === "" || required === undefined) continue;
    if (!semver.subset(range, required)) narrower.push(`${location}@${entry.version ?? "?"} requires ${required}`);
  }
  assert.deepEqual(narrower, [], `package.json engines.node is "${range}"`);
});
