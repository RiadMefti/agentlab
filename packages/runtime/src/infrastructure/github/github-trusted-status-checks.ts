const trustedStatusCheckContexts: ReadonlySet<string> = new Set(["verify", "factory-sandbox"]);

export interface GitHubTrustedStatusCheck {
  readonly context: "verify" | "factory-sandbox";
  readonly appId: number;
}

export function githubTrustedStatusCheckBindings(
  checks: readonly GitHubTrustedStatusCheck[]
): ReadonlyMap<string, number> {
  const bindings = new Map<string, number>();
  for (const check of checks) {
    if (
      !trustedStatusCheckContexts.has(check.context) ||
      !Number.isSafeInteger(check.appId) ||
      check.appId < 1 ||
      bindings.has(check.context)
    ) {
      throw new Error("GitHub trusted status-check bindings are invalid.");
    }
    bindings.set(check.context, check.appId);
  }
  if (!bindings.has("verify") || !bindings.has("factory-sandbox") || bindings.size !== 2) {
    throw new Error("GitHub trusted status checks must bind verify and factory-sandbox.");
  }
  return bindings;
}
