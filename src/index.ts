import http from "node:http";
import { imageRouter } from "./routes/image.js";
import { videoRouter } from "./routes/video.js";
import type { ApiResponse } from "./types.js";

const PORT = parseInt(process.env.PORT || "8080", 10);

function jsonBody<T = unknown>(res: http.ServerResponse, status: number, body: ApiResponse<T>) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Health check
  if (req.method === "GET" && url.pathname === "/health") {
    return jsonBody(res, 200, { success: true, data: { status: "ok" } });
  }

  // Image routes
  if (url.pathname.startsWith("/image/")) {
    return imageRouter(req, res, url, { readBody, jsonBody });
  }

  // Video routes
  if (url.pathname.startsWith("/video/")) {
    return videoRouter(req, res, url, { readBody, jsonBody });
  }

  jsonBody(res, 404, { success: false, error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[media] server listening on port ${PORT}`);
});
