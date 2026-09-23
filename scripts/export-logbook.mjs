/**
 * Export a surgery logbook to CSV by joining procedures and episodes.
 *
 * The default export is PSEUDONYMIZED, NOT ANONYMOUS. It does not read the
 * Patients folder or add dedicated MRN and patient-name columns, but free text,
 * stable case references, dates, and clinical details may still identify a
 * person. The resulting CSV is confidential and may be re-identifiable.
 *
 * Identified export is deliberately opt-in. `--identifiers` reads Patients and
 * adds MRN and patient name after validating every relationship.
 */
import {
  chmod,
  link,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { parse } from "yaml";
import {
  CARE_SETTINGS,
  EPISODE_STATUSES,
  PATHWAYS,
  PRIORITIES,
  PROCEDURE_STATUSES
} from "./export-logbook-enums.mjs";

// Resolve the package root once from this script rather than from the caller's
// working directory. Confidential exports must never be created anywhere in the
// public source checkout, even when --out reaches it through a symbolic-link
// parent outside the checkout.
const SOURCE_CHECKOUT = await realpath(fileURLToPath(new URL("..", import.meta.url)));

const USAGE = `
  Usage: npm run export:logbook -- "/path/to/vault" --out "/safe/location/logbook.csv" [options]

    --out <file>        Required CSV destination outside the vault and source checkout
    --root <folder>     Vault-relative clinical folder (default: the folder set in the
                        plugin's settings, else "Clinical Workspace")
    --from <YYYY-MM-DD> Only procedures on or after this date
    --to <YYYY-MM-DD>   Only procedures on or before this date
    --role <label>      Only procedures logged with this role (not case-sensitive)
    --identifiers       Include MRN and patient name; reads the Patients folder
    --force             Replace an existing regular CSV file
    --help              Show this help

  Every record is validated before the filters are applied.
  The default CSV is pseudonymized, not anonymous. It remains confidential.
`;

const DEFAULT_ROOT = "Clinical Workspace";

/** Console errors stay aggregate; the in-app check links to each affected note. */
const INTEGRITY_CHECK_HINT =
  'Run "Clinical Workspace: Run clinical data integrity check" in Obsidian to find the affected notes.';

class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExportError";
  }
}

function fail(message) {
  throw new ExportError(message);
}

function parseArguments(args) {
  const valueOptions = new Set(["out", "root", "from", "to", "role"]);
  const booleanOptions = new Set(["identifiers", "force", "help"]);
  const values = new Map();
  const flags = new Set();
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    // npm removes its separator before invoking this script. Ignoring a literal
    // separator as well keeps direct `node ... -- ...` invocation equivalent.
    if (token === "--") continue;

    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (valueOptions.has(name)) {
        if (values.has(name)) fail(`Option --${name} may be supplied only once.`);
        const value = args[index + 1];
        if (!value || value === "--" || value.startsWith("--")) {
          fail(`Option --${name} requires a value.`);
        }
        values.set(name, value);
        index += 1;
        continue;
      }
      if (booleanOptions.has(name)) {
        if (flags.has(name)) fail(`Flag --${name} may be supplied only once.`);
        flags.add(name);
        continue;
      }
      fail("Unknown command-line option.");
    }

    if (token.startsWith("-") && token !== "-") fail("Unknown command-line option.");

    positionals.push(token);
  }

  if (flags.has("help")) return { help: true };
  if (positionals.length !== 1) fail("Supply exactly one vault path.");
  if (!values.has("out")) fail("Option --out is required; no default output path is used.");

  const from = values.get("from") ?? null;
  const to = values.get("to") ?? null;
  if (from !== null && !isDateOnly(from)) fail("--from must be a real calendar date written YYYY-MM-DD.");
  if (to !== null && !isDateOnly(to)) fail("--to must be a real calendar date written YYYY-MM-DD.");
  if (from !== null && to !== null && from > to) fail("--from must not be later than --to.");
  const role = values.has("role") ? cleanText(values.get("role")) : null;
  if (role === "") fail("--role must name a role.");

  return {
    help: false,
    vault: positionals[0],
    out: values.get("out"),
    root: values.get("root") ?? null,
    from,
    to,
    role,
    identifiers: flags.has("identifiers"),
    force: flags.has("force")
  };
}

