/**
 * Manual migration runner — creates the SQLite DB and applies schema.
 * Run with: bun run db:migrate
 */

import { config } from "../src/config";
import { SessionStore } from "../src/db";
import { join } from "node:path";

const dbPath = join(config.paths.dataDir, "sessions.db");
const schemaPath = join(import.meta.dir, "..", "src", "db", "schema.sql");

const store = new SessionStore(dbPath, schemaPath);
console.log(`✓ migrated: ${dbPath}`);
store.close();