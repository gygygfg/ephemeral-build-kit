import { connect, canvasBox, shot, clickAt } from "./novnc.mjs";

const c = await connect();
const box = await canvasBox(c.page, c.canvas);

// uncheck "其他服务器登录" (toggle off) -> default server used, not displayed
await clickAt(c.page, box, 440, 416);
await c.page.waitForTimeout(700);
await shot(c.page, "/tmp/opencode/d-1-unchecked-noserver.png");

// focus account field, Tab to send-code button, press Space
await clickAt(c.page, box, 676, 316);
await c.page.waitForTimeout(300);
await c.page.keyboard.press("Tab");
await c.page.keyboard.press("Tab");
await c.page.keyboard.press("Tab");
await c.page.waitForTimeout(200);
await c.page.keyboard.press("Space");
await c.page.waitForTimeout(3500);
await shot(c.page, "/tmp/opencode/d-2-sendcode-result.png");

await c.browser.close();
console.log("default-test done");
