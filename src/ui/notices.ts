import { Notice } from "obsidian";
import { CLINICAL_WRITES_BLOCKED_MESSAGE } from "../data/repository";

/*
 * Every message below reaches Notices, the workspace banner and thrown errors,
 * so none may carry a record id, path, folder name or patient text. A message
 * that names a command must name one the command palette offers in that state.
 */
export const CLINICAL_ROOT_UNAVAILABLE_MESSAGE =
  "Clinical Workspace is temporarily read-only because the configured folder is unavailable. After Sync finishes or the folder is restored, run “Recheck records and unlock editing” from the Command Palette.";
export const CLINICAL_RECORD_CHANGED_MESSAGE =
  "Clinical Workspace is temporarily read-only because a record note was added, edited, deleted or moved outside Clinical Workspace, for example by Sync. Editing is paused while the records are rechecked. If it stays paused, run “Recheck records and unlock editing” from the Command Palette.";
export const CLINICAL_RECORDS_RECHECK_MESSAGE =
  "Clinical Workspace is temporarily read-only while it rechecks its record notes against the records this device trusts. After Sync finishes, run “Recheck records and unlock editing” from the Command Palette if it stays read-only.";
export const CLINICAL_SETTINGS_APPLYING_MESSAGE =
  "Clinical Workspace is temporarily read-only while it applies changes from your other device. Try again in a few seconds.";
export const CLINICAL_BASELINE_CONFIRMING_MESSAGE =
  "Clinical Workspace is temporarily read-only while it confirms the current records as the recovery baseline. Try again in a few seconds.";
export const CLINICAL_FOLDER_MOVE_OPEN_REFUSED_MESSAGE =
  "Clinical Workspace cannot open yet: a synced folder move is still being reconciled, so the records it would show may be incomplete. After Sync finishes, run “Recheck records and unlock editing” from the Command Palette.";
export const CLINICAL_UNRECOGNIZED_RECORD_NOTES_MESSAGE =
  "The managed record folders contain Markdown that is not a valid Clinical Workspace record. Use “Run clinical data integrity check” from the Command Palette to find those notes, move or repair them, then try again. The recovery baseline was not changed.";
export const CLINICAL_RECORDS_UNLOCKED_MESSAGE =
  "Clinical Workspace rechecked its records. Editing is available again.";
export const CLINICAL_INITIALIZATION_REQUIRED_MESSAGE =
  "Clinical Workspace needs a trusted baseline. After Sync finishes, use “Initialize new workspace” to adopt the current records or initialize a genuinely new workspace.";
export const CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE =
  "Clinical Workspace could not save its initialization state. No workspace folders were created; the plugin remains read-only.";
export const CLINICAL_INITIALIZATION_CHANGED_MESSAGE =
  "Clinical Workspace state changed while the confirmation was open. Initialization was cancelled; wait for Sync to finish, then open the workspace again.";
export const CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE =
  "Clinical Workspace is read-only because synchronized recovery information conflicts with the previously trusted baseline. After Sync finishes, run “Recheck records and unlock editing”. Some conflicts require explicit review even when the records are present. If review is still required, run “Confirm current records as the recovery baseline” and inspect the exact record counts before typing ADOPT.";
export const CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE =
  "Clinical Workspace is read-only because synchronized recovery information conflicts with the previously trusted baseline. Manual baseline confirmation is required; waiting for Sync or retrying recovery does not clear this review. After Sync finishes, run “Confirm current records as the recovery baseline”, inspect the exact record counts, and type ADOPT only if the complete records match the baseline you intend to trust.";
export const CLINICAL_SYNC_GROWTH_PENDING_MESSAGE =
  "Clinical Workspace is temporarily read-only while newly synchronized records are verified against this device’s trusted baseline. Keep Obsidian open until Sync finishes. Writes can resume after verification; if review is still required, the workspace remains read-only. After Sync, run “Recheck records and unlock editing” from the Command Palette if needed.";

export const CLINICAL_RECOVERY_NOTICE_CLASS = "clinical-workspace-recovery-notice";

let activeRecoveryNotice: Notice | null = null;
const presentedRecoveryMessages = new Set<string>();
const BACKGROUND_RECOVERY_NOTICE_DURATION = 5000;

export interface ClinicalRecoveryNoticeOptions {
  /** Automatic vault/Sync work should not repeatedly interrupt another note. */
  background?: boolean;
}

