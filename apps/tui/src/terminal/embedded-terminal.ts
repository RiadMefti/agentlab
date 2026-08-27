import {
  EmbeddedTerminalRenderable as OpenTuiEmbeddedTerminalRenderable,
  type EmbeddedTerminalOptions,
  type KeyEvent,
  type MouseEvent,
  type RenderContext
} from "@opentui/core";
import { extend } from "@opentui/react";

const semanticPhysicalKeys: Readonly<Record<string, string>> = {
  backspace: "Backspace",
  delete: "Delete",
  down: "ArrowDown",
  end: "End",
  enter: "Enter",
  escape: "Escape",
  home: "Home",
  insert: "Insert",
  left: "ArrowLeft",
  pagedown: "PageDown",
  pageup: "PageUp",
  return: "Enter",
  right: "ArrowRight",
  space: "Space",
  tab: "Tab",
  up: "ArrowUp",
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [`f${String(index + 1)}`, `F${String(index + 1)}`])
  )
};

const escapeCharacter = String.fromCharCode(27);
const mouseControlPattern = new RegExp(
  `${escapeCharacter}c|${escapeCharacter}\\[!p|${escapeCharacter}\\[\\?([\\d;]*)([hl])`,
  "gu"
);
const incompleteControlPattern = new RegExp(`${escapeCharacter}(?:\\[[?!\\d;]*)?$`, "u");
const MAX_INCOMPLETE_CONTROL_BYTES = 64;

interface OpenTuiTerminalInternals {
  readonly handle: unknown;
  readonly lib: {
    embeddedTerminalScroll(handle: unknown, rows: number): void;
  };
}

interface OpenTuiRendererSelectionContext {
  readonly _lastPointerModifiers?: { readonly shift?: boolean };
  clearSelection(): void;
  getSelection(): {
    readonly anchor: { readonly x: number; readonly y: number };
    readonly focus: { readonly x: number; readonly y: number };
  } | null;
}

export interface AgentTerminalOptions extends EmbeddedTerminalOptions {
  readonly sessionConnected?: boolean;
}

/** Tracks only DEC mouse modes; the native VT remains authoritative for encoding. */
export class TerminalMouseProtocolState {
  readonly #trackingModes = new Set<number>();
  #tail = "";

  public observe(data: string | Uint8Array): boolean {
    const wasEnabled = this.enabled;
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const input = this.#tail + text;
    for (const match of input.matchAll(mouseControlPattern)) {
      if (match[0] === "\x1bc" || match[0] === "\x1b[!p") {
        this.#trackingModes.clear();
        continue;
      }
      const enabled = match[2] === "h";
      for (const value of (match[1] ?? "").split(";")) {
        const mode = Number(value);
        if (mode !== 1000 && mode !== 1002 && mode !== 1003) continue;
        if (enabled) this.#trackingModes.add(mode);
        else this.#trackingModes.delete(mode);
      }
    }
    const tail = incompleteControlPattern.exec(input)?.[0] ?? "";
    this.#tail = tail.length <= MAX_INCOMPLETE_CONTROL_BYTES ? tail : "";
    return !wasEnabled && this.enabled;
  }

  public get enabled(): boolean {
    return this.#trackingModes.size > 0;
  }
}

/** Compatibility shell around OpenTUI 0.5.8's native VT implementation. */
export class EmbeddedTerminalRenderable extends OpenTuiEmbeddedTerminalRenderable {
  readonly #mouseProtocol = new TerminalMouseProtocolState();
  #forceLocalDrag = false;
  #sessionConnected: boolean;

  public constructor(ctx: RenderContext, options: AgentTerminalOptions) {
    super(ctx, options);
    this.#sessionConnected = options.sessionConnected ?? true;
  }

