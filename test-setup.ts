/**
 * Preload for `bun test`. Runs BEFORE any test file is loaded, so env
 * vars are set before config.ts is first evaluated.
 *
 * Unconditional overwrite is safe here: tests don't need real Discord
 * credentials, and a stray .env load by Bun would otherwise leak in.
 */

process.env.DISCORD_TOKEN = "test-token";
process.env.DISCORD_CHANNEL_ID = "test-channel";
process.env.DISCORD_USER_ID = "test-user";

// Hermes dataDir is captured at config module load (as a `const`), so
// we have to pin it here. Tests that touch on-disk Hermes state should
// create a unique subdir under this base. This replaces the default
// `./data` so a stray CWD never leaks real project state into tests.
//
// Bun auto-loads .env BEFORE the preload script runs, so we override
// both DATA_DIR (defaults to ./data) and HERMES_DIR (defaults to
// ~/.hermes) to ensure hermes state stays inside the test sandbox.
// HERMES_DIR is intentionally cleared so resolveHermesDir falls
// through to <DATA_DIR>/hermes.
const TEST_DATA_DIR = process.env.TEST_DATA_DIR ?? "/tmp/claude-bridge-test-data";
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.HERMES_DIR = "";
// Ensure the parent exists — tests create per-test subdirs with
// mkdtempSync, which requires the parent to already exist.
import { mkdirSync } from "node:fs";
mkdirSync(TEST_DATA_DIR, { recursive: true });
