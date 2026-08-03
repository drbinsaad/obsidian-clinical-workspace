# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- Added `SECURITY.md` with a threat model and private reporting instructions.
- `.gitignore` now excludes AppleDouble sidecars and blocks any vault,
  `.obsidian` directory, or `.base` file from entering the repository.

## [0.1.0] - 2026-08-03

Initial internal build. Not released.
