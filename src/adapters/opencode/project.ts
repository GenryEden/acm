import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * Project resolution for opencode targets, mirroring opencode's own
 * `Project.resolve` (verified against opencode 1.18.x):
 *
 *  1. Discover a git repository by walking up from the target directory
 *     looking for `.git` (dir or linked-worktree pointer file).
 *  2. No repository → the fixed `global` project (worktree `/`, no vcs).
 *  3. Repository → project id, in priority order:
 *       a. sha1(`git-remote:<host>/<owner>/<repo>`) of the `origin` remote
 *          (host lowercased, path stripped of leading `/` and trailing `.git`),
 *       b. the `<git-common-dir>/opencode` override file contents,
 *       c. the repository's first root commit hash,
 *       d. `global` as the final fallback.
 *
 * This matters because `opencode session list` (and the TUI) filter sessions
 * by the project id resolved for the current directory — a session stored
 * under any other project id is invisible to the native tooling.
 */

export const OPENCODE_GLOBAL_PROJECT_ID = "global";

export interface OpencodeProjectRef {
  projectId: string;
  /** Git worktree root (`/` for the global project). */
  worktree: string;
  vcs: "git" | null;
}

interface GitRepo {
  worktree: string;
  gitDir: string;
  commonDir: string;
}

/** Walk up from `cwd` looking for `.git` (directory or pointer file). */
function discoverGit(cwd: string): GitRepo | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    if (fs.existsSync(dotGit)) {
      let gitDir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        // linked worktree: ".git" file contains "gitdir: <path>"
        const content = fs.readFileSync(dotGit, "utf8").trim();
        const m = content.match(/^gitdir:\s*(.+)$/);
        if (!m) return null;
        gitDir = path.resolve(dir, m[1].trim());
      }
      // commondir: relative to gitDir when present (linked worktrees)
      let commonDir = gitDir;
      const commondirPath = path.join(gitDir, "commondir");
      if (fs.existsSync(commondirPath)) {
        const rel = fs.readFileSync(commondirPath, "utf8").trim();
        if (rel) commonDir = path.resolve(gitDir, rel);
      }
      return { worktree: dir, gitDir, commonDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Normalize a git remote URL to `<host>/<owner>/<repo>`, mirroring
 * opencode's normalization: URL form uses hostname + pathname; scp-like
 * `user@host:path` is matched without a protocol; `file:` URLs are ignored;
 * the path loses leading slashes and a trailing `.git`.
 */
export function normalizeRemoteUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  const build = (host: string, p: string): string | undefined => {
    const repo = p.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "");
    if (!host || !repo) return undefined;
    return `${host.toLowerCase()}/${repo}`;
  };
  try {
    const u = new URL(trimmed);
    if (u.protocol === "file:") return undefined;
    return build(u.hostname, u.pathname);
  } catch {
    const m = trimmed.match(/^([^@/:]+@)?([^/:]+):(.+)$/);
    if (m) return build(m[2], m[3]);
    return undefined;
  }
}

/** Read the `origin` remote URL from a git config file (no spawning). */
function readOriginUrl(configPath: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  let inOrigin = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(/^\[\s*remote\s+"([^"]*)"\s*\]$/);
    if (section) {
      inOrigin = section[1] === "origin";
      continue;
    }
    if (line.startsWith("[")) {
      inOrigin = false;
      continue;
    }
    if (inOrigin) {
      const kv = line.match(/^url\s*=\s*(.+)$/);
      if (kv) return kv[1].trim();
    }
  }
  return undefined;
}

/** First root commit of the repo (only needed when there is no remote). */
function rootCommit(worktree: string): string | undefined {
  try {
    const out = execFileSync(
      "git",
      ["-C", worktree, "rev-list", "--max-parents=0", "HEAD"],
      { encoding: "utf8", timeout: 5000 },
    );
    return out.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
  } catch {
    return undefined;
  }
}

/** Read the `<git-common-dir>/opencode` project-id override file. */
function readOverride(commonDir: string): string | undefined {
  try {
    const content = fs.readFileSync(path.join(commonDir, "opencode"), "utf8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

/** Project id opencode itself would resolve for a directory. */
export function remoteProjectId(url: string): string | undefined {
  const norm = normalizeRemoteUrl(url);
  if (!norm) return undefined;
  return crypto.createHash("sha1").update(`git-remote:${norm}`).digest("hex");
}

/**
 * Resolve the opencode project for a target directory exactly the way
 * opencode's `Project.resolve` does (see module comment for the rules).
 */
export function resolveOpencodeProject(cwd: string): OpencodeProjectRef {
  const repo = discoverGit(cwd);
  if (!repo) {
    return { projectId: OPENCODE_GLOBAL_PROJECT_ID, worktree: path.parse(path.resolve(cwd)).root, vcs: null };
  }
  const remoteId = (() => {
    const url = readOriginUrl(path.join(repo.commonDir, "config"));
    return url ? remoteProjectId(url) : undefined;
  })();
  const overrideId = readOverride(repo.commonDir);
  const rootCommitId = remoteId || overrideId ? undefined : rootCommit(repo.worktree);
  const projectId = remoteId ?? overrideId ?? rootCommitId ?? OPENCODE_GLOBAL_PROJECT_ID;
  return { projectId, worktree: repo.worktree, vcs: "git" };
}
