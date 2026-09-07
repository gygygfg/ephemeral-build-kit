import { connect, canvasBox, shot, clickAt } from "./novnc.mjs";

const c = await connect();
const box = await canvasBox(c.page, c.canvas);

// focus server input field
await clickAt(c.page, box, 600, 443);
await c.page.waitForTimeout(300);

// Shift+Tab to send-code button, then press Space to activate
await c.page.keyboard.press("Shift+Tab");
await c.page.keyboard.press("Shift+Tab");
await c.page.waitForTimeout(300);
await shot(c.page, "/tmp/opencode/k-1-focus.png");
await c.page.keyboard.press("Space");
await c.page.waitForTimeout(2500);
await shot(c.page, "/tmp/opencode/k-2-after-space.png");

await c.browser.close();
console.log("kbd done");
