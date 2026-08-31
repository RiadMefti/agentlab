import { chmod, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { z } from "zod";

const workspaceCoordinatesSchema = z
  .object({
    taskId: z.uuid(),
    attempt: z.number().int().min(1).max(20),
    workspaceId: z.uuid()
  })
  .strict();

export function resolveFactoryWorkspaceRoot(path: string): string {
  if (path.length === 0 || path.includes("\0")) {
    throw new Error("Factory worktree root is invalid.");
  }
  const absolute = resolve(path);
  if (absolute === parse(absolute).root) {
    throw new Error("Factory worktree root must be a dedicated non-root path.");
  }
  return absolute;
}

export async function prepareFactoryWorkspaceRoot(path: string): Promise<string> {
  const absolute = resolveFactoryWorkspaceRoot(path);
  await mkdir(absolute, { mode: 0o700, recursive: true });
  const canonical = await realpath(absolute);
  if (canonical !== absolute) {
    throw new Error("Factory worktree root must not be a symbolic-link alias.");
  }
  await chmod(canonical, 0o700);
  return canonical;
}

export function factoryWorkspaceTaskDirectory(root: string, taskIdInput: string): string {
  const taskId = z.uuid().parse(taskIdInput);
  return join(resolveFactoryWorkspaceRoot(root), taskId);
}

export async function prepareFactoryWorkspaceTaskDirectory(
  root: string,
  taskId: string
): Promise<string> {
  const directory = factoryWorkspaceTaskDirectory(root, taskId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const canonical = await realpath(directory);
  if (canonical !== directory) {
    throw new Error("Factory task worktree directory must not be a symbolic-link alias.");
  }
  await chmod(canonical, 0o700);
  return canonical;
}

export function factoryWorkspaceTarget(
  root: string,
  coordinatesInput: {
    readonly taskId: string;
    readonly attempt: number;
    readonly workspaceId: string;
  }
): string {
  const coordinates = workspaceCoordinatesSchema.parse(coordinatesInput);
  return join(
    factoryWorkspaceTaskDirectory(root, coordinates.taskId),
    `${String(coordinates.attempt)}-${coordinates.workspaceId}`
  );
}

export function factoryPathsOverlap(left: string, right: string): boolean {
  return factoryPathWithin(left, right) || factoryPathWithin(right, left);
}

export function factoryPathWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
