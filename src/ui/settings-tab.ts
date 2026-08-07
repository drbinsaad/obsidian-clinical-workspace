import {
  App,
  Notice,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
  type SettingDefinitionRender
} from "obsidian";
import type ClinicalWorkspacePlugin from "../main";
import { CARE_SETTINGS, PATHWAYS, PRIORITIES } from "../domain/types";
import { careSettingLabel, pathwayLabel, priorityLabel } from "../domain/schema";
import { validateRootFolder } from "../domain/settings";
import type { MigrationService } from "../services/migration";

function renderSetting(
  name: string,
  desc: string,
  render: (setting: Setting) => void,
  aliases: string[] = []
): SettingDefinitionRender {
  return { name, desc, aliases, render };
}

export class ClinicalSettingTab extends PluginSettingTab {
  private debounceTimers = new Map<string, { timer: number; run: () => void }>();

  constructor(
    app: App,
    private readonly plugin: ClinicalWorkspacePlugin,
    private readonly migration: MigrationService
  ) {
    super(app, plugin);
  }

  /** Coalesces text-field writes so ordinary typing does not rewrite data.json repeatedly. */
  private debounced(key: string, run: () => void, delay = 400): void {
    const existing = this.debounceTimers.get(key);
    if (existing) window.clearTimeout(existing.timer);
    this.debounceTimers.set(
      key,
      {
        run,
        timer: window.setTimeout(() => {
          this.debounceTimers.delete(key);
          run();
        }, delay)
      }
    );
  }

