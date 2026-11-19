// ============================================================================
// AVVISI SUL TELEFONO — iscrizione dalla pagina dei cantieri (19/11/2026, push-portale-1, chat B15).
// Il pulsante «Ricevi gli avvisi sul telefono» è nell'elenco dei cantieri (portale_azioni_html, chat B15).
// L'invio cifrato degli avvisi è della B4 (src/notifiche-push.js).
//   POST /push/api  {t, azione: "stato" | "salva" | "spegni", dati: {endpoint, p256dh, auth, dispositivo, browser, promemoria_diario}}
//   → database: push_portale (chiusa ad anon), che riconosce la persona dal suo accesso personale.
// Regole della B12: niente tracce di apertura o di clic, il promemoria del diario lo accende solo la persona.
// PUSH_PORTALE = "off" nel Worker spegne questa pagina.
// ============================================================================

function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: {
    "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
function corto(x, max) { return x == null ? null : String(x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }

export async function portalePushApi(request, env, h) {
  if (env.PUSH_PORTALE === "off") return new Response("Not Found", { status: 404 });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  if (!env.SUPABASE_SERVICE_KEY) return json({ esito: "errore" }, 503);
  let b = null;
  try { b = await request.json(); } catch (e) { b = null; }
  const tok = (String(b && b.t || "").match(/^[0-9a-fA-F]{64}$/) || [""])[0].toLowerCase();
  const az = String(b && b.azione || "");
  if (!tok) return json({ esito: "gettone" }, 400);
  if (az !== "stato" && az !== "salva" && az !== "spegni") return json({ esito: "errore" }, 400);
  const d = b && b.dati && typeof b.dati === "object" ? b.dati : {};
  const dati = { endpoint: corto(d.endpoint, 1000) || "" };
  if (az === "salva") {
    dati.p256dh = corto(d.p256dh, 120) || "";
    dati.auth = corto(d.auth, 40) || "";
    dati.dispositivo = corto(d.dispositivo, 60);
    dati.browser = corto(d.browser, 60);
    if (d.promemoria_diario === true || d.promemoria_diario === false) dati.promemoria_diario = d.promemoria_diario;
  }
  const r = await h.rpc(env, "push_portale", { p_token: tok, p_azione: az, p_dati: dati }, 10000).catch(() => null);
  return json(r || { esito: "errore" }, r ? 200 : 503);
}
