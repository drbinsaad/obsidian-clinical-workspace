import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClinicalWorkspacePlugin from "../main";
import { CARE_SETTINGS, PATHWAYS, PRIORITIES } from "../domain/types";
import { careSettingLabel, pathwayLabel, priorityLabel } from "../domain/schema";
import { validateRootFolder } from "../domain/settings";
import type { MigrationService } from "../services/migration";

export class ClinicalSettingTab extends PluginSettingTab {
  private debounceTimers = new Map<string, number>();

  /**
   * Text fields fire on every keystroke, and each write persists data.json and
   * forces a full vault re-read. Coalescing means typing a name costs one write
   * instead of one per character.
   */
  private debounced(key: string, run: () => void, delay = 400): void {
    const existing = this.debounceTimers.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    this.debounceTimers.set(
      key,
      window.setTimeout(() => {
        this.debounceTimers.delete(key);
        run();
      }, delay)
    );
  }

  hide(): void {
    for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
    this.debounceTimers.clear();
    super.hide();
  }

  constructor(
    app: App,
    private readonly plugin: ClinicalWorkspacePlugin,
    private readonly migration: MigrationService
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("clinical-settings");

    // --- Identity ---------------------------------------------------------
    new Setting(containerEl).setName("Identity").setHeading();

    new Setting(containerEl)
      .setName("Your name or initials")
      .setDesc(
        "Recorded as the actor on every audit note. Left blank, the trail reads “local-user”, which is unhelpful if the vault is ever opened elsewhere."
      )
      .addText((field) => {
        field.inputEl.setAttribute("aria-label", "Your name or initials");
        field
          .setPlaceholder("e.g. A. Alshahrani")
          .setValue(this.plugin.settings.clinicianName)
          .onChange((value) => {
            this.debounced("clinicianName", () => void this.plugin.updateSettings({ clinicianName: value }));
          });
      });

    // --- New episode defaults --------------------------------------------
    new Setting(containerEl).setName("New episode defaults").setHeading();
    containerEl.createEl("p", {
      text: "Pre-selected on the Add patient form. Every field can still be changed per patient.",
      cls: "clinical-section-note"
    });

    new Setting(containerEl)
      .setName("Care setting")
      .addDropdown((field) => {
        field.selectEl.setAttribute("aria-label", "Default care setting");
        field
          .addOptions(Object.fromEntries(CARE_SETTINGS.map((v) => [v, careSettingLabel(v)])))
          .setValue(this.plugin.settings.defaultCareSetting)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ defaultCareSetting: value as (typeof CARE_SETTINGS)[number] });
          });
      });

    new Setting(containerEl)
      .setName("Pathway")
      .addDropdown((field) => {
        field.selectEl.setAttribute("aria-label", "Default pathway");
        field
          .addOptions(Object.fromEntries(PATHWAYS.map((v) => [v, pathwayLabel(v)])))
          .setValue(this.plugin.settings.defaultPathway)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ defaultPathway: value as (typeof PATHWAYS)[number] });
          });
      });

    new Setting(containerEl)
      .setName("Priority")
      .addDropdown((field) => {
        field.selectEl.setAttribute("aria-label", "Default priority");
        field
          .addOptions(Object.fromEntries(PRIORITIES.map((v) => [v, priorityLabel(v)])))
          .setValue(this.plugin.settings.defaultPriority)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ defaultPriority: value as (typeof PRIORITIES)[number] });
          });
      });

    // --- Safety -----------------------------------------------------------
    new Setting(containerEl).setName("Safety").setHeading();

    new Setting(containerEl)
      .setName("Confirm before discharge")
      .setDesc("Require the word DISCHARGE to be typed before an episode is archived.")
      .addToggle((field) => {
        field.toggleEl.setAttribute("aria-label", "Confirm before discharge");
        field.setValue(this.plugin.settings.confirmBeforeDischarge).onChange(async (value) => {
          await this.plugin.updateSettings({ confirmBeforeDischarge: value });
        });
      });

    new Setting(containerEl)
      .setName("Run integrity check on first open")
      .setDesc("Reports duplicate MRNs, broken links and unexpected values when the workspace opens. Results stay in the interface.")
      .addToggle((field) => {
        field.toggleEl.setAttribute("aria-label", "Run integrity check on first open");
        field.setValue(this.plugin.settings.runIntegrityOnStartup).onChange(async (value) => {
          await this.plugin.updateSettings({ runIntegrityOnStartup: value });
        });
      });

    new Setting(containerEl)
      .setName("Refresh delay")
      .setDesc("Milliseconds to wait after a vault change before redrawing. Raise it if the interface feels busy during a sync.")
      .addText((field) => {
        field.inputEl.type = "number";
        field.inputEl.setAttribute("aria-label", "Refresh delay in milliseconds");
        field
          .setValue(String(this.plugin.settings.refreshDebounceMs))
          .onChange((value) => {
            // A blank field is mid-edit, not a request for 0 ms.
            if (value.trim() === "") return;
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) return;
            this.debounced("refreshDebounceMs", () =>
              void this.plugin.updateSettings({ refreshDebounceMs: parsed })
            );
          });
      });

    // --- Storage ----------------------------------------------------------
    new Setting(containerEl).setName("Storage").setHeading();

    const current = this.plugin.settings.rootFolder;
    containerEl.createEl("p", {
      text: `All records live under “${current}”. Changing this moves every note and rewrites the links between them, so it is a deliberate migration rather than a setting that takes effect on its own.`,
      cls: "clinical-section-note"
    });

    let target = current;
    const summary = containerEl.createDiv({ cls: "clinical-settings-summary" });
    const describe = () => {
      summary.empty();
      if (!target.trim()) {
        summary.createSpan({ text: "Enter a folder name.", cls: "clinical-settings-blocked" });
        return;
      }
      if (target === current) {
        summary.createSpan({ text: "Enter a different folder to see what would move." });
        return;
      }
      const plan = this.migration.plan(target);
      summary.createSpan({
        text: plan.blocked
          ? plan.blocked
          : `Will move ${plan.files} note${plan.files === 1 ? "" : "s"} from “${plan.from}” to “${plan.to}” and rewrite the links between them.`,
        cls: plan.blocked ? "clinical-settings-blocked" : ""
      });
    };

    new Setting(containerEl)
      .setName("Clinical folder")
      .addText((field) => {
        field.inputEl.setAttribute("aria-label", "Clinical folder");
        field.setValue(current).onChange((value) => {
          target = value;
          // Preview only — nothing is persisted until Move records is pressed.
          this.debounced("rootPreview", () => describe(), 250);
        });
      })
      .addButton((button) => {
        button
          .setButtonText("Move records")
          .setWarning()
          .onClick(async () => {
            if (!target.trim()) {
              new Notice("Enter a folder name. Leaving it blank would move every record to the default folder.", 7000);
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
              this.plugin.settings.rootFolder = plan.to;
              this.display();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "The move could not be completed.", 9000);
              button.setDisabled(false);
            }
          });
      });
    describe();

    // --- Privacy note -----------------------------------------------------
    new Setting(containerEl).setName("Privacy").setHeading();
    containerEl.createEl("p", {
      cls: "clinical-section-note",
      text:
        "These settings are stored in data.json inside this plugin's folder. Only the values above are written there — no patient information is ever stored in plugin settings."
    });
  }
}
