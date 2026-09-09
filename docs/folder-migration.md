# Moving the clinical folder safely

Changing **Settings → Community plugins → Clinical Workspace → Clinical
folder** moves the plugin-managed workspace. It is a migration, not a display
preference. Back up the vault first and perform the move only after every device
has finished syncing.

## Before the move

1. Stop clinical edits on every other device.
2. Let the complete vault and plugin settings finish syncing everywhere.
3. Confirm that the current workspace is complete, then run **Clinical
   Workspace: Run clinical data integrity check**.
4. Make a restorable backup of the vault.
5. On one device, enter the proposed folder in the plugin settings and review
   the previewed source, destination, and note count before selecting **Move
   records**.

The destination must be a safe vault-relative folder. Clinical Workspace
rejects traversal segments, a destination that already exists, and a move into
the current folder's own subtree.

## What the plugin moves

Clinical Workspace uses Obsidian's rename operation so links to managed records
are rewritten, including links stored in YAML frontmatter. It then regenerates
the database views that Obsidian does not rewrite automatically. A customised
home note or Base is preserved; only missing or still-untouched generated files
are rebuilt.

The destination and an in-progress marker are saved before the rename. That
marker lets the plugin recover after a restart or interruption instead of
quietly pointing at an empty folder. After the move, the plugin audits managed
notes for links that still name the old root. Any non-zero result—or a link
audit that could not finish—produces a warning; run the integrity check before
continuing.

## Sync and fail-closed recovery

A folder name delivered through Sync is treated as intent, not proof that its
records have arrived. While the available evidence cannot identify one complete
writable root, Clinical Workspace keeps reads on the last safe source and
blocks clinical and scaffolding writes. The recovery state survives restart and
reconciliation is retried when the vault changes.

This applies regardless of delivery order. If settings arrive before the
folder, if the folder rename arrives before settings, or if a final settings
file arrives without the intermediate marker, the plugin preserves or
reconstructs recovery intent instead of activating an unproven root.

After a move settles, `data.json` retains the losing clinical-folder name as a
safety tombstone (up to 64 roots). A delivery into any retired root re-arms the
move marker, including after restart and on another Mac. The device-local
journal stores only one-way fingerprints of these names and refuses to reopen
if an interrupted Sync callback appears to have dropped part of the history.

| Visible state after Sync | Plugin behaviour | What to do |
|---|---|---|
| Destination alone contains the complete expected managed-record count | Settles at the destination and clears the recovery marker. | Wait for the success notice, then run the integrity check. |
| Source alone contains records while settings name the destination | Remains read-only because the destination may still be in transit. | Let Sync finish, then run **Retry pending folder move recovery** to confirm rollback to the source. |
| Both source and destination contain records | Remains read-only instead of choosing one and hiding records from the other. | Inspect both roots, let Sync converge or resolve the duplicate tree deliberately, retry recovery, then run the integrity check. |
| Neither root contains records in a previously record-free workspace | Uses folder presence as evidence only when the old root is gone and the destination exists. | Let Sync finish before retrying. |
| Configured root is missing, externally renamed, empty, or only partly delivered | Keeps the write block in place. | Restore/finish Sync, then retry recovery. |

For a workspace that has previously held records, an empty parent folder or a
single early-delivered file is not convergence. The prior aggregate count of
managed Patient, Episode, Task, and Procedure notes must return before the root
can become writable. This prevents an empty or partial Sync delivery from
manufacturing a second workspace.

After a successful move, wait for both `data.json` and the moved folder to reach
every other device before resuming work there.

## First open after upgrading from before 0.3.6

Older workspaces do not have a trusted aggregate record-count baseline. Their
first open on 0.3.6 or later is intentionally read-only whether the visible root
contains zero, some, or all managed records.

After Sync is fully complete, use **Clinical Workspace: Initialize new
workspace**:

- If managed records are visible and complete, choose **Adopt current
  workspace**.
- Choose **Initialize new workspace** only for a genuinely new or intentionally
  record-free workspace.
- Cancel if any settings or records may still be in transit.

The root, record count, and settings shown at confirmation are checked again
before anything is written. Approval is saved before scaffolding, using a
path-free two-phase state so an interruption can resume safely. If saving that
state fails—or Sync changes the state while the confirmation is open—no folders
are created and the workspace remains read-only.

## Recovery checklist

1. Stop edits and let Sync finish on every device.
2. Do not manually create a replacement clinical tree.
3. Run **Retry pending folder move recovery** on the device showing the notice.
4. If both roots still contain records, reconcile that ambiguity before retrying.
5. Run **Run clinical data integrity check**.
6. Review any notes elsewhere in the vault that link into the moved folder.

Plugin `data.json` stores the visible settings, versioned path-free
initialization/recovery flags, an aggregate managed-file count, and the bounded
retired-root name list described above. It does not store MRNs, patient names,
phone numbers, record IDs, clinical-note paths, or clinical text. For the
complete trust boundary and limitations, see
[Security and privacy](../SECURITY.md).
