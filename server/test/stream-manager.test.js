import assert from "node:assert/strict";
import test from "node:test";
import { StreamManager } from "../src/stream-manager.js";

test("hardware encoders are tried before the CPU fallback", async () => {
  const manager = new StreamManager({ dataRoot: "/tmp", stream: { encoder: "auto" } });
  manager.ffmpegEncoders = "h264_nvenc h264_qsv h264_amf libx264";
  assert.deepEqual(await manager.chooseEncoders(), ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]);
});
