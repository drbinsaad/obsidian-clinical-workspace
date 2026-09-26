import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("native capture guide documents setup, reviewed conversion and uncertainty limits", async () => {
  const guide = await readFile(new URL("../docs/native-capture.md", import.meta.url), "utf8");
  for (const required of ["Set up native capture", "Review capture inbox", "Inbox/Capture", "Templates/Capture", "patient.md", "task.md", "procedure.md", "or-booking.md", "YYYYMMDDHHmmss", "clinical_capture: 1", "capture_kind:", "processing", "filed", "I checked the records; mark reviewed", "iOS 26", "1.14", "Catalyst", "physical iPhone", "exactly-once", "one device", "{{content}}"]) assert.ok(guide.includes(required), required);
  for (const path of ["../README.md", "../docs/quick-entry.md", "../docs/user-guide.md"]) {
    assert.match(await readFile(new URL(path, import.meta.url), "utf8"), /native-capture\.md/);
  }
  assert.match(await readFile(new URL("../docs/quick-entry.md", import.meta.url), "utf8"), /obsidian:\/\/clinical-workspace-book-or/);
});
