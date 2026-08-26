import { useEffect, useRef } from "react";

import type { Conversation } from "@orchestrator/contracts";
import type { ScrollBoxRenderable } from "@opentui/core";

import { palette } from "../theme.js";

export function ProjectList({
  projects,
  selectedId,
  active,
  onSelect,
  onCreate
}: {
  readonly projects: readonly Conversation[];
  readonly selectedId: string | null;
  readonly active: boolean;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
}) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    if (selectedId !== null) scrollRef.current?.scrollChildIntoView(projectRowId(selectedId));
  }, [projects, selectedId]);

  return (
    <box
      flexDirection="column"
      width="24%"
      minWidth={26}
      maxWidth={38}
      border={["right"]}
      borderColor={active ? palette.borderActive : palette.border}
      backgroundColor={palette.panel}
    >
      <box
        height={2}
        flexDirection="row"
        paddingX={1}
        alignItems="center"
        justifyContent="space-between"
        border={["bottom"]}
        borderColor={palette.border}
        backgroundColor={active ? palette.panelRaised : palette.panel}
      >
        <text fg={active ? palette.accent : palette.text} attributes={1}>
          Projects · {projects.length}
        </text>
        <text fg={palette.accent} onMouseDown={onCreate}>
          + Add
        </text>
      </box>
      <scrollbox ref={scrollRef} flexGrow={1} focused={active}>
        {projects.length === 0 ? (
          <box flexDirection="column" paddingX={1} paddingTop={1}>
            <text fg={palette.text}>No projects yet.</text>
            <text fg={palette.muted}>Add any folder to begin.</text>
          </box>
        ) : (
          projects.map((project) => {
            const selected = project.id === selectedId;
            return (
              <box
                key={project.id}
                id={projectRowId(project.id)}
                flexDirection="column"
                paddingX={1}
                minHeight={2}
                backgroundColor={selected ? palette.selection : palette.panel}
                onMouseDown={() => {
                  onSelect(project.id);
                }}
              >
                <text
                  fg={selected ? palette.text : palette.muted}
                  attributes={selected ? 1 : 0}
                  wrapMode="none"
                  truncate
                >
                  <span fg={selected ? palette.accent : palette.muted}>
                    {selected ? "› " : "  "}
                  </span>
                  {project.title}
                </text>
                <text
                  fg={project.workspacePath === null ? palette.warning : palette.muted}
                  wrapMode="none"
                  truncate
                >
                  {"  "}
                  {project.workspacePath ?? "folder not linked"}
                </text>
              </box>
            );
          })
        )}
      </scrollbox>
    </box>
  );
}

function projectRowId(projectId: string): string {
  return `project-row-${projectId}`;
}
