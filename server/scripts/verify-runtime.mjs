// Explicit Linux smoke check: real Chromium/Xvfb/PulseAudio/FFmpeg, no external site.
// Run in the documented isolated container with: node scripts/verify-runtime.mjs --run
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { newToken, digest } from "../src/access.js";
import { BrowserManager } from "../src/browser-manager.js";
import { StreamManager } from "../src/stream-manager.js";
import { ProfileManager } from "../src/profile-manager.js";
import { SlotManager } from "../src/slot-manager.js";
import { SessionManager } from "../src/session-manager.js";
import { createApi } from "../src/api.js";

const args = process.argv.slice(2);
if (!args.includes("--run") || args.some((arg, i) => arg !== "--run" && arg !== "--output-dir" && args[i - 1] !== "--output-dir")) {
  console.error("Usage: node scripts/verify-runtime.mjs --run [--output-dir /private/output]");
  process.exit(2);
}
const outputIndex = args.indexOf("--output-dir");
if (outputIndex >= 0 && (!args[outputIndex + 1] || args[outputIndex + 1].startsWith("--"))) process.exit(2);
if (process.platform !== "linux" || process.getuid() === 0) {
  console.error("This check requires Linux and a dedicated non-root user; use the documented sandboxed container.");
  process.exit(2);
}

process.umask(0o077);
const run = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const work = await fs.mkdtemp(path.join(os.tmpdir(), "vrchat-runtime-check-"));
const result = { source: "local Canvas + WebAudio fixture", checks: {}, limitations: [
  "This does not verify Douyin, VRChat, Quest, HTTPS or GPU encoding.",
  "PulseAudio accepts same-UID native processes; one worker remains one trust domain."
] };
let stage = "setup", api, sessions, fixture, session, output;
let cleanupSucceeded = true;

