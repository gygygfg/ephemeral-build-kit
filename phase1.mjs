import { connect, canvasBox, shot, clickAt, typeText } from "./novnc.mjs";

const c = await connect();
const box = await canvasBox(c.page, c.canvas);

// click into account field (top input) and type the phone
await clickAt(c.page, box, 676, 316);
await c.page.keyboard.press("Control+a");
await c.page.keyboard.type("18663108073");
await c.page.waitForTimeout(500);
await shot(c.page, "/tmp/opencode/pw-1-account.png");

// toggle "其他服务器登录" checkbox
await clickAt(c.page, box, 440, 416);
await c.page.waitForTimeout(900);
await shot(c.page, "/tmp/opencode/pw-2-checkbox.png");

await c.browser.close();
console.log("phase1 done");
