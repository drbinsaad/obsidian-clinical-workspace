/**
 * Copies a built plugin into an Obsidian vault.
 *
 *   npm run install:vault -- "/path/to/vault"
 *
 * Refuses to install a development build — the one carrying the synthetic data
 * generator — unless --allow-dev is passed, because a vault that holds real
 * patient information must never gain the ability to fabricate records.
 */
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2).filter((a) => a !== "--");
const allowDev = args.includes("--allow-dev");
const vault = args.find((a) => !a.startsWith("--"));

if (!vault) {
  console.error('Usage: npm run install:vault -- "/path/to/vault" [--allow-dev]');
  process.exit(1);
}

const die = (message) => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

const exists = async (p) => stat(p).then(() => true).catch(() => false);

const vaultPath = path.resolve(vault);
if (!(await exists(vaultPath))) die(`No such folder: ${vaultPath}`);
if (!(await exists(path.join(vaultPath, ".obsidian")))) {
  die(`Not an Obsidian vault (no .obsidian folder): ${vaultPath}\nOpen it as a vault in Obsidian first.`);
}

const dist = path.resolve("dist");
const ASSETS = ["main.js", "manifest.json", "styles.css"];
for (const asset of ASSETS) {
  if (!(await exists(path.join(dist, asset)))) die(`dist/${asset} is missing. Run: npm run build`);
}

// A development build is identifiable by the fixtures it carries.
const bundle = await readFile(path.join(dist, "main.js"), "utf8");
const isDevBuild = bundle.includes("Synthetic Patient") || bundle.includes("seed-synthetic-demo-data");
if (isDevBuild && !allowDev) {
  die(
    "dist/main.js is a DEVELOPMENT build — it contains the synthetic data generator.\n" +
      "  Rebuild for release:            npm run build\n" +
      "  Or install it deliberately:     npm run install:vault -- \"<vault>\" --allow-dev"
  );
}

const target = path.join(vaultPath, ".obsidian", "plugins", "clinical-workspace");
await mkdir(target, { recursive: true });
for (const asset of ASSETS) {
  await copyFile(path.join(dist, asset), path.join(target, asset));
}

const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
console.log(`\n  Installed Clinical Workspace ${manifest.version}${isDevBuild ? " (DEVELOPMENT BUILD)" : ""}`);
console.log(`  -> ${target}`);
console.log("\n  In Obsidian: Settings -> Community plugins -> toggle Clinical Workspace off and on.\n");
