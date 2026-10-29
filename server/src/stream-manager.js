import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function exited(child) {
  return !child || !child.pid || child.exitCode !== null || child.signalCode !== null;
}

export async function stopChild(child, graceMilliseconds = 3000) {
  if (exited(child)) return;
  let onExit;
  const stopped = new Promise((resolve) => { onExit = resolve; child.once("exit", onExit); });
  let timer;
  try {
    child.kill("SIGTERM");
    await Promise.race([stopped, new Promise((resolve) => { timer = setTimeout(resolve, graceMilliseconds); })]);
    clearTimeout(timer);
    if (!exited(child)) {
      child.kill("SIGKILL");
      await Promise.race([stopped, new Promise((resolve) => { timer = setTimeout(resolve, graceMilliseconds); })]);
    }
    if (!exited(child)) throw new Error("child process did not exit after SIGKILL");
  } finally {
    clearTimeout(timer);
    child.removeListener("exit", onExit);
  }
}

function xauthority(cookie) {
  // Xauthority's wildcard address and empty display number match only this private cookie.
  const fields = [Buffer.alloc(0), Buffer.alloc(0), Buffer.from("MIT-MAGIC-COOKIE-1"), cookie];
  const family = Buffer.from([0xff, 0xff]);
  return Buffer.concat([family, ...fields.flatMap((field) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(field.length);
    return [length, field];
  })]);
}

function privateEnvironment(resources) {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: resources.browserHome,
    TMPDIR: resources.runtimeDirectory,
    XDG_RUNTIME_DIR: resources.runtimeDirectory,
    DISPLAY: resources.display,
    XAUTHORITY: resources.xauthority,
    PULSE_SERVER: resources.pulseServer,
    PULSE_COOKIE: resources.pulseCookie,
    PULSE_SINK: resources.pulseSink
  };
}

export class StreamManager {
  constructor(config, runtime = {}) {
    this.config = config;
    this.hlsRoot = path.join(config.dataRoot, "hls");
    this.ffmpegEncoders = null;
    this.spawn = runtime.spawn || spawn;
    this.execFile = runtime.execFile || execFileAsync;
    this.wait = runtime.wait || wait;
  }

