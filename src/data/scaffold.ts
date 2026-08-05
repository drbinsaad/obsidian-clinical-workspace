import { baseFiles, homeNote } from "./bases";
import { clinicalFolder } from "./paths";

/**
 * Whether a generated file is still exactly as this plugin wrote it.
 *
 * Both `ensureStructure` and the folder migration regenerate database views and
 * the home note. Either would happily overwrite work the user has done in them,
 * so both ask here first — and the answer is a byte comparison, not a
 * resemblance test. A heuristic cannot tell one line of the user's prose from
 * one line of ours, and guessing wrong destroys their writing.
 */
export function isUntouchedBase(path: string, content: string): boolean {
  const referenced = /file\.inFolder\("([^"]+)"\)/.exec(content)?.[1];
  if (!referenced) return false;
  const priorRoot = referenced.replace(/\/[^/]+$/, "");
  const name = path.split("/").pop();
  if (!name) return false;
  const generated = baseFiles(priorRoot)[`${clinicalFolder("bases", priorRoot)}/${name}`];
  return generated !== undefined && generated.trim() === content.trim();
}

export function isUntouchedHome(content: string): boolean {
  const referenced = /!\[\[(.+?)\/Bases\/Patients\.base/.exec(content)?.[1];
  if (!referenced) return false;
  if (homeNote(referenced).trim() === content.trim()) return true;
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
