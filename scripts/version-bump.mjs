/**
 * Keeps package.json, manifest.json and versions.json in step.
 *
 * Run via `npm version <patch|minor|major>`, which updates package.json and
 * then fires this through the `version` lifecycle hook. Obsidian reads
 * manifest.json for the current version and versions.json to decide which
 * release a given app version is allowed to install, so all three must agree
 * before a tag is cut.
 */
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const read = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
const write = async (file, value) =>
  writeFile(new URL(`../${file}`, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);

const pkg = await read("package.json");
const version = pkg.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Refusing to bump: "${version}" is not a bare semantic version.`);
  console.error("Obsidian release tags carry no leading 'v' and no pre-release suffix.");
  process.exit(1);
}

const manifest = await read("manifest.json");
const previousVersion = manifest.version;
manifest.version = version;
await write("manifest.json", manifest);

const versions = await read("versions.json");
versions[version] = manifest.minAppVersion;
await write("versions.json", versions);

console.log(`Clinical Workspace ${previousVersion} -> ${version} (minAppVersion ${manifest.minAppVersion})`);
console.log("Updated package.json, manifest.json, versions.json.");
console.log(`Tag this release as "${version}" — no 'v' prefix.`);
