# Support

Clinical Workspace is maintained as an open-source personal workflow tool. It
does not provide clinical advice, emergency support, EHR support, institutional
deployment approval, or a guaranteed response time.

## Before opening a request

1. Read the [README](README.md), [folder-migration guide](docs/folder-migration.md),
   [logbook-export guide](docs/logbook-export.md), and [security boundary](SECURITY.md).
2. Confirm the behavior in the latest published release using a disposable vault
   and synthetic records.
3. Run **Clinical Workspace: Run clinical data integrity check** after a Sync
   conflict or hand edit.

Use the repository's **Bug report** form for reproducible defects and **Feature
request** form for proposed workflow changes. Security vulnerabilities must be
reported through a private GitHub security advisory.

## Privacy boundary

Never attach a live vault, clinical export, screenshot of real records, patient
identifier, or clinical free text. GitHub—public issues and private advisories
alike—is not an approved route for patient information. Reproduce every request
with fictional names and synthetic `9000...` MRNs.

Questions about whether identifiable clinical data may be stored or synced on a
particular device must go to the relevant institutional privacy, information
governance, or security team. The project cannot make that authorization.
