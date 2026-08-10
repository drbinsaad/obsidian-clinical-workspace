# Clinical Workspace for Obsidian

A mobile-first, local-first workflow plugin for personal clinical follow-up and surgical logbook organization. It uses plain Markdown notes with YAML properties, stable internal IDs, native Obsidian links, and Obsidian Bases.

> This is a personal workflow aid, not an EHR/EMR, prescribing system, diagnostic system, or autonomous clinical decision-support tool. Follow institutional privacy, retention, backup, and device-management policy before storing identifiable patient information. See [SECURITY.md](SECURITY.md) for the threat model and what this plugin deliberately does not provide.

## Separate plugin and vault boundary

Clinical Workspace and [Knowledge Base Command Center](https://github.com/drbinsaad/knowledge-base-command-center) are independent Obsidian plugins:

| Plugin | Plugin ID | Purpose |
|---|---|---|
| Clinical Workspace | `clinical-workspace` | Personal clinical follow-up, tasks, episodes and surgery logbook |
| Knowledge Base Command Center | `ent-vault-command-center` | Visual organization and note creation for a knowledge vault |

They have different repositories, release histories, settings and plugin folders. A vault holding identifiable clinical records should contain only the minimum institutionally approved plugins. Do not install a general vault-indexing plugin in that vault unless your information-governance policy explicitly permits it.

## Mobile workflow

- **Today** — overdue tasks, tasks due today, undated open work, active inpatients, and episode counts.
- **Patients** — one-column cards separated into Inpatient and Outpatient; update care setting, pathway, priority, next action, and date from one sheet.
- **Tasks** — complete, cancel, or open tasks and add another without horizontal Kanban scrolling.
- **Surgery** — OR booking queue plus completed surgery logbook; optional follow-up is only requested when enabled.
- **More** — native Bases, patient records with identity editing and merge, archive/restore, and integrity checking.

The commands **Open workspace** and **Add patient episode** can be added to the Obsidian mobile toolbar or triggered from the command palette. Obsidian automatically displays them under the Clinical Workspace plugin name.

## Installation

The Clinical Workspace **plugin runtime** requires Obsidian 1.13.0 or later and
supports desktop and mobile. The repository also contains a separate Node.js
logbook-export command; that development utility is not installed with the
plugin and is desktop-only. See [Repository-only surgery logbook
exporter](#repository-only-surgery-logbook-exporter).

### BRAT beta installation

BRAT remains available as an alternative installation route and for beta testing:

1. Install and enable **BRAT** from Obsidian's Community plugins browser.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Enter `drbinsaad/obsidian-clinical-workspace`.
4. Enable **Clinical Workspace** under **Settings → Community plugins**.

[Install Clinical Workspace with BRAT](obsidian://brat?plugin=https://github.com/drbinsaad/obsidian-clinical-workspace)

BRAT can check for releases on startup or through **BRAT: Check for updates to all beta plugins and UPDATE**.

### Community directory

Clinical Workspace is officially available in the Obsidian Community directory. Install it from **Settings → Community plugins → Browse**, search for **Clinical Workspace**, then select **Install** and **Enable**. The current public version is **0.3.6**; future stable releases appear under **Community plugins → Check for updates**.

### Manual installation

Download `main.js`, `manifest.json` and `styles.css` from the same GitHub release and place them in:

```text
<vault>/.obsidian/plugins/clinical-workspace/
```

Restart Obsidian, then enable Clinical Workspace under Community plugins. Never copy development builds into a vault holding real patient information.

On iPhone or iPad, BRAT is the recommended route. For a manual installation,
use the Files app to open the Obsidian vault, reveal its `.obsidian` folder, and
place the same three release files in
`.obsidian/plugins/clinical-workspace/`. Reopen Obsidian and enable the plugin.
If the storage provider does not expose hidden folders, use BRAT instead.

### Uninstalling

Disable and remove Clinical Workspace under **Settings → Community plugins**.
Removing the plugin deletes only its installed code and settings; it does **not**
delete the configured clinical folder, patient records, episodes, tasks,
procedures, event notes, Bases, or home note. Back up the vault and verify those
notes independently before removing or moving any clinical data yourself.

## First-use safety checklist

- Use a dedicated test vault and synthetic `9000...` MRNs first.
- On the first 0.3.6 open, wait for Sync to finish, then run **Clinical
  Workspace: Initialize new workspace** (or open the workspace and use the same
  prompt). Adopt the visible records only after confirming they are complete;
  initialize an empty baseline only for a genuinely new or intentionally
  record-free workspace. The approval is saved before scaffolding.
- Enable **Confirm before discharge** and **Run integrity check on first open**.
- Test the complete workflow before considering identifiable information.
- Confirm institutional approval for the device, vault location, synchronization, retention and backup route.
- Run **Clinical Workspace: Run clinical data integrity check** after any sync conflict.

## Settings

**Settings → Community plugins → Clinical Workspace.**

| Setting | What it does |
|---|---|
| Your name or initials | Recorded as the actor on every audit note. Left blank, the trail reads `local-user`. |
| Care setting · Pathway · Priority | Pre-selected on the Add patient form; every field is still editable per patient. |
| Confirm before discharge | Requires the word `DISCHARGE` to be typed before an episode is archived. |
| Run integrity check on first open | Surfaces problems without having to remember to look. Silent when there are none. |
| Refresh delay | How long to coalesce vault changes before redrawing, 0–2000 ms. |
| Clinical folder | Where records live. Changing it is a migration, not a toggle — see below. |

Settings are stored in `data.json` inside the plugin's own folder. It also holds
a versioned, path-free recovery state: whether the workspace was initialized,
whether first-use initialization was explicitly approved, whether managed
records existed, their aggregate file count, and whether folder recovery is
pending. It stores no MRN, patient name, phone number, record ID, record path,
or clinical text.

### Moving the clinical folder

Type a new folder name and the panel previews exactly what would move. Nothing
happens until **Move records** is pressed. The migration uses Obsidian's own
rename, which rewrites the links between records — including those held in YAML
frontmatter, verified against a real vault — and then regenerates the database
views, which Obsidian does not rewrite on its own.

Afterwards the plugin counts any link still pointing at the old folder and warns
if it finds one. It should always be zero; a non-zero count means the rewrite did
not do what it is supposed to, and the integrity check will show what to repair.
The new location is recorded *before* the move, so an interruption is recoverable
rather than leaving the workspace pointing at an empty folder.

Move the clinical folder on **one device at a time**. Before starting, allow the
vault to finish syncing everywhere and stop clinical edits on the other devices.
After the move, wait for both plugin settings and the moved folder to arrive
before resuming work elsewhere.

A folder name arriving through Sync is treated as intent, not proof that the
records have arrived. If a migration marker arrives before its folders, the
plugin keeps the last known source active and blocks clinical and scaffolding
writes. It retries reconciliation after vault changes. Records found only at the
destination settle the move there. A source-only state remains blocked because
the destination may still be in transit; after Sync has completely finished,
run **Retry pending folder move recovery** from the Command Palette to confirm
the rollback. If both roots contain records, the workspace remains blocked
instead of choosing one and hiding the other. Inspect both locations, let Sync
converge, retry recovery, and run the integrity check before continuing.

The same fail-closed recovery applies if the configured root disappears or an
unsafe external rename is detected. The block survives restart. A previously
populated root is not made writable again until its prior aggregate managed-file
count has returned, so delivery of an empty parent folder or only part of its
records cannot manufacture a second workspace.

Every pre-0.3.6 workspace lacks a trusted aggregate count, so its first 0.3.6
open is intentionally read-only whether it currently shows zero, some, or all
managed records. Wait for Sync to finish, then use **Initialize new workspace**
to adopt the visible records as the complete baseline, or to initialize a
genuinely new/record-free workspace. Cancel if anything may still be in transit.
An empty parent alone never counts as convergence. A two-phase, path-free
approval marker makes an interruption before scaffolding safely resumable.

## Data model

Each entity has a stable generated ID and its own note:

```text
Patient ──< Episode ──< Task
                 ├──< Procedure
                 └──< Event
```

- Patient identity is reused by normalized MRN. MRNs that differ only by leading zeroes resolve to the same patient; the value as typed is what is displayed.
- Missing MRN and phone remain explicit as `MRN needed` and `NFN` in the interface.
- Creating a patient without an MRN prompts when an existing record shares the name, so duplicates are a decision rather than an accident.
- Patient identity can be corrected, and linked labels update with it. Two records can be merged after typing `MERGE`; a recovery marker makes an interrupted merge visible to the integrity check. A completed merge re-points every episode, task and procedure and retires the source as `entered-in-error` — nothing is deleted.
- Episode is the unit of care: care setting, pathway, priority, next action, due date, and status.
- Open task and procedure duplicates are prevented with episode-scoped deterministic keys plus full-value comparison, including across concurrent submissions on one device.
- An episode cannot be archived while an open task remains. Tasks can be cancelled, so an episode is never permanently stuck.
- Completing the last task changes the episode to `ready-to-close`.
- Archive is a status, not a physical file move. Restore returns the episode to the pathway it held before archiving and keeps the discharge outcome.
- Records resolve by their stable ID, so renaming a note in Obsidian does not detach it.
- Every write is reread and verified, and workflow actions create event notes.

### Known limitations

- The mobile layout has been exercised and corrected using a real iPhone, and
  the plugin uses only mobile-safe APIs. Continue to validate the complete
  workflow with synthetic records on every device and Obsidian version you use.
- Duplicate protection is per-device. Two devices editing before sync converges can still produce duplicates — run the integrity check after any conflict.
- Change the clinical folder on one device only. A root setting that syncs before
  its records is deliberately deferred, and ambiguous split records block writes
  until the migration can be reconciled safely. After Sync finishes, use
  **Retry pending folder move recovery** if the identifier-free notice remains.
- Multi-file operations are not transactional. A failure part-way leaves the earlier writes in place; the integrity check reports what it can find.
- Audit notes are best-effort. A failed audit write is reported but does not roll back the clinical action.
- No encryption, no access control, no backup verification. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run check
```

`npm run check` runs strict TypeScript checking, Obsidian Community linting for
the plugin source, general linting for the repository-side Node scripts, the test
suite, and a production build into `dist/`.

The default build output is the local `dist/` directory. The build does not install into or modify any Obsidian vault.

To install a build into a vault:

```bash
npm run build && npm run install:vault -- "/path/to/vault"
```

That refuses to install a development build — the one carrying the synthetic data generator — unless `--allow-dev` is passed, so a vault holding real patient information cannot gain the ability to fabricate records by accident. It also refuses a folder that is not an Obsidian vault.

To build straight into a vault instead:

```bash
CLINICAL_PLUGIN_OUTDIR="/path/to/vault/.obsidian/plugins/clinical-workspace" npm run build
```

### Development tooling

The synthetic data generator is **compiled out of release builds** and cannot be reached from a released version. To enable it for testing:

```bash
CLINICAL_DEV_TOOLS=1 npm run build
```

Never install a build made this way into a vault holding real patient information. `npm run verify-release` fails if development tooling is present in `dist/`.

### Tests

The published `obsidian` package is type definitions only, so the plugin cannot be executed under Node as-is. `tests/support/` provides an in-memory stand-in for the vault APIs, registered through a module hook. Its YAML behaviour mirrors what Obsidian actually writes, verified against records produced in a real vault.

### Repository-only surgery logbook exporter

> **Distribution boundary:** `npm run export:logbook` is a desktop Node.js
> utility in this source repository. It is not part of `main.js`, is not exposed
> in the Obsidian interface, and is not delivered by Community plugins, BRAT, or
> the three-file manual installation. It cannot be run on iPhone or iPad from an
> installed plugin. Clone the repository on a trusted desktop, install its
> dependencies, and use Node.js 22 to run it.

The command joins completed procedure notes to their episode context. An
explicit output path is required and must resolve **outside the vault**:

```bash
npm run export:logbook -- "/path/to/vault" \
  --out "/approved/export-location/surgery-logbook.csv"
```

Use `--root "Different Clinical Folder"` when the configured clinical root is
not `Clinical Workspace`. The root must be a vault-relative child folder and
must remain inside the supplied vault after symbolic links are resolved. The
output must end in `.csv`, and its parent directory must already exist. Output
symlinks are rejected. The exporter refuses an existing regular file; add
`--force` only after confirming that replacing that exact external file is
intended:

```bash
npm run export:logbook -- "/path/to/vault" \
  --out "/approved/export-location/surgery-logbook.csv" --force
```

The default CSV is **pseudonymized and still confidential**. It excludes MRN
and patient name, but it is not anonymous or de-identified. It contains these
fields:

| Field | Remaining disclosure risk |
|---|---|
| `case_ref` | Stable procedure ID; linkable to the source vault. |
| `date`, `follow_up_date`, `logged_at` | Exact dates/times may identify a case. |
| `procedure`, `role`, `care_setting`, `pathway`, `priority`, `episode_status`, `follow_up_required` | Clinical and workflow context. |
| `indication`, `outcome` | User-authored clinical free text that may itself contain identifiers or rare-case details. |

Context, rare procedures, dates, or access to the source vault may re-identify a
person. Treat every default export as personal/confidential clinical data.
Spreadsheet cells are neutralized against formula injection, but the CSV still
needs the same review and handling controls as any clinical extract. In this
default mode the Patients folder is not read.

`--identifiers` reads the Patients folder, additionally includes `mrn` and
`patient_name`, and prints a prominent warning before records are read. Use it
only for a documented, institutionally approved need:

```bash
npm run export:logbook -- "/path/to/vault" \
  --out "/approved/identified-records/logbook.csv" --identifiers
```

Before exporting, obtain the required approval and choose an encrypted,
access-controlled destination outside both the vault and any source repository.
Afterwards, review the CSV for identifiers in free text, verify warnings and row
counts, transfer it only through an approved route, and apply the institution's
retention and secure-destruction schedule. Never attach a live export to a
public issue or commit it to git.

The exporter fails closed before creating a CSV if it finds an unreadable or
malformed record, duplicate ID, missing relationship, patient/episode mismatch,
escaped path, or symbolic link in a record tree. It reports only aggregate
counts and classifications—not filenames, IDs, free text, or the output path.
Successful output is written through a private same-directory temporary file,
published atomically, and restricted to the owner (`0600`) where the operating
system supports Unix permissions. See [Security and privacy](SECURITY.md#repository-only-logbook-exports).

## Releasing

```bash
npm version patch      # updates package.json, manifest.json, versions.json
npm run check
npm run verify-release
```

Then push the tag. Release tags are **bare semantic versions with no `v` prefix**, which is what the release workflow triggers on. It publishes a draft release with `main.js`, `manifest.json` and `styles.css` attached.

## Migrating existing records

Records are plain Markdown with YAML frontmatter, so they can be produced by any
tool. Whatever writes them, run **Run clinical data integrity check** afterwards:
it reports records that reference a missing patient or episode, a task or
procedure filed under a different patient from its episode, duplicate MRNs,
unreadable notes, and unrecognised field values.

Records written outside the plugin are not validated on the way in. The
integrity check is the only thing that will tell you they are sound.

## License

[MIT](LICENSE)
