import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  architectureReport,
  inspectArchitecture,
  sourceRootRegistrationOverlaps,
  type ArchitectureDependency,
  type ArchitectureModule
} from "../../scripts/architecture-rules.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("architecture dependency rules", () => {
  it("accepts the repository source graph", async () => {
    const report = await inspectArchitecture(projectRoot);

    expect(report.violations).toEqual([]);
  });

  it("allows application and infrastructure adapters to depend inward on domain ports", () => {
    const report = architectureReport([
      source("packages/runtime/src/domain/port.ts"),
      source("packages/runtime/src/application/use-case.ts", [
        local("../domain/port.js", "packages/runtime/src/domain/port.ts")
      ]),
      source("packages/runtime/src/infrastructure/adapter.ts", [
        local("../domain/port.js", "packages/runtime/src/domain/port.ts")
      ])
    ]);

    expect(report.violations).toEqual([]);
  });

  it("rejects outward dependencies from domain and application layers", () => {
    const report = architectureReport([
      source("packages/runtime/src/domain/model.ts", [
        local("../infrastructure/sqlite.js", "packages/runtime/src/infrastructure/sqlite.ts")
      ]),
      source("packages/runtime/src/application/use-case.ts", [
        local("../infrastructure/sqlite.js", "packages/runtime/src/infrastructure/sqlite.ts")
      ]),
      source("packages/runtime/src/infrastructure/sqlite.ts")
    ]);

    expect(report.violations.filter(({ kind }) => kind === "layer-dependency")).toHaveLength(2);
  });

  it("requires package consumers to use declared public entry points", () => {
    const report = architectureReport([
      source("apps/tui/src/view.ts", [
        local(
          "../../../packages/runtime/src/domain/model.js",
          "packages/runtime/src/domain/model.ts"
        ),
        local("@agentlab/runtime/domain", null)
      ]),
      source("packages/runtime/src/domain/model.ts")
    ]);

    expect(report.violations.map(({ kind }) => kind)).toEqual([
      "deep-package-import",
      "layer-dependency",
      "relative-package-import"
    ]);
  });

  it("resolves each explicitly registered public package subpath", () => {
    const report = architectureReport([
      source("apps/tui/src/factory-ports.ts", [
        local("@agentlab/runtime/factory-broker", "packages/runtime/src/local-factory-broker.ts"),
        local("@agentlab/runtime/factory-worker", "packages/runtime/src/local-factory-worker.ts")
      ]),
      source("packages/runtime/src/local-factory-broker.ts"),
      source("packages/runtime/src/local-factory-worker.ts")
    ]);

    expect(report.violations).toEqual([]);
  });

  it("keeps authority and model-bearing composition closures separate", () => {
    const report = architectureReport([
      source("packages/runtime/src/local-factory-broker.ts", [
        local("./application/bridge.js", "packages/runtime/src/application/bridge.ts")
      ]),
      source("packages/runtime/src/application/bridge.ts", [
        local(
          "../infrastructure/providers/model.js",
          "packages/runtime/src/infrastructure/providers/model.ts"
        )
      ]),
      source("packages/runtime/src/infrastructure/providers/model.ts"),
      source("packages/runtime/src/local-runtime.ts", [
        local(
          "./infrastructure/github/authority.js",
          "packages/runtime/src/infrastructure/github/authority.ts"
        )
      ]),
      source("packages/runtime/src/infrastructure/github/authority.ts"),
      source("packages/runtime/src/local-factory-worker.ts", [
        local("./application/worker.js", "packages/runtime/src/application/worker.ts")
      ]),
      source("packages/runtime/src/application/worker.ts", [
        local(
          "../infrastructure/providers/catalog-factory-agent-provider-resolver.js",
          "packages/runtime/src/infrastructure/providers/catalog-factory-agent-provider-resolver.ts"
        ),
        local(
          "../infrastructure/github/authority.js",
          "packages/runtime/src/infrastructure/github/authority.ts"
        )
      ]),
      source(
        "packages/runtime/src/infrastructure/providers/catalog-factory-agent-provider-resolver.ts"
      ),
      source("apps/tui/src/run-factory-broker-open-draft.ts", [
        local("@agentlab/runtime/factory-worker", "packages/runtime/src/local-factory-worker.ts")
      ]),
      source("apps/tui/src/run-factory-worker-preflight.ts", [
        local("@agentlab/runtime/factory-broker", "packages/runtime/src/local-factory-broker.ts")
      ])
    ]);

    const violations = report.violations.filter(({ kind }) => kind === "composition-boundary");
    expect(violations).toHaveLength(6);
    expect(violations.map(({ message }) => message).join("\n")).toContain(
      "application/bridge.ts -> packages/runtime/src/infrastructure/providers/model.ts"
    );
    expect(violations.map(({ target }) => target)).toContain(
      "packages/runtime/src/infrastructure/github/authority.ts"
    );
    expect(violations.map(({ target }) => target)).toContain(
      "packages/runtime/src/infrastructure/providers/catalog-factory-agent-provider-resolver.ts"
    );
    expect(
      violations.filter(({ source }) => source === "packages/runtime/src/local-factory-worker.ts")
    ).toHaveLength(2);
    expect(violations.map(({ source }) => source)).toContain(
      "apps/tui/src/run-factory-broker-open-draft.ts"
    );
    expect(violations.map(({ source }) => source)).toContain(
      "apps/tui/src/run-factory-worker-preflight.ts"
    );
  });

  it("detects cycles and unresolved local imports", () => {
    const report = architectureReport([
      source("packages/contracts/src/left.ts", [
        local("./right.js", "packages/contracts/src/right.ts")
      ]),
      source("packages/contracts/src/right.ts", [
        local("./left.js", "packages/contracts/src/left.ts"),
        local("./missing.js", null)
      ])
    ]);

    expect(report.violations.map(({ kind }) => kind)).toEqual(["cycle", "unresolved-local-import"]);
  });

  it("rejects source modules outside every declared layer", () => {
    const report = architectureReport([source("packages/runtime/src/miscellaneous.ts")]);

    expect(report.violations.map(({ kind }) => kind)).toEqual(["unclassified-module"]);
  });

  it("fails closed on an unregistered workspace", async () => {
    const root = architectureFixture();
    writeJson(root, "packages/rogue/package.json", { name: "@agentlab/rogue" });
    write(root, "packages/rogue/src/index.ts", "export {};\n");

    const report = await inspectArchitecture(root);

    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "unknown-workspace", source: "packages/rogue" })
    ]);
  });

  it("extracts static import types and rejects dependency forms that evade the graph", async () => {
    const root = architectureFixture();
    write(
      root,
      "packages/runtime/src/domain/unsafe.ts",
      [
        'type Public = import("@agentlab/contracts").Conversation;',
        'const target = "./hidden.js";',
        "void import(target);",
        'require.resolve("./also-hidden.js");',
        "void (null as Public | null);",
        ""
      ].join("\n")
    );

    const report = await inspectArchitecture(root);

    expect(report.violations.filter(({ kind }) => kind === "unsupported-import")).toHaveLength(2);
    expect(report.dependencyCount).toBe(1);
  });

  it("enumerates reference directives and string-literal module augmentations", async () => {
    const root = architectureFixture();
    write(root, "packages/runtime/src/infrastructure/outer.ts", "export interface Outer {}\n");
    write(
      root,
      "packages/runtime/src/domain/references.ts",
      [
        '/// <reference path="../infrastructure/outer.ts" />',
        '/// <reference types="node" />',
        'declare module "../infrastructure/outer.js" { interface Outer { unsafe: true } }',
        "export {};",
        ""
      ].join("\n")
    );

    const report = await inspectArchitecture(root);

    expect(report.violations.filter(({ kind }) => kind === "layer-dependency")).toHaveLength(2);
    expect(report.violations.map(({ kind }) => kind)).toContain("external-capability");
  });

  it("scans declaration modules across every supported TypeScript declaration extension", async () => {
    const root = architectureFixture();
    workspaceTsconfig(root, "packages/runtime", ["src/**/*.ts", "src/**/*.mts", "src/**/*.cts"]);
    write(root, "packages/runtime/src/infrastructure/outer.ts", "export interface Outer {}\n");
    for (const extension of ["d.ts", "d.mts", "d.cts"] as const) {
      write(
        root,
        `packages/runtime/src/domain/unsafe.${extension}`,
        [
          '/// <reference path="../infrastructure/outer.ts" />',
          'declare module "../infrastructure/outer.js" { interface Outer { unsafe: true } }',
          "export {};",
          ""
        ].join("\n")
      );
    }

    const report = await inspectArchitecture(root);

    expect(report.violations.filter(({ kind }) => kind === "layer-dependency")).toHaveLength(6);
    expect(report.moduleCount).toBeGreaterThanOrEqual(8);
  });

  it("rejects outward runtime globals in inner layers", async () => {
    const root = architectureFixture();
    write(
      root,
      "packages/runtime/src/domain/globals.ts",
      [
        "setTimeout(() => undefined, 1);",
        "void process.env;",
        'void Bun.spawn(["true"]);',
        "void Date.now();",
        ""
      ].join("\n")
    );

    const report = await inspectArchitecture(root);
    const globals = report.violations.filter(({ kind }) => kind === "external-capability");

    expect(globals).toHaveLength(4);
    expect(globals.map(({ message }) => message).join("\n")).toContain("runtime global setTimeout");
  });

  it("rejects Math.random and ambient declarations that pretend to shadow globals", async () => {
    const root = architectureFixture();
    write(
      root,
      "packages/runtime/src/domain/ambient.ts",
      [
        "declare const process: { env: unknown };",
        "void process.env;",
        "void Math.random();",
        "const { random: randomValue } = Math;",
        "void randomValue;",
        ""
      ].join("\n")
    );

    const report = await inspectArchitecture(root);
    const messages = report.violations
      .filter(({ kind }) => kind === "external-capability")
      .map(({ message }) => message);

    expect(messages).toHaveLength(3);
    expect(messages.join("\n")).toContain("runtime global process");
    expect(messages.filter((message) => message.includes("Math.random"))).toHaveLength(2);
  });

  it("rejects aliased and computed CommonJS loaders plus runtime code generation", async () => {
    const root = architectureFixture();
    write(
      root,
      "packages/runtime/src/infrastructure/loaders.ts",
      [
        "const load = require;",
        'const wrapped = module["require"];',
        "const indirectEval = eval;",
        "const DynamicFunction = Function;",
        'const globalLoader = globalThis["require"];',
        'const builtinLoader = process.getBuiltinModule("module");',
        "void [load, wrapped, indirectEval, DynamicFunction, globalLoader, builtinLoader];",
        ""
      ].join("\n")
    );

    const report = await inspectArchitecture(root);

    expect(report.violations.filter(({ kind }) => kind === "unsupported-import")).toHaveLength(6);
  });

  it("fails closed on computed randomness and reflective loader acquisition", async () => {
    const root = architectureFixture();
    write(
      root,
      "packages/runtime/src/domain/computed-random.ts",
      ['const key = "random" as const;', "void Math[key]();", ""].join("\n")
    );
    write(
      root,
      "packages/runtime/src/infrastructure/reflective-loaders.ts",
      [
        'const builtin = "module" as const;',
        "const load = process.getBuiltinModule(builtin).createRequire(import.meta.url);",
        'void load("../application/secret.js");',
        "const generate = (() => undefined).constructor;",
        "void generate('return import(\"../application/secret.js\")')();",
        'void import("node:module");',
        ""
      ].join("\n")
    );

    const report = await inspectArchitecture(root);
    const unsupported = report.violations.filter(({ kind }) => kind === "unsupported-import");

    expect(
      report.violations.filter(
        ({ kind, message }) => kind === "external-capability" && message.includes("Math.random")
      )
    ).toHaveLength(1);
    expect(unsupported.map(({ message }) => message).join("\n")).toContain(
      "process.getBuiltinModule"
    );
    expect(unsupported.map(({ message }) => message).join("\n")).toContain(
      "reflective runtime code-generation"
    );
    expect(unsupported.map(({ message }) => message).join("\n")).toContain(
      "dynamic runtime loader or code-generation module"
    );
  });

  it("rejects constructor extraction through a callable destructuring binding", async () => {
    const root = architectureFixture();
    write(
      root,
      "packages/runtime/src/infrastructure/destructured-constructor.ts",
      [
        "const { constructor: generate } = (() => undefined);",
        "void generate('return import(\"../application/secret.js\")')();",
        ""
      ].join("\n")
    );

    const report = await inspectArchitecture(root);

    expect(report.violations).toContainEqual(
      expect.objectContaining({
        kind: "unsupported-import",
        message: expect.stringContaining("reflective runtime code-generation access")
      })
    );
  });

  it("rejects computed Reflect access and node:vm code generation", async () => {
    const root = architectureFixture();
    write(
      root,
      "packages/runtime/src/infrastructure/computed-reflect.ts",
      [
        'const parts: readonly string[] = ["g", "et"];',
        'const key = parts.join("") as keyof typeof Reflect;',
        "const get = Reflect[key] as typeof Reflect.get;",
        'const generate = get(() => undefined, "constructor") as (source: string) => unknown;',
        "void generate('return import(\"../application/secret.js\")')();",
        ""
      ].join("\n")
    );
    write(
      root,
      "packages/runtime/src/infrastructure/vm-generation.ts",
      [
        'import { runInThisContext } from "node:vm";',
        'const generate = runInThisContext("(source) => import(source)") as (',
        "  source: string",
        ") => Promise<unknown>;",
        'void generate("../application/secret.js");',
        ""
      ].join("\n")
    );

    const report = await inspectArchitecture(root);
    const unsupported = report.violations.filter(({ kind }) => kind === "unsupported-import");

    expect(unsupported).toHaveLength(2);
    expect(unsupported.map(({ message }) => message).join("\n")).toContain(
      "reflective runtime code-generation access"
    );
    expect(unsupported.map(({ message }) => message).join("\n")).toContain(
      "runtime loader or code-generation module"
    );
  });

  it("rejects tsconfig and package import aliases before they can cross a layer", async () => {
    const root = architectureFixture();
    writeJson(root, "packages/runtime/tsconfig.json", {
      extends: "../../tsconfig.base.json",
      compilerOptions: {
        rootDir: "src",
        baseUrl: ".",
        paths: { zod: ["src/infrastructure/outer.ts"] }
      },
      include: ["src/**/*.ts"]
    });
    writeJson(root, "packages/runtime/package.json", {
      name: "@agentlab/runtime",
      imports: { "#outer": "./src/infrastructure/outer.ts" },
      exports: { ".": { default: "./dist/local-runtime.js", types: "./dist/local-runtime.d.ts" } }
    });
    write(root, "packages/runtime/src/infrastructure/outer.ts", "export interface Outer {}\n");
    write(
      root,
      "packages/runtime/src/domain/alias.ts",
      'import type { Outer } from "zod";\nvoid (null as Outer | null);\n'
    );

    const report = await inspectArchitecture(root);
    const messages = report.violations.map(({ message }) => message).join("\n");

    expect(messages).toContain("must not configure baseUrl");
    expect(messages).toContain("must not configure paths");
    expect(messages).toContain("must not define package import aliases");
  });

  it("rejects production files compiled outside their registered source root", async () => {
    const root = architectureFixture();
    writeJson(root, "packages/runtime/tsconfig.json", {
      extends: "../../tsconfig.base.json",
      compilerOptions: { rootDir: "." },
      include: ["src/**/*.ts", "generated/**/*.ts"]
    });
    write(root, "packages/runtime/generated/escape.ts", "export {};\n");

    const report = await inspectArchitecture(root);
    const messages = report.violations.map(({ message }) => message).join("\n");

    expect(messages).toContain("rootDir must resolve exactly");
    expect(messages).toContain("outside registered root packages/runtime/src");
    expect(messages).toContain("belongs to 0 registered source roots");
  });

  it("detects overlapping source-root registrations independently of file order", () => {
    expect(
      sourceRootRegistrationOverlaps([
        { directory: "packages/runtime", sourceRoot: "packages/runtime/src" },
        { directory: "packages/runtime-domain", sourceRoot: "packages/runtime/src/domain" },
        { directory: "packages/contracts", sourceRoot: "packages/contracts/src" }
      ])
    ).toEqual([["packages/runtime", "packages/runtime-domain"]]);
  });

  it("rejects symbolic links anywhere in a registered production source root", async () => {
    const root = architectureFixture();
    write(root, "packages/contracts/src/private.ts", "export interface Private {}\n");
    const link = join(root, "packages/runtime/src/domain/private.ts");
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync("../../../contracts/src/private.ts", link);

    const report = await inspectArchitecture(root);

    expect(report.violations).toContainEqual(
      expect.objectContaining({
        kind: "workspace-inventory",
        message: expect.stringContaining("production source links are forbidden")
      })
    );
  });

  it("rejects symbolic links masquerading as workspace directories", async () => {
    const root = architectureFixture();
    writeJson(root, "rogue-target/package.json", { name: "@agentlab/rogue" });
    write(root, "rogue-target/src/index.ts", "export {};\n");
    symlinkSync("../rogue-target", join(root, "packages/rogue"));

    const report = await inspectArchitecture(root);

    expect(report.violations).toContainEqual(
      expect.objectContaining({
        kind: "workspace-inventory",
        source: "packages/rogue",
        message: expect.stringContaining("workspace entries must be real directories")
      })
    );
  });

  it("enforces external capabilities, manifest agreement, and exact public exports", async () => {
    const root = architectureFixture();
    write(
      root,
      "packages/runtime/src/domain/unsafe.ts",
      'import { readFile } from "node:fs/promises";\nvoid readFile;\n'
    );
    writeJson(root, "apps/tui/package.json", {
      name: "@agentlab/tui",
      dependencies: { "@agentlab/runtime": "0.0.0" }
    });
    writeJson(root, "packages/contracts/package.json", {
      name: "@agentlab/contracts",
      exports: { ".": { default: "./wrong.js", types: "./wrong.d.ts" } }
    });

    const report = await inspectArchitecture(root);
    const kinds = report.violations.map(({ kind }) => kind);

    expect(kinds).toContain("external-capability");
    expect(kinds).toContain("manifest-dependency");
    expect(kinds).toContain("manifest-export");
  });

  it("reports a traversable source-cycle path", async () => {
    const root = architectureFixture();
    write(root, "packages/contracts/src/left.ts", 'export * from "./right.js";\n');
    write(root, "packages/contracts/src/right.ts", 'export * from "./left.js";\n');

    const report = await inspectArchitecture(root);
    const cycle = report.violations.find(({ kind }) => kind === "cycle");

    expect(cycle?.message).toContain(
      "packages/contracts/src/left.ts -> packages/contracts/src/right.ts -> packages/contracts/src/left.ts"
    );
  });
});

function architectureFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-architecture-"));
  temporaryRoots.push(root);
  writeJson(root, "package.json", { workspaces: ["apps/*", "packages/*"] });
  writeJson(root, "tsconfig.base.json", {
    compilerOptions: {
      allowJs: false,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      target: "ES2023"
    }
  });
  writeJson(root, "apps/tui/package.json", { name: "@agentlab/tui" });
  workspaceTsconfig(root, "apps/tui", ["src/**/*.ts", "src/**/*.tsx"]);
  write(root, "apps/tui/src/main.tsx", "export {};\n");
  writeJson(root, "packages/contracts/package.json", {
    name: "@agentlab/contracts",
    exports: { ".": { default: "./dist/index.js", types: "./dist/index.d.ts" } }
  });
  workspaceTsconfig(root, "packages/contracts", ["src/**/*.ts"]);
  write(root, "packages/contracts/src/index.ts", "export interface Conversation {}\n");
  writeJson(root, "packages/launcher/package.json", {
    name: "agentlab",
    bin: { agentlab: "dist/agentlab.js" }
  });
  workspaceTsconfig(root, "packages/launcher", ["src/**/*.ts"]);
  write(root, "packages/launcher/src/agentlab.ts", "export {};\n");
  writeJson(root, "packages/runtime/package.json", {
    name: "@agentlab/runtime",
    exports: {
      ".": { default: "./dist/local-runtime.js", types: "./dist/local-runtime.d.ts" },
      "./factory-broker": {
        default: "./dist/local-factory-broker.js",
        types: "./dist/local-factory-broker.d.ts"
      },
      "./factory-worker": {
        default: "./dist/local-factory-worker.js",
        types: "./dist/local-factory-worker.d.ts"
      }
    }
  });
  workspaceTsconfig(root, "packages/runtime", ["src/**/*.ts"]);
  write(root, "packages/runtime/src/local-runtime.ts", "export {};\n");
  write(root, "packages/runtime/src/local-factory-broker.ts", "export {};\n");
  write(root, "packages/runtime/src/local-factory-worker.ts", "export {};\n");
  return root;
}

function workspaceTsconfig(root: string, directory: string, include: readonly string[]): void {
  writeJson(root, `${directory}/tsconfig.json`, {
    extends: "../../tsconfig.base.json",
    compilerOptions: { rootDir: "src" },
    include
  });
}

function writeJson(root: string, path: string, value: unknown): void {
  write(root, path, JSON.stringify(value));
}

function write(root: string, path: string, contents: string): void {
  const destination = join(root, path);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, contents);
}

function source(
  path: string,
  dependencies: readonly ArchitectureDependency[] = []
): ArchitectureModule {
  return { dependencies, path };
}

function local(specifier: string, target: string | null): ArchitectureDependency {
  return { local: true, specifier, target };
}
