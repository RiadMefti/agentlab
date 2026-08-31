import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RuntimeSmokeSandbox {
  readonly environment: Readonly<Record<string, string>>;
  readonly rootPath: string;
  dispose(): Promise<void>;
}

const SMOKE_ENVIRONMENT_PASSTHROUGH = [
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "TZ"
] as const;

/** Creates a no-credential runtime environment whose writable paths are all disposable. */
export async function createRuntimeSmokeSandbox(
  prefix: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env
): Promise<RuntimeSmokeSandbox> {
  // macOS exposes its temporary directory through /var, which is a symlink to /private/var.
  // Canonicalize this test-owned root instead of weakening production symlink guards.
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const homePath = join(rootPath, "home");
  const configPath = join(rootPath, "config");
  const dataPath = join(rootPath, "data");
  const statePath = join(rootPath, "state");
  const cachePath = join(rootPath, "cache");
  const runtimePath = join(rootPath, "runtime");
  const temporaryPath = join(rootPath, "tmp");
  const tmuxPath = join(rootPath, "tmux");

  try {
    await Promise.all(
      [
        homePath,
        configPath,
        dataPath,
        statePath,
        cachePath,
        runtimePath,
        temporaryPath,
        tmuxPath
      ].map((path) => mkdir(path, { mode: 0o700 }))
    );
  } catch (error: unknown) {
    await rm(rootPath, { force: true, recursive: true });
    throw error;
  }

  const environment: Record<string, string> = {};
  for (const name of SMOKE_ENVIRONMENT_PASSTHROUGH) {
    const value = inheritedEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.HOME = homePath;
  environment.TERM = "xterm-256color";
  environment.TMPDIR = temporaryPath;
  environment.TMUX_TMPDIR = tmuxPath;
  environment.XDG_CACHE_HOME = cachePath;
  environment.XDG_CONFIG_HOME = configPath;
  environment.XDG_DATA_HOME = dataPath;
  environment.XDG_RUNTIME_DIR = runtimePath;
  environment.XDG_STATE_HOME = statePath;
  environment.AGENTLAB_CACHE_PATH = join(cachePath, "agentlab");
  environment.AGENTLAB_DATABASE_PATH = join(dataPath, "agentlab", "agentlab.sqlite");

  let disposed = false;
  return {
    environment,
    rootPath,
    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await rm(rootPath, { force: true, recursive: true });
    }
  };
}
