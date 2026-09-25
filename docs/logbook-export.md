# Exporting the surgery logbook

The surgery-logbook exporter creates a CSV from completed Procedure notes and
their Episode context. It is a **repository-only desktop utility**, not a plugin
feature.

## Distribution boundary

The installed Obsidian plugin consists only of `main.js`, `manifest.json`, and
`styles.css`. Community plugins, BRAT, and manual installation do not include
`scripts/export-logbook.mjs`, and there is no exporter command in the Obsidian
interface.

To export, use a trusted desktop checkout of this repository with Node.js
22.13 or later on the 22 line, or Node.js 24 or later.
The utility cannot be run from the installed plugin on iPhone or iPad.

## Before exporting

Confirm the purpose, minimum necessary fields, institutional approval or other
applicable authorization, intended recipients, approved transfer route, and
retention plan. Choose an encrypted, access-controlled destination that is
outside both:

- the source Obsidian vault; and
- this source-code repository or any other repository.

The destination directory must already exist. Do not use a live clinical export
as a bug-report attachment, test fixture, or example file.

## First-time setup

Do this once, on an institutionally managed desktop.

1. Install **Node.js 22.13 or later on the 22 line, or Node.js 24 or later**
   from [nodejs.org](https://nodejs.org/) or your organization's software
   catalogue. In a terminal, `node --version` should print `v22.13.0` or a
   later 22 release, such as `v22.20.0`, or `v24.0.0` or later. On an earlier
   release step 3 warns `EBADENGINE` (unsupported engine); update Node.js
   before you continue.
2. Get the source code: either
   `git clone https://github.com/drbinsaad/obsidian-clinical-workspace.git`,
   or download **Source code (zip)** from the [latest
   release](https://github.com/drbinsaad/obsidian-clinical-workspace/releases/latest)
   and unzip it. Keep it outside your vault.
3. Open a terminal in that folder and run `npm ci`. This downloads the
   repository's pinned tools; it does not read your vault.
4. Create the destination folder in an approved, encrypted location outside
   the vault and outside the source folder.
5. Run the export with absolute paths, from the source folder. On macOS, for
   example:

   ```bash
   npm run export:logbook -- "/Users/me/Documents/My Vault" \
     --out "/Volumes/Approved Encrypted/Logbook/surgery-logbook.csv"
   ```

   On Windows, put the command on one line:

   ```text
   npm run export:logbook -- "C:\Users\me\Documents\My Vault" --out "E:\Approved\Logbook\surgery-logbook.csv"
   ```

6. Read the counts it prints, then follow [After exporting](#after-exporting).

Run `npm run export:logbook -- --help` to see every option.

## Run the default export

From the repository root:

```bash
npm run export:logbook -- "/path/to/vault" \
  --out "/approved/export-location/surgery-logbook.csv"
```

**Which clinical folder is read.** Without `--root`, the exporter reads the
clinical folder name from this vault's Clinical Workspace settings file,
`<vault>/.obsidian/plugins/clinical-workspace/data.json`. That file holds
settings and recovery state, not patient identifiers. If it does not exist or
names no folder, the exporter uses `Clinical Workspace`. It stops instead of
guessing when:

- the settings record a clinical-folder move that has not finished. Finish or
  recover the move in Obsidian first (see [Moving the clinical folder
  safely](folder-migration.md));
- the settings record a recovery check or review that has not finished (while
  Obsidian shows **Editing is paused**), so the records may be incomplete, for
  example while Sync is still delivering them. Finish it in Obsidian first;
- the clinical folder holds fewer procedure or episode records (or, with
  `--identifiers`, patient records) than the settings say the plugin last
  confirmed, so the workspace looks incomplete, for example while it is still
  syncing. Open the vault in Obsidian and let it finish;
- the settings file cannot be read, is not valid JSON, or resolves outside the
  vault. Pass `--root` explicitly.

To choose the folder yourself, pass its vault-relative name:

```bash
npm run export:logbook -- "/path/to/vault" \
  --root "Different Clinical Folder" \
  --out "/approved/export-location/surgery-logbook.csv"
```

The root must be a child of the supplied vault and must remain inside it after
symbolic links are resolved. The output must use a `.csv` extension, resolve
outside both the vault and source checkout, and have an existing parent
directory. Output symlinks and non-file destinations are rejected.

An existing regular CSV is preserved unless `--force` is explicit:

```bash
npm run export:logbook -- "/path/to/vault" \
  --out "/approved/export-location/surgery-logbook.csv" --force
```

`--force` authorizes replacement of that exact external file only. It does not
relax any confidentiality, approval, or destination requirement.

## Export only some dates or one role

Export only what the purpose needs:

| Option | Keeps completed procedures |
|---|---|
| `--from 2026-01-01` | dated on or after this day |
| `--to 2026-06-30` | dated on or before this day |
| `--role "Primary surgeon"` | logged with this role: `Primary surgeon`, `Assistant surgeon`, `Supervisor`, or `Observer`. Capital letters do not matter. |

```bash
npm run export:logbook -- "/path/to/vault" \
  --out "/approved/export-location/surgery-logbook-2026-h1.csv" \
  --from 2026-01-01 --to 2026-06-30 --role "primary surgeon"
```

Dates must be real calendar dates written `YYYY-MM-DD`, and `--from` must not be
later than `--to`. The filters are applied only after **every** record has
passed validation, so a damaged note outside the requested dates still stops
the export. The command reports how many completed records the filters left
out.

## Default output: pseudonymized, not anonymous

The default CSV excludes dedicated MRN and patient-name columns and does not
read the Patients folder. It is still **pseudonymized, confidential, and
potentially re-identifiable**. It is not anonymous or de-identified.

| Field | Remaining disclosure risk |
|---|---|
| `case_ref` | Stable Procedure ID that can be linked to the source vault. |
| `date`, `follow_up_date`, `logged_at` | Exact dates and timestamps may identify a case. |
| `procedure`, `role`, `care_setting`, `pathway`, `priority`, `episode_status`, `follow_up_required` | Clinical and workflow context may identify rare cases. |
| `indication`, `outcome` | User-authored clinical text may contain identifiers or distinctive details. |

Context, rare procedures, dates, free text, or access to the source vault may
identify a person alone or in combination. Date and role filters reduce the
number of rows, not this risk. Treat every default export as confidential
clinical data.

## Identified export

Only use `--identifiers` when MRN and patient name are specifically necessary
and approved:

```bash
npm run export:logbook -- "/path/to/vault" \
  --out "/approved/identified-records/logbook.csv" --identifiers
```

This mode reads the Patients folder, adds `mrn` and `patient_name`, and prints a
prominent identified-record warning before records are read. The flag is a
technical gate, not authorization. The resulting CSV is an identified clinical
record. An MRN is checked and written the way the plugin stores it: Arabic-Indic
and Persian digits become 0–9, and spaces and hyphens are removed.

## Fail-closed validation and publication

Before publishing any CSV, the exporter rejects:

- an inaccessible vault, clinical root, or required record folder;
- a root that escapes the vault, including through a symbolic link;
- symbolic links or escaped paths anywhere in a scanned record tree;
- unreadable or malformed Markdown/frontmatter;
- duplicate record IDs;
- missing relationships or a Procedure/Patient mismatch with its Episode;
- invalid completed-Procedure, joined-Episode, or identified-Patient fields;
- an output inside the vault or source checkout, a non-CSV target, a symlink,
  a non-file target, or an unapproved overwrite.

Any validation failure aborts the complete export before a CSV is published.
Only Procedures with `status: completed` become rows; the command reports the
aggregate number exported and the aggregate number of non-completed records
excluded.

**Finding the notes that failed.** Error messages give counts per property,
never a file name, for example:

```text
Export failed: Export schema validation rejected 2 completed-procedure field values (role: 1, outcome: 1). No CSV was written. Run "Clinical Workspace: Run clinical data integrity check" in Obsidian to find the affected notes.
```

In Obsidian, the integrity check lists each completed procedure the exporter
would refuse as a `not-exportable` warning, names the properties to fix, and
opens the note. See [Integrity check
findings](data-model.md#integrity-check-findings).

Every cell is quoted and formula-like values are neutralized before spreadsheet
software can interpret them. This reduces formula-injection risk but does not
make clinical text safe to share. Successful output is written through a
private same-directory temporary file, published atomically, and restricted to
owner-only permissions (`0600`) where the operating system supports them.

Console messages contain aggregate counts and classifications only. They omit
record filenames, record IDs, output paths, the clinical folder name, and
clinical free text. The command itself may still place filesystem paths in
shell history, so use an approved managed terminal environment.

## After exporting

1. Confirm the reported row count and classification, including any records
   excluded by `--from`, `--to`, or `--role`.
2. Review the CSV for unexpected rows and identifiers in free text.
3. Transfer it only through the approved route.
4. Never commit it to Git; `.gitignore` is defence in depth, not a
   confidentiality control. Inspect `git status` before every commit.
5. Apply the institution's retention, revocation, and secure-destruction rules
   to the CSV and every preview, cache, download, backup, or copy.

See [Security and privacy](../SECURITY.md#repository-only-logbook-exports) for
the full threat model.
