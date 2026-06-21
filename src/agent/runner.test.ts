/**
 * Bun tests for the agent runner + parser.
 * Run with: bun test
 */

import { describe, it, expect } from "bun:test";
import {
  parseMention,
  isValidRepoUrl,
  isValidLocalPath,
  isLocalPathString,
  isValidProjectName,
} from "../discord/parser";
import {
  isInitEvent,
  isAssistantText,
  isAssistantToolUse,
  isResult,
} from "./events";
// hasEnoughMemoryForClaude was removed when the memory check was dropped
// (per user: personal use, concurrency cap is sufficient).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectRegistry } from "../projects/registry";

describe("parseMention", () => {
  it("extracts https URL from message", () => {
    const r = parseMention("<@123> fix auth on https://github.com/foo/bar", "123");
    expect(r.repoUrl).toBe("https://github.com/foo/bar");
    expect(r.localPath).toBe(null);
    expect(r.threadName.length).toBeGreaterThan(0);
  });

  it("normalizes bare github.com URL to https", () => {
    const r = parseMention("<@123> review github.com/baz/qux", "123");
    expect(r.repoUrl).toBe("https://github.com/baz/qux");
  });

  it("returns null repoUrl when none present", () => {
    const r = parseMention("<@123> just say hi", "123");
    expect(r.repoUrl).toBe(null);
    expect(r.localPath).toBe(null);
    expect(r.threadName).toBe("just say hi");
  });

  it("handles git@ ssh URL", () => {
    const r = parseMention("<@123> work on git@github.com:foo/bar.git", "123");
    expect(r.repoUrl).toBe("git@github.com:foo/bar.git");
  });

  it("strips URLs from threadName", () => {
    const r = parseMention("<@123> review my code at github.com/baz/qux please", "123");
    expect(r.threadName).not.toContain("github.com");
    expect(r.threadName).toBe("review my code at please");
  });

  it("uses repo name as fallback threadName", () => {
    const r = parseMention("<@123>", "123");
    expect(r.threadName).toBe("claude task");
  });

  it("extracts local path with absolute prefix", () => {
    const r = parseMention("<@123> work on /Users/david/code/foo", "123");
    expect(r.repoUrl).toBe(null);
    expect(r.localPath).toBe("/Users/david/code/foo");
  });

  it("extracts local path with tilde", () => {
    const r = parseMention("<@123> fix bug in ~/code/foo please", "123");
    expect(r.localPath).toBe("~/code/foo");
  });

  it("extracts local path with relative prefix", () => {
    const r = parseMention("<@123> work on ./foo", "123");
    expect(r.localPath).toBe("./foo");
  });

  it("prefers URL over path when both could match", () => {
    const r = parseMention("<@123> on https://github.com/foo/bar", "123");
    expect(r.repoUrl).toBe("https://github.com/foo/bar");
    expect(r.localPath).toBe(null);
  });

  it("detects 'new <name>' for project creation", () => {
    const r = parseMention("<@123> new my-app build a todo list API in Go", "123");
    expect(r.newProject).toBe("my-app");
    expect(r.prompt).toBe("build a todo list API in Go");
    expect(r.localPath).toBe("my-app"); // bare name; expanded by handler
  });

  it("detects 'create <name>: <prompt>'", () => {
    const r = parseMention("<@123> create blog-cms: a static site generator", "123");
    expect(r.newProject).toBe("blog-cms");
    expect(r.prompt).toBe("a static site generator");
  });

  it("new project without rest uses default prompt", () => {
    const r = parseMention("<@123> new foo-app", "123");
    expect(r.newProject).toBe("foo-app");
    expect(r.prompt).toContain("Create a new project called foo-app");
  });

  it("resolves project name with 'in <name>' preposition", () => {
    // Setup fake project under /tmp
    const root = join("/tmp", "cb-test-root");
    mkdirSync(join(root, "demo-proj"), { recursive: true });
    const reg = new ProjectRegistry({ root });

    const r = parseMention("<@123> fix bug in demo-proj", "123", { projects: reg });
    expect(r.localPath).toBe(join(root, "demo-proj"));
    expect(r.repoUrl).toBe(null);
  });

  it("resolves project name as fallback word match", () => {
    const root = join("/tmp", "cb-test-root2");
    mkdirSync(join(root, "alpha"), { recursive: true });
    const reg = new ProjectRegistry({ root });

    const r = parseMention("<@123> alpha add new feature", "123", { projects: reg });
    expect(r.localPath).toBe(join(root, "alpha"));
  });

  it("ignores non-existent project names", () => {
    const reg = new ProjectRegistry({ root: "/tmp/empty-test-root" });
    const r = parseMention("<@123> fix bug in ghost-project", "123", { projects: reg });
    expect(r.localPath).toBe(null);
    expect(r.repoUrl).toBe(null);
  });
});

