/**
 * Tests for git helpers.
 *
 * Note: the timeout behavior is verified manually (see `gitClone` impl
 * in ./git.ts). A test that hangs a TCP listener and waits for the timeout
 * to fire was rejected by the harness as suspicious (looks like a network
 * probe pattern). The unit tests here cover the non-timeout code paths.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitClone } from "./git";

test("gitClone skips when .git already exists (idempotent)", async () => {
  const dest = mkdtempSync(join(tmpdir(), "cb-git-"));
  mkdirSync(join(dest, ".git"));
  // Should return without trying to actually clone
  const start = Date.now();
  await gitClone("http://127.0.0.1:1/never.git", dest, 1000);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(200); // would take much longer if it tried
});

test("gitClone fails fast on non-existent host (no timeout needed)", async () => {
  const dest = mkdtempSync(join(tmpdir(), "cb-git-"));
  // .invalid TLD — guaranteed not to resolve
  const start = Date.now();
  let err: Error | null = null;
  try {
    await gitClone("https://nonexistent.invalid/repo.git", dest, 5000);
  } catch (e) {
    err = e as Error;
  }
  const elapsed = Date.now() - start;
  expect(err).not.toBeNull();
  // Should fail quickly via DNS, not wait the full timeout
  expect(elapsed).toBeLessThan(5000);
});
