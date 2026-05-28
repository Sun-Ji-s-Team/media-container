import type http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiResponse, FrameExtractRequest, VideoProcessRequest } from "../types.js";

interface RouteContext {
  readBody(req: http.IncomingMessage): Promise<string>;
  jsonBody<T>(res: http.ServerResponse, status: number, body: ApiResponse<T>): void;
}

async function fetchToFile(src: string, dir: string, name: string): Promise<string> {
  const resp = await fetch(src);
  if (!resp.ok) throw new Error(`Failed to fetch video: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const path = join(dir, name);
  await writeFile(path, buf);
  return path;
}

function ffmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    proc.on("error", reject);
  });
}

export async function videoRouter(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: RouteContext
): Promise<void> {
  const { readBody, jsonBody } = ctx;
  const tmpDir = await mkdtemp(join(tmpdir(), "media-"));

  try {
    // POST /video/stitch
    if (req.method === "POST" && url.pathname === "/video/stitch") {
      const raw = await readBody(req);
      const { videos, format = "mp4", crf = 23 } = JSON.parse(raw) as VideoProcessRequest;

      if (!videos?.length) {
        jsonBody(res, 400, { success: false, error: "At least one video required" });
        return;
      }

      const paths = await Promise.all(
        videos.map((v, i) => fetchToFile(v, tmpDir, `input_${i}.mp4`))
      );

      const inputs = paths.flatMap((p) => ["-i", p]);
      const filterParts = paths.map((_, i) => `[${i}:v:0][${i}:a:0]`);
      const filterComplex = `${filterParts.join("")}concat=n=${paths.length}:v=1:a=1[outv][outa]`;

      const ext = format === "webm" ? "webm" : format === "mov" ? "mov" : "mp4";
      const output = await ffmpeg([
        ...inputs,
        "-filter_complex", filterComplex,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", ext === "webm" ? "libvpx-vp9" : "libx264",
        "-crf", String(crf),
        "-preset", "fast",
        "-movflags", "frag_keyframe+empty_moov",
        "-f", ext === "mov" ? "mov" : ext === "webm" ? "webm" : "mp4",
        "pipe:1",
      ]);

      const mime = ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4";
      res.writeHead(200, { "Content-Type": mime });
      res.end(output);
      return;
    }

    // POST /video/frames
    if (req.method === "POST" && url.pathname === "/video/frames") {
      const raw = await readBody(req);
      const { video, frames, format = "png", quality = 90, width } = JSON.parse(raw) as FrameExtractRequest;

      if (!video) {
        jsonBody(res, 400, { success: false, error: "Video URL required" });
        return;
      }

      const videoPath = await fetchToFile(video, tmpDir, "input.mp4");

      // Get video duration via ffprobe
      const duration = await new Promise<number>((resolve, reject) => {
        const proc = spawn("ffprobe", [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          videoPath,
        ], { stdio: ["ignore", "pipe", "pipe"] });

        let out = "";
        proc.stdout.on("data", (c: Buffer) => { out += c.toString(); });
        proc.on("close", (code) => {
          if (code !== 0) reject(new Error("ffprobe failed"));
          else resolve(parseFloat(out.trim()));
        });
        proc.on("error", reject);
      });

      const timestamps: number[] = [];
      if (frames === "first" || frames === "both") timestamps.push(0.1);
      if (frames === "last" || frames === "both") timestamps.push(Math.max(0.1, duration - 0.5));

      const results: { frame: string; time: number; buffer: Buffer }[] = [];

      for (const t of timestamps) {
        const vfParts: string[] = [];
        if (width) vfParts.push(`scale=${width}:-1`);

        const args = ["-ss", String(t), "-i", videoPath, "-vframes", "1"];
        if (vfParts.length) args.push("-vf", vfParts.join(","));
        args.push("-f", "image2pipe", "-c:v", format === "jpeg" ? "mjpeg" : format === "webp" ? "libwebp" : "png", "pipe:1");

        const buf = await ffmpeg(args);
        results.push({ frame: t < 1 ? "first" : "last", time: t, buffer: buf });
      }

      if (results.length === 1) {
        const r = results[0]!;
        const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
        res.setHeader("X-Frame", r.frame);
        res.setHeader("X-Timestamp", String(r.time));
        res.writeHead(200, { "Content-Type": mime });
        res.end(r.buffer);
        return;
      }

      jsonBody(res, 200, {
        success: true,
        data: {
          frames: results.map((r) => ({
            frame: r.frame,
            time: r.time,
            data: r.buffer.toString("base64"),
          })),
        },
      });
      return;
    }

    // POST /video/compress
    if (req.method === "POST" && url.pathname === "/video/compress") {
      const raw = await readBody(req);
      const { videos, format = "mp4", crf = 28, width, height } = JSON.parse(raw) as VideoProcessRequest;

      if (!videos?.length) {
        jsonBody(res, 400, { success: false, error: "At least one video required" });
        return;
      }

      const videoPath = await fetchToFile(videos[0]!, tmpDir, "input.mp4");
      const ext = format === "webm" ? "webm" : format === "mov" ? "mov" : "mp4";

      const args: string[] = ["-i", videoPath];
      if (width || height) {
        const scale = `${width || -1}:${height || -1}`;
        args.push("-vf", `scale=${scale}`);
      }
      args.push(
        "-c:v", ext === "webm" ? "libvpx-vp9" : "libx264",
        "-crf", String(crf),
        "-preset", "fast",
        "-movflags", "frag_keyframe+empty_moov",
        "-f", ext === "mov" ? "mov" : ext === "webm" ? "webm" : "mp4",
        "pipe:1"
      );

      const output = await ffmpeg(args);

      const mime = ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4";
      res.writeHead(200, { "Content-Type": mime });
      res.end(output);
      return;
    }

    jsonBody(res, 404, { success: false, error: "Unknown video endpoint" });
  } catch (err) {
    console.error("[video] error:", err);
    jsonBody(res, 500, { success: false, error: err instanceof Error ? err.message : "Internal error" });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
