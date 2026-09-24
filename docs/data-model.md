# Data model reference

Every Clinical Workspace record is one Markdown note whose YAML frontmatter is
the source of truth. Note bodies are free-writing space; the plugin never
stores an identifier or a mutable field in a generated body. Filenames are
cosmetic — the frontmatter `id` is the identity, so renamed notes stay
connected.

This page describes the persisted schema for people inspecting, scripting, or
repairing records by hand. Validation of hand edits happens only when the
integrity check runs; write it, then run **Run clinical data integrity check**.
For everyday use of the workspace, see [Everyday use](user-guide.md).

## Folder layout

```text
<Clinical folder>/            e.g. "Clinical Workspace"
├── 00 Home/                  generated home note
├── Patients/                 PAT-… patient identity notes
├── Episodes/                 EPI-… care episode notes
├── Tasks/                    TSK-… task notes
├── Procedures/               PRC-… surgical logbook notes
├── Events/                   EVT-… audit trail notes
├── Bases/                    generated Obsidian Bases views
├── Inbox/ Documents/ Attachments/ Medication Library/ Templates/
```

## Relationships

```text
Patient ──< Episode ──< Task
                 ├──< Procedure
                 └──< Event (audit trail; may also reference the patient directly)
```

- `patient_id` / `episode_id` fields carry the stable ids; `patient` /
  `episode` fields carry display wikilinks that are regenerated when an
  identity is corrected or merged.
- The **episode owns the patient relationship**: a task or procedure whose
  `patient_id` disagrees with its episode's is flagged by the integrity check
  as filed under the wrong chart.

## Shared fields (every entity)

| Field | Meaning |
|---|---|
| `schema_version` | Integer, currently `3`. Records above the supported range are flagged, never rewritten. |
| `entity` | `patient` · `episode` · `task` · `procedure` · `event` |
| `id` | Stable identity: `PAT-`/`EPI-`/`TSK-`/`PRC-`/`EVT-` + 20 random hex chars |
| `created_at` / `updated_at` | UTC ISO timestamps written by the plugin |
| `tags` | `clinical/<entity>` (procedures also carry `clinical/surgery`) |

## Patient

| Field | Notes |
|---|---|
| `mrn` | Digits as entered, stored as quoted text; leading zeroes preserved. Matching uses a normalized key, so `0012345` and `12345` are one patient. An MRN already recorded under a different name is not reused until the user confirms it (**Check the MRN**). |
| `mrn_status` | `confirmed` · `missing` · `unconfirmed` |
| `patient_name`, `phone` | Display values, stored as quoted text; phone keeps only digits and a leading `+`. |
| `phone_status` | `confirmed` · `not-found` · `unconfirmed` |
| `status` | `active` · `archived` · `entered-in-error` |
| `merged_into` | Set when this record was merged away; the note is retired, never deleted. |
| `merge_in_progress` | Recovery marker while a merge is re-pointing linked records. |

## Episode

| Field | Notes |
|---|---|
| `case` | The case / reason. One active episode per (patient, case). |
| `care_setting` | `inpatient` · `outpatient` |
| `pathway` | `assessment` · `or-booking` · `opd-follow-up` · `result-review` · `consultation` · `discharge-ready` |
| `priority` | `routine` · `urgent` · `emergency` |
| `status` | `active` · `on-hold` · `ready-to-close` · `archived` · `cancelled` · `entered-in-error` |
| `next_action` / `due_date` | Mirror of the soonest **open** task (earliest due date first, undated last) — not free fields. Recomputed after every task change and every **Update**; both are blank when nothing is open. |
| `opened_at` / `closed_at` / `outcome` | Lifecycle bookkeeping; `outcome` survives restore. |
| `pathway_before_archive` / `status_before_archive` | What archiving overwrote, so restore can put it back. |
| `status_before_ready` | The status a task completion replaced when it left the episode ready to close, so Undo or Reopen can put it back (for example on hold). Empty when none. |

An episode cannot be archived while it has an open task, or while any task
note inside the configured `Tasks/` record folder is unreadable (unreadable
managed work cannot be proven closed). Records moved outside their managed
entity folder are outside workflow scope and must be returned before use.

## Task

