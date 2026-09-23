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

A customised Base therefore keeps filtering on the old folder after the move
and shows no records. **Run clinical data integrity check** reports each one as
`stale-base-folder`: open it and change its `file.inFolder(...)` lines to name
the new clinical folder. See [Generated database
views](data-model.md#generated-database-views).

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

What you see depends on the reason editing is paused:

- **A folder move is unfinished.** The workspace does not open ("Clinical
  Workspace cannot open yet"), because either folder may hold only part of the
  records. Let Sync finish, then run **Clinical Workspace: Recheck records and
  unlock editing**.
- **The configured clinical folder is missing.** The workspace does not open
  until the folder is restored or Sync delivers it; then run the same command.
- **Any other pause** (records being rechecked after a change outside the
  plugin, newly synced records being verified, or a review being required).
  The workspace opens read-only with an **Editing is paused** banner and a
  **Recheck now** button. You can read, search, and run the integrity check;
  every write is refused until the recheck succeeds.

**Recheck records and unlock editing** was called **Retry pending folder move
recovery** in earlier versions. Its command id (`retry-folder-move-recovery`)
is unchanged, so existing hotkeys and toolbar buttons still work.

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
| Source alone contains records while settings name the destination | Remains read-only because the destination may still be in transit. | Let Sync finish, then run **Recheck records and unlock editing** to confirm rollback to the source. |
| Both source and destination contain records | Remains read-only instead of choosing one and hiding records from the other. | Inspect both roots, let Sync converge or resolve the duplicate tree deliberately, run **Recheck records and unlock editing**, then run the integrity check. |
| Neither root contains records in a previously record-free workspace | Uses folder presence as evidence only when the old root is gone and the destination exists. | Let Sync finish before rechecking. |
| Configured root is missing, externally renamed, empty, or only partly delivered | Keeps the write block in place. | Restore/finish Sync, then run **Recheck records and unlock editing**. |

For a workspace that has previously held records, an empty parent folder or a
single early-delivered file is not convergence. The prior aggregate count of
managed Patient, Episode, Task, and Procedure notes must return before the root
can become writable. This prevents an empty or partial Sync delivery from
manufacturing a second workspace.

After a successful move, wait for both `data.json` and the moved folder to reach
every other device before resuming work there.

## Two devices adding records

Ordinary use on a phone and a desktop means both devices add Patient, Episode,
Task, and Procedure notes on top of the same shared set, often before Sync has
caught up. Each device keeps a device-local, one-way witness of the record
identities it has trusted. When Sync delivers another device's `data.json`
whose baseline differs from this device's (a higher count, an equal count with
a different digest, or an older lower snapshot arriving late), the delivered
baseline is staged as evidence rather than adopted or rejected:

- Writes pause with the "verifying newly synced records" notice, and the
  workspace shows its read-only banner.
- Once the record files have finished arriving, the plugin checks that every
  record this device trusted is still on disk, that no entity class shrank,
  that every note in the record folders parses, and that the disk holds at
  least the highest record count any synced baseline announced.
- If so, the grown set becomes the trusted baseline and writes reopen
  automatically. No `ADOPT` is needed on either device.

Only a record that vanished or was replaced keeps the workspace read-only. A
synced baseline that has fully arrived and omits a record this device trusted
is a genuine conflict and requires **Confirm current records as the recovery
baseline** (typed `ADOPT`). The confirmation shows the previously trusted
counts beside the current ones and warns when any count dropped; restore
missing notes from Sync version history or File recovery before adopting a
smaller set. If Sync has finished and the workspace is still read-only, run
**Recheck records and unlock editing** (or tap **Recheck now** in the banner);
it applies the same rule and reports why the current records cannot be
accepted.

The "needs review" state itself follows the same rule. A review flag saved by
an earlier version, or delivered in another device's `data.json` while that
device was still locked, is a comparison this device can redo: the next
startup, Sync delivery, workspace open, or explicit Retry re-runs the membership
proof and clears the flag when every record this device trusted is still on
disk and every note parses. The cleared flag is then what Sync carries to the
other device, so a stale lock does not bounce between devices. Explicit Retry
here means **Recheck records and unlock editing**. Typed `ADOPT`
remains the only exit when the review was raised by something a scan cannot
verify: an unreadable or unmergeable retired-root list, a device-local journal
that could not be armed or committed, a displaced folder-move edge, an
interrupted initialization, or a legacy anchor that never recorded a
membership witness.

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
3. Run **Recheck records and unlock editing** on the device showing the notice.
4. If both roots still contain records, reconcile that ambiguity before
   rechecking again.
5. Run **Run clinical data integrity check**. Fix any `stale-base-folder`
   warning for a customised database view.
6. Review any notes elsewhere in the vault that link into the moved folder.

Plugin `data.json` stores the visible settings (including the clinical folder
name), versioned initialization/recovery flags, aggregate managed-record
counts, a checksum of opaque record IDs, the bounded retired-root name list
described above, and, while a move is in progress, its source and destination
folder names. It does not store MRNs, patient names, phone numbers, record IDs,
clinical-note paths, or clinical text. For the complete trust boundary and
limitations, see [Security and privacy](../SECURITY.md).