const check = (name, condition) => { result.checks[name] = Boolean(condition); assert.ok(condition, name); };
const missing = async (filename) => {
  try { await fs.lstat(filename); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
};
const closeServer = async (server) => {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

try {
  if (outputIndex >= 0) {
    const parent = path.resolve(args[outputIndex + 1]);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(parent);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077), "private output directory required");
    output = await fs.mkdtemp(path.join(parent, "runtime-check-"));
  }
  fixture = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>ISOLATED HLS FIXTURE</title><style>body{margin:0}canvas{display:block}</style><canvas width="360" height="640"></canvas><script>
      const g=document.querySelector('canvas').getContext('2d');let n=0;
      setInterval(()=>{n++;g.fillStyle=n%2?'#e43d30':'#2854e9';g.fillRect(0,0,360,640);g.fillStyle='white';g.font='24px sans-serif';g.fillText('ISOLATED HLS',24,64);g.fillText('FRAME '+n,24,112);g.fillRect(n*29%300,200,56,56)},250);
      const a=new AudioContext(),o=a.createOscillator(),v=a.createGain();o.frequency.value=440;v.gain.value=.18;o.connect(v).connect(a.destination);o.start();a.resume();
      </script>`);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const ownerToken = newToken(), otherToken = newToken();
  const config = {
    dataRoot: path.join(work, "data"), slotCount: 1,
    sessionTtlSeconds: 120, viewTtlSeconds: 90, heartbeatTimeoutSeconds: 120,
    douyinUrl: `http://127.0.0.1:${fixture.address().port}/`,
    display: { width: 360, height: 640, fps: 15 },
    stream: { outputWidth: 360, outputHeight: 640, videoBitrate: "650k", audioBitrate: "96k", hlsSegmentSeconds: 2, encoder: "libx264" },
    selectors: { nextKeys: ["ArrowDown"], prevKeys: ["ArrowUp"], like: [], favorite: [] },
    users: [{ id: "runtime-owner", tokenHash: digest(ownerToken), profiles: ["guest"], maxSessions: 1 },
      { id: "runtime-other", tokenHash: digest(otherToken), profiles: ["guest"], maxSessions: 1 }]
  };
  const profiles = new ProfileManager(config.dataRoot), streams = new StreamManager(config);
  await profiles.initialize(); await streams.initialize();
  sessions = new SessionManager(config, new SlotManager(1), profiles, new BrowserManager(config), streams);
  api = createApi(config, sessions);
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  config.publicOrigin = `http://127.0.0.1:${api.address().port}`;
  const request = (url, method = "GET", token, body) => fetch(new URL(url, config.publicOrigin), {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000)
  });

  stage = "API authentication and browser startup";
  check("anonymousCreateDenied", (await request("/api/sessions", "POST", undefined, { profile: "guest" })).status === 401);
  check("ungrantedProfileDenied", (await request("/api/sessions", "POST", ownerToken, { profile: "user1" })).status === 403);
  const created = await request("/api/sessions", "POST", ownerToken, { profile: "guest" });
  check("realGuestCreated", created.status === 201);
  const data = await created.json();
  session = sessions.byId.get(data.id);
  check("otherOwnerCannotSeeSession", (await (await request("/api/sessions", "GET", otherToken)).json()).length === 0);
  const controlPath = `/api/sessions/${data.id}/`;
  check("otherOwnerCannotControl", (await request(controlPath + "heartbeat", "POST", otherToken)).status === 404);
  check("viewCannotControl", (await request(controlPath + "heartbeat", "POST", new URL(data.viewUrl).pathname.split("/")[3])).status === 404);
  check("sessionControlWorks", (await request(controlPath + "heartbeat", "POST", data.controlToken)).status === 200);
  check("ownerKeyboardActionWorks", (await request(controlPath + "next", "POST", ownerToken)).status === 200);

  stage = "Chromium sandbox";
  const sandboxPage = await session.browser.context.newPage();
  await sandboxPage.goto("chrome://sandbox/");
  const sandbox = await sandboxPage.locator("body").innerText();
  await sandboxPage.close();
  check("namespaceSandbox", /Layer 1 Sandbox\s+Namespace/.test(sandbox));
  check("pidNamespace", /PID namespaces\s+Yes/.test(sandbox));
  check("networkNamespace", /Network namespaces\s+Yes/.test(sandbox));
  check("seccompSandbox", /Seccomp-BPF sandbox\s+Yes/.test(sandbox));
  const commands = await Promise.all((await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name))
    .map((name) => fs.readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "")));
  const chromeCommands = commands.filter((line) => line.includes("/ms-playwright/") && line.includes("chrome"));
  check("realChromeProcessesPresent", chromeCommands.length > 0);
  check("noSandboxBypassFlags", !chromeCommands.some((line) => line.includes("--no-sandbox") || line.includes("--disable-setuid-sandbox")));

  stage = "live HLS HTTP delivery";
  let playlist;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request(data.viewUrl);
    if (response.status === 200) {
      const text = await response.text();
      if ((text.match(/^segment_\d+\.ts$/gm) || []).length >= 3) { playlist = text; break; }
    } else await response.arrayBuffer();
    await wait(200);
  }
  check("livePlaylistReady", Boolean(playlist));
  const snapshot = path.join(work, "snapshot"); await fs.mkdir(snapshot, { mode: 0o700 });
  const names = playlist.match(/^segment_\d+\.ts$/gm);
  let segmentBytes = 0;
  for (const name of names) {
    const response = await request(new URL(name, data.viewUrl));
    check("authorizedSegmentsDelivered", response.status === 200);
    const bytes = Buffer.from(await response.arrayBuffer()); segmentBytes += bytes.length;
    await fs.writeFile(path.join(snapshot, name), bytes, { mode: 0o600 });
  }
  const input = path.join(snapshot, "index.m3u8");
  await fs.writeFile(input, playlist + "\n#EXT-X-ENDLIST\n", { mode: 0o600 });
  result.media = { segmentCount: names.length, segmentBytes };

  stage = "HLS video and audio decoding";
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", input], { timeout: 15000 });
  const media = JSON.parse(stdout).streams;
  check("h264Video", media.some((stream) => stream.codec_name === "h264" && stream.width === 360 && stream.height === 640));
  check("aacStereoAudio", media.some((stream) => stream.codec_name === "aac" && stream.channels === 2 && stream.sample_rate === "48000"));
  const frames = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", input, "-t", "4", "-vf", "fps=1", "-an", "-f", "framemd5", "pipe:1"], { timeout: 15000 });
  const hashes = frames.stdout.split("\n").filter((line) => /^0,/.test(line)).map((line) => line.split(",").at(-1).trim());
  result.media.decodedFrames = hashes.length; result.media.distinctFrames = new Set(hashes).size;
  check("movingDecodedVideo", hashes.length >= 3 && new Set(hashes).size >= 2);
  const audio = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", input, "-t", "4", "-vn", "-af", "volumedetect", "-f", "null", "-"], { timeout: 15000 });
  result.media.meanAudioDb = Number.parseFloat(audio.stderr.match(/mean_volume:\s+([^\n]+)/)?.[1]);
  check("nonSilentDecodedAudio", result.media.meanAudioDb > -60);
  if (output) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", input, "-frames:v", "1", path.join(output, "runtime-frame.png")], { timeout: 15000 });

  stage = "private display and audio boundary";
  const env = session.resources.env;
  const wrongXauthority = path.join(work, "wrong-xauthority"), wrongPulseCookie = path.join(work, "wrong-pulse-cookie");
  await fs.writeFile(wrongXauthority, Buffer.alloc(0), { mode: 0o600 });
  await fs.writeFile(wrongPulseCookie, Buffer.alloc(256, 0x51), { mode: 0o600 });
  const captureArgs = ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-video_size", "360x640", "-i", `${session.resources.display}.0`, "-frames:v", "1", "-f", "null", "-"];
  await run("ffmpeg", captureArgs, { env, timeout: 3000 });
  check("authorizedXDisplayStillWorks", true);
  try {
    await run("ffmpeg", captureArgs, {
      env: { ...env, XAUTHORITY: wrongXauthority }, timeout: 3000
    }); result.checks.wrongXAuthorityRejected = false;
  } catch (error) {
    result.checks.wrongXAuthorityRejected = typeof error.code === "number" &&
      /authorization|cannot open display|no protocol/i.test(error.stderr || "");
  }
  assert.ok(result.checks.wrongXAuthorityRejected, "wrong Xauthority accepted");
  try {
    await run("pactl", ["info"], { env: { ...env, PULSE_COOKIE: wrongPulseCookie }, timeout: 3000 });
    result.sameUidPulseClientAccepted = true;
  } catch { result.sameUidPulseClientAccepted = false; }

  stage = "view rotation and cleanup";
  const shared = await request(controlPath + "share", "POST", ownerToken);
  check("shareRotated", shared.status === 200);
  const newView = (await shared.json()).viewUrl;
  check("oldViewRevoked", (await request(data.viewUrl)).status === 404);
  const current = await request(newView); check("newViewWorks", current.status === 200); await current.arrayBuffer();
  check("sessionClosed", (await request(controlPath + "close", "POST", ownerToken)).status === 200);
  check("closedViewRevoked", (await request(newView)).status === 404);
  check("guestProfileRemoved", await missing(session.profile.profilePath));
  check("hlsDirectoryRemoved", await missing(session.resources.hlsDirectory));
  check("privateRuntimeRemoved", await missing(session.resources.runtimeDirectory));
  check("ownerListEmpty", (await (await request("/api/sessions", "GET", ownerToken)).json()).length === 0);
} catch (error) {
  result.failure = { stage, type: error.name };
  process.exitCode = 1;
} finally {
  try { await sessions?.closeAll(); } catch { cleanupSucceeded = false; process.exitCode = 1; }
  await closeServer(api); await closeServer(fixture);
  if (cleanupSucceeded) await fs.rm(work, { recursive: true, force: true });
  result.checks.finalCleanupSucceeded = cleanupSucceeded;
  if (!cleanupSucceeded) result.retainedWorkDirectory = work;
  result.passed = !result.failure && Object.values(result.checks).every(Boolean);
  if (!result.passed) process.exitCode = 1;
  if (output) {
    result.outputDirectory = output;
    await fs.writeFile(path.join(output, "runtime-result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  }
  console.log(JSON.stringify(result, null, 2));
}
