import { access, lstat, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

export type ArchitectureLayer =
  | "contracts"
  | "launcher"
  | "runtime-domain"
  | "runtime-application"
  | "runtime-infrastructure"
  | "runtime-composition"
  | "tui";

interface WorkspaceRegistration {
  readonly directory: string;
  readonly packageName: string;
  readonly sourceRoot: string;
  readonly publicExports: Readonly<
    Record<
      string,
      {
        readonly source: string;
        readonly default: string;
        readonly types: string;
      }
    >
  >;
  readonly expectedBin?: Readonly<Record<string, string>>;
}

export interface SourceRootRegistration {
  readonly directory: string;
  readonly sourceRoot: string;
}

export const architectureRegistry: readonly WorkspaceRegistration[] = [
  {
    directory: "apps/tui",
    packageName: "@agentlab/tui",
    sourceRoot: "apps/tui/src",
    publicExports: {}
  },
  {
    directory: "packages/contracts",
    packageName: "@agentlab/contracts",
    sourceRoot: "packages/contracts/src",
    publicExports: {
      ".": {
        source: "packages/contracts/src/index.ts",
        default: "./dist/index.js",
        types: "./dist/index.d.ts"
      }
    }
  },
  {
    directory: "packages/launcher",
    packageName: "agentlab",
    sourceRoot: "packages/launcher/src",
    publicExports: {},
    expectedBin: { agentlab: "dist/agentlab.js" }
  },
  {
    directory: "packages/runtime",
    packageName: "@agentlab/runtime",
    sourceRoot: "packages/runtime/src",
    publicExports: {
      ".": {
        source: "packages/runtime/src/local-runtime.ts",
        default: "./dist/local-runtime.js",
        types: "./dist/local-runtime.d.ts"
      },
      "./factory-broker": {
        source: "packages/runtime/src/local-factory-broker.ts",
        default: "./dist/local-factory-broker.js",
        types: "./dist/local-factory-broker.d.ts"
      },
      "./factory-worker": {
        source: "packages/runtime/src/local-factory-worker.ts",
        default: "./dist/local-factory-worker.js",
        types: "./dist/local-factory-worker.d.ts"
      },
      "./factory-authority": {
        source: "packages/runtime/src/local-factory-authority.ts",
        default: "./dist/local-factory-authority.js",
        types: "./dist/local-factory-authority.d.ts"
      },
      "./factory-intake": {
        source: "packages/runtime/src/local-factory-intake.ts",
        default: "./dist/local-factory-intake.js",
        types: "./dist/local-factory-intake.d.ts"
      },
      "./factory-evaluator": {
        source: "packages/runtime/src/local-factory-evaluator.ts",
        default: "./dist/local-factory-evaluator.js",
        types: "./dist/local-factory-evaluator.d.ts"
      },
      "./factory-eval-attestor": {
        source: "packages/runtime/src/local-factory-eval-attestor.ts",
        default: "./dist/local-factory-eval-attestor.js",
        types: "./dist/local-factory-eval-attestor.d.ts"
      },
      "./factory-canary-authority": {
        source: "packages/runtime/src/local-factory-canary-authority.ts",
        default: "./dist/local-factory-canary-authority.js",
        types: "./dist/local-factory-canary-authority.d.ts"
      }
    }
  }
] as const;

const registrationByDirectory = new Map(
  architectureRegistry.map((registration) => [registration.directory, registration])
);
const registrationByPackage = new Map(
  architectureRegistry.map((registration) => [registration.packageName, registration])
);
const packageEntries = new Map(
  architectureRegistry.flatMap((registration) =>
    Object.entries(registration.publicExports).map(
      ([exportName, entry]) =>
        [packageSpecifier(registration.packageName, exportName), entry.source] as const
    )
  )
);

export interface ArchitectureDependency {
  readonly column?: number;
  readonly line?: number;
  readonly local: boolean;
  readonly specifier: string;
  readonly target: string | null;
}

export interface ArchitectureModule {
  readonly dependencies: readonly ArchitectureDependency[];
  readonly path: string;
}

export type ArchitectureViolationKind =
  | "cycle"
  | "composition-boundary"
  | "deep-package-import"
  | "external-capability"
  | "layer-dependency"
  | "manifest-dependency"
  | "manifest-export"
  | "parse-error"
  | "relative-package-import"
  | "unclassified-module"
  | "unknown-workspace"
  | "unresolved-local-import"
  | "unsupported-import"
  | "workspace-inventory";

export interface ArchitectureViolation {
  readonly kind: ArchitectureViolationKind;
  readonly message: string;
  readonly source: string;
  readonly target?: string;
}

export interface ArchitectureReport {
  readonly dependencyCount: number;
  readonly moduleCount: number;
  readonly violations: readonly ArchitectureViolation[];
}

const allowedLayers: Readonly<Record<ArchitectureLayer, ReadonlySet<ArchitectureLayer>>> = {
  contracts: new Set(["contracts"]),
  launcher: new Set(["launcher"]),
  "runtime-domain": new Set(["contracts", "runtime-domain"]),
  "runtime-application": new Set(["contracts", "runtime-domain", "runtime-application"]),
  "runtime-infrastructure": new Set(["contracts", "runtime-domain", "runtime-infrastructure"]),
  "runtime-composition": new Set([
    "contracts",
    "runtime-domain",
    "runtime-application",
    "runtime-infrastructure",
    "runtime-composition"
  ]),
  tui: new Set(["contracts", "runtime-composition", "tui"])
};

const allowedExternalCapabilities: Readonly<Record<ArchitectureLayer, ReadonlySet<string>>> = {
  contracts: new Set(["zod"]),
  launcher: new Set(["node:*"]),
  "runtime-domain": new Set(["zod"]),
  "runtime-application": new Set(["zod"]),
  "runtime-infrastructure": new Set(["node:*", "zod", "@anthropic-ai/claude-agent-sdk"]),
  "runtime-composition": new Set(["node:*"]),
  tui: new Set(["node:*", "react", "@opentui/core", "@opentui/react"])
};

const forbiddenInnerRuntimeGlobals = new Set([
  "Buffer",
  "Bun",
  "Date",
  "EventSource",
  "WebSocket",
  "clearImmediate",
  "clearInterval",
  "clearTimeout",
  "console",
  "crypto",
  "fetch",
  "global",
  "globalThis",
  "performance",
  "process",
  "queueMicrotask",
  "setImmediate",
  "setInterval",
  "setTimeout"
]);
const forbiddenDynamicRuntimeIdentifiers = new Set(["Function", "eval", "module", "require"]);

export async function inspectArchitecture(projectRoot: string): Promise<ArchitectureReport> {
  const inventory = await inspectWorkspaceInventory(projectRoot);
  const production = await inspectProductionSourceInventory(projectRoot);
  const sourcePaths = production.paths;
  const sourcePathSet = new Set(sourcePaths);
  const program = ts.createProgram({
    rootNames: sourcePaths.map((path) => resolve(projectRoot, path)),
    options: {
      allowJs: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2023
    }
  });
  const checker = program.getTypeChecker();
  const parseViolations: ArchitectureViolation[] = [];
  const modules = await Promise.all(
    sourcePaths.map(async (path): Promise<ArchitectureModule> => {
      const source = await readFile(resolve(projectRoot, path), "utf8");
      const extracted = extractModuleSpecifiers(
        path,
        source,
        program.getSourceFile(resolve(projectRoot, path)),
        checker
      );
      parseViolations.push(...extracted.violations);
      return {
        path,
        dependencies: extracted.dependencies.map((dependency) => ({
          ...dependency,
          ...resolveDependency(projectRoot, path, dependency.specifier, sourcePathSet)
        }))
      };
    })
  );
  const sourceReport = architectureReport(modules);
  const manifestViolations = await inspectManifestAgreement(projectRoot, modules, inventory);
  return {
    dependencyCount: sourceReport.dependencyCount,
    moduleCount: sourceReport.moduleCount,
    violations: sortViolations([
      ...inventory.violations,
      ...production.violations,
      ...parseViolations,
      ...sourceReport.violations,
      ...manifestViolations
    ])
  };
}

export function architectureReport(modules: readonly ArchitectureModule[]): ArchitectureReport {
  return {
    dependencyCount: modules.reduce((count, module) => count + module.dependencies.length, 0),
    moduleCount: modules.length,
    violations: validateArchitecture(modules)
  };
}

export function validateArchitecture(
  modules: readonly ArchitectureModule[]
): readonly ArchitectureViolation[] {
  const moduleByPath = new Map(modules.map((module) => [module.path, module]));
  const violations: ArchitectureViolation[] = [];

  for (const module of modules) {
    const sourceLayer = architectureLayer(module.path);
    const sourcePackage = workspaceDirectory(module.path);
    if (sourceLayer === null) {
      violations.push(
        violation(
          "unclassified-module",
          module.path,
          `${module.path} does not belong to a declared architecture layer.`
        )
      );
    }
    for (const dependency of module.dependencies) {
      const location = dependencyLocation(module.path, dependency);
      const workspaceImport = workspaceImportRegistration(dependency.specifier);
      if (workspaceImport !== null && !packageEntries.has(dependency.specifier)) {
        violations.push(
          violation(
            "deep-package-import",
            module.path,
            `${location} imports non-public workspace entry ${dependency.specifier}.`
          )
        );
        continue;
      }

      if (!dependency.local) {
        if (sourceLayer !== null) {
          const capability = externalCapability(dependency.specifier);
          if (!allowedExternalCapabilities[sourceLayer].has(capability)) {
            violations.push(
              violation(
                "external-capability",
                module.path,
                `${location} imports external capability ${capability}, which is not allowed in ${sourceLayer}.`
              )
            );
          }
        }
        continue;
      }
      if (dependency.target === null || !moduleByPath.has(dependency.target)) {
        violations.push({
          kind: "unresolved-local-import",
          source: module.path,
          ...(dependency.target === null ? {} : { target: dependency.target }),
          message: `${location} cannot resolve local import ${dependency.specifier}.`
        });
        continue;
      }

      const targetLayer = architectureLayer(dependency.target);
      const targetPackage = workspaceDirectory(dependency.target);
      if (
        dependency.specifier.startsWith(".") &&
        sourcePackage !== null &&
        targetPackage !== null &&
        sourcePackage !== targetPackage
      ) {
        violations.push({
          kind: "relative-package-import",
          source: module.path,
          target: dependency.target,
          message: `${location} crosses a package boundary with ${dependency.specifier}; use the package public API.`
        });
      }
      if (
        sourceLayer !== null &&
        targetLayer !== null &&
        !allowedLayers[sourceLayer].has(targetLayer)
      ) {
        violations.push({
          kind: "layer-dependency",
          source: module.path,
          target: dependency.target,
          message: `${location} is ${sourceLayer} and must not depend on ${targetLayer} module ${dependency.target}.`
        });
      }
    }
  }

  violations.push(...compositionBoundaryViolations(moduleByPath));
  violations.push(...cycleViolations(modules, moduleByPath));
  return sortViolations(violations);
}

function compositionBoundaryViolations(
  moduleByPath: ReadonlyMap<string, ArchitectureModule>
): readonly ArchitectureViolation[] {
  const rules = [
    {
      entry: "packages/runtime/src/local-factory-broker.ts",
      description: "broker composition",
      forbidden: (path: string) =>
        path === "packages/runtime/src/local-runtime.ts" ||
        path === "packages/runtime/src/local-factory-worker.ts" ||
        isFactoryIntakeModule(path) ||
        isFactoryAuthorityModule(path) ||
        isFactoryEvaluatorModule(path) ||
        isFactoryEvalAttestorModule(path) ||
        isFactoryCanaryAuthorityModule(path) ||
        path.startsWith("packages/runtime/src/infrastructure/providers/") ||
        path.startsWith("packages/runtime/src/infrastructure/terminal/") ||
        path.startsWith("packages/runtime/src/infrastructure/tmux/")
    },
    {
      entry: "packages/runtime/src/local-runtime.ts",
      description: "interactive composition",
      forbidden: (path: string) =>
        path === "packages/runtime/src/local-factory-broker.ts" ||
        path === "packages/runtime/src/local-factory-worker.ts" ||
        isFactoryIntakeModule(path) ||
        isFactoryAuthorityModule(path) ||
        isFactoryEvaluatorModule(path) ||
        isFactoryEvalAttestorModule(path) ||
        isFactoryCanaryAuthorityModule(path) ||
        path.startsWith("packages/runtime/src/infrastructure/github/")
    },
    {
      entry: "packages/runtime/src/local-factory-worker.ts",
      description: "worker composition",
      forbidden: (path: string) =>
        path === "packages/runtime/src/local-runtime.ts" ||
        path === "packages/runtime/src/local-factory-broker.ts" ||
        isFactoryIntakeModule(path) ||
        isFactoryAuthorityModule(path) ||
        isFactoryEvaluatorModule(path) ||
        isFactoryEvalAttestorModule(path) ||
        isFactoryCanaryAuthorityModule(path) ||
        path.startsWith("packages/runtime/src/infrastructure/github/") ||
        path.startsWith("packages/runtime/src/infrastructure/terminal/") ||
        path.startsWith("packages/runtime/src/infrastructure/tmux/") ||
        (path.startsWith("packages/runtime/src/infrastructure/providers/") &&
          !factoryWorkerProviderModules.has(path))
    },
    {
      entry: "packages/runtime/src/local-factory-authority.ts",
      description: "human authority composition",
      forbidden: authorityCommandForbidden
    },
    {
      entry: "packages/runtime/src/local-factory-intake.ts",
      description: "intake composition",
      forbidden: intakeCommandForbidden
    },
    {
      entry: "packages/runtime/src/local-factory-evaluator.ts",
      description: "credentialless evaluator composition",
      forbidden: evaluatorCommandForbidden
    },
    {
      entry: "packages/runtime/src/local-factory-eval-attestor.ts",
      description: "isolated eval attestor composition",
      forbidden: evalAttestorCommandForbidden
    },
    {
      entry: "packages/runtime/src/local-factory-canary-authority.ts",
      description: "human canary authority composition",
      forbidden: canaryAuthorityCommandForbidden
    },
    {
      entry: "apps/tui/src/run-factory-broker-preflight.ts",
      description: "broker preflight command",
      forbidden: brokerCommandForbidden
    },
    {
      entry: "apps/tui/src/run-factory-broker-open-draft.ts",
      description: "broker draft command",
      forbidden: brokerCommandForbidden
    },
    {
      entry: "apps/tui/src/run-factory-worker-preflight.ts",
      description: "worker preflight command",
      forbidden: workerCommandForbidden
    },
    {
      entry: "apps/tui/src/run-factory-worker-task.ts",
      description: "worker task command",
      forbidden: workerCommandForbidden
    },
    {
      entry: "apps/tui/src/run-factory-authority.ts",
      description: "human authority command",
      forbidden: authorityCommandForbidden
    },
    {
      entry: "apps/tui/src/run-factory-intake-preflight.ts",
      description: "intake preflight command",
      forbidden: intakeCommandForbidden
    },
    {
      entry: "apps/tui/src/run-factory-intake-register.ts",
      description: "intake registration command",
      forbidden: intakeCommandForbidden
    },
    {
      entry: "apps/tui/src/run-factory-evaluator.ts",
      description: "credentialless evaluator command",
      forbidden: evaluatorCommandForbidden
    },
    {
      entry: "apps/tui/src/run-factory-eval-attestor.ts",
      description: "isolated eval attestor command",
      forbidden: evalAttestorCommandForbidden
    },
    {
      entry: "apps/tui/src/run-factory-canary-authority.ts",
      description: "human canary authority command",
      forbidden: canaryAuthorityCommandForbidden
    }
  ] as const;
  const violations: ArchitectureViolation[] = [];
  for (const rule of rules) {
    if (!moduleByPath.has(rule.entry)) continue;
    const pending: string[][] = [[rule.entry]];
    const visited = new Set<string>([rule.entry]);
    while (pending.length > 0) {
      const path = pending.shift();
      if (path === undefined) continue;
      const current = path.at(-1);
      if (current === undefined) continue;
      const module = moduleByPath.get(current);
      if (module === undefined) continue;
      for (const dependency of module.dependencies) {
        const target = dependency.local ? dependency.target : null;
        if (target === null || !moduleByPath.has(target) || visited.has(target)) continue;
        const nextPath = [...path, target];
        visited.add(target);
        if (rule.forbidden(target)) {
          violations.push({
            kind: "composition-boundary",
            source: rule.entry,
            target,
            message: `${rule.description} reaches forbidden module ${target}: ${nextPath.join(
              " -> "
            )}.`
          });
          continue;
        }
        pending.push(nextPath);
      }
    }
  }
  return violations;
}

function brokerCommandForbidden(path: string): boolean {
  return (
    path === "packages/runtime/src/local-runtime.ts" ||
    path === "packages/runtime/src/local-factory-worker.ts" ||
    isFactoryIntakeModule(path) ||
    isFactoryAuthorityModule(path) ||
    isFactoryEvaluatorModule(path) ||
    isFactoryEvalAttestorModule(path) ||
    isFactoryCanaryAuthorityModule(path) ||
    path.startsWith("packages/runtime/src/infrastructure/providers/") ||
    path.startsWith("packages/runtime/src/infrastructure/terminal/") ||
    path.startsWith("packages/runtime/src/infrastructure/tmux/")
  );
}

function workerCommandForbidden(path: string): boolean {
  return (
    path === "packages/runtime/src/local-runtime.ts" ||
    path === "packages/runtime/src/local-factory-broker.ts" ||
    isFactoryIntakeModule(path) ||
    isFactoryAuthorityModule(path) ||
    isFactoryEvaluatorModule(path) ||
    isFactoryEvalAttestorModule(path) ||
    isFactoryCanaryAuthorityModule(path) ||
    path.startsWith("packages/runtime/src/infrastructure/github/") ||
    path.startsWith("packages/runtime/src/infrastructure/terminal/") ||
    path.startsWith("packages/runtime/src/infrastructure/tmux/") ||
    (path.startsWith("packages/runtime/src/infrastructure/providers/") &&
      !factoryWorkerProviderModules.has(path))
  );
}

const factoryAuthorityApplicationModules = new Set([
  "packages/runtime/src/application/factory-authority-operator.ts",
  "packages/runtime/src/application/local-factory-authority-coordinator.ts",
  "packages/runtime/src/application/local-runtime-construction.ts",
  "packages/runtime/src/application/runtime-repository-owner.ts",
  "packages/runtime/src/application/runtime-task-owner.ts"
]);

const factoryAuthorityInfrastructureModules = new Set([
  "packages/runtime/src/infrastructure/filesystem/database-target.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-authority-config.ts",
  "packages/runtime/src/infrastructure/filesystem/private-local-file.ts",
  "packages/runtime/src/infrastructure/persistence/canonical-factory-documents.ts",
  "packages/runtime/src/infrastructure/persistence/migrations.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-database.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-writer-lease.ts"
]);

function isFactoryAuthorityModule(path: string): boolean {
  return (
    path === "packages/runtime/src/local-factory-authority.ts" ||
    path === "packages/runtime/src/application/factory-authority-operator.ts" ||
    path === "packages/runtime/src/application/local-factory-authority-coordinator.ts" ||
    path === "packages/runtime/src/infrastructure/filesystem/local-factory-authority-config.ts"
  );
}

const factoryIntakeApplicationModules = new Set([
  "packages/runtime/src/application/factory-intake-operator.ts",
  "packages/runtime/src/application/factory-preparation-intake-service.ts",
  "packages/runtime/src/application/factory-skill-package-publisher.ts",
  "packages/runtime/src/application/local-factory-intake-coordinator.ts",
  "packages/runtime/src/application/local-runtime-construction.ts",
  "packages/runtime/src/application/runtime-repository-owner.ts",
  "packages/runtime/src/application/runtime-resource-owner.ts",
  "packages/runtime/src/application/runtime-task-owner.ts"
]);

const factoryIntakeInfrastructureModules = new Set([
  "packages/runtime/src/infrastructure/filesystem/database-target.ts",
  "packages/runtime/src/infrastructure/filesystem/factory-git-command.ts",
  "packages/runtime/src/infrastructure/filesystem/factory-workspace-paths.ts",
  "packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.ts",
  "packages/runtime/src/infrastructure/filesystem/git-factory-repository-revision.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-cost-policy.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-intake-config.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-intake-submission.ts",
  "packages/runtime/src/infrastructure/filesystem/private-local-file.ts",
  "packages/runtime/src/infrastructure/persistence/canonical-factory-documents.ts",
  "packages/runtime/src/infrastructure/persistence/canonical-factory-intake-deduplicator.ts",
  "packages/runtime/src/infrastructure/persistence/migrations.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-conversation-repository.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-database.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-factory-preparation-repository.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-writer-lease.ts",
  "packages/runtime/src/infrastructure/process/command-runner.ts",
  "packages/runtime/src/infrastructure/process/managed-child-process.ts",
  "packages/runtime/src/infrastructure/process/process-tree.ts"
]);

function isFactoryIntakeModule(path: string): boolean {
  return (
    path === "packages/runtime/src/local-factory-intake.ts" ||
    path === "packages/runtime/src/application/factory-intake-operator.ts" ||
    path === "packages/runtime/src/application/local-factory-intake-coordinator.ts" ||
    path === "packages/runtime/src/infrastructure/filesystem/local-factory-intake-config.ts" ||
    path === "packages/runtime/src/infrastructure/filesystem/local-factory-intake-submission.ts"
  );
}

function intakeCommandForbidden(path: string): boolean {
  if (
    path === "packages/runtime/src/local-runtime.ts" ||
    path === "packages/runtime/src/local-factory-broker.ts" ||
    path === "packages/runtime/src/local-factory-worker.ts" ||
    isFactoryAuthorityModule(path) ||
    isFactoryEvaluatorModule(path) ||
    isFactoryEvalAttestorModule(path) ||
    isFactoryCanaryAuthorityModule(path)
  ) {
    return true;
  }
  if (path.startsWith("packages/runtime/src/application/")) {
    return !factoryIntakeApplicationModules.has(path);
  }
  if (path.startsWith("packages/runtime/src/infrastructure/")) {
    return !factoryIntakeInfrastructureModules.has(path);
  }
  return false;
}

function authorityCommandForbidden(path: string): boolean {
  if (
    path === "packages/runtime/src/local-runtime.ts" ||
    path === "packages/runtime/src/local-factory-broker.ts" ||
    path === "packages/runtime/src/local-factory-worker.ts" ||
    path === "packages/runtime/src/local-factory-intake.ts" ||
    isFactoryEvaluatorModule(path) ||
    isFactoryEvalAttestorModule(path) ||
    isFactoryCanaryAuthorityModule(path)
  ) {
    return true;
  }
  if (path.startsWith("packages/runtime/src/application/")) {
    return !factoryAuthorityApplicationModules.has(path);
  }
  if (path.startsWith("packages/runtime/src/infrastructure/")) {
    return !factoryAuthorityInfrastructureModules.has(path);
  }
  return false;
}

const factoryEvaluatorApplicationModules = new Set([
  "packages/runtime/src/application/factory-eval-attestation-service.ts",
  "packages/runtime/src/application/factory-evaluation-service.ts",
  "packages/runtime/src/application/local-factory-evaluator-coordinator.ts",
  "packages/runtime/src/application/local-runtime-construction.ts",
  "packages/runtime/src/application/runtime-repository-owner.ts",
  "packages/runtime/src/application/runtime-task-owner.ts"
]);

const factoryEvaluatorInfrastructureModules = new Set([
  "packages/runtime/src/infrastructure/crypto/factory-dsse-primitives.ts",
  "packages/runtime/src/infrastructure/crypto/node-factory-dsse-verifier.ts",
  "packages/runtime/src/infrastructure/filesystem/database-target.ts",
  "packages/runtime/src/infrastructure/filesystem/file-factory-eval-attestation-key-source.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-eval-run.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-evaluator-config.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-signed-eval-attestation.ts",
  "packages/runtime/src/infrastructure/filesystem/private-local-file.ts",
  "packages/runtime/src/infrastructure/persistence/canonical-factory-documents.ts",
  "packages/runtime/src/infrastructure/persistence/migrations.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-database.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-factory-eval-attestation-repository.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-factory-evaluation-repository.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-writer-lease.ts"
]);

function isFactoryEvaluatorModule(path: string): boolean {
  return (
    path === "packages/runtime/src/local-factory-evaluator.ts" ||
    path === "packages/runtime/src/application/factory-eval-attestation-service.ts" ||
    path === "packages/runtime/src/application/factory-evaluation-service.ts" ||
    path === "packages/runtime/src/application/local-factory-evaluator-coordinator.ts" ||
    path === "packages/runtime/src/infrastructure/filesystem/local-factory-evaluator-config.ts"
  );
}

function evaluatorCommandForbidden(path: string): boolean {
  if (
    path === "packages/runtime/src/local-runtime.ts" ||
    path === "packages/runtime/src/local-factory-broker.ts" ||
    path === "packages/runtime/src/local-factory-worker.ts" ||
    path === "packages/runtime/src/local-factory-intake.ts" ||
    path === "packages/runtime/src/local-factory-authority.ts" ||
    isFactoryEvalAttestorModule(path) ||
    isFactoryCanaryAuthorityModule(path)
  ) {
    return true;
  }
  if (path.startsWith("packages/runtime/src/application/")) {
    return !factoryEvaluatorApplicationModules.has(path);
  }
  if (path.startsWith("packages/runtime/src/infrastructure/")) {
    return !factoryEvaluatorInfrastructureModules.has(path);
  }
  return false;
}

const factoryEvalAttestorApplicationModules = new Set([
  "packages/runtime/src/application/factory-eval-attestor-service.ts",
  "packages/runtime/src/application/local-factory-eval-attestor-coordinator.ts",
  "packages/runtime/src/application/runtime-task-owner.ts"
]);

const factoryEvalAttestorInfrastructureModules = new Set([
  "packages/runtime/src/infrastructure/crypto/factory-dsse-primitives.ts",
  "packages/runtime/src/infrastructure/crypto/node-factory-dsse-signer.ts",
  "packages/runtime/src/infrastructure/filesystem/file-factory-eval-attestation-key-source.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-eval-attestor-config.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-eval-run.ts",
  "packages/runtime/src/infrastructure/filesystem/private-local-file.ts",
  "packages/runtime/src/infrastructure/persistence/canonical-factory-documents.ts"
]);

function isFactoryEvalAttestorModule(path: string): boolean {
  return (
    path === "packages/runtime/src/local-factory-eval-attestor.ts" ||
    path === "packages/runtime/src/application/factory-eval-attestor-service.ts" ||
    path === "packages/runtime/src/application/local-factory-eval-attestor-coordinator.ts" ||
    path ===
      "packages/runtime/src/infrastructure/filesystem/local-factory-eval-attestor-config.ts" ||
    path === "packages/runtime/src/infrastructure/crypto/node-factory-dsse-signer.ts"
  );
}

function evalAttestorCommandForbidden(path: string): boolean {
  if (
    path === "packages/runtime/src/local-runtime.ts" ||
    path === "packages/runtime/src/local-factory-broker.ts" ||
    path === "packages/runtime/src/local-factory-worker.ts" ||
    path === "packages/runtime/src/local-factory-intake.ts" ||
    path === "packages/runtime/src/local-factory-authority.ts" ||
    isFactoryEvaluatorModule(path) ||
    isFactoryCanaryAuthorityModule(path)
  ) {
    return true;
  }
  if (path.startsWith("packages/runtime/src/application/")) {
    return !factoryEvalAttestorApplicationModules.has(path);
  }
  if (path.startsWith("packages/runtime/src/infrastructure/")) {
    return !factoryEvalAttestorInfrastructureModules.has(path);
  }
  return false;
}

const factoryCanaryAuthorityApplicationModules = new Set([
  "packages/runtime/src/application/factory-canary-authority-service.ts",
  "packages/runtime/src/application/local-factory-canary-authority-coordinator.ts",
  "packages/runtime/src/application/local-runtime-construction.ts",
  "packages/runtime/src/application/runtime-repository-owner.ts",
  "packages/runtime/src/application/runtime-task-owner.ts"
]);

const factoryCanaryAuthorityInfrastructureModules = new Set([
  "packages/runtime/src/infrastructure/filesystem/database-target.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-canary-authority-config.ts",
  "packages/runtime/src/infrastructure/filesystem/local-factory-canary-request.ts",
  "packages/runtime/src/infrastructure/filesystem/private-local-file.ts",
  "packages/runtime/src/infrastructure/persistence/canonical-factory-documents.ts",
  "packages/runtime/src/infrastructure/persistence/migrations.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-database.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-factory-canary-repository.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-factory-evaluation-repository.ts",
  "packages/runtime/src/infrastructure/persistence/sqlite-writer-lease.ts"
]);

function isFactoryCanaryAuthorityModule(path: string): boolean {
  return (
    path === "packages/runtime/src/local-factory-canary-authority.ts" ||
    path === "packages/runtime/src/application/factory-canary-authority-service.ts" ||
    path === "packages/runtime/src/application/local-factory-canary-authority-coordinator.ts" ||
    path ===
      "packages/runtime/src/infrastructure/filesystem/local-factory-canary-authority-config.ts" ||
    path === "packages/runtime/src/infrastructure/filesystem/local-factory-canary-request.ts"
  );
}

function canaryAuthorityCommandForbidden(path: string): boolean {
  if (
    path === "packages/runtime/src/local-runtime.ts" ||
    path === "packages/runtime/src/local-factory-broker.ts" ||
    path === "packages/runtime/src/local-factory-worker.ts" ||
    path === "packages/runtime/src/local-factory-intake.ts" ||
    path === "packages/runtime/src/local-factory-authority.ts" ||
    isFactoryEvaluatorModule(path) ||
    isFactoryEvalAttestorModule(path)
  ) {
    return true;
  }
  if (path.startsWith("packages/runtime/src/application/")) {
    return !factoryCanaryAuthorityApplicationModules.has(path);
  }
  if (path.startsWith("packages/runtime/src/infrastructure/")) {
    return !factoryCanaryAuthorityInfrastructureModules.has(path);
  }
  return false;
}

export function architectureLayer(path: string): ArchitectureLayer | null {
  if (path.startsWith("packages/contracts/src/")) return "contracts";
  if (path.startsWith("packages/launcher/src/")) return "launcher";
  if (path.startsWith("packages/runtime/src/domain/")) return "runtime-domain";
  if (path.startsWith("packages/runtime/src/application/")) return "runtime-application";
  if (path.startsWith("packages/runtime/src/infrastructure/")) return "runtime-infrastructure";
  if (
    path === "packages/runtime/src/local-runtime.ts" ||
    path === "packages/runtime/src/local-factory-broker.ts" ||
    path === "packages/runtime/src/local-factory-worker.ts" ||
    path === "packages/runtime/src/local-factory-authority.ts" ||
    path === "packages/runtime/src/local-factory-intake.ts" ||
    path === "packages/runtime/src/local-factory-evaluator.ts" ||
    path === "packages/runtime/src/local-factory-eval-attestor.ts" ||
    path === "packages/runtime/src/local-factory-canary-authority.ts"
  ) {
    return "runtime-composition";
  }
  if (path.startsWith("apps/tui/src/")) return "tui";
  return null;
}

const factoryWorkerProviderModules = new Set([
  "packages/runtime/src/infrastructure/providers/claude-factory-agent.ts",
  "packages/runtime/src/infrastructure/providers/codex-factory-agent.ts",
  "packages/runtime/src/infrastructure/providers/factory-agent-adapter.ts",
  "packages/runtime/src/infrastructure/providers/factory-agent-environment.ts",
  "packages/runtime/src/infrastructure/providers/factory-agent-output.ts",
  "packages/runtime/src/infrastructure/providers/local-factory-agent-executor.ts",
  "packages/runtime/src/infrastructure/providers/pinned-factory-agent-provider-resolver.ts"
]);

interface ProductionSourceInventory {
  readonly paths: readonly string[];
  readonly violations: readonly ArchitectureViolation[];
}

/** Returns every pair of registered roots where one could classify the other's files. */
export function sourceRootRegistrationOverlaps(
  registrations: readonly SourceRootRegistration[]
): readonly (readonly [string, string])[] {
  const overlaps: (readonly [string, string])[] = [];
  for (let leftIndex = 0; leftIndex < registrations.length; leftIndex += 1) {
    const left = registrations[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < registrations.length; rightIndex += 1) {
      const right = registrations[rightIndex];
      if (right === undefined) continue;
      const leftRoot = normalizedRegistryPath(left.sourceRoot);
      const rightRoot = normalizedRegistryPath(right.sourceRoot);
      if (pathWithin(leftRoot, rightRoot) || pathWithin(rightRoot, leftRoot)) {
        overlaps.push([left.directory, right.directory]);
      }
    }
  }
  return overlaps;
}

async function inspectProductionSourceInventory(
  projectRoot: string
): Promise<ProductionSourceInventory> {
  const violations: ArchitectureViolation[] = [];
  for (const [left, right] of sourceRootRegistrationOverlaps(architectureRegistry)) {
    violations.push(
      violation(
        "workspace-inventory",
        left,
        `Architecture source roots for ${left} and ${right} overlap; every production file must have exactly one owner.`
      )
    );
  }

  const paths = new Set<string>();
  const compiledBy = new Map<string, string[]>();
  for (const registration of architectureRegistry) {
    const configPath = `${registration.directory}/tsconfig.json`;
    const absoluteConfigPath = resolve(projectRoot, configPath);
    let sourceFiles: readonly string[] = [];
    try {
      sourceFiles = await findSourceFiles(projectRoot, registration.sourceRoot);
    } catch (error: unknown) {
      violations.push(
        violation(
          "workspace-inventory",
          registration.sourceRoot,
          `${registration.sourceRoot} cannot be inventoried: ${errorMessage(error)}.`
        )
      );
    }

    const config = ts.readConfigFile(absoluteConfigPath, (path) => ts.sys.readFile(path));
    if (config.error !== undefined) {
      violations.push(tsconfigViolation(configPath, config.error));
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      resolve(projectRoot, registration.directory),
      undefined,
      absoluteConfigPath
    );
    for (const diagnostic of parsed.errors) {
      violations.push(tsconfigViolation(configPath, diagnostic));
    }

    const expectedRoot = resolve(projectRoot, registration.sourceRoot);
    if (parsed.options.rootDir === undefined || resolve(parsed.options.rootDir) !== expectedRoot) {
      violations.push(
        violation(
          "workspace-inventory",
          configPath,
          `${configPath} rootDir must resolve exactly to ${registration.sourceRoot}.`
        )
      );
    }
    for (const [option, configured] of [
      ["baseUrl", parsed.options.baseUrl !== undefined],
      ["paths", parsed.options.paths !== undefined],
      ["rootDirs", parsed.options.rootDirs !== undefined],
      ["moduleSuffixes", parsed.options.moduleSuffixes !== undefined]
    ] as const) {
      if (configured) {
        violations.push(
          violation(
            "workspace-inventory",
            configPath,
            `${configPath} must not configure ${option}; source aliases can bypass architecture ownership.`
          )
        );
      }
    }
    if (parsed.options.allowJs === true) {
      violations.push(
        violation(
          "workspace-inventory",
          configPath,
          `${configPath} must keep allowJs disabled so production inventory stays exhaustive.`
        )
      );
    }

    const compiled = new Set<string>();
    for (const absolutePath of parsed.fileNames) {
      if (!/\.(?:ts|tsx|mts|cts)$/u.test(absolutePath)) continue;
      const path = projectRelative(projectRoot, absolutePath);
      if (path === ".." || path.startsWith("../")) {
        violations.push(
          violation(
            "workspace-inventory",
            configPath,
            `${configPath} compiles source outside the repository: ${path}.`
          )
        );
        continue;
      }
      compiled.add(path);
      paths.add(path);
      const owners = compiledBy.get(path) ?? [];
      owners.push(registration.directory);
      compiledBy.set(path, owners);
      if (!pathWithin(registration.sourceRoot, path)) {
        violations.push(
          violation(
            "workspace-inventory",
            configPath,
            `${configPath} compiles ${path} outside registered root ${registration.sourceRoot}.`
          )
        );
      }
    }

    for (const path of sourceFiles) {
      if (!compiled.has(path)) {
        violations.push(
          violation(
            "workspace-inventory",
            configPath,
            `${path} is production source under ${registration.sourceRoot} but is not compiled by ${configPath}.`
          )
        );
      }
    }
    for (const { source } of Object.values(registration.publicExports)) {
      if (!compiled.has(source)) {
        violations.push(
          violation(
            "workspace-inventory",
            configPath,
            `${source} is a public source entry but is not compiled by ${configPath}.`
          )
        );
      }
    }
  }

  for (const path of paths) {
    const rootOwners = architectureRegistry.filter((registration) =>
      pathWithin(registration.sourceRoot, path)
    );
    if (rootOwners.length !== 1) {
      violations.push(
        violation(
          "workspace-inventory",
          path,
          `${path} belongs to ${String(rootOwners.length)} registered source roots; exactly one is required.`
        )
      );
    }
    const compilationOwners = compiledBy.get(path) ?? [];
    if (compilationOwners.length !== 1) {
      violations.push(
        violation(
          "workspace-inventory",
          path,
          `${path} is compiled by ${String(compilationOwners.length)} workspace tsconfigs; exactly one is required.`
        )
      );
    }
  }

  return { paths: [...paths].sort(), violations };
}

function tsconfigViolation(path: string, diagnostic: ts.Diagnostic): ArchitectureViolation {
  return violation(
    "workspace-inventory",
    path,
    `${path} is invalid: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`
  );
}

function normalizedRegistryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function pathWithin(root: string, path: string): boolean {
  const normalizedRoot = normalizedRegistryPath(root);
  const normalizedPath = normalizedRegistryPath(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

interface WorkspaceInventory {
  readonly directories: readonly string[];
  readonly manifests: ReadonlyMap<string, PackageManifest>;
  readonly violations: readonly ArchitectureViolation[];
}

interface PackageManifest {
  readonly bin?: unknown;
  readonly dependencies?: unknown;
  readonly exports?: unknown;
  readonly imports?: unknown;
  readonly name?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependencies?: unknown;
}

async function inspectWorkspaceInventory(projectRoot: string): Promise<WorkspaceInventory> {
  const violations: ArchitectureViolation[] = [];
  const rootManifest = parseManifest(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const workspaces = (rootManifest as { readonly workspaces?: unknown }).workspaces;
  if (
    !Array.isArray(workspaces) ||
    workspaces.length !== 2 ||
    workspaces[0] !== "apps/*" ||
    workspaces[1] !== "packages/*"
  ) {
    violations.push(
      violation(
        "workspace-inventory",
        "package.json",
        "Root workspaces must remain the exhaustive ordered registry patterns apps/* and packages/*."
      )
    );
  }

  const directories: string[] = [];
  for (const parent of ["apps", "packages"] as const) {
    const entries = await readdir(resolve(projectRoot, parent), { withFileTypes: true });
    for (const entry of entries) {
      const directory = `${parent}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        violations.push(
          violation(
            "workspace-inventory",
            directory,
            `${directory} is a symbolic link; workspace entries must be real directories.`
          )
        );
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (
        (await pathExists(resolve(projectRoot, directory, "package.json"))) ||
        (await pathExists(resolve(projectRoot, directory, "src")))
      ) {
        directories.push(directory);
      }
    }
  }
  directories.sort();

  const manifests = new Map<string, PackageManifest>();
  for (const directory of directories) {
    const registration = registrationByDirectory.get(directory);
    if (registration === undefined) {
      violations.push(
        violation(
          "unknown-workspace",
          directory,
          `${directory} is not classified in architectureRegistry.`
        )
      );
      continue;
    }
    const manifestPath = `${directory}/package.json`;
    try {
      const manifest = parseManifest(await readFile(resolve(projectRoot, manifestPath), "utf8"));
      manifests.set(directory, manifest);
      if (manifest.name !== registration.packageName) {
        violations.push(
          violation(
            "workspace-inventory",
            manifestPath,
            `${manifestPath} must declare package name ${registration.packageName}.`
          )
        );
      }
      if (manifest.imports !== undefined) {
        violations.push(
          violation(
            "workspace-inventory",
            manifestPath,
            `${manifestPath} must not define package import aliases; production dependencies use statically resolved package or relative imports.`
          )
        );
      }
    } catch (error: unknown) {
      violations.push(
        violation(
          "workspace-inventory",
          manifestPath,
          `${manifestPath} is missing or invalid: ${errorMessage(error)}.`
        )
      );
    }
  }
  for (const registration of architectureRegistry) {
    if (!directories.includes(registration.directory)) {
      violations.push(
        violation(
          "workspace-inventory",
          registration.directory,
          `${registration.directory} is registered but missing from the workspace inventory.`
        )
      );
    }
  }
  return { directories, manifests, violations };
}

async function inspectManifestAgreement(
  projectRoot: string,
  modules: readonly ArchitectureModule[],
  inventory: WorkspaceInventory
): Promise<readonly ArchitectureViolation[]> {
  const violations: ArchitectureViolation[] = [];
  const sourceWorkspaceEdges = new Map<string, Set<string>>();
  const sourceExternalEdges = new Map<string, Set<string>>();
  for (const registration of architectureRegistry) {
    sourceWorkspaceEdges.set(registration.directory, new Set());
    sourceExternalEdges.set(registration.directory, new Set());
  }

  for (const module of modules) {
    const sourceDirectory = workspaceDirectory(module.path);
    if (sourceDirectory === null) continue;
    for (const dependency of module.dependencies) {
      const imported = workspaceImportRegistration(dependency.specifier);
      if (imported !== null && imported.directory !== sourceDirectory) {
        sourceWorkspaceEdges.get(sourceDirectory)?.add(imported.directory);
      } else if (!dependency.local) {
        const capability = externalCapability(dependency.specifier);
        if (capability !== "node:*") sourceExternalEdges.get(sourceDirectory)?.add(capability);
      }
    }
  }

  const manifestEdges = new Map<string, Set<string>>();
  for (const registration of architectureRegistry) {
    const manifestPath = `${registration.directory}/package.json`;
    const manifest = inventory.manifests.get(registration.directory);
    if (manifest === undefined) continue;
    manifestEdges.set(registration.directory, new Set());
    validatePublicEntry(registration, manifest, manifestPath, violations);

    const declared = declaredProductionDependencies(manifest);
    for (const [packageName, imported] of registrationByPackage) {
      if (packageName === registration.packageName) continue;
      const sourceImports =
        sourceWorkspaceEdges.get(registration.directory)?.has(imported.directory) ?? false;
      const manifestDeclares = declared.has(packageName);
      if (sourceImports !== manifestDeclares) {
        violations.push(
          violation(
            "manifest-dependency",
            manifestPath,
            sourceImports
              ? `${manifestPath} must declare source dependency ${packageName}.`
              : `${manifestPath} declares unused workspace dependency ${packageName}.`
          )
        );
      }
      if (manifestDeclares) manifestEdges.get(registration.directory)?.add(imported.directory);
    }

    const sourceExternals = sourceExternalEdges.get(registration.directory) ?? new Set();
    const declaredExternals = new Set(
      [...declared].filter((name) => !registrationByPackage.has(name))
    );
    for (const external of new Set([...sourceExternals, ...declaredExternals])) {
      const sourceImports = sourceExternals.has(external);
      const manifestDeclares = declaredExternals.has(external);
      if (sourceImports !== manifestDeclares) {
        violations.push(
          violation(
            "manifest-dependency",
            manifestPath,
            sourceImports
              ? `${manifestPath} must declare source dependency ${external}.`
              : `${manifestPath} declares unused production dependency ${external}.`
          )
        );
      }
    }
  }

  violations.push(...workspaceCycleViolations(manifestEdges));

  for (const registration of architectureRegistry) {
    for (const path of [
      registration.sourceRoot,
      ...Object.values(registration.publicExports).map(({ source }) => source)
    ]) {
      if (!(await pathExists(resolve(projectRoot, path)))) {
        violations.push(
          violation(
            "workspace-inventory",
            path,
            `${path} is registered architecture source but does not exist.`
          )
        );
      }
    }
  }
  return violations;
}

function validatePublicEntry(
  registration: WorkspaceRegistration,
  manifest: PackageManifest,
  manifestPath: string,
  violations: ArchitectureViolation[]
): void {
  const expectedExports = registration.publicExports;
  if (Object.keys(expectedExports).length > 0) {
    const exportsRecord = asRecord(manifest.exports);
    const actualNames = exportsRecord === null ? [] : Object.keys(exportsRecord).sort();
    const expectedNames = Object.keys(expectedExports).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      violations.push(
        violation(
          "manifest-export",
          manifestPath,
          `${manifestPath} exports must match the registered public entries exactly.`
        )
      );
    }
    for (const [exportName, expected] of Object.entries(expectedExports)) {
      const actual = asRecord(exportsRecord?.[exportName]);
      if (
        actual?.default !== expected.default ||
        actual.types !== expected.types ||
        Object.keys(actual).length !== 2
      ) {
        violations.push(
          violation(
            "manifest-export",
            manifestPath,
            `${manifestPath} export ${exportName} must map exactly to ${expected.default} and ${expected.types}.`
          )
        );
      }
    }
  } else if (manifest.exports !== undefined) {
    violations.push(
      violation(
        "manifest-export",
        manifestPath,
        `${manifestPath} exposes an unregistered package export.`
      )
    );
  }
  if (registration.expectedBin !== undefined) {
    const bin = asRecord(manifest.bin);
    if (JSON.stringify(bin) !== JSON.stringify(registration.expectedBin)) {
      violations.push(
        violation(
          "manifest-export",
          manifestPath,
          `${manifestPath} binary entry does not match architectureRegistry.`
        )
      );
    }
  }
}

function declaredProductionDependencies(manifest: PackageManifest): ReadonlySet<string> {
  const names = new Set<string>();
  for (const field of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies
  ]) {
    const record = asRecord(field);
    if (record !== null) for (const name of Object.keys(record)) names.add(name);
  }
  return names;
}

function workspaceDirectory(path: string): string | null {
  const parts = path.split("/");
  if ((parts[0] === "apps" || parts[0] === "packages") && parts[1] !== undefined) {
    return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

async function findSourceFiles(projectRoot: string, sourceRoot: string): Promise<string[]> {
  const absoluteRoot = resolve(projectRoot, sourceRoot);
  const rootMetadata = await lstat(absoluteRoot);
  if (rootMetadata.isSymbolicLink()) {
    throw new Error(`${sourceRoot} is a symbolic link; production source links are forbidden`);
  }
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(absoluteRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${projectRelative(projectRoot, absolutePath)} is a symbolic link; production source links are forbidden`
      );
    }
    if (entry.isDirectory()) {
      paths.push(
        ...(await findSourceFiles(projectRoot, projectRelative(projectRoot, absolutePath)))
      );
      continue;
    }
    if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) {
      paths.push(projectRelative(projectRoot, absolutePath));
    }
  }
  return paths;
}

interface ExtractedDependencies {
  readonly dependencies: readonly Omit<ArchitectureDependency, "local" | "target">[];
  readonly violations: readonly ArchitectureViolation[];
}

function extractModuleSpecifiers(
  path: string,
  source: string,
  programSourceFile?: ts.SourceFile,
  checker?: ts.TypeChecker
): ExtractedDependencies {
  const sourceFile =
    programSourceFile ??
    ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
  const dependencies: Omit<ArchitectureDependency, "local" | "target">[] = [];
  const parseDiagnostics =
    (sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  const violations: ArchitectureViolation[] = parseDiagnostics.map((diagnostic) => {
    const location = sourceLocation(sourceFile, diagnostic.start ?? 0);
    return violation(
      "parse-error",
      path,
      `${path}:${String(location.line)}:${String(location.column)} cannot be parsed: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`
    );
  });

  const addAt = (specifier: string, position: number): void => {
    const location = sourceLocation(sourceFile, position);
    dependencies.push({ specifier, line: location.line, column: location.column });
  };
  const add = (specifier: string, node: ts.Node): void => {
    addAt(specifier, node.getStart(sourceFile));
  };
  const unsupported = (node: ts.Node, form: string): void => {
    const location = sourceLocation(sourceFile, node.getStart(sourceFile));
    violations.push(
      violation(
        "unsupported-import",
        path,
        `${path}:${String(location.line)}:${String(location.column)} uses unsupported ${form}; architecture dependencies must be statically enumerable.`
      )
    );
  };
  for (const reference of sourceFile.referencedFiles) {
    addAt(
      reference.fileName.startsWith(".") ? reference.fileName : `./${reference.fileName}`,
      reference.pos
    );
  }
  for (const reference of sourceFile.typeReferenceDirectives) {
    addAt(reference.fileName === "node" ? "node:types" : reference.fileName, reference.pos);
  }
  for (const reference of sourceFile.libReferenceDirectives) {
    addAt(`lib:${reference.fileName}`, reference.pos);
  }

  const sourceLayer = architectureLayer(path);
  const enforceInnerGlobals =
    sourceLayer === "contracts" ||
    sourceLayer === "runtime-domain" ||
    sourceLayer === "runtime-application";
  const reportedGlobals = new Set<number>();

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        add(node.moduleSpecifier.text, node.moduleSpecifier);
        if (isRuntimeCodeGenerationModule(node.moduleSpecifier.text)) {
          unsupported(node, "runtime loader or code-generation module");
        }
      } else unsupported(node, "non-literal module specifier");
    } else if (ts.isImportEqualsDeclaration(node)) {
      unsupported(node, "import-equals declaration");
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      add(node.name.text, node.name);
    } else if (ts.isImportTypeNode(node)) {
      const { argument } = node;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        add(argument.literal.text, argument.literal);
      } else {
        unsupported(node, "non-literal import type");
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (node.arguments.length === 1 && argument !== undefined && ts.isStringLiteral(argument)) {
        add(argument.text, argument);
        if (isRuntimeCodeGenerationModule(argument.text)) {
          unsupported(node, "dynamic runtime loader or code-generation module acquisition");
        }
      } else {
        unsupported(node, "non-literal dynamic import");
      }
    }
    if (
      ts.isIdentifier(node) &&
      forbiddenDynamicRuntimeIdentifiers.has(node.text) &&
      !isRuntimeDeclaredInSource(node, sourceFile, checker) &&
      isRuntimeIdentifierReference(node)
    ) {
      unsupported(node, `runtime loader or code-generation reference ${node.text}`);
    }
    if (isGlobalDynamicRuntimeProperty(node, sourceFile, checker)) {
      unsupported(node, "global runtime loader or code-generation property");
    }
    if (isAmbiguousGlobalRuntimeAlias(node, sourceFile, checker)) {
      unsupported(node, "aliased runtime loader-capable global");
    }
    if (isProcessModuleLoader(node, sourceFile, checker)) {
      unsupported(node, "process.getBuiltinModule CommonJS loader");
    }
    if (isReflectiveCodeGenerationAccess(node, sourceFile, checker)) {
      unsupported(node, "reflective runtime code-generation access");
    }
    if (
      enforceInnerGlobals &&
      ts.isIdentifier(node) &&
      node.text === "Math" &&
      isMathRandomCapability(node, checker) &&
      !isRuntimeDeclaredInSource(node, sourceFile, checker)
    ) {
      const location = sourceLocation(sourceFile, node.getStart(sourceFile));
      violations.push(
        violation(
          "external-capability",
          path,
          `${path}:${String(location.line)}:${String(location.column)} uses runtime global Math.random, which is not allowed in ${sourceLayer}.`
        )
      );
    }
    if (
      enforceInnerGlobals &&
      ts.isIdentifier(node) &&
      forbiddenInnerRuntimeGlobals.has(node.text) &&
      !isRuntimeDeclaredInSource(node, sourceFile, checker) &&
      isRuntimeIdentifierReference(node) &&
      !reportedGlobals.has(node.getStart(sourceFile))
    ) {
      const location = sourceLocation(sourceFile, node.getStart(sourceFile));
      reportedGlobals.add(node.getStart(sourceFile));
      violations.push(
        violation(
          "external-capability",
          path,
          `${path}:${String(location.line)}:${String(location.column)} uses runtime global ${node.text}, which is not allowed in ${sourceLayer}.`
        )
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { dependencies, violations };
}

function isRuntimeDeclaredInSource(
  node: ts.Identifier,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined
): boolean {
  if (checker === undefined) return false;
  const symbol = checker.getSymbolAtLocation(node);
  return (
    symbol?.declarations?.some((declaration) => {
      if (declaration.getSourceFile().fileName !== sourceFile.fileName) return false;
      if (declaration.getSourceFile().isDeclarationFile) return false;
      return isRuntimeDeclaration(declaration);
    }) ?? false
  );
}

function isRuntimeDeclaration(node: ts.Node): boolean {
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isTypeParameterDeclaration(node)
  ) {
    return false;
  }
  if (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.DeclareKeyword) === true
  ) {
    return false;
  }
  if (ts.isImportClause(node) && node.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
  if (ts.isImportSpecifier(node) && node.isTypeOnly) return false;
  if (ts.isSourceFile(node)) return true;
  return isRuntimeDeclaration(node.parent);
}

function isMathRandomCapability(node: ts.Identifier, checker: ts.TypeChecker | undefined): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return parent.name.text === "random";
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    const property = constantPropertyName(parent.argumentExpression, checker);
    return property === null || property === "random";
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    return bindingMaySelectProperty(parent.name, "random", checker);
  }
  // Passing or aliasing the Math object would make later random access invisible to this graph.
  return isRuntimeIdentifierReference(node);
}

