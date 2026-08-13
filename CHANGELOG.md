# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-08-13

Review-and-roadmap release: a full independent review of 0.5.0 with every
confirmed finding fixed under regression coverage (`tests/ultra-review-remediation.test.ts`),
plus the first block of workflow features (`tests/roadmap-features.test.ts`,
`tests/interleaving.test.ts`). The suite grows from 219 to 245 tests.

### Fixed

- Replacing an episode's next action can no longer cancel the wrong task: every idempotency-key match now also compares the underlying task text and due date, so a hand-edited or re-worded task is never mistaken for the one the plan raised.
- Records missing while Obsidian was closed now fail closed at load exactly like a live deletion: the on-disk count is checked against the persisted baseline, the recovery inventory only ratchets forward (never rebasing from a depleted root), and a momentary zero count can no longer disarm the deletion detector.
- A crash between closing a task and updating its episode is now repaired by the retry instead of being permanently stuck; the duplicate-episode path repairs a missing first task but never supersedes live work; and episode updates validate every field before the first write.
- The automatic patient archive is skipped while any episode note is unreadable, since invisible notes may still be active care.
- YAML 1.1 date objects keep their calendar day in every timezone (UTC-midnight dates read as UTC, local moments as local).
- Sync-recovery hardening: baseline adoption and the body-migration command re-check for a migration marker or armed barrier at decision time, not just before their confirmation opened; a record-free synced folder move stays pending until the destination folder actually arrives; CRLF-normalized legacy patient bodies are recognised by the identifier-removal command; and concurrent first-use entry points share one initialization run.
- Interface correctness: background refreshes keep the scroll position; arrow-key tab switching keeps keyboard focus; modals lock while a clinical write is in flight, refuse saves over records that changed after the form opened, and fold invalid frontmatter enums to the value actually displayed; the missing-file notice no longer embeds a potentially patient-named path; and the surgery logbook lists only genuinely completed procedures.
- Integrity coverage: corrupted MRNs (non-digits) are reported, non-boolean follow-up flags are flagged instead of silently suppressing the contradiction check, event notes pass field validation, and closed records whose audit trail lacks its closure entry are reported (`missing-transition-event`).
- Normalization: zero-width characters (ZWSP, word joiner, BOM) are stripped from matching keys so visually identical names cannot split one patient into two; phone numbers keep "+" only as the international prefix. ZWNJ/ZWJ remain preserved.
- The repository refuses to adopt a different record occupying a managed path as an idempotent retry; an episode created without a next action no longer stores a phantom due date; `install-to-vault` resolves `dist/` from the repository rather than the caller's working directory; and release verification now scans the shipped stylesheet for identifier-shaped literals and remote `url()` references.
- The destructive "Move records" migration now requires a typed MOVE confirmation showing the plan, matching its own description.

### Added

- **Task templates:** a Templates-folder note with `clinical_template: task-bundle` frontmatter becomes an applyable bundle ("Tonsillectomy: consent → book OR → post-op review"). Applying is explicit and previewed; identical open tasks are kept, never duplicated. See the data model reference.
- **Recurring follow-ups:** a task can repeat (weekly to yearly). Completing it raises the next occurrence before the completion is written, so a crash between the two converges on retry; cancelling ends the series.
- **Reschedule and reopen:** open tasks move to a new date in one step (the idempotency key follows the fields it hashes), and a mis-tapped completion can be reopened from the patient view — audited, and blocked while the episode is archived.
- **Ward handover note:** one command writes an end-of-day summary of inpatients and overdue/due-today work into the Documents folder. It contains identifiers by design, stays inside the clinical folder, and says so.
- **Search:** one box across patients, MRNs, cases, tasks, and procedures, from the header or the command palette.
- **Patient view:** episodes, open and recently closed work, procedures, and audit history on one screen, with reopen for closed tasks.
- **Episode history:** the existing audit Events shown per episode, newest first.
- **Today view:** a ward-round list of inpatients in priority order, a "Next 7 days" section, and overdue badges that show the age ("Overdue 12 days") instead of a bare flag.
- **Tasks view:** filter chips by priority and task type.
- **Surgery view:** logbook summary (total, this month, as primary, awaiting OR) and a per-procedure breakdown table (total / as primary / this year) for training portfolios.
- **Forms:** date fields carry +1w/+2w/+1m/+3m quick chips.
- **Integrity report:** a selectable identifier-free summary (issue codes and counts only) for usable bug reports. Shown as text to copy manually — programmatic clipboard access stays banned by the community preflight.
- Development-only scale benchmark command; a data model reference (`docs/data-model.md`); seeded random-interleaving tests over the workflow.