describe("isValidRepoUrl", () => {
  it("accepts full https URL", () => {
    expect(isValidRepoUrl("https://github.com/foo/bar")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isValidRepoUrl("not a url")).toBe(false);
  });
  it("rejects URL without path", () => {
    expect(isValidRepoUrl("https://github.com")).toBe(false);
  });
});

describe("isValidLocalPath", () => {
  const tmpDir = join("/tmp", "claude-bridge-test");
  mkdirSync(tmpDir, { recursive: true });

  it("accepts existing absolute path", () => {
    const r = isValidLocalPath(tmpDir);
    expect(r.ok).toBe(true);
    expect(r.resolved).toBe(tmpDir);
  });

  it("rejects non-existent path", () => {
    const r = isValidLocalPath("/this/does/not/exist/anywhere");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("does not exist");
  });

  it("rejects path without /, ~/, ./, or ../ prefix", () => {
    const r = isValidLocalPath("foo/bar");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("must start with");
  });

  it("rejects empty path", () => {
    const r = isValidLocalPath("");
    expect(r.ok).toBe(false);
  });
});

describe("isLocalPathString", () => {
  it("accepts absolute", () => expect(isLocalPathString("/foo")).toBe(true));
  it("accepts tilde", () => expect(isLocalPathString("~/foo")).toBe(true));
  it("accepts dot slash", () => expect(isLocalPathString("./foo")).toBe(true));
  it("accepts dotdot slash", () => expect(isLocalPathString("../foo")).toBe(true));
  it("rejects bare word", () => expect(isLocalPathString("foo")).toBe(false));
  it("rejects URL", () => expect(isLocalPathString("https://foo")).toBe(false));
});

describe("isValidProjectName", () => {
  it("accepts simple names", () => {
    expect(isValidProjectName("my-app")).toBe(true);
    expect(isValidProjectName("foo_bar")).toBe(true);
    expect(isValidProjectName("v2.0")).toBe(true);
  });
  it("rejects slashes", () => {
    expect(isValidProjectName("foo/bar")).toBe(false);
    expect(isValidProjectName("../foo")).toBe(false);
  });
  it("rejects empty / starts-with-dot", () => {
    expect(isValidProjectName("")).toBe(false);
    expect(isValidProjectName(".hidden")).toBe(false);
  });
  it("rejects over 64 chars", () => {
    expect(isValidProjectName("a".repeat(65))).toBe(false);
  });
});

