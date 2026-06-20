/**
 * Mention parser.
 *
 * Extracts a "target" from a mention message. The target can be:
 *   - a git URL  →  bot will git clone into a per-thread dir
 *   - a local filesystem path →  bot will mount the existing dir directly
 *   - a project name (resolved via ProjectRegistry) →  bot will mount it
 *   - "new <name>" →  bot will create a new project dir and mount it
 *
 * Plus the user's prompt and a derived thread name.
 */

import { existsSync } from "node:fs";
import { expandTilde } from "../utils/path";
import type { MentionParse } from "../types";
import type { ProjectRegistry } from "../projects/registry";

// Git URL patterns
const REPO_PATTERNS: RegExp[] = [
  /https?:\/\/(?:[\w-]+\.)+[\w-]+\/[\w.-]+\/[\w.-]+(?:\.git)?/i,
  /git@[\w.-]+:[\w./-]+(?:\.git)?/i,
  /(?:^|\s)(?:github|gitlab|bitbucket)\.com\/[\w.-]+\/[\w.-]+/i,
];

// Local filesystem path patterns:
//   /Users/david/code/foo, ~/code/foo, ./foo, ../foo
const LOCAL_PATH_RE = /(?:^|\s)((?:\/(?:[\w.\- ]+|\[[^\]]+\]))+|(?:~\/|\.{1,2}\/)[\w.\-\/]+)/;

// "new <name>" / "create <name>" / "init <name>" at the start of the message.
// Captures: 1 = project name, 2 = rest of the prompt
const NEW_PROJECT_RE = /^(?:new|create|init)\s+([\w][\w.-]*)\s*[:\-]?\s*(.*)$/i;

// Preposition + identifier — used to look up a project by name when the user
// writes "in foo" / "on foo" / "for foo" / "use foo" / "with foo".
const PREP_RE = /\b(?:in|on|for|use|with)\s+([\w][\w.-]*)/i;

const stripMention = (content: string, botUserId: string): string => {
  const mentionRe = new RegExp(`<@!?${botUserId}>`, "g");
  return content.replace(mentionRe, "").trim();
};

const stripTargets = (text: string): string =>
  text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/git@\S+/g, "")
    .replace(/(?:^|\s)(?:github|gitlab|bitbucket)\.com\/[\w./-]+/gi, " ")
    .replace(LOCAL_PATH_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

const extractRepoUrl = (text: string): string | null => {
  for (const pat of REPO_PATTERNS) {
    const m = text.match(pat);
    if (m) {
      let url = m[0].trim();
      if (/^(?:github|gitlab|bitbucket)\.com\//i.test(url)) {
        url = `https://${url}`;
      }
      return url;
    }
  }
  return null;
};

const extractLocalPath = (text: string): string | null => {
  const m = text.match(LOCAL_PATH_RE);
  return m ? m[1].trim() : null;
};

const threadNameFromMessage = (text: string, anchor: string | null): string => {
  const words = text.split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 0 && anchor) {
    const cleaned = anchor.replace(/\.git$/, "");
    const m = cleaned.match(/([\w.-]+)\/?$/);
    return m ? m[1] : "claude task";
  }
  return words.length > 0 ? words.join(" ") : "claude task";
};

export interface ParseOptions {
  projects?: ProjectRegistry;
}

/**
 * Parse a mention message into a MentionParse.
 *
 * Resolution order:
 *   1. "new <name> <prompt>" / "create <name>: <prompt>"  → newProject set
 *   2. Git URL (https or ssh)                              → repoUrl set
 *   3. Local path (starts with /, ~/, ./, ../)             → localPath set
 *   4. Project name from prep ("in foo") OR word match     → localPath = resolved path
 *   5. Nothing matched                                     → all null
 */
export function parseMention(
  content: string,
  botUserId: string,
  opts: ParseOptions = {},
): MentionParse {
  const stripped = stripMention(content, botUserId);

  // 1. New project creation
  const newMatch = stripped.match(NEW_PROJECT_RE);
  if (newMatch) {
    const name = newMatch[1];
    const rest = (newMatch[2] ?? "").trim();
    const targetPath = opts.projects
      ? opts.projects.newProjectPath(name)
      : name;
    return {
      repoUrl: null,
      localPath: targetPath,
      newProject: name,
      prompt: rest || `Create a new project called ${name}`,
      threadName: threadNameFromMessage(rest || name, name).slice(0, 100),
    };
  }

  // 2. Git URL
  const repoUrl = extractRepoUrl(stripped);

  // 3. Local filesystem path
  let localPath = repoUrl ? null : extractLocalPath(stripped);

  // 4. Project name resolution (only if no path/url yet)
  if (!localPath && !repoUrl && opts.projects) {
    // Prefer explicit preposition match: "in foo", "use foo"
    const prepMatch = stripped.match(PREP_RE);
    const candidate = prepMatch?.[1];
    if (candidate) {
      const project = opts.projects.resolve(candidate);
      if (project) {
        localPath = project.path;
      }
    }
    // Fallback: any token in the message that matches a known project
    if (!localPath) {
      const tokens = stripped.split(/\s+/);
      for (const t of tokens) {
        const project = opts.projects.resolve(t);
        if (project) {
          localPath = project.path;
          break;
        }
      }
    }
  }

  const textOnly = stripTargets(stripped);
  const threadName = threadNameFromMessage(textOnly, repoUrl ?? localPath).slice(0, 100);
  return {
    repoUrl,
    localPath,
    newProject: null,
    prompt: stripped,
    threadName,
  };
}

export const isValidRepoUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.length >= 2;
  } catch {
    return false;
  }
};

export const isValidLocalPath = (rawPath: string): { ok: boolean; resolved?: string; error?: string } => {
  if (!rawPath) return { ok: false, error: "empty path" };
  if (
    !rawPath.startsWith("/") &&
    !rawPath.startsWith("~/") &&
    !rawPath.startsWith("./") &&
    !rawPath.startsWith("../")
  ) {
    return { ok: false, error: "must start with /, ~/, ./, or ../" };
  }
  const resolved = expandTilde(rawPath);
  if (!existsSync(resolved)) {
    return { ok: false, error: `does not exist: ${resolved}` };
  }
  return { ok: true, resolved };
};

export const isLocalPathString = (s: string): boolean =>
  s.startsWith("/") ||
  s.startsWith("~/") ||
  s.startsWith("./") ||
  s.startsWith("../");

/**
 * Validate a project name for "new <name>".
 * Must be a simple identifier — no slashes, no special chars.
 */
export const isValidProjectName = (name: string): boolean =>
  /^[a-zA-Z0-9][\w.-]*$/.test(name) && !name.includes("..") && name.length <= 64;