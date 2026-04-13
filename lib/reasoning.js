import { promises as fs } from "node:fs";
import { join } from "node:path";

export const REASONING_DIR = "/home/swayambhu/reasoning";
export const REASONING_INDEX_PATH = join(REASONING_DIR, "INDEX.md");

export function shouldCompileReasoningArtifact(decision, verdict) {
  return !!decision?.verified
    && verdict?.status === "converged"
    && (verdict?.rounds >= 2 || verdict?.proposal_modified === true);
}

function yamlValue(value) {
  return String(value ?? "").replace(/\n/g, " ").trim();
}

function parseFrontmatter(markdown) {
  if (!markdown?.startsWith("---\n")) return null;

  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) return null;

  const frontmatter = markdown.slice(4, end).split("\n");
  const body = markdown.slice(end + 5);
  const data = {};
  let currentListKey = null;

  for (const line of frontmatter) {
    if (line.startsWith("  - ") && currentListKey) {
      data[currentListKey].push(line.slice(4));
      continue;
    }

    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!match) continue;

    const [, key, value] = match;
    if (value === "") {
      currentListKey = key;
      data[key] = [];
      continue;
    }

    currentListKey = null;
    data[key] = value;
  }

  return { ...data, body };
}

export function renderReasoningArtifact(artifact) {
  const conditions = artifact.conditions_to_revisit || [];
  const frontmatter = [
    "---",
    `slug: ${yamlValue(artifact.slug)}`,
    `summary: ${yamlValue(artifact.summary)}`,
    `decision: ${yamlValue(artifact.decision)}`,
    `created_at: ${yamlValue(artifact.created_at)}`,
    `source: ${yamlValue(artifact.source)}`,
    "conditions_to_revisit:",
    ...conditions.map((condition) => `  - ${yamlValue(condition)}`),
    "---",
    "",
    artifact.body || "",
  ];

  return frontmatter.join("\n");
}

export function renderReasoningIndex(entries) {
  const sorted = [...entries].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return [
    "# Reasoning Artifacts",
    "",
    ...sorted.flatMap((entry) => [
      `- [${entry.slug}](./${entry.slug}.md)`,
      `  - ${entry.summary}`,
      `  - Decision: ${entry.decision}`,
      `  - Created: ${entry.created_at}`,
      "",
    ]),
  ].join("\n").trimEnd() + "\n";
}

export async function loadReasoningArtifacts({ dir = REASONING_DIR, fsImpl = fs } = {}) {
  let dirEntries = [];
  try {
    dirEntries = await fsImpl.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const artifacts = [];
  for (const entry of dirEntries) {
    if (!entry.isFile?.() || !entry.name.endsWith(".md") || entry.name === "INDEX.md") continue;
    const markdown = await fsImpl.readFile(join(dir, entry.name), "utf8");
    const parsed = parseFrontmatter(markdown);
    if (!parsed?.slug) continue;
    artifacts.push(parsed);
  }

  return artifacts.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export async function collectReasoningArtifacts(runDir, decisions, fsImpl = fs) {
  const artifacts = [];

  for (const decision of decisions) {
    if (!decision?.verified) continue;
    const verdict = JSON.parse(await fsImpl.readFile(join(runDir, `verdict-${decision.seq}.json`), "utf8"));
    if (!shouldCompileReasoningArtifact(decision, verdict)) continue;
    if (!verdict.artifact_candidate) continue;

    const proposal = await fsImpl.readFile(join(runDir, `proposal-${decision.seq}.md`), "utf8");
    let response = "";
    for (let round = 1; round <= (verdict.rounds || 0); round++) {
      try {
        response += `\n\n## Response Round ${round}\n\n`;
        response += await fsImpl.readFile(join(runDir, `response-${decision.seq}-round-${round}.md`), "utf8");
      } catch {}
    }

    artifacts.push({
      ...verdict.artifact_candidate,
      body: [
        "## Proposal",
        "",
        proposal,
        response,
        "",
        "## Verdict",
        "",
        "```json",
        JSON.stringify(verdict, null, 2),
        "```",
      ].join("\n"),
      created_at: new Date().toISOString(),
      source: "dev-loop",
    });
  }

  return artifacts;
}

export async function writeReasoningArtifacts(artifacts, { dir = REASONING_DIR, fsImpl = fs } = {}) {
  if (!artifacts?.length) return { written: [], indexEntries: await loadReasoningArtifacts({ dir, fsImpl }) };

  await fsImpl.mkdir(dir, { recursive: true });

  for (const artifact of artifacts) {
    const path = join(dir, `${artifact.slug}.md`);
    await fsImpl.writeFile(path, renderReasoningArtifact(artifact), "utf8");
  }

  const indexEntries = await loadReasoningArtifacts({ dir, fsImpl });
  const mergedBySlug = new Map(indexEntries.map((entry) => [entry.slug, entry]));
  for (const artifact of artifacts) mergedBySlug.set(artifact.slug, artifact);

  const merged = [...mergedBySlug.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const indexPath = join(dir, "INDEX.md");
  await fsImpl.writeFile(indexPath, renderReasoningIndex(merged), "utf8");
  return { written: artifacts.map((x) => x.slug), indexEntries: merged };
}