describe("ProjectRegistry", () => {
  it("scans PROJECTS_ROOT for subdirs", () => {
    const root = join("/tmp", "cb-registry-test");
    mkdirSync(join(root, "proj-a"), { recursive: true });
    mkdirSync(join(root, "proj-b"), { recursive: true });
    const reg = new ProjectRegistry({ root });
    const names = reg.list().map((p) => p.name).sort();
    expect(names).toContain("proj-a");
    expect(names).toContain("proj-b");
  });

  it("loads projects.json aliases", () => {
    const root = join("/tmp", "cb-registry-test2");
    mkdirSync(join(root, "real-name"), { recursive: true });
    const cfgPath = join("/tmp", "cb-registry-test2.json");
    writeFileSync(cfgPath, JSON.stringify({
      projects: { alias: join(root, "real-name") },
    }));
    const reg = new ProjectRegistry({ root, configPath: cfgPath });
    const r = reg.resolve("alias");
    expect(r?.path).toBe(join(root, "real-name"));
    expect(r?.source).toBe("config");
  });

  it("respects exclude list", () => {
    const root = join("/tmp", "cb-registry-test3");
    mkdirSync(join(root, "kept"), { recursive: true });
    mkdirSync(join(root, "ignored"), { recursive: true });
    const cfgPath = join("/tmp", "cb-registry-test3.json");
    writeFileSync(cfgPath, JSON.stringify({ exclude: ["ignored"] }));
    const reg = new ProjectRegistry({ root, configPath: cfgPath });
    const names = reg.list().map((p) => p.name);
    expect(names).toContain("kept");
    expect(names).not.toContain("ignored");
  });

  it("case-insensitive lookup", () => {
    const root = join("/tmp", "cb-registry-test4");
    mkdirSync(join(root, "MyApp"), { recursive: true });
    const reg = new ProjectRegistry({ root });
    expect(reg.resolve("myapp")).not.toBe(null);
    expect(reg.resolve("MYAPP")).not.toBe(null);
  });
});

describe("stream event type guards", () => {
  it("identifies init event", () => {
    const e = {
      type: "system",
      subtype: "init",
      session_id: "abc",
    };
    expect(isInitEvent(e as any)).toBe(true);
  });

  it("identifies assistant text event", () => {
    const e = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    };
    expect(isAssistantText(e as any)).toBe(true);
  });

  it("identifies assistant tool_use event", () => {
    const e = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
    };
    expect(isAssistantToolUse(e as any)).toBe(true);
  });

  it("identifies result event", () => {
    const e = { type: "result", subtype: "success", is_error: false };
    expect(isResult(e as any)).toBe(true);
  });
});

// Helper for the messageCreate handler — re-implement the function locally
// so we can unit-test it without importing the handler (which pulls Discord types).
type ToolInput = Record<string, unknown> | unknown;

function splitForDiscord(text: string, maxLen = 1900): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.5) {
      cut = remaining.lastIndexOf("\n", maxLen);
    }
    if (cut < maxLen * 0.5) {
      cut = remaining.lastIndexOf(" ", maxLen);
    }
    if (cut < maxLen * 0.3) {
      cut = maxLen;
    }
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// Helper for the messageCreate handler — re-implement the function locally
// so we can unit-test it without importing the handler (which pulls Discord types).
function containsQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith("?") || trimmed.endsWith("？")) return true;
  const tail = trimmed.slice(-250).toLowerCase();
  const patterns = [
    "should i",
    "would you like",
    "do you want",
    "let me know",
    "what do you think",
    "shall i",
    "want me to",
  ];
  return patterns.some((p) => tail.includes(p));
}

describe("containsQuestion", () => {
  it("detects trailing question mark", () => {
    expect(containsQuestion("Should I add tests too?")).toBe(true);
  });
  it("detects trailing full-width question mark", () => {
    expect(containsQuestion("好嗎？")).toBe(true);
  });
  it("returns false for declarative statement", () => {
    expect(containsQuestion("I added the tests successfully.")).toBe(false);
  });
  it("detects 'should I' in tail", () => {
    expect(containsQuestion("Looks good. Should I deploy it?")).toBe(true);
  });
  it("detects 'would you like'", () => {
    expect(containsQuestion("Done. Would you like me to refactor?")).toBe(true);
  });
  it("detects 'want me to'", () => {
    expect(containsQuestion("Tests pass. Want me to commit?")).toBe(true);
  });
  it("ignores question phrase in middle of long text", () => {
    // 'should i' is more than 250 chars from end — should not match
    const text = "Should I " + "x".repeat(300) + " end";
    expect(containsQuestion(text)).toBe(false);
  });
  it("handles empty text", () => {
    expect(containsQuestion("")).toBe(false);
  });
});

