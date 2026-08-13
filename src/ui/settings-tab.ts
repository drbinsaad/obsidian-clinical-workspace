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
import { ConfirmMaintenanceModal } from "./modals";

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

  /**
   * Applies one settings patch with visible failure handling. A rejected save
   * has already been rolled back by the plugin; re-rendering here stops the
   * control from displaying a value data.json does not hold.
   */
  private async apply(patch: Parameters<ClinicalWorkspacePlugin["updateSettings"]>[0]): Promise<void> {
    try {
      await this.plugin.updateSettings(patch);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "The setting could not be saved.", 7000);
      (this as unknown as { update?: () => void }).update?.();
    }
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
                      void this.apply({ clinicianName: value });
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
                  await this.apply({
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
                  await this.apply({ defaultPathway: value as (typeof PATHWAYS)[number] });
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
                  await this.apply({ defaultPriority: value as (typeof PRIORITIES)[number] });
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
                  await this.apply({ confirmBeforeDischarge: value });
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
                  await this.apply({ runIntegrityOnStartup: value });
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
                    void this.apply({ refreshDebounceMs: parsed });
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
                  .onClick(() => {
                    if (!target.trim()) {
                      new Notice("Enter a folder name. Leaving it blank is not allowed.", 7000);
                      return;
                    }
                    const invalid = validateRootFolder(target);
                    if (invalid) {
                      new Notice(invalid, 7000);
                      return;
                    }
                    const plan = this.migration.plan(target);
                    if (plan.blocked) {
                      new Notice(plan.blocked, 9000);
                      return;
                    }
                    // The move is irreversible from inside the plugin, and the
                    // description above promises explicit confirmation. A
                    // single tap on a destructive button is not that.
                    new ConfirmMaintenanceModal(this.app, {
                      title: "Move all clinical records",
                      lines: [
                        `This moves ${plan.files} note${plan.files === 1 ? "" : "s"} from “${plan.from}” to “${plan.to}” and rewrites their links.`,
                        "Perform a move on one fully synced device at a time, and read the folder-migration guide before continuing. The move cannot be undone from inside the plugin."
                      ],
                      confirmWord: "MOVE",
                      confirmLabel: `Move ${plan.files} note${plan.files === 1 ? "" : "s"}`,
                      onDecide: (confirmed) => {
                        if (!confirmed) return;
                        button.setDisabled(true);
                        void (async () => {
                          try {
                            const result = await this.plugin.migrateRootFolder(target);
                            new Notice(`Moved ${result.files} note${result.files === 1 ? "" : "s"} to “${result.to}”.`, 7000);
                            this.update();
                          } catch (error) {
                            new Notice(error instanceof Error ? error.message : "The move could not be completed.", 9000);
                            button.setDisabled(false);
                          }
                        })();
                      }
                    }).open();
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
            desc: `Ordinary record and scaffold access stays under “${settings.rootFolder}”. A confirmed folder move delegates link rewriting to Obsidian, which may update inbound links elsewhere in the vault. The plugin makes no network requests.`,
            aliases: ["privacy", "permissions", "files", "vault"]
          },
          {
            name: "Plugin settings",
            desc:
              "data.json stores the settings shown here plus path-free initialization/recovery state: booleans, per-entity record counts, a checksum of the opaque record ids, and the plugin version the what's-new window was last shown for. It never stores MRNs, patient names, phone numbers, record paths or clinical record content.",
            aliases: ["privacy", "patient data", "configuration"]
          }
        ]
      }
    ];
  }
}
