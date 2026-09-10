export interface TestElementOptions {
  text?: string;
  cls?: string;
  attr?: Record<string, string>;
}

/**
 * Minimal Obsidian DOM surface for rendering view and modal structure in Node.
 * It intentionally implements only the element helpers used by the UI under
 * test, so production markup can be exercised without a browser-only DOM.
 */
export class TestElement {
  readonly children: TestElement[] = [];
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  readonly scrollIntoViewCalls: Array<boolean | ScrollIntoViewOptions | undefined> = [];
  parent: TestElement | null = null;
  scrollLeft = 0;
  scrollTop = 0;
  disabled = false;
  focused = false;
  value = "";
  text = "";
  textWriteCount = 0;

  constructor(readonly tagName = "div", options: TestElementOptions = {}) {
    this.apply(options);
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  get textContent(): string {
    return [this.text, ...this.children.map((child) => child.textContent)].join("");
  }

  set textContent(value: string) {
    this.setText(value);
  }

  get dataset(): Record<string, string> {
    return Object.fromEntries(
      [...this.attributes]
        .filter(([name]) => name.startsWith("data-"))
        .map(([name, value]) => [
          name
            .slice(5)
            .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
          value
        ])
    );
  }

  addClass(...names: string[]): void {
    for (const name of names.flatMap((value) => value.split(/\s+/)).filter(Boolean)) {
      this.classes.add(name);
    }
  }

  removeClass(...names: string[]): void {
    for (const name of names) this.classes.delete(name);
  }

  toggleClass(name: string, force?: boolean): void {
    const enabled = force ?? !this.classes.has(name);
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
  }

  empty(): void {
    this.children.length = 0;
    this.text = "";
  }

  createDiv(options: TestElementOptions | string = {}): TestElement {
    return this.append("div", typeof options === "string" ? { cls: options } : options);
  }

  createSpan(options: TestElementOptions | string = {}): TestElement {
    return this.append("span", typeof options === "string" ? { cls: options } : options);
  }

  createEl(tagName: string, options: TestElementOptions = {}): TestElement {
    return this.append(tagName, options);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  setText(value: string): void {
    this.children.length = 0;
    this.text = value;
    this.textWriteCount += 1;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    const event = { currentTarget: this, target: this, type } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  scrollIntoView(options?: boolean | ScrollIntoViewOptions): void {
    this.scrollIntoViewCalls.push(options);
    // Real browsers are allowed to adjust every scrollable ancestor even when
    // the caller primarily wants inline movement. Simulate that vertical side
    // effect so view tests prove the outer reading position is restored.
    let ancestor = this.parent;
    while (ancestor) {
      if (ancestor.classes.has("clinical-workspace-scroll")) {
        ancestor.scrollTop = 0;
        break;
      }
      ancestor = ancestor.parent;
    }
  }

  focus(): void {
    this.focused = true;
  }

  /** Mirrors Obsidian's cross-realm Element.instanceOf helper. */
  instanceOf(constructor: unknown): boolean {
    return typeof constructor === "function" && this instanceof constructor;
  }

  querySelector(selector: string): TestElement | null {
    return this.findAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): TestElement[] {
    return this.findAll(selector);
  }

  find(selector: string): TestElement | null {
    if (matches(this, selector)) return this;
    for (const child of this.children) {
      const found = child.find(selector);
      if (found) return found;
    }
    return null;
  }

  findAll(selector: string): TestElement[] {
    const matchesInChildren: TestElement[] = [];
    for (const child of this.children) {
      if (matches(child, selector)) matchesInChildren.push(child);
      matchesInChildren.push(...child.findAll(selector));
    }
    return matchesInChildren;
  }

  private append(tagName: string, options: TestElementOptions): TestElement {
    const child = new TestElement(tagName, options);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  private apply(options: TestElementOptions): void {
    this.text = options.text ?? "";
    if (options.cls) this.addClass(options.cls);
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      this.setAttribute(name, value);
    }
  }
}

/** Installs only the DOM constructor referenced by Obsidian's instanceOf calls. */
export function installTestDomGlobals(): void {
  if (typeof globalThis.HTMLElement !== "undefined") return;
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: TestElement,
    writable: true
  });
}

function matches(element: TestElement, selector: string): boolean {
  const trimmed = selector.trim();
  const attribute = /^\[([\w-]+)(?:=["']([^"']*)["'])?\]$/.exec(trimmed);
  if (attribute) {
    const value = element.getAttribute(attribute[1] ?? "");
    return attribute[2] === undefined ? value !== null : value === attribute[2];
  }
  if (trimmed.startsWith("#")) return element.getAttribute("id") === trimmed.slice(1);
  if (trimmed.startsWith(".")) {
    return trimmed
      .slice(1)
      .split(".")
      .every((name) => element.classes.has(name));
  }
  return element.tagName.toLocaleLowerCase() === trimmed.toLocaleLowerCase();
}

export interface CssRule {
  selectors: string[];
  declarations: Map<string, string>;
  atRules: string[];
}

/** Small brace-aware parser sufficient for declaration-level layout contracts. */
export function parseCssRules(source: string): CssRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];

  const parse = (input: string, atRules: string[]): void => {
    let cursor = 0;
    while (cursor < input.length) {
      const open = input.indexOf("{", cursor);
      if (open < 0) return;
      const header = input.slice(cursor, open).trim();
      let depth = 1;
      let close = open + 1;
      while (close < input.length && depth > 0) {
        if (input[close] === "{") depth += 1;
        else if (input[close] === "}") depth -= 1;
        close += 1;
      }
      if (depth !== 0) throw new Error(`Unbalanced CSS block: ${header}`);
      const body = input.slice(open + 1, close - 1);
      cursor = close;
      if (!header) continue;
      if (header.startsWith("@")) {
        parse(body, [...atRules, header]);
        continue;
      }
      rules.push({
        selectors: splitTopLevel(header, ",").map((selector) => selector.trim()),
        declarations: parseDeclarations(body),
        atRules
      });
    }
  };

  parse(css, []);
  return rules;
}

