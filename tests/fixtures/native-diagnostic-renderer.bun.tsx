/** @jsxImportSource @opentui/react */

import { createRef } from "react";

import { testRender } from "@opentui/react/test-utils";

import type { EmbeddedTerminalRenderable } from "../../apps/tui/src/terminal/embedded-terminal.js";
import "../../apps/tui/src/terminal/embedded-terminal.js";

const terminal = createRef<EmbeddedTerminalRenderable>();
const setup = await testRender(<agent-terminal ref={terminal} style={{ height: 8, width: 40 }} />, {
  height: 8,
  width: 40
});

terminal.current?.write("\u001b[?7727l");
terminal.current?.write("👩🏽‍💻界é".repeat(32_768));
await setup.flush();
setup.renderer.destroy();
process.stdout.write("AGENTLAB_FRAME\n");
