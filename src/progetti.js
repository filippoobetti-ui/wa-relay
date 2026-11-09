// ============================================================================
// PROGETTI DEL CANTIERE — area riservata (08/11/2026, progetti-1, fase P1). Il pulsante «📐 Progetti» della pagina del
// cantiere apre la pagina delle tavole: architettonico, strutturale, impianti, altro. Per ogni tavola: codice, titolo,
// revisione, variante, chi l'ha caricata e quando, impronta SHA-256. Si vedono e si aprono SOLO le revisioni in vigore:
// quando arriva la revisione nuova di un codice, quella di prima diventa «Superata», resta nel database e nell'archivio,
// ma non si vede più nell'app (decisione di Filippo, 08/11/2026). TIX conserva e ordina le tavole: non controlla i disegni.
//   GET  /progetti?t=<gettone>&c=<cantiere>               → pagina (database: progetti_contesto)
//   POST /progetti/carica  intestazione X-Progetti-Dati = JSON in base64url {t, c, tipo, codice, titolo, revisione,
//                          variante, autore, nome, byte, sha256}; corpo = il file (PDF o .p7m, fino a progetti_max_mb)
//   POST /progetti/azione  {t, c, azione: "annulla", id, dati: {chi, motivo}}
//                          {t, c, azione: "sposta", dati: {ids: [...], tipo, chi}}  (09/11/2026, sposta-1: categoria nuova con
//                          storico, anche le revisioni superate dello stesso codice; interruttore impostazioni.progetti_sposta_attiva)
//                          {t, c, azione: "lotto", dati: {ids: [...], lotto, chi}}  (09/11/2026, lotto-1: «Fabbricato / lotto»
//                          facoltativo; nel caricamento X-Progetti-Dati ha anche «lotto»; interruttore impostazioni.progetti_lotto_attiva)
//   GET  /progetti/file?t=…&c=…&id=…[&scarica=1]          → il file della revisione in vigore
// Caricamento come la Sicurezza: prima il controllo nel database (progetti_carica_controlla), poi il corpo; tipo letto dai
// primi byte; impronta ricalcolata qui solo fino a 5 MB (CPU del piano gratuito), altrimenti vale quella del browser.
// Il file va in wa-media (documenti/<cantiere>/progetti/AAAAMMGG-<12 esadecimali>), con un collegamento firmato di 30 giorni
// per l'archivio su Drive (scenario Make da fare: fino ad allora la copia resta in wa-media).
// Interruttori: impostazioni.progetti_attiva (no / prova = solo Filippo / si) e PROGETTI = "off" nel Worker.
// Email (progetti_email_attive) e tavola su WhatsApp (P2): non in questo file.
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERIFICA_MAX = 5 * 1024 * 1024;   // il Worker ricalcola l'impronta solo fino a 5 MB
const LINK_SECONDI = 2592000;           // collegamento firmato di 30 giorni per l'archivio
const TIPI = [
  ["architettonico", "Architettonico"],
  ["strutturale", "Strutturale"],
  ["impianti", "Impianti"],
  ["altro", "Altro"]
];

