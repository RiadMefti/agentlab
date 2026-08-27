import {
  EmbeddedTerminalRenderable as OpenTuiEmbeddedTerminalRenderable,
  type EmbeddedTerminalOptions,
  type KeyEvent,
  type MouseEvent,
  type RawMouseEvent,
  type RenderContext
} from "@opentui/core";
import { extend } from "@opentui/react";

import { TerminalDefaultAppearance } from "./terminal-appearance.js";
import {
  cancelOpenTuiChildMouseOwnership,
  registerOpenTuiChildMouseBoundary,
  type OpenTuiChildMouseDispatch
} from "./open-tui-child-mouse-boundary.js";

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
interface OpenTuiTerminalInternals {
  readonly handle: unknown;
  readonly lib: {
    embeddedTerminalEncodeMouse(
      handle: unknown,
      mouse: {
        readonly action: "motion" | "press" | "release";
        readonly anyButtonPressed: boolean;
        readonly button?: "five" | "four" | "left" | "middle" | "right" | "seven" | "six";
        readonly mods: number;
        readonly x: number;
        readonly y: number;
      }
    ): Uint8Array;
    embeddedTerminalScroll(handle: unknown, rows: number): void;
  };
}

interface OpenTuiRendererSelectionContext {
  clearSelection(): void;
  getSelection(): {
    readonly anchor: { readonly x: number; readonly y: number };
    readonly focus: { readonly x: number; readonly y: number };
  } | null;
}

export interface AgentTerminalOptions extends Omit<
  EmbeddedTerminalOptions,
  "renderBefore" | "renderAfter"
> {
  readonly childMouseInput?: boolean;
  readonly onActivate?: () => void;
  readonly sessionConnected?: boolean;
}

export function terminalChildMouseInputEnabled(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return environment.AGENTLAB_DISABLE_MOUSE !== "1";
}

/** Compatibility shell around OpenTUI 0.5.8's native VT implementation. */
export class EmbeddedTerminalRenderable extends OpenTuiEmbeddedTerminalRenderable {
  readonly #appearance = new TerminalDefaultAppearance();
  #childMouseInput: boolean;
  readonly #disposeChildMouseBoundary: () => void;
  #onActivate: (() => void) | undefined;
  #forceLocalDrag = false;
  readonly #preparedChildMouseDispatches: OpenTuiChildMouseDispatch[] = [];
  #openTuiMouseDispatchDepth = 0;
  #sessionConnected: boolean;

  public constructor(ctx: RenderContext, options: AgentTerminalOptions) {
    const runtimeOptions = options as AgentTerminalOptions &
      Pick<EmbeddedTerminalOptions, "renderAfter" | "renderBefore">;
    const {
      childMouseInput,
      onActivate,
      renderAfter,
      renderBefore,
      sessionConnected,
      ...openTuiOptions
    } = runtimeOptions;
    // Render hooks invalidate OpenTUI's native VT on every frame. Keep the type-level omission
    // enforceable when options arrive through untyped JavaScript or a React prop spread.
    void renderAfter;
    void renderBefore;
    super(ctx, openTuiOptions);
    Object.defineProperties(this, {
      renderAfter: ignoredRenderHookProperty,
      renderBefore: ignoredRenderHookProperty
    });
    this.#childMouseInput = childMouseInput ?? true;
    this.#onActivate = onActivate;
    this.#sessionConnected = sessionConnected ?? true;
    this.#disposeChildMouseBoundary = registerOpenTuiChildMouseBoundary(ctx, this);
  }

  public override write(data: string | Uint8Array): void {
    this.#appearance.markChanged();
    super.write(data);
  }

  public override invalidate(): void {
    this.#appearance.markChanged();
    super.invalidate();
  }

