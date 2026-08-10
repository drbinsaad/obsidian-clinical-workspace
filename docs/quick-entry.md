# Quick Entry, hotkeys, and mobile shortcuts

Clinical Workspace Quick Entry opens a blank action flow without moving
identifiers or clinical text through a keyboard shortcut, mobile toolbar
configuration, or URL.

## Available commands

Open **Settings → Hotkeys**, search for `Clinical Workspace`, and assign your
own keyboard combinations if wanted. The plugin intentionally provides no
default hotkeys, so it cannot replace an existing Obsidian or operating-system
shortcut.

| Command | Result |
|---|---|
| **Quick entry** | Opens the action hub. |
| **Quick entry: new patient / episode** | Opens a completely blank patient and Episode form. |
| **Quick entry: add task / follow-up** | Opens an Episode chooser, then a blank task form. |
| **Quick entry: record procedure** | Opens an eligible active **OR booking** Episode chooser, then a blank procedure form. |
| **Open today's pending work** | Opens the Today view with overdue, due-today, and undated tasks refreshed from the vault. |

Every command passes through the same initialization, Sync-recovery, and
folder-migration barriers as the main workspace. A shortcut cannot make a
blocked workspace writable.

## iPhone and other mobile devices

The workspace header includes a 44-pixel **Quick entry** control. The plugin
also registers a separate **Clinical Workspace quick entry** ribbon action in
addition to **Open Clinical Workspace**. Obsidian shows ribbon actions in the
desktop ribbon and in the mobile **Open menu**; a ribbon action is not itself a
mobile-toolbar placement.

To keep Quick Entry on the mobile toolbar:

1. Open **Settings → Mobile → Manage toolbar options**.
2. Scroll to the bottom and choose **Add global command**.
3. Search for `Clinical Workspace`, select **Quick entry** or one of the
   individual commands, and arrange it where it is easy to reach.

The exact toolbar-management wording can vary with the installed Obsidian
version. The commands are also available through the mobile Command palette.

Before release, record the physical-device checks in the
[manual iPhone Quick Entry checklist](manual-iphone-release-checklist.md).

## Explicit Episode context

Task and procedure actions never choose an Episode automatically. They first
show a searchable picker containing the visible patient label, case, care
setting, and pathway. Task entry can use any active usable Episode; procedure
entry retains the existing Surgery workflow boundary and offers only active
Episodes on the **OR booking** pathway. The user must tap **Use this episode**
before the blank entry form opens.

If no eligible OR booking exists, procedure Quick Entry does not broaden the
workflow or write a logbook record. Update the intended Episode to the OR
booking pathway through the ordinary, visible Episode workflow first.

If the currently active Markdown file is an Episode that Clinical Workspace
already found inside its configured Episodes folder, that row is promoted and
labelled **Current episode**. It is still unselected and requires an explicit
**Confirm current episode** tap. An arbitrary note, stale active file, renamed
path that no longer matches a managed Episode, or identifier supplied from
outside the plugin is never trusted as context.

## Parameter-free Obsidian links

These links can be used with an iPhone Apple Shortcut **Open URLs** action or
another trusted local launcher:

```text
obsidian://clinical-workspace-quick-entry
obsidian://clinical-workspace-new-patient-episode
obsidian://clinical-workspace-add-task-follow-up
obsidian://clinical-workspace-record-procedure
obsidian://clinical-workspace-today
```

They contain only a fixed action name. Do not add query parameters. Clinical
Workspace rejects the complete invocation if it contains *any* parameter,
including `patient`, `mrn`, `episode`, `id`, `file`, `path`, `note`, `text`,
`content`, or `vault`. Values are not read, copied into a form, echoed in the
rejection notice, persisted, or logged.

Because `vault` is deliberately not accepted, open or focus the intended vault
before launching one of these links. Do not use a parameter-bearing generic
Obsidian `new`, `open`, or `search` link as a replacement: those actions can
place file names, paths, search terms, or content in shortcut history and
cross-app logs.

An action-only link opens the hub, picker, or blank form. The user still has to
enter and submit every value inside Clinical Workspace. No URL performs a
clinical write.

## Apple Shortcut checklist

1. Create a personal shortcut with a single **URL** value copied exactly from
   the list above.
2. Add **Open URLs**.
3. Give the shortcut a neutral name such as `Clinical quick entry`; never put a
   patient name, MRN, case, note path, or clinical detail in the shortcut name,
   icon text, URL, notification, or Siri phrase.
4. Test it with synthetic records in a disposable vault before considering it
   for an approved clinical environment.

Apple Shortcuts, Siri, notifications, device backups, and automation history
are separate trust boundaries. Action-only links reduce exposure; they do not
make those systems approved for patient data.
