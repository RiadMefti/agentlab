import { EmbeddedTerminalRenderable } from "@opentui/core";
import { extend } from "@opentui/react";

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "agent-terminal": typeof EmbeddedTerminalRenderable;
  }
}

extend({
  "agent-terminal": EmbeddedTerminalRenderable
});

export { EmbeddedTerminalRenderable };
