import { chromium } from "playwright";

export class BrowserManager {
  constructor(config) {
    this.config = config;
  }

  async launch(profilePath, display, pulseSink) {
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: null,
      screen: { width: this.config.display.width, height: this.config.display.height },
      ignoreDefaultArgs: ["--mute-audio"],
      env: {
        ...process.env,
        DISPLAY: display,
        PULSE_SINK: pulseSink
      },
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--autoplay-policy=no-user-gesture-required",
        `--window-size=${this.config.display.width},${this.config.display.height}`,
        "--window-position=0,0",
        "--kiosk"
      ]
    });

    try {
      const pages = context.pages();
      const page = pages.length ? pages[0] : await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(this.config.douyinUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.bringToFront();
      return { context, page };
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }
}
