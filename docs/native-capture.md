# Native iPhone capture inbox

Capture a patient/episode, task, procedure, or OR-booking draft in Obsidian's
native Quick Capture, then review it inside Clinical Workspace. Native capture
saves an ordinary Markdown note before the vault loads. The plugin cannot run
its forms or create clinical records until the vault and plugin have loaded.

Native Quick Capture was introduced for **iOS 26** in **Obsidian 1.14.0 Mobile**,
currently a **Catalyst** early-access release. The configurable Home Screen
widget and direct Location selection arrived in 1.14.1. See the official
[1.14.0 release notes](https://obsidian.md/changelog/2026-09-02-mobile-v1.14.0/)
and [1.14.1 release notes](https://obsidian.md/changelog/2026-09-08-mobile-v1.14.1/).
Older versions can still use [Quick Entry commands](quick-entry.md).

This workflow has been checked on macOS with synthetic files; the native
physical iPhone widget has **not been tested** for this release. Start in a
disposable vault with synthetic data and verify your installed version's
Location settings and saved note before relying on the workflow.

## One-time setup

1. Open the intended vault and initialize Clinical Workspace.
2. Run **Clinical Workspace: Set up native capture**, or choose **Capture
   inbox** in the workspace header or Quick Entry hub and use setup there.
3. Setup creates these paths beneath your configured clinical root. It leaves
   existing files untouched, including templates you have customized.

| Path beneath the clinical root | Purpose |
|---|---|
| `Inbox/Capture` | Native notes awaiting review; use this as the destination folder. |
| `Templates/Capture/patient.md` | New patient/episode draft template. |
| `Templates/Capture/task.md` | Task/follow-up draft template. |
| `Templates/Capture/procedure.md` | Completed-procedure draft template. |
| `Templates/Capture/or-booking.md` | Planned OR-booking draft template. |

4. In native Quick Capture, create a **Location** for each desired kind. Choose
   the same vault, set the behavior to **New Note**, select the full
   `<clinical root>/Inbox/Capture` folder, and choose the matching template.
   Do not target Patients, Episodes, Tasks, or Procedures directly.
5. Use a neutral custom title such as `Task capture`, with a date prefix
   `YYYYMMDDHHmmss` where your version offers it. Automatic titles may include
   captured text. A timestamp is not a uniqueness guarantee: test rapid
   captures and check for filename collisions. Do not put patient details in
   titles, widget labels, or shortcut names. The plugin never interprets a
   filename as a patient identifier.
6. Add the native Quick Capture widget or shortcut and select the Location.
   Opening Obsidian after capture is optional; review can wait until later.

The templates contain only a small static header and blank body. They contain
no patient records, record IDs, scripts, location variables, or `{{content}}`
placeholder. Obsidian documents applying a template before adding captured
content in its [native sharing help](https://obsidian.md/help/ios). Verify that
your Quick Capture version retains the header and adds your text below it.

## Capture, review, and save

1. Capture a short note with the appropriate Location and save it.
2. Open Clinical Workspace and select **Capture inbox**, or run
   **Clinical Workspace: Review capture inbox**. The workspace discovers
   direct Markdown children of the capture folder on open, refresh, and vault
   changes. Nested folders and notes outside that folder are excluded.
3. Review the captured text. Opening or scanning the inbox creates no clinical
   records. The text can prefill an action field, but it is not automatically
   split into a patient identity, date, or episode match. Check and edit every
   proposed value in the ordinary form before submitting.
4. For a task, procedure, or OR booking, explicitly select the intended patient
   episode from the initially unselected picker. A name or MRN in a capture
   does not bypass that choice. New patient/episode entry retains the normal
   MRN-owner and possible-duplicate checks described in the
   [patient-entry guide](user-guide.md#how-do-i-add-a-patient).
5. Submit the form once. **Book OR** plans surgery by updating the selected
   episode and its booking work; it does not log a completed operation.
   Procedure capture uses the existing procedure workflow and its eligibility
   and repeat-operation checks.

Native notes remain in the capture folder after filing so their original text
can be reviewed. They are drafts, not managed clinical records, and are not
included as patient, task, or procedure records in clinical indexes or exports.
The inbox shows up to 200 files. Move filed or reviewed drafts to an archive
outside the capture inbox when it fills, keeping their receipt properties.
Captured text longer than 2,000 characters remains visible in full but does
not prefill an action field; enter a concise summary in the form.

## Interrupted or uncertain saves

Before a clinical write, the plugin marks the draft `processing` with a unique
attempt token. A confirmed success marks it `filed` and records the resulting
record IDs. Local repeated taps or reopening the same marked draft cannot
submit it again.

If a save is interrupted or its outcome is uncertain, the draft remains
blocked in `processing`, with its original captured text preserved. Check the
patient, episode, tasks, and logbook to establish what was saved. Only then
enable **I checked the records; mark reviewed**, then tap **Mark reviewed**.
This marks the draft
`reviewed`; it does not create records or retry the previous action. Correct
any missing or incorrect work through the ordinary clinical workflow. Do not
remove receipt properties or copy a draft to bypass the block. There is no
automatic retry of an uncertain conversion.

This is local duplicate prevention, **not an exactly-once guarantee across
devices**. Process captures on **one device** and allow Sync to finish before
switching devices. Renaming or copying a marked note retains its state, but
conflicting unsynced copies cannot be coordinated by the plugin.

## Optional structured fields

A surgery capture without a quoted `procedure_date` starts with a blank surgery
date. Choose when the operation actually happened; the filing date is not used
automatically. Dates and patient/episode choices always need review.

Plain captured text is enough. For a custom template, the only required
properties are `clinical_capture: 1` and one `capture_kind`: `patient`, `task`,
`procedure`, or `or-booking`. This synthetic example preserves leading zeros:

```yaml
---
clinical_capture: 1
capture_kind: "patient"
mrn: "9000"
patient_name: "Synthetic Patient"
phone: "0500000000"
case: "Synthetic review"
---
Captured text for review goes here.
```

Optional text fields are `mrn`, `patient_name`, `phone`, `case`, `task`,
`task_type`, `due_date`, `priority`, `procedure`, `procedure_date`, `outcome`,
and `next_action`. Use JSON-style double-quoted strings; no YAML aliases,
multiline property blocks, numbers, record IDs, or force flags. Fields are
form suggestions, never authority to select a patient or bypass validation.
Unsupported schemas, malformed headers, duplicate keys, or notes over 64 KiB
are refused. Keep plugin-owned `capture_state`, `capture_attempt`, and
`capture_result` properties intact once processing starts.

## Privacy boundaries

Clinical Workspace adds no network requests for capture and puts no patient
information in URLs. Obsidian Sync, iCloud, device backups, keyboard dictation,
and lock-screen visibility retain their own privacy boundaries. Configure
those systems according to your approved environment and read
[Security and privacy](../SECURITY.md). Test using synthetic records first;
the example and templates contain no real patient data.
