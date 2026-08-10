# Exporting the surgery logbook

The surgery-logbook exporter creates a CSV from completed Procedure notes and
their Episode context. It is a **repository-only desktop utility**, not a plugin
feature.

## Distribution boundary

The installed Obsidian plugin consists only of `main.js`, `manifest.json`, and
`styles.css`. Community plugins, BRAT, and manual installation do not include
`scripts/export-logbook.mjs`, and there is no exporter command in the Obsidian
interface.

To export, use a trusted desktop checkout of this repository with Node.js 22.
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

## Run the default export

From the repository root:

```bash
npm ci
npm run export:logbook -- "/path/to/vault" \
  --out "/approved/export-location/surgery-logbook.csv"
```

If the managed clinical folder is not `Clinical Workspace`, pass its
vault-relative name:

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
identify a person alone or in combination. Treat every default export as
confidential clinical data.

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
record.

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

Every cell is quoted and formula-like values are neutralized before spreadsheet
software can interpret them. This reduces formula-injection risk but does not
make clinical text safe to share. Successful output is written through a
private same-directory temporary file, published atomically, and restricted to
owner-only permissions (`0600`) where the operating system supports them.

Console messages contain aggregate counts and classifications only. They omit
record filenames, record IDs, output paths, and clinical free text. The command
itself may still place filesystem paths in shell history, so use an approved
managed terminal environment.

## After exporting

1. Confirm the reported row count and classification.
2. Review the CSV for unexpected rows and identifiers in free text.
3. Transfer it only through the approved route.
4. Never commit it to Git; `.gitignore` is defence in depth, not a
   confidentiality control. Inspect `git status` before every commit.
5. Apply the institution's retention, revocation, and secure-destruction rules
   to the CSV and every preview, cache, download, backup, or copy.

See [Security and privacy](../SECURITY.md#repository-only-logbook-exports) for
the full threat model.
