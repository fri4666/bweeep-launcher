import fs from "node:fs";
import { chromium } from "playwright";

const source = fs.readFileSync("build/icon-source-v2.png").toString("base64");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });

await page.setContent(`<canvas id="icon" width="256" height="256"></canvas><script>window.source = "data:image/png;base64,${source}";</script>`);
await page.evaluate(async () => {
  const image = new Image();
  image.src = window.source;
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
  });
  const canvas = document.querySelector("#icon");
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 256, 256);
  context.fillStyle = "#17191c";
  context.beginPath();
  context.roundRect(12, 12, 232, 232, 28);
  context.fill();
  context.globalAlpha = 0.22;
  context.fillStyle = "#c58a3d";
  context.beginPath();
  context.roundRect(14, 14, 228, 228, 26);
  context.fill();
  context.globalAlpha = 1;
  context.drawImage(image, 0, 0, 256, 256);
});
await page.locator("#icon").screenshot({ path: "build/icon-source-v3-optical.png", omitBackground: true });
await browser.close();
