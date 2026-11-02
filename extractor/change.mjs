// The change under review: one commit (--change) or a PR range (--base/--head).
// Its head tree is what gets extracted, and its diff marks the nodes it touched.

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { coded } from "./errors.mjs";

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"], ...options });
}

export function resolveCommit(repo, ref, flag) {
  try {
    return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).toString().trim();
  } catch {
    throw coded("NOT_A_COMMIT", `${flag} ${ref}: not a commit in ${repo}`, "Pass a branch, tag or SHA that `git rev-parse` resolves; fetch the PR's refs first.", ref);
  }
}

// --change SHA reviews one commit; --base/--head review everything head adds since it left base.
export function resolveChange(repo, { change, base, head }) {
  if (change && (base || head)) throw coded("BAD_ARGUMENT", "--change cannot be combined with --base or --head", "Use --change SHA for one commit, or --base REF [--head REF] for a range.");
  if (head && !base) throw coded("BAD_ARGUMENT", "--head needs --base", "Pass --base REF (the PR's target branch) with --head.");
  if (change) {
    const headSha = resolveCommit(repo, change, "--change");
    const baseSha = resolveCommit(repo, `${headSha}^`, "--change");
    return { baseSha, headSha };
  }
  if (!base) return null;
  const headSha = resolveCommit(repo, head || "HEAD", "--head");
  const baseRef = resolveCommit(repo, base, "--base");
  const baseSha = git(repo, ["merge-base", baseRef, headSha]).toString().trim();
  return { baseSha, headSha };
}

// The head's version of the code, read-only: nothing in the repo changes.
export function checkoutTree(repo, sha, dest, dirs) {
  if (existsSync(dest)) return dest;
  const prefix = git(repo, ["rev-parse", "--show-prefix"]).toString().trim();
  const top = git(repo, ["rev-parse", "--show-toplevel"]).toString().trim();
  // Pathspecs are read relative to the archived tree only from the top level.
  const present = dirs.filter((d) => git(top, ["ls-tree", "--name-only", `${sha}:${prefix}`, d]).toString().trim());
  const tar = git(top, ["archive", "--format=tar", `${sha}:${prefix}`, ...present]);
  const partial = `${dest}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  execFileSync("tar", ["-x", "-C", partial], { input: tar, maxBuffer: 1 << 30 });
  renameSync(partial, dest);
  return dest;
}

export function readChange(repo, { baseSha, headSha }) {
  const prefix = git(repo, ["rev-parse", "--show-prefix"]).toString().trim();
  const short = (sha) => git(repo, ["rev-parse", "--short", sha]).toString().trim();
  const subjects = git(repo, ["log", "--format=%s", `${baseSha}..${headSha}`]).toString().trim().split("\n").filter(Boolean);
  const single = subjects.length === 1;
  const label = single ? short(headSha) : `${short(baseSha)}..${short(headSha)}`;
  const title = single ? subjects[0] : `${subjects.length} commits, latest: ${subjects[0] || "(none)"}`;
  const diff = git(repo, ["diff", "--unified=0", "--no-color", "--no-ext-diff", baseSha, headSha, "--", "."]).toString();

  const files = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      if (file && prefix && file.startsWith(prefix)) file = file.slice(prefix.length);
      continue;
    }
    const m = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m || !file) continue;
    const removed = m[1] === undefined ? 1 : Number(m[1]);
    const start = Number(m[2]);
    const added = m[3] === undefined ? 1 : Number(m[3]);
    const hunk = added > 0
      ? { file, start, end: start + added - 1, pureAdd: removed === 0 }
      : { file, start: Math.max(start, 1), end: Math.max(start, 1), pureAdd: false };
    if (!files.has(file)) files.set(file, []);
    files.get(file).push(hunk);
  }
  return { baseSha, headSha, label, title, files, hunks: [...files.values()].flat() };
}

// Marks the most specific nodes each hunk touches. A step fully inside added
// lines is "added"; anything else touched is "modified".
export function markChanges(graph, ranges, change) {
  const hits = new Map();
  const matched = new Set();
  for (const [nid, r] of ranges) {
    const touching = (change.files.get(r.file) || []).filter((h) => h.start <= r.end && h.end >= r.start);
    if (!touching.length) continue;
    touching.forEach((h) => matched.add(h));
    const added = touching.every((h) => h.pureAdd && h.start <= r.start && h.end >= r.end);
    hits.set(nid, added ? "added" : "modified");
  }
  for (const nid of [...hits.keys()]) {
    const inside = nid.includes("~") ? `${nid}.` : `${nid}~`;
    if ([...hits.keys()].some((other) => other.startsWith(inside))) hits.delete(nid);
  }
  for (const [nid, kind] of hits) graph.nodes[nid].change = kind;
  graph.change = { commit: change.label, title: change.title };
  return { marked: hits.size, unmatched: change.hunks.filter((h) => !matched.has(h)) };
}
