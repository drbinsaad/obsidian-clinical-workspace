# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Upgrade notes

- **Customised Surgery Logbook Base.** If you edited
  `Bases/Surgery Logbook.base`, it is left exactly as you made it, so it does
  not get the new "completed only" filter or the **Retracted** view. Add the
  filter yourself as shown in [Generated database
  views](docs/data-model.md#generated-database-views), or rename your copy and
  reopen the workspace to get a fresh generated one. Untouched Bases and home
  notes are upgraded automatically.
- **Quote MRN and phone when editing a note by hand.** Write
  `mrn: "0090000077"`, not `mrn: 0090000077`. Without quotes YAML reads a
  number and drops the leading zeros. Run **Run clinical data integrity
  check**: the new `text-stored-as-number` warning points to every property
  that needs quotes and a check of its value.
- **Renamed command.** "Retry pending folder move recovery" is now **Recheck
  records and unlock editing**. Its id (`retry-folder-move-recovery`) is
  unchanged, so hotkeys and mobile-toolbar buttons keep working; update any
  personal notes or shortcuts that use the old name.

### Added

- **Export patient list**: save the patients of any type — any combination of
  care setting, pathway, priority, and episode status — to a Markdown note or
  a formula-safe CSV spreadsheet in the clinical `Documents` folder. The form
  previews the match count before writing. Available from **Patients → Export
  list**, **More → Export patient list**, and the command palette.
- The Patients tab can be filtered by pathway and priority. Section counts
  show when a filter hides records, and **Export list** starts from the
  current filter.
- **Check the MRN**: when the MRN typed in **Add patient** is already recorded
  for a patient with a different name, a dialog shows the stored patient
  before anything is filed. **Go back and check the MRN** (the default)
  returns to the filled form; **Use this patient** adds the episode there and
  keeps the stored name.
- **Undo after Complete**: completing a task shows "Task completed." with an
  **Undo** button for about 9 seconds, from any tab. For a repeating task the
  notice says whether the next occurrence was withdrawn or, because it had
  been changed, left open. A task that was already completed, for example on
  the other device, says so instead and offers no Undo.
- **Discharge with open tasks**: Discharge lists the episode's open tasks and
  offers one explicit tick, off by default, to cancel them with the reason
  "Closed at discharge". **Archive episode** stays unavailable until it is
  ticked or the tasks are closed, and work added while the form was open
  refuses the discharge. Episode cards show "N open tasks".
- **Add another procedure**: an episode that has moved on after surgery can log
  a further procedure from its newest Surgery logbook entry or from **Quick
  entry → Record procedure**, without changing its pathway, status or next
  action.
- **Read-only banner**: while editing is paused the workspace shows **Editing
  is paused**, the reason in plain words, a warning when the list may be
  incomplete, and a **Recheck now** button. It clears by itself.
- The patient sheet can complete and reschedule open tasks. Ward-round rows
  have **View** (the patient sheet) beside **Open**, and choosing a patient in
  Search opens the sheet.
- Date fields gain **Today**, **+1d** and **+2d** chips, and a due or
  follow-up date in the past is named before saving.
- The ward handover note adds **Due tomorrow** and **No date set** sections;
  every task section lists emergency work first, and each task line shows its
  case and priority.
- A **Retracted** view in the generated Surgery Logbook Base lists cancelled
  and entered-in-error procedures.
- Integrity check findings for text stored as a number, invalid repeat
  intervals, records left under a merged patient, open episodes under an
  archived or entered-in-error patient, completed procedures the logbook
  exporter would refuse, and database views still filtering on a previous
  clinical folder. The report now covers 24 check families. See [Integrity
  check findings](docs/data-model.md#integrity-check-findings).
- Task template previews show each task's type, priority and due date, and list
  anything that was skipped or defaulted under "Check this template:".
- Logbook exporter: `--from`, `--to` and `--role` filters, applied only after
  every record has been validated.
- An everyday-use guide, [docs/user-guide.md](docs/user-guide.md), with
  step-by-step recipes and a table of every command.

### Changed

- A workspace whose editing is paused now opens read-only instead of refusing
  to open, from the ribbon, commands, Quick entry and links. It still refuses
  while a synced folder move is unfinished, while the clinical folder is
  missing, and before first-use initialization. Forms that would write refuse
  up front with the reason.
- **Retry pending folder move recovery** is renamed **Recheck records and
  unlock editing** and is also offered while a baseline review or verification
  of newly synced records is pending. **Confirm current records as the recovery
  baseline** is listed only while editing is paused or a review is pending.
  **Initialize new workspace** stays listed until an approved initialization
  has finished, unless a baseline review then needs typed `ADOPT`.
- Recovery notices say what happened in plain words and name only commands
  that are available at that moment. A successful recheck says "Clinical
  Workspace rechecked its records. Editing is available again." instead of
  "folder access was restored". The What's new window uses plain language too.
- After a hand edit to a record note, editing still pauses at once, but the
  recheck runs about 1.5 seconds after the last autosave instead of after
  every autosave. Notes saved outside the clinical folder do not delay it.
- **Run clinical data integrity check** works while editing is paused, and
  notices about unreadable or unrecognised notes point to it. The automatic
  check on first open waits until editing is available, and is not shown
  again for an unchanged set of issues in the same session.
- The `ADOPT` confirmation shows the previously trusted counts beside the
  current ones and warns when any count dropped.
- Return moves to the next form field and saves only from the form's last
  field when that is a text field (or with Ctrl/Cmd+Return), so **Add
  patient** and **Update** no longer save from **Next action** before **Due
  date** is reached. The iPhone keyboard shows next/done to match.
- Task notices no longer repeat the task's wording: "Task added.", "Task
  already exists." and "No task added: that task was already completed…".
  When an action fails with an error that names a file or folder path, the
  notice shows a fixed message instead; a form still shows the full reason.
- A repeating task completed late comes back on the first date on or after
  today, on the same cadence, instead of already overdue.
- **Update**: changing only the date of the next action moves that task and
  keeps its type, owner, priority and repeat; rewording it keeps the owner and
  repeat (and the type unless the pathway changed). The episode's next action
  and due date always show the soonest open task and are blank when nothing is
  open. Raising the episode priority raises lower-priority open tasks. The
  notice reports a moved task and how many tasks were raised.
- **Add patient**: an MRN nobody holds yet, typed for a name already recorded
  without an MRN, now offers that chart in **Possible duplicate patient** and
  records the MRN on it if chosen. Duplicate names match across Arabic spelling
  variants. Cancelling the dialog returns to the filled form.
- A new task's due date starts at today, or the episode's later planned date.
  Reschedule starts at tomorrow and says "Date unchanged." when nothing moved.
- Today's Overdue, Today and No date set lists sort by priority first. The ward
  round pages like other lists. Card buttons put **Complete** first and pair
  the rest; **Discharge** and **Cancel** have a red border.
- Search and the episode picker match Arabic spelling variants, Arabic-Indic
  digits and MRNs with or without leading zeros. A patient search also finds
  that patient's episodes, tasks and procedures, each row names its patient,
  and a capped group says "+N more — refine your search".
- A filter that hides every item keeps its chip and offers **Clear filters**.
  Tapping **Next** or **Previous** starts the new page at its heading.
- The generated Surgery Logbook Base lists completed procedures only. Generated
  Bases are versioned, and untouched ones are upgraded when the workspace opens
  and after a folder move.
- The generated home note names the real command: **Clinical Workspace: Open
  workspace** (or the stethoscope ribbon icon).
- Audit history in the patient sheet and episode history shows local time.
- MRN, name, phone and owner fields turn off autocorrect and autofill; text
  fields follow the direction of the text typed.
- Task templates ignore capital letters and surrounding spaces in `task_type`,
  `priority`, `pathway` and `clinical_template`, and `due_in_days` accepts
  quoted numbers and Arabic-Indic digits.
- Logbook exporter: without `--root` it reads the clinical folder from the
  plugin's `data.json` in the vault (falling back to `Clinical Workspace`) and
  refuses while that file records an unfinished folder move. Validation errors
  give counts per property and point to the in-app integrity check.
- **Settings → Privacy and capabilities** lists exactly what `data.json` keeps,
  including the current and up to 64 previous clinical-folder names and the
  source and destination names during a move.

### Fixed

- A hand-typed unquoted number or `true`/`false` in a text property (MRN,
  phone, name, case, task, and similar) no longer breaks adding tasks or
  episodes or Search; it is read as text and reported by the integrity check.
- A clinical folder name containing an apostrophe no longer produces broken
  Bases; untouched Bases broken by earlier versions are repaired.
- Restoring an archived episode can no longer create a second active episode
  for the same case.
- A second procedure on an episode that already had one was refused.
- Undoing a repeating task's completion left its automatically created next
  occurrence open, so the series ran twice.
- Changing only the date in **Update** ended a repeating series and dropped the
  task's owner and type.
- An episode could show a due date that no open task tracked.
- The ward round stopped at 30 inpatients while its heading counted them all.
- A task-type filter could hide every task with no chip left to clear it.
- Changing a filter chip, or **Clear filters**, kept the page you were on, so
  the highest-priority matches could sit unseen on an earlier page. The list
  now starts again at page 1.
- A quick double tap on **Complete**, **Restore** or **Generate handover**
  could run it twice.
- A redraw, including one caused by Sync, no longer drops keyboard or
  VoiceOver focus to the top of the view.
- Modal footers no longer add the iPhone bottom safe area twice, and shrink
  while the keyboard is open.
- On a new device, a plain note inside a record folder is reported as "not a
  valid Clinical Workspace record" with a pointer to the integrity check, and
  records that Sync delivered before initialization no longer force a typed
  `ADOPT` after a restart.
- The integrity check on first open no longer reappears after every settings
  save from the other device.
- **Remove identifiers from generated note bodies** reports how many notes it
  rewrote when Sync interrupts it, instead of failing silently.
- The Arabic Letter Mark (U+061C) is stripped from entered text and logbook CSV
  cells like the other direction-control characters.
- Danger buttons and error text meet AA contrast with the default light and
  dark themes.

## [0.6.9] - 2026-09-20

### Fixed

- A stale shared manual-review flag can now recover automatically when this
  device already has a clean, complete recovery journal that exactly matches
  the synced commitment. Startup and settings delivery recheck the actual
  record identities, counts, folder binding, and retired-folder evidence;
  writes reopen only after the save and a second matching scan. Ordinary
  verified recovery does not ask the user to type `ADOPT` again.
- Newly detected local integrity failures are recorded in the device-local
  journal, so another device's settings cannot erase their origin or clear
  them. If that local evidence cannot be saved and read back, a conservative
  shared confirmation requirement is retained instead.
- Missing/replaced records, interrupted journals, incomplete witnesses,
  conflicting synced commitments, and malformed recovery metadata do not
  qualify for the stale-flag exception. It does not adopt a different record
  set or change clinical notes.

### Recovery compatibility

- Older releases stored the manual-review flag without its origin. The
  narrowly scoped upgrade above treats that legacy flag as a request to
  reverify an independently committed exact record set, not as proof of a
  current local failure. It cannot reconstruct an unknown historical reason
  that an older release did not record. A pending or invalid journal remains
  protected and is never classified as clean by this upgrade.

## [0.6.8] - 2026-09-20

### Fixed

- Manual baseline-review notices now explain that Sync completion or Retry
  alone will not clear this lock. The confirmation preview reminds users to
  verify that the displayed records are the complete intended set.
- Repeated background recovery events no longer restart the same popup.
  Background notices expire within five seconds, remain suppressed after
  dismissal for that recovery episode, and use a smaller mobile footprint.
  Explicit blocked actions still show actionable guidance.
- Record-verification rules, write barriers, and typed baseline confirmation
  are unchanged. This update does not approve a baseline or unlock a workspace
  whose saved recovery state requires manual confirmation.

## [0.6.7] - 2026-09-18

### Fixed

- A "needs review" lock no longer outlives the condition that raised it. A
  review flag saved by an earlier version, or delivered in another device's
  `data.json` while that device was still locked, now clears itself through the
  same membership proof that reopens ordinary two-device growth: on startup,
  on the next Sync delivery, when the workspace is opened, and on explicit
  **Retry pending folder move recovery**. The cleared flag is what Sync then
  carries to the other device, so a stale lock no longer bounces between
  devices after both have updated. Typed `ADOPT` is still required when a
  trusted record vanished or was replaced, when the review was raised by
  unreadable safety metadata, or when the device-local journal predates
  membership witnesses.
- The review notice now says that the workspace reopens on its own once every
  trusted record is present, and to try **Retry pending folder move recovery**
  before confirming a new baseline.

## [0.6.6] - 2026-09-17

### Fixed

- Adding records on two devices no longer locks the workspace behind typed
  `ADOPT`. A synced baseline that differs from this device's trusted baseline
  (equal counts with different digests, a higher count, or an older lower
  snapshot arriving late) is now staged as evidence and verified against the
  finished on-disk record set. Writes reopen automatically, on every device,
  once every record this device previously trusted is still present and the
  disk holds at least the highest synced record count; the grown set becomes
  the new trusted baseline. Loss, replacement, malformed Markdown in the
  record folders, and legacy count-only safety data still fail closed, and a
  synced set that omits a locally trusted record still requires `ADOPT`.
- Record files that arrive before their `data.json`, a Sync callback landing
  while a local write is in flight, and explicit **Retry pending folder move
  recovery** all use the same rule, so ordinary two-device use no longer ends
  in a permanent "verifying newly synced records" barrier.
- **Update**, **Reschedule**, **Cancel**, **Discharge**, **Template**, **Edit
  identity**, and **Merge** now show the recovery notice before opening a form
  the repository already knows cannot save, matching the task and procedure
  entry points.
- The "verifying newly synced records" notice now says what to do if Sync has
  finished and the workspace is still read-only.

## [0.6.5] - 2026-09-17

### Fixed

- Repeated delivery of unchanged plugin settings no longer writes another pair
  of recovery states back through Sync. This stops the settings feedback loop
  that could keep workspace activation busy and repeatedly display a recovery
  warning after baseline confirmation.
- An unchanged healthy delivery still pauses record writes and verifies the
  complete record inventory against the device-local journal. Pending folder
  moves, changed commitments, and existing review requirements retain their
  normal recovery checks.

## [0.6.4] - 2026-09-17

### Fixed

- Task forms on iPad no longer snap back to the focused field while the user
  scrolls. Delayed keyboard-animation reveals are cancelled by touch, pointer,
  wheel, or visual-viewport scrolling; genuine keyboard, rotation, and Split
  View resizing still reveals a control only when the form actually clips it.
- Long Sync/recovery errors now live inside the form's scroll area. A rejected
  submission keeps every entered value, restores Submit and Cancel, announces
  the error accessibly, and scrolls the message into view once.
- Legitimate same-folder additions from another device no longer become a
  permanent typed-`ADOPT` conflict. A higher synced inventory stays read-only
  until an exact full scan proves that every locally trusted record identity is
  still present. Explicit Retry and clean legacy-journal upgrades use the same
  proof; replacement, deletion, malformed, incomplete, and legacy-ambiguous
  states remain fail-closed.
- Task and procedure entry points now show the existing recovery notice before
  opening a form that the repository already knows cannot save.
- `discharge-ready` can no longer conceal existing or newly created open work;
  the final reconciled Episode remains active until every task is closed.
- A failed late retired-root safety save now keeps its journal and write barrier
  armed, marks persistence for retry, and avoids an unhandled rejection.

### Accessibility

- Split Clinical Workspace panes now use unique tab and panel IDs. Filter and
  date chips meet the 44 px touch target, pinch zoom remains available inside
  forms, and redraws restore keyboard focus without stealing it from a newer
  modal or control.

### Security

- Device-local membership witnesses are one-way SHA-256 values, capped at
  20,000 records and hashed in batches of 256. Larger inventories stay on the
  conservative review path instead of creating unbounded work or storage.
- The threat model now calls out generated ward-handover notes as high-density
  identifier summaries and documents their handling expectations.

## [0.6.3] - 2026-09-10

### Fixed

- The iPhone workspace header now keeps Search, Quick Entry, and Refresh in one
  compact row. All five workspace tabs remain visible at ordinary phone text
  sizes and become horizontally scrollable instead of clipping when larger text
  needs more room.
- Surgery summaries use a compact two-by-two phone grid, while record actions
  use two touch-safe columns with primary and destructive actions spanning the
  row. Task cancellation is now visually identified as destructive.
- Mobile devices now show a labelled, in-flow **Add patient** action only in the
  Patients view. The ambiguous floating plus no longer covers cards or competes
  with Obsidian's mobile toolbar on either iPhone or iPad.
- Quick Entry and empty Search sheets are denser, and native modal close controls
  account for the iOS top safe area without covering modal content. Existing
  visual-viewport keyboard handling remains in place.

### Accessibility

- Search uses the mobile keyboard's Search return-key hint and announces its
  threshold, empty state, and displayed result count through a deduplicated
  polite status region.
- Added behavioral mobile-layout coverage for phone and iPad header controls,
  navigation, cards, action placement, safe areas, Quick Entry, Search, and
  keyboard geometry.

## [0.6.2] - 2026-09-09

### Fixed

- Cross-device folder recovery now keeps a device-local, path-free inventory
  journal, rejects stale or overlapping Sync callbacks by generation, and
  verifies the exact Patient/Episode/Task/Procedure ID set before reopening
  writes. Corrupt or unwritable journal state fails closed; typed `ADOPT`
  remains the only way to replace a conflicting trusted baseline.
- Successfully retired clinical roots are retained as a bounded, synced list
  so a late old-folder delivery on another Mac—or after restart—reconstructs
  recovery instead of appearing as unrelated notes. The device-local journal
  commits one-way fingerprints of that list before applying Sync; malformed,
  truncated, over-limit, or crash-interrupted provenance fails closed.
- Managed-record writes and root moves now serialize at their boundary. Vault
  events are accepted as plugin-owned only after revision-stable identity
  readback, so same-path Sync replacements, suspended reads, final recovery
  scans, concurrent creates, observer failures, and a create racing a root move
  cannot silently advance trust or strand a successful record under the old
  root. Legacy count-only moves require an exact explicit Retry before writes
  reopen.
- Recovery notices now use one responsive, deduplicated presenter that stays
  within narrow desktop and phone viewports instead of covering the workspace.

### Security

- Recovery metadata and its privacy limits are documented explicitly. The
  journal contains aggregate counts and one-way commitments, not raw paths,
  record IDs, patient identifiers, clinical text, timestamps, or device IDs.

## [0.6.1] - 2026-08-13

Fast-follow to 0.6.0.

### Changed

- The what's-new window now appears as soon as the updated plugin loads (at layout-ready), instead of waiting until the workspace is next opened. It still shows once per version per synced device set.
- Whole-folder record reads are served from a path-keyed index that is trusted until Obsidian reports a change for that path, so a workflow action no longer re-reads every record note. On large caseloads this removes the dominant per-action cost on phones; a file's existence is always re-checked before an entry is served, and write verification updates the index authoritatively.

### Added

- A property harness for the sync-safety state machine: seeded random sequences of restarts, folder renames, record deletions, and data.json deliveries assert after every event that a clinical write is accepted only against a root holding the trusted record count — and that the trusted baseline only ratchets upward.

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
