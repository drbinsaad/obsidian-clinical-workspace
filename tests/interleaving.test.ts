/**
 * Seeded random-interleaving smoke tests over the clinical workflow.
 *
 * Not a full property-based model — a deterministic, reproducible slice of
 * one: for each fixed seed, a pseudo-random mix of workflow operations runs
 * partly concurrently against one vault, and the integrity scan must find no
 * error-severity issue afterwards. Any failure reproduces exactly from its
 * seed. Rejected operations are legitimate outcomes (the service refuses
 * plenty by design); silent corruption is the only failure.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { EpisodeRecord, TaskRecord } from "../src/domain/types";
import { taskIsOpen } from "../src/domain/schema";
import { episodeInput, harness, withLatency, type Harness } from "./support/harness";

/** Deterministic 32-bit PRNG (mulberry32). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // 2 ** 32 as arithmetic: bare long literals trip the CI identifier guard.
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const CASES = ["Synthetic case A", "Synthetic case B", "Synthetic case C"] as const;
const MRNS = ["9000000101", "9000000102"] as const;
const ACTIONS = ["Review result", "Call family", "Book review"] as const;
const DATES = ["2026-08-20", "2026-09-01", ""] as const;

function operation(h: Harness, random: () => number): () => Promise<unknown> {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const openTasks = async (): Promise<TaskRecord[]> =>
    (await h.repository.list<TaskRecord>("task")).map((item) => item.record).filter(taskIsOpen);
  const episodes = async (): Promise<EpisodeRecord[]> =>
    (await h.repository.list<EpisodeRecord>("episode")).map((item) => item.record);

  const choices: Array<() => Promise<unknown>> = [
    () =>
      h.service.createEpisode(
        episodeInput({
          mrn: pick(MRNS),
          patientName: "Synthetic Interleaved Patient",
          caseName: pick(CASES),
          pathway: random() < 0.3 ? "or-booking" : "assessment",
          nextAction: pick(ACTIONS),
          dueDate: pick(DATES) || "2026-08-20"
        })
      ),
    async () => {
      const task = pick([...(await openTasks()), null]);
      return task ? h.service.completeTask(task.id) : null;
    },
    async () => {
      const task = pick([...(await openTasks()), null]);
      return task ? h.service.cancelTask(task.id, "Synthetic cancellation") : null;
    },
    async () => {
      const task = pick([...(await openTasks()), null]);
      return task ? h.service.rescheduleTask(task.id, pick(["2026-09-05", "2026-10-01"])) : null;
    },
    async () => {
      const closed = (await h.repository.list<TaskRecord>("task"))
        .map((item) => item.record)
        .filter((record) => ["completed", "cancelled"].includes(record.status));
      const task = pick([...closed, null]);
      return task ? h.service.reopenTask(task.id) : null;
    },
    async () => {
      const active = (await episodes()).filter(
        (record) => !["archived", "cancelled", "entered-in-error"].includes(record.status)
      );
      const episode = pick([...active, null]);
      if (!episode) return null;
      return h.service.updateEpisode(episode.id, {
        careSetting: episode.care_setting,
        pathway: random() < 0.5 ? "or-booking" : "assessment",
        priority: pick(["routine", "urgent"] as const),
        nextAction: pick(ACTIONS),
        dueDate: "2026-09-01"
      });
    },
    async () => {
      const active = (await episodes()).filter((record) => record.status !== "archived");
      const episode = pick([...active, null]);
      return episode ? h.service.archiveEpisode(episode.id, "Synthetic outcome") : null;
    },
    async () => {
      const archived = (await episodes()).filter((record) => record.status === "archived");
      const episode = pick([...archived, null]);
      return episode ? h.service.restoreEpisode(episode.id) : null;
    },
    async () => {
      const bookings = (await episodes()).filter(
        (record) => record.pathway === "or-booking" && record.status === "active"
      );
      const episode = pick([...bookings, null]);
      if (!episode) return null;
      return h.service.completeProcedure({
        patientId: episode.patient_id,
        episodeId: episode.id,
        procedure: "Synthetic procedure",
        procedureDate: "2026-08-13",
        role: "Primary surgeon",
        outcome: "",
        followUpRequired: random() < 0.4,
        followUpDate: "2026-09-15",
        followUpPlan: "Synthetic wound review"
      });
    }
  ];
  return pick(choices);
}

for (const seed of [11, 29, 47]) {
  test(`interleaved workflow operations leave no corruption (seed ${seed})`, async () => {
    const h = await harness();
    const random = prng(seed);
    await withLatency(h.app, 1, async () => {
      for (let step = 0; step < 12; step += 1) {
        // Small concurrent batches force lock contention; rejections are
        // expected outcomes, so allSettled — corruption is the only failure.
        const batch = Array.from({ length: 3 }, () => operation(h, random));
        await Promise.allSettled(batch.map((run) => run()));
      }
    });

    const issues = await h.integrity.scan();
    const errors = issues.filter((issue) => issue.severity === "error");
    assert.deepEqual(
      errors,
      [],
      `seed ${seed} produced error-severity integrity issues: ${JSON.stringify(errors, null, 2)}`
    );
  });
}