  hide(): void {
    const pending = [...this.debounceTimers.values()];
    for (const { timer } of pending) window.clearTimeout(timer);
    this.debounceTimers.clear();
    for (const { run } of pending) run();
    super.hide();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;

    return [
      {
        name: "About Clinical Workspace",
        desc:
          "A local clinical workflow aid, not an EHR, prescribing system, diagnostic system, or autonomous clinical decision-support tool.",
        aliases: ["privacy", "clinical records", "patient workflow"]
      },
      {
        type: "group",
        heading: "Identity",
        cls: "clinical-settings",
        items: [
          renderSetting(
            "Your name or initials",
            "Recorded as the actor on every audit note. Left blank, the trail reads local-user.",
            (row) => {
              row.addText((field) => {
                field.inputEl.setAttribute("aria-label", "Your name or initials");
                field
                  .setPlaceholder("E.g. A. Alshahrani")
                  .setValue(settings.clinicianName)
                  .onChange((value) => {
                    this.debounced("clinicianName", () => {
                      void this.plugin.updateSettings({ clinicianName: value });
                    });
                  });
              });
            },
            ["clinician", "audit actor"]
          )
        ]
      },
      {
        type: "group",
        heading: "New episode defaults",
        cls: "clinical-settings",
        items: [
          {
            name: "Default behavior",
            desc: "These values are pre-selected on the Add patient form and remain editable for every episode.",
            aliases: ["patient", "form"]
          },
          renderSetting("Care setting", "Default inpatient or outpatient setting.", (row) => {
            row.addDropdown((field) => {
              field.selectEl.setAttribute("aria-label", "Default care setting");
              field
                .addOptions(Object.fromEntries(CARE_SETTINGS.map((value) => [value, careSettingLabel(value)])))
                .setValue(settings.defaultCareSetting)
                .onChange(async (value) => {
                  await this.plugin.updateSettings({
                    defaultCareSetting: value as (typeof CARE_SETTINGS)[number]
                  });
                });
            });
          }),
          renderSetting("Pathway", "Default clinical pathway for a new episode.", (row) => {
            row.addDropdown((field) => {
              field.selectEl.setAttribute("aria-label", "Default pathway");
              field
                .addOptions(Object.fromEntries(PATHWAYS.map((value) => [value, pathwayLabel(value)])))
                .setValue(settings.defaultPathway)
                .onChange(async (value) => {
                  await this.plugin.updateSettings({ defaultPathway: value as (typeof PATHWAYS)[number] });
                });
            });
          }),
          renderSetting("Priority", "Default priority for a new episode.", (row) => {
            row.addDropdown((field) => {
              field.selectEl.setAttribute("aria-label", "Default priority");
              field
                .addOptions(Object.fromEntries(PRIORITIES.map((value) => [value, priorityLabel(value)])))
                .setValue(settings.defaultPriority)
                .onChange(async (value) => {
                  await this.plugin.updateSettings({ defaultPriority: value as (typeof PRIORITIES)[number] });
                });
            });
          })
        ]
      },
      {
        type: "group",
        heading: "Safety",
        cls: "clinical-settings",
        items: [
          renderSetting(
            "Confirm before discharge",
            "Require the word DISCHARGE to be typed before an episode is archived.",
            (row) => {
              row.addToggle((field) => {
                field.toggleEl.setAttribute("aria-label", "Confirm before discharge");
                field.setValue(settings.confirmBeforeDischarge).onChange(async (value) => {
                  await this.plugin.updateSettings({ confirmBeforeDischarge: value });
                });
              });
            },
            ["archive", "confirmation"]
          ),
          renderSetting(
            "Run integrity check on first open",
            "Report duplicate MRNs, broken links and unexpected values when the workspace opens. Results stay in the interface.",
            (row) => {
              row.addToggle((field) => {
                field.toggleEl.setAttribute("aria-label", "Run integrity check on first open");
                field.setValue(settings.runIntegrityOnStartup).onChange(async (value) => {
                  await this.plugin.updateSettings({ runIntegrityOnStartup: value });
                });
              });
            },
            ["startup", "data check", "duplicates"]
          ),
          renderSetting(
            "Refresh delay",
            "Milliseconds to wait after a managed-folder change before redrawing. Valid range: 0–2000.",
            (row) => {
              const description =
                "Milliseconds to wait after a managed-folder change before redrawing. Valid range: 0–2000.";
              row.addText((field) => {
                field.inputEl.type = "number";
                field.inputEl.min = "0";
                field.inputEl.max = "2000";
                field.inputEl.setAttribute("aria-label", "Refresh delay in milliseconds");
                field.setValue(String(settings.refreshDebounceMs)).onChange((value) => {
                  if (value.trim() === "") return;
                  const parsed = Number(value);
                  const invalid = !Number.isFinite(parsed) || parsed < 0 || parsed > 2000;
                  field.inputEl.toggleClass("is-error", invalid);
                  row.setDesc(invalid ? "Enter a number from 0 to 2000 milliseconds." : description);
                  if (invalid) return;
                  this.debounced("refreshDebounceMs", () => {
                    void this.plugin.updateSettings({ refreshDebounceMs: parsed });
                  });
                });
              });
            },
            ["performance", "sync", "debounce"]
          )
        ]
      },
      {
        type: "group",
        heading: "Storage",
        cls: "clinical-settings",
        items: [
          renderSetting(
            "Clinical folder",
            `All managed records currently live under “${settings.rootFolder}”. Moving them rewrites their links and requires explicit confirmation.`,
            (row) => {
              const current = settings.rootFolder;
              let target = current;
              const summary = row.settingEl.createDiv({ cls: "clinical-settings-summary" });
              const describe = (): void => {
                summary.empty();
                if (!target.trim()) {
                  summary.createSpan({ text: "Enter a folder name.", cls: "clinical-settings-blocked" });
                  return;
                }
                if (target === current) {
                  summary.createSpan({ text: "Enter a different folder to preview the migration." });
                  return;
                }
                const plan = this.migration.plan(target);
                summary.createSpan({
                  text: plan.blocked
                    ? plan.blocked
                    : `Will move ${plan.files} note${plan.files === 1 ? "" : "s"} from “${plan.from}” to “${plan.to}” and rewrite their links.`,
                  cls: plan.blocked ? "clinical-settings-blocked" : ""
                });
              };

              row.addText((field) => {
                field.inputEl.setAttribute("aria-label", "Clinical folder");
                field.setValue(current).onChange((value) => {
                  target = value;
                  this.debounced("rootPreview", describe, 250);
                });
              });
              row.addButton((button) => {
                button
                  .setButtonText("Move records")
                  .setDestructive()
                  .onClick(async () => {
                    if (!target.trim()) {
                      new Notice("Enter a folder name. Leaving it blank is not allowed.", 7000);
                      return;
                    }
                    const invalid = validateRootFolder(target);
                    if (invalid) {
                      new Notice(invalid, 7000);
                      return;
                    }
                    button.setDisabled(true);
                    try {
                      const plan = await this.plugin.migrateRootFolder(target);
                      new Notice(`Moved ${plan.files} note${plan.files === 1 ? "" : "s"} to “${plan.to}”.`, 7000);
                      this.update();
                    } catch (error) {
                      new Notice(error instanceof Error ? error.message : "The move could not be completed.", 9000);
                      button.setDisabled(false);
                    }
                  });
              });
              describe();
            },
            ["records", "root", "migration", "path"]
          )
        ]
      },
      {
        type: "group",
        heading: "Privacy and capabilities",
        cls: "clinical-settings",
        items: [
          {
            name: "Managed-folder access",
            desc: `The plugin reads and writes Markdown only under “${settings.rootFolder}”. It does not enumerate unrelated vault files and makes no network requests.`,
            aliases: ["privacy", "permissions", "files", "vault"]
          },
          {
            name: "Plugin settings",
            desc:
              "data.json stores only the settings shown here. It never stores MRNs, patient names, phone numbers or clinical record content.",
            aliases: ["privacy", "patient data", "configuration"]
          }
        ]
      }
    ];
  }
}
