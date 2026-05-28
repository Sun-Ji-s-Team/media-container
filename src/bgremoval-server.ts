import http from "node:http";
import { removeBackground } from "@imgly/background-removal-node";

const PORT = parseInt(process.env.PORT || "8080", 10);

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
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
  // Assume raw base64
  return Buffer.from(src, "base64");
}

function guessMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && reqUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { status: "ok" } }));
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/image/remove-bg") {
    try {
      const raw = await readBody(req);
      const { image, format = "png" } = JSON.parse(raw) as { image: string; format?: string };

      if (!image) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing image field" }));
        return;
      }

      const input = await fetchImage(image);
      const inputMime = guessMime(input);
      console.log(`[bgremoval] input: ${input.length} bytes, detected: ${inputMime}, output format: ${format}`);

      const outputMime = format === "webp" ? "image/webp" : "image/png";
      const blob = await removeBackground(input, {
        output: { format: outputMime },
      });

      const output = Buffer.from(await blob.arrayBuffer());
      console.log(`[bgremoval] output: ${output.length} bytes`);

      // Return as base64 JSON (matching caller expectation)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        image: `data:${outputMime};base64,${output.toString("base64")}`,
      }));
    } catch (err) {
      console.error("[bgremoval] error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : "Internal error" }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: false, error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`[bgremoval] server listening on port ${PORT}`);
});
