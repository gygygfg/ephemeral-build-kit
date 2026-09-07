import { connect, canvasBox, shot, clickAt } from "./novnc.mjs";

const c = await connect();
const box = await canvasBox(c.page, c.canvas);

async function holdClick(x, y) {
  await c.page.mouse.move(box.x + x, box.y + y);
  await c.page.waitForTimeout(120);
  await c.page.mouse.down();
  await c.page.waitForTimeout(150);
  await c.page.mouse.up();
  await c.page.waitForTimeout(1500);
}

for (const [x, y] of [[771, 384], [779, 384], [784, 386]]) {
  await holdClick(x, y);
  await c.page.waitForTimeout(2500);
  await shot(c.page, `/tmp/opencode/p-h-${x}-${y}.png`);
}
await c.browser.close();
console.log("press done");
