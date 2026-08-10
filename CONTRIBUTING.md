# Contributing

Thank you for helping improve Clinical Workspace. Changes should preserve a
small, auditable plugin that keeps its runtime work inside the configured
clinical folder.

## Patient-information prohibition

Never include real patient information in an issue, pull request, commit, test,
screenshot, log, sample vault, or export. This includes identifiers, clinical
free text, dates, filenames, and screen chrome that exposes a live vault. Use
obviously synthetic `9000...` MRNs, fictional names, and invented clinical text.

Security problems belong in a private GitHub security advisory as described in
[SECURITY.md](SECURITY.md). GitHub is not an approved route for patient
information, even when the report is private.

## Development setup

Repository tooling requires Node.js 22 or later. The installed Obsidian plugin
does not require Node.js.

```bash
npm ci
npm run review
```

`npm run review` performs strict TypeScript checking, Obsidian Community
linting, a production build, the complete test suite, release verification, and
a Community-review preflight. It also verifies that approved public images have
not changed and contain no embedded EXIF or text metadata.

Development tooling is compiled out of normal builds. If you intentionally
enable it with `CLINICAL_DEV_TOOLS=1`, install it only in a disposable test vault
that has never held real patient information. Never submit that build as a
release asset.

## Design and safety boundaries

- Preserve the local-first, no-network runtime design.
- Keep runtime record reads and writes scoped to the configured clinical folder.
- Preserve data through reversible status transitions when deletion is not
  necessary.
- Treat multi-file changes and Sync recovery as fail-closed workflows.
- Keep the repository-only Node.js exporter out of the Obsidian runtime bundle.
- Keep default exports labelled pseudonymized and confidential, never anonymous
  or de-identified.
- Do not add a compliance, security-certification, clinical-validation, or
  Obsidian-endorsement claim.

## Tests and accessibility

Add a regression test for every behavior change or defect fix. UI changes must
retain keyboard operation, visible focus, semantic labels and roles, readable
contrast, reflow without horizontal scrolling, and touch targets suitable for
the existing mobile layout. Exercise both narrow and desktop widths with
synthetic records.

## Screenshots and visual assets

Capture UI only from a dedicated synthetic vault. Collapse unrelated Obsidian
sidebars and inspect every pixel for vault names, paths, notifications, account
details, and unrelated note titles. Strip image metadata and commit only the
final sanitized asset. Captions and alt text must say when synthetic data is
shown. Generated artwork must be identified as generated and must not be
presented as a product screenshot.

## Pull requests

- Keep the change focused and explain its user and clinical-workflow consequence.
- Describe privacy, data-integrity, accessibility, mobile, and migration effects
  where relevant.
- Update documentation and `CHANGELOG.md` when behavior changes.
- Run `npm run review`, `npm audit`, and `git diff --check` before requesting
  review.
- Do not bump versions, create tags, commit built release assets, or publish a
  release unless a maintainer explicitly requests that release work.
- Confirm that every screenshot, fixture, path, and log is synthetic and safe to
  publish.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
