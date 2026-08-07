# Contributing

Thank you for helping improve Clinical Workspace.

## Patient-information prohibition

Never include real patient information in an issue, pull request, commit, test, screenshot, log or sample vault. Use obviously synthetic `9000...` MRNs, fictional names and invented clinical text.

Security problems must be reported through a private GitHub security advisory as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm run review
```

`npm run review` performs strict TypeScript checking, Obsidian community linting, production building, the full test suite, release verification and a Community-review preflight.

Development tooling is compiled out of normal builds. If you intentionally enable it with `CLINICAL_DEV_TOOLS=1`, never install that build into a vault that contains real patient information.

## Pull requests

- Keep changes focused and explain the clinical-workflow consequence.
- Add a regression test for every behavior change or defect fix.
- Preserve the local-only, no-network design.
- Preserve the configured-folder access boundary.
- Do not introduce deletion when a reversible status transition is possible.
- Confirm `npm run review` passes before requesting review.
