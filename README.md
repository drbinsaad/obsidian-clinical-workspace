# Clinical Workspace for Obsidian

A mobile-first, local-first workflow plugin for personal clinical follow-up and surgical logbook organization. It uses plain Markdown notes with YAML properties, stable internal IDs, native Obsidian links, and Obsidian Bases.

> This is a personal workflow aid, not an EHR/EMR, prescribing system, diagnostic system, or autonomous clinical decision-support tool. Follow institutional privacy, retention, backup, and device-management policy before storing identifiable patient information. See [SECURITY.md](SECURITY.md) for the threat model and what this plugin deliberately does not provide.

## Mobile workflow

- **Today** — overdue tasks, tasks due today, undated open work, active inpatients, and episode counts.
- **Patients** — one-column cards separated into Inpatient and Outpatient; update care setting, pathway, priority, next action, and date from one sheet.
- **Tasks** — complete, cancel, or open tasks and add another without horizontal Kanban scrolling.
- **Surgery** — OR booking queue plus completed surgery logbook; optional follow-up is only requested when enabled.
- **More** — native Bases, patient records with identity editing and merge, archive/restore, and integrity checking.

The commands **Open Clinical Workspace** and **Add patient episode** can be added to the Obsidian mobile toolbar or triggered from the command palette.

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
- Patient identity can be corrected, and two records can be merged. A merge re-points every episode, task and procedure and retires the source as `entered-in-error` — nothing is deleted.
- Episode is the unit of care: care setting, pathway, priority, next action, due date, and status.
- Open task duplicates are prevented with deterministic idempotency keys, including across concurrent submissions on one device.
- An episode cannot be archived while an open task remains. Tasks can be cancelled, so an episode is never permanently stuck.
- Completing the last task changes the episode to `ready-to-close`.
- Archive is a status, not a physical file move. Restore returns the episode to the pathway it held before archiving and keeps the discharge outcome.
- Records resolve by their stable ID, so renaming a note in Obsidian does not detach it.
- Every write is reread and verified, and workflow actions create event notes.

### Known limitations

- Nothing has been tested on iOS. The layout has been measured at iPhone
  viewports and the plugin uses only mobile-safe APIs, but no build has run on a
  device.
- Duplicate protection is per-device. Two devices editing before sync converges can still produce duplicates — run the integrity check after any conflict.
- Multi-file operations are not transactional. A failure part-way leaves the earlier writes in place; the integrity check reports what it can find.
- Audit notes are best-effort. A failed audit write is reported but does not roll back the clinical action.
- No encryption, no access control, no backup verification. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run check
```

`npm run check` runs strict TypeScript checking, the test suite, and a production build into `dist/`.

The default build output is the local `dist/` directory. The build does not install into or modify any Obsidian vault. To test in an isolated synthetic vault, explicitly provide its plugin directory:

```bash
CLINICAL_PLUGIN_OUTDIR="/path/to/Clinical Dev Vault/.obsidian/plugins/clinical-workspace" npm run build
```

### Development tooling

The synthetic data generator is **compiled out of release builds** and cannot be reached from a released version. To enable it for testing:

```bash
CLINICAL_DEV_TOOLS=1 npm run build
```

Never install a build made this way into a vault holding real patient information. `npm run verify-release` fails if development tooling is present in `dist/`.

### Tests

The published `obsidian` package is type definitions only, so the plugin cannot be executed under Node as-is. `tests/support/` provides an in-memory stand-in for the vault APIs, registered through a module hook. Its YAML behaviour mirrors what Obsidian actually writes, verified against records produced in a real vault.

## Releasing

```bash
npm version patch      # updates package.json, manifest.json, versions.json
npm run check
npm run verify-release
```

Then push the tag. Release tags are **bare semantic versions with no `v` prefix**, which is what the release workflow triggers on. It publishes a draft release with `main.js`, `manifest.json` and `styles.css` attached.

## Planned controlled migration

Migration from NotePlan should be a separate, dry-run-first step:

1. Export/copy source Markdown into a temporary staging directory.
2. Parse existing patient notes without editing the source.
3. Produce a review report for missing/duplicate MRNs and ambiguous episode types.
4. Import approved records into the dedicated Obsidian clinical vault.
5. Run the integrity check and reconcile counts before switching workflows.

Do not combine a clinical patient vault with the ENT educational knowledge vault. Keep the clinical workspace in a separate encrypted/sanctioned sync location.

## License

[MIT](LICENSE)
