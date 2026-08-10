/**
 * Quick Entry actions deliberately carry no record context. A task or
 * procedure action always asks the user to choose an episode inside the
 * plugin, where the clinical context is visible and can be confirmed.
 */
export const QUICK_ENTRY_ACTIONS = [
  "hub",
  "new-patient-episode",
  "add-task-follow-up",
  "record-procedure",
  "today"
] as const;

export type QuickEntryAction = (typeof QUICK_ENTRY_ACTIONS)[number];

export const QUICK_ENTRY_COMMAND_IDS: Readonly<Record<QuickEntryAction, string>> = {
  hub: "open-quick-entry",
  "new-patient-episode": "add-patient-episode",
  "add-task-follow-up": "add-task-follow-up",
  "record-procedure": "record-procedure",
  today: "open-today-pending-work"
};

/**
 * Each URI has its own fixed action instead of accepting a mode, patient,
 * record, or note parameter. This makes the URLs safe to place in Apple
 * Shortcuts without putting clinical context in shortcut history or logs.
 */
export const QUICK_ENTRY_PROTOCOL_ACTIONS: Readonly<Record<QuickEntryAction, string>> = {
  hub: "clinical-workspace-quick-entry",
  "new-patient-episode": "clinical-workspace-new-patient-episode",
  "add-task-follow-up": "clinical-workspace-add-task-follow-up",
  "record-procedure": "clinical-workspace-record-procedure",
  today: "clinical-workspace-today"
};

/**
 * Obsidian supplies the registered action in `params.action`. No query
 * parameter is accepted — including otherwise-benign ones — so a copied URI
 * cannot silently smuggle an identifier, note path, or free text into a form.
 */
export function isSafeQuickEntryProtocolInvocation(
  expectedAction: string,
  params: Readonly<Record<string, string>>
): boolean {
  const keys = Object.keys(params);
  return keys.length === 1 && keys[0] === "action" && params.action === expectedAction;
}
