# Security and privacy

Clinical Workspace organises a clinician's own follow-up workflow inside an
Obsidian vault. It is **not** an EHR/EMR, a prescribing system, a diagnostic
system, or an autonomous clinical decision-support tool.

## Reporting a vulnerability

Open a **private** security advisory through the repository's Security tab
(*Report a vulnerability*). Please do not open a public issue.

**Never include real patient information in a report** — no MRNs, names, phone
numbers, dates of birth, or screenshots of a live vault. Reproduce the problem
with synthetic data and send that instead. A report containing real patient
data will be deleted without being acted on.

Expect an acknowledgement within 7 days.

## Distribution and trust boundaries

This repository contains two different components:

1. The **Obsidian plugin runtime** is the released `main.js`, `manifest.json`,
   and `styles.css`. Community plugins, BRAT, and manual installation deliver
   only these files. This runtime supports desktop and mobile.
2. The **repository-only logbook exporter** is `scripts/export-logbook.mjs`. It
   requires a trusted desktop source checkout, Node.js 22, and an explicit
   terminal command. It is not bundled into the plugin, has no Obsidian command
   or interface, and is unavailable from a Community/BRAT/manual installation or
   on iPhone/iPad.

The runtime's vault confinement does not mean an export stays in the vault. The
exporter's purpose is to create a separate confidential CSV at an approved
external location.

## What the installed plugin runtime does with your data

- **Runtime clinical data stays in your vault.** Every record is a Markdown note
  with YAML frontmatter under the configured clinical folder, `Clinical
  Workspace` by default.
- **No network access.** The plugin makes no HTTP requests and contains no
  telemetry, analytics, crash reporting, or update checks. There is no code
  path that transmits vault content anywhere.
- **No third-party runtime dependencies.** The bundle imports only the Obsidian
  API. Everything in `package.json` is a build-time or test-time dependency.
- **Folder-scoped reads.** Runtime record and integrity scans begin at the
  configured clinical root and recurse only through that folder. The plugin
  does not enumerate unrelated vault files.
- **Ordinary writes stay inside its own folder.** Clinical records and scaffold
  files are created or modified only under the configured clinical folder. A
  user-confirmed clinical-folder migration is the exception: it delegates the
  rename to Obsidian so inbound links elsewhere in the vault may be rewritten.
  Back up the vault first and review notes that link into the clinical folder
  after a move.
- **Plugin settings hold no patient identity or clinical text.** `data.json`
  stores the visible configuration plus path-free initialization/recovery
  booleans and an aggregate managed-file count. It contains no MRN, patient
  name, phone number, record ID, record path, case text, or record content.
- **No identifiers in logs.** Integrity results are rendered in the interface.
  Messages are written so that they never contain an MRN, name, or phone
  number, and this is enforced by a test.

## What this plugin does *not* provide

These are deliberate non-goals. If your setting requires any of them, this
plugin is not sufficient on its own:

- **No encryption.** Notes are plain text on disk. Confidentiality depends
  entirely on your device's full-disk encryption, screen lock, and the security
  of whatever syncs the vault.
- **No access control.** Anyone who can open the vault can read every record.
  There are no roles, permissions, or per-record restrictions.
- **No multi-user integrity.** Duplicate protection is per-device. Two devices
  editing concurrently before sync converges can produce duplicate records; run
  the integrity check after any conflict.
- **No guaranteed audit completeness.** Audit notes are written on a best-effort
  basis. A failed audit write is reported but does not roll back the clinical
  action that preceded it.
- **No backup or disaster recovery.** Use your own backup regime.
- **No compliance certification.** No HIPAA/GDPR/local attestation is claimed.

## Repository-only logbook exports

The default CSV is **pseudonymized, not anonymous or de-identified**. It omits
the direct `mrn` and `patient_name` columns, but contains:

- the stable, source-linkable `case_ref` procedure ID;
- exact `date`, `follow_up_date`, and `logged_at` values;
- `procedure`, `role`, `care_setting`, `pathway`, `priority`,
  `follow_up_required`, and `episode_status`; and
- user-authored `indication` and `outcome` clinical text.

The dates, rare-case context, stable reference, or free text may identify a
person by themselves or when combined with other information. Free text may
also contain a name, MRN, or another direct identifier entered by a user. The
default output therefore remains confidential personal/clinical data and may
remain regulated personal data under applicable law and institutional policy.

`--identifiers` adds `mrn` and `patient_name` and emits a warning. That file is
an identified clinical record. The flag is an explicit technical gate, not an
authorization decision. Without that flag, the Patients folder is not read.

The command requires an explicit `--out` path that resolves outside the source
vault and ends in `.csv`; the parent directory must already exist. It rejects a
clinical root that escapes the vault, refuses symbolic links in record trees or
at the output, and refuses to replace an existing regular output unless
`--force` is supplied. `--force` means only that the operator intentionally
approved replacement of that exact external file; it does not relax any
confidentiality requirement. Spreadsheet cells are escaped and formula-like
values are neutralized, but output still requires human review.

Unreadable or malformed records, duplicate IDs, missing relationships, and
patient/episode mismatches abort the complete export before a CSV is published.
Console output is limited to aggregate counts and data classification; it does
not print output paths, record filenames, stable IDs, or clinical free-text
tallies. A successful CSV is created through a private same-directory temporary
file, atomically published, and restricted to owner-only permissions (`0600`)
where supported.

