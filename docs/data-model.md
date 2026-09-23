# Data model reference

Every Clinical Workspace record is one Markdown note whose YAML frontmatter is
the source of truth. Note bodies are free-writing space; the plugin never
stores an identifier or a mutable field in a generated body. Filenames are
cosmetic — the frontmatter `id` is the identity, so renamed notes stay
connected.

This page describes the persisted schema for people inspecting, scripting, or
repairing records by hand. Validation of hand edits happens only when the
integrity check runs; write it, then run **Run clinical data integrity check**.

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
| `mrn` | Digits as entered; leading zeroes preserved. Matching uses a normalized key, so `0012345` and `12345` are one patient. |
| `mrn_status` | `confirmed` · `missing` · `unconfirmed` |
| `patient_name`, `phone` | Display values; phone keeps only digits and a leading `+`. |
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
| `next_action` / `due_date` | Mirror of the most imminent **open** task — not free fields. Cleared when nothing is outstanding. |
| `opened_at` / `closed_at` / `outcome` | Lifecycle bookkeeping; `outcome` survives restore. |
| `pathway_before_archive` / `status_before_archive` | What archiving overwrote, so restore can put it back. |

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
| `due_date` | Bare `YYYY-MM-DD` or empty. |
| `owner` | Optional free text. |
| `completed_at` / `cancelled_at` / `cancel_reason` | Closure bookkeeping. |
| `repeat_every_days` | `0` or absent = one-off. When positive, *completing* the task raises the next occurrence that many days after its due date; *cancelling* ends the series. |
| `idempotency_key` | 32-bit hash of (episode, task, due date) used for duplicate suppression. Never trusted alone: every match also compares the underlying fields, so hand-editing a task does not confuse it with another. Rescheduling recomputes it, so it always names the current fields. |

## Procedure

| Field | Notes |
|---|---|
| `procedure` | The operation performed (not the booked case). |
| `procedure_date` | Bare date, required and validated before any write. |
| `role` | `Primary surgeon` · `Assistant surgeon` · `Supervisor` · `Observer` |
| `status` | `completed` · `cancelled` · `entered-in-error` — the plugin only creates `completed`. |
| `outcome` | Optional short outcome. |
| `follow_up_required` / `follow_up_date` / `follow_up_plan` | A required follow-up creates a `postop-follow-up` task; contradictions are flagged by the integrity check. |
| `audit_pending` | `true` until the completion audit event is durably written; retries settle it. |
| `idempotency_key` | Same rules as tasks. |

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

Items without a `task` value, or with unrecognised types and priorities, are
dropped or defaulted rather than guessed at.

## Patient lists

**Export patient list** (Patients → Export list, More → Export patient list,
or the command palette) writes one file into the `Documents` folder listing
every episode that matches the chosen filter:

| Filter | Choices |
|---|---|
| Care setting | Any · `inpatient` · `outpatient` |
| Pathway | Any · any pathway value above |
| Priority | Any · `routine` · `urgent` · `emergency` |
| Episodes | Open (`active`, `on-hold`, `ready-to-close`) · one status · every status except `entered-in-error` |

- One row per matching **episode**: a patient with two matching episodes is
  listed twice, because the episode carries the setting, pathway, and
  priority being filtered. Rows are ordered inpatients first, then by
  priority, due date, and patient name.
- Columns: MRN, patient, phone, case, setting, pathway, priority, status,
  next action, due date, opened date, open tasks, overdue tasks.
- **Note (`.md`)** — a Markdown table that opens in Obsidian. Pipes,
  brackets, and angle brackets in clinical text are escaped so they cannot
  break the table or create links.
- **Spreadsheet (`.csv`)** — UTF-8 with a byte-order mark (so Arabic names
  display correctly in Excel), CRLF line endings, every cell quoted, and
  formula-like values (`=`, `+`, `-`, `@`) prefixed with `'` so spreadsheet
  apps cannot evaluate them. Obsidian cannot display a CSV itself: open it
  from your file manager or the iOS/iPadOS Files app. Spreadsheet apps may
  drop leading zeroes from MRN and phone columns unless you import them as
  text. Obsidian Sync copies a CSV only when syncing of other file types is
  enabled.

Like the handover note, a patient list contains identifiers by design, stays
inside the clinical folder, is not a managed record, and should be deleted
after use. A name collision gets a numeric suffix; nothing is overwritten.

## Handover notes

**Generate ward handover note** writes one Markdown note into the `Documents`
folder listing active inpatients and the overdue and due-today work. It
contains identifiers by design, lives inside the clinical folder like every
other record, and should be deleted after use. It is a convenience copy, not
a managed record: the integrity check does not track it.

## Editing records by hand

Safe, with care:

- Keep enum values exactly as listed above — unknown values are flagged and
  the affected workflows fail closed.
- Dates are bare `YYYY-MM-DD`; timestamps are UTC ISO.
- Never duplicate an `id`, and never reuse one across entities.
- After any external edit or import, run the integrity check. It detects
  unreadable notes, unknown values, duplicate MRNs and ids, orphaned records,
  wrong-chart filings, contradiction states, and audit-trail gaps.
