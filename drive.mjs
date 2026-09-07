import { connect, canvasBox, shot, clickAt } from "./novnc.mjs";

const c = await connect();
const box = await canvasBox(c.page, c.canvas);

async function typeTo(x, y, text) {
  await clickAt(c.page, box, x, y);
  await c.page.keyboard.press("Control+a");
  await c.page.keyboard.type(text);
  await c.page.waitForTimeout(400);
}

const PHONE = "18663108073";
const URL = "http://127.0.0.1:18099";

await shot(c.page, "/tmp/opencode/g-01-initial.png");

// account
await typeTo(676, 316, PHONE);
await shot(c.page, "/tmp/opencode/g-02-account.png");

// checkbox
await clickAt(c.page, box, 440, 416);
await c.page.waitForTimeout(900);
await shot(c.page, "/tmp/opencode/g-03-checked-server-shown.png");

// server url
await typeTo(600, 443, URL);
await shot(c.page, "/tmp/opencode/g-04-server-url.png");

// click send code at a few candidate centers
for (const [x, y] of [[778, 384], [770, 384], [786, 386]]) {
  await clickAt(c.page, box, x, y);
  await c.page.waitForTimeout(2500);
  await shot(c.page, `/tmp/opencode/g-05-click-${x}-${y}.png`);
}
await shot(c.page, "/tmp/opencode/g-06-final.png");

await c.browser.close();
console.log("drive done");
