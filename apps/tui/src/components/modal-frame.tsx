import type { ReactNode } from "react";

import { palette } from "../theme.js";

export function ModalFrame({
  title,
  width = 72,
  height = 24,
  children,
  footer
}: {
  readonly title: string;
  readonly width?: number | `${number}%`;
  readonly height?: number | `${number}%`;
  readonly children: ReactNode;
  readonly footer: string;
}) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      alignItems="center"
      justifyContent="center"
      backgroundColor="#05080ccc"
    >
      <box
        flexDirection="column"
        width={width}
        maxWidth="92%"
        height={height}
        maxHeight="90%"
        border
        borderStyle="rounded"
        borderColor={palette.accent}
        backgroundColor={palette.panel}
        title={` ${title} `}
        titleColor={palette.text}
        padding={1}
      >
        <box flexGrow={1} flexDirection="column">
          {children}
        </box>
        <text fg={palette.muted}>{footer}</text>
      </box>
    </box>
  );
}
