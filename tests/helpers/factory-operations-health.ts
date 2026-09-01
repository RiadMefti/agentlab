import {
  factoryOperationsHealthPolicySchema,
  type FactoryOperationsHealthPolicy
} from "@agentlab/contracts";

export function testFactoryOperationsHealthPolicy(
  overrides: Partial<FactoryOperationsHealthPolicy> = {}
): FactoryOperationsHealthPolicy {
  return factoryOperationsHealthPolicySchema.parse({
    schemaVersion: "agentlab.operations-health-policy.v1",
    id: "agentlab/operations-health",
    version: "1.0.0",
    lookbackSeconds: 86_400,
    maximumScheduleOverrunSeconds: 300,
    maximumInFlightSilenceSeconds: 3_600,
    quotaWarningBasisPoints: 8_000,
    maximumRecordsPerSection: 1_000,
    ...overrides
  });
}
