import { connect, canvasBox, shot, clickAt, typeText } from "./novnc.mjs";

const c = await connect();
const box = await canvasBox(c.page, c.canvas);

// click into server input (appeared below checkbox after toggle) and type mock URL
await clickAt(c.page, box, 600, 443);
await c.page.keyboard.press("Control+a");
await c.page.keyboard.type("http://127.0.0.1:18099");
await c.page.waitForTimeout(500);
await shot(c.page, "/tmp/opencode/pw-3-server.png");

// click 发送验证码 button
await clickAt(c.page, box, 771, 383);
await c.page.waitForTimeout(4000);
await shot(c.page, "/tmp/opencode/pw-4-sendcode.png");

await c.browser.close();
console.log("phase2 done");