function isGlobalDynamicRuntimeProperty(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined
): boolean {
  if (
    ts.isElementAccessExpression(node) &&
    constantPropertyName(node.argumentExpression, checker) === null &&
    isUnshadowedGlobalIdentifier(node.expression, ["global", "globalThis"], sourceFile, checker)
  ) {
    return true;
  }
  const access = propertyAccessParts(node, checker);
  if (access === null || !forbiddenDynamicRuntimeIdentifiers.has(access.property)) return false;
  return isUnshadowedGlobalIdentifier(
    access.expression,
    ["global", "globalThis"],
    sourceFile,
    checker
  );
}

function isAmbiguousGlobalRuntimeAlias(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined
): boolean {
  if (
    !ts.isIdentifier(node) ||
    !["global", "globalThis", "Object", "process", "Reflect"].includes(node.text) ||
    isRuntimeDeclaredInSource(node, sourceFile, checker) ||
    !isRuntimeIdentifierReference(node)
  ) {
    return false;
  }
  const parent = node.parent;
  return !(
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

function isProcessModuleLoader(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined
): boolean {
  if (
    ts.isElementAccessExpression(node) &&
    constantPropertyName(node.argumentExpression, checker) === null &&
    isUnshadowedGlobalIdentifier(node.expression, ["process"], sourceFile, checker)
  ) {
    return true;
  }
  const access = propertyAccessParts(node, checker);
  if (access?.property !== "getBuiltinModule") return false;
  if (isUnshadowedGlobalIdentifier(access.expression, ["process"], sourceFile, checker)) {
    return true;
  }
  return (
    checker?.getTypeAtLocation(access.expression).getProperty("getBuiltinModule") !== undefined
  );
}

function isReflectiveCodeGenerationAccess(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined
): boolean {
  if (ts.isBindingElement(node) && bindingElementPropertyName(node, checker) === "constructor") {
    return true;
  }
  const access = propertyAccessParts(node, checker);
  if (access?.property === "constructor") return true;
  if (
    access?.property === "get" &&
    isUnshadowedGlobalIdentifier(access.expression, ["Reflect"], sourceFile, checker)
  ) {
    return true;
  }
  if (
    access !== null &&
    [
      "getOwnPropertyDescriptor",
      "getOwnPropertyDescriptors",
      "getOwnPropertyNames",
      "getPrototypeOf"
    ].includes(access.property) &&
    isUnshadowedGlobalIdentifier(access.expression, ["Object"], sourceFile, checker)
  ) {
    return true;
  }
  return (
    ts.isElementAccessExpression(node) &&
    constantPropertyName(node.argumentExpression, checker) === null &&
    (isPossiblyCallable(node.expression, checker) ||
      isUnshadowedGlobalIdentifier(node.expression, ["Object", "Reflect"], sourceFile, checker))
  );
}

function bindingElementPropertyName(
  element: ts.BindingElement,
  checker: ts.TypeChecker | undefined
): string | null {
  if (element.dotDotDotToken !== undefined) return null;
  if (element.propertyName === undefined) {
    return ts.isIdentifier(element.name) ? element.name.text : null;
  }
  if (ts.isComputedPropertyName(element.propertyName)) {
    return constantPropertyName(element.propertyName.expression, checker);
  }
  return element.propertyName.text;
}

function propertyAccessParts(
  node: ts.Node,
  checker: ts.TypeChecker | undefined
): { readonly expression: ts.Expression; readonly property: string } | null {
  if (ts.isPropertyAccessExpression(node)) {
    return { expression: node.expression, property: node.name.text };
  }
  if (ts.isElementAccessExpression(node)) {
    const property = constantPropertyName(node.argumentExpression, checker);
    if (property !== null) return { expression: node.expression, property };
  }
  return null;
}

function constantPropertyName(
  expression: ts.Expression,
  checker: ts.TypeChecker | undefined
): string | null {
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
    return expression.text;
  }
  const type = checker?.getTypeAtLocation(expression);
  return type?.isStringLiteral() === true ? type.value : null;
}

function bindingMaySelectProperty(
  name: ts.BindingName,
  expected: string,
  checker: ts.TypeChecker | undefined
): boolean {
  if (ts.isIdentifier(name) || ts.isArrayBindingPattern(name)) return true;
  return name.elements.some((element) => {
    if (ts.isOmittedExpression(element) || element.dotDotDotToken !== undefined) {
      return !ts.isOmittedExpression(element);
    }
    if (element.propertyName === undefined) {
      return !ts.isIdentifier(element.name) || element.name.text === expected;
    }
    if (ts.isComputedPropertyName(element.propertyName)) {
      const property = constantPropertyName(element.propertyName.expression, checker);
      return property === null || property === expected;
    }
    return (
      (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)) &&
      element.propertyName.text === expected
    );
  });
}

