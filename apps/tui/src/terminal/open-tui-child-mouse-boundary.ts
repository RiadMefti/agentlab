import type { RawMouseEvent, RenderContext } from "@opentui/core";

/**
 * OpenTUI 0.5.8 decides renderer selection and pointer capture before a renderable receives an
 * event. A native terminal therefore needs a small dispatcher seam so child-owned mouse input
 * never becomes renderer-owned state. Keep this adapter isolated for removal with the dependency
 * workaround.
 */
export interface OpenTuiChildMouseBoundaryTarget {
  readonly isDestroyed: boolean;
  readonly num: number;
  completeChildMouseDispatch(): void;
  prepareChildMouseDispatch(event: RawMouseEvent): boolean;
}

interface OpenTuiMouseDispatcher {
  capturedRenderable?: { readonly num: number };
  readonly renderOffset: number;
  readonly _splitHeight: number;
  hitTest(x: number, y: number): number;
  processSingleMouseEvent(event: RawMouseEvent): boolean;
  setCapturedRenderable(renderable: { readonly num: number } | undefined): void;
}

interface MouseBoundaryState {
  readonly captureSuppressionStack: (number | undefined)[];
  readonly originalProcessMouseEvent: OpenTuiMouseDispatcher["processSingleMouseEvent"];
  readonly originalSetCapturedRenderable: OpenTuiMouseDispatcher["setCapturedRenderable"];
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
    if (installedState.targets.get(target.num) === target) {
      installedState.targets.delete(target.num);
    }
  };
}

export function registeredOpenTuiChildMouseBoundaryTargets(context: RenderContext): number {
  return installedBoundaries.get(context)?.targets.size ?? 0;
}

function installBoundary(renderer: OpenTuiMouseDispatcher): MouseBoundaryState {
  const originalProcessMouseEvent = renderer.processSingleMouseEvent.bind(renderer);
  const originalSetCapturedRenderable = renderer.setCapturedRenderable.bind(renderer);
  const state: MouseBoundaryState = {
    captureSuppressionStack: [],
    originalProcessMouseEvent,
    originalSetCapturedRenderable,
    targets: new Map()
  };

  renderer.setCapturedRenderable = function setCapturedRenderableOutsideChildBoundary(
    renderable: { readonly num: number } | undefined
  ): void {
    const suppressedTarget = state.captureSuppressionStack.at(-1);
    if (suppressedTarget === undefined || renderable?.num !== suppressedTarget) {
      originalSetCapturedRenderable(renderable);
    }
  };

  renderer.processSingleMouseEvent = function processMouseEventWithoutTerminalCapture(
    event: RawMouseEvent
  ): boolean {
    const normalizedEvent = normalizeForHitTesting(this, event);
    const target =
      normalizedEvent === null
        ? undefined
        : state.targets.get(this.hitTest(normalizedEvent.x, normalizedEvent.y));
    if (target?.isDestroyed === true) {
      state.targets.delete(target.num);
    }
    const dispatchTarget = target !== undefined && !target.isDestroyed ? target : undefined;
    let prepared = false;
    if (normalizedEvent !== null && dispatchTarget !== undefined) {
      prepared = dispatchTarget.prepareChildMouseDispatch(normalizedEvent);
    }
    const suppressedTarget = prepared ? dispatchTarget?.num : undefined;
    if (suppressedTarget !== undefined && this.capturedRenderable?.num === suppressedTarget) {
      originalSetCapturedRenderable(undefined);
    }
    state.captureSuppressionStack.push(suppressedTarget);
    try {
      return originalProcessMouseEvent(event);
    } finally {
      state.captureSuppressionStack.pop();
      dispatchTarget?.completeChildMouseDispatch();
    }
  };

  return state;
}

function normalizeForHitTesting(
  renderer: OpenTuiMouseDispatcher,
  event: RawMouseEvent
): RawMouseEvent | null {
  if (renderer._splitHeight <= 0) return event;
  if (event.y < renderer.renderOffset) return null;
  return { ...event, y: event.y - renderer.renderOffset };
}
