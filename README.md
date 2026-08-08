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

Clinical Workspace requires Obsidian 1.13.0 or later and supports desktop and mobile.

### BRAT beta installation

BRAT remains available as an alternative installation route and for beta testing:

1. Install and enable **BRAT** from Obsidian's Community plugins browser.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Enter `drbinsaad/obsidian-clinical-workspace`.
4. Enable **Clinical Workspace** under **Settings → Community plugins**.

[Install Clinical Workspace with BRAT](obsidian://brat?plugin=https://github.com/drbinsaad/obsidian-clinical-workspace)

BRAT can check for releases on startup or through **BRAT: Check for updates to all beta plugins and UPDATE**.

### Community directory

Clinical Workspace is officially available in the Obsidian Community directory. Install it from **Settings → Community plugins → Browse**, search for **Clinical Workspace**, then select **Install** and **Enable**. The current public version is **0.3.5**; future stable releases appear under **Community plugins → Check for updates**.

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

Settings are stored in `data.json` inside the plugin's own folder. Only the
values above are written there; no patient information is ever stored in plugin
settings.

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
- Multi-file operations are not transactional. A failure part-way leaves the earlier writes in place; the integrity check reports what it can find.
- Audit notes are best-effort. A failed audit write is reported but does not roll back the clinical action.
- No encryption, no access control, no backup verification. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run check
```

`npm run check` runs strict TypeScript checking, Obsidian Community linting, the test suite, and a production build into `dist/`.

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

### Exporting a surgery logbook

The repository includes an optional command-line exporter for appraisal or
training records. It reads only the configured clinical folder, joins completed
procedure notes to their episode context, and writes a CSV outside Obsidian:

```bash
npm run export:logbook -- "/path/to/vault" --out "/path/to/surgery-logbook.csv"
```

The default export is de-identified: it includes a stable case reference but no
MRN or patient name. Add `--identifiers` only when there is a documented need:

```bash
npm run export:logbook -- "/path/to/vault" --out "/secure/path/logbook.csv" --identifiers
```

An identified CSV is a separate clinical record. Store, transfer, retain, and
dispose of it under the same institutional policy as the source vault. The
exporter does not alter vault notes and is not included in the Obsidian runtime
bundle.

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
