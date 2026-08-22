interface DisposableThemeRuntime {
  dispose(): void;
}

export function registerThemeRuntimeLifecycle(
  window: Window,
  runtime: DisposableThemeRuntime
): () => void {
  let disposed = false;
  const onPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted || disposed) return;
    disposed = true;
    window.removeEventListener("pagehide", onPageHide);
    runtime.dispose();
  };
  window.addEventListener("pagehide", onPageHide);
  return () => {
    window.removeEventListener("pagehide", onPageHide);
  };
}
