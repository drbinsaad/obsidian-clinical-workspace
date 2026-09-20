import { Notice } from "obsidian";
import { CLINICAL_WRITES_BLOCKED_MESSAGE } from "../data/repository";

export const CLINICAL_ROOT_UNAVAILABLE_MESSAGE =
  "Clinical Workspace is temporarily read-only because the configured folder is unavailable. After Sync finishes or the folder is restored, run “Retry pending folder move recovery” from the Command Palette.";
export const CLINICAL_INITIALIZATION_REQUIRED_MESSAGE =
  "Clinical Workspace needs a trusted baseline. After Sync finishes, use “Initialize new workspace” to adopt the current records or initialize a genuinely new workspace.";
export const CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE =
  "Clinical Workspace could not save its initialization state. No workspace folders were created; the plugin remains read-only.";
export const CLINICAL_INITIALIZATION_CHANGED_MESSAGE =
  "Clinical Workspace state changed while the confirmation was open. Initialization was cancelled; wait for Sync to finish, then open the workspace again.";
export const CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE =
  "Clinical Workspace is read-only because synchronized recovery information conflicts with the previously trusted baseline. After Sync finishes, run “Retry pending folder move recovery”. Some conflicts require explicit review even when the records are present. If review is still required, run “Confirm current records as the recovery baseline” and inspect the exact record counts before typing ADOPT.";
export const CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE =
  "Clinical Workspace is read-only because synchronized recovery information conflicts with the previously trusted baseline. Manual baseline confirmation is required; waiting for Sync or retrying recovery does not clear this review. After Sync finishes, run “Confirm current records as the recovery baseline”, inspect the exact record counts, and type ADOPT only if the complete records match the baseline you intend to trust.";
export const CLINICAL_SYNC_GROWTH_PENDING_MESSAGE =
  "Clinical Workspace is temporarily read-only while newly synchronized records are verified against this device’s trusted baseline. Keep Obsidian open until Sync finishes. Writes can resume after verification; if review is still required, the workspace remains read-only. After Sync, run “Retry pending folder move recovery” from the Command Palette if needed.";

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
    return "Clinical Workspace is read-only: its folder is unavailable. After Sync or restore, run “Retry pending folder move recovery”.";
  }
  if (message === CLINICAL_WRITES_BLOCKED_MESSAGE) {
    return "Clinical Workspace is read-only while a folder move syncs. After Sync, run “Retry pending folder move recovery”.";
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
    return "Clinical Workspace is read-only. After Sync, retry recovery; if review is still required, inspect the baseline before confirming.";
  }
  if (message === CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE) {
    return "Clinical Workspace needs baseline confirmation. After Sync, inspect record counts before using “Confirm current records as the recovery baseline”.";
  }
  if (message === CLINICAL_SYNC_GROWTH_PENDING_MESSAGE) {
    return "Clinical Workspace is verifying synced records. After Sync, run “Retry pending folder move recovery” if it stays read-only.";
  }
  return message;
}

export function isClinicalRecoveryMessage(message: string): boolean {
  return message === CLINICAL_ROOT_UNAVAILABLE_MESSAGE ||
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
