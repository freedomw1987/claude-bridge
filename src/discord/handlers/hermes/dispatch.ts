/**
 * Hermes command dispatcher.
 *
 * Routes a `/project <subcommand>` message to the matching handler
 * (start / list / delete / status / plan / kill / resume / setMode / adopt).
 * Falls through with a "no project handler matched" reply if the
 * message is in a Hermes thread (status=auto, active) so the bot doesn't
 * forward non-/project messages to Claude Code under Hermes control.
 *
 * Channel-level commands: /list, /start, /delete (work at top level).
 * Thread-level commands: /status, /plan, /kill, /resume, /setMode, /adopt
 * (require being inside a project thread).
 */

import type { ThreadChannel } from "discord.js";
import { config } from "../../../config";
import { resolveHermesDir } from "../../../hermes/state";
import { isActive } from "../../../hermes/types";
import {
  isProjectCommand,
  matchAdopt,
  matchDelete,
  matchKill,
  matchList,
  matchPlan,
  matchResume,
  matchSetMode,
  matchStart,
  matchStatus,
  type HermesCommandContext,
} from "./matchers";
import { handleProjectStart } from "./start";
import { handleProjectAdopt } from "./adopt";
import { handleProjectSetMode } from "./setMode";
import { handleProjectDelete } from "./delete";
import {
  handleProjectKill,
  handleProjectList,
  handleProjectPlan,
  handleProjectResume,
  handleProjectStatus,
} from "./lifecycle";
import { findProjectByThread } from "./helpers";

export type { HermesCommandContext };

export async function dispatchHermesCommand(
  content: string,
  ctx: HermesCommandContext,
): Promise<boolean> {
  if (!isProjectCommand(content)) return false;
  // The caller (messageCreate.ts) has already stripped any leading
  // @bot mention, so content is clean command text here.
  const trimmed = content.trim();

  // Channel-level commands (work anywhere — top level or thread).
  if (matchList(trimmed)) {
    await handleProjectList(ctx.msg);
    return true;
  }

  // /project start only works at top level.
  const startMatch = matchStart(trimmed);
  if (startMatch) {
    if (!ctx.isTopLevel) {
      await ctx.msg.reply("❌ `/project start` must be invoked in the configured channel, not in a thread.");
      return true;
    }
    await handleProjectStart(ctx.msg, startMatch[1], ctx.store);
    return true;
  }

  // /project delete only works at top level (cross-thread operation,
  // no specific thread context required). RG-009.
  const deleteMatch = matchDelete(trimmed);
  if (deleteMatch) {
    if (!ctx.isTopLevel) {
      await ctx.msg.reply("❌ `/project delete` must be invoked in the configured channel, not in a thread.");
      return true;
    }
    await handleProjectDelete(ctx.msg, deleteMatch);
    return true;
  }

  // Thread-level commands require the message to be in a project thread.
  if (!ctx.msg.channel.isThread()) {
    await ctx.msg.reply("❌ `/project <subcommand>` requires being in a project thread, except for `/project list` and `/project start`.");
    return true;
  }

  const threadId = ctx.msg.channel.id;

  if (matchStatus(trimmed)) {
    await handleProjectStatus(ctx.msg, threadId);
    return true;
  }
  if (matchPlan(trimmed)) {
    await handleProjectPlan(ctx.msg, threadId);
    return true;
  }
  if (matchKill(trimmed)) {
    await handleProjectKill(ctx.msg, threadId);
    return true;
  }
  if (matchResume(trimmed)) {
    await handleProjectResume(ctx.msg, threadId, ctx.msg.channel as ThreadChannel, ctx.store);
    return true;
  }

  const setModeMatch = matchSetMode(trimmed);
  if (setModeMatch) {
    await handleProjectSetMode(
      ctx.msg,
      threadId,
      setModeMatch.mode,
      setModeMatch.duration,
      ctx.store,
    );
    return true;
  }

  // /project adopt only works in a thread (the whole point is to upgrade
  // an existing thread's CC session — top-level makes no sense).
  const adoptMatch = matchAdopt(trimmed);
  if (adoptMatch) {
    if (ctx.isTopLevel) {
      await ctx.msg.reply("❌ `/project adopt` must be invoked in an existing thread, not at the channel top level.");
      return true;
    }
    await handleProjectAdopt(
      ctx.msg,
      threadId,
      ctx.msg.channel as ThreadChannel,
      ctx.store,
      adoptMatch,
    );
    return true;
  }

  // Hermes thread consume gate. In AUTO mode + active project, consume
  // any non-/project message so it doesn't fall through to Claude Code
  // (Hermes is orchestrating; replies are not directed at Claude Code).
  // In MANUAL mode (or any terminal status), let messages fall through
  // to forwardToClaude so David can continue the conversation with
  // Claude Code via session resume.
  const hermesDirEarly = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const earlyState = findProjectByThread(hermesDirEarly, threadId);
  if (
    earlyState &&
    earlyState.mode === "auto" &&
    isActive(earlyState)
  ) {
    return true;
  }

  await ctx.msg.reply(
    `❓ Unknown \`/project\` subcommand. Try: \`start\`, \`status\`, \`plan\`, \`kill\`, \`resume\`, \`setMode\`, \`adopt\`, \`list\`.`,
  );
  return true;
}