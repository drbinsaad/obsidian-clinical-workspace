# Everyday use

Short recipes for the jobs you do every day. Every example uses synthetic data:
9000-series MRNs and made-up names. Screens and button names match the current
release; Obsidian's own menus can vary slightly by version.

- New here? Start with the [five-minute synthetic quick
  start](../README.md#five-minute-synthetic-quick-start) in a test vault.
- Privacy and security limits are in [Security and privacy](../SECURITY.md).
  Read them before storing real patient information.

## Where things are

Open the workspace with the stethoscope icon (**Open Clinical Workspace**) or
the **Clinical Workspace: Open workspace** command. On iPhone and iPad the
icon is in Obsidian's mobile **Open menu**. You can also put any command on the
mobile toolbar; see [Quick Entry and mobile shortcuts](quick-entry.md).

The header has three buttons: **Search** (magnifier), **Quick entry**, and
**Refresh**. Below it are five tabs:

| Tab | Use it for |
|---|---|
| **Today** | Ward round, overdue work, today, the next 7 days, and work with no date. |
| **Patients** | Active episodes as cards, split into Inpatients and Outpatients. Filter chips, **Add patient** and **Export list**. |
| **Tasks** | Every open task, with priority and task-type filter chips. |
| **Surgery** | OR bookings, the surgery logbook, and logbook counts. |
| **More** | Database views, patient records (identity and merge), archive, patient lists, handover, and the integrity check. |

Long lists show 40 items per page with **Previous** and **Next** at the bottom.
Changing a filter chip starts the list again at page 1.

## How do I do a ward round on my iPhone?

1. Open the workspace and tap the **Today** tab, or choose **Quick entry →
   Today's pending work**.
2. The **Ward round** section lists your inpatients, emergency first, then
   urgent, then routine. Each row shows the MRN, name, case, priority and the
   next action with its due date.
3. Tap **View** to open the patient sheet. It shows the patient's episodes,
   **Open work** (with **Complete** and **Reschedule**), **Recently closed**
   tasks (with **Reopen**), procedures, and recent history in your local time.
   **Open** shows the episode note itself.
4. Below the ward round, work through **Overdue** (with how many days late),
   **Today**, **Next 7 days** and **No date set**. Overdue, Today and No date
   set are sorted by priority first.

Each task card has **Complete**, **Reschedule**, **+ Task**, **Open**, and a
red **Cancel**.

On any episode card (Patients, Surgery, Archive), tap the patient line — the
MRN and name with a small arrow — to open the same patient sheet.

## How do I add a patient?

1. On iPhone, go to **Patients** and tap **Add patient**. On desktop, use the
   round **+** button in the bottom corner of the workspace. From anywhere, use
   **Quick entry → New patient / episode**.
2. Fill in the **Add patient** form:
   - **MRN** (numbers only; leading zeros are kept) or **Patient name** — at
     least one is required.
   - **Phone** (leave blank to store NFN).
   - **Case / reason** (required).
   - **Care setting**, **Pathway**, **Priority** (defaults come from
     Settings).
   - **Next action** and **Due date**. A task is created only when you type a
     next action. OPD Follow-Up, Result / Image Review and Consultation need
     both.
3. Tap **Create patient episode**.

If the MRN already belongs to a patient with the same name, the episode is
added to that patient: "Episode added to an existing patient record (matched
by MRN)." If that patient already has an active episode with the same case,
nothing new is created and the existing episode is kept.

### "Check the MRN"

This appears when the MRN you typed is already recorded for a patient with a
**different name**. It usually means a one-digit slip. The dialog shows the
stored patient's name, MRN and phone.

- **Go back and check the MRN** (the default) returns to your filled form with
  the cursor in the MRN field. Nothing was saved.
- **Use this patient** adds the episode to that stored patient and keeps the
  stored name. Fix a wrong name later with **More → Patient records → Edit
  identity**. If Sync moved the MRN to another patient while the dialog was
  open, it asks again about that patient.

Names are compared ignoring capital letters and Arabic spelling variants. A
blank name on either side is not a conflict; the missing name is filled in.

### "Possible duplicate patient"

This appears when you typed **no MRN** and a patient with the same name
already exists, or when you typed an MRN nobody holds yet and a same-name
patient has **no MRN** recorded.

