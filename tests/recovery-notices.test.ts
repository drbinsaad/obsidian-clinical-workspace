import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE,
  CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE,
  CLINICAL_RECOVERY_NOTICE_CLASS,
  CLINICAL_ROOT_UNAVAILABLE_MESSAGE,
  CLINICAL_SYNC_GROWTH_PENDING_MESSAGE,
  compactClinicalRecoveryNotice,
  hideClinicalRecoveryNotice,
  isClinicalRecoveryMessage,
  showClinicalNotice,
  showClinicalRecoveryNotice
} from "../src/ui/notices";
import { Notice } from "./support/obsidian-stub";

beforeEach(() => {
  hideClinicalRecoveryNotice();
  Notice.history.length = 0;
});
afterEach(() => hideClinicalRecoveryNotice());

test("duplicate background recovery notices do not replace or restart the visible notice", () => {
  const first = showClinicalRecoveryNotice(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE, 12000, {
    background: true
  });
  assert.ok(first);
  const shown = Notice.history[0]!;
  assert.equal(shown.duration, 5000);
  assert.equal(shown.hidden, false);
  for (let index = 0; index < 20; index += 1) {
    assert.equal(showClinicalRecoveryNotice(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE, 12000, {
      background: true
    }), null);
  }
  assert.equal(Notice.history.length, 1);
  assert.equal(shown.hidden, false, "duplicates do not hide and replace the original");
});

test("native dismissal or expiry keeps background recovery guidance suppressed", () => {
  const first = showClinicalRecoveryNotice(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE, undefined, {
    background: true
  });
  assert.ok(first);
  // Native Obsidian calls Notice.hide for both tap dismissal and auto-expiry.
  first.hide();
  assert.equal(Notice.history[0]!.hidden, true);
  assert.equal(showClinicalRecoveryNotice(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE, undefined, {
    background: true
  }), null);
  assert.equal(Notice.history.length, 1);
});

test("ending a recovery episode allows the same background reason to appear again", () => {
  showClinicalRecoveryNotice(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE, undefined, { background: true });
  hideClinicalRecoveryNotice();
  const next = showClinicalRecoveryNotice(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE, undefined, {
    background: true
  });
  assert.ok(next);
  assert.equal(Notice.history.length, 2);
  assert.equal(Notice.history[0]!.hidden, true);
  assert.equal(Notice.history[1]!.hidden, false);
});

test("explicit user actions can repeat a notice without resetting background suppression", () => {
  showClinicalRecoveryNotice(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE, undefined, { background: true });
  const explicit = showClinicalRecoveryNotice(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE, 7000);
  assert.ok(explicit);
  const repeated = showClinicalNotice(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE, 7000);
  assert.ok(repeated);
  assert.equal(Notice.history.length, 3);
  assert.equal(Notice.history[0]!.hidden, true);
  assert.equal(Notice.history[1]!.hidden, true);
  assert.equal(Notice.history[2]!.duration, 7000);
  assert.equal(Notice.history[2]!.hidden, false);
  assert.equal(showClinicalRecoveryNotice(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE, undefined, {
    background: true
  }), null);
  assert.equal(Notice.history.length, 3);
});

test("a changed background reason appears once without reviving previous reasons", () => {
  showClinicalRecoveryNotice(CLINICAL_ROOT_UNAVAILABLE_MESSAGE, undefined, { background: true });
  const changed = showClinicalRecoveryNotice(CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE, undefined, {
    background: true
  });
  assert.ok(changed);
  assert.equal(Notice.history.length, 2);
  assert.equal(Notice.history[0]!.hidden, true);
  assert.equal(showClinicalRecoveryNotice(CLINICAL_ROOT_UNAVAILABLE_MESSAGE, undefined, {
    background: true
  }), null);
  assert.equal(Notice.history[1]!.hidden, false);
});

test("background recovery guidance always has a bounded positive lifetime", () => {
  for (const requested of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 60000]) {
    hideClinicalRecoveryNotice();
    showClinicalRecoveryNotice(CLINICAL_ROOT_UNAVAILABLE_MESSAGE, requested, { background: true });
    assert.equal(Notice.history.at(-1)!.duration, 5000);
  }
  hideClinicalRecoveryNotice();
  showClinicalRecoveryNotice(CLINICAL_ROOT_UNAVAILABLE_MESSAGE, 2000, { background: true });
  assert.equal(Notice.history.at(-1)!.duration, 2000);
});

test("confirmation-required guidance states manual review and retains the full accessible explanation", () => {
  assert.equal(isClinicalRecoveryMessage(CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE), true);
  showClinicalNotice(CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE, 7000);
  const shown = Notice.history[0]!;
  assert.equal(shown.classes.has(CLINICAL_RECOVERY_NOTICE_CLASS), true);
  assert.equal(shown.attributes.get("aria-label"), CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE);
  assert.equal(shown.attributes.get("title"), CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE);
  assert.match(shown.message, /needs baseline confirmation/);
  assert.match(shown.message, /inspect record counts before/);
  assert.match(CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE, /does not clear this review/);
  assert.match(CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE, /type ADOPT only if/);
  for (const message of [
    CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE,
    CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE,
    CLINICAL_SYNC_GROWTH_PENDING_MESSAGE
  ]) {
    assert.doesNotMatch(message, /reopens automatically|resume automatically|resumes automatically/);
    assert.doesNotMatch(compactClinicalRecoveryNotice(message), /reopens once|resumes automatically/);
    assert.ok(compactClinicalRecoveryNotice(message).length < 165);
  }
});
