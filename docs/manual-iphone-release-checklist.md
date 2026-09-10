# Manual iPhone Quick Entry release checklist

Complete this checklist on a physical iPhone with unmistakably synthetic data
before publishing a release that changes Quick Entry. This document is an empty
test record, not evidence that the checks have been performed.

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
  picker; procedure Quick Entry shows only active OR-booking Episodes.
- [ ] Opening from a managed Episode note promotes **Current episode** but still
  requires **Confirm current episode**.
- [ ] The iOS keyboard does not hide the search results or action controls;
  results and the modal remain vertically scrollable in portrait orientation.
- [ ] Cancelling the picker and cancelling each form writes nothing.
- [ ] Submitting one synthetic task and one synthetic procedure writes each
  record once, refreshes the intended view, and does not silently select a
  different Episode.

## Safety barriers

- [ ] In an uninitialized vault, every Quick Entry command and URL stops at the
  normal initialization flow and writes nothing before explicit initialization.
- [ ] With folder migration or Sync recovery deliberately left unresolved,
  every Quick Entry command and URL shows the normal blocked/recovery behavior
  and creates or changes no clinical record.

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
