import { z } from "zod";

import { factoryActorSchema, factoryTimestampSchema, sha256DigestSchema } from "./factory.js";
import { factoryOperationsHealthReportSchema } from "./factory-operations-health.js";

const authorityStateSchema = z
  .object({
    schedulerEnabled: z.boolean(),
    prBrokerEnabled: z.boolean()
  })
  .strict();

/** Durable proof that a critical independently recomputed report removed existing authority. */
export const factoryIncidentContainmentSchema = z
  .object({
    schemaVersion: z.literal("agentlab.incident-containment.v1"),
    containmentId: z.uuid(),
    healthReportDigest: sha256DigestSchema,
    healthReport: factoryOperationsHealthReportSchema,
    authorityBefore: authorityStateSchema,
    brokerDisableEventDigest: sha256DigestSchema.nullable(),
    schedulerDisableEventDigest: sha256DigestSchema.nullable(),
    actor: factoryActorSchema,
    containedAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((containment, context) => {
    if (
      containment.healthReport.status !== "critical" ||
      !containment.healthReport.incidentRecommended
    ) {
      context.addIssue({
        code: "custom",
        path: ["healthReport"],
        message: "Incident containment requires a critical health report."
      });
    }
    if (
      !containment.authorityBefore.schedulerEnabled &&
      !containment.authorityBefore.prBrokerEnabled
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorityBefore"],
        message: "Incident containment must remove at least one enabled authority."
      });
    }
    if (
      containment.authorityBefore.prBrokerEnabled !==
      (containment.brokerDisableEventDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["brokerDisableEventDigest"],
        message: "Broker disable evidence must exactly match prior broker authority."
      });
    }
    if (
      containment.authorityBefore.schedulerEnabled !==
      (containment.schedulerDisableEventDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["schedulerDisableEventDigest"],
        message: "Scheduler disable evidence must exactly match prior scheduler authority."
      });
    }
    if (
      containment.actor.kind !== "control-plane" ||
      containment.actor.role !== "incident-commander" ||
      containment.actor.sessionId !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Incident containment requires the isolated control-plane incident commander."
      });
    }
    if (containment.containedAt < containment.healthReport.observedAt) {
      context.addIssue({
        code: "custom",
        path: ["containedAt"],
        message: "Incident containment cannot precede its health observation."
      });
    }
  });
export type FactoryIncidentContainment = z.infer<typeof factoryIncidentContainmentSchema>;