- **Use this patient** on the right card adds the episode to that record. If
  you typed an MRN, it is recorded on that chart (the card says so).
- **Create separate patient** makes a new patient record.
- **Cancel** returns to your filled form. Nothing was saved.

## How do I add, complete, undo, or reschedule a task?

**Add.** Tap **+ Task** on an episode card (Patients tab) or on any task card,
or use **Quick entry → Add task / follow-up** and tap **Use this episode** on
the right patient. Fill in **Task**, **Task type**, **Due date**, **Priority**,
**Repeat** and an optional **Owner**, then tap **Add task**. The due date
starts at today, or at the episode's planned date if that is later. Priority
starts at the episode's priority.

**Complete.** Tap **Complete** on a task card or in the patient sheet. A
notice says "Task completed." with an **Undo** button for about 9 seconds.
Undo works from any tab. If the task had already been completed, for example
on your other device, the notice says so and has no Undo.

**Reopen later.** Open the patient sheet (**View**) and tap **Reopen** under
**Recently closed**. A task on an archived episode cannot be reopened until the
episode is restored.

**Reschedule.** Tap **Reschedule**. The date starts at tomorrow; pick a date
or a chip and tap **Reschedule**. The task keeps its wording, priority and
owner. The notice says "Task moved to" the new date, or "Date unchanged."

**Cancel.** Tap the red **Cancel**, give a reason, and tap **Cancel task**.
The task stays in the record as cancelled and no longer blocks discharge.

Completing the last open task of an episode marks the episode ready to close.

## How do recurring tasks work?

Set **Repeat** when adding a task: Weekly, Every 2 weeks, Monthly (30 days),
Every 3 months, Every 6 months, or Yearly. A repeating task needs a due date.
Its card shows a **Repeats** badge.

- **Completing** it creates the next one: the due date plus the interval. If
  that date has already passed because you completed it late, it moves forward
  by whole intervals to the first date on or after today. Example: a weekly
  task due 2026-09-01 and completed on 2026-09-12 comes back on 2026-09-15,
  not on the already-overdue 2026-09-08.
- **Undo** (or **Reopen**) after completing withdraws the next occurrence it
  created: "Task reopened. Its next occurrence was withdrawn." If you had
  already changed that next occurrence, it is left open and the notice says
  so.
  If a later occurrence was already completed, Undo and Reopen are refused,
  so the series never ends up with two open copies.
- **Cancelling** a repeating task ends the series.

## How do I update an episode?

Tap **Update** on the episode card. The **Update patient workflow** form has
**Care setting**, **Pathway**, **Priority**, **Next action** and **Due date**.
Tap **Save changes**.

- **Change only the date** of the next action: the existing task moves to the
  new date and keeps its type, owner, priority and repeat. "Task moved to" the
  new date.
- **Change the wording** of the next action: a new task replaces the old one,
  which is cancelled as superseded. The new task keeps the task type, owner
  and repeat. If you also changed the pathway, it is new work instead: it gets
  the new pathway's task type, no owner and no repeat.
- **Clear** the next action: no task is added; the card shows the next open
  task, if any.
- **Raise the priority**: open tasks with a lower priority are raised too, for
  example "2 open tasks raised to Urgent." Lowering the priority never lowers a
  task.
- **Discharge Ready** marks the episode ready to close once no work is open.

The **Next** line and date on the card always show the soonest open task. They
are blank when nothing is open. If the episode changed on another device after
you opened the form, saving is refused; close the form and open it again.

## How do I discharge a patient?

1. Tap the red **Discharge** on the episode card.
2. Check **Outcome / reason** (it starts as "Discharged").
3. If the episode still has open tasks, the form lists them. Either complete
   them first, or tick **Cancel these N open tasks (reason: Closed at
   discharge)**. The tick is off by default, and **Archive episode** stays
   unavailable until you tick it or the tasks are closed. Each cancelled task
   keeps its own audit entry.
4. If **Confirm before discharge** is on in Settings, type `DISCHARGE`.
5. Tap **Archive episode**.

If new work was added to the episode (for example by Sync) while the form was
open, the discharge is refused and nothing is cancelled. Close the form and
open **Discharge** again to review it.

