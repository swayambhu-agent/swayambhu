#!/usr/bin/env node

import * as childProcess from "child_process";
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "fs/promises";
import { dirname, resolve, relative } from "path";
import { pathToFileURL } from "url";

import { generateIndexJS, readCodeFromKV } from "../governor/builder.js";
import { dispose, getKV, root as REPO_ROOT, resolveStateDir } from "./shared.mjs";

async function writeGeneratedFile(rootDir, relativePath, content) {
  const target = resolve(rootDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

const REQUIRED_RUNTIME_FILES = [
  "kernel.js",
  "hook-communication.js",
  "userspace.js",
  "act.js",
  "reflect.js",
];

const FIXED_RUNTIME_FILES = ["eval.js", "memory.js", "meta-policy.js"];
const FIXED_RUNTIME_DIRS = ["lib"];

function readGitHeadFile(relativePath) {
  try {
    return childProcess.execFileSync("git", ["show", `HEAD:${relativePath}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error?.status === 128) return null;
    throw error;
  }
}

async function listFilesFromFilesystem(relativeDir) {
  const baseDir = resolve(REPO_ROOT, relativeDir);
  const results = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath);
        continue;
      }
      const relPath = relative(REPO_ROOT, childPath).replace(/\\/g, "/");
      results.push(relPath);
    }
  }

  await walk(baseDir);
  return results.sort();
}

export async function listStableDependencyFiles(relativeDir, execFileSyncImpl = childProcess.execFileSync) {
  try {
    const output = execFileSyncImpl("git", ["ls-tree", "-r", "--name-only", "HEAD", relativeDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error?.status !== 128) throw error;
    return listFilesFromFilesystem(relativeDir);
  }
}

async function readStableDependencyFile(relativePath) {
  const gitVersion = readGitHeadFile(relativePath);
  if (gitVersion != null) {
    return { content: gitVersion, source: "git-head" };
  }
  return {
    content: await readFile(resolve(REPO_ROOT, relativePath), "utf8"),
    source: "working-tree-fallback",
  };
}

export async function materializeRuntimeWorkspace({ stateDir, workspaceDir }) {
  const kv = await getKV({ stateDir });
  try {
    const resolvedStateDir = resolveStateDir({ stateDir });
    const resolvedWorkspaceDir = resolve(workspaceDir);
    const stagingWorkspaceDir = `${resolvedWorkspaceDir}.tmp`;
    const previousWorkspaceDir = `${resolvedWorkspaceDir}.prev`;

    const { files, metadata } = await readCodeFromKV(kv);
    files["index.js"] = generateIndexJS(metadata);

    for (const required of REQUIRED_RUNTIME_FILES) {
      if (!files[required]) {
        throw new Error(`runtime workspace missing required canonical file: ${required}`);
      }
    }

    const wranglerConfig = (await readStableDependencyFile("wrangler.dev.toml")).content;
    const dependencySources = {};

    await rm(stagingWorkspaceDir, { recursive: true, force: true });
    await rm(previousWorkspaceDir, { recursive: true, force: true });
    await mkdir(stagingWorkspaceDir, { recursive: true });

    for (const [relativePath, content] of Object.entries(files)) {
      await writeGeneratedFile(stagingWorkspaceDir, relativePath, content);
    }

    for (const dependency of FIXED_RUNTIME_FILES) {
      const resolved = await readStableDependencyFile(dependency);
      dependencySources[dependency] = resolved.source;
      await writeGeneratedFile(stagingWorkspaceDir, dependency, resolved.content);
    }
    for (const directory of FIXED_RUNTIME_DIRS) {
      for (const file of await listStableDependencyFiles(directory)) {
        const resolved = await readStableDependencyFile(file);
        dependencySources[file] = resolved.source;
        await writeGeneratedFile(stagingWorkspaceDir, file, resolved.content);
      }
    }

    await writeGeneratedFile(stagingWorkspaceDir, "wrangler.dev.toml", wranglerConfig);
    await symlink(resolve(REPO_ROOT, "node_modules"), resolve(stagingWorkspaceDir, "node_modules"));

    await writeGeneratedFile(
      stagingWorkspaceDir,
      ".state-lab-runtime.json",
      JSON.stringify({
        generated_at: new Date().toISOString(),
        state_dir: resolvedStateDir,
        workspace_root: resolvedWorkspaceDir,
        source: "canonical-kv",
        files: Object.keys(files).sort(),
        fixed_dependencies: [...FIXED_RUNTIME_FILES, ...FIXED_RUNTIME_DIRS],
        fixed_dependency_sources: dependencySources,
        repo_root: REPO_ROOT,
      }, null, 2) + "\n",
    );
    await writeGeneratedFile(stagingWorkspaceDir, ".materialized", "ok\n");

    try {
    await rename(resolvedWorkspaceDir, previousWorkspaceDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rename(stagingWorkspaceDir, resolvedWorkspaceDir);

  return {
      workspaceDir: resolvedWorkspaceDir,
      stateDir: resolvedStateDir,
      files: Object.keys(files).sort(),
    };
  } finally {
    await dispose();
  }
}

async function main(argv = process.argv.slice(2)) {
  const [workspaceDir] = argv;
  if (!workspaceDir) {
    throw new Error("usage: node scripts/materialize-runtime-workspace.mjs <workspace-dir>");
  }

  const result = await materializeRuntimeWorkspace({
    stateDir: process.env.SWAYAMBHU_PERSIST_DIR,
    workspaceDir,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    try {
      await dispose();
    } catch {}
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
