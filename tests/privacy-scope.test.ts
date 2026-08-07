import assert from "node:assert/strict";
import test from "node:test";
import { episodeInput, harness } from "./support/harness";

test("clinical scans ignore unrelated vault folders", async () => {
  const { app, repository, service, integrity } = await harness();
  await service.createEpisode(episodeInput({ mrn: "90005001" }));

  await app.vault.createFolder("Unrelated notes");
  await app.vault.create(
    "Unrelated notes/PAT-outside.md",
    "---\nentity: patient\nid: PAT-outside\nmrn: 90009999\npatient_name: Outside record\nstatus: active\n---\n"
  );

  const patients = await repository.list("patient");
  const snapshot = await repository.snapshot();
  const issues = await integrity.scan();

  assert.equal(patients.length, 1);
  assert.equal(snapshot.patients.length, 1);
  assert.equal(snapshot.patients[0]?.mrn, "90005001");
  assert.equal(issues.some((issue) => issue.path.startsWith("Unrelated notes/")), false);
});