export interface CssViewport {
  width: number;
  height: number;
}

export function computedDeclarations(
  rules: readonly CssRule[],
  applicableSelectors: readonly string[],
  viewport?: CssViewport
): Map<string, string> {
  const applicable = new Set(applicableSelectors);
  const result = new Map<string, string>();
  for (const rule of rules) {
    if (viewport && !rule.atRules.every((atRule) => atRuleApplies(atRule, viewport))) continue;
    if (!rule.selectors.some((selector) => applicable.has(selector))) continue;
    for (const [property, value] of rule.declarations) result.set(property, value);
  }
  return result;
}

function atRuleApplies(atRule: string, viewport: CssViewport): boolean {
  if (!atRule.startsWith("@media")) return true;
  const query = atRule.slice("@media".length).trim();
  return splitTopLevel(query, ",").some((alternative) =>
    alternative
      .split(/\s+and\s+/i)
      .map((condition) => condition.trim())
      .every((condition) => mediaConditionApplies(condition, viewport))
  );
}

function mediaConditionApplies(condition: string, viewport: CssViewport): boolean {
  const match = /^\(\s*(min|max)-(width|height)\s*:\s*([0-9]+(?:\.[0-9]+)?)px\s*\)$/.exec(condition);
  if (!match) return true;
  const boundary = match[1];
  const axis = match[2];
  const threshold = Number(match[3]);
  const actual = axis === "width" ? viewport.width : viewport.height;
  return boundary === "min" ? actual >= threshold : actual <= threshold;
}

export function gridTrackCount(template: string): number {
  const tracks = splitTopLevelWhitespace(template.trim());
  return tracks.reduce((count, track) => {
    const repeat = /^repeat\(\s*(\d+)\s*,([\s\S]+)\)$/.exec(track);
    if (!repeat) return count + (track === "none" || !track ? 0 : 1);
    return count + Number(repeat[1]) * gridTrackCount(repeat[2] ?? "");
  }, 0);
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of splitTopLevel(body, ";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (property && value) declarations.set(property, value);
  }
  return declarations;
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === delimiter && depth === 0) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function splitTopLevelWhitespace(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(character) && depth === 0) {
      if (start >= 0) parts.push(input.slice(start, index));
      start = -1;
    } else if (start < 0) {
      start = index;
    }
  }
  if (start >= 0) parts.push(input.slice(start));
  return parts;
}
