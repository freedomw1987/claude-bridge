/**
 * `/project delete <id|prefix>` and `/project delete --all-failed` (RG-009).
 *
 * Two-phase commit:
 *   Phase 1 (`handleProjectDelete`): parse, validate, list targets,
 *     store a PendingDelete, and reply with a confirmation prompt. No
 *     files are touched yet.
 *   Phase 2 (`handleDeleteConfirmReply`): invoked from messageCreate
 *     when the user replies with "yes"/"no". Resolves the pending
 *     entry, executes (or cancels), and clears it.
 *
 * The userId + channelId check in Phase 2 ensures a random user typing
 * "yes" in a different channel cannot trigger another user's delete.
 */

import type { Message } from "discord.js";
import { config } from "../../../config";
import { log } from "../../../logger";
import {
  deleteProject,
  listProjects,
  loadState,
  resolveHermesDir,
  resolveProjectPrefix,
} from "../../../hermes/state";
import { isActive } from "../../../hermes/types";

/**
 * Pending delete operations awaiting user confirmation. Keyed by
 * Discord userId; expires after `DELETE_CONFIRM_TTL_MS` to bound the
 * risk of a stale confirmation being triggered by someone else's reply.
 *
 * Stored in a module-scoped Map so multiple concurrent /project delete
 * commands by different users are independent.
 */
interface PendingDelete {
  userId: string;
  kind: "id" | "all-failed";
  /** Full projectId (after prefix resolution). */
  projectId?: string;
  /** Pre-computed list for --all-failed so the confirmation message
   *  can show the user exactly what will be deleted, AND a fresh
   *  re-scan at execute-time avoids TOCTOU (a project could have been
   *  auto-killed by /adopt between confirm and execute — see I-7). */
  targets: Array<{ projectId: string; status: string; goal: string }>;
  expiresAt: number;
  /** Channel id where the original command was issued — the confirmation
   *  reply "yes" must come from the same channel. */
  channelId: string;
}

const pendingDeletes = new Map<string, PendingDelete>();
const DELETE_CONFIRM_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Garbage-collect expired pending deletes. Called on every
 * handleProjectDelete + handleDeleteConfirmReply invocation so the map
 * stays bounded under normal traffic. We don't run a setInterval —
 * the map is small (one entry per active user) and entries are cleared
 * individually as they expire or are consumed.
 */
function gcPendingDeletes(): void {
  const now = Date.now();
  for (const [k, v] of pendingDeletes) {
    if (v.expiresAt <= now) pendingDeletes.delete(k);
  }
}

/**
 * Format the confirmation message a user sees after typing `/project delete`.
 * The text includes the exact set of projects that will be removed so
 * the user can sanity-check before confirming.
 */
function formatDeleteConfirm(p: PendingDelete): string {
  const verb = p.kind === "all-failed" ? "all failed/killed/timed_out projects" : `project \`${p.projectId!.slice(0, 8)}\``;
  const lines: string[] = [];
  lines.push(`⚠️ About to permanently delete ${verb} (${p.targets.length} project${p.targets.length === 1 ? "" : "s"}):`);
  for (const t of p.targets) {
    lines.push(`- \`${t.projectId.slice(0, 8)}\` ${t.status} "${t.goal.slice(0, 60)}"`);
  }
  lines.push("");
  lines.push("This is **NOT recoverable**. The state.json, journal.log, plan.md, and artifacts/ for each project will be removed.");
  lines.push("Reply `yes` to confirm, or `no` to cancel (expires in 5 minutes).");
  return lines.join("\n");
}

