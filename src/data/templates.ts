import type { Vault } from "obsidian";
import type { Pathway, Priority, TaskType } from "../domain/types";
import { PATHWAYS, PRIORITIES, TASK_TYPES } from "../domain/types";
import { normalizeText } from "../domain/schema";
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
}

const TEMPLATE_MARKER = "task-bundle";

function bundleItem(value: unknown): TaskBundleItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const task = normalizeText(raw.task);
  if (!task) return null;
  const taskType = TASK_TYPES.includes(raw.task_type as TaskType)
    ? (raw.task_type as TaskType)
    : "other";
  const priority = PRIORITIES.includes(raw.priority as Priority)
    ? (raw.priority as Priority)
    : null;
  const days = raw.due_in_days;
  const dueInDays =
    typeof days === "number" && Number.isInteger(days) && days >= 0 && days <= 730 ? days : null;
  return { task, taskType, priority, dueInDays };
}

/** Parses one Templates note; null when it is not a task bundle. */
export function parseTaskBundle(path: string, content: string): TaskBundle | null {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter || frontmatter.clinical_template !== TEMPLATE_MARKER) return null;
  const rawTasks = frontmatter.tasks;
  if (!Array.isArray(rawTasks)) return null;
  const tasks = rawTasks
    .map((item) => bundleItem(item))
    .filter((item): item is TaskBundleItem => item !== null);
  if (!tasks.length) return null;
  const fileName = path.split("/").pop()?.replace(/\.md$/i, "") ?? "Template";
  const pathway = PATHWAYS.includes(frontmatter.pathway as Pathway)
    ? (frontmatter.pathway as Pathway)
    : null;
  return {
    name: normalizeText(frontmatter.template_name) || fileName,
    path,
    pathway,
    tasks
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
