import { App, normalizePath, TFile, TFolder } from "obsidian";
import { baseFiles, homeNote } from "../data/bases";
import { isUntouchedBase, isUntouchedHome } from "../data/scaffold";
import { allClinicalFolders, clinicalFolder, clinicalRootFolder } from "../data/paths";
import { markdownFilesInFolder } from "../data/vault-scope";
import { normalizeFolderPath, validateRootFolder } from "../domain/settings";

export interface MigrationPlan {
  from: string;
  to: string;
  files: number;
  blocked: string | null;
}

export interface MigrationResult extends MigrationPlan {
  /** Wikilinks still pointing at the old root after the move; must be empty. */
  danglingLinks: number;
  /** True when the post-move link audit itself could not be completed. */
  linkVerificationFailed: boolean;
}

/** Persisted across the rename so an interrupted migration can be reconciled. */
export interface MigrationMarker {
  from: string;
  to: string;
}

/**
 * Chooses the only safe root after an interrupted move.
 *
 * The destination wins only when it actually contains records. Merely existing
 * is not evidence: first-run scaffolding can create an otherwise empty root.
 * Returning `null` deliberately prevents callers from manufacturing a new
 * empty workspace while the real location is still unknown.
 */
export function resolveMigrationRoot(
  marker: MigrationMarker,
  holdsRecords: (root: string) => boolean
): string | null {
  if (holdsRecords(marker.to)) return marker.to;
  if (holdsRecords(marker.from)) return marker.from;
  return null;
}

/**
 * Moves the managed root folder.
 *
 * Records reference each other with vault-absolute wikilinks, so the folder
 * cannot simply be renamed on disk. `fileManager.renameFile` is used instead,
 * which is the only API that rewrites inbound links across the vault. Base
 * files are regenerated afterwards because Obsidian does not rewrite folder
 * strings embedded in a base's YAML.
 */
export class MigrationService {
  constructor(private readonly app: App) {}

  plan(target: string): MigrationPlan {
    const from = clinicalRootFolder();
    const to = normalizeFolderPath(target);
    const invalid = validateRootFolder(to);
    if (invalid) return { from, to, files: 0, blocked: invalid };
    if (from === to) return { from, to, files: 0, blocked: "That is already the current folder." };

    const source = this.app.vault.getAbstractFileByPath(normalizePath(from));
    if (!source) return { from, to, files: 0, blocked: `The folder "${from}" does not exist.` };
    if (!(source instanceof TFolder)) return { from, to, files: 0, blocked: `"${from}" is not a folder.` };
    if (this.app.vault.getAbstractFileByPath(normalizePath(to))) {
      return { from, to, files: 0, blocked: `"${to}" already exists. Choose a folder that does not exist yet.` };
    }
    // Moving a folder into its own subtree is not a rename Obsidian can do.
    if (`${to}/`.startsWith(`${from}/`)) {
      return { from, to, files: 0, blocked: "The new folder cannot sit inside the current one." };
    }

    const files = markdownFilesInFolder(this.app.vault, from).length;
    return { from, to, files, blocked: null };
  }

  /**
   * Performs the move.
   *
   * `beforeRename` is awaited immediately before the irreversible step, so the
   * caller can persist where the records are about to be. Everything after the
   * rename is cosmetic regeneration and is deliberately non-fatal: a failure
   * there must not leave the caller believing the move did not happen, because
   * by then it has.
   */
  async run(target: string, beforeRename?: (plan: MigrationPlan) => Promise<void>): Promise<MigrationResult> {
    const plan = this.plan(target);
    if (plan.blocked) throw new Error(plan.blocked);

    const source = this.app.vault.getAbstractFileByPath(normalizePath(plan.from));
    if (!(source instanceof TFolder)) throw new Error(`The folder "${plan.from}" does not exist.`);

    if (beforeRename) await beforeRename(plan);

    // Rewrites every wikilink pointing into the folder.
    await this.app.fileManager.renameFile(source, normalizePath(plan.to));

    // Past this point the records have moved. Nothing below may throw, or the
    // caller would report failure for a move that actually succeeded.
    try {
      for (const folder of allClinicalFolders(plan.to)) await this.ensureFolder(folder);

      // Regenerate only files still identical to what the plugin would have
      // written. A base or home note the user has customised is their work, and
      // a folder move is no reason to discard it.
      for (const [path, content] of Object.entries(baseFiles(plan.to))) {
        const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (!existing) {
          await this.app.vault.create(normalizePath(path), content);
        } else if (existing instanceof TFile) {
          const current = await this.app.vault.read(existing);
          if (isUntouchedBase(path, current)) await this.app.vault.modify(existing, content);
        }
      }
      const homePath = normalizePath(`${clinicalFolder("home", plan.to)}/Clinical Workspace.md`);
      const home = this.app.vault.getAbstractFileByPath(homePath);
      if (!home) {
        await this.app.vault.create(homePath, homeNote(plan.to));
      } else if (home instanceof TFile) {
        const current = await this.app.vault.read(home);
        if (isUntouchedHome(current)) await this.app.vault.modify(home, homeNote(plan.to));
      }
    } catch (error) {
      console.warn(
        "Clinical Workspace: records moved, but database views could not be regenerated. They will be rebuilt on next open.",
        error instanceof Error ? error.message : error
      );
    }

    let danglingLinks = 0;
    let linkVerificationFailed = false;
    try {
      danglingLinks = await this.countDanglingLinks(plan.from, plan.to);
    } catch (error) {
      linkVerificationFailed = true;
      console.warn(
        "Clinical Workspace: records moved, but their rewritten links could not be verified. Run the integrity check.",
        error instanceof Error ? error.message : error
      );
    }
    return { ...plan, danglingLinks, linkVerificationFailed };
  }

  /**
   * Counts wikilinks still pointing at the old root.
   *
   * This is the check that decides whether the migration is trustworthy: the
   * whole design rests on `renameFile` rewriting links held in YAML
   * frontmatter, which is not something the API documents. If that assumption
   * is ever wrong, this returns a non-zero count instead of leaving a silently
   * broken caseload.
   */
  async countDanglingLinks(from: string, to: string): Promise<number> {
    const files = markdownFilesInFolder(this.app.vault, to);
    let dangling = 0;
    for (const file of files) {
      const content = await this.app.vault.read(file);
      if (content.includes(`[[${from}/`)) dangling += 1;
    }
    return dangling;
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(normalized)) return;
    let current = "";
    for (const segment of normalized.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }
}
