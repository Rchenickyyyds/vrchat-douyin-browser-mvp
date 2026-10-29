import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { BrowserManager } from "../src/browser-manager.js";

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
    await assert.rejects(manager.launch("/not-used", ":100", "not-used"), navigationError);
    assert.equal(closeCalls, 1);
  } finally {
    chromium.launchPersistentContext = originalLaunch;
  }
});
