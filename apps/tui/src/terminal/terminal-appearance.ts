import type { OptimizedBuffer } from "@opentui/core";

import { palette } from "../theme.js";

const foreground = parseHexColor(palette.text);
const background = parseHexColor(palette.terminalBackground);

/** Replaces OpenTUI's resolved black/white defaults while leaving colored ANSI cells intact. */
export function paintTerminalDefaults(buffer: OptimizedBuffer): void {
  const colors = buffer.buffers;
  paintMatchingCells(colors.fg, [255, 255, 255], foreground);
  paintMatchingCells(colors.bg, [0, 0, 0], background);
}

function paintMatchingCells(
  cells: Uint16Array,
  source: readonly [red: number, green: number, blue: number],
  color: readonly [red: number, green: number, blue: number]
): void {
  for (let offset = 0; offset < cells.length; offset += 4) {
    if (
      ((cells[offset] ?? 0) & 0xff) !== source[0] ||
      ((cells[offset + 1] ?? 0) & 0xff) !== source[1] ||
      ((cells[offset + 2] ?? 0) & 0xff) !== source[2]
    ) {
      continue;
    }
    cells[offset] = ((cells[offset] ?? 0) & 0xff00) | color[0];
    cells[offset + 1] = ((cells[offset + 1] ?? 0) & 0xff00) | color[1];
    cells[offset + 2] = ((cells[offset + 2] ?? 0) & 0xff00) | color[2];
  }
}

function parseHexColor(value: `#${string}`): readonly [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
  if (match === null) throw new Error(`Terminal palette color is invalid: ${value}`);
  return [
    Number.parseInt(match[1] ?? "", 16),
    Number.parseInt(match[2] ?? "", 16),
    Number.parseInt(match[3] ?? "", 16)
  ];
}
