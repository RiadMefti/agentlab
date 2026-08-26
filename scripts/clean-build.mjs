import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const buildDirectories = [
  "packages/contracts/dist",
  "packages/runtime/dist",
  "apps/tui/dist",
  ".test-types"
];

await Promise.all(
  buildDirectories.map((directory) =>
    rm(resolve(projectRoot, directory), { force: true, recursive: true })
  )
);
