import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("database path required");
const lockPath = `${databasePath}.agentlab-writer-lock.sqlite`;
const database = new DatabaseSync(lockPath);
chmodSync(lockPath, 0o600);
database.exec("PRAGMA journal_mode = DELETE");
database.exec(
  "CREATE TABLE IF NOT EXISTS writer_lease (singleton INTEGER PRIMARY KEY CHECK (singleton = 1)) STRICT"
);
database.exec("BEGIN EXCLUSIVE");
process.stdout.write("ready\n");
setInterval(() => undefined, 1_000);
