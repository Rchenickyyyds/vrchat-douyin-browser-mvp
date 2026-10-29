import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StreamManager, stopChild } from "../src/stream-manager.js";

const id = "11111111-1111-4111-8111-111111111111";

function fakeRuntime(failingCommand) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, {
      pid: calls.length + 100, exitCode: null, signalCode: null,
      stderr: new PassThrough(), stdio: [null, null, null, new PassThrough()], signals: []
    });
    child.kill = (signal) => {
      child.signals.push(signal);
      queueMicrotask(() => { child.signalCode = signal; child.emit("exit", null, signal); });
      return true;
    };
    calls.push({ command, args, options, child });
    queueMicrotask(() => {
      if (command === failingCommand) {
        child.exitCode = 1;
        child.emit("error", new Error("simulated startup failure"));
        child.emit("exit", 1, null);
      } else if (command === "Xvfb") child.stdio[3].write("287\n");
    });
    return child;
  };
  const execFile = async () => {
    if (failingCommand === "pulseaudio") throw new Error("not ready");
    return { stdout: "ready" };
  };
  return { calls, spawn, execFile, wait: async () => {} };
}

test("hardware encoders are tried before the CPU fallback", async () => {
  const manager = new StreamManager({ dataRoot: "/tmp", stream: { encoder: "auto" } });
  manager.ffmpegEncoders = "h264_nvenc h264_qsv h264_amf libx264";
  assert.deepEqual(await manager.chooseEncoders(), ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]);
});

test("display, audio, cookies and HLS use private session resources and are removed on stop", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-resources-test-"));
  const runtime = fakeRuntime();
  const manager = new StreamManager({ dataRoot: root, display: { width: 640, height: 360 } }, runtime);
  let resources;
  try {
    await manager.initialize();
    resources = await manager.prepare(0, id);
    assert.equal(resources.display, ":287");
    assert.equal(resources.hlsDirectory, path.join(root, "hls", id));
    assert.equal((await fs.stat(resources.runtimeDirectory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(resources.hlsDirectory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(resources.pulseCookie)).mode & 0o777, 0o600);
    assert.equal((await fs.readFile(resources.pulseCookie)).length, 256);
    const auth = await fs.readFile(resources.xauthority);
    assert.equal(auth.readUInt16BE(), 65535);
    assert.equal(auth.includes(Buffer.from("MIT-MAGIC-COOKIE-1")), true);
    const xvfb = runtime.calls.find((call) => call.command === "Xvfb");
    assert.equal(xvfb.args.includes("-ac"), false);
    assert.deepEqual(xvfb.args.slice(0, 2), ["-displayfd", "3"]);
    assert.equal(xvfb.args[xvfb.args.indexOf("-auth") + 1], resources.xauthority);
    const pulse = runtime.calls.find((call) => call.command === "pulseaudio");
    assert.equal(pulse.args.some((arg) => arg.includes(resources.pulseCookie)), true);
    assert.equal(pulse.args.some((arg) => arg.includes("auth-anonymous=0")), true);
    assert.equal(pulse.options.env.PULSE_SERVER, resources.pulseServer);
    await Promise.all([manager.stop(resources), manager.stop(resources)]);
    assert.deepEqual(xvfb.child.signals, ["SIGTERM"]);
    assert.deepEqual(pulse.child.signals, ["SIGTERM"]);
    await assert.rejects(fs.access(resources.runtimeDirectory));
    await assert.rejects(fs.access(resources.hlsDirectory));
  } finally {
    if (resources) await manager.stop(resources);
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const command of ["Xvfb", "pulseaudio"]) {
  test(`${command} startup failure cleans every resource acquired so far`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-failure-test-"));
    const runtime = fakeRuntime(command);
    const manager = new StreamManager({ dataRoot: root, display: { width: 640, height: 360 } }, runtime);
    try {
      await manager.initialize();
      await assert.rejects(manager.prepare(0, id), /failed to start/);
      assert.deepEqual(await fs.readdir(path.join(root, "hls")), []);
      for (const call of runtime.calls) {
        await assert.rejects(fs.access(call.options.env.XDG_RUNTIME_DIR));
        assert.equal(call.child.exitCode !== null || call.child.signalCode !== null, true);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("resource IDs cannot escape HLS root or overwrite an existing session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-id-test-"));
  const manager = new StreamManager({ dataRoot: root }, fakeRuntime());
  try {
    await manager.initialize();
    await assert.rejects(manager.prepare(0, "../../other"), /invalid session resource id/);
    const directory = path.join(root, "hls", id);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "keep"), "existing");
    await assert.rejects(manager.prepare(0, id), { code: "EEXIST" });
    assert.equal(await fs.readFile(path.join(directory, "keep"), "utf8"), "existing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stopping a child waits for SIGKILL exit before reporting completion", async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 42, exitCode: null, signalCode: null });
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") setTimeout(() => { child.signalCode = signal; child.emit("exit", null, signal); }, 2);
  };
  await stopChild(child, 10);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
  await stopChild(child);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