| Field | Notes |
|---|---|
| `task` | The action. |
| `task_type` | `clinical-review` · `call-patient` · `review-result` · `book-or` · `postop-follow-up` · `consultation` · `wound-care` · `medication` · `other` |
| `status` | `open` · `in-progress` · `waiting` · `completed` · `cancelled` · `entered-in-error` — the first three count as open work. |
| `priority` | `routine` · `urgent` · `emergency`. Starts at the episode's priority; raising the episode's priority raises lower-priority open tasks, and lowering it never lowers a task. |
| `due_date` | Bare `YYYY-MM-DD` or empty. |
| `owner` | Optional free text. |
| `completed_at` / `cancelled_at` / `cancel_reason` | Closure bookkeeping. `cancel_reason` is `Closed at discharge` for tasks cancelled by the Discharge option, `Superseded by: …` when **Update** replaced the next action, and `Completion undone` for a next occurrence withdrawn by Undo. |
| `repeat_every_days` | Unquoted whole number from `0` to `730`; `0` or absent = one-off. When positive, *completing* the task raises the next occurrence: its due date (or today, if it has none) plus the interval, moved forward by whole intervals until it is on or after today. A weekly task due `2026-09-01` and completed on `2026-09-12` recurs on `2026-09-15`. *Reopening* a completed task withdraws that next occurrence while it is untouched; *cancelling* ends the series. Any other value is reported as `invalid-repeat-interval` and the task does not recur. |
| `idempotency_key` | 32-bit hash of (episode, task, due date) used for duplicate suppression. Never trusted alone: every match also compares the underlying fields, so hand-editing a task does not confuse it with another. Rescheduling recomputes it, so it always names the current fields. |

## Procedure

| Field | Notes |
|---|---|
| `procedure` | The operation performed (not the booked case). |
| `procedure_date` | Bare date, required and validated before any write. |
| `role` | `Primary surgeon` · `Assistant surgeon` · `Supervisor` · `Observer` |
| `status` | `completed` · `cancelled` · `entered-in-error` — the plugin only creates `completed`. An episode can hold several procedures; one logged with **Add another procedure** completes no OR-booking task and leaves the episode's pathway unchanged; without follow-up it leaves the status and next action unchanged too. |
| `outcome` | Optional short outcome. |
| `follow_up_required` / `follow_up_date` / `follow_up_plan` | A required follow-up creates a `postop-follow-up` task; contradictions are flagged by the integrity check. |
| `audit_pending` | `true` until the completion audit event is durably written; a retry of the same form settles it. One left `true` with no completion event is reported by the integrity check: as `unfinished-procedure` when something besides the audit entry needs checking, otherwise as `missing-audit-event`. |
| `idempotency_key` | 32-bit hash of (episode, procedure, date), with the same rules as tasks. One logged with **Add another procedure** also hashes an id unique to that form, so a second procedure with the same name and date gets its own entry, while resubmitting the same form does not. |

## Event (audit trail)

Events record who did what, when: `action`, `actor` (from settings, default
`local-user`), `patient_id`, `episode_id`, `target_id`, `target_entity`,
`summary`, `previous_state`, `new_state`. Event writes never fail a clinical
action; a gap is reported as a Notice and found again by the integrity
check's audit-trail coverage.

## Task bundle templates

A note in the `Templates` folder becomes an applyable task bundle when its
frontmatter carries `clinical_template: task-bundle`. Applying one is always
an explicit, previewed action from an episode card — templates never run
automatically, and re-applying is safe because identical open tasks are kept,
not duplicated.

```yaml
---
clinical_template: task-bundle
template_name: Tonsillectomy pathway   # optional; defaults to the filename
pathway: or-booking                    # optional; omit to offer everywhere
tasks:
  - task: Confirm consent
    task_type: clinical-review         # optional; defaults to other
    due_in_days: 1                     # optional; omit for undated
  - task: Book operating room
    task_type: book-or
    priority: urgent                   # optional; defaults to the episode's
---
```

Matching is lenient about presentation, not about meaning:

- `clinical_template`, `pathway`, `task_type`, and `priority` ignore capital
  letters and surrounding spaces, so `Book-OR` and `URGENT` are accepted. The
  value itself must still be one listed on this page (`book-or`, not
  `book or`).
- `due_in_days` is a whole number of days from `0` to `730`. An unquoted
  number, a quoted number such as `"3"`, and Arabic-Indic digits all work.

Nothing is guessed. The apply preview lists every fallback under "Check this
template:":

