#!/usr/bin/env node
// Lightweight dashboard usability review harness.
// Logs in, walks the main tabs on desktop/mobile, captures screenshots,
// and records obvious runtime/usability issues for later inspection.

import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";

import { chromium, devices } from "playwright";

const DEFAULT_URL = process.env.SWAYAMBHU_UI_URL || "http://localhost:3001/patron/";
const DEFAULT_PATRON_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || "test";
const DEFAULT_OUTPUT_ROOT = process.env.SWAYAMBHU_UI_REVIEW_DIR || "/home/swami/swayambhu/ui-reviews";
const DEFAULT_TIMEOUT_MS = 10000;
const TAB_LABELS = ["Runs", "Chat", "Contacts", "Index", "Deep Reflect", "Modifications", "Mind"];

const VIEWPORT_PRESETS = {
  desktop: {
    viewport: { width: 1440, height: 1024 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
  },
  mobile: {
    ...devices["iPhone 13"],
  },
};

function timestampSlug(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    url: DEFAULT_URL,
    patronKey: DEFAULT_PATRON_KEY,
    outputDir: join(DEFAULT_OUTPUT_ROOT, timestampSlug()),
    headed: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    viewports: ["desktop", "mobile"],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") {
      options.url = argv[++i];
    } else if (arg === "--patron-key") {
      options.patronKey = argv[++i];
    } else if (arg === "--output-dir") {
      options.outputDir = resolve(argv[++i]);
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++i]);
    } else if (arg === "--viewports") {
      options.viewports = String(argv[++i])
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.viewports = [...new Set(options.viewports)];
  for (const viewport of options.viewports) {
    if (!VIEWPORT_PRESETS[viewport]) {
      throw new Error(`Unsupported viewport "${viewport}" (use desktop,mobile)`);
    }
  }
  if (!options.url) throw new Error("Missing --url");
  if (!options.patronKey) throw new Error("Missing --patron-key");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${options.timeoutMs}`);
  }
  return options;
}

function usage() {
  console.log([
    "Usage:",
    "  npm run ui:review -- [options]",
    "",
    "Options:",
    "  --url <url>                 Dashboard URL (default: http://localhost:3001/patron/)",
    "  --patron-key <key>         Patron key (default: test / env override)",
    "  --output-dir <dir>         Where screenshots and report are written",
    "  --viewports desktop,mobile Which viewports to review (default: both)",
    "  --timeout-ms <ms>          Navigation/action timeout",
    "  --headed                   Run a visible browser window",
  ].join("\n"));
}

async function ensureLoggedIn(page, patronKey, timeoutMs) {
  const loginInput = page.getByPlaceholder("Patron key");
  if (await loginInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    await loginInput.fill(patronKey);
    await page.getByRole("button", { name: "Enter", exact: true }).click();
  }
  await page.getByRole("button", { name: "Runs", exact: true }).waitFor({ timeout: timeoutMs });
}

async function gatherViewportIssues(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const messages = [];
    const text = body?.innerText || "";
    const horizontalOverflow = Math.max(doc.scrollWidth, body?.scrollWidth || 0) > doc.clientWidth + 2;
    if (horizontalOverflow) messages.push("horizontal_overflow");

    const errorMarkers = [
      "Failed to load data",
      "Connection failed",
      "Invalid key",
      "Request timed out",
    ].filter((marker) => text.includes(marker));
    for (const marker of errorMarkers) messages.push(`visible_error:${marker}`);

    const loadingMarkers = [
      "Loading contacts...",
      "Loading index...",
      "Loading code staging...",
      "Loading...",
    ].filter((marker) => text.includes(marker));
    for (const marker of loadingMarkers) messages.push(`still_loading:${marker}`);

    return {
      horizontalOverflow,
      visibleMarkers: messages,
    };
  });
}

async function captureTab(page, outputDir, viewportName, tabLabel, index) {
  const button = page.getByRole("button", { name: tabLabel, exact: true });
  await button.click();
  await page.waitForTimeout(1200);
  const issues = await gatherViewportIssues(page);
  const screenshot = `${String(index).padStart(2, "0")}-${viewportName}-${slugify(tabLabel)}.png`;
  await page.screenshot({
    path: join(outputDir, screenshot),
    fullPage: true,
  });
  return {
    tab: tabLabel,
    screenshot,
    ...issues,
  };
}

async function reviewViewport(browser, options, viewportName) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...VIEWPORT_PRESETS[viewportName],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(options.timeoutMs);
  const consoleMessages = [];
  const requestFailures = [];
  const pageErrors = [];

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || "unknown",
    });
  });

  await page.goto(options.url, { waitUntil: "domcontentloaded" });
  await ensureLoggedIn(page, options.patronKey, options.timeoutMs);
  await page.waitForTimeout(1200);

  const viewportDir = join(options.outputDir, viewportName);
  await mkdir(viewportDir, { recursive: true });

  const homeScreenshot = `00-${viewportName}-home.png`;
  await page.screenshot({
    path: join(viewportDir, homeScreenshot),
    fullPage: true,
  });

  const tabs = [];
  for (let index = 0; index < TAB_LABELS.length; index += 1) {
    const tabLabel = TAB_LABELS[index];
    tabs.push(await captureTab(page, viewportDir, viewportName, tabLabel, index + 1));
  }

  await context.close();
  return {
    viewport: viewportName,
    screenshots_dir: viewportDir,
    home_screenshot: homeScreenshot,
    tabs,
    console_messages: consoleMessages,
    request_failures: requestFailures,
    page_errors: pageErrors,
  };
}

function summarizeReport(report) {
  const lines = [];
  lines.push(`# UI Review`);
  lines.push("");
  lines.push(`- URL: ${report.url}`);
  lines.push(`- Generated at: ${report.generated_at}`);
  lines.push(`- Viewports: ${report.viewports.join(", ")}`);
  lines.push("");

  for (const result of report.results) {
    const issueCount = result.tabs.reduce((sum, tab) => sum + tab.visibleMarkers.length, 0)
      + result.console_messages.length
      + result.request_failures.length
      + result.page_errors.length;
    lines.push(`## ${result.viewport}`);
    lines.push(`- Issues observed: ${issueCount}`);
    if (result.console_messages.length) lines.push(`- Console warnings/errors: ${result.console_messages.length}`);
    if (result.request_failures.length) lines.push(`- Request failures: ${result.request_failures.length}`);
    if (result.page_errors.length) lines.push(`- Page errors: ${result.page_errors.length}`);
    for (const tab of result.tabs) {
      if (!tab.visibleMarkers.length && !tab.horizontalOverflow) continue;
      const markers = [...tab.visibleMarkers];
      if (tab.horizontalOverflow) markers.unshift("horizontal_overflow");
      lines.push(`- ${tab.tab}: ${markers.join(", ")}`);
    }
    if (
      !result.console_messages.length
      && !result.request_failures.length
      && !result.page_errors.length
      && result.tabs.every((tab) => !tab.visibleMarkers.length && !tab.horizontalOverflow)
    ) {
      lines.push(`- No obvious runtime/usability issues detected in the scripted pass.`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    usage();
    return;
  }

  await mkdir(options.outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const results = [];
    for (const viewportName of options.viewports) {
      console.log(`[ui-review] reviewing ${viewportName} at ${options.url}`);
      results.push(await reviewViewport(browser, options, viewportName));
    }
    const report = {
      generated_at: new Date().toISOString(),
      url: options.url,
      output_dir: options.outputDir,
      viewports: options.viewports,
      results,
    };
    await writeFile(join(options.outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    await writeFile(join(options.outputDir, "report.md"), summarizeReport(report), "utf8");
    console.log(`[ui-review] wrote ${join(options.outputDir, "report.md")}`);
  } finally {
    await browser.close();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);

if (isMain) {
  main().catch((error) => {
    console.error(`[ui-review] ${error.stack || error.message}`);
    process.exit(1);
  });
}
