import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function stopChild(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), wait(3000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export class StreamManager {
  constructor(config) {
    this.config = config;
    this.hlsRoot = path.join(config.dataRoot, "hls");
    this.ffmpegEncoders = null;
  }

  async initialize() {
    await fs.mkdir(this.hlsRoot, { recursive: true });
  }

  async prepare(slot) {
    const displayNumber = 100 + slot;
    const display = `:${displayNumber}`;
    const pulseSink = `douyin_slot_${slot}`;
    const hlsDirectory = path.join(this.hlsRoot, String(slot));
    await fs.rm(hlsDirectory, { recursive: true, force: true });
    await fs.mkdir(hlsDirectory, { recursive: true });

    const xvfb = spawn("Xvfb", [
      display,
      "-screen", "0", `${this.config.display.width}x${this.config.display.height}x24`,
      "-nolisten", "tcp",
      "-ac"
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let xvfbError = "";
    let xvfbSpawnError = "";
    xvfb.on("error", (error) => { xvfbSpawnError = error.message; });
    xvfb.stderr.on("data", (chunk) => { xvfbError = (xvfbError + chunk).slice(-4000); });

    const socket = `/tmp/.X11-unix/X${displayNumber}`;
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (xvfbSpawnError || xvfb.exitCode !== null) {
          throw new Error(`Xvfb failed: ${(xvfbSpawnError || xvfbError).trim()}`);
        }
        try {
          await fs.access(socket);
          break;
        } catch {
          if (attempt === 49) throw new Error("Xvfb did not become ready");
          await wait(100);
        }
      }
    } catch (error) {
      await stopChild(xvfb);
      throw error;
    }

    let pulseModule;
    try {
      const { stdout } = await execFileAsync("pactl", [
        "load-module", "module-null-sink",
        `sink_name=${pulseSink}`,
        `sink_properties=device.description=${pulseSink}`
      ]);
      pulseModule = stdout.trim();
    } catch (error) {
      await stopChild(xvfb);
      throw new Error(`cannot create PulseAudio sink: ${error.message}`);
    }

    return { slot, display, pulseSink, pulseModule, hlsDirectory, xvfb, ffmpeg: null, encoder: null };
  }

  async start(resources) {
    const candidates = await this.chooseEncoders();
    let lastError;
    for (let index = 0; index < candidates.length; index++) {
      const encoder = candidates[index];
      if (index > 0) {
        await fs.rm(resources.hlsDirectory, { recursive: true, force: true });
        await fs.mkdir(resources.hlsDirectory, { recursive: true });
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
      const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-encoders"], { maxBuffer: 4 * 1024 * 1024 });
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
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
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
    await stopChild(resources.ffmpeg);
    await stopChild(resources.xvfb);
    if (resources.pulseModule) {
      await execFileAsync("pactl", ["unload-module", resources.pulseModule]).catch(() => {});
    }
    await fs.rm(resources.hlsDirectory, { recursive: true, force: true });
  }
}