### Changed

- Task transition table: `completed → open` is now legal, exclusively for the audited reopen path.

## [0.5.0] - 2026-08-12

Reliability release implementing the findings of an independent review of
0.4.1. Every item below carries regression coverage in `tests/reliability.test.ts`.

### Fixed

- A procedure retry that carries different follow-up details than the record an earlier attempt already saved is now rejected with a clear explanation instead of silently mixing the two: previously the persisted procedure could say "follow-up required" while the retry drove the episode to discharge-ready with no follow-up task. A retry with matching details resumes from the saved record.
- Procedure and follow-up dates are fully validated before anything is written. An impossible calendar date, or a follow-up date before the procedure date, is rejected while the vault is still untouched; previously an invalid follow-up date was caught only after the procedure note and episode transition had been written.
- The procedure-completed audit event now belongs to the workflow rather than to note creation: a retry that finds the note but an unwritten audit event settles it (`audit_pending` on the procedure record), instead of losing the event forever.
- A failed audit-note write now shows an identifier-free notice, and the integrity check reports the gap through a new audit-trail coverage check. Previously the failure went only to the developer console and nothing ever surfaced it.
- Retrying a task submission whose first attempt failed part-way now repairs the episode's next-action pointer instead of returning early.
- The stale merge preview race is closed: switching merge targets while a slower preview is still loading can no longer append the old target's counts or error under the new target's summary.
- Recovery gates now verify a parsed-record inventory (per-entity counts plus a digest of the sorted opaque record ids) before lifting the fail-closed barrier. An equal raw file count can hide records replaced with unreadable content, filed in the wrong folder, or swapped under duplicate ids; the inventory cannot. The commitment contains no patient information.
- Generated Base files and the home note are repaired through `Vault.process`, with the untouched-scaffold decision re-run inside the atomic transform. A Sync delivery landing mid-repair previously lost to a read-then-write race.
- Settings saves roll back and re-render on failure instead of leaving the interface showing a value `data.json` does not hold.
- Repository error messages no longer embed vault paths, which could contain patient text when a note had been renamed by hand.
- The integrity scan is linear instead of quadratic in caseload size, and the workspace render no longer repeats per-card searches; a growth-rate benchmark guards the fix.
- The floating action button no longer covers full-width card actions in narrow desktop panes; the gutter that protected mobile now applies to `is-narrow` too, on the logical inline end.
- Right-to-left fixes: the floating action button, header actions, and date fields use logical CSS properties and mirror correctly; workspace tab arrow keys follow the reading direction; user-entered names and case labels are wrapped in first-strong bidi isolates so Arabic text cannot reorder surrounding labels.
- Logbook CSV export strips directionality control characters (keeping ZWNJ/ZWJ, which Arabic-script text needs), closing a spreadsheet cell-spoofing vector.

### Changed

- The integrity report now says "Configured checks passed" with the number of check families and records examined, and states explicitly that it is not a full validation — instead of an empty state that read as a comprehensive clean bill of health.
- Integrity coverage now includes: schema versions, task types, procedure statuses, patient status enums, timestamps, missing idempotency keys, duplicate internal ids, procedure follow-up contradictions, episodes whose next action no open task tracks, ready-to-close episodes with open work, and audit-trail coverage.
- Audit event summaries are now fixed phrases ("Task created", "Procedure completed") instead of embedding user-entered case, task, or outcome text into the Events folder.
- Newly generated note bodies no longer duplicate the patient name, MRN, or phone (or other mutable fields): the frontmatter is the single source of truth, so a later identity correction cannot leave a stale copy behind.
- Card action buttons carry per-record accessible names ("Discharge — ‹case›, MRN … · ‹name›"), so screen-reader users can tell one card's buttons from another's. Form controls meet the 44 px touch minimum and show focus outlines.

### Added

