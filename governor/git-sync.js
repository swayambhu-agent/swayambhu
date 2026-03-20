// Governor — Git Sync
// Commits changed files to GitHub after a successful deploy.
// Uses the GitHub Git Data API for atomic multi-file commits.
// Best-effort — failure never blocks deployment.

const GH_API = "https://api.github.com";

async function ghFetch(path, token, opts = {}) {
  const resp = await fetch(`${GH_API}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API ${opts.method || "GET"} ${path} failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// Commit changed files atomically to the repo.
// changedFiles: { "tools/kv_query.js": "...source...", "act.js": "...source..." }
export async function syncToGitHub(env, changedFiles, commitMessage) {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";

  if (!token || !repo) return;

  const paths = Object.keys(changedFiles);
  if (paths.length === 0) return;

  // 1. Get current HEAD
  const ref = await ghFetch(`/repos/${repo}/git/ref/heads/${branch}`, token);
  const headSha = ref.object.sha;

  // 2. Get base tree from HEAD commit
  const headCommit = await ghFetch(`/repos/${repo}/git/commits/${headSha}`, token);
  const baseTreeSha = headCommit.tree.sha;

  // 3. Create new tree with changed files
  const tree = paths.map(path => ({
    path,
    mode: "100644",
    type: "blob",
    content: changedFiles[path],
  }));

  const newTree = await ghFetch(`/repos/${repo}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });

  // 4. Create commit
  const newCommit = await ghFetch(`/repos/${repo}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify({
      message: commitMessage,
      tree: newTree.sha,
      parents: [headSha],
    }),
  });

  // 5. Update branch ref to new commit
  await ghFetch(`/repos/${repo}/git/refs/heads/${branch}`, token, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommit.sha }),
  });

  return { sha: newCommit.sha, files: paths.length };
}
