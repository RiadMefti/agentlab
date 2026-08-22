import { describe, expect, it, vi } from "vitest";

import { ensureDesktopWorkspace } from "../../apps/desktop/src/workspace-selection.js";

describe("desktop workspace selection", () => {
  it("asks packaged launches for an explicit workspace", async () => {
    const select = vi.fn().mockResolvedValue("/projects/orchestrator");

    await expect(ensureDesktopWorkspace({}, true, select)).resolves.toMatchObject({
      AO_WORKSPACE: "/projects/orchestrator"
    });
    expect(select).toHaveBeenCalledOnce();
  });

  it("keeps an explicit workspace without prompting", async () => {
    const select = vi.fn();
    const environment = { AO_WORKSPACE: "/projects/existing" };

    await expect(ensureDesktopWorkspace(environment, true, select)).resolves.toBe(environment);
    expect(select).not.toHaveBeenCalled();
  });

  it("cancels startup when packaged selection is canceled", async () => {
    await expect(
      ensureDesktopWorkspace({}, true, vi.fn().mockResolvedValue(null))
    ).resolves.toBeNull();
  });

  it("uses the current directory default during development", async () => {
    const environment = {};
    const select = vi.fn();

    await expect(ensureDesktopWorkspace(environment, false, select)).resolves.toBe(environment);
    expect(select).not.toHaveBeenCalled();
  });
});
