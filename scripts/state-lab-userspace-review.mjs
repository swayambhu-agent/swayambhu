#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import { keyToFilePath } from "../governor/builder.js";
import {
  loadDotEnv,
  nowTimestamp,
  runSelectedRunner,
  slugifyLabel,
} from "../lib/userspace-review/cli.js";
import {
  normalizeSpec,
  targetRelativePathForSource,
  collectDirectSourceKeys,
  buildLiveReviewSpec,
  buildOverview,
  buildReviewPrompt as buildPrompt,
  extractJsonFromString,
} from "../lib/userspace-review/spec.js";
import { getDefaultServiceUrls } from "./dev-loop/services.mjs";
import { getKV, dispose as disposeKV } from "./shared.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
const REVIEWS_DIR = join(STATE_LAB_DIR, "reviews");
const DEFAULT_URLS = getDefaultServiceUrls();
const DEFAULT_RUNNER = process.env.SWAYAMBHU_USERSPACE_REVIEW_RUNNER || "codex";
const DEFAULT_TIMEOUT_MS = Number(process.env.SWAYAMBHU_USERSPACE_REVIEW_TIMEOUT_MS || 180000);
const DEFAULT_CODEX_PROFILE = process.env.SWAYAMBHU_USERSPACE_REVIEW_CODEX_PROFILE || null;
const DEFAULT_CLAUDE_MODEL = process.env.SWAYAMBHU_USERSPACE_REVIEW_CLAUDE_MODEL || "opus";
const DEFAULT_CODEX_MODEL = process.env.SWAYAMBHU_USERSPACE_REVIEW_CODEX_MODEL || null;
const DEFAULT_GEMINI_MODEL = process.env.SWAYAMBHU_USERSPACE_REVIEW_GEMINI_MODEL || "gemini-2.5-flash";
const DEFAULT_INPUT_SOURCE = process.env.SWAYAMBHU_USERSPACE_REVIEW_INPUT_SOURCE || "dashboard";
const DEFAULT_DASHBOARD_URL = process.env.SWAYAMBHU_DASHBOARD_URL || DEFAULT_URLS.dashboardUrl;
const DEFAULT_PATRON_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || "test";
const DEFAULT_BUNDLE_DIR = process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR || null;
const REVIEW_SCHEMA_PATH = join(ROOT, "schemas", "userspace-review-result.schema.json");

function parseArgs(argv) {
  const args = {
    specPath: null,
    reviewNoteKey: null,
    label: null,
    runner: DEFAULT_RUNNER,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    codexProfile: DEFAULT_CODEX_PROFILE,
    claudeModel: DEFAULT_CLAUDE_MODEL,
    codexModel: DEFAULT_CODEX_MODEL,
    geminiModel: DEFAULT_GEMINI_MODEL,
    inputSource: DEFAULT_INPUT_SOURCE,
    dashboardUrl: DEFAULT_DASHBOARD_URL,
    patronKey: DEFAULT_PATRON_KEY,
    bundleDir: DEFAULT_BUNDLE_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec") {
      args.specPath = argv[++i];
    } else if (arg === "--review-note-key") {
      args.reviewNoteKey = argv[++i];
    } else if (arg === "--label") {
      args.label = argv[++i];
    } else if (arg === "--runner") {
      args.runner = argv[++i];
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++i]);
    } else if (arg === "--codex-profile") {
      args.codexProfile = argv[++i];
    } else if (arg === "--claude-model") {
      args.claudeModel = argv[++i];
    } else if (arg === "--codex-model") {
      args.codexModel = argv[++i];
    } else if (arg === "--gemini-model") {
      args.geminiModel = argv[++i];
    } else if (arg === "--input-source") {
      args.inputSource = argv[++i];
    } else if (arg === "--dashboard-url") {
      args.dashboardUrl = argv[++i];
    } else if (arg === "--patron-key") {
      args.patronKey = argv[++i];
    } else if (arg === "--bundle-dir") {
      args.bundleDir = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  return args;
}

function usage() {
  console.log([
    "Usage:",
    "  node scripts/state-lab-userspace-review.mjs --spec <spec.json> [--label <name>] [--runner codex|claude|gemini]",
    "  node scripts/state-lab-userspace-review.mjs --review-note-key <review_note:...> [--label <name>] [--runner codex|claude|gemini] [--input-source dashboard|kv|bundle]",
  ].join("\n"));
}

export {
  normalizeSpec,
  targetRelativePathForSource,
  collectDirectSourceKeys,
  buildLiveReviewSpec,
  buildOverview,
  buildPrompt,
  extractJsonFromString,
};

