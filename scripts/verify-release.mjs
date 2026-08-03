/**
 * Release gate. Run after `npm run build`, before tagging or uploading.
 *
 * Checks the things that are cheap to verify and expensive to get wrong:
 * version files agreeing, required documents present, and — most importantly —
 * that no development tooling or identifier-shaped literal made it into the
 * artefacts that get attached to a GitHub release.
 */
import { readFile, stat } from "node:fs/promises";
import process from "node:process";

const url = (file) => new URL(`../${file}`, import.meta.url);
const readJson = async (file) => JSON.parse(await readFile(url(file), "utf8"));
const exists = async (file) => stat(url(file)).then(() => true).catch(() => false);

const failures = [];
const fail = (message) => failures.push(message);
const ok = (message) => console.log(`  ok    ${message}`);

// --- Versions ---------------------------------------------------------------
const pkg = await readJson("package.json");
const manifest = await readJson("manifest.json");
const versions = await readJson("versions.json");

if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  fail(`package.json version "${pkg.version}" is not a bare semantic version`);
} else if (pkg.version !== manifest.version) {
  fail(`package.json (${pkg.version}) and manifest.json (${manifest.version}) disagree`);
} else if (versions[manifest.version] !== manifest.minAppVersion) {
  fail(`versions.json is missing ${manifest.version} -> ${manifest.minAppVersion}`);
} else {
  ok(`version ${pkg.version} consistent across package.json, manifest.json, versions.json`);
}

if (manifest.isDesktopOnly !== false) fail("manifest.isDesktopOnly must be false — this is a mobile-first plugin");
else ok("manifest declares mobile support");

if (/obsidian/i.test(manifest.id)) fail('manifest.id must not contain "obsidian"');
else ok(`manifest id "${manifest.id}" follows Obsidian naming rules`);

// --- Required documents -----------------------------------------------------
for (const file of ["LICENSE", "SECURITY.md", "CHANGELOG.md", "README.md", "versions.json"]) {
  if (await exists(file)) ok(`${file} present`);
  else fail(`${file} is missing`);
}

// --- Release artefacts ------------------------------------------------------
const artefacts = ["dist/main.js", "dist/manifest.json", "dist/styles.css"];
for (const file of artefacts) {
  if (await exists(file)) ok(`${file} built`);
  else fail(`${file} is missing — run npm run build`);
}

// --- The bundle must be a release build -------------------------------------
if (await exists("dist/main.js")) {
  const bundle = await readFile(url("dist/main.js"), "utf8");
  const banned = [
    ["Synthetic Patient", "synthetic patient fixtures"],
    ["seed-synthetic-demo-data", "the synthetic data command"],
    ["Development:", "a development-only command name"]
  ];
  let clean = true;
  for (const [needle, description] of banned) {
    if (bundle.includes(needle)) {
      fail(`dist/main.js contains ${description} — build without CLINICAL_DEV_TOOLS=1`);
      clean = false;
    }
  }
  if (clean) ok("dist/main.js contains no development tooling");

  // Identifier-shaped literals have no business in a shipped bundle. Known
  // algorithmic constants are listed explicitly rather than pattern-matched, so
  // that adding a new one is a deliberate act.
  const ALLOWED_CONSTANTS = new Set([
    "2166136261", // FNV-1a 32-bit offset basis (0x811c9dc5)
    "16777619" //   FNV-1a 32-bit prime (0x01000193)
  ]);
  const digits = (bundle.match(/(?<![\w.])\d{7,}(?![\w.])/g) ?? []).filter(
    (value) => !ALLOWED_CONSTANTS.has(value)
  );
  if (digits.length) fail(`dist/main.js contains identifier-shaped literals: ${[...new Set(digits)].join(", ")}`);
  else ok("dist/main.js contains no identifier-shaped literals");

  for (const [pattern, description] of [
    [/\bfetch\s*\(/, "a fetch call"],
    [/XMLHttpRequest/, "XMLHttpRequest"],
    [/new WebSocket/, "a WebSocket"],
    [/\brequestUrl\s*\(/, "Obsidian's requestUrl"],
    [/\.innerHTML\s*=/, "an innerHTML assignment"],
    [/\beval\s*\(/, "eval"]
  ]) {
    if (pattern.test(bundle)) fail(`dist/main.js contains ${description}`);
  }
  ok("dist/main.js contains no network, eval or innerHTML usage");
}

// --- Report -----------------------------------------------------------------
console.log("");
if (failures.length) {
  console.error(`Release verification FAILED (${failures.length} problem${failures.length === 1 ? "" : "s"}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`Release verification passed. Tag this release as "${pkg.version}" (no 'v' prefix).`);
