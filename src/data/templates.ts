import type { Vault } from "obsidian";
import type { Pathway, Priority, TaskType } from "../domain/types";
import { PATHWAYS, PRIORITIES, TASK_TYPES } from "../domain/types";
import { normalizeArabicDigits, normalizeText } from "../domain/schema";
import { parseFrontmatter } from "./markdown";
import { clinicalFolder } from "./paths";
import { markdownFilesInFolder } from "./vault-scope";

/**
 * A user-authored task bundle: a note in the Templates folder whose
 * frontmatter declares the standard tasks for a pathway (for example
 * "Tonsillectomy: consent → book OR → post-op review"). Applying a bundle is
 * always an explicit, previewed action — templates never run automatically,
 * and the ordinary duplicate suppression makes re-applying one safe.
 */
export interface TaskBundleItem {
  task: string;
  taskType: TaskType;
  priority: Priority | null;
  /** Days from today for the task's due date; null leaves it undated. */
  dueInDays: number | null;
}

export interface TaskBundle {
  name: string;
  path: string;
  /** Restricts the bundle to one pathway; null offers it everywhere. */
  pathway: Pathway | null;
  tasks: TaskBundleItem[];
  /**
   * What was dropped or defaulted while reading the bundle. Bundles are
   * hand-written YAML, and a silent fallback (an undated task, the episode's
   * priority) is exactly the follow-up slippage they exist to prevent. Built
   * only from fixed wording and item positions, never from note text.
   */
  warnings: string[];
}

const TEMPLATE_MARKER = "task-bundle";

/** Hand-typed enum values: "Urgent " and "Book-OR" mean what they say. */
function enumText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
}

/** Whole days from a number or an integer string, Arabic-Indic digits included. */
function wholeDays(value: unknown): number | null {
  const text = typeof value === "string" ? normalizeArabicDigits(normalizeText(value)) : "";
  const days = typeof value === "number" ? value : /^\d+$/.test(text) ? Number(text) : Number.NaN;
  return Number.isInteger(days) && days >= 0 && days <= 730 ? days : null;
}

function bundleItem(value: unknown, position: number, warnings: string[]): TaskBundleItem | null {
  const label = `Item ${position}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`${label} is not a task entry and was skipped.`);
    return null;
  }
  const raw = value as Record<string, unknown>;
  const task = normalizeText(raw.task);
  if (!task) {
    warnings.push(`${label} has no task text and was skipped.`);
    return null;
  }
  const typeText = enumText(raw.task_type);
  const taskType = TASK_TYPES.find((type) => type === typeText) ?? "other";
  if (isPresent(raw.task_type) && taskType !== typeText) {
    warnings.push(`${label}: task type not recognised, so it will be created as "other".`);
  }
  const priorityText = enumText(raw.priority);
  const priority = PRIORITIES.find((option) => option === priorityText) ?? null;
  if (isPresent(raw.priority) && !priority) {
    warnings.push(`${label}: priority not recognised, so the episode's priority will be used.`);
  }
  const dueInDays = wholeDays(raw.due_in_days);
  if (isPresent(raw.due_in_days) && dueInDays === null) {
    warnings.push(`${label}: due_in_days is not a whole number from 0 to 730, so the task will be undated.`);
  }
  return { task, taskType, priority, dueInDays };
}

/** Parses one Templates note; null when it is not a task bundle. */
export function parseTaskBundle(path: string, content: string): TaskBundle | null {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter || enumText(frontmatter.clinical_template) !== TEMPLATE_MARKER) return null;
  const rawTasks = frontmatter.tasks;
  if (!Array.isArray(rawTasks)) return null;
  const warnings: string[] = [];
  const tasks = rawTasks
    .map((item, index) => bundleItem(item, index + 1, warnings))
    .filter((item): item is TaskBundleItem => item !== null);
  if (!tasks.length) return null;
  const fileName = path.split("/").pop()?.replace(/\.md$/i, "") ?? "Template";
  const pathwayText = enumText(frontmatter.pathway);
  const pathway = PATHWAYS.find((option) => option === pathwayText) ?? null;
  if (isPresent(frontmatter.pathway) && !pathway) {
    // Hiding the bundle instead would change what existing templates offer;
    // saying so lets the author fix the spelling.
    warnings.push("The pathway is not recognised, so this template is offered for every episode.");
  }
  return {
    name: normalizeText(frontmatter.template_name) || fileName,
    path,
    pathway,
    tasks,
    warnings
  };
}

/** All valid task bundles in the Templates folder, sorted by name. */
export async function listTaskBundles(vault: Vault): Promise<TaskBundle[]> {
  const files = markdownFilesInFolder(vault, clinicalFolder("templates"));
  const bundles: TaskBundle[] = [];
  for (const file of files) {
    const bundle = parseTaskBundle(file.path, await vault.cachedRead(file));
    if (bundle) bundles.push(bundle);
  }
  return bundles.sort((a, b) => a.name.localeCompare(b.name));
}
