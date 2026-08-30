import type { ProviderId } from "@agentlab/contracts";

const commonKeys = [
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy"
] as const;

const providerKeys: Readonly<Record<ProviderId, readonly string[]>> = {
  codex: ["CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"],
  opencode: []
};

/** Copies only provider-runtime variables; repository, cloud, and package credentials are dropped. */
export function factoryAgentEnvironment(
  provider: ProviderId,
  host: NodeJS.ProcessEnv,
  overlay: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const allowed = new Set<string>([...commonKeys, ...providerKeys[provider]]);
  const environment: NodeJS.ProcessEnv = {
    CI: "true",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TERM: "dumb"
  };
  for (const key of allowed) {
    const value = host[key];
    if (value !== undefined) environment[key] = safeValue(key, value);
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (!allowed.has(key)) {
      throw new Error(`Factory provider environment variable ${key} is not allowlisted.`);
    }
    environment[key] = safeValue(key, value);
  }
  return environment;
}

function safeValue(key: string, value: string): string {
  if (value.length > 16_384 || /[\0\r\n]/u.test(value)) {
    throw new Error(`Factory provider environment variable ${key} is invalid.`);
  }
  return value;
}
