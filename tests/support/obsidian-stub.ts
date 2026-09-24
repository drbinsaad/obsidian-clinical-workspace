/**
 * In-memory stand-in for the parts of the Obsidian runtime this plugin uses.
 *
 * The published `obsidian` npm package is type definitions only (`"main": ""`),
 * so nothing that imports runtime values from it can be executed under Node.
 * `obsidian-loader.mjs` redirects the module specifier here during `npm test`.
 *
 * YAML behaviour mirrors what Obsidian actually writes, verified against records
 * produced by the plugin in a real vault: numeric-looking strings are quoted,
 * dates are not, and everything reads back as a string. The YAML core schema
 * reproduces those semantics without applying timestamp coercion.
 */
import { parse, stringify } from "yaml";

export function parseYaml(text: string): unknown {
  return parse(text, { schema: "core" });
}

export function stringifyYaml(value: unknown): string {
  return stringify(value, { schema: "core", lineWidth: 0 });
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  extension: string;
  constructor(path: string) {
    super(path);
    this.extension = path.split(".").pop() ?? "";
  }
}

export class TFolder extends TAbstractFile {
  constructor(path: string, public children: TAbstractFile[] = []) {
    super(path);
  }
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export class Vault {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  /** Snapshot used by cachedRead; intentionally separate from the backing map. */
  private readonly readCache = new Map<string, string>();
  /** Artificial await between read and write, used to expose races in tests. */
  latency = 0;

  async tick(): Promise<void> {
    if (this.latency > 0) await new Promise((resolve) => setTimeout(resolve, this.latency));
    else await Promise.resolve();
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const key = normalizePath(path);
    if (this.files.has(key)) return new TFile(key);
    if (this.folders.has(key)) return this.folderTree(key);
    return null;
  }

  private folderTree(path: string): TFolder {
    const prefix = `${path}/`;
    const children: TAbstractFile[] = [];
    for (const folder of this.folders) {
      if (!folder.startsWith(prefix)) continue;
      const relative = folder.slice(prefix.length);
      if (relative && !relative.includes("/")) children.push(this.folderTree(folder));
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const relative = file.slice(prefix.length);
      if (relative && !relative.includes("/")) children.push(new TFile(file));
    }
    return new TFolder(path, children);
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.keys()].filter((path) => path.endsWith(".md")).map((path) => new TFile(path));
  }

  async createFolder(path: string): Promise<TFolder> {
    const key = normalizePath(path);
    this.folders.add(key);
    return new TFolder(key);
  }

  async create(path: string, content: string): Promise<TFile> {
    const key = normalizePath(path);
    await this.tick();
    if (this.files.has(key)) throw new Error(`File already exists: ${key}`);
    this.files.set(key, content);
    this.readCache.delete(key);
    return new TFile(key);
  }

  async read(file: TFile): Promise<string> {
    await this.tick();
    const key = normalizePath(file.path);
    const content = this.files.get(key);
    if (content === undefined) throw new Error(`File not found: ${file.path}`);
    this.readCache.set(key, content);
    return content;
  }

  async cachedRead(file: TFile): Promise<string> {
    await this.tick();
    const key = normalizePath(file.path);
    const cached = this.readCache.get(key);
    if (cached !== undefined) return cached;
    const content = this.files.get(key);
    if (content === undefined) throw new Error(`File not found: ${file.path}`);
    this.readCache.set(key, content);
    return content;
  }

  async modify(file: TFile, content: string): Promise<void> {
    await this.tick();
    const key = normalizePath(file.path);
    this.files.set(key, content);
    this.readCache.delete(key);
  }

