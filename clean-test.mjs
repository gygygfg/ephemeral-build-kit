import { connect, canvasBox, shot, clickAt } from "./novnc.mjs";

const c = await connect();
const box = await canvasBox(c.page, c.canvas);

// initial state (fresh dialog): checkbox unchecked, NO server input
await shot(c.page, "/tmp/opencode/c-01-initial.png");

// type ONLY the phone (default server, no custom server)
await clickAt(c.page, box, 676, 316);
await c.page.keyboard.press("Control+a");
await c.page.keyboard.type("18663108073");
await c.page.waitForTimeout(400);
await shot(c.page, "/tmp/opencode/c-02-phone.png");

// Tab to send-code button, press Space
await c.page.keyboard.press("Tab");
await c.page.keyboard.press("Tab");
await c.page.keyboard.press("Tab");
await c.page.waitForTimeout(200);
await c.page.keyboard.press("Space");
await c.page.waitForTimeout(3500);
await shot(c.page, "/tmp/opencode/c-03-sendcode.png");

await c.browser.close();
console.log("clean-test done");
