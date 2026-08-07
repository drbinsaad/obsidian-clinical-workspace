/** Community-review preflight for source patterns that previously triggered review warnings. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

async function sourceFiles(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(target)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}

const failures = [];
const sources = await sourceFiles(path.join(root, "src"));
const combined = (await Promise.all(sources.map((file) => readFile(file, "utf8")))).join("\n");

for (const [pattern, message] of [
  [/\.getMarkdownFiles\s*\(/, "vault-wide Markdown enumeration"],
  [/\.getFiles\s*\(/, "vault-wide file enumeration"],
  [/\.getAllLoadedFiles\s*\(/, "vault-wide loaded-file enumeration"],
  [/\.setWarning\s*\(/, "deprecated setWarning()"],
  [/\bdisplay\s*\(\s*\)\s*:\s*void/, "deprecated imperative settings display()"],
  [/\bnavigator\.clipboard\b/, "clipboard access"],
  [/\bfetch\s*\(/, "network fetch"],
  [/\brequestUrl\s*\(/, "Obsidian requestUrl"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bnew\s+WebSocket\b/, "WebSocket"],
  [/\binnerHTML\s*=/, "innerHTML assignment"],
  [/\beval\s*\(/, "eval"],
  [/\bnew\s+Function\b/, "dynamic Function construction"]
]) {
  if (pattern.test(combined)) failures.push(message);
}

if (!combined.includes("getSettingDefinitions(): SettingDefinitionItem[]")) {
  failures.push("declarative getSettingDefinitions() implementation is missing");
}

if (failures.length > 0) {
  console.error("Community preflight failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Community preflight passed across ${sources.length} TypeScript source files.`);