If one of the episode's tasks is filed under a different patient (Sync can
leave one behind after a merge), a discharge that cancels open tasks is
refused and nothing is cancelled. Run **Run clinical data integrity check**,
repair the task it lists, then discharge again.

Archived episodes are listed under **More → Archive**. **Restore** brings one
back with its previous pathway and keeps its outcome. Restore is refused if the
same case is already active again for that patient; open the active episode
instead.

## How do I make a handover note?

Go to **More → Ward handover → Generate handover**, or run **Clinical
Workspace: Generate ward handover note**. The note opens straight away and is
saved in the clinical `Documents` folder as `Handover` plus today's date. It
has these sections:

- **Inpatients**: every active inpatient, emergency first.
- **Overdue and due today**, **Due tomorrow**, **No date set**: open tasks for
  all patients, inpatient and outpatient, emergency first and then by date.
  Each line shows the task, patient, case, priority and due state.
- **Counts**: active episodes and open tasks.

The note contains patient identifiers. Check it against the ward list, share it
only through an approved route, and delete it after use.

## How do I find a patient?

Tap the magnifier in the header, or run **Clinical Workspace: Search clinical
records**. Type at least two characters.

- Search by name, MRN, case, task or procedure wording.
- A patient's name or MRN also finds their episodes, tasks and procedures.
  Every row names its patient.
- A full MRN matches with or without leading zeros: `90000077` finds a patient
  stored as `0090000077`, and the other way round.
- Arabic names match across common spelling variants:
  - hamza forms of alef (أ / إ / آ) match bare alef (ا);
  - ta marbuta (ة) matches ha (ه), and alef maqsura (ى) matches ya (ي);
  - ؤ matches و, and ئ matches ي;
  - diacritics (tashkeel) and tatweel are ignored.
- Arabic-Indic digits typed on the iPhone keyboard work like 0–9.
- Each group shows up to 8 results. "+N more — refine your search" means more
  matched; type more letters.

Tap a patient to open the patient sheet. A patient who is archived, merged or
entered in error opens their note instead. Other rows open their note.

## How do I list or export patients of any type?

Use **Patients → Export list**, **More → Export patient list**, or **Clinical
Workspace: Export patient list**.

1. Choose **Care setting**, **Pathway**, **Priority** and **Episodes** (open,
   active, on hold, ready to close, archived, cancelled, or every status). The
   form shows how many episodes and patients match.
2. Choose the **Format**: a note in this vault, or a spreadsheet file (`.csv`).
3. Tap **Create patient list**.

Starting from **Patients → Export list** pre-selects the pathway and priority
chips you are viewing. The file is saved in the clinical `Documents` folder and
named after the filter, never after a patient. A note opens straight away.

Obsidian cannot show a CSV. On iPhone, open the **Files** app, browse to your
vault's clinical folder, then `Documents`, and open the file in Numbers or
Excel. MRNs and phone numbers that start with 0 or are long get a leading
apostrophe, so spreadsheets keep every digit instead of dropping leading zeros
or rounding. Most spreadsheet apps show that apostrophe in the cell: remove it
before you copy an MRN into another system.