function isInside(parent, candidate, allowEqual = false) {
  const relative = path.relative(parent, candidate);
  if (relative === "") return allowEqual;
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record, key) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function existingDirectory(input, label) {
  try {
    const canonical = await realpath(path.resolve(input));
    const details = await stat(canonical);
    if (!details.isDirectory()) fail(`${label} must be a directory.`);
    return canonical;
  } catch (error) {
    if (error instanceof ExportError) throw error;
    fail(`${label} does not exist or cannot be accessed.`);
  }
}

function validateRootArgument(root, source = "--root") {
  if (!root || path.isAbsolute(root)) fail(`${source} must be a non-empty vault-relative folder.`);
  const segments = root.split(/[\\/]+/u);
  if (segments.some((segment) => segment === "..") || segments.every((segment) => segment === "." || segment === "")) {
    fail(`${source} must name a child folder and may not contain traversal segments.`);
  }
}

/**
 * The clinical folder saved in the plugin's settings, so an export after a
 * folder move needs no --root. Only the vault's default config folder is
 * read. A folder move the plugin has not finished is refused: the records
 * could then be in either folder. So is a recovery check or review the
 * plugin still requires (it keeps editing paused then): the records under
 * that folder may be incomplete, for example while Sync is still delivering.
 */
async function configuredRoot(vault) {
  const settingsFile = path.join(vault, ".obsidian", "plugins", "clinical-workspace", "data.json");
  let text;
  try {
    const canonical = await realpath(settingsFile);
    if (!isInside(vault, canonical)) {
      fail("The plugin settings file resolves outside the supplied vault. Pass --root explicitly.");
    }
    text = await readFile(canonical, "utf8");
  } catch (error) {
    if (error instanceof ExportError) throw error;
    if (isRecord(error) && error.code === "ENOENT") return DEFAULT_ROOT;
    fail("The plugin settings file could not be read. Pass --root explicitly.");
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    fail("The plugin settings file is not valid JSON. Pass --root explicitly.");
  }
  if (!isRecord(settings)) fail("The plugin settings file is not a settings object. Pass --root explicitly.");
  if (settings.migrationInProgress !== undefined && settings.migrationInProgress !== null) {
    fail(
      "The plugin records a clinical folder move that has not finished. Finish or recover it in Obsidian first, or pass --root explicitly."
    );
  }
  // recoveryValidationRequired is deliberately not read: the plugin sets it
  // on every startup and never clears it, so a healthy workspace carries it.
  const safety = settings.workspaceSafety;
  if (
    isRecord(safety) &&
    safety.version === 1 &&
    (safety.rootRecoveryRequired === true || safety.baselineReviewRequired === true)
  ) {
    fail(
      "The plugin records a recovery check or review that has not finished, so the records may be incomplete. Finish it in Obsidian first, or pass --root explicitly."
    );
  }
  if (typeof settings.rootFolder !== "string") return DEFAULT_ROOT;
  // The plugin's own normalisation: forward slashes, no repeated or edge separators.
  const root = settings.rootFolder
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/^\/+|\/+$/gu, "")
    .trim();
  if (!root) return DEFAULT_ROOT;
  validateRootArgument(root, "The clinical folder in the plugin settings");
  return root;
}

async function clinicalRoot(vault, rootArgument) {
  validateRootArgument(rootArgument);
  let canonical;
  try {
    canonical = await realpath(path.resolve(vault, rootArgument));
    if (!(await stat(canonical)).isDirectory()) fail("The clinical root must be a directory.");
  } catch (error) {
    if (error instanceof ExportError) throw error;
    fail("The clinical root does not exist or cannot be accessed.");
  }
  if (!isInside(vault, canonical)) {
    fail("The clinical root must remain inside the supplied vault, including after resolving symbolic links.");
  }
  return canonical;
}

async function entityFolder(root, name) {
  let canonical;
  try {
    canonical = await realpath(path.join(root, name));
    if (!(await stat(canonical)).isDirectory()) fail(`The required ${name} folder is not a directory.`);
  } catch (error) {
    if (error instanceof ExportError) throw error;
    fail(`The required ${name} folder does not exist or cannot be accessed.`);
  }
  if (!isInside(root, canonical)) {
    fail(`The required ${name} folder resolves outside the clinical root.`);
  }
  return canonical;
}

