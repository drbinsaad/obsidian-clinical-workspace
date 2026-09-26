import { TFile, TFolder, type App } from "obsidian";
import { ClinicalRepository } from "../data/repository";
import { clinicalRootFolder } from "../data/paths";
import { createId } from "../domain/schema";
import { MrnIdentityConflictError, PossibleDuplicatePatientError } from "../services/clinical-service";
import {
  captureInboxPath, captureTemplateFolderPath, captureTemplates,
  isCaptureDraftPath, parseCaptureDraft, setCaptureState,
  type CaptureDraft
} from "./drafts";

export interface CaptureItem {
  path: string;
  source: string;
  draft?: CaptureDraft;
  error?: string;
}

const MAX_CAPTURE_BYTES = 65536;
const INCOMPLETE = "Filing may be incomplete. Check records before marking this capture reviewed; do not retry on another device.";
const CHANGED = "This capture changed or is no longer available. Reopen capture review.";
const INVALID = "This capture could not be read. Check its template and size.";

/** Draft receipts coordinate this app instance; Sync is not a distributed lock. */
export class CaptureStore {
  constructor(private readonly app: App, private readonly repository: ClinicalRepository) {}

  private guard(root: string): void {
    if (clinicalRootFolder() !== root) throw new Error(CHANGED);
    if (this.repository.getWriteBlockReason()) throw new Error("Clinical editing is paused. Resolve the workspace recovery notice first.");
  }