  /**
   * Models Obsidian's atomic read-transform-write. The queueing delay happens
   * BEFORE the read, and read+transform+write run without an interleaving
   * point — content delivered during the delay is seen by the transform, so a
   * repair that re-checks inside the transform cannot destroy it.
   */
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    await this.tick();
    const key = normalizePath(file.path);
    const current = this.files.get(key);
    if (current === undefined) throw new Error(`File not found: ${file.path}`);
    const next = fn(current);
    this.files.set(key, next);
    this.readCache.delete(key);
    return next;
  }

  /** Models Obsidian invalidating cachedRead after a vault or file-manager write. */
  invalidateCachedRead(path: string): void {
    this.readCache.delete(normalizePath(path));
  }

  /** Test helper for an external edit after Obsidian has delivered its change event. */
  writeRaw(path: string, content: string): void {
    const key = normalizePath(path);
    this.files.set(key, content);
    this.invalidateCachedRead(key);
  }

  /** Test helper for an externally delivered deletion. */
  deleteRaw(path: string): void {
    const key = normalizePath(path);
    this.files.delete(key);
    this.invalidateCachedRead(key);
  }

  on(): { id: string } {
    return { id: "stub-event" };
  }

  /** Test helper: rename without going through Obsidian's link updater. */
  renameRaw(from: string, to: string): void {
    const content = this.files.get(normalizePath(from));
    if (content === undefined) throw new Error(`File not found: ${from}`);
    this.files.delete(normalizePath(from));
    this.files.set(normalizePath(to), content);
    this.invalidateCachedRead(from);
    this.invalidateCachedRead(to);
  }
}

export class FileManager {
  constructor(private readonly vault: Vault) {}

  /**
   * Models Obsidian's folder rename, including the part the migration depends
   * on: rewriting vault-absolute wikilinks that point into the folder.
   *
   * Real Obsidian's behaviour for links held in YAML frontmatter is not
   * documented, so this stub deliberately rewrites them. That makes the stub
   * OPTIMISTIC: a passing migration test proves the plugin is correct *if*
   * Obsidian rewrites frontmatter links, and `MigrationService.countDanglingLinks`
   * exists to catch the case where it does not.
   */
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    const from = normalizePath(file.path);
    const to = normalizePath(newPath);
    const isFolder = this.vault.folders.has(from);

    for (const path of [...this.vault.files.keys()]) {
      if (path === from || (isFolder && path.startsWith(`${from}/`))) {
        const moved = path === from ? to : `${to}${path.slice(from.length)}`;
        this.vault.files.set(moved, this.vault.files.get(path)!);
        this.vault.files.delete(path);
        this.vault.invalidateCachedRead(path);
        this.vault.invalidateCachedRead(moved);
      }
    }
    for (const folder of [...this.vault.folders]) {
      if (folder === from || folder.startsWith(`${from}/`)) {
        this.vault.folders.delete(folder);
        this.vault.folders.add(folder === from ? to : `${to}${folder.slice(from.length)}`);
      }
    }
    this.vault.folders.add(to);

    // Rewrite inbound wikilinks, body and frontmatter alike.
    for (const [path, content] of [...this.vault.files.entries()]) {
      if (!content.includes(`[[${from}/`)) continue;
      this.vault.files.set(path, content.split(`[[${from}/`).join(`[[${to}/`));
      this.vault.invalidateCachedRead(path);
    }
  }

  async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const key = normalizePath(file.path);
    const content = this.vault.files.get(key);
    if (content === undefined) throw new Error(`File not found: ${key}`);
    // Two awaits so the read-modify-write window is observable to concurrent callers.
    await this.vault.tick();
    const match = FRONTMATTER.exec(content);
    const parsed = match?.[1] ? parseYaml(match[1]) : {};
    const frontmatter = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    fn(frontmatter);
    const body = match ? content.slice(match[0].length) : content;
    await this.vault.tick();
    this.vault.files.set(key, `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${body}`);
    this.vault.invalidateCachedRead(key);
  }
}

export class App {
  readonly vault = new Vault();
  readonly fileManager = new FileManager(this.vault);
  /** Device-local values survive fresh plugin instances that reuse this App. */
  readonly localStorage = new Map<string, unknown>();

  loadLocalStorage(key: string): unknown {
    return structuredClone(this.localStorage.get(key) ?? null);
  }

  saveLocalStorage(key: string, data: unknown): void {
    this.localStorage.set(key, structuredClone(data));
  }
}

