import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  normalizeRemoteUrl,
  remoteProjectId,
  resolveOpencodeProject,
  OPENCODE_GLOBAL_PROJECT_ID,
} from "../../src/adapters/opencode/project.ts";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acm-proj-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function initRepo(dir: string, remoteUrl?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  if (remoteUrl) git(dir, "remote", "add", "origin", remoteUrl);
  return dir;
}

describe("normalizeRemoteUrl (opencode parity)", () => {
  it("normalizes scp-like urls", () => {
    expect(normalizeRemoteUrl("git@git.mws-team.ru:mws/devp/big-bang/generator.git")).toBe(
      "git.mws-team.ru/mws/devp/big-bang/generator",
    );
  });

  it("normalizes https urls and strips .git", () => {
    expect(normalizeRemoteUrl("https://GitHub.com/owner/repo.git/")).toBe("github.com/owner/repo");
  });

  it("ignores file: urls and garbage", () => {
    expect(normalizeRemoteUrl("file:///srv/repo")).toBeUndefined();
    expect(normalizeRemoteUrl("")).toBeUndefined();
    expect(normalizeRemoteUrl("not a url at all")).toBeUndefined();
  });

  it("remoteProjectId matches opencode's sha1 scheme (verified against a live db)", () => {
    // real opencode 1.18 install: project f206677fd04b50dc81fdf7a0244ba3cfd0524656
    // was resolved from remote git@git.mws-team.ru:mws/devp/big-bang/generator.git
    expect(
      remoteProjectId("git@git.mws-team.ru:mws/devp/big-bang/generator.git"),
    ).toBe("f206677fd04b50dc81fdf7a0244ba3cfd0524656");
  });
});

describe("resolveOpencodeProject", () => {
  it("resolves the global project for non-git directories", () => {
    const dir = path.join(tmp, "plain");
    fs.mkdirSync(dir, { recursive: true });
    const p = resolveOpencodeProject(dir);
    expect(p.projectId).toBe(OPENCODE_GLOBAL_PROJECT_ID);
    expect(p.worktree).toBe("/");
    expect(p.vcs).toBeNull();
  });

  it("resolves remote-based ids for git repositories with an origin remote", () => {
    const repo = initRepo(path.join(tmp, "remote-repo"), "git@example.com:team/tool.git");
    const p = resolveOpencodeProject(repo);
    expect(p.projectId).toBe(remoteProjectId("git@example.com:team/tool.git"));
    expect(p.worktree).toBe(repo);
    expect(p.vcs).toBe("git");
  });

  it("resolves the same id from a subdirectory of the repository", () => {
    const repo = initRepo(path.join(tmp, "remote-sub"), "https://example.com/team/tool.git");
    const sub = path.join(repo, "deep", "nested");
    fs.mkdirSync(sub, { recursive: true });
    expect(resolveOpencodeProject(sub).projectId).toBe(
      resolveOpencodeProject(repo).projectId,
    );
  });

  it("falls back to the <gitdir>/opencode override file when there is no remote", () => {
    const repo = initRepo(path.join(tmp, "override-repo"));
    fs.writeFileSync(path.join(repo, ".git", "opencode"), "my-custom-id\n");
    expect(resolveOpencodeProject(repo).projectId).toBe("my-custom-id");
  });

  it("falls back to the first root commit when no remote and no override exist", () => {
    const repo = initRepo(path.join(tmp, "commit-repo"));
    fs.writeFileSync(path.join(repo, "a.txt"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const root = execFileSync("git", ["-C", repo, "rev-list", "--max-parents=0", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(resolveOpencodeProject(repo).projectId).toBe(root);
  });

  it("remote wins over the override file (opencode priority order)", () => {
    const repo = initRepo(path.join(tmp, "prio-repo"), "git@example.com:team/tool.git");
    fs.writeFileSync(path.join(repo, ".git", "opencode"), "should-lose");
    expect(resolveOpencodeProject(repo).projectId).toBe(
      remoteProjectId("git@example.com:team/tool.git"),
    );
  });
});
