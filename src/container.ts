import { Container } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { removeBackground } from "@imgly/background-removal";

export class MediaContainer extends Container {
  defaultPort = 8080;
  sleepAfter = 60_000;

  async onStart(): Promise<void> {
    console.log("[MediaContainer] starting media processing container");
  }

  async onError(err: Error): Promise<void> {
    console.error("[MediaContainer] error:", err.message);
  }

  async onStop(): Promise<void> {
    console.log("[MediaContainer] stopping");
  }
}

// Internal-only entrypoint: accessed via service binding with entrypoint="MediaInternal"
// Public internet cannot reach this — only workers with the right binding config.
export class MediaInternal extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle background removal directly in Worker (no container needed)
    if (request.method === "POST" && url.pathname === "/image/remove-bg") {
      try {
        const body = await request.json<{ image: string; format?: string }>();
        const { image, format = "png" } = body;

        let imageBuffer: ArrayBuffer;
        if (image.startsWith("data:")) {
          const b64 = image.includes("base64,") ? image.split("base64,")[1] : image.split(",")[1];
          imageBuffer = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
        } else if (image.startsWith("http://") || image.startsWith("https://")) {
          const resp = await fetch(image);
          if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
          imageBuffer = await resp.arrayBuffer();
        } else {
          imageBuffer = Uint8Array.from(atob(image), c => c.charCodeAt(0)).buffer;
        }

        const blob = await removeBackground(new Blob([imageBuffer]), {
          output: { format: format === "webp" ? "image/webp" : "image/png" },
        });

        const output = await blob.arrayBuffer();
        return new Response(output, {
          headers: { "Content-Type": format === "webp" ? "image/webp" : "image/png" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: err instanceof Error ? err.message : "Remove bg failed" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // All other requests go to the container
    const id = this.env.MEDIA_CONTAINER.idFromName("default");
    const stub = this.env.MEDIA_CONTAINER.get(id);
    return stub.fetch(request);
  }
}

interface Env {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MEDIA_CONTAINER: any;
  APP_ENV: string;
}

// Public internet → 403. Internal callers use MediaInternal entrypoint.
export default {
  fetch(): Response {
    return new Response(JSON.stringify({ success: false, error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  },
};
