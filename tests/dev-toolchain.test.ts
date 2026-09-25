/**
 * The repository's development toolchain: every Node.js release that
 * package.json's engines.node accepts must also be one that each locked
 * package accepts, and the public guides must name that same floor. Reads
 * package.json, package-lock.json and the Markdown guides only; installs and
 * runs nothing.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

// semver is the range library npm itself uses to check engines. It ships no
// types of its own, so only the calls made here are declared.
const semver = createRequire(import.meta.url)("semver") as {
  coerce(version: string): { version: string } | null;
  minVersion(range: string): { major: number; minor: number; patch: number } | null;
  satisfies(version: string, range: string): boolean;
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

// "^22.13.0 || >=24" is written "22.13" and "24" in prose.
const floorsOf = (range: string): string[] =>
  range.split("||").map((part) => {
    const floor = semver.minVersion(part.trim());
    assert.ok(floor, `"${part.trim()}" has a lowest version`);
    if (floor.patch !== 0) return `${floor.major}.${floor.minor}.${floor.patch}`;
    return floor.minor === 0 ? `${floor.major}` : `${floor.major}.${floor.minor}`;
  });

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the public guides name the Node.js floor package.json declares", async () => {
  // engines.node moved to 22.13 while the README, SECURITY.md and the
  // exporter guide still asked for "Node.js 22", and the guide accepted any
  // `node --version` starting with v22. On 22.0-22.12 the guide's next step,
  // `npm ci`, then warns that clinical-workspace itself is unsupported.
  const range = await projectNodeRange();
  const floors = floorsOf(range);
  const docs = (await readdir(new URL("../docs/", import.meta.url))).filter((name) => name.endsWith(".md"));
  const guides = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md", ...docs.map((name) => `docs/${name}`)];
  const stateRequirement = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "docs/logbook-export.md"];
  const mentions = (text: string, floor: string): boolean =>
    new RegExp(`Node\\.js ${escaped(floor)}(?![.\\d])`).test(text);
  const problems: string[] = [];
  for (const guide of guides) {
    const text = (await read(guide)).replace(/\s+/g, " ");
    // "Node.js 22", "Node.js v22.12" and a `v22` version check all name a release.
    for (const match of text.matchAll(/Node\.js v?(\d+(?:\.\d+){0,2})\b|`v(\d+(?:\.\d+){0,2})`/g)) {
      const version = semver.coerce(match[1] ?? match[2] ?? "")?.version ?? "0.0.0";
      if (!semver.satisfies(version, range)) problems.push(`${guide} names "${match[0]}"`);
    }
    if (!stateRequirement.includes(guide)) continue;
    for (const floor of floors) {
      if (!mentions(text, floor)) problems.push(`${guide} does not name Node.js ${floor}`);
    }
  }
  // Raising the floor changes what a contributor or exporter user must
  // install, so the change log has to say so too.
  const changelog = (await read("CHANGELOG.md")).replace(/\s+/g, " ");
  for (const floor of floors) {
    if (!mentions(changelog, floor)) problems.push(`CHANGELOG.md does not name Node.js ${floor}`);
  }
  assert.deepEqual(problems, [], `package.json engines.node is "${range}"`);
});
