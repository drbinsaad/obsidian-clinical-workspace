/**
 * Wording a clinician reads must match what the app does: the What's new
 * window, the visible text of a recovery notice the guides quote, and the
 * upgrade steps for a customised generated Base.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WHATS_NEW_HIGHLIGHTS } from "../src/main";
import { CLINICAL_FOLDER_MOVE_OPEN_REFUSED_MESSAGE, compactClinicalRecoveryNotice } from "../src/ui/notices";

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("What's new names the ward round's View button instead of a tappable name", () => {
  // A ward-round row's name is plain text; only View opens the patient sheet.
  const ward = WHATS_NEW_HIGHLIGHTS.filter((highlight) => /ward round/i.test(highlight));
  assert.ok(ward.length > 0);
  for (const highlight of ward) {
    assert.doesNotMatch(highlight, /tapping a patient/i);
    assert.match(highlight, /\bView\b/);
  }
});

test("the visible folder-move refusal says what the guides quote", async () => {
  // The guides tell a clinician to look for "Clinical Workspace cannot open
  // yet"; the compact notice on screen must carry those words.
  const quoted = "Clinical Workspace cannot open yet";
  assert.ok(compactClinicalRecoveryNotice(CLINICAL_FOLDER_MOVE_OPEN_REFUSED_MESSAGE).startsWith(quoted));
  for (const doc of ["docs/user-guide.md", "docs/folder-migration.md"]) {
    assert.match((await read(doc)).replace(/\s+/g, " "), new RegExp(`"${quoted}"`), doc);
  }
});

test("upgrade steps for a customised Base say a restart brings the fresh copy", async () => {
  // Generated Bases are written on the first open of a session, so renaming a
  // customised copy and reopening the workspace alone recreated nothing.
  for (const doc of ["CHANGELOG.md", "docs/data-model.md"]) {
    const text = (await read(doc)).replace(/\s+/g, " ");
    assert.doesNotMatch(text, /rename your copy and reopen the workspace/i, doc);
    assert.match(text, /rename your copy[^.]*restart Obsidian/i, doc);
  }
});