  private file(path: string, root: string): TFile {
    if (!isCaptureDraftPath(path, root)) throw new Error(CHANGED);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.path !== path) throw new Error(CHANGED);
    if (file.stat?.size > MAX_CAPTURE_BYTES) throw new Error(INVALID);
    return file;
  }

  private guardSetup(root: string): void {
    this.guard(root);
    for (const path of [root, `${root}/Inbox`, `${root}/Templates`]) {
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) {
        throw new Error("The existing clinical workspace folders are required for capture setup.");
      }
    }
  }

  /** Explicit setup only. Existing customized templates are always retained. */
  async setup(): Promise<void> {
    const root = clinicalRootFolder();
    try { await this.repository.withLock("capture-setup", async () => {
      this.guardSetup(root);
      for (const path of [captureInboxPath(root), captureTemplateFolderPath(root)]) {
        await this.repository.withManagedRecordMutation([path], async () => {
          this.guardSetup(root);
          const existing = this.app.vault.getAbstractFileByPath(path);
          if (existing && !(existing instanceof TFolder)) throw new Error("A capture folder could not be prepared.");
          if (!existing) await this.app.vault.createFolder(path);
          this.guardSetup(root);
        });
      }
      for (const [path, content] of Object.entries(captureTemplates(root))) {
        await this.repository.withManagedRecordMutation([path], async () => {
          this.guardSetup(root);
          const existing = this.app.vault.getAbstractFileByPath(path);
          if (existing && !(existing instanceof TFile)) throw new Error("A capture template destination is not a note.");
          if (!existing) await this.app.vault.create(path, content);
          this.guardSetup(root);
        });
      }
    }); } catch { throw new Error("Capture setup could not finish. Check clinical editing and the capture folders, then run setup again."); }
  }

  async read(path: string): Promise<CaptureItem> {
    const root = clinicalRootFolder();
    // Reject out-of-scope paths before any content read.
    if (!isCaptureDraftPath(path, root)) throw new Error(CHANGED);
    try {
      const file = this.file(path, root);
      const source = await this.app.vault.read(file);
      if (clinicalRootFolder() !== root || file.path !== path) throw new Error(CHANGED);
      if (new TextEncoder().encode(source).length > MAX_CAPTURE_BYTES) return { path, source: "", error: INVALID };
      try { return { path, source, draft: parseCaptureDraft(source) }; }
      catch { return { path, source, error: INVALID }; }
    } catch { return { path, source: "", error: INVALID }; }
  }

  async list(): Promise<CaptureItem[]> {
    const root = clinicalRootFolder();
    const folder = this.app.vault.getAbstractFileByPath(captureInboxPath(root));
    if (!(folder instanceof TFolder)) return [];
    const files = folder.children.filter((file): file is TFile => file instanceof TFile && isCaptureDraftPath(file.path, root))
      .sort((a, b) => a.path.localeCompare(b.path)).slice(0, 200);
    const items: CaptureItem[] = [];
    for (const file of files) {
      if (clinicalRootFolder() !== root) break;
      items.push(await this.read(file.path));
    }
    return items;
  }

  async run<T>(item: CaptureItem, operation: () => Promise<T>, describe: (result: T) => string): Promise<T> {
    const root = clinicalRootFolder();
    // The maintenance helper reads its paths; validate before entering it.
    this.file(item.path, root);
    let claimed = false;
    let safeIdentityFailure: unknown;
    try {
      return await this.repository.withLock(`capture:${item.path}`, () =>
        this.repository.withManagedRecordMutation([item.path], async () => {
          this.guard(root);
          const file = this.file(item.path, root);
          const attempt = createId("CAP");
          const claim = await this.app.vault.process(file, (current) => {
            this.guard(root);
            this.file(item.path, root);
            if (file.path !== item.path || current !== item.source) throw new Error(CHANGED);
            if (parseCaptureDraft(current).state !== "draft") throw new Error("This capture has already been attempted. Review its saved receipt.");
            const next = setCaptureState(current, "processing", attempt);
            claimed = true;
            return next;
          });
          claimed = true;
          const fresh = await this.app.vault.read(file);
          this.guard(root);
          this.file(item.path, root);
          if (file.path !== item.path || fresh !== claim) throw new Error(CHANGED);
          let result: T;
          try { result = await operation(); }
          catch (error) {
            // These specific service exceptions are emitted before clinical writes.
            // All other errors retain the claim, including uncertain persistence.
            if (error instanceof PossibleDuplicatePatientError || error instanceof MrnIdentityConflictError) {
              await this.changeReceipt(item.path, root, attempt, "draft", undefined, { claim, original: item.source });
              safeIdentityFailure = error;
            }
            throw error;
          }
          await this.changeReceipt(item.path, root, attempt, "filed", describe(result));
          return result;
        })
      );
    } catch (error) {
      if (safeIdentityFailure !== undefined && error === safeIdentityFailure) throw error;
      if (claimed) throw new Error(INCOMPLETE);
      // Repository errors can contain paths: expose only a neutral pre-claim notice.
      throw new Error("Capture could not be filed. Reopen it and check that clinical editing is available.");
    }
  }

  private async changeReceipt(path: string, root: string, attempt: string, state: "draft" | "filed" | "reviewed", result?: string, rollback?: { claim: string; original: string }): Promise<void> {
    this.guard(root);
    const file = this.file(path, root);
    await this.app.vault.process(file, (current) => {
      this.guard(root);
      this.file(path, root);
      const draft = parseCaptureDraft(current);
      if (file.path !== path || draft.state !== "processing" || draft.attemptId !== attempt) throw new Error(CHANGED);
      if (rollback) {
        if (current !== rollback.claim) throw new Error(CHANGED);
        return rollback.original;
      }
      return setCaptureState(current, state, state === "draft" ? undefined : attempt, result);
    });
    this.guard(root);
    const saved = parseCaptureDraft(await this.app.vault.read(file));
    this.guard(root);
    this.file(path, root);
    if (file.path !== path || saved.state !== state || saved.attemptId !== (state === "draft" ? "" : attempt) || (result !== undefined && saved.result !== result)) throw new Error(CHANGED);
  }

  /** Caller must obtain explicit confirmation after reviewing clinical records. */
  async markReviewed(item: CaptureItem): Promise<void> {
    const root = clinicalRootFolder();
    this.file(item.path, root);
    const draft = parseCaptureDraft(item.source);
    if (draft.state !== "processing") throw new Error("Only an unfinished capture can be marked reviewed.");
    try { await this.repository.withLock(`capture:${item.path}`, () =>
      this.repository.withManagedRecordMutation([item.path], () =>
        this.changeReceipt(item.path, root, draft.attemptId, "reviewed")
      )
    ); } catch { throw new Error("The capture could not be marked reviewed. Reopen it and check clinical editing."); }
  }
}