The list contains identifiers. Share it only through an approved route and
delete it after use. Column details are in [Patient
lists](data-model.md#patient-lists).

## How do I log a procedure?

**From an OR booking.** On **Surgery**, find the booking under **OR booking**
and tap **Complete surgery**. Or use **Quick entry → Record procedure** and tap
**Use this episode**.

1. **Surgery / procedure**: the operation performed. It starts blank because
   it can differ from the booked case.
2. **Surgery date** (today by default), **Your role**, optional **Outcome**.
3. Turn on **Follow-up required** to add a **Follow-up date** and **Follow-up
   plan**.
4. Tap **Complete surgery**.

The procedure joins the logbook, and open OR-booking tasks (task type
`book-or`) are completed. With follow-up, the episode moves to OPD Follow-Up
with a post-op follow-up task. Without it, the episode moves to Discharge
Ready and is ready to close once no other work is open.

**Add another procedure.** For a second procedure from the same operation or a
return to theatre on an episode that has already moved on from OR booking:

- On **Surgery → Surgery logbook**, tap **Add another procedure** on that
  episode's newest entry, or
- use **Quick entry → Record procedure**. Such episodes say "A procedure is
  already logged here; this adds another." and have an **Add another
  procedure** button.

Fill in the form and tap **Log procedure**. The notice says "Procedure added to
the logbook." The episode's pathway stays as it is and no OR-booking task is
completed, even if the episode was put back on OR booking while the form was
open. With follow-up off, its status, next action and due date stay as they
are too. Turning on follow-up adds a follow-up task like any other: it
becomes the episode's next action if it is due first, and an episode that was
ready to close becomes active again.

Each form adds its own entry, even with the same procedure and date as an
earlier one, such as a second lesion excised the same day. If **Log
procedure** shows an error, tap it again on the same form without changing
anything: retrying the same form is safe and never adds a second entry. If the
entry was already saved before the error, it keeps the details it was saved
with: a retry does not apply a changed role or outcome, and one with different
follow-up details is refused. To correct a saved entry, open it from the
**Surgery logbook**. A new form always adds a new entry, so if you cancelled a
form that showed an error, check the **Surgery logbook** before entering that
procedure again. A procedure whose save stopped part-way is listed by the
integrity check as `unfinished-procedure`; check that episode's follow-up task.

The **Surgery** tab counts completed procedures: total, this month, as primary
surgeon, and awaiting OR, plus a breakdown by procedure. The **Surgery** database
view under **More** lists completed procedures; cancelled or entered-in-error
ones are in its **Retracted** view (unless you have customised that view).

## How do I use task templates?

A template adds a standard set of tasks to an episode in one step, for example
consent, OR booking and post-op review.

1. In your clinical folder, open `Templates` and create a note. Give it this
   frontmatter:

   ```yaml
   ---
   clinical_template: task-bundle
   template_name: Tonsillectomy pathway   # optional; defaults to the note name
   pathway: or-booking                    # optional; omit to offer everywhere
   tasks:
     - task: Confirm consent
       task_type: clinical-review         # optional; defaults to other
       due_in_days: 1                     # optional; omit for no due date
     - task: Book operating room
       task_type: book-or
       priority: urgent                   # optional; defaults to the episode's
   ---
   ```

2. On **Patients**, tap **Template** on the episode card.
3. Check the preview. Each task shows its type, priority and due date.
4. Tap **Apply template**. An identical open task (same wording and due date)
   is kept, not duplicated, so applying twice is safe.

Only templates for the episode's pathway, or with no pathway, are offered.

**Spelling.** Capital letters and spaces around a value are ignored, so
`Book-OR` and `Urgent` work. The words themselves must still match:
`book-or`, not `book or`. Task types are `clinical-review`, `call-patient`, `review-result`,
`book-or`, `postop-follow-up`, `consultation`, `wound-care`, `medication` and
`other`. `due_in_days` is a whole number of days from 0 to 730; `3`, `"3"` and
Arabic-Indic digits all work.

**Warnings.** If something was skipped or defaulted, the preview lists it
under "Check this template:". For example: an item with no task text is
skipped; an unknown task type becomes "other"; an unknown priority uses the
episode's; a bad `due_in_days` leaves the task undated; an unknown pathway
offers the template for every episode. A template with no usable task is not
offered at all. More detail is in the [data model
reference](data-model.md#task-bundle-templates).

## The workspace says read-only — what do I do?

Clinical Workspace pauses editing whenever it cannot be sure your records are
complete, for example while Sync is still delivering notes. Nothing is lost.
You can still read, search, open notes and patient sheets, and run the
integrity check.

While editing is paused, a banner at the top says **Editing is paused** and
why. It may add "The records shown may be incomplete until this is resolved."
It has a **Recheck now** button, and it disappears by itself once editing is
available again. Forms such as Add patient, + Task and Export list do not open
while it is shown.

1. **Let Sync finish.** Keep Obsidian open on this device (and the other one)
   for a minute. If you just typed in a record note, the recheck runs by itself
   a moment after you stop typing.
2. **Tap Recheck now**, or run **Clinical Workspace: Recheck records and
   unlock editing**. If everything checks out, the banner disappears and a
   notice confirms it, for example "Clinical Workspace rechecked its records.
   Editing is available again." If not, the notice says why.
3. **If it mentions a note that is not a valid record, or cannot be read**,
   run **Clinical Workspace: Run clinical data integrity check**. Tap **Open
   record** on each issue, fix or move the note, then recheck.
4. **If it still says a review is needed**, run **Clinical Workspace: Confirm
   current records as the recovery baseline**. It shows the records you have
   now next to the ones previously trusted. If it warns that there are fewer,
   restore the missing notes from Sync version history or File recovery first.
   Type `ADOPT` only when the records shown are complete.

**"Try again in a few seconds."** Clinical Workspace is applying changes from
your other device. Wait, then repeat what you were doing.

**The workspace will not open at all.** It stays closed while a clinical-folder
move is still arriving through Sync ("Clinical Workspace cannot open yet"),
when the clinical folder is missing, or on first use before you initialize it.
Let Sync finish and run **Recheck records and unlock editing**, or **Initialize
new workspace** on first use. For folder moves, read [Moving the clinical
folder safely](folder-migration.md).

**What the integrity check shows.** The check always opens a report. When
nothing is found it says "Configured checks passed" with the number of check
families and records examined. Otherwise each issue has **Open record**. **Show
identifier-free summary** gives issue codes and counts you can paste into a
bug report. What each new issue means is in the [data model
reference](data-model.md#integrity-check-findings).

## Forms on iPhone

- **Return** moves to the next field. It saves only from the form's last
  field, and only when that is a text field; the keyboard's Return key reads
  "next" or "done" to match. Forms that end with a date, such as **Add
  patient** and **Update patient workflow**, save only with their button. On a
  hardware keyboard, Ctrl+Return or Cmd+Return saves from any field.
- Date fields have chips: **Today**, **+1d**, **+2d**, **+1w**, **+2w**, **+1m**
  (30 days) and **+3m** (90 days). A due or follow-up date in the past shows
  "This date is in the past." before you save.
- MRN, name, phone and owner fields have autocorrect and autofill turned off,
  so the keyboard does not "correct" a name.
- If a form is refused, everything you typed stays in it. Fix the problem and
  try again.

## All commands

Run commands from the Command palette (they start with **Clinical
Workspace:**), give them hotkeys in **Settings → Hotkeys**, or add them to the
mobile toolbar. No command has a default hotkey.

| Command | What it does | When it is listed |
|---|---|---|
| **Open workspace** | Opens the workspace (read-only while editing is paused). | Always |
| **Quick entry** | Opens the Quick entry hub. | Always |
| **Quick entry: new patient / episode** | Opens a blank Add patient form. | Always |
| **Quick entry: add task / follow-up** | Asks you to choose an episode, then opens a blank task form. | Always |
| **Quick entry: record procedure** | Asks you to choose an OR booking, or an episode with a logged procedure, then opens the procedure form. | Always |
| **Open today's pending work** | Opens the **Today** tab, freshly read from the vault. | Always |
| **Search clinical records** | Opens search. | Always |
| **Export patient list** | Opens the patient-list export form. | Always |
| **Generate ward handover note** | Writes and opens today's handover note. | Always |
| **Run clinical data integrity check** | Checks your records and shows a report. Works while read-only. | Always |
| **Remove identifiers from generated note bodies** | One-time tidy-up for patient notes created before version 0.5: rewrites only untouched generated note bodies so they no longer repeat the name, MRN and phone. Asks you to type `REWRITE`. | Always |
| **Initialize new workspace** | First-use setup: adopt the records already in the folder or start a new workspace. | Only before the workspace is initialized, or while an approved initialization is unfinished and no baseline review is needed |
| **Recheck records and unlock editing** | Rechecks the records and reopens editing when they are complete. Same as the banner's **Recheck now**. | Only while editing is paused for a recheck, a Sync verification, a review, or a folder move |
| **Confirm current records as the recovery baseline** | Accepts the current records as complete after you have checked them. Asks you to type `ADOPT`. | Only while editing is paused or a review is pending |

Commands that open a form or write a file (new patient, task, procedure,
export, handover) stay listed while editing is paused, but they stop with a
notice instead of collecting input that cannot be saved.

"Recheck records and unlock editing" was called "Retry pending folder move
recovery" before. Its internal id did not change, so existing hotkeys and
toolbar buttons keep working.

The ribbon also has **Open Clinical Workspace** and **Clinical Workspace quick
entry**. Development builds add two commands starting with "Development:";
they are not in released versions.
