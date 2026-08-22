// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { registerThemeRuntimeLifecycle } from "../../apps/web/src/theme/browser-theme-lifecycle.js";

describe("browser theme runtime lifecycle", () => {
  it("keeps the runtime alive when the page enters the back-forward cache", () => {
    const runtime = { dispose: vi.fn() };
    const unregister = registerThemeRuntimeLifecycle(window, runtime);

    window.dispatchEvent(pageHideEvent(true));

    expect(runtime.dispose).not.toHaveBeenCalled();
    unregister();
  });

  it("disposes exactly once for a non-persisted navigation after BFCache restoration", () => {
    const runtime = { dispose: vi.fn() };
    registerThemeRuntimeLifecycle(window, runtime);

    window.dispatchEvent(pageHideEvent(true));
    window.dispatchEvent(pageHideEvent(false));
    window.dispatchEvent(pageHideEvent(false));

    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});

function pageHideEvent(persisted: boolean): Event {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}
