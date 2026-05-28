import { Container } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";

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

/**
 * Background removal via Cloudflare Images transformation.
 * Only works with publicly accessible image URLs.
 */
async function removeBackgroundViaCfImages(imageUrl: string, format: string): Promise<Response | null> {
  if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
    return null;
  }

  const ext = format === "webp" ? "webp" : "png";
  const cfImageUrl = `https://findai.one/cdn-cgi/image/format=${ext},background=transparent/${imageUrl}`;

  try {
    const resp = await fetch(cfImageUrl);
    if (!resp.ok) return null;

    const buffer = await resp.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return new Response(JSON.stringify({
      success: true,
      image: `data:image/${ext};base64,${base64}`,
    }), { headers: { "Content-Type": "application/json" } });
  } catch {
    return null;
  }
}

// Internal-only entrypoint: accessed via service binding with entrypoint="MediaInternal"
// Public internet cannot reach this — only workers with the right binding config.
export class MediaInternal extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    console.log(`[MediaInternal] ${request.method} ${url.pathname}`);

    // Background removal: use Cloudflare Images transformation
    if (request.method === "POST" && url.pathname === "/image/remove-bg") {
      try {
        const body = await request.text();
        const { image, format = "png" } = JSON.parse(body) as { image: string; format?: string };

        if (image && (image.startsWith("http://") || image.startsWith("https://"))) {
          const fallback = await removeBackgroundViaCfImages(image, format);
          if (fallback) return fallback;
        }

        return new Response(JSON.stringify({
          success: false,
          error: "Background removal requires a publicly accessible image URL",
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new Response(JSON.stringify({
          success: false,
          error: "Invalid request",
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // All other requests go to the media container
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
