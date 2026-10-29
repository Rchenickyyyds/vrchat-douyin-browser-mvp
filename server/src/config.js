import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(serverRoot, "config", name), "utf8"));
const raw = readJson("default.json");

export const config = {
  ...raw,
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || raw.port),
  dataRoot: path.resolve(serverRoot, process.env.DOUYIN_DATA_ROOT || raw.dataRoot),
  stream: {
    ...raw.stream,
    encoder: process.env.H264_ENCODER || raw.stream.encoder
  },
  selectors: readJson("selectors.json")
};
