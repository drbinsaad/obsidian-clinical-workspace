# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-08-04

Adds plugin settings and a configurable clinical folder, then fixes what an
adversarial review found in that new code and in the existing workflow.

### Added

- **Settings tab.** Clinician name (recorded as the actor on every audit note),
  defaults for care setting, pathway and priority, an optional typed
  confirmation before discharge, an optional integrity check when the workspace
  first opens, and a configurable refresh delay.
- **Configurable clinical folder**, applied by an explicit migration with a live
  preview of what will move rather than taking effect on its own. Inter-record
  links are verified afterwards; a rewrite that failed is reported rather than
  left to break the caseload silently.
- Task cancellation. An open task can be closed without being completed, so an
  episode can always be discharged.
- Patient identity editor, for correcting a recorded MRN, name, or phone.
- Patient merge, which re-points every episode, task and procedure at the
  surviving record and retires the source as `entered-in-error` without
  deleting it.
- Duplicate-patient prompt when creating an MRN-less patient whose name matches
  an existing record.
- `Episodes.base`, and a `Patients.base` that queries patient records. Existing
  vaults with the old, misnamed base are repaired on next open.
- Integrity results are shown in a modal with a link to each affected record.
- Integrity checks for orphan patients, unidentified patients, missing episode
  case, broken merge links, and unrecognised enum values.
- A "No date set" section on Today, so undated open tasks are not invisible.
- Keyboard navigation for the tab bar, with a matching `tabpanel` and roving
  `tabindex`.

### Changed

- Schema version 2. Episodes record `pathway_before_archive` and
  `status_before_archive`; patients record `merged_into`; tasks record
  `cancelled_at` and `cancel_reason`. Version 1 records load unchanged.
- Development tooling, including the synthetic data generator, is compiled out
  of release builds. Enable it with `CLINICAL_DEV_TOOLS=1 npm run build`.
- Folders and database views are created when the workspace is first opened
  rather than when the plugin loads.
- Integrity messages no longer contain patient identifiers and are never
  written to the developer console.

### Fixed

- **An unreadable note no longer disappears.** Frontmatter that failed to parse
  dropped the record from every list, so a task damaged by a sync conflict
  became invisible and its episode could be discharged with the work still
  open. Discharge now refuses, and the integrity check reports the note.
- **Changing an episode's next action cancels the task it replaces** instead of
  leaving both open. When the new action matches an already-closed task, that is
  reported rather than silently dropped.
- Archiving an already-archived episode no longer overwrites the pathway and
  outcome that restore depends on.
- A procedure that failed part-way is retryable; the retry finishes the workflow
  rather than reporting success and stopping.
- An episode is only marked ready to close when no other task is open.
- Generated database views and the home note are replaced only when they are
  byte-identical to what the plugin would have written, so user edits survive.
- Settings persist on a debounce rather than on every keystroke, and a blank
  field is treated as mid-edit rather than as zero.
- Renaming a clinical note no longer detaches it. Records resolve by their
  stable id, so a renamed task can still be completed and its episode
  discharged; previously both failed permanently and there was no way to
  recover from within the plugin.
- Restoring an archived episode returns it to the pathway it held before
  archiving and keeps the discharge outcome. Both were previously destroyed.
- Saving the episode update sheet no longer recreates a task that has already
  been completed or cancelled.
- Completing a procedure no longer forces the episode to `outpatient`, which
  removed post-operative inpatients from the Inpatients list.
- Duplicate protection for tasks and procedures now holds across concurrent
  submissions, not only sequential ones.
- A malformed or hand-edited note no longer takes down the entire workspace;
  it is reported by the integrity check instead.
- MRNs that differ only by leading zeroes resolve to one patient rather than
  two separate charts. The value as typed is still what is displayed.
- Audit-note failures no longer fail the clinical action that preceded them.
- Editing an episode no longer silently reactivates an `on-hold` episode.
- Patient archive and reactivation are now recorded in the audit trail.
- A vault change arriving during a refresh is queued rather than dropped.
- The floating action button is anchored to the view instead of the viewport,
  so it no longer floats over unrelated panes on desktop.
- Badge and tab contrast raised to meet WCAG AA.

### Security

- Clinical folder paths reject `.` and `..` segments anywhere in the path, not
  just at the start, so a migration target cannot resolve outside the vault.
- Stored settings are validated on load; an invalid value falls back to its
  default rather than reaching the workflow.
- The console-identifier guard previously scanned four files that call `console`
  zero times, so it asserted nothing while appearing to protect the strongest
  privacy claim. It now enumerates the source tree and fails if it scans nothing.
- Added `SECURITY.md` with a threat model and private reporting instructions.
- `.gitignore` now excludes AppleDouble sidecars and blocks any vault,
  `.obsidian` directory, or `.base` file from entering the repository.

### Known limitations

- `mergePatients` is not atomic. Obsidian offers no multi-file transaction, so a
  real fix needs journal-and-resume; the integrity check detects the artefacts a
  partial merge leaves behind.
- Nothing has been tested on iOS.

## [0.1.0] - 2026-08-03

Initial internal build. Not released.
