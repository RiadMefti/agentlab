import { MODEL_ID_MAX_LENGTH } from "@agentlab/contracts";
import { z } from "zod";

import { discoveredProviderCapabilitySchema } from "../../domain/provider-capability-discovery.js";
import type {
  DiscoveredProviderCapability,
  ProviderCapabilityDiscovery,
  ProviderDiscoveryContext
} from "../../domain/provider-capability-discovery.js";
import type { CommandRunner } from "../process/command-runner.js";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_MODELS = 1_000;
const MAX_JSON_DEPTH = 32;
const DISCOVERY_TIMEOUT_MS = 5_000;
const MODEL_HEADER = /^[^\s/]+\/[A-Za-z0-9][^\s]*$/u;

const rawModelSchema = z
  .object({
    id: z.string(),
    providerID: z.string(),
    name: z.string(),
    variants: z.record(z.string(), z.unknown())
  })
  .loose();

interface ParsedRecord {
  readonly header: string;
  readonly value: unknown;
}

/** Discovers the active OpenCode model catalog from its CLI output. */
export class OpenCodeCapabilityDiscovery implements ProviderCapabilityDiscovery {
  public readonly id = "opencode" as const;

  public constructor(
    private readonly runner: CommandRunner,
    private readonly timeoutMs = DISCOVERY_TIMEOUT_MS
  ) {}

  public async discover(context: ProviderDiscoveryContext): Promise<DiscoveredProviderCapability> {
    const { stdout } = await this.runner.run(context.executable, ["models", "--verbose"], {
      cwd: context.workspace,
      timeoutMs: this.timeoutMs,
      maxBufferBytes: MAX_OUTPUT_BYTES,
      cleanupProcessTree: true
    });
    return parseOpenCodeModels(stdout);
  }
}

export function parseOpenCodeModels(output: string): DiscoveredProviderCapability {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
    throw new Error("OpenCode model catalog exceeded the size limit.");
  }
  const records = parseRecords(output);
  if (records.length > MAX_MODELS) {
    throw new Error("OpenCode model catalog exceeded the model limit.");
  }
  const models = records.map(({ header, value }) => {
    const model = rawModelSchema.parse(value);
    if (`${model.providerID}/${model.id}` !== header) {
      throw new Error("OpenCode model header does not match its metadata.");
    }
    return {
      id: header,
      label: model.name,
      description: null,
      defaultReasoning: null,
      // OpenCode 1.18.21 exposes variants in this catalog, but its persistent root TUI has no
      // startup variant argument. Do not advertise a setting that the launcher cannot honor.
      reasoningOptions: []
    };
  });
  return discoveredProviderCapabilitySchema.parse({ defaultModel: null, models });
}

function parseRecords(output: string): readonly ParsedRecord[] {
  const records: ParsedRecord[] = [];
  let offset = 0;
  while (offset < output.length) {
    offset = skipWhitespace(output, offset);
    if (offset >= output.length) break;

    const newline = output.indexOf("\n", offset);
    if (newline < 0) throw new Error("OpenCode model catalog ended before its metadata.");
    const header = output.slice(offset, newline).replace(/\r$/u, "");
    if (!MODEL_HEADER.test(header) || header.length > MODEL_ID_MAX_LENGTH) {
      throw new Error("OpenCode model catalog contains an invalid model header.");
    }
    offset = skipWhitespace(output, newline + 1);
    const end = findJsonObjectEnd(output, offset);
    const serialized = output.slice(offset, end);
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
      throw new Error("OpenCode model metadata exceeded the record size limit.");
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      throw new Error("OpenCode model catalog contains invalid JSON.");
    }
    records.push({ header, value });
    offset = end;
  }
  return records;
}

function findJsonObjectEnd(output: string, start: number): number {
  if (output[start] !== "{") {
    throw new Error("OpenCode model metadata must be a JSON object.");
  }
  const nesting: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      nesting.push(character);
      if (nesting.length > MAX_JSON_DEPTH) {
        throw new Error("OpenCode model metadata exceeded the nesting limit.");
      }
    } else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (nesting.pop() !== expected) break;
      if (nesting.length === 0) return index + 1;
    }
  }
  throw new Error("OpenCode model metadata is incomplete.");
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/u.test(value[index] ?? "")) index += 1;
  return index;
}
