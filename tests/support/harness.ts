import { App } from "obsidian";
import type { App as StubApp } from "./obsidian-stub";
import { ClinicalRepository } from "../../src/data/repository";
import { ClinicalService } from "../../src/services/clinical-service";
import { IntegrityService } from "../../src/services/integrity";
import type { NewEpisodeInput } from "../../src/domain/types";

export interface Harness {
  app: StubApp;
  repository: ClinicalRepository;
  service: ClinicalService;
  integrity: IntegrityService;
}

/** A fresh in-memory vault with the clinical folder structure in place. */
export async function harness(): Promise<Harness> {
  const app = new App() as unknown as StubApp;
  const repository = new ClinicalRepository(app as unknown as App);
  await repository.ensureStructure();
  return {
    app,
    repository,
    service: new ClinicalService(repository),
    integrity: new IntegrityService(repository)
  };
}

export const episodeInput = (overrides: Partial<NewEpisodeInput> = {}): NewEpisodeInput => ({
  mrn: "5001",
  patientName: "Test Patient",
  phone: "",
  caseName: "Test case",
  careSetting: "outpatient",
  pathway: "assessment",
  priority: "routine",
  nextAction: "",
  dueDate: "",
  ...overrides
});

/** Runs `fn` with an artificial delay between vault reads and writes. */
export async function withLatency<T>(app: StubApp, ms: number, fn: () => Promise<T>): Promise<T> {
  app.vault.latency = ms;
  try {
    return await fn();
  } finally {
    app.vault.latency = 0;
  }
}
