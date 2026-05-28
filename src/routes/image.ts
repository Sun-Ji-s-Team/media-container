import type http from "node:http";
import sharp from "sharp";
import type { ApiResponse, ImageProcessRequest, StitchImageRequest } from "../types.js";

interface RouteContext {
  readBody(req: http.IncomingMessage): Promise<string>;
  jsonBody<T>(res: http.ServerResponse, status: number, body: ApiResponse<T>): void;
}

async function fetchImage(src: string): Promise<Buffer> {
  if (src.startsWith("data:")) {
    const b64 = src.includes("base64,") ? src.split("base64,")[1] : src.split(",")[1];
    return Buffer.from(b64, "base64");
  }
  if (src.startsWith("http://") || src.startsWith("https://")) {
    const resp = await fetch(src);
    if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  return Buffer.from(src, "base64");
}

export async function imageRouter(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: RouteContext
): Promise<void> {
  const { readBody, jsonBody } = ctx;

  try {
    // POST /image/process (resize/compress/convert)
    if (req.method === "POST" && url.pathname === "/image/process") {
      const raw = await readBody(req);
      const { images, format, quality, width, height, fit } = JSON.parse(raw) as ImageProcessRequest;

      if (!images?.length) {
        jsonBody(res, 400, { success: false, error: "At least one image required" });
        return;
      }

      const input = await fetchImage(images[0]);
      let pipeline = sharp(input);

      if (width || height) {
        pipeline = pipeline.resize(width, height, { fit: fit || "inside", withoutEnlargement: true });
      }

      const fmt = format || "png";
      switch (fmt) {
        case "jpeg": pipeline = pipeline.jpeg({ quality: quality || 85 }); break;
        case "webp": pipeline = pipeline.webp({ quality: quality || 85 }); break;
        case "avif": pipeline = pipeline.avif({ quality: quality || 50 }); break;
        default: pipeline = pipeline.png({ quality: quality || 90 }); break;
      }

      const output = await pipeline.toBuffer();
      res.writeHead(200, { "Content-Type": `image/${fmt}` });
      res.end(output);
      return;
    }

    // POST /image/stitch
    if (req.method === "POST" && url.pathname === "/image/stitch") {
      const raw = await readBody(req);
      const { images, direction, columns, gap = 0, background = "#ffffff", format = "png", quality = 90 } = JSON.parse(raw) as StitchImageRequest;

      if (!images?.length) {
        jsonBody(res, 400, { success: false, error: "At least one image required" });
        return;
      }

      const buffers = await Promise.all(images.map(fetchImage));
      const metas = await Promise.all(buffers.map((b) => sharp(b).metadata()));
      const fmt = format || "png";

      if (direction === "grid" && columns && columns > 1) {
        // Arrange images row by row
        const rows: { buffer: Buffer; meta: sharp.Metadata }[][] = [];
        for (let i = 0; i < buffers.length; i += columns) {
          rows.push(
            buffers.slice(i, i + columns).map((b, j) => ({ buffer: b, meta: metas[i + j]! }))
          );
        }

        // Stitch each row horizontally
        const rowImages = await Promise.all(
          rows.map(async (row) => {
            let x = 0;
            const positioned = row.map(({ buffer, meta }) => {
              const pos = { input: buffer, top: 0, left: x };
              x += (meta.width || 0) + gap;
              return pos;
            });

            const rowWidth = x - gap;
            const rowHeight = Math.max(...row.map(({ meta }) => meta.height || 0));

            return sharp({ create: { width: rowWidth, height: rowHeight, channels: 4, background } })
              .composite(positioned)
              .png()
              .toBuffer();
          })
        );

        // Stitch rows vertically
        let y = 0;
        const maxWidth = Math.max(...rowImages.map((_, i) => {
          return rows[i]!.reduce((w, m) => w + (m.meta.width || 0), 0) + gap * (rows[i]!.length - 1);
        }));

        const finalComposite = rowImages.map((rowBuf, i) => {
          const rowWidth = rows[i]!.reduce((w, m) => w + (m.meta.width || 0), 0) + gap * (rows[i]!.length - 1);
          const pos = { input: rowBuf, top: y, left: Math.floor((maxWidth - rowWidth) / 2) };
          y += Math.max(...rows[i]!.map((m) => m.meta.height || 0)) + gap;
          return pos;
        });

        const totalHeight = y - gap;

        const output = await sharp({ create: { width: maxWidth, height: totalHeight, channels: 4, background } })
          .composite(finalComposite)
          [fmt === "jpeg" ? "jpeg" : fmt === "webp" ? "webp" : "png"]({ quality })
          .toBuffer();

        res.writeHead(200, { "Content-Type": `image/${fmt}` });
        res.end(output);
        return;
      }

      // Horizontal or vertical
      const isHorizontal = direction === "horizontal";
      const dimKey = isHorizontal ? "width" as const : "height" as const;
      const otherKey = isHorizontal ? "height" as const : "width" as const;

      const totalDim = metas.reduce((sum, m) => sum + (m[dimKey] || 0), 0) + gap * (buffers.length - 1);
      const maxOther = Math.max(...metas.map((m) => m[otherKey] || 0));

      const canvasWidth = isHorizontal ? totalDim : maxOther;
      const canvasHeight = isHorizontal ? maxOther : totalDim;

      const composites: sharp.OverlayOptions[] = [];
      let offset = 0;
      for (let i = 0; i < buffers.length; i++) {
        composites.push({
          input: buffers[i]!,
          top: isHorizontal ? Math.floor((maxOther - (metas[i]![otherKey] || 0)) / 2) : offset,
          left: isHorizontal ? offset : Math.floor((maxOther - (metas[i]![otherKey] || 0)) / 2),
        });
        offset += (metas[i]![dimKey] || 0) + gap;
      }

      const output = await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background } })
        .composite(composites)
        [fmt === "jpeg" ? "jpeg" : fmt === "webp" ? "webp" : "png"]({ quality })
        .toBuffer();

      res.writeHead(200, { "Content-Type": `image/${fmt}` });
      res.end(output);
      return;
    }

    jsonBody(res, 404, { success: false, error: "Unknown image endpoint" });
  } catch (err) {
    console.error("[image] error:", err);
    jsonBody(res, 500, { success: false, error: err instanceof Error ? err.message : "Internal error" });
  }
}
