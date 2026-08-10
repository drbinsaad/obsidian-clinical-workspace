## Summary

<!-- What changes, and what user outcome does it improve? -->

## Workflow and safety impact

<!-- Describe effects on records, Sync, migrations, exports, privacy, mobile use, and accessibility. Write "None" where a category is not affected. -->

## Verification

<!-- List commands and manual checks. -->

- [ ] `npm run review`
- [ ] `npm audit`
- [ ] `git diff --check`
- [ ] New or changed behavior has regression coverage.

## Public-data checklist

- [ ] No real patient information, clinical export, live-vault file, identifier, path, or clinical free text is included.
- [ ] Tests and examples use fictional names and synthetic `9000...` identifiers.
- [ ] Screenshots come from a dedicated synthetic vault, expose no unrelated screen chrome, have metadata removed, and are captioned as synthetic.
- [ ] Generated artwork, if any, is identified as generated and is not presented as a product screenshot.

## Release boundaries

- [ ] The Obsidian runtime remains local-first, no-network, and scoped to the configured clinical folder.
- [ ] Repository-only Node.js tools remain outside the plugin bundle.
- [ ] No version, tag, built release asset, or publication change is included unless explicitly requested.
- [ ] User-facing behavior and notable changes are documented.
