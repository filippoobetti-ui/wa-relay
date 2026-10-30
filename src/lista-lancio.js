// Lista del lancio (30/10/2026, richiesta di Filippo): il modulo nella pagina «in arrivo» di www.tixcantiere.it.
// POST /lista/iscrivi (dal modulo), GET /lista/conferma?t= (link dell'email), GET e POST /lista/cancella?t= e
// /lista/no-whatsapp?t= (link delle email). Versione 2 dopo il parere legale del 30/10/2026 sera.
// Controlli, salvataggio, email di conferma e posizione li fa il database (funzioni lista_lancio_*); qui solo
// trappole per i programmi automatici e le pagine di risposta. Interruttore: impostazioni.lista_lancio_attiva.

const LISTA_ORIGINI = new Set(["https://www.tixcantiere.it", "https://wa-relay.filippo-obetti.workers.dev"]);

function listaEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function listaRpc(env, nome, corpo) {
  const supabaseUrl = env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(supabaseUrl + "/rest/v1/rpc/" + nome, {
      method: "POST",
      headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(corpo), signal: ctrl.signal
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

async function listaImpronta(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function listaJson(dati, stato) {
  return new Response(JSON.stringify(dati), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
  });
}

// Pagina di risposta con lo stesso aspetto della pagina «in arrivo».
function listaPagina(titolo, corpo, prefisso) {
  const html = '<!doctype html><html lang="it"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    '<meta name="referrer" content="no-referrer"><meta name="theme-color" content="#052A21">' +
    '<title>' + listaEsc(titolo) + ' — TIX · Diario di cantiere</title><style>' +
    '*{box-sizing:border-box}html,body{margin:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 16px;' +
    'background:radial-gradient(120% 140% at 50% -10%,#0A3C2E 0%,#052A21 60%,#031a15 100%);color:#fff;text-align:center;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}' +
    'main{max-width:460px}.marchio{font-weight:800;letter-spacing:.02em;color:#F26A10;font-size:15px;margin-bottom:18px}' +
    'h1{font-size:clamp(22px,5vw,28px);line-height:1.3;margin:0 0 14px}p{color:#CFE6DB;line-height:1.55;font-size:16px;margin:0 0 14px}' +
    '.numero{display:inline-block;margin:6px 0 18px;padding:10px 22px;border-radius:999px;background:rgba(18,183,100,.16);border:1px solid rgba(31,210,119,.35);color:#1FD277;font-weight:800;font-size:20px}' +
    'a{color:#fff}button{font:inherit;font-weight:700;font-size:16px;padding:12px 22px;border:0;border-radius:10px;background:#12B764;color:#052A21;cursor:pointer;min-height:44px}' +
    'button:focus-visible,a:focus-visible{outline:2px solid #1FD277;outline-offset:2px}' +
    '</style></head><body><main><div class="marchio">TIX · Diario di cantiere</div>' + corpo +
    '<p style="margin-top:22px;font-size:14px"><a href="' + listaEsc(prefisso + "/") + '">Torna alla pagina di TIX</a></p></main></body></html>';
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer" }
  });
}

const LISTA_LINK_NON_VALIDO = '<h1>Questo link non vale più</h1><p>Forse l\'hai già usato, oppure sono passati più di 7 giorni. ' +
  'Puoi iscriverti di nuovo dalla pagina di TIX.</p>';

export async function listaLancioRoute(request, env, sotto, prefisso) {
  const url = new URL(request.url);

  if (sotto === "/lista/iscrivi") {
    if (request.method !== "POST") return listaJson({ esito: "non_valido" }, 405);
    const origine = request.headers.get("origin") || "";
    if (origine && !LISTA_ORIGINI.has(origine)) return listaJson({ esito: "non_valido" }, 403);
    if (Number(request.headers.get("content-length") || 0) > 4096) return listaJson({ esito: "non_valido" }, 413);
    let d;
    try { d = JSON.parse((await request.text()).slice(0, 4096)); } catch (e) { return listaJson({ esito: "non_valido" }, 400); }
    if (!d || typeof d !== "object") return listaJson({ esito: "non_valido" }, 400);
    // trappole per i programmi automatici: campo nascosto compilato o modulo inviato in meno di 3 secondi → finta risposta ok
    if (d.sito_web || (Number(d.t_ms) >= 0 && Number(d.t_ms) < 3000)) return listaJson({ esito: "ok" });
    if (d.email_ok !== true) return listaJson({ esito: "non_valido" });
    const ip = request.headers.get("cf-connecting-ip") || "";
    const giorno = new Date().toISOString().slice(0, 10);   // impronta che cambia ogni giorno: serve solo al limite di invii
    const ipHash = ip ? (await listaImpronta("lista|" + giorno + "|" + ip)).slice(0, 32) : null;
    const r = await listaRpc(env, "lista_lancio_iscrivi", { p: {
      nome: String(d.nome || "").slice(0, 60), cognome: String(d.cognome || "").slice(0, 60),
      impresa: String(d.impresa || "").slice(0, 120), email: String(d.email || "").slice(0, 160),
      telefono: d.whatsapp === true ? String(d.telefono || "").slice(0, 30) : "", email_ok: true, whatsapp: d.whatsapp === true, ip_hash: ipHash
    } });
    return listaJson({ esito: r && r.esito ? r.esito : "errore" });
  }

  if (sotto === "/lista/conferma") {
    const r = await listaRpc(env, "lista_lancio_conferma", { p_token: url.searchParams.get("t") || "" });
    if (!r || r.esito !== "ok") return listaPagina("Link non valido", LISTA_LINK_NON_VALIDO, prefisso);
    return listaPagina("Iscrizione confermata",
      '<h1>Fatto, ' + listaEsc(r.nome || "") + '!</h1><p>Sei nella lista del lancio di TIX.</p>' +
      '<div class="numero">n. ' + listaEsc(r.posizione) + '</div>' +
      (r.entro_offerta
        ? '<p>Sei tra i primi ' + listaEsc(r.posti) + ' iscritti confermati: ti riserveremo l\'offerta di lancio, con condizioni che pubblicheremo il giorno dell\'apertura.</p>'
        : '<p>I primi ' + listaEsc(r.posti) + ' posti dell\'offerta di lancio sono già stati presi, ma il giorno dell\'apertura ti avviseremo comunque.</p>') +
      '<p>Ti abbiamo mandato un\'email di riepilogo. L\'iscrizione non obbliga a nessun acquisto.</p>', prefisso);
  }

  if (sotto === "/lista/no-whatsapp") {
    if (request.method === "POST") {
      let t = "";
      try { t = String((await request.formData()).get("t") || ""); } catch (e) { t = ""; }
      const r = await listaRpc(env, "lista_lancio_no_whatsapp", { p_token: t });
      if (!r || r.esito !== "ok") return listaPagina("Link non valido", LISTA_LINK_NON_VALIDO, prefisso);
      return listaPagina("WhatsApp tolto", '<h1>Niente più WhatsApp</h1><p>Abbiamo tolto il tuo numero di telefono. Resti nella lista e ti avviseremo solo per email.</p>', prefisso);
    }
    const t = url.searchParams.get("t") || "";
    return listaPagina("Togliere WhatsApp",
      '<h1>Non vuoi più messaggi su WhatsApp?</h1><p>Cancelliamo il tuo numero di telefono. Resti nella lista e ti avviseremo solo per email.</p>' +
      '<form method="post" action="' + listaEsc(prefisso + "/lista/no-whatsapp") + '"><input type="hidden" name="t" value="' + listaEsc(t) + '">' +
      '<button type="submit">Sì, niente WhatsApp</button></form>', prefisso);
  }

  if (sotto === "/lista/cancella") {
    if (request.method === "POST") {
      let t = "";
      try { t = String((await request.formData()).get("t") || ""); } catch (e) { t = ""; }
      const r = await listaRpc(env, "lista_lancio_cancella", { p_token: t });
      if (!r || r.esito !== "ok") return listaPagina("Link non valido", LISTA_LINK_NON_VALIDO, prefisso);
      return listaPagina("Cancellazione fatta", '<h1>Ti abbiamo cancellato</h1><p>I tuoi dati sono stati eliminati dalla lista del lancio. Non riceverai altri messaggi.</p>', prefisso);
    }
    // con il link si apre solo la domanda: la cancellazione parte dal pulsante (i programmi che aprono i link da soli non cancellano nessuno)
    const t = url.searchParams.get("t") || "";
    return listaPagina("Cancellati dalla lista",
      '<h1>Vuoi uscire dalla lista del lancio?</h1><p>Cancelliamo subito nome, email e telefono.</p>' +
      '<form method="post" action="' + listaEsc(prefisso + "/lista/cancella") + '"><input type="hidden" name="t" value="' + listaEsc(t) + '">' +
      '<button type="submit">Sì, cancellami</button></form>', prefisso);
  }

  return Response.redirect(url.origin + prefisso + "/", 302);
}