  public override onSelectionChanged(
    selection: Parameters<OpenTuiEmbeddedTerminalRenderable["onSelectionChanged"]>[0]
  ): boolean {
    this.#appearance.markChanged();
    return super.onSelectionChanged(selection);
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

  public override processMouseEvent(event: MouseEvent): void {
    if (this.#openTuiMouseDispatchDepth > 0) {
      if (event.type === "up" || event.type === "drag-end") {
        this.#forceLocalDrag = false;
        this.clearCollapsedSelection();
      }
      return;
    }
    if (event.type === "down" && event.button === 0) {
      this.#forceLocalDrag = event.modifiers.shift;
      this.#onActivate?.();
    }
    const forceLocal = event.modifiers.shift || this.#forceLocalDrag;
    const preparedDispatch = this.#preparedChildMouseDispatches.at(-1);
    if (preparedDispatch !== undefined) {
      if (event.type === "down" && event.button === 0) this.focus();
      if (event.type === "scroll") this.#appearance.markChanged();
      if (preparedDispatch.output === undefined) {
        event.preventDefault();
        event.stopPropagation();
      } else {
        event.preventDefault();
        event.stopPropagation();
        this.onData?.(preparedDispatch.output, "input");
      }
      if (event.type === "up" && event.button === 0) this.#forceLocalDrag = false;
      return;
    }
    if (forceLocal || !this.#childMouseInput) {
      if (event.type === "scroll") {
        this.scrollLocally(event);
        return;
      }
      // Selection begins in the renderer before dispatch. Skipping OpenTUI's handler is the exact
      // Shift bypass: no child bytes and no manual re-entry into parent/capture bookkeeping.
      if (event.type === "down" && event.button === 0) this.focus();
      if (event.type === "up" || event.type === "drag-end") {
        this.#forceLocalDrag = false;
        this.clearCollapsedSelection();
      }
      return;
    }

    if (event.type === "scroll") this.#appearance.markChanged();
    // A zero-byte native result is intentionally allowed through this normal OpenTUI path so
    // local selection and scrolling remain available when the child has not enabled tracking.
    super.processMouseEvent(event);
    if (event.type === "up" && event.button === 0) {
      this.#forceLocalDrag = false;
      this.clearCollapsedSelection();
    }
  }

  public get childMouseInput(): boolean {
    return this.#childMouseInput;
  }

  public set childMouseInput(value: boolean) {
    if (value && !this.#childMouseInput) this.clearLocalSelection();
    if (!value) cancelOpenTuiChildMouseOwnership(this.ctx, this);
    this.#childMouseInput = value;
  }

  public override shouldStartSelection(x: number, y: number): boolean {
    return this.#preparedChildMouseDispatches.length === 0 && super.shouldStartSelection(x, y);
  }

  public prepareChildMouseDispatch(
    event: RawMouseEvent,
    retainOwnership: boolean
  ): OpenTuiChildMouseDispatch | null {
    if (!this.#childMouseInput || event.modifiers.shift || this.#forceLocalDrag) {
      return null;
    }
    const output = this.encodeMouse(event);
    if (output.byteLength === 0 && !retainOwnership) return null;
    this.clearLocalSelection();
    return output.byteLength === 0 ? {} : { output };
  }

  public beginChildMouseDispatch(dispatch: OpenTuiChildMouseDispatch): void {
    this.#preparedChildMouseDispatches.push(dispatch);
  }

  public completeChildMouseDispatch(): void {
    this.#preparedChildMouseDispatches.pop();
  }

  public beginOpenTuiMouseDispatch(): void {
    this.#openTuiMouseDispatchDepth += 1;
  }

  public completeOpenTuiMouseDispatch(): void {
    this.#openTuiMouseDispatchDepth = Math.max(0, this.#openTuiMouseDispatchDepth - 1);
  }

  public endOpenTuiMouseGesture(): void {
    this.#forceLocalDrag = false;
    this.clearCollapsedSelection();
  }

  public get sessionConnected(): boolean {
    return this.#sessionConnected;
  }

  public set sessionConnected(value: boolean) {
    if (this.#sessionConnected === value) return;
    this.#sessionConnected = value;
    if (!value) this.blur();
  }

  public get onActivate(): (() => void) | undefined {
    return this.#onActivate;
  }

  public set onActivate(value: (() => void) | undefined) {
    this.#onActivate = value;
  }

  public override focus(): void {
    if (this.#sessionConnected) super.focus();
  }

  public override blur(): void {
    cancelOpenTuiChildMouseOwnership(this.ctx, this);
    this.#forceLocalDrag = false;
    this.clearLocalSelection();
    super.blur();
  }

  public clearLocalSelection(): void {
    if (this.hasSelection()) this.selectionContext().clearSelection();
  }

  public get appearanceApplicationCount(): number {
    return this.#appearance.applicationCount;
  }

  protected override onResize(width: number, height: number): void {
    this.#appearance.markChanged();
    super.onResize(width, height);
  }

  protected override renderSelf(
    buffer: Parameters<OpenTuiEmbeddedTerminalRenderable["render"]>[0]
  ): void {
    super.renderSelf(buffer);
    this.#appearance.apply(buffer);
  }

  protected override destroySelf(): void {
    this.#disposeChildMouseBoundary();
    super.destroySelf();
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

  private encodeMouse(event: RawMouseEvent): Uint8Array {
    const terminal = this as unknown as OpenTuiTerminalInternals;
    const button = event.type === "move" ? undefined : mouseButton(event);
    return terminal.lib.embeddedTerminalEncodeMouse(terminal.handle, {
      action:
        event.type === "down" || event.type === "scroll"
          ? "press"
          : event.type === "up"
            ? "release"
            : "motion",
      anyButtonPressed: event.type === "down" || event.type === "drag",
      ...(button === undefined ? {} : { button }),
      mods: mouseModifiers(event.modifiers),
      x: event.x - this.screenX,
      y: event.y - this.screenY
    });
  }

  private scrollLocally(event: MouseEvent): void {
    const direction = event.scroll?.direction;
    if (direction !== "up" && direction !== "down") return;
    const terminal = this as unknown as OpenTuiTerminalInternals;
    this.#appearance.markChanged();
    terminal.lib.embeddedTerminalScroll(terminal.handle, direction === "up" ? -3 : 3);
    this.requestRender();
    event.preventDefault();
    event.stopPropagation();
  }

  private selectionContext(): OpenTuiRendererSelectionContext {
    return this.ctx;
  }
}

function mouseButton(
  event: RawMouseEvent
): "five" | "four" | "left" | "middle" | "right" | "seven" | "six" | undefined {
  if (event.type === "scroll") {
    if (event.scroll?.direction === "up") return "four";
    if (event.scroll?.direction === "down") return "five";
    if (event.scroll?.direction === "left") return "six";
    if (event.scroll?.direction === "right") return "seven";
    return undefined;
  }
  return { 0: "left", 1: "middle", 2: "right", 4: "four", 5: "five" }[event.button] as
    "five" | "four" | "left" | "middle" | "right" | undefined;
}

function mouseModifiers(modifiers: RawMouseEvent["modifiers"]): number {
  return (modifiers.shift ? 1 : 0) | (modifiers.ctrl ? 2 : 0) | (modifiers.alt ? 4 : 0);
}

const ignoredRenderHookProperty: PropertyDescriptor = {
  configurable: false,
  enumerable: false,
  get: () => undefined,
  set: () => undefined
};

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "agent-terminal": typeof EmbeddedTerminalRenderable;
  }
}

extend({
  "agent-terminal": EmbeddedTerminalRenderable
});
