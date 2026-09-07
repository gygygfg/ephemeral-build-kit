import { chromium } from "playwright";
import fs from "node:fs";

const URL = process.env.NOVNC_URL || "http://localhost:8066/";

export async function connect() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const page = await browser.newContext({ viewport: { width: 1280, height: 720 } }).then(c => c.newPage());
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  // try to connect (noVNC may show a Connect button)
  const conn = page.locator("text=/connect/i").first();
  if (await conn.isVisible().catch(() => false)) {
    await conn.click().catch(() => {});
    await page.waitForTimeout(5000);
  }
  // fallback: click center of canvas
  const canvas = page.locator("canvas").first();
  if (await canvas.isVisible().catch(() => false)) {
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.press("Enter").catch(() => {});
    }
  }
  await page.waitForTimeout(5000);
  return { browser, page, canvas: page.locator("canvas").first() };
}

export async function canvasBox(page, canvas) {
  const box = await canvas.boundingBox();
  return box;
}

export async function shot(page, file) {
  await page.screenshot({ path: file });
  return file;
}

export async function clickAt(page, box, x, y) {
  await page.mouse.click(box.x + x, box.y + y);
}

export async function typeText(page, text) {
  await page.keyboard.type(text);
}