/** Keep recovery Notices actionable without letting them obscure a phone viewport. */
export function compactClinicalRecoveryNotice(message: string): string {
  if (message === CLINICAL_ROOT_UNAVAILABLE_MESSAGE) {
    return "Clinical Workspace is read-only: its folder is unavailable. After Sync or restore, run “Recheck records and unlock editing”.";
  }
  if (message === CLINICAL_RECORD_CHANGED_MESSAGE) {
    return "A record note changed outside Clinical Workspace, so editing is paused while records are rechecked. If it stays paused, run “Recheck records and unlock editing”.";
  }
  if (message === CLINICAL_RECORDS_RECHECK_MESSAGE) {
    return "Clinical Workspace is read-only while it rechecks records. After Sync, run “Recheck records and unlock editing” if needed.";
  }
  if (message === CLINICAL_SETTINGS_APPLYING_MESSAGE) {
    return "Clinical Workspace is applying changes from your other device. Try again in a few seconds.";
  }
  if (message === CLINICAL_BASELINE_CONFIRMING_MESSAGE) {
    return "Clinical Workspace is confirming the current records. Try again in a few seconds.";
  }
  if (message === CLINICAL_FOLDER_MOVE_OPEN_REFUSED_MESSAGE) {
    return "Records may be incomplete while a folder move syncs. After Sync, run “Recheck records and unlock editing”.";
  }
  if (message === CLINICAL_UNRECOGNIZED_RECORD_NOTES_MESSAGE) {
    return "A record folder holds a note that is not a valid Clinical Workspace record. Use “Run clinical data integrity check” to find it.";
  }
  if (message === CLINICAL_WRITES_BLOCKED_MESSAGE) {
    return "Clinical Workspace is read-only while a folder move syncs. After Sync, run “Recheck records and unlock editing”.";
  }
  if (message === CLINICAL_INITIALIZATION_REQUIRED_MESSAGE) {
    return "Clinical Workspace is read-only until its records are trusted. After Sync, run “Initialize new workspace”.";
  }
  if (message === CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE) {
    return "Clinical Workspace stays read-only because its safety state could not be saved. No folders were created.";
  }
  if (message === CLINICAL_INITIALIZATION_CHANGED_MESSAGE) {
    return "Clinical Workspace changed during confirmation. Wait for Sync, then open the workspace again.";
  }
  if (message === CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE) {
    return "Clinical Workspace is read-only. After Sync, run “Recheck records and unlock editing”; if review is still required, inspect record counts before confirming.";
  }
  if (message === CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE) {
    return "Clinical Workspace needs baseline confirmation. After Sync, inspect record counts before using “Confirm current records as the recovery baseline”.";
  }
  if (message === CLINICAL_SYNC_GROWTH_PENDING_MESSAGE) {
    return "Clinical Workspace is verifying synced records. After Sync, run “Recheck records and unlock editing” if it stays read-only.";
  }
  return message;
}

export function isClinicalRecoveryMessage(message: string): boolean {
  return message === CLINICAL_ROOT_UNAVAILABLE_MESSAGE ||
    message === CLINICAL_RECORD_CHANGED_MESSAGE ||
    message === CLINICAL_RECORDS_RECHECK_MESSAGE ||
    message === CLINICAL_SETTINGS_APPLYING_MESSAGE ||
    message === CLINICAL_BASELINE_CONFIRMING_MESSAGE ||
    message === CLINICAL_FOLDER_MOVE_OPEN_REFUSED_MESSAGE ||
    message === CLINICAL_UNRECOGNIZED_RECORD_NOTES_MESSAGE ||
    message === CLINICAL_WRITES_BLOCKED_MESSAGE ||
    message === CLINICAL_INITIALIZATION_REQUIRED_MESSAGE ||
    message === CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE ||
    message === CLINICAL_INITIALIZATION_CHANGED_MESSAGE ||
    message === CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE ||
    message === CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE ||
    message === CLINICAL_SYNC_GROWTH_PENDING_MESSAGE;
}

/**
 * One shared presenter covers the plugin entry point, open forms, workspace
 * actions, and settings. Keeping it module-scoped prevents those surfaces from
 * stacking competing recovery notices during a burst of Sync events.
 */
export function showClinicalRecoveryNotice(message: string, duration?: number): Notice;
export function showClinicalRecoveryNotice(
  message: string,
  duration: number | undefined,
  options: ClinicalRecoveryNoticeOptions
): Notice | null;
export function showClinicalRecoveryNotice(
  message: string,
  duration = 12000,
  options: ClinicalRecoveryNoticeOptions = {}
): Notice | null {
  if (options.background && presentedRecoveryMessages.has(message)) return null;
  // Replacing a notice must not reset the recovery episode. Remember messages
  // even after native tap dismissal or expiry, until recovery explicitly ends.
  activeRecoveryNotice?.hide();
  const visibleDuration = options.background
    ? Math.min(
      Number.isFinite(duration) && duration > 0 ? duration : BACKGROUND_RECOVERY_NOTICE_DURATION,
      BACKGROUND_RECOVERY_NOTICE_DURATION
    )
    : duration;
  const notice = new Notice(compactClinicalRecoveryNotice(message), visibleDuration);
  const noticeEl = notice.messageEl.closest<HTMLElement>(".notice") ?? notice.messageEl;
  noticeEl.addClass(CLINICAL_RECOVERY_NOTICE_CLASS);
  // Keep the complete safety explanation available to assistive technology
  // and desktop hover while the visible copy stays phone-sized.
  noticeEl.setAttribute("aria-label", message);
  noticeEl.setAttribute("title", message);
  presentedRecoveryMessages.add(message);
  activeRecoveryNotice = notice;
  return notice;
}

export function hideClinicalRecoveryNotice(): void {
  activeRecoveryNotice?.hide();
  activeRecoveryNotice = null;
  presentedRecoveryMessages.clear();
}

/** Route arbitrary action errors through recovery styling when applicable. */
export function showClinicalNotice(message: string, duration?: number): Notice {
  if (isClinicalRecoveryMessage(message)) {
    return showClinicalRecoveryNotice(message, duration);
  }
  return new Notice(message, duration);
}
