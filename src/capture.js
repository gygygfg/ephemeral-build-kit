import { chromium } from "playwright";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { sleep } from "./wait.js";

/**
 * Drive the web-based VM viewer (noVNC) with Playwright to capture
 * periodic screenshots and a full-session video.
 *
 * @param {object} opts
 * @param {string} opts.url            http://localhost:<webPort>/
 * @param {string} opts.screenshotsDir directory for PNGs
 * @param {string} opts.videoDir       directory for the session video
 * @param {number} [opts.screenshotEveryMs=30000]
 * @param {import("./logger.js").logger} opts.log
 * @param {AbortSignal} [opts.signal]  abort stop to finish early
 * @returns {Promise<{screenshots:string, video:string|null}>}
 */
export async function captureSession(opts) {
  const {
    url,
    screenshotsDir,
    videoDir,
    screenshotEveryMs = 30000,
    log,
    signal,
  } = opts;

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
  });
  const context = await browser.newContext({
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  let connected = false;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    log.info(`[capture] Opened viewer at ${url}`);
    await page.waitForTimeout(5000);

    await tryConnect(page, log);
    connected = true;

    let shotIndex = 0;
    const onAbort = () => {
      shotIndex = -1; // sentinel to stop the loop
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // If the signal was already aborted before we attached the listener (e.g. a
    // result marker was detected while the viewer was still connecting), stop
    // immediately instead of capturing until the session is closed.
    if (signal?.aborted) onAbort();

    const shouldStop = () => shotIndex < 0;

    while (!shouldStop()) {
      const file = path.join(screenshotsDir, `shot-${String(shotIndex).padStart(4, "0")}.png`);
      try {
        await page.screenshot({ path: file });
        shotIndex += 1;
        log.info(`[capture] screenshot ${file}`);
      } catch (e) {
        log.warn(`[capture] screenshot failed: ${e.message}`);
      }
      if (shouldStop()) break;
      await sleep(screenshotEveryMs);
    }
    signal?.removeEventListener("abort", onAbort);
  } finally {
    const video = page.video();
    await page.screenshot({
      path: path.join(screenshotsDir, "final.png"),
    }).catch(() => {});
    await context.close().catch(() => {});
    await browser.close();

    let videoPath = null;
    if (video) {
      try {
        videoPath = (await video.path()) ?? null;
      } catch {
        videoPath = null;
      }
    }

    return {
      screenshots: screenshotsDir,
      video: videoPath,
      connected,
    };
  }
}

async function tryConnect(page, log) {
  const attempts = [
    async () => {
      const first = await page.locator("text=/connect/i").first().isVisible().catch(() => false);
      if (first) {
        await page.locator("text=/connect/i").first().click().catch(() => {});
        return true;
      }
      return false;
    },
    async () => {
      // Some viewers (noVNC) connect after pressing on the canvas.
      const canvas = page.locator("canvas").first();
      if (await canvas.isVisible().catch(() => false)) {
        const box = await canvas.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.keyboard.press("Enter").catch(() => {});
          return true;
        }
      }
      return false;
    },
  ];

  for (const attempt of attempts) {
    if (await attempt()) {
      log.info("[capture] Connected to the VM viewer.");
      return;
    }
  }
  log.warn("[capture] Could not auto-connect to the viewer; capturing as-is.");
}

export function writeManifest(dir, data) {
  const file = path.join(dir, "capture.json");
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}