function resolveInputPath(inputPath, specDir) {
  if (isAbsolute(inputPath)) return inputPath;
  const repoResolved = resolve(ROOT, inputPath);
  if (existsSync(repoResolved)) return repoResolved;
  return resolve(specDir, inputPath);
}

function sourceKeyToFilename(sourceKey) {
  const repoPath = keyToFilePath(sourceKey);
  if (repoPath) return join("live", repoPath);
  return join("live", `${String(sourceKey).replace(/[^A-Za-z0-9._-]+/g, "-")}.txt`);
}

async function fetchJson(url, { patronKey = DEFAULT_PATRON_KEY, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "X-Patron-Key": patronKey },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} from ${url}: ${body || res.statusText}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function bundledKeyPath(bundleDir, key) {
  return join(resolve(bundleDir), ...String(key).split(":")) + ".json";
}

async function readBundleValue(bundleDir, key) {
  if (!bundleDir) return null;
  const bundlePath = bundledKeyPath(bundleDir, key);
  if (existsSync(bundlePath)) {
    const raw = await readFile(bundlePath, "utf8");
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  const repoPath = keyToFilePath(key);
  if (repoPath) {
    const absoluteRepoPath = resolve(ROOT, repoPath);
    if (existsSync(absoluteRepoPath)) {
      const raw = await readFile(absoluteRepoPath, "utf8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
  }

  return null;
}

async function createInputReader({ inputSource, dashboardUrl, patronKey, bundleDir }) {
  if (inputSource === "bundle") {
    const resolvedBundleDir = bundleDir || DEFAULT_BUNDLE_DIR;
    if (!resolvedBundleDir) {
      throw new Error("bundle input source requires --bundle-dir or SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR");
    }
    return {
      async get(key) {
        return readBundleValue(resolvedBundleDir, key);
      },
      async dispose() {},
    };
  }

  if (inputSource === "dashboard") {
    return {
      async get(key) {
        const data = await fetchJson(
          `${dashboardUrl}/kv/multi?keys=${encodeURIComponent(key)}`,
          { patronKey },
        );
        return data[key];
      },
      async dispose() {},
    };
  }

  const kv = await getKV();
  return {
    async get(key) {
      try {
        return await kv.get(key, "json");
      } catch {
        return await kv.get(key, "text");
      }
    },
    async dispose() {
      await disposeKV();
    },
  };
}

async function materializeGeneratedSpec(runDir, generatedSpec) {
  const generatedDir = join(runDir, "generated-inputs");
  await mkdir(generatedDir, { recursive: true });
  const files = [];

  for (const [index, file] of (generatedSpec.files || []).entries()) {
    const filename = file.filename || `${String(index).padStart(2, "0")}.txt`;
    const targetPath = join(generatedDir, filename);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, "utf8");
    files.push({ path: targetPath, kind: file.kind || "artifact" });
  }

  return {
    question: generatedSpec.question,
    notes: generatedSpec.notes || [],
    files,
  };
}

async function buildSpecFromReviewNote(args, runDir) {
  const reader = await createInputReader(args);
  try {
    const reviewNote = await reader.get(args.reviewNoteKey);
    if (!reviewNote || typeof reviewNote !== "object") {
      throw new Error(`Review note not found or invalid: ${args.reviewNoteKey}`);
    }
    if (!reviewNote.summary) {
      console.error(`[userspace-review] Warning: ${args.reviewNoteKey} has no summary; generated question may be weak.`);
    }

    const sourceReflectKey = reviewNote.source_reflect_key || null;
    const [
      sourceReflect,
      lastReflect,
      defaults,
      promptPlan,
      promptReflect,
      promptDeepReflect,
      sourceMap,
    ] = await Promise.all([
      sourceReflectKey ? reader.get(sourceReflectKey) : Promise.resolve(null),
      reader.get("last_reflect"),
      reader.get("config:defaults"),
      reader.get("prompt:plan"),
      reader.get("prompt:reflect"),
      reader.get("prompt:deep_reflect"),
      reader.get("kernel:source_map"),
    ]);
    if (sourceReflectKey && !sourceReflect) {
      console.error(`[userspace-review] Warning: source_reflect_key ${sourceReflectKey} was not found.`);
    }

    const directSourceKeys = collectDirectSourceKeys(sourceMap);
    const sourceTexts = Object.fromEntries(
      await Promise.all(
        directSourceKeys.map(async (sourceKey) => [sourceKey, await reader.get(sourceKey)]),
      ),
    );

    const generatedSpec = buildLiveReviewSpec({
      reviewNoteKey: args.reviewNoteKey,
      reviewNote,
      sourceReflectKey,
      sourceReflect,
      lastReflect,
      defaults,
      prompts: {
        plan: promptPlan,
        reflect: promptReflect,
        deep_reflect: promptDeepReflect,
      },
      sourceMap,
      sourceTexts,
      keyToFilePath,
    });

    return materializeGeneratedSpec(runDir, generatedSpec);
  } finally {
    await reader.dispose();
  }
}

async function copyContextFiles(runDir, spec, specDir) {
  const contextDir = join(runDir, "context");
  const filesDir = join(contextDir, "files");
  await mkdir(filesDir, { recursive: true });

  const manifest = [];
  for (let index = 0; index < spec.files.length; index += 1) {
    const entry = spec.files[index];
    const sourcePath = resolveInputPath(entry.path, specDir);
    const targetRel = targetRelativePathForSource(sourcePath, index);
    const targetPath = join(filesDir, targetRel);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });
    manifest.push({
      source_path: sourcePath,
      relative_path: join("context", "files", targetRel),
      kind: entry.kind,
    });
  }

  return { contextDir, manifest };
}

