#!/usr/bin/env node
// Rewrite the docs' repo-relative links to absolute URLs for the published
// GitHub Pages site. The committed docs deliberately keep relative links (which
// render correctly when browsing the repo on GitHub); this runs in the Pages
// build on an ephemeral checkout, so the committed files are never changed.
//
//   ](../<path>)     → GitHub blob/tree URL for that repo file/dir
//   ](../../<name>)  → the sibling repo's GitHub Pages site
//
// Owner/repo/branch come from the GitHub Actions context (GITHUB_REPOSITORY*,
// GITHUB_REF_NAME), so it works under any owner without hardcoding.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoFull = process.env.GITHUB_REPOSITORY || '';
const owner = process.env.GITHUB_REPOSITORY_OWNER || repoFull.split('/')[0] || '';
const repo = repoFull.split('/')[1] || '';
const branch = process.env.GITHUB_REF_NAME || 'main';
if (!owner || !repo) {
  console.error('rewrite-doc-links: set GITHUB_REPOSITORY and GITHUB_REPOSITORY_OWNER');
  process.exit(1);
}
const ghBase = `https://github.com/${owner}/${repo}`;

const rewriteTarget = (t) => {
  // sibling repo: ../../<name> → that repo's Pages site
  let m = t.match(/^\.\.\/\.\.\/([^/#?]+)\/?$/);
  if (m) return `https://${owner}.github.io/${m[1]}/`;
  // this repo's file or directory: ../<path>
  m = t.match(/^\.\.\/(.+)$/);
  if (m) {
    const rest = m[1];
    const kind = rest.endsWith('/') ? 'tree' : 'blob'; // dir vs file on GitHub
    return `${ghBase}/${kind}/${branch}/${rest}`;
  }
  return t;
};

const dir = 'docs';
let changed = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
  const p = path.join(dir, f);
  const src = readFileSync(p, 'utf8');
  const out = src.replace(/\]\((\.\.[^)\s]*)\)/g, (_, target) => `](${rewriteTarget(target)})`);
  if (out !== src) {
    writeFileSync(p, out);
    changed += 1;
  }
}
console.log(`rewrote docs links in ${changed} file(s) for ${owner}/${repo}@${branch}`);
