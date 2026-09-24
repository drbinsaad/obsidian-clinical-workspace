/**
 * Enum values the logbook exporter accepts. This plain-JavaScript tool cannot
 * import src/domain/types.ts, so the values are repeated here and a test
 * (tests/export-logbook.test.ts) fails the build when the two lists drift.
 * Kept apart from export-logbook.mjs because importing that file runs an
 * export.
 */
export const CARE_SETTINGS = new Set(["inpatient", "outpatient"]);
export const PATHWAYS = new Set([
  "assessment",
  "or-booking",
  "opd-follow-up",
  "result-review",
  "consultation",
  "discharge-ready"
]);
export const PRIORITIES = new Set(["routine", "urgent", "emergency"]);
export const EPISODE_STATUSES = new Set([
  "active",
  "on-hold",
  "ready-to-close",
  "archived",
  "cancelled",
  "entered-in-error"
]);
export const PROCEDURE_STATUSES = new Set(["completed", "cancelled", "entered-in-error"]);
