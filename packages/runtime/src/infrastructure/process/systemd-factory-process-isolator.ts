import { isAbsolute } from "node:path";

import { factoryProcessIsolationSchema, factoryResourceLimitsSchema } from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryProcessIsolator } from "../../domain/factory-process-isolation.js";
import { factorySystemdScopeName, systemdUserManagerEnvironment } from "./systemd-user-manager.js";

const isolationInputSchema = z
  .object({
    command: z
      .object({
        executable: z.string().min(1).max(4_096).refine(safeArgument),
        args: z.array(z.string().max(4_096).refine(safeArgument)).max(512),
        environment: z.record(z.string(), z.string()).optional()
      })
      .strict(),
    isolationId: z.uuid(),
    limits: factoryResourceLimitsSchema
  })
  .strict();

export interface SystemdFactoryProcessIsolatorOptions {
  readonly executable: string;
  readonly environmentExecutable: string;
  readonly version: string;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
}

/**
 * Places one command and every descendant in a transient user scope with cgroup v2 ceilings.
 * The provider or repository command never receives a shell-interpolated string.
 */
export class SystemdFactoryProcessIsolator implements FactoryProcessIsolator {
  readonly #executable: string;
  readonly #environmentExecutable: string;
  readonly #version: string;
  readonly #controllerEnvironment: Readonly<Record<string, string>>;

  public constructor(options: SystemdFactoryProcessIsolatorOptions) {
    if (!isAbsolute(options.executable) || !safeArgument(options.executable)) {
      throw new Error("systemd-run executable must be an absolute safe path.");
    }
    if (
      !isAbsolute(options.environmentExecutable) ||
      !safeArgument(options.environmentExecutable)
    ) {
      throw new Error("env executable must be an absolute safe path.");
    }
    const version = options.version.trim();
    if (version.length === 0 || version.length > 180 || /[\0\r\n]/u.test(version)) {
      throw new Error("systemd-run version identity is invalid.");
    }
    this.#executable = options.executable;
    this.#environmentExecutable = options.environmentExecutable;
    this.#version = version;
    this.#controllerEnvironment = systemdUserManagerEnvironment(
      options.hostEnvironment ?? process.env
    );
  }

  public isolate(inputValue: unknown) {
    return Promise.resolve().then(() => {
      const input = isolationInputSchema.parse(inputValue);
      if (!isAbsolute(input.command.executable)) {
        throw new Error("Factory resource isolation requires an absolute executable path.");
      }
      const scopeName = factorySystemdScopeName(input.isolationId);
      const isolation = factoryProcessIsolationSchema.parse({
        isolationId: input.isolationId,
        mechanism: { id: "linux/systemd-user-scope", version: this.#version },
        scopeName,
        limits: input.limits
      });
      return {
        command: {
          executable: this.#executable,
          args: [
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            `--unit=${scopeName}`,
            "--property=Delegate=no",
            `--property=TasksMax=${String(input.limits.maxProcesses)}`,
            `--property=MemoryMax=${String(input.limits.maxMemoryBytes)}`,
            "--property=MemorySwapMax=0",
            `--property=CPUQuota=${String(input.limits.cpuQuotaPercent)}%`,
            "--same-dir",
            "--",
            this.#environmentExecutable,
            "--unset=XDG_RUNTIME_DIR",
            "--unset=DBUS_SESSION_BUS_ADDRESS",
            "--",
            input.command.executable,
            ...input.command.args
          ],
          ...(input.command.environment === undefined
            ? {}
            : { environment: input.command.environment })
        },
        controllerEnvironment: this.#controllerEnvironment,
        isolation
      };
    });
  }
}

function safeArgument(value: string): boolean {
  return !value.includes("\0");
}
