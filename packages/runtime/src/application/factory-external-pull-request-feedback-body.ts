import type { FactoryExternalPullRequestReviewBundle, Sha256Digest } from "@agentlab/contracts";

export function renderExternalPullRequestFeedback(input: {
  readonly bundle: FactoryExternalPullRequestReviewBundle;
  readonly bundleDigest: Sha256Digest;
  readonly maximumBytes: number;
}): string {
  const marker = `<!-- agentlab-external-review:${input.bundleDigest} -->`;
  const lines = [
    marker,
    "## AgentLab automated review",
    "",
    "This is evidence-backed advisory feedback. It is not an approval, merge decision, or repair authorization.",
    "",
    `Aggregate decision: ${decisionLabel(input.bundle.decision)}`,
    ""
  ];
  for (const review of input.bundle.reviews) {
    lines.push(
      `### ${safeMarkdown(review.reviewerId)} — ${decisionLabel(review.verdict)}`,
      "",
      safeMarkdown(review.summary).slice(0, 2_000),
      ""
    );
    for (const finding of review.findings) {
      const location =
        finding.path === null
          ? "repository"
          : finding.line === null
            ? safeMarkdown(finding.path)
            : `${safeMarkdown(finding.path)}:${String(finding.line)}`;
      lines.push(
        `- [${finding.severity.toUpperCase()}] ${safeMarkdown(finding.title)} (${location})`,
        `  ${safeMarkdown(finding.detail).slice(0, 2_000)}`
      );
    }
    if (review.findings.length > 0) lines.push("");
  }
  lines.push(`Evidence: ${input.bundleDigest}`, "");
  const body = lines.join("\n");
  if (new TextEncoder().encode(body).byteLength > input.maximumBytes) {
    throw new Error("External PR feedback body exceeds its reviewed byte ceiling.");
  }
  return body;
}

function decisionLabel(decision: "approved" | "changes-requested" | "human-review-required") {
  if (decision === "approved") return "no blocking findings reported";
  if (decision === "changes-requested") return "changes suggested";
  return "human review required";
}

function safeMarkdown(value: string): string {
  let sanitized = value
    .replaceAll("\0", "")
    .replaceAll("\r", " ")
    .replaceAll("@", "@\u200b")
    .replaceAll("\\", "\\\\");
  for (const character of ["[", "]", "`", "*", "_", "{", "}", "<", ">", "#", "|"]) {
    sanitized = sanitized.replaceAll(character, `\\${character}`);
  }
  return sanitized;
}
