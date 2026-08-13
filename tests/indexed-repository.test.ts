/**
 * Behavior of the path-keyed record index: warm lists must not re-read
 * files, invalidation must re-read exactly the changed path, deletions must
 * never be masked, and write verification must keep the index authoritative.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TFile } from "obsidian";
import type { EpisodeRecord, TaskRecord } from "../src/domain/types";
import { episodeInput, harness, type Harness } from "./support/harness";

/** Counts cachedRead calls without changing what they return. */
function countReads(h: Harness): { count: () => number; reset: () => void } {
  const vault = h.app.vault as unknown as {
    cachedRead: (file: TFile) => Promise<string>;
  };
  const original = vault.cachedRead.bind(vault);
  let reads = 0;
  vault.cachedRead = async (file: TFile) => {
    reads += 1;
    return original(file);
  };
  return { count: () => reads, reset: () => (reads = 0) };
}

test("warm lists are served from the index without re-reading any file", async () => {
  const h = await harness();
  await h.service.createEpisode(
    episodeInput({ mrn: "9000000301", caseName: "Index case A", nextAction: "Review", dueDate: "2026-09-01" })
  );
  await h.service.createEpisode(episodeInput({ mrn: "9000000302", caseName: "Index case B" }));
  const reads = countReads(h);

  await h.repository.snapshot(); // warm every folder once
  reads.reset();
  await h.repository.snapshot();
  assert.equal(reads.count(), 0, "a warm snapshot re-reads nothing");

  // Invalidating one path re-reads exactly that file on the next list.
  const task = (await h.repository.list<TaskRecord>("task"))[0]!;
  reads.reset();
  h.repository.invalidatePath(task.path);
  await h.repository.snapshot();
  assert.equal(reads.count(), 1, "only the invalidated path is re-read");
});

test("a deleted note is never served from a stale index entry", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({ nextAction: "Review", dueDate: "2026-09-01" })
  );
  const task = created.task!;
  await h.repository.snapshot(); // index the task

  // Deleted externally; the plugin's delete handler invalidates, but even
  // WITHOUT that the existence check must win over the index.
  (h.app.vault as unknown as { deleteRaw(path: string): void }).deleteRaw(task.path);
  const listed = await h.repository.list<TaskRecord>("task");
  assert.equal(
    listed.some((item) => item.record.id === task.record.id),
    false,
    "the index must not resurrect a deleted note"
  );
});

test("write verification keeps the index fresh without extra reads", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({ nextAction: "Review", dueDate: "2026-09-01" })
  );
  await h.repository.snapshot();
  await h.service.updateEpisode(created.episode.record.id, {
    careSetting: "inpatient",
    pathway: "assessment",
    priority: "urgent",
    nextAction: "Review",
    dueDate: "2026-09-01"
  });
  const reads = countReads(h);
  const episode = (await h.repository.list<EpisodeRecord>("episode"))[0]!;
  assert.equal(episode.record.priority, "urgent", "the verified write is what the index serves");
  assert.equal(reads.count(), 0, "the fresh verification read already updated the index");
});
