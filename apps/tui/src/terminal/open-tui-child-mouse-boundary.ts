import type { RawMouseEvent, RenderContext } from "@opentui/core";

/** A prepared native child event. Its absence means OpenTUI owns the physical event. */
export interface OpenTuiChildMouseDispatch {
  readonly output?: Uint8Array;
}

/**
 * OpenTUI 0.5.8 expands one raw mouse event into synthetic over/out/drag-end/drop events and uses
 * its own global capture. Embedded terminals need a separate physical-gesture owner so a child
 * press can retain drag/release without borrowing or changing that global capture.
 */
export interface OpenTuiChildMouseBoundaryTarget {
  readonly isDestroyed: boolean;
  readonly num: number;
  beginChildMouseDispatch(dispatch: OpenTuiChildMouseDispatch): void;
  beginOpenTuiMouseDispatch(): void;
  completeChildMouseDispatch(): void;
  completeOpenTuiMouseDispatch(): void;
  endOpenTuiMouseGesture(): void;
  prepareChildMouseDispatch(
    event: RawMouseEvent,
    retainOwnership: boolean
  ): OpenTuiChildMouseDispatch | null;
}

interface OpenTuiMouseDispatcher {
  readonly capturedRenderable?: { readonly num: number };
  readonly renderOffset: number;
  readonly _splitHeight: number;
  dispatchMouseEvent(target: OpenTuiChildMouseBoundaryTarget, event: RawMouseEvent): unknown;
  hitTest(x: number, y: number): number;
  processSingleMouseEvent: (event: RawMouseEvent) => boolean;
}

type PhysicalGesture =
  | {
      readonly button: number;
      readonly kind: "child";
      readonly target: OpenTuiChildMouseBoundaryTarget;
    }
  | { readonly button: number; readonly kind: "opentui" };

interface MouseBoundaryState {
  gesture: PhysicalGesture | undefined;
  readonly originalProcessMouseEvent: OpenTuiMouseDispatcher["processSingleMouseEvent"];
  readonly renderer: OpenTuiMouseDispatcher;
  readonly targets: Map<number, OpenTuiChildMouseBoundaryTarget>;
}

const installedBoundaries = new WeakMap<object, MouseBoundaryState>();

export function registerOpenTuiChildMouseBoundary(
  context: RenderContext,
  target: OpenTuiChildMouseBoundaryTarget
): () => void {
  const renderer = context as unknown as OpenTuiMouseDispatcher;
  const rendererKey = renderer as unknown as object;
  let state = installedBoundaries.get(rendererKey);
  if (state === undefined) {
    state = installBoundary(renderer);
    installedBoundaries.set(rendererKey, state);
  }
  state.targets.set(target.num, target);
  const installedState = state;
  return () => {
    if (installedState.targets.get(target.num) !== target) return;
    installedState.targets.delete(target.num);
    if (installedState.gesture?.kind === "child" && installedState.gesture.target === target) {
      installedState.gesture = undefined;
    }
    if (installedState.targets.size === 0) {
      installedState.renderer.processSingleMouseEvent = installedState.originalProcessMouseEvent;
      installedBoundaries.delete(installedState.renderer);
    }
  };
}

export function cancelOpenTuiChildMouseOwnership(
  context: RenderContext,
  target: OpenTuiChildMouseBoundaryTarget
): void {
  const state = installedBoundaries.get(context);
  if (state?.gesture?.kind === "child" && state.gesture.target === target) {
    state.gesture = undefined;
  }
}

export function registeredOpenTuiChildMouseBoundaryTargets(context: RenderContext): number {
  return installedBoundaries.get(context)?.targets.size ?? 0;
}

