import assert from "node:assert/strict";
import test from "node:test";
import { CAPTURE_KINDS, captureInboxPath, captureTemplateFolderPath, captureTemplates, isCaptureDraftPath, parseCaptureDraft, setCaptureState } from "../src/capture/drafts";

const draft = '---\nclinical_capture: 1\ncapture_kind: "patient"\nmrn: "9000"\nphone: "0500000000"\npatient_name: "Synthetic patient"\n---\n\nCaptured text: keep **all** formatting.\n';
const attempt = "CAP-abcdefabcdefabcdefab";

test("capture parser preserves body and leading zeros without inferring identity", () => {
  const parsed = parseCaptureDraft(draft);
  assert.equal(parsed.kind, "patient");
  assert.equal(parsed.state, "draft");
  assert.deepEqual(parsed.fields, { mrn: "9000", phone: "0500000000", patient_name: "Synthetic patient" });
  assert.equal(parsed.body, "\nCaptured text: keep **all** formatting.\n");
});

test("capture schema rejects unsupported, ambiguous and record-shaped input", () => {
  for (const source of [
    draft.replace("clinical_capture: 1", "clinical_capture: 2"),
    draft.replace('"patient"', '"episode"'),
    draft.replace('mrn: "9000"', "mrn: 9000"),
    draft.replace('phone: "0500000000"', "phone: &phone 0500000000"),
    draft.replace('mrn: "9000"', 'mrn: "9000"\nmrn: "9000"'),
    ...["entity", "id", "patient_id", "episode_id", "forceNewPatient", "__proto__", "unknown"].map((key) => draft.replace("---\n\n", `${key}: "9000"\n---\n\n`)),
    draft.replace('mrn: "9000"', "mrn: |\n  9000"),
    draft.replace("---\nclinical", "clinical"),
    draft.replace("---\n\n", ""),
    draft.replace("clinical_capture: 1", "clinical_capture: 1\ncapture_state: automatic"),
    `${draft}${"x".repeat(65536)}`,
    `${draft}${"🙂".repeat(17000)}`
  ]) assert.throws(() => parseCaptureDraft(source));
});

test("capture state changes preserve content and reject invalid input", () => {
  for (const state of ["processing", "filed", "reviewed"] as const) {
    const changed = setCaptureState(draft, state, attempt);
    assert.equal(parseCaptureDraft(changed).state, state);
    assert.equal(parseCaptureDraft(changed).body, parseCaptureDraft(draft).body);
    assert.equal(changed.replace(`capture_state: "${state}"\n`, "").replace(`capture_attempt: "${attempt}"\n`, ""), draft);
    assert.equal(setCaptureState(changed, state), changed);
  }
  const crlf = draft.replaceAll("\n", "\r\n");
  assert.equal(setCaptureState(crlf, "processing", attempt).replace('capture_state: "processing"\r\n', "").replace(`capture_attempt: "${attempt}"\r\n`, ""), crlf);
  assert.throws(() => setCaptureState("plain text", "processing"));
  assert.throws(() => setCaptureState(draft, "processing"));
  assert.throws(() => setCaptureState(draft, "processing", "bad-attempt"));
  const filed = setCaptureState(draft, "filed", attempt, "TASK-abcdefabcdefabcdefab");
  assert.equal(parseCaptureDraft(filed).attemptId, attempt);
  assert.equal(parseCaptureDraft(filed).result, "TASK-abcdefabcdefabcdefab");
  const rolledBack = parseCaptureDraft(setCaptureState(filed, "draft"));
  assert.equal(rolledBack.state, "draft");
  assert.equal(rolledBack.attemptId, "");
  assert.equal(rolledBack.result, undefined);
  assert.equal(rolledBack.body, parseCaptureDraft(draft).body);
});

test("capture inbox path scope is exact and does not parse filenames", () => {
  assert.equal(captureInboxPath("Clinical"), "Clinical/Inbox/Capture");
  assert.equal(captureTemplateFolderPath("Clinical"), "Clinical/Templates/Capture");
  assert.equal(isCaptureDraftPath("Clinical/Inbox/Capture/9000.md", "Clinical"), true);
  for (const path of ["Clinical/Inbox/Capture-other/a.md", "Other/Inbox/Capture/a.md", "Clinical/Patients/a.md", "Clinical/Inbox/Capture/nested/a.md", "Clinical/Inbox/Capture/../a.md", "Clinical/Inbox/Capture/a.json", "Clinical/Inbox/Capture//a.md", "/Clinical/Inbox/Capture/a.md", "Clinical\\Inbox\\Capture\\a.md"]) assert.equal(isCaptureDraftPath(path, "Clinical"), false);
  for (const root of ["", "/", "../Clinical", "Clinical/../Other", "Clinical/", "Clinical//Notes", "Clinical\\Notes"]) assert.throws(() => captureInboxPath(root));
});

test("four static native templates stay isolated and accept native appended content", () => {
  const templates = captureTemplates("Clinical");
  assert.equal(Object.keys(templates).length, 4);
  for (const kind of CAPTURE_KINDS) {
    const source = templates[`Clinical/Templates/Capture/${kind}.md`];
    assert.ok(source);
    const parsed = parseCaptureDraft(`${source}Synthetic captured text\n`);
    assert.equal(parsed.kind, kind);
    assert.equal(parsed.state, "draft");
    assert.ok(parsed.body.includes("Synthetic captured text\n"));
    assert.ok(!source.includes("{{content}}"));
    assert.ok(!source.includes("entity:"));
  }
});