  public override write(data: string | Uint8Array): void {
    if (this.#mouseProtocol.observe(data)) this.clearLocalSelection();
    super.write(data);
  }

  public override encodeKey(key: KeyEvent): Uint8Array {
    const legacyLinefeed = key.name.toLowerCase() === "linefeed";
    const physical = legacyLinefeed ? "KeyJ" : semanticPhysicalKeys[key.name.toLowerCase()];
    const legacyAlt =
      key.source === "raw" && key.meta && !key.option && key.sequence.startsWith(escapeCharacter);
    const duplicateAlt = key.meta && key.option;
    if (
      (physical === undefined || key.code === physical) &&
      !legacyAlt &&
      !duplicateAlt &&
      !legacyLinefeed
    ) {
      return super.encodeKey(key);
    }
    const prototype: object | null = Reflect.getPrototypeOf(key);
    const normalized = Object.assign(Object.create(prototype) as KeyEvent, key, {
      code: physical ?? key.code,
      ctrl: legacyLinefeed ? true : key.ctrl,
      name: legacyLinefeed ? "j" : key.name,
      // Raw ESC-prefixed Alt arrives as `meta`, while Kitty also sets `option`. The native
      // encoder treats `meta` as Super, so retain only the terminal Option/Alt bit.
      meta: legacyAlt || duplicateAlt ? false : key.meta,
      option: legacyAlt ? true : key.option
    });
    return super.encodeKey(normalized);
  }

  public override shouldStartSelection(x: number, y: number): boolean {
    if (!super.shouldStartSelection(x, y)) return false;
    return !this.#mouseProtocol.enabled || this.pointerHasShift();
  }

  public override processMouseEvent(event: MouseEvent): void {
    if (event.type === "down" && event.button === 0) {
      this.#forceLocalDrag = event.modifiers.shift;
    }
    const forceLocal = event.modifiers.shift || this.#forceLocalDrag;
    if (this.#mouseProtocol.enabled && forceLocal) {
      if (event.type === "scroll") {
        this.scrollLocally(event);
        return;
      }
      // Continue renderer-owned selection and bubble activation without entering
      // OpenTUI's independent child mouse forwarding path.
      this.parent?.processMouseEvent(event);
      if (event.type === "down" && event.button === 0) this.focus();
      if (event.type === "up" || event.type === "drag-end") {
        this.#forceLocalDrag = false;
        this.clearCollapsedSelection();
      }
      return;
    }

    super.processMouseEvent(event);
    if (event.type === "up" && event.button === 0) {
      this.#forceLocalDrag = false;
      this.clearCollapsedSelection();
    }
  }

  public get sessionConnected(): boolean {
    return this.#sessionConnected;
  }

  public set sessionConnected(value: boolean) {
    if (this.#sessionConnected === value) return;
    this.#sessionConnected = value;
    if (!value) this.blur();
  }

  public override focus(): void {
    if (this.#sessionConnected) super.focus();
  }

  public override blur(): void {
    this.#forceLocalDrag = false;
    this.clearLocalSelection();
    super.blur();
  }

  public clearLocalSelection(): void {
    if (this.hasSelection()) this.selectionContext().clearSelection();
  }

  private pointerHasShift(): boolean {
    return this.selectionContext()._lastPointerModifiers?.shift === true;
  }

  private clearCollapsedSelection(): void {
    const selection = this.selectionContext().getSelection();
    if (
      selection !== null &&
      selection.anchor.x === selection.focus.x &&
      selection.anchor.y === selection.focus.y
    ) {
      this.selectionContext().clearSelection();
    }
  }

  private scrollLocally(event: MouseEvent): void {
    const direction = event.scroll?.direction;
    if (direction !== "up" && direction !== "down") return;
    const terminal = this as unknown as OpenTuiTerminalInternals;
    terminal.lib.embeddedTerminalScroll(terminal.handle, direction === "up" ? -3 : 3);
    this.requestRender();
    event.preventDefault();
    event.stopPropagation();
  }

  private selectionContext(): OpenTuiRendererSelectionContext {
    return this.ctx;
  }
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "agent-terminal": typeof EmbeddedTerminalRenderable;
  }
}

extend({
  "agent-terminal": EmbeddedTerminalRenderable
});