| Problem | What happens |
|---|---|
| An item is not a task entry, or has no `task` text | The item is skipped. |
| `task_type` not recognised | The task is created as `other`. |
| `priority` not recognised | The episode's priority is used. |
| `due_in_days` not a whole number from 0 to 730 | The task is created without a due date. |
| `pathway` not recognised | The template is offered for every episode. |

A note whose `tasks` is not a list, or whose items are all skipped, is not
offered as a template.

## Patient lists

**Export patient list** (Patients → Export list, More → Export patient list,
or the command palette) writes one file into the `Documents` folder listing
every episode that matches the chosen filter:

| Filter | Choices |
|---|---|
| Care setting | Any · `inpatient` · `outpatient` (any value other than `inpatient` counts as outpatient, as on the Patients tab) |
| Pathway | Any · any pathway value above |
| Priority | Any · `routine` · `urgent` · `emergency` |
| Episodes | Open (every status except `archived`, `cancelled` and `entered-in-error`, as on the Patients tab) · one status · every status except `entered-in-error` |

- One row per matching **episode**: a patient with two matching episodes is
  listed twice, because the episode carries the setting, pathway, and
  priority being filtered. Rows are ordered inpatients first, then by
  priority, due date, and patient name. An episode still filed under a
  merged patient is listed, and counted, under the surviving patient.
- Columns: MRN, patient, phone, case, setting, pathway, priority, status,
  next action, due date, opened date, open tasks, overdue tasks.
- **Note (`.md`)** — a Markdown table that opens in Obsidian. Pipes,
  brackets, angle brackets, and Obsidian's inline syntax (`%%` comments,
  `#` tags, `$` math, emphasis, highlights) in clinical text are escaped so
  they cannot break the table, hide rows, or create links or tags.
- **Spreadsheet (`.csv`)** — UTF-8 with a byte-order mark (so Arabic names
  display correctly in Excel), CRLF line endings, every cell quoted, and
  formula-like values (`=`, `+`, `-`, `@`) prefixed with `'` so spreadsheet
  apps cannot evaluate them. Obsidian cannot display a CSV itself: open it
  from your file manager or the iOS/iPadOS Files app. MRN and phone values
  that start with 0 or are 12 or more digits long also get a leading `'`, so
  spreadsheets keep every digit instead of dropping leading zeroes or rounding
  them. Most spreadsheet apps show that `'` as part of the cell text, so remove
  it before copying the value into another system. Obsidian Sync copies a CSV only when syncing of other file types is
  enabled.

Like the handover note, a patient list contains identifiers by design, stays
inside the clinical folder, is not a managed record, and should be deleted
after use. A name collision gets a numeric suffix; nothing is overwritten.
Writing a list goes through the same write barrier as records, so it is
unavailable while editing is paused.

## Handover notes

**Generate ward handover note** writes one Markdown note named `Handover` plus
today's date into the `Documents` folder. Its sections are:

| Section | Contents |
|---|---|
| Inpatients | Every active inpatient episode, emergency first, with case, pathway, priority, and next action. |
| Overdue and due today | Open tasks for all patients, inpatient and outpatient, that are overdue or due today. |
| Due tomorrow | Open tasks due tomorrow. |
| No date set | Open tasks with no due date, or with a due date that cannot be read. |
| Counts | Active episodes (inpatient and outpatient) and open tasks. |

Each task section is sorted emergency first, then by due date; each task line
shows the task, patient, case, priority, and due state. The note contains
identifiers by design, lives inside the clinical folder like every other
record, and should be deleted after use. It is a convenience copy, not a
managed record: the integrity check does not track it.

## Generated database views

The `Bases` folder holds four generated Obsidian Bases views: `Patients.base`
(**All patients**, **Needs identity review**), `Episodes.base` (**Active
episodes**, **Archive**), `Tasks.base` (**Open tasks**, **Completed**), and
`Surgery Logbook.base` (**Surgery logbook**, **Retracted**).

- **Surgery logbook** lists completed procedures only, matching the Surgery
  tab and the logbook exporter. **Retracted** lists cancelled and
  entered-in-error procedures.
- Generated views are versioned. A file still exactly as an earlier version
  wrote it is upgraded when the workspace first opens after Obsidian starts
  and after a clinical-folder move; a missing file is recreated then.
- A file you have edited is never rewritten, so it does not receive later
  changes such as the completed-only filter. Either rename your copy and
  restart Obsidian to get a fresh generated file, or give the **Surgery
  logbook** view in your copy the same filter the generated file uses:

  ```yaml
  views:
    - type: table
      name: Surgery logbook
      filters:
        and:
          - 'status == "completed"'
  ```
