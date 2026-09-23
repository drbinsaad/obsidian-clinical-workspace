import { generatedBaseVersions, homeNote, LEGACY_HOME_OPEN_LINE } from "./bases";
import { clinicalFolder } from "./paths";

/**
 * Whether a generated file is still exactly as this plugin wrote it.
 *
 * Both `ensureStructure` and the folder migration regenerate database views and
 * the home note. Either would happily overwrite work the user has done in them,
 * so both ask here first — and the answer is a byte comparison, not a
 * resemblance test. A heuristic cannot tell one line of the user's prose from
 * one line of ours, and guessing wrong destroys their writing.
 *
 * Any version this plugin ever generated counts, for whichever root it was
 * generated for, so an older untouched base can still be upgraded.
 */
export function isUntouchedBase(path: string, content: string): boolean {
  const referenced = /file\.inFolder\("([^"]+)"\)/.exec(content)?.[1];
  if (!referenced) return false;
  const name = path.split("/").pop();
  if (!name) return false;
  // Current output doubles an apostrophe inside the YAML scalar; output up to
  // 0.6.9 wrote the folder raw. Try the folder both ways.
  const folders = new Set([referenced.replaceAll("''", "'"), referenced]);
  for (const folder of folders) {
    const priorRoot = folder.replace(/\/[^/]+$/, "");
    const basePath = `${clinicalFolder("bases", priorRoot)}/${name}`;
    for (const version of generatedBaseVersions(priorRoot)) {
      const generated = version[basePath];
      if (generated !== undefined && generated.trim() === content.trim()) return true;
    }
  }
  return false;
}

export function isUntouchedHome(content: string): boolean {
  const referenced = /!\[\[(.+?)\/Bases\/Patients\.base/.exec(content)?.[1];
  if (!referenced) return false;
  if (homeNote(referenced).trim() === content.trim()) return true;
  // The scaffold shipped from 0.2.0 through 0.6.9, which named the command
  // incorrectly.
  if (homeNote(referenced, LEGACY_HOME_OPEN_LINE).trim() === content.trim()) return true;
  // The scaffold shipped by 0.1.0, before Episodes.base existed.
  const legacy = [
    "# Clinical Workspace",
    "",
    "Use the **Open Clinical Workspace** command for the mobile patient, task and surgery interface.",
    "",
    "## Database views",
    "",
    `- ![[${referenced}/Bases/Patients.base#Active patients]]`,
    `- ![[${referenced}/Bases/Tasks.base#Open tasks]]`,
    `- ![[${referenced}/Bases/Surgery Logbook.base#Surgery logbook]]`
  ].join("\n");
  return legacy.trim() === content.trim();
}

/**
 * Managed folder names a generated base filters on. A filter naming one of
 * these outside the configured root belongs to a root the records have left.
 */
const RECORD_FOLDER_NAMES = ["Patients", "Episodes", "Tasks", "Procedures"];

/**
 * Whether a base filters on a clinical record folder under a root other than
 * `root` — typically a customised base kept, unchanged, through a folder move.
 * Such a base silently shows no records.
 */
export function baseQueriesOtherRoot(content: string, root: string): boolean {
  for (const match of content.matchAll(/file\.inFolder\("([^"]+)"\)/g)) {
    const folder = match[1] ?? "";
    const name = folder.split("/").pop() ?? "";
    if (!RECORD_FOLDER_NAMES.includes(name)) continue;
    const parent = folder.slice(0, -(name.length + 1));
    // Current output doubles an apostrophe; output up to 0.6.9 did not.
    if (parent !== root && parent.replaceAll("''", "'") !== root) return true;
  }
  return false;
}