export async function handleProjectDelete(
  msg: Message,
  args: { kind: "id"; target: string } | { kind: "all-failed" },
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  gcPendingDeletes();
  const userId = msg.author.id;
  const channelId = msg.channelId;
  const targets: PendingDelete["targets"] = [];

  if (args.kind === "id") {
    // Resolve the (possibly 8-char) prefix to a full projectId.
    const r = resolveProjectPrefix(hermesDir, args.target);
    if (r.ambiguous.length > 0) {
      const list = r.ambiguous.map((p) => `\`${p.slice(0, 8)}\``).join(", ");
      await msg.reply(
        `❌ Prefix \`${args.target}\` is ambiguous — matches ${r.ambiguous.length} projects: ${list}. Use a longer prefix or the full id.`,
      );
      return;
    }
    if (r.projectId === null) {
      await msg.reply(`❌ No Hermes project with id starting with \`${args.target}\`.`);
      return;
    }
    const s = loadState(hermesDir, r.projectId);
    if (!s) {
      await msg.reply(`❌ Project \`${r.projectId.slice(0, 8)}\` exists on disk but state.json is unreadable. Aborting.`);
      return;
    }
    if (isActive(s)) {
      // RG-009 safety: refuse to delete an active project via
      // single-id mode. The user must `/project kill` first, or
      // use --all-failed (which already filters out active ones).
      await msg.reply(
        `❌ Project \`${s.id.slice(0, 8)}\` is **active** (status=\`${s.status}\`). \`/project kill\` it first, or use \`/project delete --all-failed\` to bulk-delete only terminal projects.`,
      );
      return;
    }
    targets.push({
      projectId: s.id,
      status: s.status,
      goal: s.goal,
    });
    pendingDeletes.set(userId, {
      userId,
      kind: "id",
      projectId: s.id,
      targets,
      expiresAt: Date.now() + DELETE_CONFIRM_TTL_MS,
      channelId,
    });
  } else {
    // --all-failed: scan all projects, keep only terminal ones
    // (failed / killed / timed_out). Active projects are NEVER
    // touched by this path, even if the user explicitly asks.
    const all = listProjects(hermesDir);
    for (const s of all) {
      if (isActive(s)) continue;
      targets.push({
        projectId: s.id,
        status: s.status,
        goal: s.goal,
      });
    }
    if (targets.length === 0) {
      await msg.reply(`📭 No failed/killed/timed_out projects to delete.`);
      return;
    }
    pendingDeletes.set(userId, {
      userId,
      kind: "all-failed",
      targets,
      expiresAt: Date.now() + DELETE_CONFIRM_TTL_MS,
      channelId,
    });
  }

  const p = pendingDeletes.get(userId)!;
  await msg.reply(formatDeleteConfirm(p));
}

/**
 * Phase 2 of the delete flow: invoked from messageCreate when the user
 * replies with "yes" or "no". Looks up the matching PendingDelete (keyed
 * by userId, scoped to the same channelId), and either executes the
 * deletion or cancels.
 *
 * Returns true if a pending delete was found and resolved, false
 * otherwise (caller can fall through to other reply handlers).
 */
export async function handleDeleteConfirmReply(
  msg: Message,
): Promise<boolean> {
  const trimmed = msg.content.trim().toLowerCase();
  if (trimmed !== "yes" && trimmed !== "no") return false;
  const userId = msg.author.id;
  const channelId = msg.channelId;
  gcPendingDeletes();
  const p = pendingDeletes.get(userId);
  if (!p) return false; // no pending delete for this user
  if (p.channelId !== channelId) {
    // Confirmation must come from the same channel as the original
    // command. We silently drop (return false) so a /yes typed in
    // a project thread doesn't accidentally fire a delete that
    // was set up in the configured channel.
    return false;
  }
  // Consume the pending entry regardless of yes/no so the user
  // can't accidentally double-confirm.
  pendingDeletes.delete(userId);
  if (trimmed === "no") {
    await msg.reply("🚫 Delete cancelled.");
    return true;
  }
  // Execute. We re-scan at execute-time to avoid TOCTOU (a
  // project could have been auto-killed by /adopt between confirm
  // and execute — see I-7). For --all-failed we re-compute the
  // target set; for single-id we just use p.projectId directly.
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  let deleted: string[] = [];
  let skipped: string[] = [];
  if (p.kind === "id" && p.projectId) {
    const id = p.projectId;
    // Re-check active status (defense-in-depth: project may have
    // been resumed between confirm and execute).
    const fresh = loadState(hermesDir, id);
    if (fresh && isActive(fresh)) {
      await msg.reply(
        `❌ Project \`${id.slice(0, 8)}\` is now **active** (status=\`${fresh.status}\`). Aborting delete.`,
      );
      return true;
    }
    if (deleteProject(hermesDir, id)) {
      deleted.push(id);
    } else {
      skipped.push(id);
    }
  } else {
    // --all-failed. Re-scan and delete.
    const all = listProjects(hermesDir);
    for (const s of all) {
      if (isActive(s)) continue;
      if (deleteProject(hermesDir, s.id)) {
        deleted.push(s.id);
      } else {
        skipped.push(s.id);
      }
    }
  }
  // Audit trail: log to bot log (NOT to journal, because the
  // journal is part of what was just deleted).
  log.info("hermes: project(s) deleted", {
    userId,
    kind: p.kind,
    deletedCount: deleted.length,
    skippedCount: skipped.length,
    deletedIds: deleted.map((d) => d.slice(0, 8)),
  });
  const lines: string[] = [];
  lines.push(`🗑️ Deleted ${deleted.length} project${deleted.length === 1 ? "" : "s"}.`);
  if (skipped.length > 0) {
    lines.push(`(Skipped ${skipped.length} that were already gone: ${skipped.map((s) => `\`${s.slice(0, 8)}\``).join(", ")})`);
  }
  await msg.reply(lines.join("\n"));
  return true;
}