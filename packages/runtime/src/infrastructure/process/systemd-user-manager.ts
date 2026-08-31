import { isAbsolute } from "node:path";

import { z } from "zod";

export function factorySystemdScopeName(isolationIdInput: string): string {
  const isolationId = z.uuid().parse(isolationIdInput);
  return `agentlab-factory-${isolationId.replaceAll("-", "")}.scope`;
}

export function systemdUserManagerEnvironment(
  environment: NodeJS.ProcessEnv
): Readonly<Record<string, string>> {
  const runtimeDirectory = environment.XDG_RUNTIME_DIR;
  const busAddress = environment.DBUS_SESSION_BUS_ADDRESS;
  if (
    runtimeDirectory === undefined ||
    !isAbsolute(runtimeDirectory) ||
    !safeEnvironmentValue(runtimeDirectory)
  ) {
    throw new Error("Factory isolation requires a safe XDG_RUNTIME_DIR for the user manager.");
  }
  if (busAddress === undefined || !safeEnvironmentValue(busAddress)) {
    throw new Error("Factory isolation requires a safe DBUS_SESSION_BUS_ADDRESS.");
  }
  return Object.freeze({
    XDG_RUNTIME_DIR: runtimeDirectory,
    DBUS_SESSION_BUS_ADDRESS: busAddress
  });
}

function safeEnvironmentValue(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !/[\0\r\n]/u.test(value);
}
