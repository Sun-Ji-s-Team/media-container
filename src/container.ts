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

// Internal-only entrypoint: accessed via service binding with entrypoint="MediaInternal"
// Public internet cannot reach this — only workers with the right binding config.
export class MediaInternal extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Background removal goes to dedicated container
    if (request.method === "POST" && url.pathname === "/image/remove-bg") {
      const id = this.env.BG_REMOVAL_CONTAINER.idFromName("default");
      const stub = this.env.BG_REMOVAL_CONTAINER.get(id);
      return stub.fetch(request);
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
