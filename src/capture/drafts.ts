/** Native capture notes are untrusted drafts, never clinical records. */
export const CAPTURE_KINDS = ["patient", "task", "procedure", "or-booking"] as const;
export type CaptureKind = typeof CAPTURE_KINDS[number];
export type CaptureState = "draft" | "processing" | "filed" | "reviewed";
export const CAPTURE_FIELDS = ["mrn", "patient_name", "phone", "case", "task", "task_type", "due_date", "priority", "procedure", "procedure_date", "outcome", "next_action"] as const;
export type CaptureField = typeof CAPTURE_FIELDS[number];
export interface CaptureDraft {
  kind: CaptureKind;
  state: CaptureState;
  attemptId: string;
  result?: string;
  fields: Partial<Record<CaptureField, string>>;
  body: string;
}
const MAX_BYTES = 65536;
const STATES: readonly string[] = ["draft", "processing", "filed", "reviewed"];
const ATTEMPT = /^CAP-[a-f0-9]{20}$/;

function invalid(): never {
  // Never echo untrusted note contents or patient details in diagnostics.
  throw new Error("Invalid capture draft. Check the capture template and quoted fields.");
}

function frontmatter(source: string): RegExpMatchArray {
  if (new TextEncoder().encode(source).length > MAX_BYTES || source.includes("\0")) invalid();
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) invalid();
  return match;
}

/** Deliberately accepts only a flat schema, without YAML aliases or coercion. */
export function parseCaptureDraft(source: string): CaptureDraft {
  const match = frontmatter(source);
  const values = new Map<string, string>();
  const header = match[1] ?? "";
  for (const line of header.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = line.match(/^([a-z_]+):[ \t]*(.*?)[ \t]*$/);
    if (!entry) invalid();
    const key = entry[1] ?? "";
    const raw = entry[2] ?? "";
    if (values.has(key)) invalid();
    if (key === "clinical_capture") {
      if (raw !== "1") invalid();
      values.set(key, raw);
      continue;
    }
    if (!["capture_kind", "capture_state", "capture_attempt", "capture_result", ...CAPTURE_FIELDS].includes(key)) invalid();
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      if ((key === "capture_kind" && (CAPTURE_KINDS as readonly string[]).includes(raw)) || (key === "capture_state" && STATES.includes(raw))) value = raw;
      else invalid();
    }
    if (typeof value !== "string" || value.includes("\0")) invalid();
    values.set(key, value);
  }
  if (values.get("clinical_capture") !== "1") invalid();
  const kind = values.get("capture_kind") ?? "";
  const state = values.get("capture_state") ?? "draft";
  const attemptId = values.get("capture_attempt") ?? "";
  const result = values.get("capture_result");
  if (!(CAPTURE_KINDS as readonly string[]).includes(kind) || !STATES.includes(state)) invalid();
  if ((attemptId && !ATTEMPT.test(attemptId)) || (state !== "draft" && !attemptId) || (state === "draft" && (attemptId || result !== undefined))) invalid();
  if (result !== undefined && result.length > 2048) invalid();
  const fields: CaptureDraft["fields"] = {};
  for (const key of CAPTURE_FIELDS) {
    const value = values.get(key);
    if (value !== undefined) fields[key] = value;
  }
  return { kind: kind as CaptureKind, state: state as CaptureState, attemptId, ...(result !== undefined ? { result } : {}), fields, body: source.slice(match[0].length) };
}

/** Changes only reserved receipt fields; callers must atomically compare claims. */
export function setCaptureState(source: string, state: CaptureState, attemptId?: string, result?: string): string {
  parseCaptureDraft(source);
  const match = frontmatter(source);
  const newline = source.startsWith("---\r\n") ? "\r\n" : "\n";
  let header = match[1] ?? "";
  if (state === "draft") {
    header = header.split(/\r?\n/).filter((line) => !/^capture_(?:attempt|result):/.test(line)).join(newline);
  }
  const updates: Record<string, string> = { capture_state: state };
  if (attemptId !== undefined) updates.capture_attempt = attemptId;
  if (result !== undefined) updates.capture_result = result;
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}: ${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}:[^\\r\\n]*`, "m");
    header = pattern.test(header) ? header.replace(pattern, () => line) : `${header}${newline}${line}`;
  }
  const changed = `---${newline}${header}${newline}---${match[0].endsWith("\n") ? newline : ""}${source.slice(match[0].length)}`;
  parseCaptureDraft(changed);
  return changed;
}

function safeRoot(root: string): string {
  if (!root || root.includes("\\") || hasControlCharacter(root) || root.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid clinical root for capture.");
  return root;
}
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
export function captureInboxPath(root: string): string { return `${safeRoot(root)}/Inbox/Capture`; }
export function captureTemplateFolderPath(root: string): string { return `${safeRoot(root)}/Templates/Capture`; }

/** Direct children only; names are opaque and never interpreted as identity. */
export function isCaptureDraftPath(path: string, root: string): boolean {
  let folder: string;
  try { folder = captureInboxPath(root); } catch { return false; }
  if (!path.startsWith(`${folder}/`)) return false;
  const name = path.slice(folder.length + 1);
  return /^[^/\\]+\.md$/i.test(name) && !hasControlCharacter(name) && name !== ".md";
}

/** Native capture appends text after applying the template; no content macro. */
export function captureTemplates(root: string): Record<string, string> {
  const folder = captureTemplateFolderPath(root);
  return Object.fromEntries(CAPTURE_KINDS.map((kind) => [`${folder}/${kind}.md`, `---\nclinical_capture: 1\ncapture_kind: "${kind}"\n---\n\n`]));
}