- A what's-new window appears once after an update, the first time the workspace is opened: a short identifier-free summary of the changes with a link to the full release notes on GitHub. It makes no network request; the shown-for version is stored in `data.json` so other synced devices are spared the repeat.
- Command "Confirm current records as the recovery baseline": a typed-confirmation exit from the fail-closed read-only state after a deliberate record deletion or accepted Sync outcome. Previously the only way out was restoring the missing files.
- Command "Remove identifiers from generated note bodies": rewrites patient-note bodies still byte-identical to the pre-0.5 generated scaffold (which embedded name, MRN, and phone) to the new identifier-free scaffold, with a count preview and typed confirmation. Edited notes are never touched.

## [0.4.1] - 2026-08-11

### Fixed

- Made the workspace respond to its actual Obsidian pane width, including narrow stacked tabs inside a wide desktop window. Header controls, summary cards, record actions, pagination, and the workspace tab strip now reflow without pushing the view horizontally, and pane observers are rebound for pop-out windows and disconnected when the view closes.
- Kept Quick Entry, Episode selection, and clinical forms inside the visible iPhone viewport while the software keyboard is open. Modal bodies now own scrolling while action footers remain visible and tappable.
- Made Quick Entry choices, Episode cards, labels, and form controls wrap cleanly at narrow widths instead of clipping beyond the screen.
- Reconciled Obsidian's native keyboard inset with the browser visual viewport, resynchronized focused fields during the iOS keyboard animation, and removed all responsive listeners and timers when a modal closes.

## [0.4.0] - 2026-08-10

### Added

- Added a Quick Entry hub, dedicated command-palette actions for new
  patient/Episode, task or follow-up, procedure, and today's pending work, a
  touch-friendly workspace-header control, and a separate ribbon action shown
  in the desktop ribbon and mobile Open menu. Commands intentionally ship
  without default hotkeys and can be added to the mobile toolbar as global
  commands.
- Added parameter-free Obsidian protocol actions for trusted local automation.
  Every action opens only the hub, an Episode chooser, a blank form, or Today;
  any query parameter rejects the complete invocation.
- Added a searchable Episode context picker for task and procedure shortcuts.
  Task choices cover active usable Episodes, while procedure choices preserve
  the Surgery workflow boundary by listing only active OR-booking Episodes. An
  exact active managed-Episode path is labelled and promoted, but remains
  unselected until the user explicitly confirms it.
- Added a focused guide for desktop hotkeys, iPhone/mobile toolbar setup, and
  privacy-safe Apple Shortcut configuration.

### Security

- Quick Entry never accepts patient names, MRNs, record IDs, note paths,
  clinical text, or vault selection from a URI. Rejected values are not read,
  echoed, persisted, or logged, and every action still passes through the
  workspace initialization, migration, and Sync-recovery barriers.
- A single patient-merge → Episode-lifecycle → task/procedure lock order plus
  fresh context validation prevents a stale form from crossing a patient merge
  or reviving a retired Episode. Episode creation/reuse, update, archive,
  restore, and identity correction use the same ordering. Patient merges lock
  both participants in stable ID order, reject inactive surviving targets, and
  cannot form opposite-direction merge cycles. Task completion/cancellation
  also holds the Episode lifecycle lock through reconciliation, so it cannot
  erase a concurrently created next action. Procedure creation also rechecks
  the active patient relationship and OR-booking pathway before writing.
- MRN creation and identity correction share one normalized uniqueness lock;
  concurrent corrections cannot claim the same MRN. Episode creation also
  revalidates its resolved MRN after acquiring the patient lock, so a stale
  identity resolution fails closed instead of attaching to a changed patient.

## [0.3.7] - 2026-08-10

### Added

- Added product visuals, focused folder-migration and logbook-export guides,
  support and conduct policies, a feature-request form, a pull-request privacy
  checklist, Dependabot configuration, and a CI gate for public text and visual
  assets.

### Changed

- Reworked the public README around installation, first use, the core workflow,
  and the plugin's privacy and product boundaries.
- Clarified vulnerability handling so accidental patient-information disclosure
  triggers containment and institutional escalation without abandoning
  synthetic vulnerability triage or promising irreversible deletion.

### Security