/* Declarations below exist only so modules that import them can be loaded. */
export class Notice {
  static readonly history: Notice[] = [];
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly noticeEl = {
    addClass: (...names: string[]) => {
      for (const name of names) this.classes.add(name);
    },
    setAttribute: (name: string, value: string) => {
      this.attributes.set(name, value);
    }
  };
  readonly messageEl = {
    closest: () => this.noticeEl
  };
  hidden = false;

  constructor(public message: string, public duration?: number) {
    Notice.history.push(this);
  }

  hide(): void {
    this.hidden = true;
  }
}
export class Plugin {}
export class ItemView {}
export class MarkdownView extends ItemView {
  file: TFile | null = null;
}
export class Modal {}

/** The element surface the Setting stand-in needs; tests pass a DOM-harness TestElement. */
interface StubSettingElement {
  value: string;
  createDiv(options?: { cls?: string }): StubSettingElement;
  createEl(tagName: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }): StubSettingElement;
  setText(text: string): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
}

/**
 * Mirrors the structure Obsidian's Setting renders (info with name and
 * description, then the control), so a form modal can be opened in a
 * DOM-harness test. Controls use upper-case tag names, as a browser reports.
 */
export class Setting {
  readonly settingEl: StubSettingElement;
  readonly infoEl: StubSettingElement;
  readonly nameEl: StubSettingElement;
  readonly descEl: StubSettingElement;
  readonly controlEl: StubSettingElement;

  constructor(containerEl: StubSettingElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }

  setName(name: string): this {
    this.nameEl.setText(name);
    return this;
  }

  setDesc(description: string): this {
    this.descEl.setText(description);
    return this;
  }

  addText(build: (component: unknown) => void): this {
    const inputEl = this.controlEl.createEl("INPUT", { attr: { type: "text" } });
    (inputEl as StubSettingElement & { type: string }).type = "text";
    const component = {
      inputEl,
      getValue: () => inputEl.value,
      setValue: (value: string) => {
        inputEl.value = value;
        return component;
      },
      setPlaceholder: (placeholder: string) => {
        inputEl.setAttribute("placeholder", placeholder);
        return component;
      },
      onChange: (listener: (value: string) => void) => {
        inputEl.addEventListener("input", () => listener(inputEl.value));
        return component;
      }
    };
    build(component);
    return this;
  }

  addDropdown(build: (component: unknown) => void): this {
    const selectEl = this.controlEl.createEl("SELECT");
    const component = {
      selectEl,
      addOptions: (options: Record<string, string>) => {
        for (const [value, text] of Object.entries(options)) {
          selectEl.createEl("OPTION", { text, attr: { value } });
        }
        return component;
      },
      getValue: () => selectEl.value,
      setValue: (value: string) => {
        selectEl.value = value;
        return component;
      },
      onChange: (listener: (value: string) => void) => {
        selectEl.addEventListener("change", () => listener(selectEl.value));
        return component;
      }
    };
    build(component);
    return this;
  }

  addToggle(build: (component: unknown) => void): this {
    // Obsidian 1.14 renders a focusable label around a checkbox kept out of
    // the tab order; the label toggles on click and on Enter or Space.
    const toggleEl = this.controlEl.createEl("LABEL", { cls: "checkbox-container", attr: { tabindex: "0" } });
    toggleEl.createEl("INPUT", { attr: { type: "checkbox", tabindex: "-1" } });
    let enabled = false;
    const listeners: Array<(value: boolean) => void> = [];
    const component = {
      toggleEl,
      getValue: () => enabled,
      setValue: (value: boolean) => {
        enabled = value;
        return component;
      },
      onChange: (listener: (value: boolean) => void) => {
        listeners.push(listener);
        return component;
      }
    };
    const toggle = (): void => {
      enabled = !enabled;
      for (const listener of listeners) listener(enabled);
    };
    toggleEl.addEventListener("click", toggle);
    (toggleEl as unknown as { addEventListener(type: string, listener: (event: KeyboardEvent) => void): void })
      .addEventListener("keydown", (event) => {
        if (event.key === " " || event.key === "Enter") toggle();
      });
    build(component);
    return this;
  }
}
export class PluginSettingTab {
  hide(): void {}
}
export class WorkspaceLeaf {}
export function setIcon(): void {}