function isUnshadowedGlobalIdentifier(
  expression: ts.Expression,
  names: readonly string[],
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined
): expression is ts.Identifier {
  return (
    ts.isIdentifier(expression) &&
    names.includes(expression.text) &&
    !isRuntimeDeclaredInSource(expression, sourceFile, checker)
  );
}

function isPossiblyCallable(
  expression: ts.Expression,
  checker: ts.TypeChecker | undefined
): boolean {
  if (
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isFunctionDeclaration(expression)
  ) {
    return true;
  }
  if (checker === undefined) return false;
  const type = checker.getTypeAtLocation(expression);
  return (
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  );
}

function isRuntimeCodeGenerationModule(specifier: string): boolean {
  return (
    specifier === "module" ||
    specifier === "node:module" ||
    specifier === "vm" ||
    specifier === "node:vm"
  );
}

function isRuntimeIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isBindingElement(parent)) &&
      parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isExportSpecifier(parent) && parent.name === node) ||
    (ts.isLabeledStatement(parent) && parent.label === node) ||
    (ts.isBreakOrContinueStatement(parent) && parent.label === node)
  ) {
    return false;
  }
  for (let current: ts.Node = node; ; current = current.parent) {
    if (ts.isTypeNode(current)) return false;
    if (ts.isStatement(current) || ts.isSourceFile(current)) break;
  }
  return true;
}