async function main(argv = process.argv.slice(2)) {
  loadDotEnv(ROOT);
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  if ((args.specPath && args.reviewNoteKey) || (!args.specPath && !args.reviewNoteKey)) {
    usage();
    throw new Error("Provide exactly one of --spec or --review-note-key");
  }

  const labelSeed = args.label || args.reviewNoteKey || basename(args.specPath, extname(args.specPath));
  const label = slugifyLabel(labelSeed, "userspace-review");
  const runDir = join(REVIEWS_DIR, `${nowTimestamp()}-${label}`);

  await mkdir(runDir, { recursive: true });
  let spec;
  let resolvedSpecPath = null;
  let specDir = runDir;
  if (args.specPath) {
    resolvedSpecPath = resolve(args.specPath);
    const rawSpec = JSON.parse(await readFile(resolvedSpecPath, "utf8"));
    spec = normalizeSpec(rawSpec, resolvedSpecPath);
    specDir = dirname(resolvedSpecPath);
  } else {
    spec = await buildSpecFromReviewNote(args, runDir);
  }

  const { contextDir, manifest } = await copyContextFiles(runDir, spec, specDir);
  await writeFile(join(contextDir, "manifest.json"), JSON.stringify({
    question: spec.question,
    notes: spec.notes,
    files: manifest,
  }, null, 2), "utf8");
  await writeFile(join(contextDir, "overview.md"), buildOverview(spec, manifest), "utf8");

  const basePrompt = await readFile(join(ROOT, "prompts/userspace_review.md"), "utf8");
  const prompt = buildPrompt(basePrompt);
  await writeFile(join(runDir, "prompt.userspace-review.md"), prompt, "utf8");

  const startedAt = new Date().toISOString();
  const result = await runSelectedRunner({
    runner: args.runner,
    prompt,
    runDir,
    timeoutMs: args.timeoutMs,
    claudeModel: args.claudeModel,
    codexModel: args.codexModel,
    codexProfile: args.codexProfile,
    geminiModel: args.geminiModel,
    claudeOptions: {
      cwd: runDir,
      promptMode: "arg",
      extraArgs: ["--no-session-persistence"],
    },
    codexOptions: {
      cwd: runDir,
      commandCwd: ROOT,
      outputSchemaPath: REVIEW_SCHEMA_PATH,
    },
    geminiOptions: {
      cwd: runDir,
      parseEnvelopeResponse: extractJsonFromString,
    },
  });

  const artifact = {
    review_role: "userspace_review",
    question: spec.question,
    spec_path: resolvedSpecPath || null,
    runner: args.runner,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    parse_ok: result.parse_ok,
    payload: result.payload,
    meta: result.meta || null,
    raw_path: result.raw_path,
    stdout_path: result.stdout_path || null,
    stderr_path: result.stderr_path || null,
    timed_out: result.timed_out,
    exit_code: result.exit_code,
    error: result.error || null,
    context_manifest_path: join(contextDir, "manifest.json"),
  };
  await writeFile(join(runDir, "userspace-review-result.json"), JSON.stringify(artifact, null, 2), "utf8");

  console.log(`Userspace review complete: ${runDir}`);
  console.log(`  runner: ${args.runner}`);
  console.log(`  parse_ok: ${result.parse_ok}`);
  console.log(`  result: ${join(runDir, "userspace-review-result.json")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`userspace-review: ${error.message}`);
    process.exit(1);
  });
}