async function markdownContents(folder, label) {
  const contents = [];

  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      fail(`The ${label} folder could not be read completely.`);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.name.startsWith("._")) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`The ${label} folder contains a symbolic link; export stops rather than following an ambiguous path.`);
      }
      if (entry.isDirectory()) {
        let canonical;
        try {
          canonical = await realpath(candidate);
        } catch {
          fail(`The ${label} folder contains an inaccessible directory.`);
        }
        if (!isInside(folder, canonical, true)) fail(`The ${label} folder contains a path that resolves outside it.`);
        await visit(canonical);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;

      try {
        const canonical = await realpath(candidate);
        if (!isInside(folder, canonical)) fail(`The ${label} folder contains a record outside its boundary.`);
        contents.push(await readFile(canonical, "utf8"));
      } catch (error) {
        if (error instanceof ExportError) throw error;
        fail(`A Markdown record in the ${label} folder could not be read.`);
      }
    }
  }

  await visit(folder);
  return contents;
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

function frontmatter(content) {
  const block = FRONTMATTER.exec(content)?.[1];
  if (!block) return null;
  try {
    const parsed = parse(block, { schema: "core", maxAliasCount: 0 });
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function recordsIn(root, folderName, entity) {
  const folder = await entityFolder(root, folderName);
  const contents = await markdownContents(folder, folderName);
  const records = [];
  let invalid = 0;

  for (const content of contents) {
    const data = frontmatter(content);
    const id = data ? requiredString(data, "id") : null;
    if (!data || data.entity !== entity || !id) {
      invalid += 1;
      continue;
    }
    records.push({ ...data, id });
  }

  if (invalid > 0) {
    fail(`${invalid} Markdown record${invalid === 1 ? "" : "s"} in ${folderName} had invalid or unreadable frontmatter. ${INTEGRITY_CHECK_HINT}`);
  }

  const seen = new Set();
  let duplicates = 0;
  for (const record of records) {
    if (seen.has(record.id)) duplicates += 1;
    seen.add(record.id);
  }
  if (duplicates > 0) {
    fail(`${folderName} contains duplicate record IDs (${duplicates} conflict${duplicates === 1 ? "" : "s"}). ${INTEGRITY_CHECK_HINT}`);
  }

  return records;
}

function indexById(records) {
  return new Map(records.map((record) => [record.id, record]));
}

function validateRelationships(procedures, episodes, patients) {
  const episodeById = indexById(episodes);
  const patientById = patients ? indexById(patients) : null;
  let invalid = 0;

  for (const episode of episodes) {
    const patientId = requiredString(episode, "patient_id");
    if (!patientId) {
      invalid += 1;
    } else if (patientById && !patientById.has(patientId)) {
      invalid += 1;
    }
  }

  for (const procedure of procedures) {
    const episodeId = requiredString(procedure, "episode_id");
    const procedurePatientId = requiredString(procedure, "patient_id");
    const episode = episodeId ? episodeById.get(episodeId) : null;
    const episodePatientId = episode ? requiredString(episode, "patient_id") : null;

    if (!episodeId || !procedurePatientId || !episode || !episodePatientId) {
      invalid += 1;
      continue;
    }
    if (procedurePatientId !== episodePatientId) invalid += 1;
    if (patientById && !patientById.has(procedurePatientId)) invalid += 1;
  }

  if (invalid > 0) {
    fail(`Record integrity validation found ${invalid} invalid or mismatched relationship${invalid === 1 ? "" : "s"}. No CSV was written. ${INTEGRITY_CHECK_HINT}`);
  }

  return { episodeById, patientById };
}

function isString(value) {
  return typeof value === "string";
}

function isNonEmptyString(value) {
  return isString(value) && value.trim().length > 0;
}

function isDateOnly(value) {
  if (!isNonEmptyString(value) || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  // Runtime records use UTC ISO timestamps. Date.parse alone is insufficient:
  // it silently normalizes impossible values such as 30 February.
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (!match) return false;
  const canonical = `${match[1]}.${match[2] ?? "000"}Z`;
  const parsed = new Date(canonical);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === canonical;
}

/**
 * The plugin's normalizeMrn (src/domain/schema.ts): invisible and direction
 * controls removed, Arabic-Indic and Persian digits read as ASCII, spaces and
 * hyphens dropped. The in-app integrity check validates this form, so the
 * exporter validates and writes it too; otherwise a hand-edited MRN would be
 * refused here while the check the error points to finds nothing.
 */
function normalizeMrn(value) {
  return value
    .replace(/[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, "")
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/gu, (digit) => {
      const code = digit.codePointAt(0) ?? 0;
      return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
    })
    .replace(/[\s-]/gu, "");
}

/** Counts rejected values per property name for one kind of record. */
class FieldRejections {
  constructor(order) {
    this.order = order;
    this.counts = new Map();
  }

  add(field) {
    this.counts.set(field, (this.counts.get(field) ?? 0) + 1);
  }

  get total() {
    let total = 0;
    for (const count of this.counts.values()) total += count;
    return total;
  }

  /** Property names and counts only, so the breakdown can never identify a record. */
  describe(noun) {
    const total = this.total;
    const parts = this.order
      .filter((field) => this.counts.has(field))
      .map((field) => `${field}: ${this.counts.get(field)}`);
    return `${total} ${noun}${total === 1 ? "" : "s"} (${parts.join(", ")})`;
  }
}

/**
 * Validate every value that can reach a CSV cell. Empty optional strings are
 * explicit and accepted; missing values, arrays, objects, and invalid enums are
 * not silently stringified. Error output is aggregate-only so it cannot expose
 * a filename, record ID, patient identifier, or clinical text: counts per
 * property name, plus a pointer to the in-app integrity check, which does
 * link to the affected notes.
 */
function validateExportSchema(procedures, episodeById, patientById, identifiers) {
  let invalidProcedureStatuses = 0;
  const procedureFields = new FieldRejections([
    "procedure",
    "role",
    "outcome",
    "procedure_date",
    "created_at",
    "follow_up_required",
    "follow_up_date"
  ]);
  const episodeFields = new FieldRejections(["case", "care_setting", "pathway", "priority", "status"]);
  const patientFields = new FieldRejections(["mrn", "patient_name", "mrn or patient_name"]);
  const completed = [];
  const joinedEpisodes = new Map();
  const joinedPatients = new Map();

  for (const procedure of procedures) {
    if (!isNonEmptyString(procedure.status) || !PROCEDURE_STATUSES.has(procedure.status)) {
      invalidProcedureStatuses += 1;
      continue;
    }
    if (procedure.status !== "completed") continue;
    completed.push(procedure);

    if (!isNonEmptyString(procedure.procedure)) procedureFields.add("procedure");
    if (!isNonEmptyString(procedure.role)) procedureFields.add("role");
    if (!isString(procedure.outcome)) procedureFields.add("outcome");
    if (!isDateOnly(procedure.procedure_date)) procedureFields.add("procedure_date");
    if (!isTimestamp(procedure.created_at)) procedureFields.add("created_at");
    if (typeof procedure.follow_up_required !== "boolean") procedureFields.add("follow_up_required");
    const followUpDateValid =
      isString(procedure.follow_up_date) &&
      (procedure.follow_up_date === "" || isDateOnly(procedure.follow_up_date));
    if (!followUpDateValid || (procedure.follow_up_required === true && procedure.follow_up_date === "")) {
      procedureFields.add("follow_up_date");
    }

    const episodeId = requiredString(procedure, "episode_id");
    const patientId = requiredString(procedure, "patient_id");
    const episode = episodeId ? episodeById.get(episodeId) : null;
    const patient = identifiers && patientId ? patientById?.get(patientId) : null;
    if (episode) joinedEpisodes.set(episode.id, episode);
    if (patient) joinedPatients.set(patient.id, patient);
  }

  for (const episode of joinedEpisodes.values()) {
    if (!isNonEmptyString(episode.case)) episodeFields.add("case");
    if (!isNonEmptyString(episode.care_setting) || !CARE_SETTINGS.has(episode.care_setting)) {
      episodeFields.add("care_setting");
    }
    if (!isNonEmptyString(episode.pathway) || !PATHWAYS.has(episode.pathway)) episodeFields.add("pathway");
    if (!isNonEmptyString(episode.priority) || !PRIORITIES.has(episode.priority)) episodeFields.add("priority");
    if (!isNonEmptyString(episode.status) || !EPISODE_STATUSES.has(episode.status)) episodeFields.add("status");
  }

  for (const patient of joinedPatients.values()) {
    const mrn = isString(patient.mrn) ? normalizeMrn(patient.mrn) : null;
    const validMrn = mrn !== null && (mrn === "" || /^\d+$/u.test(mrn));
    const validName = isString(patient.patient_name);
    if (!validMrn) patientFields.add("mrn");
    if (!validName) patientFields.add("patient_name");
    // The runtime permits MRN-only or name-only identities, but never neither.
    if (
      !(validMrn && mrn.length > 0) &&
      !(validName && patient.patient_name.trim().length > 0)
    ) {
      patientFields.add("mrn or patient_name");
    }
  }

  const errors = [];
  if (invalidProcedureStatuses > 0) {
    errors.push(`${invalidProcedureStatuses} procedure status value${invalidProcedureStatuses === 1 ? "" : "s"}`);
  }
  if (procedureFields.total > 0) errors.push(procedureFields.describe("completed-procedure field value"));
  if (episodeFields.total > 0) errors.push(episodeFields.describe("joined-episode field value"));
  if (patientFields.total > 0) errors.push(patientFields.describe("joined-patient identifier field value"));
  if (errors.length > 0) {
    fail(`Export schema validation rejected ${errors.join("; ")}. No CSV was written. ${INTEGRITY_CHECK_HINT}`);
  }

  return completed;
}

/**
 * Narrows validated completed procedures to the requested period and role.
 * Runs only after every record passed validation, so a filter can never hide
 * a damaged record from the checks.
 */
function applyFilters(completed, options) {
  return completed.filter((procedure) => {
    if (options.from !== null && procedure.procedure_date < options.from) return false;
    if (options.to !== null && procedure.procedure_date > options.to) return false;
    if (
      options.role !== null &&
      cleanText(procedure.role).toLocaleLowerCase() !== options.role.toLocaleLowerCase()
    ) {
      return false;
    }
    return true;
  });
}

async function outputTarget(vault, requested, force) {
  const resolved = path.resolve(requested);
  if (path.extname(resolved).toLowerCase() !== ".csv") fail("--out must use the .csv extension.");

  let parent;
  try {
    parent = await realpath(path.dirname(resolved));
    if (!(await stat(parent)).isDirectory()) fail("The output parent must be a directory.");
  } catch (error) {
    if (error instanceof ExportError) throw error;
    fail("The output parent directory does not exist or cannot be accessed.");
  }

  const target = path.join(parent, path.basename(resolved));
  if (isInside(vault, target, true)) {
    fail("The output CSV must be outside the supplied vault, even when --force is used.");
  }
  if (isInside(SOURCE_CHECKOUT, target, true)) {
    fail("The output CSV must be outside this source checkout.");
  }

  let existing = null;
  try {
    existing = await lstat(target);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") fail("The output destination could not be inspected safely.");
  }
  if (existing?.isSymbolicLink()) fail("The output destination may not be a symbolic link.");
  if (existing && !existing.isFile()) fail("The output destination must be a regular file.");
  if (existing && !force) fail("The output file already exists. Use --force to replace it explicitly.");

  return target;
}

function cleanText(value) {
  if (value === null || value === undefined) return "";
  const withoutControls = [...String(value)]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    // Strip directionality controls (ALM/LRM/RLM, overrides, isolates):
    // an RLO smuggled into a cell can visually reorder neighbouring cells in a
    // spreadsheet — and this CSV is the one artifact meant to leave the vault.
    // ZWNJ/ZWJ are deliberately preserved: they are orthographically
    // significant in Persian and other Arabic-script text (see
    // src/domain/schema.ts normalizeText, which strips the same controls).
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "");
  return withoutControls.replace(/\s+/gu, " ").trim();
}

/** Prevent Excel, Numbers, Sheets, and LibreOffice from evaluating formulas. */
function csvCell(value) {
  const raw = cleanText(value);
  const safe = /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvFor(procedures, episodeById, patientById, identifiers) {
  const columns = [
    ["case_ref", (procedure) => procedure.id],
    ["date", (procedure) => procedure.procedure_date],
    ["procedure", (procedure) => procedure.procedure],
    ["role", (procedure) => procedure.role],
    ["care_setting", (procedure, episode) => episode.care_setting],
    ["pathway", (procedure, episode) => episode.pathway],
    ["priority", (procedure, episode) => episode.priority],
    ["indication", (procedure, episode) => episode.case],
    ["outcome", (procedure) => procedure.outcome],
    ["follow_up_required", (procedure) => (procedure.follow_up_required ? "yes" : "no")],
    ["follow_up_date", (procedure) => procedure.follow_up_date],
    ["episode_status", (procedure, episode) => episode.status],
    ["logged_at", (procedure) => procedure.created_at],
    ...(identifiers
      ? [
          ["mrn", (procedure, episode, patient) => normalizeMrn(patient.mrn)],
          ["patient_name", (procedure, episode, patient) => patient.patient_name]
        ]
      : [])
  ];

  const completed = [...procedures].sort((left, right) =>
    cleanText(right.procedure_date).localeCompare(cleanText(left.procedure_date))
  );
  const rows = completed.map((procedure) => {
    const episode = episodeById.get(requiredString(procedure, "episode_id"));
    const patient = patientById?.get(requiredString(procedure, "patient_id"));
    return columns.map(([, read]) => csvCell(read(procedure, episode, patient))).join(",");
  });

  return {
    csv: `﻿${columns.map(([name]) => name).join(",")}\n${rows.join("\n")}\n`,
    completed: completed.length
  };
}

async function restrictPermissions(file) {
  try {
    await chmod(file, 0o600);
  } catch (error) {
    if (process.platform === "win32" && isRecord(error) && ["ENOSYS", "EINVAL", "EPERM"].includes(error.code)) return;
    fail("Owner-only permissions could not be applied to the output safely.");
  }
}

async function atomicWrite(target, content, force) {
  const temporary = path.join(
    path.dirname(target),
    `.clinical-workspace-export-${process.pid}-${randomUUID()}.tmp`
  );
  let handle = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await restrictPermissions(temporary);

    if (force) {
      try {
        await rename(temporary, target);
      } catch {
        fail("The completed temporary CSV could not replace the destination atomically. No partial CSV was left behind.");
      }
    } else {
      // A same-directory hard link publishes the complete, fsynced inode only
      // if the destination is still absent. Unlike check-then-rename, this is
      // atomic and cannot clobber a file created by a concurrent process.
      try {
        await link(temporary, target);
      } catch (error) {
        if (isRecord(error) && error.code === "EEXIST") {
          fail("The output file appeared during export and was not overwritten. Use --force only after inspecting it.");
        }
        fail("The completed temporary CSV could not be published atomically. No partial CSV was left behind.");
      }
    }
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The cleanup below still removes the private temporary file.
      }
    }
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const vault = await existingDirectory(options.vault, "The supplied vault");
  const root = await clinicalRoot(vault, options.root ?? (await configuredRoot(vault)));
  const target = await outputTarget(vault, options.out, options.force);

  if (options.identifiers) {
    console.error(
      "WARNING: identified export requested. The CSV will contain MRNs and patient names and must be handled as a clinical record."
    );
  }

  const procedures = await recordsIn(root, "Procedures", "procedure");
  if (procedures.length === 0) fail("No valid procedure records were found; no CSV was written.");
  const episodes = await recordsIn(root, "Episodes", "episode");
  const patients = options.identifiers ? await recordsIn(root, "Patients", "patient") : null;
  const { episodeById, patientById } = validateRelationships(procedures, episodes, patients);
  const completed = validateExportSchema(procedures, episodeById, patientById, options.identifiers);
  const selected = applyFilters(completed, options);
  const result = csvFor(selected, episodeById, patientById, options.identifiers);

  await atomicWrite(target, result.csv, options.force);

  console.log(`Exported ${result.completed} completed procedure record${result.completed === 1 ? "" : "s"}.`);
  const skipped = procedures.length - completed.length;
  if (skipped > 0) {
    console.log(`Excluded ${skipped} non-completed procedure record${skipped === 1 ? "" : "s"}.`);
  }
  const filtered = completed.length - selected.length;
  if (filtered > 0) {
    console.log(`Excluded ${filtered} completed procedure record${filtered === 1 ? "" : "s"} outside the requested dates or role.`);
  }
  console.log(
    options.identifiers
      ? "Identified confidential CSV created with owner-only permissions where supported."
      : "Pseudonymized confidential CSV created. It is not anonymous and may be re-identifiable."
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof ExportError ? error.message : "Unexpected internal error. No CSV was written.";
  console.error(`Export failed: ${message}`);
  process.exitCode = 1;
}