function resolveDependency(
  projectRoot: string,
  sourcePath: string,
  specifier: string,
  sourcePaths: ReadonlySet<string>
): Pick<ArchitectureDependency, "local" | "target"> {
  const packageEntry = packageEntries.get(specifier);
  if (packageEntry !== undefined) return { local: true, target: packageEntry };
  if (workspaceImportRegistration(specifier) !== null) return { local: true, target: null };
  if (!specifier.startsWith(".")) return { local: false, target: null };

  const unresolvedPath = projectRelative(
    projectRoot,
    resolve(projectRoot, dirname(sourcePath), specifier)
  );
  const target = resolutionCandidates(unresolvedPath).find((candidate) =>
    sourcePaths.has(candidate)
  );
  return { local: true, target: target ?? null };
}

function resolutionCandidates(path: string): readonly string[] {
  const extension = extname(path);
  const withoutExtension = extension === "" ? path : path.slice(0, -extension.length);
  const direct = [".js", ".jsx", ".mjs", ".cjs"].includes(extension) ? withoutExtension : path;
  return [
    path,
    `${direct}.ts`,
    `${direct}.tsx`,
    `${direct}.mts`,
    `${direct}.cts`,
    `${direct}.d.ts`,
    `${direct}.d.mts`,
    `${direct}.d.cts`,
    `${path}/index.ts`,
    `${path}/index.tsx`,
    `${path}/index.mts`,
    `${path}/index.cts`,
    `${path}/index.d.ts`,
    `${path}/index.d.mts`,
    `${path}/index.d.cts`
  ];
}