function installBoundary(renderer: OpenTuiMouseDispatcher): MouseBoundaryState {
  const state: MouseBoundaryState = {
    gesture: undefined,
    originalProcessMouseEvent: renderer.processSingleMouseEvent,
    renderer,
    targets: new Map()
  };

  renderer.processSingleMouseEvent = function processMouseEventAtChildBoundary(
    this: OpenTuiMouseDispatcher,
    event: RawMouseEvent
  ): boolean {
    const normalizedEvent = normalizeForRenderer(this, event);
    const insideRenderRegion = this._splitHeight <= 0 || event.y >= this.renderOffset;

    removeDestroyedTargets(state);
    if (state.gesture?.kind === "child" && state.gesture.target.isDestroyed) {
      state.gesture = undefined;
    }

    if (normalizedEvent.type === "down") {
      // A press is a new physical gesture even if an earlier release was lost.
      if (state.gesture?.kind === "opentui") endOpenTuiGesture(state);
      state.gesture = undefined;
      if (!insideRenderRegion) return state.originalProcessMouseEvent.call(this, event);
      if (this.capturedRenderable !== undefined) {
        state.gesture = { button: normalizedEvent.button, kind: "opentui" };
        return callOpenTui(state, this, event, true);
      }
      const target = targetAt(state, this, normalizedEvent);
      const dispatch = prepare(target, normalizedEvent, false);
      if (target !== undefined && dispatch !== null) {
        state.gesture = { button: normalizedEvent.button, kind: "child", target };
        return dispatchToChild(this, target, normalizedEvent, dispatch);
      }
      state.gesture = { button: normalizedEvent.button, kind: "opentui" };
      return callOpenTui(state, this, event, false);
    }

    const gesture = state.gesture;
    if (gesture?.kind === "child") {
      const endsGesture =
        normalizedEvent.type === "up" && normalizedEvent.button === gesture.button;
      const dispatch = prepare(gesture.target, normalizedEvent, true);
      if (endsGesture) state.gesture = undefined;
      if (dispatch === null) {
        state.gesture = undefined;
        return true;
      }
      return dispatchToChild(this, gesture.target, normalizedEvent, dispatch);
    }

    if (gesture?.kind === "opentui") {
      const endsGesture =
        normalizedEvent.type === "up" && normalizedEvent.button === gesture.button;
      if (endsGesture) state.gesture = undefined;
      try {
        return callOpenTui(state, this, event, true);
      } finally {
        if (endsGesture) endOpenTuiGesture(state);
      }
    }

    if (!insideRenderRegion) return state.originalProcessMouseEvent.call(this, event);

    // OpenTUI capture can predate registration or begin in reentrant user code. It always wins.
    if (this.capturedRenderable !== undefined) return callOpenTui(state, this, event, true);

    // A release or drag without a recorded press belongs to OpenTUI (or to a gesture whose owner
    // was deliberately cancelled on blur/disable/destroy). It must never seed child state.
    if (normalizedEvent.type === "up" || normalizedEvent.type === "drag") {
      return callOpenTui(state, this, event, true);
    }

    const target = targetAt(state, this, normalizedEvent);
    const dispatch = prepare(target, normalizedEvent, false);
    if (target !== undefined && dispatch !== null) {
      if (normalizedEvent.type === "move") {
        // Preserve OpenTUI's physical pointer transition bookkeeping (including UI out/child over)
        // while suppressing all child input generated by its raw and synthetic dispatches. The
        // prepared raw hover is then delivered exactly once below.
        callOpenTui(state, this, event, true);
        if (target.isDestroyed) return true;
      }
      return dispatchToChild(this, target, normalizedEvent, dispatch);
    }
    return callOpenTui(state, this, event, false);
  };

  return state;
}

function prepare(
  target: OpenTuiChildMouseBoundaryTarget | undefined,
  event: RawMouseEvent,
  retainOwnership: boolean
): OpenTuiChildMouseDispatch | null {
  if (target === undefined || target.isDestroyed) return null;
  try {
    return target.prepareChildMouseDispatch(event, retainOwnership);
  } catch (error: unknown) {
    // Match OpenTUI's handler boundary: native mouse failures remain diagnostic, never fatal input.
    console.error("Error preparing child mouse input:", error);
    return null;
  }
}

function dispatchToChild(
  renderer: OpenTuiMouseDispatcher,
  target: OpenTuiChildMouseBoundaryTarget,
  event: RawMouseEvent,
  dispatch: OpenTuiChildMouseDispatch
): boolean {
  target.beginChildMouseDispatch(dispatch);
  try {
    renderer.dispatchMouseEvent(target, event);
  } finally {
    target.completeChildMouseDispatch();
  }
  return true;
}

function callOpenTui(
  state: MouseBoundaryState,
  renderer: OpenTuiMouseDispatcher,
  event: RawMouseEvent,
  suppressChildInput: boolean
): boolean {
  if (!suppressChildInput) return state.originalProcessMouseEvent.call(renderer, event);
  const targets = [...state.targets.values()].filter((target) => !target.isDestroyed);
  for (const target of targets) target.beginOpenTuiMouseDispatch();
  try {
    return state.originalProcessMouseEvent.call(renderer, event);
  } finally {
    for (let index = targets.length - 1; index >= 0; index -= 1) {
      targets[index]?.completeOpenTuiMouseDispatch();
    }
  }
}

function targetAt(
  state: MouseBoundaryState,
  renderer: OpenTuiMouseDispatcher,
  event: RawMouseEvent
): OpenTuiChildMouseBoundaryTarget | undefined {
  const target = state.targets.get(renderer.hitTest(event.x, event.y));
  return target?.isDestroyed === false ? target : undefined;
}

function removeDestroyedTargets(state: MouseBoundaryState): void {
  for (const [number, target] of state.targets) {
    if (target.isDestroyed) state.targets.delete(number);
  }
}

function endOpenTuiGesture(state: MouseBoundaryState): void {
  for (const target of state.targets.values()) {
    if (!target.isDestroyed) target.endOpenTuiMouseGesture();
  }
}

function normalizeForRenderer(
  renderer: OpenTuiMouseDispatcher,
  event: RawMouseEvent
): RawMouseEvent {
  if (renderer._splitHeight <= 0) return event;
  return { ...event, y: event.y - renderer.renderOffset };
}
