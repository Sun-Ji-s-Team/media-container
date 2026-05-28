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
  return Buffer.from(src, "base64");
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && new URL(req.url || "/", "http://localhost").pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { status: "ok" } }));
    return;
  }

  if (req.method === "POST" && new URL(req.url || "/", "http://localhost").pathname === "/image/remove-bg") {
    try {
      const raw = await readBody(req);
      const { image, format = "png" } = JSON.parse(raw) as { image: string; format?: string };
      const input = await fetchImage(image);

      const blob = await removeBackground(input, {
        output: { format: format === "webp" ? "image/webp" : "image/png" },
      });

      const output = Buffer.from(await blob.arrayBuffer());
      res.writeHead(200, { "Content-Type": format === "webp" ? "image/webp" : "image/png" });
      res.end(output);
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
