/**
 * wa-relay - Worker Cloudflare per il Giornale Lavori digitale
 *
 * Fa da ponte tra Meta WhatsApp Cloud API e il custom webhook di Make,
 * riproducendo esattamente il formato prodotto dal connettore nativo
 * whatsapp-business-cloud (modulo id 3 "WA Events"), cosi i riferimenti
 * gia presenti nello scenario restano validi senza modifiche.
 *
 * Secrets richiesti (Cloudflare dashboard -> Worker -> Settings -> Variables
 * and Secrets -> Add, tipo "Secret"):
 *   META_VERIFY_TOKEN  -> stringa a tua scelta
 *   META_APP_SECRET    -> Chiave segreta dell'app Meta
 *   MAKE_WEBHOOK_URL   -> URL del custom webhook Make
 */

export default {
    async fetch(request, env, ctx) {
          const url = new URL(request.url);

      if (request.method === "GET") {
              const mode = url.searchParams.get("hub.mode");
              const token = url.searchParams.get("hub.verify_token");
              const challenge = url.searchParams.get("hub.challenge");

            if (mode === "subscribe" && token === env.META_VERIFY_TOKEN) {
                      return new Response(challenge, {
                                  status: 200,
                                  headers: { "Content-Type": "text/plain" },
                      });
            }
              return new Response("Forbidden", { status: 403 });
      }

      if (request.method === "POST") {
              const rawBody = await request.text();

            const signatureHeader = request.headers.get("X-Hub-Signature-256") || "";
              const valid = await verifySignature(rawBody, signatureHeader, env.META_APP_SECRET);
              if (!valid) {
                        return new Response("Invalid signature", { status: 403 });
              }

            ctx.waitUntil(forwardToMake(rawBody, env.MAKE_WEBHOOK_URL));
              return new Response("OK", { status: 200 });
      }

      return new Response("Method Not Allowed", { status: 405 });
    },
};

async function verifySignature(rawBody, signatureHeader, appSecret) {
    if (!signatureHeader.startsWith("sha256=")) return false;
    const expectedHex = signatureHeader.slice(7);

  const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const macHex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (macHex.length !== expectedHex.length) return false;
    let diff = 0;
    for (let i = 0; i < macHex.length; i++) {
          diff |= macHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    return diff === 0;
}

async function forwardToMake(rawBody, makeWebhookUrl) {
    let payload;
    try {
          payload = JSON.parse(rawBody);
    } catch (e) {
          return;
    }

  const entries = payload.entry || [];
    for (const entry of entries) {
          const changes = entry.changes || [];
          for (const change of changes) {
                  const value = change.value || {};

            if (!value.messages || value.messages.length === 0) continue;

            const bundle = {
                      id: entry.id,
                      time: value.messages[0] && value.messages[0].timestamp
                        ? Number(value.messages[0].timestamp)
                                  : Math.floor(Date.now() / 1000),
                      field: change.field,
                      messages: value.messages,
                      contacts: value.contacts || [],
            };

            try {
                      await fetch(makeWebhookUrl, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify(bundle),
                      });
            } catch (e) {
                      // errore di rete verso Make: valutare una coda di retry in futuro
            }
          }
    }
}
