import { chromium } from "playwright";

export class BrowserManager {
  constructor(config) {
    this.config = config;
  }

  async launch(profilePath, display, pulseSink, resources) {
    if (!resources?.xauthority || !resources.pulseServer || !resources.pulseCookie || !resources.browserHome) {
      throw new Error("private display and audio resources are required");
    }
    const context = await chromium.launchPersistentContext(profilePath, {
      chromiumSandbox: true,
      headless: false,
      acceptDownloads: false,
      serviceWorkers: "block",
      ...(this.config.proxyServer ? { proxy: { server: this.config.proxyServer, bypass: "<-loopback>" } } : {}),
      viewport: null,
      screen: { width: this.config.display.width, height: this.config.display.height },
      ignoreDefaultArgs: ["--mute-audio"],
      env: {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: resources.browserHome,
        TMPDIR: resources.runtimeDirectory,
        XDG_RUNTIME_DIR: resources.runtimeDirectory,
        DISPLAY: display,
        XAUTHORITY: resources.xauthority,
        PULSE_SERVER: resources.pulseServer,
        PULSE_COOKIE: resources.pulseCookie,
        PULSE_SINK: pulseSink
      },
      args: [
        "--disable-dev-shm-usage",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-quic",
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
      try { await context.close(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "browser startup cleanup failed");
      }
      throw error;
    }
  }
}
