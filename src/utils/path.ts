/**
 * Path utilities. Handles `~` expansion to $HOME.
 * Pure Bun — no Deno std import.
 */

const HOME = process.env.HOME || process.env.USERPROFILE || "";

export function expandTilde(input: string): string {
  if (!input) return input;
  if (input === "~") return HOME;
  if (input.startsWith("~/")) return HOME + input.slice(1);
  if (input.startsWith("~")) return HOME + "/" + input.slice(1);
  return input;
}

export function taskRepoPath(tasksRoot: string, threadId: string): string {
  return `${tasksRoot.replace(/\/$/, "")}/${threadId}`;
}
