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

## What this plugin does with your data

- **All data stays in your vault.** Every record is a Markdown note with YAML
  frontmatter under the configured clinical folder, `Clinical Workspace` by default.
- **No network access.** The plugin makes no HTTP requests and contains no
  telemetry, analytics, crash reporting, or update checks. There is no code
  path that transmits vault content anywhere.
- **No third-party runtime dependencies.** The bundle imports only the Obsidian
  API. Everything in `package.json` is a build-time or test-time dependency.
- **No writes outside its own folder.** Files and folders are only ever created
  or modified under the configured clinical folder.
- **Plugin settings hold no patient data.** `data.json` inside the plugin folder
  stores only the configuration listed in the README — a clinician name, four
  defaults, two toggles, a delay, and a folder name. No MRN, patient name, phone
  number or record content is ever written to it.
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

## Threat model

**Assets.** Patient identifiers (MRN, name, phone), clinical case text,
surgical history, and the audit trail.

**Trust boundary.** The plugin trusts the vault. Frontmatter is coerced into
expected types on read and unrecognised values are reported by the integrity
check, but a note is otherwise taken at face value.

| # | Exposure | Mitigation |
|---|---|---|
| 1 | Vault read by another Obsidian plugin | **Not mitigable from within this plugin.** Any community plugin has full vault access. Install as few as possible in a clinical vault, and review what you do install. |
| 2 | Device loss or theft | Out of scope. Requires full-disk encryption and a screen lock. |
| 3 | Sync provider or an account with vault access | Out of scope. Use a sync route your institution sanctions. |
| 4 | Accidental publication to git | `.gitignore` excludes any `.obsidian` directory, any `.base` file, and the generated record filename prefixes, so a vault created in the repository directory cannot be committed by accident regardless of what the clinical folder is named. |
| 5 | Identifiers leaking through logs or bug reports | Integrity output is rendered in the interface, never logged, and contains no identifiers. Enforced by a test. |
| 6 | A hostile note causing code execution | **Not reachable.** All DOM is built with `createEl`/`createDiv`/`createSpan`, which assign `textContent`. There is no `innerHTML`, `eval`, or `new Function` anywhere in the source. |
| 7 | Fabricated records mixed into real data | The synthetic data generator is compiled out of release builds and cannot be reached from a released version. |
| 8 | A folder migration moving records outside the vault | Folder paths reject `.` and `..` segments anywhere in the path, and the target must not already exist. |

## Before using this with identifiable patient data

This is a personal workflow aid. Whether identifiable patient data may be
stored in an Obsidian vault on your device is an **institutional information
governance decision**, not a software one. Confirm your local requirements —
privacy impact assessment, device management, sanctioned sync, retention, and
breach reporting — before storing anything identifiable.
