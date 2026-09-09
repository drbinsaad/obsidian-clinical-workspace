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
  "Clinical Workspace is read-only because synchronized recovery information conflicts with the previously trusted baseline. After Sync finishes, run “Confirm current records as the recovery baseline” and review the exact record counts before typing ADOPT.";

export const CLINICAL_RECOVERY_NOTICE_CLASS = "clinical-workspace-recovery-notice";

let activeRecoveryNotice: Notice | null = null;

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
    return "Clinical Workspace is read-only because synced recovery data needs review. After Sync, confirm the current records as a new baseline.";
  }
  return message;
}

export function isClinicalRecoveryMessage(message: string): boolean {
  return message === CLINICAL_ROOT_UNAVAILABLE_MESSAGE ||
    message === CLINICAL_WRITES_BLOCKED_MESSAGE ||
    message === CLINICAL_INITIALIZATION_REQUIRED_MESSAGE ||
    message === CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE ||
    message === CLINICAL_INITIALIZATION_CHANGED_MESSAGE ||
    message === CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE;
}

/**
 * One shared presenter covers the plugin entry point, open forms, workspace
 * actions, and settings. Keeping it module-scoped prevents those surfaces from
 * stacking competing recovery notices during a burst of Sync events.
 */
export function showClinicalRecoveryNotice(message: string, duration = 12000): Notice {
  hideClinicalRecoveryNotice();
  const notice = new Notice(compactClinicalRecoveryNotice(message), duration);
  const noticeEl = notice.messageEl.closest<HTMLElement>(".notice") ?? notice.messageEl;
  noticeEl.addClass(CLINICAL_RECOVERY_NOTICE_CLASS);
  // Keep the complete safety explanation available to assistive technology
  // and desktop hover while the visible copy stays phone-sized.
  noticeEl.setAttribute("aria-label", message);
  noticeEl.setAttribute("title", message);
  activeRecoveryNotice = notice;
  return notice;
}

export function hideClinicalRecoveryNotice(): void {
  activeRecoveryNotice?.hide();
  activeRecoveryNotice = null;
}

/** Route arbitrary action errors through recovery styling when applicable. */
export function showClinicalNotice(message: string, duration?: number): Notice {
  if (isClinicalRecoveryMessage(message)) {
    return showClinicalRecoveryNotice(message, duration);
  }
  return new Notice(message, duration);
}