- The repository-only logbook exporter now rejects output anywhere inside this
  public source checkout after resolving the destination parent, preventing
  relative, custom-named, or symlink-disguised confidential CSVs from entering
  the repository.

## [0.3.6] - 2026-08-10

### Added

- Added a repository-side surgery-logbook CSV exporter that joins completed
  procedures to their episode context. Default exports are pseudonymized and
  confidential, protect spreadsheet cells from formula injection, and require
  an explicit `--identifiers` flag before including MRNs or patient names.
- Added a mobile-safe, explicit **Initialize new workspace** confirmation that
  lets pre-0.3.6 users adopt the current records as a trusted recovery baseline
  only after Sync is complete, or initialize a genuinely new/record-free
  workspace. A two-phase path-free approval marker makes an interruption before
  scaffolding safely resumable.

### Changed

- Documentation now separates the desktop/mobile Obsidian plugin runtime from
  the desktop-only Node.js exporter, lists every default export field and its
  residual disclosure risk, and defines institutional handling for both
  pseudonymized and identified CSVs.
- Repository linting now covers the Node.js scripts as well as plugin source;
  Obsidian runtime-only lint rules remain scoped away from those desktop CLIs.
- Long clinical lists render in bounded 40-record pages. Paging preserves the
  mobile scroll position and keyboard focus, with list-specific accessible
  navigation labels.

### Fixed

- The exporter now requires an explicit output path outside the vault, rejects
  a clinical root or record-tree symlink that escapes the vault, requires an
  existing parent and `.csv` extension, rejects output symlinks, and refuses to
  replace an existing regular output unless `--force` is supplied.
- Logbook export now fails closed on unreadable/malformed records, invalid
  field types, dates or enums, duplicate IDs, missing links, and
  patient/episode mismatches. Pseudonymized mode does not read Patients;
  successful files use owner-only permissions where supported and
  same-directory atomic publication, while console summaries omit paths,
  filenames, IDs, and clinical free text.
- Conventional surgery-logbook CSV names and exporter temporary artifacts are
  ignored as defence in depth against accidental source-control publication.
- A clinical root received through Sync is no longer activated before the
  corresponding workspace arrives. Incomplete or split migration state keeps
  the known source active, preserves the recovery marker, and blocks clinical
  and scaffolding writes until vault evidence identifies one safe root.
- Migration reconciliation now retries on vault changes, settles destination-
  only records to the destination, requires explicit recovery after Sync for a
  source-only rollback, and fails closed when both roots contain managed
  records.
- Path-free workspace safety state now survives restarts. A missing previously
  populated root remains
  read-only until its prior aggregate managed-file count returns. Legacy
  workspaces with or without `data.json` stay read-only on their first 0.3.6
  open until the user confirms the visible, fully synced record count as the
  baseline. This prevents an empty parent or partial Sync delivery from being
  mistaken for a complete workspace.

## [0.3.5] - 2026-08-07

Independent re-review patch release.

### Fixed

- An interrupted root-folder move in a newly scaffolded, record-free workspace
  now resolves back to the source and clears its recovery marker instead of
  making every future workspace activation fail.
- Ribbon and command activation failures now appear in a Notice rather than
  becoming silent unhandled promise rejections.
- Text normalization strips directionality controls used for visual spoofing
  while preserving the orthographically significant ZWNJ and ZWJ characters
  used by Persian and other Arabic-script languages.
- Discharge errors for unreadable task notes no longer display user-authored
  filenames that could contain a patient name; they direct the user to the
  privacy-scoped integrity check instead.
- Patient identity correction and linked-label updates now run under one lock,
  preventing concurrent edits from leaving mixed labels.

### Changed

- New records use schema version 3, documenting the existing
  `merge_in_progress` recovery field. Older records continue to load unchanged.
- The Obsidian test stub now models `cachedRead` as an independently cached
  snapshot and invalidates it after writes, so stale-cache assumptions are
  regression-testable.
- Repeated list and workspace refreshes reuse parsed records only when the
  exact note content is unchanged, removing repeat YAML parsing without making
  clinical decisions depend on asynchronous metadata-cache timing.
- Community verification ignores macOS AppleDouble `._*` sidecars and reports
  the real TypeScript source count on exFAT checkouts.

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
