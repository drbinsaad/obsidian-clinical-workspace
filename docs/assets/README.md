# Documentation assets

Only synthetic or non-data-bearing visuals belong in this directory.

| Asset | Purpose and data status |
|---|---|
| `hero.png` | AI-generated abstract project artwork created with OpenAI image generation on 2026-08-10 from a project-authored, text-free clinical-workflow prompt and no reference image. It contains no patient record and is not an application screenshot. Its generator-supplied C2PA content credential is retained as provenance. |
| `patients-desktop.png` | Real Clinical Workspace 0.3.6 UI in Obsidian, captured from a disposable demonstration vault. The visible records are Synthetic Patient Alpha and Synthetic Patient Beta with `9000`-series MRNs and the reserved demonstration phone value `0500000001`; no real patient data is present. |

`npm run verify-assets` locks the reviewed PNG bytes and rejects embedded EXIF
or text chunks. Any intentional visual change therefore requires an explicit
checksum update after another pixel-level privacy review.

These documentation assets are distributed with the repository under the
[MIT License](../../LICENSE). Obsidian names, interface elements, and trademarks
visible in the product capture remain the property of their respective owners;
this project is not endorsed by Obsidian.

For future captures:

- use a disposable, unsynced vault containing synthetic records only;
- keep account details, vault names, filesystem paths, notifications, recent
  files, and unrelated note titles out of frame;
- inspect every visible value and OCR result before committing;
- crop unwanted content instead of blurring it; and
- remove EXIF, location, and other unnecessary metadata.

Never capture a real clinical vault, even if the intended screenshot area seems
empty.
