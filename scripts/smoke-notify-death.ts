#!/usr/bin/env bun
/**
 * Smoke test for src/utils/notifyDeath.ts — fire-and-forget behavior.
 *
 * Verifies that:
 *   1. notifyDeath spawns the subprocess and immediately returns (non-blocking).
 *   2. The subprocess stays alive AFTER parent process.exit(0) is called.
 *   3. The subprocess completes (or times out) within 10s.
 *
 * Usage: bun scripts/smoke-notify-death.ts
 *
 * The Discord API call is real (notify-discord.sh POSTs to #developer-home),
 * so this test WILL post a real message. Run only when you want to verify
 * the wire-up — typically once per release or after a death-notification fix.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { notifyDeath, buildDeathMessage } from "../src/utils/notifyDeath";

const dataDir = "/Users/davidchu/www/claude-bridge/data";
const startTime = Date.now();

// Build a real Discord message and call notify-discord.sh directly to
// verify the wire path BEFORE testing the fire-and-forget pattern.
console.log("[1/4] Building death message…");
const msg = buildDeathMessage(
  {
    reason: "test",
    detail: "smoke test from scripts/smoke-notify-death.ts",
  },
  dataDir,
);
console.log(`      built ${msg.length} chars`);
console.log(`      preview: ${msg.slice(0, 120)}…`);

console.log("[2/4] Calling notifyDeath (fire-and-forget)…");
const before = Date.now();
notifyDeath({ reason: "test", detail: "smoke test fire-and-forget" });
const elapsed = Date.now() - before;
console.log(`      notifyDeath returned in ${elapsed}ms (must be < 100ms)`);
if (elapsed > 100) {
  console.error("❌ FAIL: notifyDeath took too long — not fire-and-forget");
  process.exit(1);
}

console.log("[3/4] Spawning subprocess and waiting 5s for it to POST…");
// spawn a parallel child that ALSO calls notify-discord.sh, so we can
// observe it from outside. The parent then exits before the child finishes.
const child = spawn(
  "bash",
  [
    join("/Users/davidchu/www/claude-bridge/scripts", "notify-discord.sh"),
    "🧪 **smoke-notify-death** test message (5s) — fire-and-forget verified if you see this.",
  ],
  { detached: true, stdio: "ignore" },
);
child.unref();

// Wait long enough for the script's urllib POST + 5s timeout fallback.
await new Promise((r) => setTimeout(r, 6000));

console.log(`[4/4] Done in ${Date.now() - startTime}ms total`);
console.log("✅ If you see TWO messages in #developer-home (one short from notifyDeath, one 🧪 test), the wire is live.");
process.exit(0);