  async initialize() {
    await fs.mkdir(this.hlsRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.hlsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe HLS directory");
    await fs.chmod(this.hlsRoot, 0o700);
  }

  managedChild(command, args, options = {}) {
    const child = this.spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], ...options });
    child.errorTail = "";
    child.on("error", (error) => { child.spawnError = error; });
    child.stderr?.on("data", (chunk) => { child.errorTail = (child.errorTail + chunk).slice(-4000); });
    return child;
  }

  async prepare(slot, id) {
    if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) {
      throw new Error("invalid session resource id");
    }
    const resources = { slot, id, ffmpeg: null, xvfb: null, pulse: null, encoder: null };
    try {
      const hlsDirectory = path.join(this.hlsRoot, id);
      await fs.mkdir(hlsDirectory, { mode: 0o700 });
      resources.hlsDirectory = hlsDirectory;
      resources.runtimeDirectory = await fs.mkdtemp("/tmp/vrchat-browser-");
      await fs.chmod(resources.runtimeDirectory, 0o700);
      resources.browserHome = path.join(resources.runtimeDirectory, "home");
      await fs.mkdir(resources.browserHome, { mode: 0o700 });
      resources.xauthority = path.join(resources.runtimeDirectory, "xauthority");
      await fs.writeFile(resources.xauthority, xauthority(crypto.randomBytes(16)), { mode: 0o600, flag: "wx" });
      resources.pulseCookie = path.join(resources.runtimeDirectory, "pulse-cookie");
      await fs.writeFile(resources.pulseCookie, crypto.randomBytes(256), { mode: 0o600, flag: "wx" });
      const pulseSocket = path.join(resources.runtimeDirectory, "pulse.sock");
      resources.pulseServer = `unix:${pulseSocket}`;
      resources.pulseSink = `douyin_${id.replaceAll("-", "")}`;

      resources.xvfb = this.managedChild("Xvfb", [
        "-displayfd", "3", "-screen", "0", `${this.config.display.width}x${this.config.display.height}x24`,
        "-nolisten", "tcp", "-auth", resources.xauthority
      ], { env: privateEnvironment(resources), stdio: ["ignore", "ignore", "pipe", "pipe"] });
      resources.display = await this.displayReady(resources.xvfb);
      resources.env = privateEnvironment(resources);
      resources.pulse = this.managedChild("pulseaudio", [
        "--daemonize=no", "--use-pid-file=no", "--exit-idle-time=-1", "--disallow-exit=yes",
        "--disallow-module-loading=yes", "--log-target=stderr", "-n",
        `--load=module-native-protocol-unix socket=${pulseSocket} auth-cookie=${resources.pulseCookie} auth-cookie-enabled=1 auth-anonymous=0 auth-group-enable=0`,
        `--load=module-null-sink sink_name=${resources.pulseSink}`
      ], { env: resources.env });
      await this.pulseReady(resources);
      return resources;
    } catch (error) {
      try { await this.stop(resources); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "session resource startup and cleanup failed");
      }
      throw error;
    }
  }

  displayReady(child) {
    return new Promise((resolve, reject) => {
      let output = "";
      const finish = (error, display) => {
        clearTimeout(timer);
        child.removeListener("error", failed);
        child.removeListener("exit", failed);
        child.stdio[3].removeListener("data", data);
        if (error) reject(error); else resolve(display);
      };
      const failed = () => finish(new Error("private Xvfb failed to start"));
      const data = (chunk) => {
        output += chunk;
        if (output.includes("\n")) {
          const number = output.trim();
          if (!/^\d{1,5}$/.test(number)) finish(new Error("invalid Xvfb display number"));
          else finish(null, `:${number}`);
        }
      };
      const timer = setTimeout(() => finish(new Error("private Xvfb did not become ready")), 10000);
      child.on("error", failed);
      child.on("exit", failed);
      child.stdio[3].on("data", data);
    });
  }

  async pulseReady(resources) {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (resources.pulse.spawnError || exited(resources.pulse)) throw new Error("private PulseAudio failed to start");
      try {
        await this.execFile("pactl", ["info"], { env: resources.env, timeout: 1000 });
        return;
      } catch {
        await this.wait(100);
      }
    }
    throw new Error("private PulseAudio did not become ready");
  }

  async start(resources) {
    const candidates = await this.chooseEncoders();
    let lastError;
    for (let index = 0; index < candidates.length; index++) {
      const encoder = candidates[index];
      if (index > 0) {
        await fs.rm(resources.hlsDirectory, { recursive: true, force: true });
        await fs.mkdir(resources.hlsDirectory, { mode: 0o700 });
      }
      try {
        resources.ffmpeg = await this.startFfmpeg(resources, encoder);
        resources.encoder = encoder;
        return encoder;
      } catch (error) {
        lastError = error;
        console.warn(`slot ${resources.slot}: ${encoder} unavailable at runtime`);
      }
    }
    throw lastError;
  }

  async chooseEncoders() {
    const requested = this.config.stream.encoder;
    if (requested !== "auto") return requested === "libx264" ? [requested] : [requested, "libx264"];
    if (!this.ffmpegEncoders) {
      const { stdout } = await this.execFile("ffmpeg", ["-hide_banner", "-encoders"], { maxBuffer: 4 * 1024 * 1024 });
      this.ffmpegEncoders = stdout;
    }
    return ["h264_nvenc", "h264_qsv", "h264_amf"].filter((name) => this.ffmpegEncoders.includes(name)).concat("libx264");
  }

  async startFfmpeg(resources, encoder) {
    const stream = this.config.stream;
    const segmentPattern = path.join(resources.hlsDirectory, "segment_%06d.ts");
    const playlist = path.join(resources.hlsDirectory, "index.m3u8");
    const encoderArgs = encoder === "h264_nvenc" ? ["-preset", "p4", "-tune", "ll"]
      : encoder === "h264_qsv" ? ["-preset", "veryfast", "-look_ahead", "0"]
      : encoder === "h264_amf" ? ["-quality", "speed"]
      : ["-preset", "veryfast", "-tune", "zerolatency"];

    const args = [
      "-hide_banner", "-loglevel", "warning",
      "-thread_queue_size", "1024",
      "-f", "x11grab", "-draw_mouse", "0",
      "-framerate", String(this.config.display.fps),
      "-video_size", `${this.config.display.width}x${this.config.display.height}`,
      "-i", `${resources.display}.0`,
      "-thread_queue_size", "1024",
      "-f", "pulse", "-i", `${resources.pulseSink}.monitor`,
      "-vf", `scale=${stream.outputWidth}:${stream.outputHeight}`,
      "-c:v", encoder,
      ...encoderArgs,
      "-pix_fmt", "yuv420p",
      "-profile:v", "main",
      "-level:v", "4.0",
      "-b:v", stream.videoBitrate,
      "-maxrate", stream.videoBitrate,
      "-bufsize", "7000k",
      "-g", String(this.config.display.fps * 2),
      "-keyint_min", String(this.config.display.fps * 2),
      "-sc_threshold", "0",
      "-c:a", "aac", "-b:a", stream.audioBitrate, "-ar", "48000", "-ac", "2",
      "-f", "hls",
      "-hls_time", String(stream.hlsSegmentSeconds),
      "-hls_list_size", "6",
      "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments+program_date_time",
      "-hls_segment_filename", segmentPattern,
      playlist
    ];
    const child = this.managedChild("ffmpeg", args, { env: resources.env });
    let errorTail = "";
    child.on("error", (error) => { errorTail = error.message; });
    child.stderr.on("data", (chunk) => { errorTail = (errorTail + chunk).slice(-8000); });
    const exited = await Promise.race([
      new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(-1));
      }),
      wait(2500).then(() => null)
    ]);
    if (exited !== null) throw new Error(`ffmpeg ${encoder} failed: ${errorTail.trim()}`);
    return child;
  }

  async stop(resources) {
    if (!resources) return;
    if (resources.stopPromise) return resources.stopPromise;
    resources.stopPromise = (async () => {
      const results = await Promise.allSettled([
        stopChild(resources.ffmpeg), stopChild(resources.pulse), stopChild(resources.xvfb)
      ]);
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "session child cleanup failed");
      const directories = await Promise.allSettled([resources.hlsDirectory, resources.runtimeDirectory]
        .filter(Boolean).map((directory) => fs.rm(directory, { recursive: true, force: true })));
      const failures = directories.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, "session directory cleanup failed");
    })();
    return resources.stopPromise;
  }
}
