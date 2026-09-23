# Manual iPhone Quick Entry release checklist

Complete this checklist on a physical iPhone with unmistakably synthetic data
before publishing a release that changes Quick Entry, forms, or the everyday
workflows in the [Everyday use guide](user-guide.md). This document is an
empty test record, not evidence that the checks have been performed.

- Plugin version/build: ____________________
- Obsidian version: ____________________
- iOS/device: ____________________
- Disposable vault: ____________________
- Tester: ____________________
- Test date: ____________________

## Access and commands

- [ ] Search, Quick Entry, and Refresh stay on one non-overlapping header row;
  every control has a readable label or accessible name and a 44-pixel target.
- [ ] Today, Patients, Tasks, Surgery, and More are all visible at the default
  text size. At enlarged text, no label is clipped and every tab remains
  reachable by scrolling.
- [ ] The **Clinical Workspace quick entry** ribbon action appears in the
  mobile **Open menu** and opens the hub.
- [ ] Under **Settings → Mobile → Manage toolbar options**, scrolling to the
  bottom and choosing **Add global command** makes the hub and each individual
  Clinical Workspace command searchable and placeable on the toolbar. Exact
  labels may vary by Obsidian version.
- [ ] The 44-pixel workspace-header **Quick entry** button opens the hub.
- [ ] The hub opens each action: new patient/Episode, add task/follow-up,
  record procedure, and today's pending work.
- [ ] Each individual command opens the same intended flow directly.

## Action-only links

Open each exact URL from Apple Shortcuts **Open URLs**:

- [ ] `obsidian://clinical-workspace-quick-entry`
- [ ] `obsidian://clinical-workspace-new-patient-episode`
- [ ] `obsidian://clinical-workspace-add-task-follow-up`
- [ ] `obsidian://clinical-workspace-record-procedure`
- [ ] `obsidian://clinical-workspace-today`
- [ ] Adding any query parameter, for example `?patient=synthetic`, rejects the
  complete invocation without echoing its value or opening a form.

## Picker and forms

- [ ] Surgery summary cards form a two-by-two grid in portrait; Patient and Task
  actions use compact columns without clipping their labels.
- [ ] The labelled **Add patient** action appears in Patients only and never
  covers a card, action, scrollbar, keyboard, or Obsidian's mobile toolbar.
- [ ] Quick Entry options are evenly packed near the heading rather than spread
  across the full sheet, and the native close control remains below the status
  area without covering text or controls.
- [ ] Search covers threshold, no-match, capped-result, clear, and reopen states;
  its polite status announcement describes the number of results shown.
- [ ] Task Quick Entry shows the searchable, initially unselected Episode
  picker; procedure Quick Entry shows only active OR-booking Episodes and
  active Episodes that already have a logged procedure.
- [ ] Search and the picker find a synthetic patient by an Arabic spelling
  variant, by Arabic-Indic digits, and by a full MRN typed with or without
  leading zeros. A patient search also lists that patient's episodes, tasks,
  and procedures, and choosing the patient opens the patient sheet.
- [ ] Opening from a managed Episode note promotes **Current episode** but still
  requires **Confirm current episode**.
- [ ] The iOS keyboard does not hide the search results or action controls;
  results and the modal remain vertically scrollable in portrait orientation.
- [ ] Cancelling the picker and cancelling each form writes nothing.
- [ ] Submitting one synthetic task and one synthetic procedure writes each
  record once, refreshes the intended view, and does not silently select a
  different Episode.
- [ ] In **Add patient**, **Add patient task**, and **Complete surgery**, the
  keyboard's Return key reads "next" on every text field except one that is
  the form's last field, where it reads "done" (**Owner** in **Add patient
  task**). Tapping Return after the procedure name moves to the next field and
  does not log the surgery; tapping Return after **Next action** in **Add
  patient** moves to **Due date** and saves nothing. Only Return in that last
  field (or the Submit button) saves.
- [ ] With **Follow-up required** turned on, **Follow-up plan** becomes the last
  text field and its Return key saves.
- [ ] Due-date and follow-up-date fields show **Today**, **+1d**, **+2d**,
  **+1w**, **+2w**, **+1m**, and **+3m** chips that fit without clipping and
  set the expected date. Choosing a past date shows "This date is in the
  past." A new task starts at today; **Reschedule** starts at tomorrow.
- [ ] Procedure Quick Entry lists an Episode that already has a logged
  procedure with **Add another procedure**; saving it adds a logbook entry and
  leaves the Episode's pathway and next action unchanged.

## Everyday workflows

- [ ] **Complete** on a task shows "Task completed." with an **Undo** button
  that stays tappable for about 9 seconds above the keyboard and toolbar.
  **Undo** reopens the task. For a weekly repeating task, **Undo** reports that
  the next occurrence was withdrawn and it disappears from the list.
- [ ] **Discharge** on an Episode with open tasks lists them, the **Cancel
  these N open tasks** checkbox starts unticked, **Archive episode** is
  disabled with an explanation, and ticking the box enables it. Archiving then
  cancels those tasks with the reason "Closed at discharge".
- [ ] Ward-round **View** opens the patient sheet; **Complete** and
  **Reschedule** there work and the sheet closes first.
- [ ] **Add patient** with a synthetic 9000-series MRN already recorded under a
  different synthetic name shows **Check the MRN**. **Go back and check the
  MRN** returns to the filled form with the cursor in the MRN field and saves
  nothing.
- [ ] **Patients → Export list** with **Spreadsheet file (.csv)** saves a CSV
  in the clinical `Documents` folder and shows a notice without any patient
  identifier. The CSV opens from the iOS **Files** app in Numbers or Excel
  with Arabic names displayed correctly. Delete the test file afterwards.
- [ ] Export with **Note in this vault (.md)** opens a readable table in
  Obsidian.

## Safety barriers

- [ ] In an uninitialized vault, every Quick Entry command and URL stops at the
  normal initialization flow and writes nothing before explicit initialization.
- [ ] With folder migration or Sync recovery deliberately left unresolved,
  every Quick Entry command and URL shows the normal blocked/recovery behavior
  and creates or changes no clinical record.
- [ ] Editing a synthetic record note by hand shows the **Editing is paused**
  banner at the top of the workspace, readable at the default and enlarged
  text sizes. Lists stay readable, forms refuse to open with a notice, and
  the banner clears by itself a moment after the edit is saved. If it does
  not, **Recheck now** clears it and reports "Editing is available again."
- [ ] **Run clinical data integrity check** opens its report while the banner
  is shown.

## Device and presentation matrix

- [ ] iPhone portrait and landscape; default and enlarged text.
- [ ] iPad portrait, landscape, and narrow split view.
- [ ] Light and dark appearance; left-to-right and right-to-left interface.
- [ ] VoiceOver announces selected tabs, Search status changes, and contextual
  actions once; external-keyboard focus order and Escape dismissal are correct.

## Sign-off

- Result: [ ] Pass  [ ] Fail
- Failed check(s) / issue link: ______________________________________________
- Tester signature: ____________________
- Release approver: ____________________
- Approval date: ____________________
