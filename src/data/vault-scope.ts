import { normalizePath, TFile, TFolder, type Vault } from "obsidian";

/**
 * Returns Markdown files beneath one explicit vault folder.
 *
 * Clinical Workspace must never enumerate unrelated vault content. Starting
 * from the configured root also makes the privacy boundary visible in code and
 * keeps future scans from accidentally expanding to the whole vault.
 */
export function markdownFilesInFolder(vault: Vault, folderPath: string): TFile[] {
  const root = vault.getAbstractFileByPath(normalizePath(folderPath));
  if (!(root instanceof TFolder)) return [];

  const files: TFile[] = [];
  const pending: TFolder[] = [root];
  while (pending.length > 0) {
    const folder = pending.pop();
    if (!folder) continue;
    for (const child of folder.children) {
      if (child instanceof TFolder) pending.push(child);
      else if (child instanceof TFile && child.extension.toLowerCase() === "md") files.push(child);
    }
  }
  return files;
}
