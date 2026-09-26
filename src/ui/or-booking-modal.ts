import { App, Setting } from "obsidian";
import { canonicalOption, isIsoDate, priorityLabel } from "../domain/schema";
import { CARE_SETTINGS, PRIORITIES } from "../domain/types";
import type { EpisodeRecord, EpisodeUpdateInput, Priority } from "../domain/types";
import { ClinicalModal } from "./modals";

/** Draft fields may seed a form only after the user has selected an episode. */
export interface OrBookingSeed {
  nextAction?: string;
  dueDate?: string;
  priority?: Priority;
}

/** Planned work uses updateEpisode; it never creates a performed procedure. */
export class BookOrModal extends ClinicalModal<EpisodeUpdateInput> {
  private readonly input: EpisodeUpdateInput;
  protected returnSubmits = false;

  constructor(
    app: App,
    private readonly episode: EpisodeRecord,
    onSubmit: (input: EpisodeUpdateInput) => Promise<void>,
    seed: OrBookingSeed = {},
    private readonly patientLabel = ""
  ) {
    super(app, "Save OR booking", onSubmit);
    this.input = {
      careSetting: canonicalOption(episode.care_setting, CARE_SETTINGS) ?? "outpatient",
      pathway: "or-booking",
      priority: canonicalOption(seed.priority ?? episode.priority, PRIORITIES) ?? "routine",
      // An unrelated current task is not an implied surgical booking.
      nextAction: seed.nextAction ?? "",
      dueDate: seed.dueDate ?? "",
      expectedUpdatedAt: episode.updated_at
    };
  }

  onOpen(): void {
    const form = this.prepare(
      "Book OR",
      "Plan surgery and its next action. This is planned surgery; it does not record a performed procedure or add a logbook entry."
    );
    form.createEl("h3", { text: this.episode.case, attr: { dir: "auto" } });
    if (this.patientLabel) {
      form.createEl("p", { text: this.patientLabel, cls: "clinical-card-meta", attr: { dir: "auto" } });
    }
    form.createEl("p", { text: "Pathway: OR booking", cls: "clinical-section-note" });
    new Setting(form).setName("Next action")
      .setDesc("Required. Describe the booking plan. Saving replaces the current next action when it differs.")
      .addText((field) => {
        field.inputEl.setAttribute("aria-label", "Next action");
        field.inputEl.required = true;
        field.setValue(this.input.nextAction).setPlaceholder("Book planned surgery / confirm theatre date").onChange((value) => {
          this.input.nextAction = value;
        });
      });
    this.addDateSetting(form, "Due date", this.input.dueDate, (value) => { this.input.dueDate = value; }, true);
    new Setting(form).setName("Priority").addDropdown((field) => {
      field.selectEl.setAttribute("aria-label", "Priority");
      field.addOptions(Object.fromEntries(PRIORITIES.map((priority) => [priority, priorityLabel(priority)])))
        .setValue(this.input.priority).onChange((value) => { this.input.priority = value as Priority; });
    });
    this.addActions(this.contentEl);
  }

  protected value(): EpisodeUpdateInput {
    const nextAction = this.input.nextAction.trim();
    if (!nextAction) throw new Error("Enter the next action for this OR booking.");
    if (!this.input.dueDate) throw new Error("Choose the due date for this OR booking.");
    if (!isIsoDate(this.input.dueDate)) throw new Error("Due date is invalid.");
    return { ...this.input, nextAction, pathway: "or-booking" };
  }
}
