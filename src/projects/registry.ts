/**
 * Project registry.
 *
 * Resolves "project names" (e.g. "claude-bridge") to filesystem paths.
 *
 * Sources, in priority order:
 *   1. projects.json (optional, configurable via PROJECTS_CONFIG)
 *      - Lets the user add aliases, override paths, or list paths
 *        outside PROJECTS_ROOT
 *   2. PROJECTS_ROOT directory contents (default ~/www/)
 *      - Each subdirectory becomes a project, name = basename
 *
 * Resolution priority at lookup time:
 *   a. exact alias from projects.json (with explicit override)
 *   b. exact subdirectory name under PROJECTS_ROOT
 *   c. otherwise: not found (caller can fall through to ad-hoc path)
 *
 * Scan results are cached in-memory with a TTL (default 60s) so that
 * bursts of `@bot` mentions — each of which calls `list()` / `resolve()` —
 * don't re-stat every project on every keystroke. The cache is
 * invalidated explicitly via `invalidate()` (e.g. after creating a new
 * project) or implicitly when the TTL expires.
 */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandTilde } from "../utils/path";
import { log } from "../logger";

export interface ProjectEntry {
  /** The name used to reference this project in chat (e.g. "claude-bridge"). */
  name: string;
  /** Absolute path on host. */
  path: string;
  /** Where this entry came from. */
  source: "config" | "scan" | "ad-hoc";
}

export interface ProjectsConfig {
  /** Aliases / overrides keyed by name. */
  projects?: Record<string, string>;
  /** Subdirectory names to exclude from scanning. */
  exclude?: string[];
  /** Subdirectory names to hide from /projects output (but still mountable). */
  hidden?: string[];
}

export class ProjectRegistry {
  private root: string;
  private byName = new Map<string, ProjectEntry>();
  private hidden = new Set<string>();
  private configPath: string | null;
  private config: ProjectsConfig | null = null;
  private lastScanAt = 0;
  private scanCount = 0;

  constructor(
    opts: { root: string; configPath?: string },
    /**
     * Cache TTL in milliseconds. After this many ms since `lastScanAt`,
     * the next `resolve()` / `list()` / `newProjectPath()`-after-list
     * triggers a fresh scan. Set to 0 to disable caching entirely
     * (each call rescans — useful for tests). Default 60s.
     */
    private ttlMs: number = 60_000,
  ) {
    this.root = expandTilde(opts.root);
    this.configPath = opts.configPath
      ? expandTilde(opts.configPath)
      : null;
    this.reload();
  }

  reload(): void {
    this.byName.clear();
    this.hidden.clear();
    this.config = null;

    // 1. Load config
    if (this.configPath && existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, "utf-8");
        const parsed = JSON.parse(raw) as ProjectsConfig;
        this.config = parsed;
        for (const name of parsed.hidden ?? []) this.hidden.add(name);
        for (const [name, path] of Object.entries(parsed.projects ?? {})) {
          const resolved = expandTilde(path);
          this.byName.set(name.toLowerCase(), {
            name,
            path: resolved,
            source: "config",
          });
        }
        log.info("loaded projects config", {
          configPath: this.configPath,
          aliases: Object.keys(parsed.projects ?? {}).length,
          hidden: (parsed.hidden ?? []).length,
          exclude: (parsed.exclude ?? []).length,
        });
      } catch (err) {
        log.warn("failed to load projects config", {
          path: this.configPath,
          err: String(err),
        });
      }
    }

    // 2. Scan root
    if (existsSync(this.root)) {
      try {
        const entries = readdirSync(this.root, { withFileTypes: true });
        let scanned = 0;
        for (const entry of entries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (entry.name.startsWith(".")) continue;
          if (this.hidden.has(entry.name)) continue;
          if (this.config?.exclude?.includes(entry.name)) continue;
          // Don't override config-provided entries
          if (this.byName.has(entry.name.toLowerCase())) continue;
          const fullPath = join(this.root, entry.name);
          // Make sure it resolves to a real directory
          try {
            const st = statSync(fullPath);
            if (!st.isDirectory()) continue;
          } catch {
            continue;
          }
          this.byName.set(entry.name.toLowerCase(), {
            name: entry.name,
            path: fullPath,
            source: "scan",
          });
          scanned++;
        }
        this.lastScanAt = Date.now();
        this.scanCount += 1;
        log.info("scanned projects root", {
          root: this.root,
          scanned,
          total: this.byName.size,
          scanCount: this.scanCount,
        });
      } catch (err) {
        log.warn("failed to scan projects root", {
          root: this.root,
          err: String(err),
        });
      }
    } else {
      log.warn("projects root does not exist", { root: this.root });
    }
  }

  /**
   * Force-clear the cache so the next resolve/list re-scans.
   * Call this after creating a new project (so `@bot new foo` is
   * immediately resolvable) or after manually editing projects.json.
   */
  invalidate(): void {
    this.lastScanAt = 0;
  }

  /**
   * Internal: re-scan only if the TTL has elapsed since the last scan.
   * When ttlMs is 0 (tests), always re-scan. Safe to call from any
   * read accessor — the work is a no-op when the cache is warm.
   */
  private ensureFresh(): void {
    if (this.ttlMs === 0) {
      this.reload();
      return;
    }
    const now = Date.now();
    if (now - this.lastScanAt >= this.ttlMs) {
      this.reload();
    }
  }

  /**
   * Diagnostics: how many scans have happened and when the last one ran.
   * Used by tests + future ops dashboards.
   */
  cacheStats(): { scanCount: number; ageMs: number; ttlMs: number } {
    return {
      scanCount: this.scanCount,
      ageMs: this.lastScanAt === 0 ? Infinity : Date.now() - this.lastScanAt,
      ttlMs: this.ttlMs,
    };
  }

  /** Look up a project by name. Case-insensitive. */
  resolve(name: string): ProjectEntry | null {
    this.ensureFresh();
    return this.byName.get(name.toLowerCase()) ?? null;
  }

  /** List all projects, sorted by name. */
  list(opts: { includeHidden?: boolean } = {}): ProjectEntry[] {
    this.ensureFresh();
    const all = [...this.byName.values()];
    const filtered = opts.includeHidden
      ? all
      : all.filter((p) => !this.hidden.has(p.name));
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Where new projects are created. */
  newProjectPath(name: string): string {
    return join(this.root, name);
  }

  rootPath(): string {
    return this.root;
  }
}
