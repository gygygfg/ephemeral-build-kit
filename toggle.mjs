import { connect, canvasBox, shot, clickAt } from "./novnc.mjs";

const c = await connect();
const box = await canvasBox(c.page, c.canvas);

// warm-up on the account field, then toggle the checkbox
await clickAt(c.page, box, 676, 316);
await c.page.waitForTimeout(600);
await clickAt(c.page, box, 439, 416);
await c.page.waitForTimeout(900);
await shot(c.page, "/tmp/opencode/t-1-checked-server-appears.png");

await c.browser.close();
console.log("toggle done");