function projectRelative(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join("/");
}

function workspaceImportRegistration(specifier: string): WorkspaceRegistration | null {
  for (const registration of architectureRegistry) {
    if (
      specifier === registration.packageName ||
      specifier.startsWith(`${registration.packageName}/`)
    ) {
      return registration;
    }
  }
  return null;
}

function packageSpecifier(packageName: string, exportName: string): string {
  return exportName === "." ? packageName : `${packageName}${exportName.slice(1)}`;
}

function externalCapability(specifier: string): string {
  if (specifier.startsWith("node:")) return "node:*";
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function dependencyLocation(path: string, dependency: ArchitectureDependency): string {
  return dependency.line === undefined || dependency.column === undefined
    ? path
    : `${path}:${String(dependency.line)}:${String(dependency.column)}`;
}

function sourceLocation(
  sourceFile: ts.SourceFile,
  position: number
): { line: number; column: number } {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function cycleViolations(
  modules: readonly ArchitectureModule[],
  moduleByPath: ReadonlyMap<string, ArchitectureModule>
): readonly ArchitectureViolation[] {
  const adjacency = new Map(
    modules.map((module) => [
      module.path,
      module.dependencies.flatMap(({ target }) =>
        target !== null && moduleByPath.has(target) ? [target] : []
      )
    ])
  );
  return graphCycleViolations(adjacency, "Circular source dependency");
}

function workspaceCycleViolations(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>
): readonly ArchitectureViolation[] {
  return graphCycleViolations(
    new Map([...adjacency].map(([source, targets]) => [source, [...targets]])),
    "Circular workspace manifest dependency"
  ).map((entry) => ({ ...entry, kind: "manifest-dependency" as const }));
}

function graphCycleViolations(
  adjacency: ReadonlyMap<string, readonly string[]>,
  label: string
): readonly ArchitectureViolation[] {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const reported = new Set<string>();
  const violations: ArchitectureViolation[] = [];

  const visit = (path: string): void => {
    state.set(path, "visiting");
    stack.push(path);
    for (const target of [...(adjacency.get(path) ?? [])].sort()) {
      if (!adjacency.has(target)) continue;
      const targetState = state.get(target);
      if (targetState === undefined) visit(target);
      else if (targetState === "visiting") {
        const start = stack.lastIndexOf(target);
        const cycle = [...stack.slice(start), target];
        const canonical = canonicalCycle(cycle);
        if (!reported.has(canonical)) {
          reported.add(canonical);
          violations.push({
            kind: "cycle",
            source: cycle[0] ?? path,
            target,
            message: `${label}: ${cycle.join(" -> ")}.`
          });
        }
      }
    }
    stack.pop();
    state.set(path, "visited");
  };
  for (const path of [...adjacency.keys()].sort()) if (state.get(path) === undefined) visit(path);
  return violations;
}

function canonicalCycle(cycle: readonly string[]): string {
  const members = cycle.slice(0, -1);
  if (members.length === 0) return "";
  return (
    members
      .map((_member, index) => [...members.slice(index), ...members.slice(0, index)].join("\0"))
      .sort()[0] ?? ""
  );
}

function parseManifest(source: string): PackageManifest & { readonly workspaces?: unknown } {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("manifest root must be an object");
  }
  return value;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function violation(
  kind: ArchitectureViolationKind,
  source: string,
  message: string
): ArchitectureViolation {
  return { kind, source, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortViolations(
  violations: readonly ArchitectureViolation[]
): readonly ArchitectureViolation[] {
  return [...violations].sort((left, right) =>
    [left.kind, left.source, left.target ?? "", left.message]
      .join("\0")
      .localeCompare([right.kind, right.source, right.target ?? "", right.message].join("\0"))
  );
}
