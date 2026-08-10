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

## Sign-off

- Result: [ ] Pass  [ ] Fail
- Failed check(s) / issue link: ______________________________________________
- Tester signature: ____________________
- Release approver: ____________________
- Approval date: ____________________
