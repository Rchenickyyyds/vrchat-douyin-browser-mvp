import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { BrowserManager } from "../src/browser-manager.js";

const resources = {
  xauthority: "/private/xauthority", pulseServer: "unix:/private/pulse.sock", pulseCookie: "/private/pulse-cookie",
  browserHome: "/private/home", runtimeDirectory: "/private"
};

test("failed initial navigation closes the newly launched browser context", async () => {
  const originalLaunch = chromium.launchPersistentContext;
  const navigationError = new Error("simulated navigation failure");
  let closeCalls = 0;
  chromium.launchPersistentContext = async () => ({
    pages: () => [{
      setDefaultTimeout() {},
      async goto() { throw navigationError; }
    }],
    async close() { closeCalls++; }
  });

  try {
    const manager = new BrowserManager({
      display: { width: 1080, height: 1920 },
      douyinUrl: "https://example.com"
    });
    await assert.rejects(manager.launch("/not-used", ":100", "not-used", resources), navigationError);
    assert.equal(closeCalls, 1);
  } finally {
    chromium.launchPersistentContext = originalLaunch;
  }
});

test("browser requires sandbox and private resources without inheriting service credentials", async () => {
  const originalLaunch = chromium.launchPersistentContext;
  const previousSecret = process.env.TEST_SERVICE_CREDENTIAL;
  process.env.TEST_SERVICE_CREDENTIAL = "do-not-inherit";
  let options;
  chromium.launchPersistentContext = async (_profile, launchOptions) => {
    options = launchOptions;
    return {
      pages: () => [{ setDefaultTimeout() {}, async goto() {}, async bringToFront() {} }],
      async close() {}
    };
  };
  try {
    const manager = new BrowserManager({
      display: { width: 640, height: 360 }, douyinUrl: "https://example.com", proxyServer: "http://egress:3128"
    });
    await assert.rejects(manager.launch("/profile", ":1", "sink"), /private display and audio/);
    await manager.launch("/profile", ":1", "sink", resources);
    assert.equal(options.chromiumSandbox, true);
    assert.equal(options.args.includes("--no-sandbox"), false);
    assert.equal(options.env.TEST_SERVICE_CREDENTIAL, undefined);
    assert.equal(options.env.HOME, resources.browserHome);
    assert.equal(options.env.XAUTHORITY, resources.xauthority);
    assert.equal(options.env.PULSE_SERVER, resources.pulseServer);
    assert.equal(options.env.PULSE_COOKIE, resources.pulseCookie);
    assert.equal(options.acceptDownloads, false);
    assert.equal(options.serviceWorkers, "block");
    assert.deepEqual(options.proxy, { server: "http://egress:3128", bypass: "<-loopback>" });
    assert.equal(options.args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"), true);
    assert.equal(options.args.includes("--disable-quic"), true);
  } finally {
    chromium.launchPersistentContext = originalLaunch;
    if (previousSecret === undefined) delete process.env.TEST_SERVICE_CREDENTIAL;
    else process.env.TEST_SERVICE_CREDENTIAL = previousSecret;
  }
});

test("failed browser startup cleanup propagates uncertainty for worker quarantine", async () => {
  const originalLaunch = chromium.launchPersistentContext;
  const navigationError = new Error("navigation failed"), cleanupError = new Error("context did not close");
  chromium.launchPersistentContext = async () => ({
    pages: () => [{ setDefaultTimeout() {}, async goto() { throw navigationError; } }],
    async close() { throw cleanupError; }
  });
  try {
    const manager = new BrowserManager({ display: { width: 640, height: 360 }, douyinUrl: "https://example.com" });
    await assert.rejects(manager.launch("/profile", ":1", "sink", resources), (error) =>
      error instanceof AggregateError && error.errors[0] === navigationError && error.errors[1] === cleanupError);
  } finally {
    chromium.launchPersistentContext = originalLaunch;
  }
});
