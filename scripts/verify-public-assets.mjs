import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASSET_DIRECTORY = path.join(ROOT, "docs", "assets");
const CHECKSUM_FILE = path.join(ASSET_DIRECTORY, "SHA256SUMS");
const EXPECTED_ASSETS = ["hero.png", "patients-desktop.png"];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FORBIDDEN_METADATA_CHUNKS = new Set(["eXIf", "iTXt", "tEXt", "zTXt"]);

function fail(message) {
  console.error(`Public asset verification failed: ${message}`);
  process.exitCode = 1;
}

function pngChunks(data, asset) {
  if (data.length < PNG_SIGNATURE.length || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${asset} is not a valid PNG.`);
  }

  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) throw new Error(`${asset} contains a truncated PNG chunk.`);
    chunks.push(data.toString("ascii", offset + 4, offset + 8));
    offset = end;
  }

  if (offset !== data.length || chunks[0] !== "IHDR" || chunks.at(-1) !== "IEND") {
    throw new Error(`${asset} has an invalid PNG chunk layout.`);
  }
  return chunks;
}

const checksumText = await readFile(CHECKSUM_FILE, "utf8");
const approved = new Map();
for (const line of checksumText.trim().split("\n")) {
  const match = /^([a-f0-9]{64}) {2}([^/]+\.png)$/.exec(line);
  if (!match) throw new Error("SHA256SUMS contains an invalid entry.");
  approved.set(match[2], match[1]);
}

const actualAssets = (await readdir(ASSET_DIRECTORY))
  .filter((entry) => !entry.startsWith("._") && entry.toLowerCase().endsWith(".png"))
  .sort();
if (JSON.stringify(actualAssets) !== JSON.stringify(EXPECTED_ASSETS)) {
  fail("the PNG asset set changed without an explicit verifier update.");
}
if (JSON.stringify([...approved.keys()].sort()) !== JSON.stringify(EXPECTED_ASSETS)) {
  fail("SHA256SUMS does not name exactly the reviewed PNG assets.");
}

for (const asset of EXPECTED_ASSETS) {
  const data = await readFile(path.join(ASSET_DIRECTORY, asset));
  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== approved.get(asset)) {
    fail(`${asset} changed; inspect every pixel and update SHA256SUMS only after privacy review.`);
  }

  let chunks;
  try {
    chunks = pngChunks(data, asset);
  } catch (error) {
    fail(error instanceof Error ? error.message : `${asset} could not be parsed.`);
    continue;
  }
  const forbidden = chunks.find((chunk) => FORBIDDEN_METADATA_CHUNKS.has(chunk));
  if (forbidden) fail(`${asset} contains forbidden ${forbidden} metadata.`);
}

if (!process.exitCode) console.log("Reviewed public assets are unchanged and metadata-safe.");
