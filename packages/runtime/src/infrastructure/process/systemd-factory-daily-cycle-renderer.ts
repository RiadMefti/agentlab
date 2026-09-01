import { createHash } from "node:crypto";

import {
  factoryDailyCycleBundleSchema,
  sha256DigestSchema,
  type FactoryDailyCycleBundle,
  type FactoryDailyCycleManifest,
  type FactoryDailyCycleUnit,
  type Sha256Digest
} from "@agentlab/contracts";

import type {
  FactoryDailyCyclePlan,
  FactoryDailyCycleStage
} from "../../domain/factory-daily-cycle-plan.js";
import { canonicalJson } from "../persistence/canonical-factory-documents.js";

const timerUnit = "agentlab-factory-daily.timer" as const;
const incidentUnit = "agentlab-factory-incident.target" as const;

/** Renders reviewable system units only; it never writes, installs, enables, or starts them. */
export function renderSystemdFactoryDailyCycle(
  manifest: FactoryDailyCycleManifest,
  plan: FactoryDailyCyclePlan
): FactoryDailyCycleBundle {
  const stageUnits = plan.stages.map((stage, index) =>
    serviceUnit(stage, plan.stages[index + 1], manifest.executableChecksumPath)
  );
  const units = Object.freeze([
    unit(incidentUnit, "target", incidentTargetContent()),
    ...stageUnits,
    unit(timerUnit, "timer", timerContent(plan))
  ]);
  const manifestDigest = digest(canonicalJson(manifest));
  const checksumContent = `${manifest.agentlabExecutable.digest.slice("sha256:".length)}  ${manifest.agentlabExecutable.path}\n`;
  const executableVerification = {
    verifierPath: "/usr/bin/sha256sum" as const,
    checksumFilePath: manifest.executableChecksumPath,
    checksumContent,
    checksumDigest: digest(checksumContent)
  };
  const body = {
    schemaVersion: "agentlab.daily-cycle-bundle.v1" as const,
    manifestDigest,
    schedulePolicyDigest: manifest.expectedSchedulePolicyDigest,
    roleIdentityPolicyDigest: manifest.expectedRoleIdentityPolicyDigest,
    factoryPolicyBundleDigest: manifest.expectedFactoryPolicyBundleDigest,
    agentlabExecutableDigest: manifest.agentlabExecutable.digest,
    executableVerification,
    timerUnit,
    units
  };
  return factoryDailyCycleBundleSchema.parse({
    ...body,
    bundleDigest: digest(canonicalJson(body))
  });
}

function serviceUnit(
  stage: FactoryDailyCycleStage,
  next: FactoryDailyCycleStage | undefined,
  executableChecksumPath: string
): FactoryDailyCycleUnit {
  const name = `agentlab-factory-${stage.id}.service`;
  const nextDirective =
    next === undefined
      ? ""
      : `OnSuccess=agentlab-factory-${next.id}.service\nOnSuccessJobMode=fail\n`;
  const userEnvironment =
    stage.role === "worker"
      ? `Environment=${unitWord(`XDG_RUNTIME_DIR=/run/user/${String(stage.userId)}`)} ${unitWord(
          `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${String(stage.userId)}/bus`
        )}\n`
      : "";
  const content = `[Unit]
Description=AgentLab daily factory ${stage.id} (${stage.role})
Documentation=https://github.com/riadmefti/agentlab/blob/main/docs/factory-operations.md
OnFailure=${incidentUnit}
OnFailureJobMode=replace
${nextDirective}
[Service]
Type=oneshot
User=${String(stage.userId)}
SetLoginEnvironment=yes
UMask=0077
WorkingDirectory=/
Environment=CI=true LC_ALL=C NO_COLOR=1
${userEnvironment}ExecStartPre=:"/usr/bin/sha256sum" "--status" "--check" ${unitWord(executableChecksumPath)}
ExecStart=:${unitWord(stage.executable)} ${stage.arguments.map(unitWord).join(" ")}
TimeoutStartSec=${String(stage.timeoutSeconds)}s
TimeoutStopSec=120s
KillMode=mixed
Restart=no
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateDevices=yes
ProtectSystem=full
ProtectClock=yes
ProtectControlGroups=yes
ProtectHostname=yes
ProtectKernelLogs=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
SystemCallArchitectures=native
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentlab-factory-${stage.id}
`;
  return unit(name, "service", content);
}

function incidentTargetContent(): string {
  return `[Unit]
Description=AgentLab daily factory incident signal
Documentation=https://github.com/riadmefti/agentlab/blob/main/docs/factory-operations.md
`;
}

function timerContent(plan: FactoryDailyCyclePlan): string {
  return `[Unit]
Description=AgentLab bounded daily software factory
Documentation=https://github.com/riadmefti/agentlab/blob/main/docs/factory-operations.md

[Timer]
OnCalendar=*-*-* ${plan.scheduleAtUtc}:00 UTC
AccuracySec=1s
RandomizedDelaySec=0
Persistent=false
Unit=agentlab-factory-scheduler.service

[Install]
WantedBy=timers.target
`;
}

function unit(
  name: string,
  kind: FactoryDailyCycleUnit["kind"],
  content: string
): FactoryDailyCycleUnit {
  return { name, kind, content, digest: digest(content) };
}

function unitWord(value: string): string {
  if (
    value.length === 0 ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("Systemd command arguments must be non-empty and control-free.");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function digest(value: string): Sha256Digest {
  return sha256DigestSchema.parse(
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
  );
}