Before running an export:

1. Confirm the purpose, minimum fields, legal basis or institutional approval,
   and intended recipients.
2. Use a managed desktop and an encrypted, access-controlled destination outside
   the vault and outside any source-code repository.
3. Prefer the pseudonymized default. Use `--identifiers` only when direct
   identifiers are specifically necessary and approved.
4. Review the resulting CSV for direct identifiers in free text and unexpected
   rows, confirm the reported row count, and treat any validation failure as a
   reason to repair the source and rerun rather than share a partial extract.
5. Transfer only through an approved route; never attach live data to a public
   issue, chat, email, or bug report unless that exact route is authorized.
6. Apply the institution's retention, revocation, and secure-destruction rules to
   the CSV and any copies, previews, downloads, backups, or spreadsheet caches.

## Threat model

**Assets.** Patient identifiers (MRN, name, phone), clinical case text,
surgical history, the audit trail, pseudonymized exports, and identified
exports.

**Trust boundary.** The plugin runtime trusts the configured clinical folder in
the vault. Frontmatter is coerced into expected types on read and unrecognised
values are reported by the integrity check, but a note is otherwise taken at
face value. The separate exporter additionally trusts the operator, the local
Node.js environment, and the approved external destination after validating the
vault/root/output path boundaries.

| # | Exposure | Mitigation |
|---|---|---|
| 1 | Vault read by another Obsidian plugin | **Not mitigable from within this plugin.** Any community plugin has full vault access. Install as few as possible in a clinical vault, and review what you do install. |
| 2 | Device loss or theft | Out of scope. Requires full-disk encryption and a screen lock. |
| 3 | Sync provider or an account with vault access | Out of scope. Use a sync route your institution sanctions. A folder move must be performed on one device after Sync converges. |
| 4 | Accidental publication to git | `.gitignore` excludes vault markers, generated record prefixes, conventional `surgery-logbook*.csv` names, and exporter temporary-file names. This is defence in depth, not a confidentiality control: use an approved export location outside any repository and inspect `git status` before every commit. |
| 5 | Identifiers leaking through logs or bug reports | Integrity output is rendered in the interface, never logged, and contains no identifiers. Enforced by a test. |
| 6 | A hostile note causing code execution | **Not reachable.** All DOM is built with `createEl`/`createDiv`/`createSpan`, which assign `textContent`. There is no `innerHTML`, `eval`, or `new Function` anywhere in the source. |
| 7 | Fabricated records mixed into real data | The synthetic data generator is compiled out of release builds and cannot be reached from a released version. |
| 8 | A folder migration moving records outside the vault | Folder paths reject `.` and `..` segments anywhere in the path, and unsafe or ambiguous targets are rejected. |
| 9 | Settings or a parent folder syncs before all moved clinical records, causing an empty or partial second tree | A synced root change is not activated without workspace evidence. The last known source remains active and clinical/scaffold writes are blocked while migration evidence is incomplete or both roots contain records. Path-free recovery state survives restart; a previously populated missing root requires its prior aggregate managed-file count before explicit recovery. |
| 10 | Re-identification of a default export | The output is explicitly labelled pseudonymized/confidential. Direct identifier columns are excluded, remaining fields and linkage risk are documented, and institutional handling plus human review are required. |
| 11 | Direct identifiers exported accidentally | `mrn` and `patient_name` require `--identifiers`; the command prints an identified-record warning. Authorization and destination controls remain the operator's responsibility. |
| 12 | Export overwrites a source or existing file | `--out` is mandatory, must use `.csv`, and must resolve outside the vault. Output symlinks and non-files are rejected; an existing regular file is preserved unless the operator supplies `--force`. |
| 13 | Spreadsheet formula injection through clinical free text | Every cell is quoted and formula-like content is neutralized before CSV creation. Review untrusted clinical text and use a supported spreadsheet viewer. |
| 14 | Partial or incorrectly joined export | Malformed/unreadable records, duplicate IDs, missing links, and patient/episode mismatches abort before publication. Atomic private-file creation prevents a partial CSV from being mistaken for a complete one. |
| 15 | Export details leaking through terminal history or logs | The operator-supplied command can expose local filesystem paths through shell history. Runtime output itself omits paths, filenames, IDs, and free-text tallies. Use an institutionally managed terminal environment. |
| 16 | A pre-0.3.6 workspace being baselined from an empty or partial Sync delivery | Every safetyless legacy workspace remains read-only on its first 0.3.6 open, regardless of the visible record count. After Sync is complete, the user must explicitly adopt the current records through **Initialize new workspace**, or initialize a genuinely new/record-free vault. The exact settings/root/count shown at confirmation are revalidated before saving, and a two-phase path-free approval marker makes interruption before scaffolding resumable. |

## Before using this with identifiable patient data

This is a personal workflow aid. Whether identifiable patient data may be
stored in an Obsidian vault on your device is an **institutional information
governance decision**, not a software one. Confirm your local requirements —
privacy impact assessment, device management, sanctioned sync, retention, and
breach reporting — before storing anything identifiable.
