# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.3.4] - 2026-08-07

Independent-review remediation release.

### Fixed

- A failed root-folder rename now restores the original active folder and keeps
  its recovery marker through unrelated settings writes until reconciliation.
- Concurrent identical episode submissions are serialised, and integrity now
  reports duplicate active episodes.
- Task and procedure duplicate detection is episode-scoped and verifies the
  complete clinical tuple instead of trusting a 32-bit hash match.
- Unreadable task notes block only their attributed episode; notes that cannot
  be attributed still fail closed and report their repair path.
- Correcting patient identity re-points the patient label on every linked
  episode, task and procedure.
- Date-only values derived from `Date` objects preserve the local calendar day.
- Pending text settings are flushed when the settings pane closes, and settings
  synced from another device are applied without restarting Obsidian.
- Wikilink aliases reject link-control characters, bidirectional controls are
  stripped, and Arabic-Indic MRN/phone digits are normalized to ASCII.
- Completing a hand-edited task cannot reopen an archived, cancelled or
  entered-in-error episode.

### Added

- Patient merges require typed confirmation, reject an already-merged target,
  retain a retryable in-progress marker, and surface interrupted merges through
  the integrity check.
- Regression coverage for the independent review findings, including the real
  plugin migration method and external-settings hook.
- Linting on every pull request, a refresh debounce maximum wait, cached vault
  reads, and a 44-pixel mobile refresh target.
- iPhone manual-install and data-preserving uninstall documentation.

### Security

- Frontmatter coercion now uses a null-prototype object and ignores prototype-
  mutating keys.
- The undocumented internal core-plugin probe was removed.

## [0.3.3] - 2026-08-07

### Changed

- Replaced the direct `js-yaml` development dependency with the maintained
  `yaml` package recommended by the Obsidian Community source-code review.
- Preserved Obsidian-like core-schema parsing and stringification in the test
  harness, including quoted identifiers with leading zeroes.

## [0.3.2] - 2026-08-07

### Security

- Release assets now receive GitHub build-provenance attestations before they
  are attached to the release, allowing Community reviewers and users to verify
  that the published files were produced by this repository's workflow.

## [0.3.1] - 2026-08-07

Community-review readiness and privacy-scope hardening.

### Added

- Obsidian's declarative settings API, including settings-search metadata for
  identity, workflow defaults, safety, storage and privacy controls.
- Strict Obsidian community linting and a reviewer-style publication preflight.
- A regression test proving clinical scans ignore unrelated vault folders.
- BRAT, manual-install and future Community-directory instructions.
- Contribution and issue-reporting templates that prohibit patient data.

### Changed

- Runtime record and integrity scans now recurse only through the configured
  clinical root instead of enumerating every Markdown file in the vault.
- The folder-migration action uses Obsidian's current destructive-button API.
- Command IDs and names follow Obsidian's namespace and sentence-case rules.
- Unsafe YAML and settings values are narrowed before reaching typed code.

### Security

- The release preflight rejects vault-wide enumeration, network access,
  clipboard access, deprecated settings APIs, dynamic code execution and unsafe
  HTML assignment.

## [0.3.0] - 2026-08-05

Two further adversarial reviews, and the fixes for what they found. The theme
of this release is that fixes introduce defects: of the findings in the second
review, 15 were regressions from fixes made earlier the same day. Every fix
below carries a test that fails against the build before it.

### Fixed — clinical correctness

- A task could be filed under one patient while its episode belonged to
  another. The episode owns that relationship and it is now enforced on
  creation, for procedures as well as tasks.
- Nothing detected such a mismatch after the fact. Integrity gains
  `mismatched-task-patient` and `mismatched-procedure-patient`.
- Changing only a task's due date created a second open task instead of
  rescheduling the first.
- Clearing an episode's next action left an open task behind while the card
  showed nothing outstanding.
- Changing an episode's priority could revert, because the task created
  alongside it was built from a record captured before the save.
- Adding a task rewrote the episode's priority, so a routine task silently
  downgraded an urgent episode. Priority is a judgement about the patient,
  not a property of the newest task.
- An episode now points at its most imminent outstanding task rather than
  whichever was added last, which made "the task this episode raised"
  ambiguous.
- Superseding a task no longer cancels it before its replacement exists, and
  identifies it by idempotency key rather than by wording — so a repeat
  deliberately scheduled for a later date is left alone.
- `completeProcedure` validates the patient and episode before writing,
  rather than after.

### Fixed — folder migration

- An interrupted move could resolve to an empty folder and report an empty
  caseload. Reconciliation now runs before the folder structure is created,
  and looks for records rather than for any markdown.
- The recovery marker was erased by any unrelated settings change.
- Moving the folder overwrote customised database views and the home note.

### Fixed — mobile

- Obsidian's mobile toolbar floats above the safe-area inset, so the floating
  action button sat underneath it and the last section of every tab was cut off.
- Modal actions were pinned mid-form on a phone, leaving five of nine fields
  unreachable. The modal is now a column with its own scrolling body.
- Card buttons had no visible chrome on mobile and read as plain text.
- The floating action button covered the Discharge control on a short list.
- An empty date field renders as nothing at all on iOS.

### Removed

- The NotePlan importer. The migration was done another way, and the importer
  fabricated patients from any four-digit number — a note titled
  "# 2024 - Q3 Retrospective" became a patient with MRN 2024 and
  `mrn_status: confirmed`. Code that writes clinical records should not sit
  unused in the tree.

### Added

- `npm run install:vault` — installs a build into a vault, refusing a
  development build unless `--allow-dev` is passed.

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
