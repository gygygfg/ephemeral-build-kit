import { connect, canvasBox, shot } from "./novnc.mjs";

const c = await connect();
const box = await canvasBox(c.page, c.canvas);
console.log("canvas box:", JSON.stringify(box));
await shot(c.page, "/tmp/opencode/pw-connect.png");
await c.browser.close();
console.log("done");
