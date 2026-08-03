import type { NewEpisodeInput } from "../domain/types";
import { todayIso } from "../domain/schema";
import { ClinicalService } from "./clinical-service";

function dateOffset(days: number): string {
  const date = new Date(`${todayIso()}T12:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function seedSyntheticFixtures(service: ClinicalService): Promise<number> {
  const fixtures: NewEpisodeInput[] = [
    {
      mrn: "9000000001",
      patientName: "Synthetic Patient Alpha",
      phone: "0500000001",
      caseName: "Synthetic airway follow-up",
      careSetting: "outpatient",
      pathway: "opd-follow-up",
      priority: "routine",
      nextAction: "Call family and confirm symptoms",
      dueDate: todayIso()
    },
    {
      mrn: "9000000002",
      patientName: "Synthetic Patient Beta",
      phone: "",
      caseName: "Synthetic adenotonsillectomy booking",
      careSetting: "outpatient",
      pathway: "or-booking",
      priority: "urgent",
      nextAction: "Confirm OR booking date",
      dueDate: dateOffset(2)
    },
    {
      mrn: "",
      patientName: "Synthetic Patient Gamma",
      phone: "",
      caseName: "Synthetic CT result review",
      careSetting: "inpatient",
      pathway: "result-review",
      priority: "emergency",
      nextAction: "Review CT result",
      dueDate: dateOffset(-1)
    }
  ];
  let created = 0;
  for (const fixture of fixtures) {
    const result = await service.createEpisode(fixture);
    if (!result.duplicateEpisode) created += 1;
  }
  return created;
}