function supabaseUrl(env) {
  return env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co";
}
function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: {
    "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
function lista(a) { return Array.isArray(a) ? a : []; }
function testo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function casuale(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function esadecimale(buf) { return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join(""); }
function daB64url(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return new TextDecoder().decode(u);
}
function percorsoStorage(p) { return String(p).split("/").map(encodeURIComponent).join("/"); }
function parametri(inUrl) {
  const s = inUrl.searchParams;
  const m = String(s.get("t") || "").match(/[0-9a-fA-F]{64}/);
  const c = String(s.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  return { tok: m ? m[0].toLowerCase() : "", c };
}
function dataIt(iso) { return /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(String(iso || "")) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : ""; }
function quando(ts) {   // "2026-11-08T18:20" → "08/11/2026 alle 18:20"
  const s = String(ts || "");
  return dataIt(s) + (/T[0-9]{2}:[0-9]{2}/.test(s) ? " alle " + s.slice(11, 16) : "");
}
function mb(n) {
  const x = Number(n) || 0;
  if (x >= 1048576) return (Math.round(x / 104857.6) / 10).toString().replace(".", ",") + " MB";
  return Math.max(1, Math.round(x / 1024)) + " KB";
}

// ---------------------------------------------------------------------------- pulsante nella pagina del cantiere
// Chiamata fatta da index.js insieme a dashboard_html: qualsiasi errore o attesa oltre 8 secondi = nessun pulsante.
export async function progettiPulsante(env, token, commessa) {
  if (!env || !env.SUPABASE_SERVICE_KEY || env.PROGETTI === "off") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(supabaseUrl(env) + "/rest/v1/rpc/progetti_pulsante", {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_token: token, p_commessa: commessa }), signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j !== "object" || j.esito !== "ok" || j.attiva !== true) return null;
    return { attiva: true, modo: String(j.modo || ""), tavole: Math.max(0, Math.min(9999, Number(j.tavole_in_vigore) || 0)) };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Sesto pulsante della riga dei pulsanti del cantiere (la riga la compone economie.js, riga(), che rimette in ordine i suoi
// cinque): questo script gira DOPO quello di economie.js (index.js lo mette prima nella catena) e rimette «Progetti» in fondo
// anche dopo i riordini di riga() all'avvio. Da solo, se la riga non c'è, va sotto le schede come «Sicurezza».
export function progettiIniezione(base, token, commessa) {
  const u = base + "/progetti?t=" + token + "&c=" + encodeURIComponent(commessa);
  const icona = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3.5 20.5 13 4"/><path d="M20.5 20.5 11 4"/><circle cx="12" cy="4" r="1.6"/><path d="M6.3 15.7c3.6 2 7.8 2 11.4 0"/></svg>';
  return "<style>.gl-pg-barra{max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right}" +
    ".gl-pg-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 16px;border:1.5px solid #7A4E2D;border-radius:10px;background:#F8F1EA;color:#5C3A20;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none;box-shadow:0 0 0 3px rgba(122,78,45,.14)}" +
    ".gl-pg-b:hover,.gl-pg-b:focus-visible{background:#7A4E2D;color:#fff;outline:none}" +
    // con sei pulsanti: 6 colonne sul computer largo, 3 fino a 1100 px, 2 fino a 900 px, 1 sul telefono
    ".gl-azioni.gl-az5.gl-az6{grid-template-columns:repeat(6,minmax(0,1fr))}" +
    "@media (max-width:1100px){.gl-azioni.gl-az5.gl-az6{grid-template-columns:repeat(3,minmax(0,1fr))}}" +
    "@media (max-width:900px){.gl-azioni.gl-az5.gl-az6{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
    "@media (max-width:640px){.gl-azioni.gl-az5.gl-az6{grid-template-columns:minmax(0,1fr)}}" +
    "@media (prefers-color-scheme:dark){.gl-pg-b{background:#2e2016;color:#f0dcc8;border-color:#A86F44}}</style>" +
    "<script>(function(){try{var a=document.createElement('a');a.className='gl-pg-b';a.href=" + JSON.stringify(u) + ";a.innerHTML=" + JSON.stringify(icona + " Progetti") + ";" +
    "function metti(){var r=document.querySelector('.gl-azioni');var v=document.querySelector('.gl-pg-barra');" +
    "if(r){if(r.lastElementChild!==a)r.appendChild(a);if(v&&!v.children.length&&v.parentNode)v.parentNode.removeChild(v);" +
    "var n=r.children.length;r.classList.toggle('gl-az4',n===4);r.classList.toggle('gl-az5',n>=5);r.classList.toggle('gl-az6',n>=6);return;}" +
    "if(a.parentNode)return;var b=document.createElement('div');b.className='gl-pg-barra';b.appendChild(a);var nav=document.querySelector('nav.schede');" +
    "if(nav&&nav.parentNode){nav.parentNode.insertBefore(b,nav.nextSibling);}else{document.body.insertBefore(b,document.body.firstChild);}}" +
    "metti();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',metti);setTimeout(metti,0);setTimeout(metti,60);}catch(e){}})();</script>";
}

// ---------------------------------------------------------------------------- rotte
export async function portaleProgetti(request, env, base, inUrl, h) {
  if (env.PROGETTI === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");
  if (sotto === "/progetti/carica") return carica(request, env, h);
  if (sotto === "/progetti/azione") return azione(request, env, h);
  if (sotto === "/progetti/file") return apriFile(request, env, base, inUrl, h);
  if (sotto !== "/progetti") return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const p = parametri(inUrl);
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!UUID.test(p.c)) return Response.redirect(inUrl.origin + base + "/?t=" + p.tok, 303);
  const torna = base + "/?t=" + p.tok + "&c=" + p.c;
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>';
  const d = await h.rpc(env, "progetti_contesto", { p_token: p.tok, p_commessa: p.c }, 20000).catch(() => null);
  if (!d || typeof d !== "object") return h.risposta(h.foglio(base, "Progetti del cantiere", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Progetti del cantiere", "Questa pagina non è disponibile per questo cantiere.", indietro), 404);
  return h.risposta(pagina(base, h, p, d, torna));
}

// ---------------------------------------------------------------------------- caricamento (un file per richiesta)
async function carica(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  const grezzo = String(request.headers.get("X-Progetti-Dati") || "");
  let d = null;
  if (grezzo && grezzo.length <= 16000 && /^[A-Za-z0-9_-]+$/.test(grezzo)) {
    try { d = JSON.parse(daB64url(grezzo)); } catch (e) { d = null; }
  }
  if (!d || typeof d !== "object") return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c)) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const nome = testo(d.nome, 200).replace(/[\\/]+/g, " ");
  const byte = Number(d.byte);
  const sha = String(d.sha256 || "").toLowerCase();
  const dati = {
    tipo: testo(d.tipo, 40), codice: testo(d.codice, 60), titolo: testo(d.titolo, 200), revisione: testo(d.revisione, 30),
    variante: d.variante === true, autore: testo(d.autore, 120), nome, byte, sha256: sha, lotto: testo(d.lotto, 60)
  };
  const dichiarati = Number(request.headers.get("Content-Length") || 0);
  if (!Number.isFinite(byte) || byte <= 0) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (dichiarati && dichiarati !== byte) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  // prima l'accesso, l'interruttore, il cantiere aperto e la misura: chi non può caricare non scrive niente nell'archivio
  const ctl = await h.rpc(env, "progetti_carica_controlla", { p_token: tok, p_commessa: c,
    p_dati: { tipo: dati.tipo, codice: dati.codice, revisione: dati.revisione, nome, byte } }, 10000).catch(() => null);
  if (!ctl || typeof ctl !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 502);
  if (ctl.esito !== "ok") return json(ctl, ctl.esito === "gettone" ? 403 : 200);
  const cartella = "documenti/" + c + "/progetti/";
  const est = ctl.est === "p7m" ? "p7m" : ctl.est === "pdf" ? "pdf" : "";
  const max = Number(ctl.max_byte) || 0;
  if (ctl.cartella !== cartella || !est || !max) return json({ esito: "errore", messaggio: "Richiesta non valida: ricarica la pagina." }, 502);
  const troppo = "Il file è troppo grande: in TIX una tavola arriva fino a " + Math.round(max / 1048576) + " MB.";
  if (dichiarati > max) return json({ esito: "grande", messaggio: troppo }, 413);
  if (!/^[0-9a-f]{64}$/.test(sha)) return json({ esito: "errore", messaggio: "Manca l'impronta del file: ricarica la pagina e riprova." }, 400);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length > max) return json({ esito: "grande", messaggio: troppo }, 413);
  if (bytes.length !== byte) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  if (est === "pdf") {
    const testa = String.fromCharCode.apply(null, Array.from(bytes.subarray(0, 1024)));
    if (testa.indexOf("%PDF-") === -1) return json({ esito: "formato", messaggio: "Il file non sembra un PDF: controlla di aver scelto quello giusto." }, 415);
  } else if (bytes[0] !== 0x30) {
    return json({ esito: "formato", messaggio: "Il file .p7m non è nel formato binario dei documenti firmati: salvalo di nuovo dal programma di firma, oppure carica il PDF." }, 415);
  }
  if (bytes.length <= VERIFICA_MAX && esadecimale(await crypto.subtle.digest("SHA-256", bytes)) !== sha) {
    return json({ esito: "impronta", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  }
  const ora = new Date();
  const giorno = ora.getUTCFullYear() + String(ora.getUTCMonth() + 1).padStart(2, "0") + String(ora.getUTCDate()).padStart(2, "0");
  const percorso = cartella + giorno + "-" + casuale(6) + "." + est;
  const svc = env.SUPABASE_SERVICE_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let url = "", scade = "";
  try {
    const up = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(percorso), {
      method: "POST",
      headers: { Authorization: "Bearer " + svc, apikey: svc, "Content-Type": ctl.mime === "application/pkcs7-mime" ? "application/pkcs7-mime" : "application/pdf", "x-upsert": "false" },
      body: bytes, signal: ctrl.signal
    });
    if (!up.ok) return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
    const sg = await fetch(supabaseUrl(env) + "/storage/v1/object/sign/wa-media/" + percorsoStorage(percorso), {
      method: "POST",
      headers: { Authorization: "Bearer " + svc, apikey: svc, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: LINK_SECONDI }), signal: ctrl.signal
    });
    const sj = sg.ok ? await sg.json().catch(() => null) : null;
    if (!sj || typeof sj.signedURL !== "string") throw new Error("firma");
    url = supabaseUrl(env) + "/storage/v1" + sj.signedURL;
    scade = new Date(Date.now() + LINK_SECONDI * 1000).toISOString();
  } catch (e) {
    await togli(env, percorso, c);
    return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } finally {
    clearTimeout(timer);
  }
  const r = await h.rpc(env, "progetti_tavola_registra", { p_token: tok, p_commessa: c,
    p_dati: Object.assign({}, dati, { byte: bytes.length, percorso, url, url_scade: scade }) }, 15000).catch(() => null);
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Non so se la tavola è stata registrata: ricarica la pagina prima di riprovare." }, 502);
  if (r.esito !== "ok") {
    await togli(env, percorso, c);
    return json(r, r.esito === "gettone" ? 403 : 200);
  }
  return json({ esito: "ok", id: r.id, superate: r.superate });
}

// Toglie dall'archivio una copia di questo cantiere appena caricata (mai altro).
async function togli(env, percorso, c) {
  const p = String(percorso || "");
  if (!UUID.test(c) || !new RegExp("^documenti/" + c + "/progetti/[0-9]{8}-[0-9a-f]{12}\\.(pdf|p7m)$").test(p)) return false;
  try {
    const r = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(p), {
      method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } });
    return r.ok;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------- azioni sulle tavole
async function azione(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  if (Number(request.headers.get("Content-Length") || 0) > 20000) return json({ esito: "richiesta_non_valida" }, 413);
  let d = null;
  try { d = await request.json(); } catch (e) { d = null; }
  if (!d || typeof d !== "object") return json({ esito: "richiesta_non_valida" }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const id = String(d.id || "").toLowerCase();
  const c = String(d.c || "").toLowerCase();
  const a = String(d.azione || "");
  const dati = d.dati && typeof d.dati === "object" && !Array.isArray(d.dati) ? d.dati : {};
  if (!tok) return json({ esito: "gettone" }, 403);
  let r = null;
  if (a === "annulla") {
    if (!UUID.test(id)) return json({ esito: "richiesta_non_valida" }, 400);
    r = await h.rpc(env, "progetti_tavola_annulla", { p_token: tok, p_id: id, p_motivo: testo(dati.motivo, 300), p_chi: testo(dati.chi, 120) }, 15000).catch(() => null);
  } else if (a === "sposta") {
    const ids = Array.from(new Set(lista(dati.ids).map((x) => String(x || "").toLowerCase()).filter((x) => UUID.test(x))));
    if (!UUID.test(c) || !ids.length || ids.length > 400) return json({ esito: "richiesta_non_valida" }, 400);
    r = await h.rpc(env, "progetti_tavole_sposta", { p_token: tok, p_commessa: c, p_ids: ids, p_tipo: testo(dati.tipo, 40), p_chi: testo(dati.chi, 120) }, 15000).catch(() => null);
  } else if (a === "lotto") {
    const ids = Array.from(new Set(lista(dati.ids).map((x) => String(x || "").toLowerCase()).filter((x) => UUID.test(x))));
    if (!UUID.test(c) || !ids.length || ids.length > 400) return json({ esito: "richiesta_non_valida" }, 400);
    r = await h.rpc(env, "progetti_tavole_lotto", { p_token: tok, p_commessa: c, p_ids: ids, p_lotto: testo(dati.lotto, 60), p_chi: testo(dati.chi, 120) }, 15000).catch(() => null);
  } else if (a === "destinatari" || a === "destinatario_aggiungi" || a === "destinatario_togli") {
    if (!UUID.test(c)) return json({ esito: "richiesta_non_valida" }, 400);
    const az = a === "destinatario_aggiungi" ? "aggiungi" : a === "destinatario_togli" ? "togli" : "elenco";
    r = await h.rpc(env, "progetti_destinatari_azione", { p_token: tok, p_commessa: c, p_azione: az,
      p_dati: { email: testo(dati.email, 200), nome: testo(dati.nome, 120), ruolo: testo(dati.ruolo, 60), chi: testo(dati.chi, 120), id: testo(dati.id, 40) } }, 15000).catch(() => null);
  } else {
    return json({ esito: "richiesta_non_valida" }, 400);
  }
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 503);
  return json(r, r.esito === "gettone" ? 403 : 200);
}

// ---------------------------------------------------------------------------- apertura del file (solo revisione in vigore)
async function apriFile(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const p = parametri(inUrl);
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  const scarica = inUrl.searchParams.get("scarica") === "1";
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const e = h.esc;
  const torna = base + "/progetti?t=" + p.tok + "&c=" + p.c;
  const indietro = '<a class="btn" href="' + e(torna) + '">Torna ai Progetti del cantiere</a>';
  if (!UUID.test(p.c) || !UUID.test(id)) return h.risposta(h.foglio(base, "Tavola non trovata", "", indietro), 404);
  const info = await h.rpc(env, "progetti_file_info", { p_token: p.tok, p_id: id }, 10000).catch(() => null);
  if (!info || typeof info !== "object") return h.risposta(h.foglio(base, "Tavola", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (info.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (info.esito === "superata") {
    return h.risposta(h.foglio(base, "Questa revisione non è più in vigore", "È arrivata una revisione nuova di questa tavola: apri quella dai Progetti del cantiere.", indietro), 410);
  }
  if (info.esito !== "ok" || String(info.commessa_id || "") !== p.c) return h.risposta(h.foglio(base, "Tavola non trovata", "", indietro), 404);
  const radice = "documenti/" + p.c + "/progetti/";
  let cacheMancante = false, guasto = false;
  for (const [percorso, copia] of [[info.transito, "transito"], [info.cache, "cache"]]) {
    const ps = String(percorso || "");
    if (!ps || ps.indexOf(radice) !== 0 || ps.indexOf("..") !== -1) continue;
    const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(ps), {
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
    if (f && f.ok) return servi(f, info, scarica, metodo);
    if (f && (f.status === 400 || f.status === 404)) { if (copia === "cache") cacheMancante = true; }
    else guasto = true;
  }
  if (guasto) return h.risposta(h.foglio(base, "Tavola", "Il file non si legge dall'archivio in questo momento: riprova tra un minuto.", indietro), 502);
  if (!info.drive) return h.risposta(h.foglio(base, "Tavola", "Il file di questa tavola non è disponibile in questo momento. Riprova tra qualche minuto.", indietro), 404);
  // c'è solo su Drive: si chiede a Make di riprenderla (la sveglia la manda il database) e la pagina aspetta
  const riprova = inUrl.searchParams.get("riprova") === "1";
  const giro = Math.max(0, Math.min(99, parseInt(inUrl.searchParams.get("n") || "0", 10) || 0));
  const qui = base + "/progetti/file?t=" + p.tok + "&c=" + p.c + "&id=" + id + (scarica ? "&scarica=1" : "");
  const rec = await h.rpc(env, "progetti_recupero_chiedi", { p_token: p.tok, p_id: id,
    p_dati: Object.assign({}, cacheMancante ? { cache_mancante: true } : {}, riprova ? { riprova: true } : {}) }, 10000).catch(() => null);
  if (!rec || typeof rec !== "object") return h.risposta(h.foglio(base, "Tavola", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (rec.esito === "fallito") {
    return h.risposta(h.foglio(base, "Non riesco a riprenderla dall'archivio", "La tavola è nell'archivio Drive di TIX, ma adesso non riesco a riprenderla. Riprova tra qualche minuto; se non va, scrivici e la recuperiamo noi.",
      '<a class="btn" href="' + e(qui + "&riprova=1") + '">Riprova</a><p class="piede"><a href="' + e(torna) + '">Torna ai Progetti del cantiere</a></p>'), 200);
  }
  if (rec.esito === "pronto" || rec.esito === "chiesto" || rec.esito === "in_corso") {
    if (giro >= 24) {
      return h.risposta(h.foglio(base, "Ci vuole più del solito", "L'archivio Drive sta rispondendo piano. Riprova tra qualche minuto.",
        '<a class="btn" href="' + e(qui) + '">Riprova</a><p class="piede"><a href="' + e(torna) + '">Torna ai Progetti del cantiere</a></p>'), 200);
    }
    const pag = h.foglio(base, "Sto riprendendo la tavola dall'archivio", "Ci vogliono 10–20 secondi: la pagina si aggiorna da sola e poi apre la tavola.",
      '<p aria-hidden="true" style="text-align:center;font-size:1.6rem;margin:0 0 6px">&#8987;</p><p class="piede"><a href="' + e(torna) + '">Torna ai Progetti del cantiere</a></p>');
    return h.risposta(pag.replace("</head>", '<meta http-equiv="refresh" content="' + (rec.esito === "pronto" ? 0 : 4) + ";url=" + e(qui + "&n=" + (giro + 1)) + '"></head>'), 200);
  }
  if (rec.esito === "superata") {
    return h.risposta(h.foglio(base, "Questa revisione non è più in vigore", "È arrivata una revisione nuova di questa tavola: apri quella dai Progetti del cantiere.", indietro), 410);
  }
  return h.risposta(h.foglio(base, "Tavola", "Il file di questa tavola non è disponibile in questo momento.", indietro), 404);
}

// Il tipo del file lo decide la riga del database, mai quello salvato nell'archivio.
function servi(f, info, scarica, metodo) {
  const p7m = info.mime === "application/pkcs7-mime";
  const nome = String(info.nome || (p7m ? "tavola.p7m" : "tavola.pdf"));
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || (p7m ? "tavola.p7m" : "tavola.pdf");
  const hd = {
    "Content-Type": p7m ? "application/pkcs7-mime" : "application/pdf",
    "Content-Disposition": (scarica || p7m ? "attachment" : "inline") + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff"
  };
  const lun = f.headers.get("Content-Length");
  if (lun && /^[0-9]+$/.test(lun)) hd["Content-Length"] = lun;
  return new Response(metodo === "HEAD" ? null : f.body, { status: 200, headers: hd });
}

// ---------------------------------------------------------------------------- pagina
const SVG = {
  compasso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 20.5 13 4"/><path d="M20.5 20.5 11 4"/><circle cx="12" cy="4" r="1.6"/><path d="M6.3 15.7c3.6 2 7.8 2 11.4 0"/></svg>',
  piu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  su: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-3"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14l3-3 3 3"/></svg>',
  cerca: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  archivio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M2 3h20v4H2zM10 12h4"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></svg>'
};

function pagina(base, h, p, d, torna) {
  const e = h.esc;
  const tavole = lista(d.tavole);
  const chiuso = !!d.chiuso;
  const sposta = !chiuso && d.sposta === true;
  const lottoModo = !chiuso && d.lotto_modo === true;
  const scegli = sposta || lottoModo;   // caselle «Seleziona» e barra in basso
  const lotti = Array.from(new Set(tavole.map((x) => String(x.lotto || "").trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "it", { numeric: true }));
  const senzaLotto = tavole.some((x) => !String(x.lotto || "").trim());
  const maxMb = Math.max(1, Math.min(50, Number(d.max_mb) || 25));
  const sup = Math.max(0, Number(d.superate) || 0);
  const spazio = tavole.reduce((s, x) => s + (Number(x.byte) || 0), 0);
  const varianti = tavole.filter((x) => x.variante).length;
  const qui = base + "/progetti";
  const conta = {};
  TIPI.forEach(([k]) => { conta[k] = tavole.filter((x) => x.tipo === k).length; });

  const cifre = '<div class="pg-cifre">' +
    '<div class="pg-c-pr"><b>' + tavole.length + '</b><span>Tavole in vigore</span></div>' +
    '<div><b>' + varianti + '</b><span>Tavole di variante in vigore</span></div>' +
    '<div class="pg-c-gr"><b>' + sup + '</b><span>Revisioni superate, solo in archivio</span></div>' +
    '<div class="pg-c-gr"><b>' + e(mb(spazio)) + '</b><span>Spazio delle tavole in vigore</span></div></div>';

  const filtri = '<div class="pg-cerca"><div class="pg-filtri" role="group" aria-label="Mostra">' +
    '<button type="button" class="on" data-f="">Tutte <i>' + tavole.length + '</i></button>' +
    TIPI.map(([k, n]) => '<button type="button" data-f="' + k + '"' + (conta[k] ? "" : " hidden") + '>' + e(n) + ' <i>' + conta[k] + '</i></button>').join("") +
    (varianti ? '<button type="button" data-f="variante">Varianti <i>' + varianti + '</i></button>' : "") + '</div>' +
    '<label class="pg-campo">' + SVG.cerca + '<input type="search" id="pg-q" placeholder="Cerca: fondazioni, STR-03…" aria-label="Cerca una tavola"></label></div>';
  // lotto-1: secondo filtro, solo se almeno una tavola ha il fabbricato / lotto
  const filtriLotto = lotti.length ? '<div class="pg-filtri pg-lotti" role="group" aria-label="Fabbricato / lotto"><span class="pg-lotti-et">Fabbricato / lotto</span>' +
    '<button type="button" class="on" data-l="">Tutti</button>' +
    lotti.map((l) => '<button type="button" data-l="' + e(l) + '">' + e(l) + ' <i>' + tavole.filter((x) => String(x.lotto || "").trim() === l).length + '</i></button>').join("") +
    (senzaLotto ? '<button type="button" data-l="__senza">Senza <i>' + tavole.filter((x) => !String(x.lotto || "").trim()).length + '</i></button>' : "") + '</div>' : "";
  const elencoLotti = lotti.length ? '<datalist id="pg-lotti-elenco">' + lotti.map((l) => '<option value="' + e(l) + '">').join("") + '</datalist>' : "";

  let sezioni = "";
  let num = 0;
  TIPI.forEach(([k, n]) => {
    const t = tavole.filter((x) => x.tipo === k).sort((a, b) => String(a.lotto || "").localeCompare(String(b.lotto || ""), "it", { numeric: true }) ||
      String(a.codice).localeCompare(String(b.codice), "it", { numeric: true }));
    if (!t.length) return;
    num++;
    sezioni += '<section class="pg-sez" data-sez="' + k + '"><h2><span class="n">' + num + '</span>' + e(n) + ' <small>' + t.length + (t.length === 1 ? " tavola" : " tavole") + '</small>' +
      (scegli ? '<button type="button" class="pg-sel-tutte" data-sel-sez="' + k + '">Seleziona tutte</button>' : "") + '</h2>' +
      t.map((x) => riga(e, qui, p, x, chiuso, sposta, scegli)).join("") + '</section>';
  });
  if (!tavole.length) {
    sezioni = '<div class="pg-vuoto">' + SVG.compasso + '<p><b>Nessuna tavola ancora.</b> ' +
      (chiuso ? "Il cantiere è chiuso." : "Carica i PDF delle tavole del progetto: architettonico, strutture, impianti.") + '</p></div>';
  }

  const form = chiuso ? "" :
    '<section class="pg-form" id="carica"><h3><span class="pg-mini">' + SVG.su + '</span>Carica tavole</h3>' +
    '<p class="pg-sotto">Puoi scegliere più file insieme. TIX prova a leggere codice, titolo e revisione dal nome del file: controlla e correggi prima di salvare.</p>' +
    '<label class="pg-drop" id="pg-drop"><span class="pg-scegli">' + SVG.file + '<span>Trascina qui i PDF o tocca per sceglierli<small>PDF o PDF firmato (.p7m), fino a ' + maxMb + ' MB l\'uno · l\'impronta la calcola il tuo telefono o computer</small></span></span>' +
    '<span class="btn sm sec">Scegli i file</span><input type="file" id="pg-file" accept="application/pdf,.pdf,.p7m" multiple hidden></label>' +
    (lottoModo ? '<div class="pg-chi pg-lotto-box" id="pg-lotto-box" hidden><label for="pg-lotto">Fabbricato / lotto <small>facoltativo, vale per tutti i file di questo caricamento</small></label>' +
      '<input id="pg-lotto" maxlength="60" list="pg-lotti-elenco" placeholder="es. Palazzina B, Lotto 2 — lascia vuoto se il cantiere è uno solo"></div>' : "") +
    '<div class="pg-tutte" id="pg-tutte" hidden><label for="pg-rev-tutte">Stessa revisione per tutte</label><input id="pg-rev-tutte" maxlength="30" placeholder="es. A">' +
    '<button type="button" class="btn sm sec" id="pg-rev-applica">Applica a tutte</button></div>' +
    '<p class="pg-mancano" id="pg-mancano" role="status" hidden></p>' +
    '<div class="pg-fl" id="pg-fl" hidden><div class="pg-fr pg-th"><span>File</span><span>Tipo</span><span>Codice</span><span>Titolo</span><span>Rev.</span><span>Variante</span></div><div id="pg-righe"></div></div>' +
    '<div class="pg-chi" id="pg-chi-box" hidden><label for="pg-chi">Il tuo nome</label><input id="pg-chi" maxlength="120" autocomplete="name" placeholder="Resta scritto chi ha caricato le tavole"></div>' +
    '<div class="pg-arch">' + SVG.archivio + '<span>La revisione nuova di un codice diventa «In vigore». Quella di prima diventa «Superata»: resta nell\'archivio di TIX, ma non si vede più qui e non si potrà mandare su WhatsApp.</span></div>' +
    '<p class="pg-msg" id="pg-msg" role="status"></p>' +
    '<div class="pg-form-az" id="pg-az" hidden><button type="button" class="btn tenue" id="pg-annulla">Annulla</button><button type="button" class="btn pr" id="pg-salva">Salva</button></div></section>';

  const ESITI = { mandata: ["ok", "Mandata"], elenco: ["sc", "Elenco"], non_trovata: ["no", "Non trovata"], archivio: ["sc", "Ripresa dall'archivio"],
    limite: ["no", "Oltre il limite"], numero_non_registrato: ["no", "Numero non del cantiere"], errore_invio: ["no", "Non partita"] };
  const invii = lista(d.invii);
  const waModo = String(d.wa_modo || "no");
  const wa = '<section class="pg-wa" id="wa"><h3><span class="pg-mini wa">' + SVG.wa + '</span>Le tavole su WhatsApp ' +
    (waModo === "si" ? '<span class="pg-st">Accesa</span>' : waModo === "prova" ? '<span class="pg-presto">in prova: risponde solo al numero di Filippo</span>' : '<span class="pg-presto">spenta</span>') + '</h3>' +
    '<p class="pg-sotto">Chi lavora nel cantiere scrive a TIX, per esempio «mandami la tavola delle fondazioni» o «tavola STR-03», e riceve il PDF della revisione in vigore. Solo al numero che l\'ha chiesta.</p>' +
    (invii.length ? '<div class="pg-reg"><div class="pg-rr pg-th"><span>Quando</span><span>Chi</span><span>Cosa ha chiesto</span><span>Esito</span></div>' +
      invii.map((i) => { const es = ESITI[i.esito] || ["sc", i.esito]; return '<div class="pg-rr"><span>' + e(quando(i.quando)) + '</span><span>' + e(i.chi) + '</span><span class="pg-q">' +
        e(i.tavola || ("«" + String(i.richiesta || "").slice(0, 60) + "»")) + '</span><span class="pg-es ' + es[0] + '">' + e(es[1]) + '</span></div>'; }).join("") + '</div>'
      : '<p class="pg-sotto">Nessuna richiesta ancora.</p>') +
    '<ul class="pg-regole"><li><b>Chi può chiedere:</b> le persone della tua impresa e quelle di «Persone del cantiere», anche dei subappaltatori.</li>' +
    '<li><b>Cosa parte:</b> solo la revisione «In vigore». Le revisioni superate non partono mai.</li>' +
    '<li><b>Costo:</b> zero. TIX risponde a chi ha appena scritto.</li><li>Massimo 20 richieste al giorno a persona.</li></ul></section>';
  const vecchie = lista(d.superate_mandate);
  const avvVecchie = vecchie.length ? '<div class="pg-avv"><div class="pg-tx">' + SVG.wa + '<span><b>Qualcuno ha sul telefono una revisione superata.</b> ' +
    vecchie.slice(0, 6).map((v) => e(v.chi) + " ha " + e(v.codice) + " rev. " + e(v.revisione)).join("; ") + (vecchie.length > 6 ? "…" : "") +
    '. Avvisalo: se scrive a TIX, gli arriva subito la revisione in vigore.</span></div></div>' : "";
  const emModo = String(d.email_modo || "no");
  const email = chiuso ? "" : '<section class="pg-wa" id="email"><h3><span class="pg-mini">' + SVG.mail + '</span>Avvisi email ' +
    (emModo === "si" ? '<span class="pg-st">Accesi</span>' : emModo === "prova" ? '<span class="pg-presto">in prova: solo all\'indirizzo amministratore</span>' : '<span class="pg-presto">spenti per ora</span>') + '</h3>' +
    '<p class="pg-sotto">Quando carichi tavole nuove, revisioni o varianti, TIX manda un\'email sola, circa 10 minuti dopo l\'ultimo file, a chi scegli qui. Il file non è mai allegato.' +
    (emModo === "no" ? ' <b>Per ora gli avvisi sono spenti: puoi già scegliere chi li riceverà.</b>' : "") + '</p>' +
    '<div id="pg-dest" class="pg-dest"><p class="pg-sotto">Carico i destinatari…</p></div>' +
    '<div class="pg-dest-agg"><select id="pg-dest-sug" aria-label="Dalla Rubrica"><option value="">Scegli dalla Rubrica…</option></select>' +
    '<input id="pg-dest-email" type="email" maxlength="200" placeholder="oppure scrivi un\'email" aria-label="Email"><input id="pg-dest-nome" maxlength="120" placeholder="Nome (facoltativo)" aria-label="Nome">' +
    '<button type="button" class="btn sm sec" id="pg-dest-si">Aggiungi</button></div><p class="pg-msg" id="pg-dest-msg" role="status"></p></section>';

  const cfg = JSON.stringify({ u: qui, t: p.tok, c: p.c, max: maxMb * 1048576, maxMb }).replace(/</g, "\\u003c");

  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>Progetti del cantiere - TIX · Diario di cantiere</title>" + h.testa(base) +
    "<style>" + STILE + "</style></head><body><main>" +
    '<a class="pg-torna" href="' + e(torna) + '">‹ Torna al cantiere</a>' +
    '<div class="pg-card">' +
    '<div class="pg-testa"><div>' + (d.cantiere ? '<p class="pg-cant">' + e(d.cantiere) + '</p>' : "") +
    '<h1><span class="pg-ic" aria-hidden="true">' + SVG.compasso + '</span>Progetti del cantiere</h1>' +
    (d.modo === "prova" ? '<p class="pg-prova">In prova: questa pagina la vede solo l\'accesso «Tutte le aziende»</p>' : "") + '</div>' +
    (chiuso ? "" : '<div class="pg-az-testa"><a class="btn pr" href="#carica">' + SVG.piu + 'Carica tavole</a></div>') + '</div>' +
    cifre + avvVecchie + (tavole.length ? filtri + filtriLotto : "") + sezioni + '<p class="pg-nessuno" id="pg-nessuno" hidden>Nessuna tavola con questa ricerca.</p>' +
    (scegli && tavole.length ? '<div class="pg-selbar" id="pg-selbar" hidden><span id="pg-sel-n"></span>' +
      (sposta ? '<button type="button" class="btn sm pr" id="pg-sel-sposta">Sposta le selezionate in…</button>' : "") +
      (lottoModo ? '<button type="button" class="btn sm sec" id="pg-sel-lotto">Fabbricato / lotto…</button>' : "") +
      '<button type="button" class="btn sm tenue" id="pg-sel-via">Annulla la selezione</button></div>' : "") + elencoLotti +
    form + wa + email +
    '<p class="pg-fonti">TIX™ conserva le tavole, le tiene in ordine e mostra solo la revisione in vigore. Non controlla i disegni: la responsabilità del progetto resta dei progettisti e della Direzione Lavori.</p>' +
    '</div></main>' +
    '<dialog class="pg-dlg" id="pg-dlg"><form method="dialog"><h3>Togli la tavola <span id="pg-dlg-cod"></span></h3>' +
    '<p>Usalo solo per un file caricato per sbaglio. La tavola resta registrata come tolta; se aveva sostituito una revisione, quella di prima torna in vigore.</p>' +
    '<label for="pg-dlg-chi">Il tuo nome</label><input id="pg-dlg-chi" maxlength="120" autocomplete="name">' +
    '<label for="pg-dlg-mot">Perché (facoltativo)</label><input id="pg-dlg-mot" maxlength="300" placeholder="Per esempio: file sbagliato">' +
    '<p class="pg-msg" id="pg-dlg-msg" role="status"></p>' +
    '<div class="pg-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn rosso" id="pg-dlg-si">Togli</button></div></form></dialog>' +
    (sposta ? '<dialog class="pg-dlg" id="pg-sp-dlg"><form method="dialog"><h3 id="pg-sp-tit">Sposta</h3>' +
      '<p>Cambia solo la categoria. Codice, revisione e file restano uguali, e con la tavola si spostano anche le sue revisioni superate. Non parte nessun avviso email.</p>' +
      '<label for="pg-sp-tipo">Nuova categoria</label><select id="pg-sp-tipo"><option value="">Scegli…</option>' +
      TIPI.map(([k, n]) => '<option value="' + k + '">' + e(n) + '</option>').join("") + '</select>' +
      '<label for="pg-sp-chi">Il tuo nome</label><input id="pg-sp-chi" maxlength="120" autocomplete="name">' +
      '<p class="pg-msg" id="pg-sp-msg" role="status"></p>' +
      '<div class="pg-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn pr" id="pg-sp-si">Sposta</button></div></form></dialog>' : "") +
    (lottoModo ? '<dialog class="pg-dlg" id="pg-lt-dlg"><form method="dialog"><h3 id="pg-lt-tit">Fabbricato / lotto</h3>' +
      '<p>Scrivi a quale fabbricato o lotto appartengono, per esempio «Palazzina B» o «Lotto 2». Lascia vuoto per togliere il fabbricato / lotto. ' +
      'Cambiano anche le revisioni superate delle stesse tavole; codice, revisione e file restano uguali.</p>' +
      '<label for="pg-lt-val">Fabbricato / lotto</label><input id="pg-lt-val" maxlength="60" list="pg-lotti-elenco" placeholder="es. Palazzina B">' +
      '<label for="pg-lt-chi">Il tuo nome</label><input id="pg-lt-chi" maxlength="120" autocomplete="name">' +
      '<p class="pg-msg" id="pg-lt-msg" role="status"></p>' +
      '<div class="pg-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn pr" id="pg-lt-si">Salva</button></div></form></dialog>' : "") +
    "<script>var CFG=" + cfg + ";" + SCRIPT + "</script></body></html>";
}

const NOME_TIPO = Object.fromEntries(TIPI);

function riga(e, qui, p, x, chiuso, sposta, scegli) {
  const apri = qui + "/file?t=" + p.tok + "&c=" + p.c + "&id=" + encodeURIComponent(x.id);
  const meta = [];
  meta.push("<b>rev. " + e(x.revisione) + "</b>" + (x.sostituisce ? ", sostituisce la rev. " + e(x.sostituisce) : ""));
  meta.push("caricata da <b>" + e(x.caricato_da || "") + "</b> il " + e(quando(x.caricato_il)));
  const sp = x.spostata && typeof x.spostata === "object" ? x.spostata : null;
  if (sp) meta.push("spostata da <b>" + e(NOME_TIPO[sp.da] || sp.da || "") + "</b> a <b>" + e(NOME_TIPO[sp.a] || sp.a || "") + "</b> da <b>" + e(sp.chi || "") + "</b> il " + e(quando(sp.il)));
  const lc = x.lotto_cambiato && typeof x.lotto_cambiato === "object" ? x.lotto_cambiato : null;
  if (lc) meta.push("fabbricato / lotto " + (lc.a ? "«" + e(lc.a) + "»" : "tolto") + (lc.da ? " (prima «" + e(lc.da) + "»)" : "") + " da <b>" + e(lc.chi || "") + "</b> il " + e(quando(lc.il)));
  meta.push(e(mb(x.byte)));
  const imp = '<span class="pg-imp" title="Impronta SHA-256 del file: ' + e(x.sha256 || "") + '">impronta ' + e(String(x.sha256 || "").slice(0, 8)) + '…</span>' +
    (x.drive && x.impronta_drive === "uguale" ? ' <span class="pg-ok">verificata sull\'archivio Drive</span>'
      : x.archivio === "errore" ? ' <span class="pg-ko">archivio da controllare</span>'
      : x.drive ? ' <span class="pg-ok">archiviata su Drive</span>' : ' · in archiviazione su Drive') +
    (Number(x.invii) > 0 ? ' · <span class="pg-wa-n">mandata su WhatsApp ' + e(x.invii) + (Number(x.invii) === 1 ? " volta" : " volte") + '</span>' : "");
  const az = '<a class="btn sm tenue" href="' + e(apri) + '" target="_blank" rel="noopener">Apri</a>' +
    '<a class="btn sm tenue" href="' + e(apri + "&scarica=1") + '">Scarica</a>' +
    (sposta ? '<button type="button" class="btn sm tenue" data-sposta="' + e(x.id) + '" data-tipo="' + e(x.tipo) + '" data-cod="' + e(x.codice + " rev. " + x.revisione) + '">Sposta</button>' : "") +
    (chiuso ? "" : '<button type="button" class="btn sm togli" data-togli="' + e(x.id) + '" data-cod="' + e(x.codice + " rev. " + x.revisione) + '">Togli</button>');
  const lotto = String(x.lotto || "").trim();
  const q = (String(x.codice || "") + " " + String(x.titolo || "") + " " + String(x.nome || "") + " " + lotto).toLowerCase();
  return '<div class="pg-tv" data-tipo="' + e(x.tipo) + '" data-var="' + (x.variante ? "1" : "") + '" data-lotto="' + e(lotto) + '" data-q="' + e(q) + '">' +
    '<div class="pg-cod"><b>' + e(x.codice) + '</b><span class="pg-rev">rev. ' + e(x.revisione) + '</span>' +
    (scegli ? '<label class="pg-sel"><input type="checkbox" data-sel="' + e(x.id) + '" aria-label="Seleziona ' + e(x.codice) + '"> Seleziona</label>' : "") + '</div>' +
    '<div class="pg-corpo"><p class="pg-tit">' + e(x.titolo || x.nome || x.codice) + (lotto ? ' <span class="pg-lotto">' + e(lotto) + '</span>' : "") +
    (x.variante ? ' <span class="pg-var">Variante</span>' : "") + '</p>' +
    '<p class="pg-meta">' + meta.join(" · ") + " · " + imp + '</p></div>' +
    '<div class="pg-lato"><span class="pg-st">In vigore</span><div class="pg-az">' + az + '</div></div></div>';
}

const STILE =
  ":root{--navy:#1B2F4A;--arancio:#F26A10;--pr:#7A4E2D;--pr-2:#A86F44;--pr-s:#5C3A20;--pr-f:#F8F1EA;--pr-b:#E2CBB3;" +
  "--t:#17212E;--s:#5B6672;--c:#FFFFFF;--z:#F5F7FA;--l:rgba(16,27,43,.11);--ro-f:#FDECEA;--ro:#B3261E;--ro-b:#F2B8B5;" +
  "--ok-f:#E9F6EF;--ok:#146C43;--ok-b:#A8D8BD;--ombra:0 1px 2px rgba(16,27,43,.05),0 8px 20px -14px rgba(16,27,43,.20),0 0 0 1px rgba(16,27,43,.03)}" +
  "*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-font-smoothing:antialiased}" +
  "body{margin:0;color:var(--t);font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,system-ui,sans-serif;letter-spacing:-.006em;" +
  "background:radial-gradient(1100px 600px at 100% -10%,rgba(242,106,16,.05),transparent 60%),radial-gradient(900px 600px at -10% 0%,rgba(27,47,74,.06),transparent 60%),#F8FAFC}" +
  "main{max-width:960px;margin:0 auto;padding:16px 16px 48px}" +
  "@media screen and (min-width:760px){main{max-width:min(1600px,calc(100vw - 48px));padding:20px 12px 56px}}" +
  "@media screen and (min-width:900px){main{max-width:min(1600px,calc(100vw - 96px))}}" +
  "svg{display:block}" +
  ".pg-torna{display:inline-block;margin:0 0 12px;padding:6px 14px;border-radius:999px;border:1px solid var(--l);background:var(--c);color:var(--navy);font-weight:600;text-decoration:none}" +
  ".pg-card{position:relative;background:var(--c);border-radius:16px;padding:18px 18px 16px;box-shadow:var(--ombra)}" +
  ".pg-card::before{content:\"\";position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#F26A10);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}" +
  ".pg-testa{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:0 0 14px}" +
  ".pg-cant{margin:0;font-size:.88rem;color:var(--s)}" +
  "h1{display:flex;align-items:center;gap:10px;margin:4px 0 0;font-size:1.5rem;letter-spacing:-.02em;color:var(--navy)}" +
  ".pg-ic{flex:none;width:38px;height:38px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#D19A6A,#A86F44 45%,#5C3A20);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 6px 14px -6px rgba(92,58,32,.65)}" +
  ".pg-ic svg{width:22px;height:22px}" +
  ".pg-prova{display:inline-block;margin:8px 0 0;padding:3px 10px;border:1px dashed var(--pr-b);border-radius:999px;background:var(--pr-f);color:var(--pr-s);font-size:.8rem;font-weight:600}" +
  ".pg-az-testa{display:flex;gap:8px;flex-wrap:wrap}" +
  ".btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:42px;padding:0 16px;border-radius:12px;border:1px solid var(--navy);background:var(--c);color:var(--navy);font:inherit;font-weight:700;font-size:.92rem;text-decoration:none;white-space:nowrap;cursor:pointer;background-image:linear-gradient(180deg,#FFFFFF,#F4F7FA);box-shadow:0 1px 2px rgba(16,27,43,.05)}" +
  ".btn svg{width:17px;height:17px}" +
  ".btn.pr{border-color:var(--pr);color:#fff;background-image:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,.05) 48%,rgba(255,255,255,0) 52%),linear-gradient(180deg,#986238,#7A4E2D);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 22px -12px rgba(92,58,32,.8)}" +
  ".btn.pr:disabled{opacity:.6;cursor:wait}" +
  ".btn.sec{border-color:var(--pr);color:var(--pr-s);background-image:none;background-color:var(--pr-f)}" +
  ".btn.sm{min-height:34px;padding:0 12px;font-size:.84rem;border-radius:10px}" +
  ".btn.tenue{border-color:rgba(16,27,43,.16);color:var(--t)}" +
  ".btn.togli{border-color:var(--ro-b);color:var(--ro);background-image:none}" +
  ".btn.rosso{border-color:var(--ro);color:#fff;background-image:none;background-color:var(--ro)}" +
  ".btn:hover,.btn:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(122,78,45,.22)}" +
  ".pg-cifre{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 14px}" +
  ".pg-cifre div{position:relative;border:1px solid var(--l);border-radius:12px;padding:10px 12px 10px 14px;background:var(--c);overflow:hidden}" +
  ".pg-cifre div::before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--navy)}" +
  ".pg-cifre b{display:block;font-size:1.55rem;line-height:1.2;color:var(--navy)}.pg-cifre span{font-size:.82rem;color:var(--s)}" +
  ".pg-cifre .pg-c-pr::before{background:var(--pr)}.pg-cifre .pg-c-pr b{color:var(--pr-s)}.pg-cifre .pg-c-gr::before{background:#8A96A3}" +
  ".pg-cerca{display:flex;gap:10px 14px;align-items:center;flex-wrap:wrap;margin:16px 0 2px}" +
  ".pg-filtri{display:flex;gap:6px;flex-wrap:wrap;flex:1 1 420px}" +
  ".pg-filtri button{padding:6px 12px;border-radius:999px;border:1px solid var(--l);background:var(--c);font:inherit;font-size:.84rem;font-weight:600;color:var(--t);cursor:pointer}" +
  ".pg-filtri button i{font-style:normal;color:var(--s);margin-left:4px}" +
  ".pg-filtri button.on{background:var(--navy);border-color:var(--navy);color:#fff}.pg-filtri button.on i{color:rgba(255,255,255,.75)}" +
  ".pg-campo{display:flex;align-items:center;gap:8px;flex:0 1 300px;min-width:0;min-height:40px;padding:0 12px;border:1px solid rgba(16,27,43,.16);border-radius:12px;background:var(--c)}" +
  ".pg-campo svg{flex:none;width:17px;height:17px;color:var(--s)}.pg-campo input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:.92rem;color:var(--t)}" +
  ".pg-sez{margin:24px 0 0}" +
  ".pg-sez h2{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0 0 10px;padding:0 0 8px;border-bottom:2px solid rgba(122,78,45,.18);font-size:.92rem;text-transform:uppercase;letter-spacing:.06em;color:var(--navy)}" +
  ".pg-sez h2 .n{flex:none;width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--pr);color:#fff;font-size:.82rem;letter-spacing:0;box-shadow:0 0 0 2px #fff,0 0 0 3.5px rgba(122,78,45,.35)}" +
  ".pg-sez h2 small{margin-left:auto;font-size:.82rem;font-weight:600;letter-spacing:0;text-transform:none;color:var(--s)}" +
  ".pg-tv{display:grid;grid-template-columns:96px minmax(0,1fr) auto;gap:6px 14px;align-items:start;padding:12px 14px;border:1px solid var(--l);border-radius:14px;background:var(--c);box-shadow:0 1px 2px rgba(16,27,43,.04)}" +
  ".pg-tv+.pg-tv{margin-top:10px}.pg-tv.pg-via,.pg-sez.pg-via{display:none}" +
  ".pg-cod{display:flex;flex-direction:column;align-items:flex-start;gap:6px}" +
  ".pg-cod b{display:inline-block;padding:3px 8px;border-radius:8px;border:1.5px solid var(--pr);background:var(--pr-f);color:var(--pr-s);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.84rem;overflow-wrap:anywhere}" +
  ".pg-rev{padding:1px 8px;border-radius:999px;background:var(--navy);color:#fff;font-size:.74rem;font-weight:700}" +
  ".pg-tit{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 3px;font-weight:700;font-size:1rem;overflow-wrap:anywhere}" +
  ".pg-meta{margin:0;font-size:.86rem;line-height:1.55;color:var(--s)}.pg-meta b{color:var(--t);font-weight:600}" +
  ".pg-imp{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.8rem}" +
  ".pg-var{padding:1px 8px;border-radius:999px;border:1px solid var(--pr-b);background:#fff;color:var(--pr-s);font-size:.74rem;font-weight:700}" +
  ".pg-lato{display:flex;flex-direction:column;align-items:flex-end;gap:8px}" +
  ".pg-az{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}" +
  ".pg-st{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;border:1px solid var(--ok-b);background:var(--ok-f);color:var(--ok);font-size:.78rem;font-weight:700;line-height:1.7;white-space:nowrap}" +
  ".pg-vuoto{display:flex;gap:14px;align-items:center;margin:18px 0 0;padding:18px;border:1.5px dashed var(--pr-b);border-radius:14px;background:var(--pr-f);color:var(--pr-s)}" +
  ".pg-vuoto svg{flex:none;width:34px;height:34px}.pg-vuoto p{margin:0;line-height:1.45}" +
  ".pg-nessuno{margin:16px 0 0;color:var(--s);font-size:.92rem}" +
  ".pg-form{margin-top:26px;padding:16px;border:1px solid var(--pr-b);border-radius:16px;background:linear-gradient(180deg,#FCF8F4,#FFFFFF 60%)}" +
  ".pg-form h3,.pg-wa h3{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 4px;font-size:1.15rem;color:var(--navy)}" +
  ".pg-mini{flex:none;width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--pr);color:#fff}.pg-mini.wa{background:#1F8F4E}.pg-mini svg{width:17px;height:17px}" +
  ".pg-sotto{margin:0 0 14px;font-size:.88rem;color:var(--s);line-height:1.45}" +
  ".pg-drop{display:flex;align-items:center;gap:12px 16px;flex-wrap:wrap;padding:14px;border:2px dashed var(--pr-b);border-radius:14px;background:var(--pr-f);cursor:pointer}" +
  ".pg-drop.sopra{border-color:var(--pr);background:#F3E6D9}" +
  ".pg-scegli{display:flex;align-items:center;gap:10px;font-size:.92rem;color:var(--pr-s);font-weight:600;flex:1 1 300px}.pg-scegli svg{flex:none;width:26px;height:26px}" +
  ".pg-scegli small{display:block;margin-top:2px;font-size:.8rem;font-weight:500;color:var(--s)}" +
  ".pg-fl{margin-top:12px;border:1px solid var(--l);border-radius:14px;background:var(--c);overflow:hidden}" +
  ".pg-fr{display:grid;grid-template-columns:minmax(0,1.3fr) 140px 170px minmax(0,1.4fr) 64px 84px;gap:8px 12px;align-items:center;padding:10px 12px}" +
  ".pg-fr+.pg-fr,#pg-righe .pg-fr{border-top:1px solid var(--l)}" +
  ".pg-th{padding:8px 12px;background:var(--z);font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--s)}" +
  ".pg-fn{display:flex;align-items:center;gap:10px;min-width:0}" +
  ".pg-pdf{flex:none;width:28px;height:34px;border-radius:5px;border:1px solid var(--ro-b);background:#fff;display:flex;align-items:flex-end;justify-content:center;padding-bottom:3px;font-size:.56rem;font-weight:800;color:var(--ro)}" +
  ".pg-nm{min-width:0;font-size:.84rem;font-weight:600;overflow-wrap:anywhere}.pg-nm span{display:block;font-size:.76rem;font-weight:500;color:var(--s)}" +
  ".pg-fr input[type=text],.pg-fr select,.pg-chi input,.pg-dlg input{width:100%;min-height:36px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;background:var(--c);font:inherit;font-size:.88rem;color:var(--t)}" +
  ".pg-fr input.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}" +
  ".pg-fr input.manca{border:2px solid var(--ro);background:var(--ro-f)}.pg-fr input.manca::placeholder{color:var(--ro);opacity:.8}" +
  ".pg-mancano{margin:12px 0 0;padding:10px 12px;border:1px solid var(--ro-b);border-radius:12px;background:var(--ro-f);font-size:.88rem;line-height:1.5;color:#7a1c16}.pg-mancano b{color:var(--ro)}" +
  ".pg-tutte{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin:12px 0 0;padding:10px 12px;border:1px solid var(--pr-b);border-radius:12px;background:#fff}" +
  ".pg-tutte label{font-size:.88rem;font-weight:700;color:var(--navy)}.pg-tutte input{width:110px;min-height:36px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;font-family:ui-monospace,Consolas,monospace;font-size:.88rem}" +
  ".pg-fr .pg-ck{display:flex;align-items:center;gap:6px;font-size:.84rem}.pg-fr .pg-ck input{width:18px;height:18px;accent-color:#7A4E2D}" +
  ".pg-fr .et{display:none}" +
  ".pg-fr.no{background:var(--ro-f)}.pg-fr .pg-esito{grid-column:1/-1;font-size:.86rem;line-height:1.45}" +
  ".pg-fr.no .pg-esito{color:var(--ro);font-weight:600}.pg-fr.ok{background:var(--ok-f)}.pg-fr.ok .pg-esito{color:var(--ok);font-weight:600}" +
  ".pg-chi{margin-top:12px;display:flex;flex-direction:column;gap:4px;max-width:420px}.pg-chi label,.pg-dlg label{font-size:.84rem;font-weight:700;color:var(--navy)}" +
  ".pg-arch{display:flex;gap:10px;align-items:flex-start;margin:14px 0 0;padding:10px 12px;border-radius:12px;background:var(--z);font-size:.84rem;line-height:1.45;color:var(--s)}.pg-arch svg{flex:none;width:20px;height:20px;color:var(--pr)}" +
  ".pg-msg{margin:10px 0 0;font-size:.9rem;font-weight:600;color:var(--ro);min-height:1px}" +
  ".pg-form-az{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:14px}" +
  ".pg-wa{margin-top:22px;padding:16px;border:1px solid var(--l);border-radius:16px;background:var(--c)}.pg-wa .pg-sotto{margin:6px 0 0}" +
  ".pg-presto{padding:1px 10px;border-radius:999px;border:1px solid var(--l);background:var(--z);color:var(--s);font-size:.76rem;font-weight:700}" +
  ".pg-fonti{margin:20px 0 0;font-size:.82rem;line-height:1.5;color:var(--s)}" +
  ".pg-ok{color:var(--ok);font-weight:600}.pg-ko{color:var(--ro);font-weight:600}.pg-wa-n{color:#1F7A45;font-weight:600}" +
  ".pg-avv{display:flex;gap:10px;margin:0 0 12px;padding:12px 14px;border-radius:14px;border:1px solid var(--pr-b);background:var(--pr-f)}" +
  ".pg-avv .pg-tx{display:flex;gap:10px;align-items:flex-start;font-size:.92rem;line-height:1.45}.pg-avv svg{flex:none;width:20px;height:20px;color:#1F8F4E;margin-top:1px}.pg-avv b{color:var(--pr-s)}" +
  ".pg-reg{margin:12px 0 0;border:1px solid var(--l);border-radius:14px;overflow:hidden}" +
  ".pg-rr{display:grid;grid-template-columns:150px minmax(0,1fr) minmax(0,1.3fr) 150px;gap:8px 12px;align-items:center;padding:9px 12px;font-size:.84rem}" +
  ".pg-rr+.pg-rr{border-top:1px solid var(--l)}.pg-rr.pg-th{background:var(--z);font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--s)}" +
  ".pg-q{overflow-wrap:anywhere}.pg-es{justify-self:start;padding:1px 8px;border-radius:999px;font-size:.74rem;font-weight:700;white-space:nowrap}" +
  ".pg-es.ok{background:var(--ok-f);color:var(--ok);border:1px solid var(--ok-b)}.pg-es.sc{background:var(--z);color:var(--navy);border:1px solid var(--l)}.pg-es.no{background:var(--ro-f);color:var(--ro);border:1px solid var(--ro-b)}" +
  ".pg-regole{margin:10px 0 0;padding:0 0 0 18px;font-size:.84rem;line-height:1.55;color:var(--s)}.pg-regole b{color:var(--t)}" +
  ".pg-dest{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px}.pg-dest .pg-sotto{margin:0}" +
  ".pg-chip{display:inline-flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;border:1px solid var(--pr-b);border-radius:999px;background:var(--pr-f);font-size:.86rem}" +
  ".pg-chip em{font-style:normal;color:var(--s);font-size:.78rem}.pg-chip button{border:0;background:#fff;border-radius:999px;width:24px;height:24px;cursor:pointer;color:var(--ro);font-weight:800}" +
  ".pg-dest-agg{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.pg-dest-agg select,.pg-dest-agg input{min-height:36px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;background:#fff;font:inherit;font-size:.88rem;flex:1 1 200px;min-width:0}" +
  "@media (max-width:680px){.pg-rr.pg-th{display:none}.pg-rr{grid-template-columns:minmax(0,1fr) auto}.pg-rr .pg-q{grid-column:1/-1}}" +
  ".pg-dlg{max-width:460px;width:calc(100vw - 32px);border:0;border-radius:16px;padding:18px;box-shadow:0 24px 60px -20px rgba(16,27,43,.45)}" +
  ".pg-dlg::backdrop{background:rgba(16,27,43,.45)}.pg-dlg h3{margin:0 0 8px;color:var(--navy)}.pg-dlg p{margin:0 0 12px;font-size:.9rem;line-height:1.45;color:var(--s)}" +
  ".pg-dlg form{display:flex;flex-direction:column;gap:6px}" +
  // sposta-1: caselle di selezione, «Seleziona tutte» nella sezione, barra in basso con le selezionate, tendina nella finestra
  ".pg-sel{display:inline-flex;align-items:center;gap:6px;font-size:.78rem;font-weight:600;color:var(--s);cursor:pointer}.pg-sel input{width:18px;height:18px;accent-color:#7A4E2D}" +
  ".pg-sel-tutte{padding:3px 10px;border:1px solid var(--pr-b);border-radius:999px;background:var(--pr-f);color:var(--pr-s);font:inherit;font-size:.74rem;font-weight:700;letter-spacing:0;text-transform:none;cursor:pointer}" +
  ".pg-selbar{position:sticky;bottom:12px;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin:14px 0 0;padding:10px 12px;border:1.5px solid var(--pr);border-radius:14px;background:#fff;box-shadow:0 12px 28px -14px rgba(16,27,43,.45)}" +
  ".pg-selbar span{flex:1 1 160px;font-weight:700;color:var(--pr-s);font-size:.92rem}" +
  // lotto-1: etichetta del fabbricato / lotto, secondo filtro, campo del caricamento
  ".pg-lotto{padding:1px 9px;border-radius:999px;border:1px solid #9FB3C8;background:#EEF3F8;color:var(--navy);font-size:.74rem;font-weight:700}" +
  ".pg-lotti{margin:10px 0 2px;align-items:center}.pg-lotti-et{font-size:.78rem;font-weight:700;color:var(--s);margin-right:2px}" +
  ".pg-lotti button.on{background:#3E5A7A;border-color:#3E5A7A}.pg-lotto-box{max-width:520px}.pg-lotto-box small{font-weight:500;color:var(--s)}" +
  ".pg-dlg select{width:100%;min-height:36px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;background:var(--c);font:inherit;font-size:.88rem;color:var(--t)}" +
  "@media (max-width:1100px){.pg-fr{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.pg-th{display:none}.pg-fr .pg-fn{grid-column:1/-1}.pg-fr .c-tit{grid-column:1/-1}" +
  ".pg-fr .et{display:block;font-size:.7rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--s);margin-bottom:3px}}" +
  "@media (max-width:680px){main{padding:14px 16px 40px}.pg-card{padding:16px 14px 14px}h1{font-size:1.35rem}" +
  ".pg-az-testa{width:100%}.pg-az-testa .btn{flex:1 1 auto}.pg-cifre{grid-template-columns:repeat(2,minmax(0,1fr))}.pg-campo{flex:1 1 100%}" +
  ".pg-tv{grid-template-columns:minmax(0,1fr) auto}.pg-tv .pg-cod{flex-direction:row;align-items:center;grid-column:1;grid-row:1}" +
  ".pg-tv .pg-lato{display:contents}.pg-tv .pg-st{grid-column:2;grid-row:1;justify-self:end}.pg-tv .pg-corpo{grid-column:1/-1}" +
  ".pg-tv .pg-az{grid-column:1/-1;justify-content:flex-start}.pg-sez h2 small{flex-basis:100%;margin-left:36px}.pg-form-az .btn{flex:1 1 auto}}";

const SCRIPT = String.raw`(function(){try{
var D=document;function $(i){return D.getElementById(i);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function leggiChi(){try{return localStorage.getItem('tix_pg_chi')||'';}catch(e){return '';}}
function scriviChi(v){try{if(v)localStorage.setItem('tix_pg_chi',v);}catch(e){}}
function mb(n){n=Number(n)||0;if(n>=1048576)return (Math.round(n/104857.6)/10).toString().replace('.',',')+' MB';return Math.max(1,Math.round(n/1024))+' KB';}
function b64url(s){var u=unescape(encodeURIComponent(s));return btoa(u).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function esa(buf){return Array.prototype.map.call(new Uint8Array(buf),function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
// ---- dal nome del file: codice, revisione, titolo, tipo
function leggiNome(n){var base=String(n||'').replace(/\.(pdf|p7m)$/i,'').replace(/\.(pdf)$/i,'');var rev='',cod='',tit=base,nuovo=false;
// schema «PREFISSO_NNx_titolo» (es. 21EI055DEF_01a_ortofoto attuale): prefisso di lettere e numeri (almeno 4, con un numero),
// NN = numero della tavola, x = lettera della revisione. Codice = PREFISSO_NN, così le tavole di commesse o discipline diverse non si confondono.
var ms=base.match(/^([A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*)[\s_\-.]+(\d{1,3})([A-Za-z])?(?=$|[\s_\-.])[\s_\-.]*(.*)$/);
if(ms&&ms[1].length>=4&&/\d/.test(ms[1])&&!/(?:^|[\s_.\-(])rev(?:isione)?[\s_.\-]*[A-Za-z0-9]/i.test(base)){cod=ms[1].toUpperCase()+'_'+ms[2];rev=(ms[3]||'').toUpperCase();tit=ms[4]||'';nuovo=true;}
if(!nuovo){
var mr=base.match(/(?:^|[\s_.\-(])rev(?:isione)?[\s_.\-]*([A-Za-z0-9]{1,3})(?=$|[\s_.\-)])/i);if(mr){rev=mr[1].toUpperCase();tit=tit.replace(mr[0],' ');}
var mc=tit.match(/^\s*([A-Za-z]{1,5}[\s_\-.]?\d{1,4}[A-Za-z]?)(?=$|[\s_\-.])/);if(mc){cod=mc[1].toUpperCase().replace(/[\s_.]/,'-');tit=tit.slice(mc[0].length);}}
tit=tit.replace(/[_]+/g,' ').replace(/\s*[-–]\s*$/,'').replace(/^\s*[-–.]\s*/,'').replace(/\s{2,}/g,' ').trim();
var p=nuovo?'':cod.replace(/[^A-Z]/g,''),tipo='altro';
if(/^(STR|S|ST|CA|CLS|FOND|CARP)$/.test(p))tipo='strutturale';else if(/^(ARC|AR|A|ARCH|PA|PR)$/.test(p))tipo='architettonico';
else if(/^(IE|IM|IMP|IT|IID|IDR|IMC|MEC|EL|ELE|IS|TE|IA|IF|IG)$/.test(p))tipo='impianti';
if(tipo==='altro'){var l=(nuovo?tit:base).toLowerCase();if(/struttur|fondazion|carpenteri|armatur|solai|travi|pilastr|platea|plinti/.test(l))tipo='strutturale';
else if(/impiant|elettric|idraulic|termic|meccanic|scaric|meteoric|fognat|acque|antincend|gas\b|climatizz|ventilaz|illuminaz|fotovolt|riscaldam|sanitar|adduzion/.test(l))tipo='impianti';
else if(/piant|prospett|sezion|architett|planimetr|layout|copertur/.test(l))tipo='architettonico';}
return {codice:cod,revisione:rev,titolo:tit,tipo:tipo};}
window.__pgLeggiNome=leggiNome;
// ---- filtri e ricerca
var filtro='',filtroL='';var q=$('pg-q');
function applica(){var t=(q&&q.value||'').toLowerCase().trim();var vis=0;
D.querySelectorAll('.pg-tv').forEach(function(el){var l=el.getAttribute('data-lotto')||'';var ok=(!filtro||(filtro==='variante'?el.getAttribute('data-var')==='1':el.getAttribute('data-tipo')===filtro))&&(!filtroL||(filtroL==='__senza'?!l:l===filtroL))&&(!t||el.getAttribute('data-q').indexOf(t)!==-1);el.classList.toggle('pg-via',!ok);if(ok)vis++;});
D.querySelectorAll('.pg-sez').forEach(function(s){s.classList.toggle('pg-via',!s.querySelector('.pg-tv:not(.pg-via)'));});
var n=$('pg-nessuno');if(n)n.hidden=vis>0||!D.querySelector('.pg-tv');}
D.querySelectorAll('.pg-filtri button[data-f]').forEach(function(b){b.addEventListener('click',function(){filtro=b.getAttribute('data-f')||'';D.querySelectorAll('.pg-filtri button[data-f]').forEach(function(x){x.classList.toggle('on',x===b);});applica();});});
D.querySelectorAll('.pg-filtri button[data-l]').forEach(function(b){b.addEventListener('click',function(){filtroL=b.getAttribute('data-l')||'';D.querySelectorAll('.pg-filtri button[data-l]').forEach(function(x){x.classList.toggle('on',x===b);});applica();});});
if(q)q.addEventListener('input',applica);
// ---- caricamento
var inp=$('pg-file'),drop=$('pg-drop'),righe=$('pg-righe'),FILE=[];
var TIPI=[['architettonico','Architettonico'],['strutturale','Strutturale'],['impianti','Impianti'],['altro','Altro']];
function opz(v){return TIPI.map(function(t){return '<option value="'+t[0]+'"'+(t[0]===v?' selected':'')+'>'+t[1]+'</option>';}).join('');}
function vuoto(v){return !String(v||'').trim();}
function mancano(){var n=FILE.filter(function(f){return !f.no&&!f.ok&&(vuoto(f.codice)||vuoto(f.revisione));}).length;var a=$('pg-mancano');
if(a){a.hidden=!n;a.innerHTML=n?'<b>'+(n===1?'In 1 tavola manca':'In '+n+' tavole mancano')+' il codice o la revisione</b> (i campi in rosso). Codice = il numero della tavola scritto nel cartiglio, per esempio <b>STR-03</b> o <b>01</b>; revisione = la lettera o il numero della revisione, per esempio <b>A</b>. Se la revisione è la stessa per tutte, usa «Stessa revisione per tutte».':'';}return n;}
function disegna(){if(!righe)return;$('pg-fl').hidden=!FILE.length;$('pg-az').hidden=!FILE.length;$('pg-chi-box').hidden=!FILE.length;if($('pg-lotto-box'))$('pg-lotto-box').hidden=!FILE.length;if($('pg-tutte'))$('pg-tutte').hidden=FILE.filter(function(f){return !f.no&&!f.ok;}).length<2;
var buoni=FILE.filter(function(f){return !f.no&&!f.ok;}).length;$('pg-salva').textContent=buoni===1?'Salva 1 tavola':'Salva '+buoni+' tavole';$('pg-salva').disabled=!buoni;
righe.innerHTML=FILE.map(function(f,i){var ext=(String(f.file.name).match(/\.([A-Za-z0-9]{1,4})$/)||['',''])[1].toUpperCase()||'FILE';var testa='<div class="pg-fn"><span class="pg-pdf">'+esc(ext)+'</span><span class="pg-nm">'+esc(f.file.name)+'<span>'+mb(f.file.size)+'</span></span></div>';
if(f.no)return '<div class="pg-fr no">'+testa+'<div class="pg-esito">'+esc(f.no)+'</div></div>';
if(f.ok)return '<div class="pg-fr ok">'+testa+'<div class="pg-esito">'+esc(f.ok)+'</div></div>';
return '<div class="pg-fr" data-i="'+i+'">'+testa+
'<div><span class="et">Tipo</span><select data-k="tipo" aria-label="Tipo">'+opz(f.tipo)+'</select></div>'+
'<div><span class="et">Codice</span><input type="text" class="mono'+(vuoto(f.codice)?' manca':'')+'" data-k="codice" maxlength="60" value="'+esc(f.codice)+'" placeholder="es. STR-03" aria-label="Codice"></div>'+
'<div class="c-tit"><span class="et">Titolo</span><input type="text" data-k="titolo" maxlength="200" value="'+esc(f.titolo)+'" placeholder="es. Pianta delle fondazioni" aria-label="Titolo"></div>'+
'<div><span class="et">Revisione</span><input type="text" class="mono'+(vuoto(f.revisione)?' manca':'')+'" data-k="revisione" maxlength="30" value="'+esc(f.revisione)+'" placeholder="es. A" aria-label="Revisione"></div>'+
'<div><span class="et">Variante</span><label class="pg-ck"><input type="checkbox" data-k="variante"'+(f.variante?' checked':'')+'> Sì</label></div>'+
(f.err?'<div class="pg-esito" style="color:#B3261E;font-weight:600">'+esc(f.err)+'</div>':'')+'</div>';}).join('');mancano();}
function aggiungi(lista){Array.prototype.forEach.call(lista||[],function(file){var f={file:file,variante:false};
if(!/\.(pdf|p7m)$/i.test(file.name))f.no='Questo file non è un PDF: carica la tavola in PDF, anche firmata digitalmente (.p7m). I file DWG per ora TIX non li legge.';
else if(file.size>CFG.max)f.no='Questo file pesa '+mb(file.size)+': il massimo è '+CFG.maxMb+' MB. Salvalo in PDF dal programma di disegno, dividilo in più tavole, oppure riscansionalo in bianco e nero o in grigio a 200 dpi.';
else if(!file.size)f.no='Il file è vuoto.';
else{var g=leggiNome(file.name);f.codice=g.codice;f.revisione=g.revisione;f.titolo=g.titolo;f.tipo=g.tipo;}
FILE.push(f);});disegna();var c=$('pg-chi');if(c&&!c.value)c.value=leggiChi();$('pg-msg').textContent='';}
if(inp)inp.addEventListener('change',function(){aggiungi(inp.files);inp.value='';});
if(drop){['dragenter','dragover'].forEach(function(t){drop.addEventListener(t,function(ev){ev.preventDefault();drop.classList.add('sopra');});});
['dragleave','drop'].forEach(function(t){drop.addEventListener(t,function(ev){ev.preventDefault();drop.classList.remove('sopra');});});
drop.addEventListener('drop',function(ev){if(ev.dataTransfer)aggiungi(ev.dataTransfer.files);});}
if(righe){righe.addEventListener('input',function(ev){var el=ev.target,r=el.closest('[data-i]');if(!r)return;var f=FILE[+r.getAttribute('data-i')];var k=el.getAttribute('data-k');if(!f||!k)return;f[k]=el.type==='checkbox'?el.checked:el.value;
if(k==='codice'||k==='revisione'){el.classList.toggle('manca',vuoto(el.value));mancano();}});
if($('pg-rev-applica'))$('pg-rev-applica').addEventListener('click',function(){var v=$('pg-rev-tutte').value.trim();if(!v){$('pg-rev-tutte').focus();return;}
FILE.forEach(function(f){if(!f.no&&!f.ok)f.revisione=v;});disegna();});
righe.addEventListener('change',function(ev){var el=ev.target,r=el.closest('[data-i]');if(!r)return;var f=FILE[+r.getAttribute('data-i')];var k=el.getAttribute('data-k');if(!f||!k)return;f[k]=el.type==='checkbox'?el.checked:el.value;});}
if($('pg-annulla'))$('pg-annulla').addEventListener('click',function(){FILE=[];disegna();$('pg-msg').textContent='';});
function manda(f,chi){return f.file.arrayBuffer().then(function(buf){return crypto.subtle.digest('SHA-256',buf).then(function(h){
var dati={t:CFG.t,c:CFG.c,tipo:f.tipo,codice:String(f.codice||'').trim(),titolo:String(f.titolo||'').trim(),revisione:String(f.revisione||'').trim(),variante:!!f.variante,autore:chi,nome:f.file.name,byte:buf.byteLength,sha256:esa(h),lotto:($('pg-lotto')?$('pg-lotto').value.trim():'')};
return fetch(CFG.u+'/carica',{method:'POST',headers:{'X-Progetti-Dati':b64url(JSON.stringify(dati)),'Content-Type':'application/octet-stream'},body:buf}).then(function(r){return r.json().catch(function(){return {esito:'errore'};});});});});}
var salvati=0;
if($('pg-salva'))$('pg-salva').addEventListener('click',function(){var b=$('pg-salva'),m=$('pg-msg'),chi=$('pg-chi').value.trim();
if(!chi){m.textContent='Scrivi il tuo nome: resta scritto chi ha caricato le tavole.';$('pg-chi').focus();return;}
var da=FILE.filter(function(f){return !f.no&&!f.ok;});
if(mancano()){m.textContent='Prima di salvare scrivi codice e revisione nei campi in rosso (vedi il riquadro sopra l\'elenco).';var pr=righe.querySelector('input.manca');if(pr)pr.focus();return;}
scriviChi(chi);b.disabled=true;m.textContent='';var i=0;
(function prossimo(){if(i>=da.length){b.disabled=false;disegna();if(salvati&&!FILE.some(function(f){return !f.no&&!f.ok;})){m.style.color='#146C43';m.textContent='Fatto. Aggiorno la pagina…';setTimeout(function(){location.reload();},900);}return;}
var f=da[i++];b.textContent='Salvo '+i+' di '+da.length+'…';f.err='';
manda(f,chi).then(function(r){if(r&&r.esito==='ok'){salvati++;f.ok='Salvata: '+f.codice+' rev. '+f.revisione+' in vigore'+(r.superate?' · la revisione di prima ora è «Superata»':'');}
else f.err=(r&&r.messaggio)||'Non si è salvata: riprova.';}).catch(function(){f.err='Non si è salvata: controlla la connessione e riprova.';}).then(prossimo);})();});
// ---- destinatari degli avvisi email
var dBox=$('pg-dest');
function chiamaD(az,dati){return fetch(CFG.u+'/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:az,dati:dati||{}})}).then(function(r){return r.json();});}
function disegnaD(r){if(!dBox)return;var ds=(r&&r.destinatari)||[];
dBox.innerHTML=ds.length?ds.map(function(x){return '<span class="pg-chip">'+esc(x.nome||x.email)+(x.nome?' <em>'+esc(x.email)+'</em>':'')+(x.ruolo?' <em>'+esc(x.ruolo)+'</em>':'')+'<button type="button" data-dt="'+esc(x.id)+'" aria-label="Togli">×</button></span>';}).join(''):'<p class="pg-sotto">Nessun destinatario scelto.</p>';
var s=$('pg-dest-sug');if(s){s.innerHTML='<option value="">Scegli dalla Rubrica…</option>'+((r&&r.suggeriti)||[]).map(function(k,i){return '<option value="'+i+'">'+esc((k.nome||k.email)+(k.ruolo?' · '+k.ruolo:'')+(k.impresa?' · '+k.impresa:'')+' — '+k.email)+'</option>';}).join('');s._sug=(r&&r.suggeriti)||[];}}
function caricaD(){if(!dBox)return;chiamaD('destinatari').then(disegnaD).catch(function(){dBox.innerHTML='<p class="pg-sotto">Non riesco a leggere i destinatari: ricarica la pagina.</p>';});}
caricaD();
if(dBox)dBox.addEventListener('click',function(ev){var b=ev.target.closest('[data-dt]');if(!b)return;b.disabled=true;chiamaD('destinatario_togli',{id:b.getAttribute('data-dt')}).then(caricaD).catch(caricaD);});
if($('pg-dest-sug'))$('pg-dest-sug').addEventListener('change',function(){var s=this,k=(s._sug||[])[+s.value];if(!k)return;$('pg-dest-email').value=k.email||'';$('pg-dest-nome').value=k.nome||'';$('pg-dest-nome')._ruolo=k.ruolo||'';});
if($('pg-dest-si'))$('pg-dest-si').addEventListener('click',function(){var m=$('pg-dest-msg'),em=$('pg-dest-email').value.trim();m.textContent='';if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){m.textContent='Scrivi un\'email valida.';return;}
var b=this;b.disabled=true;chiamaD('destinatario_aggiungi',{email:em,nome:$('pg-dest-nome').value.trim(),ruolo:$('pg-dest-nome')._ruolo||'',chi:leggiChi()}).then(function(r){b.disabled=false;
if(r&&r.esito==='ok'){$('pg-dest-email').value='';$('pg-dest-nome').value='';$('pg-dest-nome')._ruolo='';$('pg-dest-sug').value='';caricaD();}else m.textContent=(r&&r.messaggio)||'Non è andata: riprova.';}).catch(function(){b.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
// ---- togli
var dlg=$('pg-dlg'),corr=null;
D.querySelectorAll('[data-togli]').forEach(function(b){b.addEventListener('click',function(){corr=b.getAttribute('data-togli');$('pg-dlg-cod').textContent=b.getAttribute('data-cod')||'';$('pg-dlg-chi').value=leggiChi();$('pg-dlg-mot').value='';$('pg-dlg-msg').textContent='';
if(dlg&&typeof dlg.showModal==='function')dlg.showModal();else if(dlg)dlg.setAttribute('open','');});});
if($('pg-dlg-si'))$('pg-dlg-si').addEventListener('click',function(){var chi=$('pg-dlg-chi').value.trim(),m=$('pg-dlg-msg');if(!chi){m.textContent='Scrivi il tuo nome.';return;}scriviChi(chi);
this.disabled=true;var self=this;fetch(CFG.u+'/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:'annulla',id:corr,dati:{chi:chi,motivo:$('pg-dlg-mot').value.trim()}})})
.then(function(r){return r.json();}).then(function(r){if(r&&r.esito==='ok'){location.reload();return;}self.disabled=false;m.textContent=(r&&r.messaggio)||'Non è andata: riprova.';}).catch(function(){self.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
// ---- sposta (09/11/2026, sposta-1): una tavola dal suo pulsante, oppure le selezionate dalla barra in basso
var sdlg=$('pg-sp-dlg'),sIds=[];
function selezionate(){return Array.prototype.map.call(D.querySelectorAll('[data-sel]:checked'),function(x){return x.getAttribute('data-sel');});}
function barra(){var b=$('pg-selbar');if(!b)return;var n=selezionate().length;b.hidden=!n;$('pg-sel-n').textContent=n===1?'1 tavola selezionata':n+' tavole selezionate';}
D.addEventListener('change',function(ev){var t=ev.target;if(t&&t.hasAttribute&&t.hasAttribute('data-sel'))barra();});
D.querySelectorAll('[data-sel-sez]').forEach(function(b){b.addEventListener('click',function(){var s=b.closest('.pg-sez');if(!s)return;
var cs=Array.prototype.filter.call(s.querySelectorAll('[data-sel]'),function(x){var tv=x.closest('.pg-tv');return !tv||!tv.classList.contains('pg-via');});
var tutte=cs.length&&cs.every(function(x){return x.checked;});cs.forEach(function(x){x.checked=!tutte;});b.textContent=tutte?'Seleziona tutte':'Togli la selezione';barra();});});
function apriSposta(ids,tipo,titolo){if(!sdlg)return;sIds=ids;$('pg-sp-tit').textContent=titolo;var s=$('pg-sp-tipo');s.value='';
Array.prototype.forEach.call(s.options,function(o){o.disabled=!!tipo&&o.value===tipo;});$('pg-sp-chi').value=leggiChi();$('pg-sp-msg').textContent='';$('pg-sp-si').disabled=false;
if(typeof sdlg.showModal==='function')sdlg.showModal();else sdlg.setAttribute('open','');}
D.querySelectorAll('[data-sposta]').forEach(function(b){b.addEventListener('click',function(){apriSposta([b.getAttribute('data-sposta')],b.getAttribute('data-tipo')||'','Sposta la tavola '+(b.getAttribute('data-cod')||''));});});
if($('pg-sel-sposta'))$('pg-sel-sposta').addEventListener('click',function(){var ids=selezionate();if(!ids.length)return;apriSposta(ids,'',ids.length===1?'Sposta 1 tavola':'Sposta '+ids.length+' tavole');});
if($('pg-sel-via'))$('pg-sel-via').addEventListener('click',function(){D.querySelectorAll('[data-sel]:checked').forEach(function(x){x.checked=false;});D.querySelectorAll('[data-sel-sez]').forEach(function(b){b.textContent='Seleziona tutte';});barra();});
if($('pg-sp-si'))$('pg-sp-si').addEventListener('click',function(){var m=$('pg-sp-msg'),tipo=$('pg-sp-tipo').value,chi=$('pg-sp-chi').value.trim();m.textContent='';
if(!tipo){m.textContent='Scegli la categoria.';$('pg-sp-tipo').focus();return;}if(!chi){m.textContent='Scrivi il tuo nome: resta scritto chi ha spostato le tavole.';$('pg-sp-chi').focus();return;}scriviChi(chi);var self=this;self.disabled=true;
fetch(CFG.u+'/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:'sposta',dati:{ids:sIds,tipo:tipo,chi:chi}})})
.then(function(r){return r.json();}).then(function(r){if(r&&r.esito==='ok'){location.reload();return;}self.disabled=false;
m.textContent=(r&&r.messaggio)||(r&&r.esito==='spento'?'Lo spostamento delle tavole non è disponibile.':'Non è andata: riprova.');}).catch(function(){self.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
// ---- fabbricato / lotto (09/11/2026, lotto-1): alle tavole selezionate; vuoto = toglie il fabbricato / lotto
var ldlg=$('pg-lt-dlg'),lIds=[];
if($('pg-sel-lotto'))$('pg-sel-lotto').addEventListener('click',function(){var ids=selezionate();if(!ids||!ids.length||!ldlg)return;lIds=ids;
$('pg-lt-tit').textContent=ids.length===1?'Fabbricato / lotto di 1 tavola':'Fabbricato / lotto di '+ids.length+' tavole';
var vals=ids.map(function(id){var c=D.querySelector('[data-sel="'+id+'"]');var tv=c&&c.closest('.pg-tv');return tv?tv.getAttribute('data-lotto')||'':'';});
$('pg-lt-val').value=vals.every(function(v){return v===vals[0];})?vals[0]:'';$('pg-lt-chi').value=leggiChi();$('pg-lt-msg').textContent='';$('pg-lt-si').disabled=false;
if(typeof ldlg.showModal==='function')ldlg.showModal();else ldlg.setAttribute('open','');});
if($('pg-lt-si'))$('pg-lt-si').addEventListener('click',function(){var m=$('pg-lt-msg'),val=$('pg-lt-val').value.trim(),chi=$('pg-lt-chi').value.trim();m.textContent='';
if(!chi){m.textContent='Scrivi il tuo nome: resta scritto chi ha cambiato le tavole.';$('pg-lt-chi').focus();return;}scriviChi(chi);var self=this;self.disabled=true;
fetch(CFG.u+'/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:'lotto',dati:{ids:lIds,lotto:val,chi:chi}})})
.then(function(r){return r.json();}).then(function(r){if(r&&r.esito==='ok'){location.reload();return;}self.disabled=false;
m.textContent=(r&&r.messaggio)||(r&&r.esito==='spento'?'Il fabbricato / lotto non è disponibile.':'Non è andata: riprova.');}).catch(function(){self.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
}catch(err){}})();`;

// ---------------------------------------------------------------------------- P2: la tavola su WhatsApp (08/11/2026, progetti-2)
// Riconosce solo richieste chiare, senza intelligenza artificiale:
//   «forte»  = «mandami/manda/inviami (la) tavola …», «mi serve la tavola …», «tavola STR-03»: se non trova niente risponde lui;
//   «debole» = messaggio che è solo un codice («STR-03») o che inizia con «tavola …»: se non trova niente il messaggio prosegue
//              verso Make come sempre (può essere una voce del diario);
//   scelta dall'elenco (id «PRG_<id della tavola>»).
// Decide il database (progetti_wa_richiesta): interruttore progetti_wa_attiva (no / prova / si), numeri del cantiere, limite al giorno,
// solo la revisione in vigore, registro in progetti_invii. FAIL-SAFE: interruttore spento, numero non ammesso, database o Meta che non
// rispondono → il messaggio prosegue verso Make come prima.
const PG_FORTE = /^\s*(?:(?:mandami|manda|mandatemi|inviami|invia|mi\s+serve|serve|mi\s+servono|vorrei)\s+(?:la\s+|le\s+|una\s+)?tavol[ae]\b|tavol[ae]\s*[:\-]?\s*[A-Za-z]{1,5}[ _.-]?[0-9]{1,4}[A-Za-z]?\s*$)/i;
const PG_DEBOLE = /^\s*(?:tavol[ae]\b.*|[A-Za-z]{1,5}[ _.-]?[0-9]{1,4}[A-Za-z]?)\s*[.!?]?\s*$/i;

function pgTesto(msg) { return msg && msg.type === "text" && msg.text ? String(msg.text.body || "").slice(0, 300) : ""; }
function pgScelta(msg) {
  const lr = msg && msg.type === "interactive" && msg.interactive && msg.interactive.list_reply;
  const id = lr && String(lr.id || "");
  return id && /^PRG_[0-9a-f-]{36}$/i.test(id) ? id.slice(4).toLowerCase() : "";
}

// Vocale breve (fase 3): fino a 40 KB, circa 20 secondi, già salvato dal relay (msg._media). Si trascrive solo se il database
// dice che per quel numero ci sono tavole (progetti_wa_vocale_ammesso); se non è una richiesta chiara prosegue verso Make.
const PG_VOCALE_MAX = 40 * 1024;
function pgVocale(msg) {
  const m = msg && msg.type === "audio" && msg._media;
  return m && m.signed_url && Number(m.bytes) > 0 && Number(m.bytes) <= PG_VOCALE_MAX ? String(m.signed_url) : "";
}

export function progettiWaComando(msg) {
  if (pgScelta(msg)) return true;
  if (pgVocale(msg)) return true;
  const t = pgTesto(msg);
  return !!t && t.length <= 200 && (PG_FORTE.test(t) || PG_DEBOLE.test(t));
}

// Fase 3: la richiesta chiara non ha trovato niente → Claude sceglie dall'elenco delle tavole in vigore (Edge Function progetti-cerca).
async function pgCercaIa(env, tel, testo, nomeWa) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(supabaseUrl(env) + "/functions/v1/progetti-cerca", {
      method: "POST", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ telefono: tel, testo, nome_wa: nomeWa }), signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j && ["manda", "elenco", "non_trovata", "archivio", "limite"].indexOf(j.esito) !== -1 ? j : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function progettiWaGestisci(msg, value, env, h) {
  const tel = String(msg.from || "");
  const phoneId = (value.metadata && value.metadata.phone_number_id) || "";
  if (!progettiWaComando(msg) || !tel || !phoneId || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN || env.PROGETTI === "off") return false;
  const scelta = pgScelta(msg);
  let testoMsg = pgTesto(msg);
  const vocale = pgVocale(msg);
  if (vocale) {
    // vocale: si trascrive solo se ha senso, e si prende solo se è una richiesta chiara di tavola
    if (typeof h.trascrivi !== "function") return false;
    const am = await h.rpc(env, "progetti_wa_vocale_ammesso", { p_telefono: tel }, 6000).catch(() => null);
    if (!am || am.ok !== true) return false;
    const tr = await h.trascrivi(vocale).catch(() => null);
    testoMsg = String((tr && tr.testo) || "").replace(/[.!?…]+$/g, "").trim().slice(0, 200);
    if (!testoMsg || !PG_FORTE.test(testoMsg)) return false;   // un vocale del diario: prosegue come sempre
  }
  const forte = !!scelta || PG_FORTE.test(testoMsg);
  const nomeWa = (value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name) || "";
  let r = await h.rpc(env, "progetti_wa_richiesta", { p_telefono: tel, p_testo: testoMsg, p_scelta: scelta || null, p_nome_wa: String(nomeWa).slice(0, 80) }, 8000);
  if (!r || !r.esito || r.esito === "spento" || r.esito === "errore") return false;
  if (!forte && (r.esito === "non_trovata" || r.esito === "non_registrato")) return false;   // forse era una voce del diario
  // fase 3: richiesta chiara senza risultati con codice e parole → intelligenza artificiale (tetto mensile nel database)
  if (forte && !scelta && r.esito === "non_trovata" && env.PROGETTI_IA !== "off") {
    const ia = await pgCercaIa(env, tel, testoMsg, String(nomeWa).slice(0, 80));
    if (ia) r = ia;
  }
  const testoBase = { messaging_product: "whatsapp", recipient_type: "individual", to: tel, context: { message_id: msg.id } };
  const scrivi = (t) => h.invia(phoneId, env.WHATSAPP_TOKEN, Object.assign({}, testoBase, { type: "text", text: { body: t.slice(0, 1500), preview_url: false } }));
  try {
    if (r.esito === "manda") {
      const ps = String(r.percorso || "");
      if (!/^documenti\/[0-9a-f-]{36}\/progetti\/(cache\/)?[A-Za-z0-9_-]+\.(pdf|p7m)$/.test(ps)) { await scrivi("Non riesco a prendere la tavola adesso: riprova tra qualche minuto."); return true; }
      const svc = env.SUPABASE_SERVICE_KEY;
      const sg = await fetch(supabaseUrl(env) + "/storage/v1/object/sign/wa-media/" + percorsoStorage(ps), {
        method: "POST", headers: { Authorization: "Bearer " + svc, apikey: svc, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 900 }) });
      const sj = sg.ok ? await sg.json().catch(() => null) : null;
      if (!sj || typeof sj.signedURL !== "string") { await scrivi("Non riesco a prendere la tavola adesso: riprova tra qualche minuto."); return true; }
      const didascalia = "📐 *" + r.codice + "*" + (r.titolo ? " " + r.titolo : "") + (r.lotto ? "\n" + r.lotto : "") + "\nRev. " + r.revisione + (r.data ? " del " + r.data : "") + " · *in vigore*" +
        (r.variante ? " · variante" : "") + (r.cantiere ? "\n" + r.cantiere : "") + "\nRiservata al cantiere. Prima di stampare controlla sempre la revisione.";
      const inv = await h.invia(phoneId, env.WHATSAPP_TOKEN, Object.assign({}, testoBase, { type: "document",
        document: { link: supabaseUrl(env) + "/storage/v1" + sj.signedURL, filename: String(r.nome_file || (r.codice + ".pdf")).slice(0, 200), caption: didascalia.slice(0, 1000) } }));
      // chatUnicaInvia risponde { ok, status, testo }: l'id del messaggio di Meta è nel testo (primi 300 caratteri)
      const wid = (String((inv && inv.testo) || "").match(/"id"\s*:\s*"(wamid\.[^"]+)"/) || [])[1] || "";
      try { await h.rpc(env, "progetti_wa_esito", { p_invio: r.invio_id, p_wa_message_id: wid, p_ok: !!(inv && inv.ok) }, 6000); } catch (e) {}
    } else if (r.esito === "elenco" && Array.isArray(r.righe) && r.righe.length) {
      const righe = r.righe.slice(0, 10).map((x) => ({ id: "PRG_" + x.id, title: String(x.codice + " rev. " + x.revisione).slice(0, 24),
        description: String((x.lotto ? x.lotto + " · " : "") + (x.titolo || "") + (x.cantiere ? " · " + x.cantiere : "")).slice(0, 72) }));
      await h.invia(phoneId, env.WHATSAPP_TOKEN, Object.assign({}, testoBase, { type: "interactive", interactive: { type: "list",
        body: { text: "Ho trovato " + r.quante + " tavole in vigore" + (r.quante > 10 ? " (ti mostro le prime 10)" : "") + ". Quale ti serve?" },
        action: { button: "Scegli la tavola", sections: [{ title: "Tavole in vigore", rows: righe }] } } }));
    } else if (r.esito === "archivio") {
      await scrivi("La tavola " + (r.codice || "") + " è nell'archivio: la sto riprendendo. Riscrivimi la richiesta tra un minuto e te la mando.");
    } else if (r.esito === "limite") {
      await scrivi("Oggi hai già chiesto " + (r.limite || 20) + " tavole: per oggi basta così. Riprova domani oppure chiedi all'ufficio.");
    } else if (r.esito === "non_registrato") {
      await scrivi("Le tavole le mando solo a chi è registrato nel cantiere. Chiedi all'ufficio della tua impresa di aggiungerti in «Persone del cantiere».");
    } else {
      await scrivi("Non trovo una tavola in vigore con queste parole. Scrivi il codice della tavola (per esempio «tavola STR-03») oppure chiedila all'ufficio.");
    }
  } catch (e) {}
  try { await h.log(env, tel, msg.id, "progetti_tavola", String(r.esito)); } catch (e) {}
  return true;
}

// Solo per il banco di prova locale (pagina con dati inventati, senza database): stessa pagina della rotta vera.
export function progettiPaginaProva(base, h, p, d) {
  return pagina(base, h, p, d, base + "/?t=" + p.tok + "&c=" + p.c);
}