describe("splitForDiscord", () => {
  it("returns single chunk for short text", () => {
    const out = splitForDiscord("hello world", 100);
    expect(out).toEqual(["hello world"]);
  });

  it("splits long text on paragraph boundary", () => {
    const text = "para1\n\n" + "x".repeat(100) + "\n\npara2";
    const out = splitForDiscord(text, 50);
    // Should split at \n\n
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toContain("para1");
  });

  it("falls back to line break when no paragraph", () => {
    const text = "line1\n" + "x".repeat(200) + "\nline2";
    const out = splitForDiscord(text, 50);
    expect(out.length).toBeGreaterThan(1);
  });

  it("falls back to word break when no newline", () => {
    const text = "word ".repeat(500); // ~2500 chars
    const out = splitForDiscord(text, 100);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(100);
    }
  });

  it("hard-cuts only when no good boundary", () => {
    const text = "x".repeat(5000);
    const out = splitForDiscord(text, 100);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(100);
    }
  });

  it("handles empty string", () => {
    expect(splitForDiscord("")).toEqual([""]);
  });
});
function formatToolUse(name: string, input: ToolInput): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const pick = (k: string): string | undefined => {
    const v = obj[k];
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return undefined;
  };
  const trunc = (s: string, n: number): string =>
    s.length <= n ? s : s.slice(0, n - 1) + "…";
  switch (name) {
    case "Bash": {
      const cmd = pick("command") ?? pick("cmd") ?? "";
      return `\`${trunc(cmd, 200)}\``;
    }
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit": {
      const p = pick("file_path") ?? pick("path") ?? "";
      return `\`${trunc(p, 150)}\``;
    }
    case "Glob": {
      const p = pick("pattern") ?? "";
      return `pattern: \`${trunc(p, 100)}\``;
    }
    case "Grep": {
      const p = pick("pattern") ?? "";
      const path = pick("path") ?? "";
      return `pattern: \`${trunc(p, 80)}\` in \`${trunc(path, 60)}\``;
    }
    case "WebFetch": {
      const url = pick("url") ?? "";
      return `\`${trunc(url, 120)}\``;
    }
    default: {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && v.length > 0 && v.length < 200) {
          return `${k}: \`${trunc(v, 120)}\``;
        }
      }
      return "";
    }
  }
}

describe("formatToolUse", () => {
  it("formats Bash command", () => {
    expect(formatToolUse("Bash", { command: "npm test" }))
      .toBe("`npm test`");
  });
  it("formats Read file path", () => {
    expect(formatToolUse("Read", { file_path: "/src/foo.ts" }))
      .toBe("`/src/foo.ts`");
  });
  it("formats Edit with file_path", () => {
    expect(formatToolUse("Edit", { file_path: "src/bar.ts", old_string: "x", new_string: "y" }))
      .toBe("`src/bar.ts`");
  });
  it("formats Grep with pattern + path", () => {
    expect(formatToolUse("Grep", { pattern: "TODO", path: "src/" }))
      .toBe("pattern: `TODO` in `src/`");
  });
  it("formats WebFetch URL", () => {
    expect(formatToolUse("WebFetch", { url: "https://example.com" }))
      .toBe("`https://example.com`");
  });
  it("handles empty input", () => {
    expect(formatToolUse("UnknownTool", {})).toBe("");
  });
  it("falls back to first string field for unknown tools", () => {
    expect(formatToolUse("UnknownTool", { foo: "bar" })).toBe("foo: `bar`");
  });
  it("truncates long bash command", () => {
    const long = "x".repeat(500);
    const out = formatToolUse("Bash", { command: long });
    expect(out.length).toBeLessThan(220);
    expect(out.includes("…")).toBe(true);
  });
  it("falls back to first string field for unknown tools", () => {
    expect(formatToolUse("CustomTool", { foo: "bar" })).toBe("foo: `bar`");
  });
});