- After a folder move, an edited view may still filter on the old folder and
  show nothing. The integrity check reports it as `stale-base-folder`.

## Editing records by hand

Safe, with care:

- Keep enum values exactly as listed above — unknown values are flagged and
  the affected workflows fail closed.
- **Quote text values that look like numbers**, above all `mrn` and `phone`:
  write `mrn: "0090000077"` and `phone: "0500000000"`. Unquoted, YAML reads a
  number and drops leading zeros before the plugin sees it. The plugin still
  reads such a value as text, but the integrity check reports it as
  `text-stored-as-number` so you can restore the digits and add quotes. The
  same applies to `true`/`false` typed into a text property.
- `repeat_every_days` is the opposite: an unquoted whole number.
- Dates are bare `YYYY-MM-DD`; timestamps are UTC ISO.
- Never duplicate an `id`, and never reuse one across entities.
- Saving a record note by hand pauses editing in the workspace for a moment
  while the records are rechecked; it reopens by itself when the record set is
  still complete.
- After any external edit or import, run the integrity check. It detects
  unreadable notes, unknown values, duplicate MRNs and ids, orphaned records,
  wrong-chart filings, contradiction states, and audit-trail gaps.

## Integrity check findings

**Run clinical data integrity check** always opens a report. When nothing is
found it says "Configured checks passed" with the number of check families
(currently 24) and records examined; this is not a full validation of every
field. Each issue has **Open record**. The findings below were added after
0.6.9:

| Code | Severity | Meaning | What to do |
|---|---|---|---|
| `text-stored-as-number` | warning | A text property (for example `mrn`, `phone`, `patient_name`, `case`) was typed as an unquoted number or `true`/`false`. Leading zeros may already be lost. | Check the value against the source, restore any missing zeros, and put it in quotes. |
| `invalid-repeat-interval` | warning | `repeat_every_days` is not an unquoted whole number from 0 to 730, so the task will not recur. | Set it to a plain whole number such as `7`, or `0` for no repeat. |
| `record-linked-to-merged-patient` | error | An episode, task, or procedure is still filed under a patient that was merged into another, usually because Sync delivered it after the merge. The workspace cannot change it. | Set its `patient_id` to the `merged_into` value on the merged patient's note, and its `patient` link to that same patient. |
| `active-episode-under-inactive-patient` | error | An episode is still open but its patient is archived or entered in error, so the episode cannot be updated or discharged. | Set the patient's `status` back to `active`. If the patient was entered in error and is not real, set the episode's `status` to `entered-in-error` too. |
| `not-exportable` | warning | A completed procedure that the logbook exporter would refuse. The message lists the properties to fix: `procedure`, `role`, `outcome` (`""` when there is none), `procedure_date` (`YYYY-MM-DD`, no time), `created_at` (UTC ending in `Z`), `follow_up_required` (`true` or `false`), `follow_up_date` (`YYYY-MM-DD`, or `""` when no follow-up is required). | Correct the listed properties in the procedure note. |
| `unfinished-procedure` | warning | A procedure is in the logbook, but its audit entry was never written and something else needs checking: the save may have stopped before it moved the episode on from OR booking or added its follow-up task, or the same procedure and date was logged again on the episode after it. The message says which. When only the audit entry can be missing, for example when the audit write alone failed and the workspace said the action succeeded, the procedure is reported as `missing-audit-event` instead. | Do what the message says. It offers **Complete surgery** only when that finishes this entry: a **Complete surgery** form saved it, the episode is still on that OR booking, and nothing has been logged, added or updated on the episode since; tap it and enter the same procedure, date and follow-up. Otherwise the message never offers it, because **Complete surgery** would then complete the episode's current booking, which may be for a surgery that has not happened yet. Open the episode and check its pathway, next action and tasks; add a missing follow-up task with **+ Task**. Check the Surgery logbook before logging the procedure again, because a new form adds a second entry. If the procedure is there twice, set `status` to `entered-in-error` on the unfinished note, so the logbook counts it once. |
| `stale-base-folder` | warning | A customised database view still filters on a clinical folder other than the configured one, usually after a folder move, so it shows no records. | Edit the view's `file.inFolder(...)` lines to name the current clinical folder. |

**Show identifier-free summary** lists issue codes and counts only, for bug
reports.
