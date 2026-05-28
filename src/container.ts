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

export class BgRemovalContainer extends Container {
  defaultPort = 8080;
  sleepAfter = 60_000;

  async onStart(): Promise<void> {
    console.log("[BgRemovalContainer] starting background removal container");
  }

  async onError(err: Error): Promise<void> {
    console.error("[BgRemovalContainer] error:", err.message);
  }

  async onStop(): Promise<void> {
    console.log("[BgRemovalContainer] stopping");
  }
}

/**
 * Fallback: use Cloudflare Images transformation for background removal.
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

    // Background removal: try container first, fallback to CF Images
    if (request.method === "POST" && url.pathname === "/image/remove-bg") {
      const body = await request.clone().text();

      try {
        const id = this.env.BG_REMOVAL_CONTAINER.idFromName("default");
        const stub = this.env.BG_REMOVAL_CONTAINER.get(id);
        const resp = await stub.fetch(new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body,
        }));

        if (resp.ok) return resp;

        // Container failed, try CF Images fallback
        console.log("[MediaInternal] container failed, trying CF Images fallback");
        const { image, format = "png" } = JSON.parse(body) as { image: string; format?: string };
        const fallback = await removeBackgroundViaCfImages(image, format);
        if (fallback) return fallback;

        // Return original container error
        return resp;
      } catch (err) {
        // Container unreachable, try CF Images fallback
        console.log("[MediaInternal] container error, trying CF Images fallback:", err);
        try {
          const { image, format = "png" } = JSON.parse(body) as { image: string; format?: string };
          const fallback = await removeBackgroundViaCfImages(image, format);
          if (fallback) return fallback;
        } catch { /* ignore parse errors */ }

        return new Response(JSON.stringify({ success: false, error: "Background removal service unavailable" }), {
          status: 503,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BG_REMOVAL_CONTAINER: any;
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
