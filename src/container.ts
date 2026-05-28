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

function extractSession(request: Request) {
  return {
    sessionCookie: request.headers.get("cookie") ?? undefined,
    authorization: request.headers.get("authorization") ?? undefined,
  };
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

// Internal-only entrypoint: accessed via service binding with entrypoint="MediaInternal"
// Public internet cannot reach this — only workers with the right binding config.
export class MediaInternal extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    console.log(`[MediaInternal] ${request.method} ${url.pathname}`);

    // Background removal: verify session, consume points, process
    if (request.method === "POST" && url.pathname === "/image/remove-bg") {
      let transactionId: string | undefined;
      try {
        const { sessionCookie, authorization } = extractSession(request);
        const { user } = await this.env.ACCOUNT_INTERNAL.verifySession({ sessionCookie, authorization });

        const body = await request.text();
        const { image, format = "png" } = JSON.parse(body) as { image: string; format?: string };

        if (!image) {
          return json({ success: false, error: "Image is required" }, { status: 400 });
        }

        const { transactionId: txId } = await this.env.ACCOUNT_INTERNAL.consumePoints({
          userId: user.userId,
          idempotencyKey: `remove-bg:${user.userId}:${Date.now()}`,
          source: { worker: "media", reason: "background_removal" },
        });
        transactionId = txId;

        // Try CF Images fallback for publicly accessible URLs
        if (image.startsWith("http://") || image.startsWith("https://")) {
          const fallback = await removeBackgroundViaCfImages(image, format);
          if (fallback) return fallback;
        }

        // Forward to container
        const id = this.env.MEDIA_CONTAINER.idFromName("default");
        const stub = this.env.MEDIA_CONTAINER.get(id);
        const resp = await stub.fetch(request);

        if (!resp.ok) {
          await this.env.ACCOUNT_INTERNAL.refundPoints({
            userId: user.userId,
            amount: undefined,
            idempotencyKey: `refund:remove-bg:${user.userId}:${Date.now()}`,
            relatedTransactionId: transactionId,
            source: { worker: "media", reason: "background_removal_failed" },
          });
        }
        return resp;
      } catch (err) {
        if (transactionId) {
          try {
            const { sessionCookie, authorization } = extractSession(request);
            const { user } = await this.env.ACCOUNT_INTERNAL.verifySession({ sessionCookie, authorization });
            await this.env.ACCOUNT_INTERNAL.refundPoints({
              userId: user.userId,
              idempotencyKey: `refund:remove-bg:${user.userId}:${Date.now()}`,
              relatedTransactionId: transactionId,
              source: { worker: "media", reason: "background_removal_error" },
            });
          } catch { /* best-effort refund */ }
        }
        const message = err instanceof Error ? err.message : "Processing failed";
        return json({ success: false, error: message }, { status: 500 });
      }
    }

    // All other requests: verify session, consume points, forward to container
    let transactionId: string | undefined;
    try {
      const { sessionCookie, authorization } = extractSession(request);
      const { user } = await this.env.ACCOUNT_INTERNAL.verifySession({ sessionCookie, authorization });

      const { transactionId: txId } = await this.env.ACCOUNT_INTERNAL.consumePoints({
        userId: user.userId,
        idempotencyKey: `media:${user.userId}:${Date.now()}`,
        source: { worker: "media", reason: "media_processing" },
      });
      transactionId = txId;

      const id = this.env.MEDIA_CONTAINER.idFromName("default");
      const stub = this.env.MEDIA_CONTAINER.get(id);
      const resp = await stub.fetch(request);

      if (!resp.ok) {
        await this.env.ACCOUNT_INTERNAL.refundPoints({
          userId: user.userId,
          idempotencyKey: `refund:media:${user.userId}:${Date.now()}`,
          relatedTransactionId: transactionId,
          source: { worker: "media", reason: "media_processing_failed" },
        });
      }
      return resp;
    } catch (err) {
      if (transactionId) {
        try {
          const { sessionCookie, authorization } = extractSession(request);
          const { user } = await this.env.ACCOUNT_INTERNAL.verifySession({ sessionCookie, authorization });
          await this.env.ACCOUNT_INTERNAL.refundPoints({
            userId: user.userId,
            idempotencyKey: `refund:media:${user.userId}:${Date.now()}`,
            relatedTransactionId: transactionId,
            source: { worker: "media", reason: "media_processing_error" },
          });
        } catch { /* best-effort refund */ }
      }
      const message = err instanceof Error ? err.message : "Processing failed";
      return json({ success: false, error: message }, { status: 500 });
    }
  }
}

interface Env {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MEDIA_CONTAINER: any;
  ACCOUNT_INTERNAL: {
    verifySession(input: { sessionCookie?: string; authorization?: string }): Promise<{
      user: { userId: string; email: string | null; displayName: string | null; avatarUrl: string | null; role: "user" | "admin"; status: "active" | "banned" };
      session: { expiresAt: number };
    }>;
    consumePoints(body: { userId?: string; amount?: number; idempotencyKey?: string; relatedTransactionId?: string; source?: { worker?: string; projectId?: string; jobId?: string; reason?: string } }): Promise<{ transactionId: string; balance: number }>;
    refundPoints(body: { userId?: string; amount?: number; idempotencyKey?: string; relatedTransactionId?: string; source?: { worker?: string; projectId?: string; jobId?: string; reason?: string } }): Promise<{ transactionId: string; balance: number }>;
  };
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
