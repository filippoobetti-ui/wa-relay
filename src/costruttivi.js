// ============================================================================
// COSTRUTTIVI DEI FORNITORI — area riservata (09/11/2026, costruttivi-1, fase C1). Sezione a parte della pagina del cantiere
// (scelta di Filippo del 09/11/2026): il pulsante «Costruttivi» apre la pagina dei disegni costruttivi mandati dai fornitori
// (copertura in legno, carpenteria metallica, serramenti…). Per ogni costruttivo: fornitore, codice, titolo, revisione,
// «Riguarda le strutture», chi l'ha caricato e quando, impronta SHA-256, stato di approvazione. Ogni costruttivo nasce
// «Da approvare»; prima della firma non va su WhatsApp e non è tra le tavole del cantiere. La revisione nuova dello stesso
// codice e dello stesso fornitore rende «Superata» quella di prima (resta nel database e nell'archivio, non si vede più qui).
// Tabelle PROPRIE (costruttivi), non dentro progetti_tavole: i Progetti non si toccano. Dal 09/11/2026 (costruttivi-2, C2) qui c'è
// anche «Chiedi il visto» per i costruttivi delle strutture (tabella costruttivi_visti); strutturista e DL rispondono dalle pagine
// /studio della chat 02A. Dal 09/11/2026 (costruttivi-3, C3a) «Firma per approvazione» con il firmatore comune (src/firma.js,
// /firma/firma-tix.js), «Firme e timbro» e la copia firmata; si firma solo «Da approvare» e, per le strutture, con il visto completo.
//   GET  /costruttivi?t=<gettone>&c=<cantiere>             → pagina (database: costruttivi_contesto)
//   POST /costruttivi/carica  intestazione X-Costruttivi-Dati = JSON in base64url {t, c, fornitore, codice, titolo, revisione,
//                          strutture, autore, nome, byte, sha256}; corpo = il file (PDF o .p7m, fino a progetti_max_mb)
//   POST /costruttivi/azione  {t, c, azione: "annulla", id, dati: {chi, motivo}}  (solo se ancora «Da approvare»)
//                             {t, c, azione: "visto_chiedi", id, dati: {chi}}  (09/11/2026, costruttivi-2, fase C2: visto di
//                             strutturista e DL sui costruttivi «Riguarda le strutture»; rispondono dalle pagine /studio della 02A)
//   GET  /costruttivi/file?t=…&c=…&id=…[&scarica=1]       → il file della revisione in vigore
// Caricamento come i Progetti: prima il controllo nel database (costruttivi_carica_controlla), poi il corpo; tipo letto dai
// primi byte; impronta ricalcolata qui fino a 5 MB, altrimenti vale quella del browser. Il file va in wa-media
// (documenti/<cantiere>/costruttivi/AAAAMMGG-<12 esadecimali>.pdf|p7m) e lì resta: l'archivio su Drive arriva con la firma (C3).
// Interruttori: impostazioni.costruttivi_attiva (no / prova = solo l'accesso «Tutte le aziende» / si) e COSTRUTTIVI = "off".
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERIFICA_MAX = 5 * 1024 * 1024;   // il Worker ricalcola l'impronta solo fino a 5 MB

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
function quando(ts) {   // "2026-11-09T18:20" → "09/11/2026 alle 18:20"
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
export async function costruttiviPulsante(env, token, commessa) {
  if (!env || !env.SUPABASE_SERVICE_KEY || env.COSTRUTTIVI === "off") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(supabaseUrl(env) + "/rest/v1/rpc/costruttivi_pulsante", {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_token: token, p_commessa: commessa }), signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j !== "object" || j.esito !== "ok" || j.attiva !== true) return null;
    return { attiva: true, modo: String(j.modo || ""), in_vigore: Math.max(0, Math.min(9999, Number(j.in_vigore) || 0)),
      da_approvare: Math.max(0, Math.min(999, Number(j.da_approvare) || 0)) };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Settimo pulsante della riga dei pulsanti del cantiere, subito dopo «Progetti». index.js mette questo script DOPO quello dei
// Progetti nella catena: a ogni giro (subito, 0, 60, 150, 400 ms e al caricamento) i Progetti si rimettono in fondo e poi
// «Costruttivi» si rimette dopo di loro. Da solo, se la riga non c'è, va accanto a «Progetti» sotto le schede.
export function costruttiviIniezione(base, token, commessa, daApprovare) {
  const u = base + "/costruttivi?t=" + token + "&c=" + encodeURIComponent(commessa);
  const n = Math.max(0, Math.min(999, Number(daApprovare) || 0));
  const icona = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 20h18"/><path d="M5 20V9l7-5 7 5v11"/><path d="M9 20v-6h6v6"/><path d="M5 9h14"/></svg>';
  const etichetta = icona + " Costruttivi" + (n ? ' <span class="gl-cs-n" title="Da approvare">' + n + "</span>" : "");
  return "<style>.gl-cs-barra{max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right}" +
    ".gl-cs-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 16px;border:1.5px solid #3F4A9E;border-radius:10px;background:#EEF0FA;color:#2C3577;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none;box-shadow:0 0 0 3px rgba(63,74,158,.14)}" +
    ".gl-cs-b:hover,.gl-cs-b:focus-visible{background:#3F4A9E;color:#fff;outline:none}" +
    ".gl-cs-n{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#B45309;color:#fff;font-size:.74rem;font-weight:800}" +
    ".gl-pg-barra .gl-cs-b,.gl-cs-barra .gl-pg-b{margin-left:8px}" +
    // con sette pulsanti: 7 colonne sul computer largo, 4 fino a 1300 px, 2 fino a 900 px, 1 sul telefono
    ".gl-azioni.gl-az5.gl-az6.gl-az7{grid-template-columns:repeat(7,minmax(0,1fr))}" +
    "@media (max-width:1300px){.gl-azioni.gl-az5.gl-az6.gl-az7{grid-template-columns:repeat(4,minmax(0,1fr))}}" +
    "@media (max-width:900px){.gl-azioni.gl-az5.gl-az6.gl-az7{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
    "@media (max-width:640px){.gl-azioni.gl-az5.gl-az6.gl-az7{grid-template-columns:minmax(0,1fr)}}" +
    "@media (prefers-color-scheme:dark){.gl-cs-b{background:#1e2240;color:#d9ddf7;border-color:#6E78C9}}</style>" +
    "<script>(function(){try{var a=document.createElement('a');a.className='gl-cs-b';a.href=" + JSON.stringify(u) + ";a.innerHTML=" + JSON.stringify(etichetta) + ";" +
    "function metti(){var r=document.querySelector('.gl-azioni');" +
    "if(r){var pg=r.querySelector('.gl-pg-b');if(pg){if(pg.nextElementSibling!==a)r.insertBefore(a,pg.nextSibling);}else if(r.lastElementChild!==a)r.appendChild(a);" +
    "var v=document.querySelector('.gl-cs-barra');if(v&&!v.children.length&&v.parentNode)v.parentNode.removeChild(v);" +
    "var n=r.children.length;r.classList.toggle('gl-az4',n===4);r.classList.toggle('gl-az5',n>=5);r.classList.toggle('gl-az6',n>=6);r.classList.toggle('gl-az7',n>=7);return;}" +
    "var pb=document.querySelector('.gl-pg-barra');if(pb){if(pb.lastElementChild!==a)pb.appendChild(a);return;}" +
    "if(a.parentNode)return;var b=document.createElement('div');b.className='gl-cs-barra';b.appendChild(a);var nav=document.querySelector('nav.schede');" +
    "if(nav&&nav.parentNode){nav.parentNode.insertBefore(b,nav.nextSibling);}else{document.body.insertBefore(b,document.body.firstChild);}}" +
    "metti();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',metti);setTimeout(metti,0);setTimeout(metti,60);setTimeout(metti,150);setTimeout(metti,400);" +
    "window.addEventListener('load',metti);}catch(e){}})();</script>";
}

// ---------------------------------------------------------------------------- rotte
export async function portaleCostruttivi(request, env, base, inUrl, h) {
  if (env.COSTRUTTIVI === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");
  if (sotto === "/costruttivi/carica") return carica(request, env, h);
  if (sotto === "/costruttivi/azione") return azione(request, env, h);
  if (sotto === "/costruttivi/file") return apriFile(request, env, base, inUrl, h);
  if (sotto !== "/costruttivi") return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const p = parametri(inUrl);
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!UUID.test(p.c)) return Response.redirect(inUrl.origin + base + "/?t=" + p.tok, 303);
  const torna = base + "/?t=" + p.tok + "&c=" + p.c;
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>';
  const d = await h.rpc(env, "costruttivi_contesto", { p_token: p.tok, p_commessa: p.c }, 20000).catch(() => null);
  if (!d || typeof d !== "object") return h.risposta(h.foglio(base, "Costruttivi dei fornitori", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Costruttivi dei fornitori", "Questa pagina non è disponibile per questo cantiere.", indietro), 404);
  return h.risposta(pagina(base, h, p, d, torna));
}

// ---------------------------------------------------------------------------- caricamento (un file per richiesta)
async function carica(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  const grezzo = String(request.headers.get("X-Costruttivi-Dati") || "");
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
    fornitore: testo(d.fornitore, 120), codice: testo(d.codice, 60), titolo: testo(d.titolo, 200), revisione: testo(d.revisione, 30),
    strutture: d.strutture === true, autore: testo(d.autore, 120), nome, byte, sha256: sha
  };
  const dichiarati = Number(request.headers.get("Content-Length") || 0);
  if (!Number.isFinite(byte) || byte <= 0) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (dichiarati && dichiarati !== byte) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  // prima l'accesso, l'interruttore, il cantiere aperto e la misura: chi non può caricare non scrive niente nell'archivio
  const ctl = await h.rpc(env, "costruttivi_carica_controlla", { p_token: tok, p_commessa: c,
    p_dati: { fornitore: dati.fornitore, codice: dati.codice, revisione: dati.revisione, nome, byte } }, 10000).catch(() => null);
  if (!ctl || typeof ctl !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 502);
  if (ctl.esito !== "ok") return json(ctl, ctl.esito === "gettone" ? 403 : 200);
  const cartella = "documenti/" + c + "/costruttivi/";
  const est = ctl.est === "p7m" ? "p7m" : ctl.est === "pdf" ? "pdf" : "";
  const max = Number(ctl.max_byte) || 0;
  if (ctl.cartella !== cartella || !est || !max) return json({ esito: "errore", messaggio: "Richiesta non valida: ricarica la pagina." }, 502);
  const troppo = "Il file è troppo grande: in TIX un costruttivo arriva fino a " + Math.round(max / 1048576) + " MB.";
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
  try {
    const up = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(percorso), {
      method: "POST",
      headers: { Authorization: "Bearer " + svc, apikey: svc, "Content-Type": est === "p7m" ? "application/pkcs7-mime" : "application/pdf", "x-upsert": "false" },
      body: bytes, signal: ctrl.signal
    });
    if (!up.ok) return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } catch (e) {
    await togli(env, percorso, c);
    return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } finally {
    clearTimeout(timer);
  }
  const r = await h.rpc(env, "costruttivi_registra", { p_token: tok, p_commessa: c,
    p_dati: Object.assign({}, dati, { byte: bytes.length, percorso }) }, 15000).catch(() => null);
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Non so se il costruttivo è stato registrato: ricarica la pagina prima di riprovare." }, 502);
  if (r.esito !== "ok") {
    await togli(env, percorso, c);
    return json(r, r.esito === "gettone" ? 403 : 200);
  }
  return json({ esito: "ok", id: r.id, superate: r.superate });
}

// Toglie dall'archivio una copia di questo cantiere appena caricata (mai altro).
async function togli(env, percorso, c) {
  const p = String(percorso || "");
  if (!UUID.test(c) || !new RegExp("^documenti/" + c + "/costruttivi/[0-9]{8}-[0-9a-f]{12}\\.(pdf|p7m)$").test(p)) return false;
  try {
    const r = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(p), {
      method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } });
    return r.ok;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------- azioni sui costruttivi
async function azione(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  if (Number(request.headers.get("Content-Length") || 0) > 20000) return json({ esito: "richiesta_non_valida" }, 413);
  let d = null;
  try { d = await request.json(); } catch (e) { d = null; }
  if (!d || typeof d !== "object") return json({ esito: "richiesta_non_valida" }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const id = String(d.id || "").toLowerCase();
  const a = String(d.azione || "");
  const dati = d.dati && typeof d.dati === "object" && !Array.isArray(d.dati) ? d.dati : {};
  if (!tok) return json({ esito: "gettone" }, 403);
  let r = null;
  if (a === "annulla") {
    if (!UUID.test(id)) return json({ esito: "richiesta_non_valida" }, 400);
    r = await h.rpc(env, "costruttivi_annulla", { p_token: tok, p_id: id, p_motivo: testo(dati.motivo, 300), p_chi: testo(dati.chi, 120) }, 15000).catch(() => null);
  } else if (a === "visto_chiedi") {
    if (!UUID.test(id)) return json({ esito: "richiesta_non_valida" }, 400);
    r = await h.rpc(env, "costruttivi_visto_chiedi", { p_token: tok, p_id: id, p_chi: testo(dati.chi, 120) }, 15000).catch(() => null);
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
  const torna = base + "/costruttivi?t=" + p.tok + "&c=" + p.c;
  const indietro = '<a class="btn" href="' + e(torna) + '">Torna ai Costruttivi dei fornitori</a>';
  if (!UUID.test(p.c) || !UUID.test(id)) return h.risposta(h.foglio(base, "Costruttivo non trovato", "", indietro), 404);
  const info = await h.rpc(env, "costruttivi_file_info", { p_token: p.tok, p_id: id }, 10000).catch(() => null);
  if (!info || typeof info !== "object") return h.risposta(h.foglio(base, "Costruttivo", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (info.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (info.esito === "superata") {
    return h.risposta(h.foglio(base, "Questa revisione non è più in vigore", "È arrivata una revisione nuova di questo costruttivo, oppure è stato tolto: apri quello in vigore dai Costruttivi dei fornitori.", indietro), 410);
  }
  if (info.esito !== "ok" || String(info.commessa_id || "") !== p.c) return h.risposta(h.foglio(base, "Costruttivo non trovato", "", indietro), 404);
  const ps = String(info.transito || "");
  if (!ps || ps.indexOf("documenti/" + p.c + "/costruttivi/") !== 0 || ps.indexOf("..") !== -1) {
    return h.risposta(h.foglio(base, "Costruttivo", "Il file di questo costruttivo non è disponibile in questo momento.", indietro), 404);
  }
  const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(ps), {
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  if (f && f.ok) return servi(f, info, scarica, metodo);
  if (f && (f.status === 400 || f.status === 404)) return h.risposta(h.foglio(base, "Costruttivo", "Il file di questo costruttivo non è disponibile nell'archivio. Scrivici e lo recuperiamo noi.", indietro), 404);
  return h.risposta(h.foglio(base, "Costruttivo", "Il file non si legge dall'archivio in questo momento: riprova tra un minuto.", indietro), 502);
}

// Il tipo del file lo decide la riga del database, mai quello salvato nell'archivio.
function servi(f, info, scarica, metodo) {
  const p7m = info.mime === "application/pkcs7-mime";
  const nome = String(info.nome || (p7m ? "costruttivo.p7m" : "costruttivo.pdf"));
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || (p7m ? "costruttivo.p7m" : "costruttivo.pdf");
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
  casa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><path d="M5 20V9l7-5 7 5v11"/><path d="M9 20v-6h6v6"/><path d="M5 9h14"/></svg>',
  piu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  su: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-3"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14l3-3 3 3"/></svg>',
  cerca: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  archivio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M2 3h20v4H2zM10 12h4"/></svg>',
  penna: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  persone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 4.5a3 3 0 0 1 0 6M18 14.6c1.8.7 3 2.4 3 5.4"/></svg>',
  occhio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
};
// C2: il costruttivo delle strutture «Da approvare» aspetta ancora il visto (non chiesto, oppure manca una risposta)
function attesaVisto(x) { return !!(x && x.strutture && x.approvazione === "da_approvare" && !x.visti_completi); }
const STATI = {
  da_approvare: ["da", "Da approvare"],
  approvato: ["ok", "Approvato"],
  osservazioni: ["os", "Approvato con osservazioni"],
  da_rivedere: ["no", "Non approvato – da rivedere"]
};

function pagina(base, h, p, d, torna) {
  const e = h.esc;
  const voci = lista(d.costruttivi);
  const chiuso = !!d.chiuso;
  const fornitoriRubrica = lista(d.fornitori).map((x) => testo(x, 120)).filter(Boolean);
  const maxMb = Math.max(1, Math.min(50, Number(d.max_mb) || 25));
  const sup = Math.max(0, Number(d.superate) || 0);
  const qui = base + "/costruttivi";
  const conta = (k) => voci.filter((x) => x.approvazione === k).length;
  const daApprovare = conta("da_approvare");
  const approvati = conta("approvato") + conta("osservazioni");
  const rivedere = conta("da_rivedere");
  const strutture = voci.filter((x) => x.strutture).length;
  // costruttivi-2 (fase C2): visto di strutturista e DL
  const vistoAttivo = d.visto_attivo === true;
  const pro = d.professionisti && typeof d.professionisti === "object" ? d.professionisti : {};
  const inAttesa = vistoAttivo ? voci.filter((x) => attesaVisto(x)).length : 0;
  // costruttivi-3 (fase C3a): firma per approvazione
  const firmaAttiva = d.firma_attiva === true;
  const impostazioniFirma = base + "/firma/impostazioni?t=" + p.tok + "&c=" + p.c + "&da=costruttivi";
  const fornitori = Array.from(new Set(voci.map((x) => String(x.fornitore || "").trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "it", { sensitivity: "base" }));

  const cifre = '<div class="cs-cifre">' +
    '<div class="cs-c-pr"><b>' + voci.length + '</b><span>Costruttivi in vigore</span></div>' +
    '<div class="cs-c-da"><b>' + daApprovare + '</b><span>Da approvare</span></div>' +
    '<div class="cs-c-ok"><b>' + approvati + '</b><span>Approvati</span></div>' +
    '<div class="cs-c-gr"><b>' + sup + '</b><span>Revisioni superate, solo in archivio</span></div></div>';

  const filtri = '<div class="cs-cerca"><div class="cs-filtri" role="group" aria-label="Mostra">' +
    '<button type="button" class="on" data-f="">Tutti <i>' + voci.length + '</i></button>' +
    '<button type="button" data-f="da_approvare"' + (daApprovare ? "" : " hidden") + '>Da approvare <i>' + daApprovare + '</i></button>' +
    '<button type="button" data-f="approvati"' + (approvati ? "" : " hidden") + '>Approvati <i>' + approvati + '</i></button>' +
    '<button type="button" data-f="da_rivedere"' + (rivedere ? "" : " hidden") + '>Da rivedere <i>' + rivedere + '</i></button>' +
    '<button type="button" data-f="strutture"' + (strutture ? "" : " hidden") + '>Strutture <i>' + strutture + '</i></button>' +
    (vistoAttivo ? '<button type="button" data-f="visto"' + (inAttesa ? "" : " hidden") + '>Senza visto completo <i>' + inAttesa + '</i></button>' : "") + '</div>' +
    '<label class="cs-campo">' + SVG.cerca + '<input type="search" id="cs-q" placeholder="Cerca: copertura, COP-01, fornitore…" aria-label="Cerca un costruttivo"></label></div>';

  let sezioni = "";
  let num = 0;
  fornitori.forEach((f) => {
    const t = voci.filter((x) => String(x.fornitore || "").trim() === f)
      .sort((a, b) => String(a.codice).localeCompare(String(b.codice), "it", { numeric: true }));
    if (!t.length) return;
    num++;
    sezioni += '<section class="cs-sez"><h2><span class="n">' + num + '</span>' + e(f) + ' <small>' + t.length + (t.length === 1 ? " costruttivo" : " costruttivi") + '</small></h2>' +
      t.map((x) => riga(e, qui, p, x, chiuso, vistoAttivo, firmaAttiva, base)).join("") + '</section>';
  });
  if (!voci.length) {
    sezioni = '<div class="cs-vuoto">' + SVG.casa + '<p><b>Nessun costruttivo ancora.</b> ' +
      (chiuso ? "Il cantiere è chiuso." : "Carica i PDF che ti mandano i fornitori: copertura in legno, carpenteria metallica, serramenti, facciate, impianti prefabbricati.") + '</p></div>';
  }

  const regole = '<div class="cs-regole">' + SVG.penna + '<div><b>Come funziona.</b> Ogni costruttivo nasce «Da approvare» e resta in questa pagina. ' +
    'Prima della firma non va su WhatsApp e non è tra le tavole del cantiere. ' +
    'Per i costruttivi che riguardano le strutture, la firma richiede il visto dello strutturista e della Direzione Lavori' +
    (vistoAttivo ? ': chiedilo con «Chiedi il visto». Lo vedono nella loro Area professionisti e rispondono «Visto» oppure «Osservazioni».' : ".") +
    (firmaAttiva ? ' Poi lo firmi con «Firma per approvazione»: TIX mette firma e timbro dell\'impresa nel punto che tocchi e conserva l\'originale e la copia firmata, ' +
      'ognuno con la sua impronta. Chi può firmare lo indichi in <a href="' + e(impostazioniFirma) + '">«Firme e timbro»</a>.' : "") + '</div></div>';
  // chi manca nel cantiere per il visto (solo se c'è almeno un costruttivo delle strutture da approvare)
  const RUOLI = { strutt: "lo strutturista", dl: "il Direttore dei Lavori" };
  const serve = vistoAttivo && !chiuso && voci.some((x) => x.strutture && x.approvazione === "da_approvare");
  const mancano = serve ? ["strutt", "dl"].filter((k) => pro[k] !== "attivo") : [];
  const persone = base + "/persone?t=" + p.tok + "&c=" + p.c;
  const MAIUSC = { strutt: "Lo strutturista", dl: "Il Direttore dei Lavori" };
  const avvisoPro = mancano.length ? '<div class="cs-manca">' + SVG.persone + '<div><b>Per il visto ' + (mancano.length > 1 ? "mancano " : "manca ") +
    mancano.map((k) => RUOLI[k]).join(" e ") + '.</b> ' +
    mancano.map((k) => MAIUSC[k] + (pro[k] === "invitato"
      ? " è invitato ma non è ancora entrato in TIX: ricordagli di scegliere la password dall'email dell'invito."
      : " non è tra le Persone del cantiere con l'accesso all'Area professionisti: aggiungilo con il suo ruolo.")).join(" ") +
    (mancano.length > 1 ? ' Le richieste di visto restano aperte e le vedono appena entrano.' : ' La richiesta di visto resta aperta e la vede appena entra.') +
    '<p class="cs-manca-az"><a class="btn sm sec" href="' + e(persone) + '">Apri Persone del cantiere</a></p></div></div>' : "";

  const elenco = fornitoriRubrica.length ? '<datalist id="cs-fornitori">' + fornitoriRubrica.map((x) => '<option value="' + e(x) + '">').join("") + '</datalist>' : "";
  const form = chiuso ? "" :
    '<section class="cs-form" id="carica"><h3><span class="cs-mini">' + SVG.su + '</span>Carica costruttivi</h3>' +
    '<p class="cs-sotto">Puoi scegliere più file dello stesso fornitore insieme. TIX prova a leggere codice, titolo e revisione dal nome del file: controlla e correggi prima di salvare.</p>' +
    '<div class="cs-chi cs-forn"><label for="cs-forn">Fornitore</label><input id="cs-forn" maxlength="120" list="cs-fornitori" autocomplete="off" placeholder="Scegli dalla Rubrica o scrivi il nome della ditta"></div>' +
    '<label class="cs-drop" id="cs-drop"><span class="cs-scegli">' + SVG.file + '<span>Trascina qui i PDF o tocca per sceglierli<small>PDF o PDF firmato (.p7m), fino a ' + maxMb + ' MB l\'uno · l\'impronta la calcola il tuo telefono o computer</small></span></span>' +
    '<span class="btn sm sec">Scegli i file</span><input type="file" id="cs-file" accept="application/pdf,.pdf,.p7m" multiple hidden></label>' +
    '<div class="cs-tutte" id="cs-tutte" hidden><label for="cs-rev-tutte">Stessa revisione per tutti</label><input id="cs-rev-tutte" maxlength="30" placeholder="es. A">' +
    '<button type="button" class="btn sm sec" id="cs-rev-applica">Applica a tutti</button></div>' +
    '<p class="cs-mancano" id="cs-mancano" role="status" hidden></p>' +
    '<div class="cs-fl" id="cs-fl" hidden><div class="cs-fr cs-th"><span>File</span><span>Codice</span><span>Titolo</span><span>Rev.</span><span>Strutture</span></div><div id="cs-righe"></div></div>' +
    '<div class="cs-chi" id="cs-chi-box" hidden><label for="cs-chi">Il tuo nome</label><input id="cs-chi" maxlength="120" autocomplete="name" placeholder="Resta scritto chi ha caricato i costruttivi"></div>' +
    '<div class="cs-arch">' + SVG.archivio + '<span>La revisione nuova di un codice dello stesso fornitore diventa quella in vigore. Quella di prima diventa «Superata»: resta nell\'archivio di TIX, ma non si vede più qui.</span></div>' +
    '<p class="cs-msg" id="cs-msg" role="status"></p>' +
    '<div class="cs-form-az" id="cs-az" hidden><button type="button" class="btn tenue" id="cs-annulla">Annulla</button><button type="button" class="btn pr" id="cs-salva">Salva</button></div></section>';

  const cfg = JSON.stringify({ u: qui, b: base, t: p.tok, c: p.c, max: maxMb * 1048576, maxMb }).replace(/</g, "\\u003c");

  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>Costruttivi dei fornitori - TIX · Diario di cantiere</title>" + h.testa(base) +
    "<style>" + STILE + "</style></head><body><main>" +
    '<a class="cs-torna" href="' + e(torna) + '">‹ Torna al cantiere</a>' +
    '<div class="cs-card">' +
    '<div class="cs-testa"><div>' + (d.cantiere ? '<p class="cs-cant">' + e(d.cantiere) + '</p>' : "") +
    '<h1><span class="cs-ic" aria-hidden="true">' + SVG.casa + '</span>Costruttivi dei fornitori</h1>' +
    (d.modo === "prova" ? '<p class="cs-prova">In prova: questa pagina la vede solo l\'accesso «Tutte le aziende»</p>' : "") + '</div>' +
    (chiuso && !firmaAttiva ? "" : '<div class="cs-az-testa">' + (firmaAttiva ? '<a class="btn sec" href="' + e(impostazioniFirma) + '">' + SVG.penna + 'Firme e timbro</a>' : "") +
      (chiuso ? "" : '<a class="btn pr" href="#carica">' + SVG.piu + 'Carica costruttivi</a>') + '</div>') + '</div>' +
    cifre + regole + avvisoPro + (voci.length ? filtri : "") + sezioni + '<p class="cs-nessuno" id="cs-nessuno" hidden>Nessun costruttivo con questa ricerca.</p>' +
    elenco + form +
    '<p class="cs-fonti">TIX™ conserva i costruttivi dei fornitori, li tiene in ordine e mostra solo la revisione in vigore. Non controlla i disegni: la responsabilità resta dei fornitori, dei progettisti e della Direzione Lavori.</p>' +
    '</div></main>' +
    '<dialog class="cs-dlg" id="cs-dlg"><form method="dialog"><h3>Togli il costruttivo <span id="cs-dlg-cod"></span></h3>' +
    '<p>Usalo solo per un file caricato per sbaglio, finché il costruttivo è «Da approvare». Resta registrato come tolto; se aveva sostituito una revisione, quella di prima torna in vigore.</p>' +
    '<label for="cs-dlg-chi">Il tuo nome</label><input id="cs-dlg-chi" maxlength="120" autocomplete="name">' +
    '<label for="cs-dlg-mot">Perché (facoltativo)</label><input id="cs-dlg-mot" maxlength="300" placeholder="Per esempio: file sbagliato">' +
    '<p class="cs-msg" id="cs-dlg-msg" role="status"></p>' +
    '<div class="cs-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn rosso" id="cs-dlg-si">Togli</button></div></form></dialog>' +
    (vistoAttivo ? '<dialog class="cs-dlg" id="cs-vs-dlg"><form method="dialog"><h3>Chiedi il visto di <span id="cs-vs-cod"></span></h3>' +
      '<p>Lo strutturista e il Direttore dei Lavori del cantiere vedono il costruttivo nella loro Area professionisti, ricevono un\'email ' +
      'e rispondono «Visto» oppure «Osservazioni». La firma si accende quando hanno risposto tutti e due.</p>' +
      '<label for="cs-vs-chi">Il tuo nome</label><input id="cs-vs-chi" maxlength="120" autocomplete="name">' +
      '<p class="cs-msg" id="cs-vs-msg" role="status"></p>' +
      '<div class="cs-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn pr" id="cs-vs-si">Chiedi il visto</button></div></form></dialog>' : "") +
    "<script>var CFG=" + cfg + ";" + SCRIPT + "</script></body></html>";
}

// C2: riquadro del visto di strutturista e DL sul costruttivo delle strutture
const VISTO_RUOLI = [["strutt", "Strutturista"], ["dl", "Direzione Lavori"]];
function bloccoVisto(e, x, chiuso) {
  if (!x.strutture) return "";
  const vs = x.visti && typeof x.visti === "object" ? x.visti : null;
  if (!vs) {
    if (x.approvazione !== "da_approvare") return "";
    return '<div class="cs-visti"><span class="cs-vs-tit">' + SVG.occhio + 'Visto di strutturista e DL: non ancora chiesto</span>' +
      (chiuso ? "" : '<button type="button" class="btn sm sec" data-visto="' + e(x.id) + '" data-cod="' + e(x.codice + " rev. " + x.revisione) + '">Chiedi il visto</button>') + '</div>';
  }
  return '<div class="cs-visti"><span class="cs-vs-tit">' + SVG.occhio + 'Visto di strutturista e DL' +
    (x.visti_completi ? ' <em class="cs-vs-ok">completo</em>' : "") + '</span>' +
    VISTO_RUOLI.map(([k, n]) => {
      const v = vs[k] && typeof vs[k] === "object" ? vs[k] : null;
      if (!v) return '<div class="cs-vs-r"><b>' + e(n) + '</b><span class="cs-vs-st at">non chiesto</span></div>';
      if (!v.esito) return '<div class="cs-vs-r"><b>' + e(n) + '</b><span class="cs-vs-st at">In attesa</span><span class="cs-vs-q">chiesto da ' + e(v.chiesto_da || "") + ' il ' + e(quando(v.chiesto_il)) + '</span></div>';
      const oss = v.esito === "osservazioni";
      return '<div class="cs-vs-r"><b>' + e(n) + '</b><span class="cs-vs-st ' + (oss ? "os" : "ok") + '">' + (oss ? "Osservazioni" : "Visto") + '</span>' +
        '<span class="cs-vs-q">' + e(v.chi || "") + ' il ' + e(quando(v.il)) + (v.cambiato ? " (risposta cambiata)" : "") + '</span>' +
        (oss && v.nota ? '<p class="cs-vs-nota">' + e(v.nota) + '</p>' : "") + '</div>';
    }).join("") + '</div>';
}

function riga(e, qui, p, x, chiuso, vistoAttivo, firmaAttiva, base) {
  const apri = qui + "/file?t=" + p.tok + "&c=" + p.c + "&id=" + encodeURIComponent(x.id);
  const st = STATI[x.approvazione] || STATI.da_approvare;
  const meta = [];
  meta.push("<b>rev. " + e(x.revisione) + "</b>" + (x.sostituisce ? ", sostituisce la rev. " + e(x.sostituisce) : ""));
  meta.push("caricato da <b>" + e(x.caricato_da || "") + "</b> il " + e(quando(x.caricato_il)));
  if (x.approvazione !== "da_approvare" && x.approvato_da) meta.push("firmato da <b>" + e(x.approvato_da) + "</b> il " + e(quando(x.approvato_il)));
  meta.push(e(mb(x.byte)));
  const imp = '<span class="cs-imp" title="Impronta SHA-256 del file: ' + e(x.sha256 || "") + '">impronta ' + e(String(x.sha256 || "").slice(0, 8)) + '…</span>';
  const nota = x.nota ? '<p class="cs-nota"><b>' + (x.approvazione === "da_rivedere" ? "Da rivedere:" : "Osservazioni:") + '</b> ' + e(x.nota) + '</p>' : "";
  // C3a: firma per approvazione (spenta finché manca il visto delle strutture) e copia firmata
  const fm = x.firma && typeof x.firma === "object" ? x.firma : null;
  const copia = fm ? base + "/firma/file?t=" + p.tok + "&c=" + p.c + "&id=" + encodeURIComponent(fm.id) : "";
  const senzaVisto = !!(x.strutture && !x.visti_completi);
  const bFirma = firmaAttiva && !chiuso && x.approvazione === "da_approvare"
    ? (senzaVisto ? '<button type="button" class="btn sm pr" disabled title="Si firma dopo il visto di strutturista e DL">Firma per approvazione</button>'
      : '<button type="button" class="btn sm pr" data-firma="' + e(x.id) + '">Firma per approvazione</button>') : "";
  if (fm) meta.push('copia firmata: <span class="cs-imp" title="Impronta SHA-256 della copia firmata: ' + e(fm.sha256 || "") + '">impronta ' + e(String(fm.sha256 || "").slice(0, 8)) + '…</span>' +
    (fm.qualificata ? " · firma digitale qualificata" : ""));
  const az = bFirma + (fm ? '<a class="btn sm sec" href="' + e(copia) + '" target="_blank" rel="noopener">Copia firmata</a>' : "") +
    '<a class="btn sm tenue" href="' + e(apri) + '" target="_blank" rel="noopener">' + (fm ? "Originale" : "Apri") + '</a>' +
    '<a class="btn sm tenue" href="' + e(apri + "&scarica=1") + '">Scarica</a>' +
    (chiuso || x.approvazione !== "da_approvare" ? "" : '<button type="button" class="btn sm togli" data-togli="' + e(x.id) + '" data-cod="' + e(x.codice + " rev. " + x.revisione) + '">Togli</button>');
  const notaFirma = bFirma && senzaVisto ? '<p class="cs-attesa-firma">La firma si accende quando strutturista e DL hanno risposto.</p>' : "";
  const gruppo = x.approvazione === "approvato" || x.approvazione === "osservazioni" ? "approvati" : String(x.approvazione || "da_approvare");
  const q = (String(x.codice || "") + " " + String(x.titolo || "") + " " + String(x.nome || "") + " " + String(x.fornitore || "")).toLowerCase();
  return '<div class="cs-tv" data-stato="' + e(gruppo) + '" data-str="' + (x.strutture ? "1" : "") + '" data-vis="' + (vistoAttivo && attesaVisto(x) ? "1" : "") + '" data-q="' + e(q) + '">' +
    '<div class="cs-cod"><b>' + e(x.codice) + '</b><span class="cs-rev">rev. ' + e(x.revisione) + '</span></div>' +
    '<div class="cs-corpo"><p class="cs-tit">' + e(x.titolo || x.nome || x.codice) + (x.strutture ? ' <span class="cs-str">Riguarda le strutture</span>' : "") + '</p>' +
    '<p class="cs-meta">' + meta.join(" · ") + " · " + imp + '</p>' + nota + (vistoAttivo ? bloccoVisto(e, x, chiuso) : "") + notaFirma + '</div>' +
    '<div class="cs-lato"><span class="cs-st ' + st[0] + '">' + e(st[1]) + '</span><div class="cs-az">' + az + '</div></div></div>';
}

const STILE =
  ":root{--navy:#1B2F4A;--arancio:#F26A10;--pr:#3F4A9E;--pr-2:#5B66C0;--pr-s:#2C3577;--pr-f:#EEF0FA;--pr-b:#C9CDEC;" +
  "--t:#17212E;--s:#5B6672;--c:#FFFFFF;--z:#F5F7FA;--l:rgba(16,27,43,.11);--ro-f:#FDECEA;--ro:#B3261E;--ro-b:#F2B8B5;" +
  "--ok-f:#E9F6EF;--ok:#146C43;--ok-b:#A8D8BD;--da-f:#FFF4DC;--da:#8A4B00;--da-b:#F0CF8A;" +
  "--ombra:0 1px 2px rgba(16,27,43,.05),0 8px 20px -14px rgba(16,27,43,.20),0 0 0 1px rgba(16,27,43,.03)}" +
  "*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-font-smoothing:antialiased}" +
  "body{margin:0;color:var(--t);font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,system-ui,sans-serif;letter-spacing:-.006em;" +
  "background:radial-gradient(1100px 600px at 100% -10%,rgba(242,106,16,.05),transparent 60%),radial-gradient(900px 600px at -10% 0%,rgba(27,47,74,.06),transparent 60%),#F8FAFC}" +
  "main{max-width:960px;margin:0 auto;padding:16px 16px 48px}" +
  "@media screen and (min-width:760px){main{max-width:min(1600px,calc(100vw - 48px));padding:20px 12px 56px}}" +
  "@media screen and (min-width:900px){main{max-width:min(1600px,calc(100vw - 96px))}}" +
  "svg{display:block}" +
  ".cs-torna{display:inline-block;margin:0 0 12px;padding:6px 14px;border-radius:999px;border:1px solid var(--l);background:var(--c);color:var(--navy);font-weight:600;text-decoration:none}" +
  ".cs-card{position:relative;background:var(--c);border-radius:16px;padding:18px 18px 16px;box-shadow:var(--ombra)}" +
  ".cs-card::before{content:\"\";position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#F26A10);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}" +
  ".cs-testa{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:0 0 14px}" +
  ".cs-cant{margin:0;font-size:.88rem;color:var(--s)}" +
  "h1{display:flex;align-items:center;gap:10px;margin:4px 0 0;font-size:1.5rem;letter-spacing:-.02em;color:var(--navy)}" +
  ".cs-ic{flex:none;width:38px;height:38px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#8A93DB,#5B66C0 45%,#2C3577);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 6px 14px -6px rgba(44,53,119,.65)}" +
  ".cs-ic svg{width:22px;height:22px}" +
  ".cs-prova{display:inline-block;margin:8px 0 0;padding:3px 10px;border:1px dashed var(--pr-b);border-radius:999px;background:var(--pr-f);color:var(--pr-s);font-size:.8rem;font-weight:600}" +
  ".cs-az-testa{display:flex;gap:8px;flex-wrap:wrap}" +
  ".btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:42px;padding:0 16px;border-radius:12px;border:1px solid var(--navy);background:var(--c);color:var(--navy);font:inherit;font-weight:700;font-size:.92rem;text-decoration:none;white-space:nowrap;cursor:pointer;background-image:linear-gradient(180deg,#FFFFFF,#F4F7FA);box-shadow:0 1px 2px rgba(16,27,43,.05)}" +
  ".btn svg{width:17px;height:17px}" +
  ".btn.pr{border-color:var(--pr);color:#fff;background-image:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,.05) 48%,rgba(255,255,255,0) 52%),linear-gradient(180deg,#5560B8,#3F4A9E);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 22px -12px rgba(44,53,119,.8)}" +
  ".btn.pr:disabled{opacity:.6;cursor:wait}" +
  ".btn.sec{border-color:var(--pr);color:var(--pr-s);background-image:none;background-color:var(--pr-f)}" +
  ".btn.sm{min-height:34px;padding:0 12px;font-size:.84rem;border-radius:10px}" +
  ".btn.tenue{border-color:rgba(16,27,43,.16);color:var(--t)}" +
  ".btn.togli{border-color:var(--ro-b);color:var(--ro);background-image:none}" +
  ".btn.rosso{border-color:var(--ro);color:#fff;background-image:none;background-color:var(--ro)}" +
  ".btn:hover,.btn:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(63,74,158,.22)}" +
  ".cs-cifre{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 14px}" +
  ".cs-cifre div{position:relative;border:1px solid var(--l);border-radius:12px;padding:10px 12px 10px 14px;background:var(--c);overflow:hidden}" +
  ".cs-cifre div::before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--navy)}" +
  ".cs-cifre b{display:block;font-size:1.55rem;line-height:1.2;color:var(--navy)}.cs-cifre span{font-size:.82rem;color:var(--s)}" +
  ".cs-cifre .cs-c-pr::before{background:var(--pr)}.cs-cifre .cs-c-pr b{color:var(--pr-s)}" +
  ".cs-cifre .cs-c-da::before{background:#D08A1C}.cs-cifre .cs-c-da b{color:var(--da)}" +
  ".cs-cifre .cs-c-ok::before{background:var(--ok)}.cs-cifre .cs-c-ok b{color:var(--ok)}.cs-cifre .cs-c-gr::before{background:#8A96A3}" +
  ".cs-regole{display:flex;gap:10px;align-items:flex-start;margin:0 0 6px;padding:12px 14px;border-radius:14px;border:1px solid var(--pr-b);background:var(--pr-f);font-size:.9rem;line-height:1.5;color:var(--t)}" +
  ".cs-regole svg{flex:none;width:20px;height:20px;color:var(--pr);margin-top:2px}.cs-regole b{color:var(--pr-s)}" +
  ".cs-cerca{display:flex;gap:10px 14px;align-items:center;flex-wrap:wrap;margin:16px 0 2px}" +
  ".cs-filtri{display:flex;gap:6px;flex-wrap:wrap;flex:1 1 420px}" +
  ".cs-filtri button{padding:6px 12px;border-radius:999px;border:1px solid var(--l);background:var(--c);font:inherit;font-size:.84rem;font-weight:600;color:var(--t);cursor:pointer}" +
  ".cs-filtri button i{font-style:normal;color:var(--s);margin-left:4px}" +
  ".cs-filtri button.on{background:var(--navy);border-color:var(--navy);color:#fff}.cs-filtri button.on i{color:rgba(255,255,255,.75)}" +
  ".cs-campo{display:flex;align-items:center;gap:8px;flex:0 1 320px;min-width:0;min-height:40px;padding:0 12px;border:1px solid rgba(16,27,43,.16);border-radius:12px;background:var(--c)}" +
  ".cs-campo svg{flex:none;width:17px;height:17px;color:var(--s)}.cs-campo input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:.92rem;color:var(--t)}" +
  ".cs-sez{margin:24px 0 0}" +
  ".cs-sez h2{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0 0 10px;padding:0 0 8px;border-bottom:2px solid rgba(63,74,158,.18);font-size:.95rem;letter-spacing:.01em;color:var(--navy)}" +
  ".cs-sez h2 .n{flex:none;width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--pr);color:#fff;font-size:.82rem;letter-spacing:0;box-shadow:0 0 0 2px #fff,0 0 0 3.5px rgba(63,74,158,.35)}" +
  ".cs-sez h2 small{margin-left:auto;font-size:.82rem;font-weight:600;letter-spacing:0;color:var(--s)}" +
  ".cs-tv{display:grid;grid-template-columns:110px minmax(0,1fr) auto;gap:6px 14px;align-items:start;padding:12px 14px;border:1px solid var(--l);border-radius:14px;background:var(--c);box-shadow:0 1px 2px rgba(16,27,43,.04)}" +
  ".cs-tv+.cs-tv{margin-top:10px}.cs-tv.cs-via,.cs-sez.cs-via{display:none}" +
  ".cs-cod{display:flex;flex-direction:column;align-items:flex-start;gap:6px}" +
  ".cs-cod b{display:inline-block;padding:3px 8px;border-radius:8px;border:1.5px solid var(--pr);background:var(--pr-f);color:var(--pr-s);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.84rem;overflow-wrap:anywhere}" +
  ".cs-rev{padding:1px 8px;border-radius:999px;background:var(--navy);color:#fff;font-size:.74rem;font-weight:700}" +
  ".cs-tit{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 3px;font-weight:700;font-size:1rem;overflow-wrap:anywhere}" +
  ".cs-meta{margin:0;font-size:.86rem;line-height:1.55;color:var(--s)}.cs-meta b{color:var(--t);font-weight:600}" +
  ".cs-nota{margin:6px 0 0;padding:6px 10px;border-radius:10px;background:var(--z);font-size:.86rem;line-height:1.45}" +
  ".cs-imp{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.8rem}" +
  ".cs-str{padding:1px 8px;border-radius:999px;border:1px solid #9FB3C8;background:#EEF3F8;color:var(--navy);font-size:.74rem;font-weight:700}" +
  ".cs-lato{display:flex;flex-direction:column;align-items:flex-end;gap:8px}" +
  ".cs-az{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}" +
  ".cs-st{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:.78rem;font-weight:700;line-height:1.7;white-space:nowrap}" +
  ".cs-st.da{border:1px solid var(--da-b);background:var(--da-f);color:var(--da)}.cs-st.ok{border:1px solid var(--ok-b);background:var(--ok-f);color:var(--ok)}" +
  ".cs-st.os{border:1px solid var(--ok-b);background:#F3FAF6;color:#1F6B4A}.cs-st.no{border:1px solid var(--ro-b);background:var(--ro-f);color:var(--ro)}" +
  ".cs-vuoto{display:flex;gap:14px;align-items:center;margin:18px 0 0;padding:18px;border:1.5px dashed var(--pr-b);border-radius:14px;background:var(--pr-f);color:var(--pr-s)}" +
  ".cs-vuoto svg{flex:none;width:34px;height:34px}.cs-vuoto p{margin:0;line-height:1.45}" +
  ".cs-nessuno{margin:16px 0 0;color:var(--s);font-size:.92rem}" +
  ".cs-form{margin-top:26px;padding:16px;border:1px solid var(--pr-b);border-radius:16px;background:linear-gradient(180deg,#F7F8FD,#FFFFFF 60%)}" +
  ".cs-form h3{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 4px;font-size:1.15rem;color:var(--navy)}" +
  ".cs-mini{flex:none;width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--pr);color:#fff}.cs-mini svg{width:17px;height:17px}" +
  ".cs-sotto{margin:0 0 14px;font-size:.88rem;color:var(--s);line-height:1.45}" +
  ".cs-forn{margin:0 0 12px;max-width:520px}" +
  ".cs-drop{display:flex;align-items:center;gap:12px 16px;flex-wrap:wrap;padding:14px;border:2px dashed var(--pr-b);border-radius:14px;background:var(--pr-f);cursor:pointer}" +
  ".cs-drop.sopra{border-color:var(--pr);background:#E2E5F6}" +
  ".cs-scegli{display:flex;align-items:center;gap:10px;font-size:.92rem;color:var(--pr-s);font-weight:600;flex:1 1 300px}.cs-scegli svg{flex:none;width:26px;height:26px}" +
  ".cs-scegli small{display:block;margin-top:2px;font-size:.8rem;font-weight:500;color:var(--s)}" +
  ".cs-fl{margin-top:12px;border:1px solid var(--l);border-radius:14px;background:var(--c);overflow:hidden}" +
  ".cs-fr{display:grid;grid-template-columns:minmax(0,1.3fr) 170px minmax(0,1.4fr) 64px 100px;gap:8px 12px;align-items:center;padding:10px 12px}" +
  ".cs-fr+.cs-fr,#cs-righe .cs-fr{border-top:1px solid var(--l)}" +
  ".cs-th{padding:8px 12px;background:var(--z);font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--s)}" +
  ".cs-fn{display:flex;align-items:center;gap:10px;min-width:0}" +
  ".cs-pdf{flex:none;width:28px;height:34px;border-radius:5px;border:1px solid var(--ro-b);background:#fff;display:flex;align-items:flex-end;justify-content:center;padding-bottom:3px;font-size:.56rem;font-weight:800;color:var(--ro)}" +
  ".cs-nm{min-width:0;font-size:.84rem;font-weight:600;overflow-wrap:anywhere}.cs-nm span{display:block;font-size:.76rem;font-weight:500;color:var(--s)}" +
  ".cs-fr input[type=text],.cs-chi input,.cs-dlg input{width:100%;min-height:36px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;background:var(--c);font:inherit;font-size:.88rem;color:var(--t)}" +
  ".cs-fr input.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}" +
  ".cs-fr input.manca,.cs-chi input.manca{border:2px solid var(--ro);background:var(--ro-f)}.cs-fr input.manca::placeholder{color:var(--ro);opacity:.8}" +
  ".cs-mancano{margin:12px 0 0;padding:10px 12px;border:1px solid var(--ro-b);border-radius:12px;background:var(--ro-f);font-size:.88rem;line-height:1.5;color:#7a1c16}.cs-mancano b{color:var(--ro)}" +
  ".cs-tutte{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin:12px 0 0;padding:10px 12px;border:1px solid var(--pr-b);border-radius:12px;background:#fff}" +
  ".cs-tutte label{font-size:.88rem;font-weight:700;color:var(--navy)}.cs-tutte input{width:110px;min-height:36px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;font-family:ui-monospace,Consolas,monospace;font-size:.88rem}" +
  ".cs-fr .cs-ck{display:flex;align-items:center;gap:6px;font-size:.84rem}.cs-fr .cs-ck input{width:18px;height:18px;accent-color:#3F4A9E}" +
  ".cs-fr .et{display:none}" +
  ".cs-fr.no{background:var(--ro-f)}.cs-fr .cs-esito{grid-column:1/-1;font-size:.86rem;line-height:1.45}" +
  ".cs-fr.no .cs-esito{color:var(--ro);font-weight:600}.cs-fr.ok{background:var(--ok-f)}.cs-fr.ok .cs-esito{color:var(--ok);font-weight:600}" +
  ".cs-chi{margin-top:12px;display:flex;flex-direction:column;gap:4px;max-width:420px}.cs-chi label,.cs-dlg label{font-size:.84rem;font-weight:700;color:var(--navy)}" +
  ".cs-forn.cs-chi{margin-top:0;max-width:520px}" +
  ".cs-arch{display:flex;gap:10px;align-items:flex-start;margin:14px 0 0;padding:10px 12px;border-radius:12px;background:var(--z);font-size:.84rem;line-height:1.45;color:var(--s)}.cs-arch svg{flex:none;width:20px;height:20px;color:var(--pr)}" +
  ".cs-msg{margin:10px 0 0;font-size:.9rem;font-weight:600;color:var(--ro);min-height:1px}" +
  ".cs-form-az{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:14px}" +
  ".cs-fonti{margin:20px 0 0;font-size:.82rem;line-height:1.5;color:var(--s)}" +
  ".cs-dlg{max-width:460px;width:calc(100vw - 32px);border:0;border-radius:16px;padding:18px;box-shadow:0 24px 60px -20px rgba(16,27,43,.45)}" +
  ".cs-dlg::backdrop{background:rgba(16,27,43,.45)}.cs-dlg h3{margin:0 0 8px;color:var(--navy)}.cs-dlg p{margin:0 0 12px;font-size:.9rem;line-height:1.45;color:var(--s)}" +
  ".cs-dlg form{display:flex;flex-direction:column;gap:6px}" +
  // costruttivi-2 (C2): visto di strutturista e DL, avviso di chi manca nel cantiere
  ".cs-visti{display:flex;flex-direction:column;gap:6px;margin:10px 0 0;padding:10px 12px;border:1px solid var(--pr-b);border-radius:12px;background:#FAFBFE}" +
  ".cs-vs-tit{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:.84rem;font-weight:700;color:var(--pr-s)}.cs-vs-tit svg{flex:none;width:17px;height:17px}" +
  ".cs-vs-tit em{font-style:normal}.cs-vs-ok{padding:0 8px;border-radius:999px;background:var(--ok-f);border:1px solid var(--ok-b);color:var(--ok);font-size:.74rem}" +
  ".cs-visti .btn{align-self:flex-start}" +
  ".cs-vs-r{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:.86rem}.cs-vs-r b{min-width:128px;color:var(--t);font-weight:600}" +
  ".cs-vs-st{padding:1px 9px;border-radius:999px;font-size:.76rem;font-weight:700;white-space:nowrap}" +
  ".cs-vs-st.at{border:1px solid var(--da-b);background:var(--da-f);color:var(--da)}.cs-vs-st.ok{border:1px solid var(--ok-b);background:var(--ok-f);color:var(--ok)}" +
  ".cs-vs-st.os{border:1px solid #F0CF8A;background:#FFF8E8;color:#7A4A00}" +
  ".cs-vs-q{color:var(--s);font-size:.82rem}.cs-vs-nota{flex-basis:100%;margin:2px 0 0;padding:6px 10px;border-radius:10px;background:#FFF8E8;white-space:pre-wrap;font-size:.86rem;line-height:1.45}" +
  ".cs-manca{display:flex;gap:10px;align-items:flex-start;margin:6px 0 0;padding:12px 14px;border-radius:14px;border:1px solid var(--da-b);background:var(--da-f);font-size:.9rem;line-height:1.5;color:var(--t)}" +
  ".cs-manca svg{flex:none;width:22px;height:22px;color:var(--da);margin-top:1px}.cs-manca b{color:var(--da)}.cs-manca-az{margin:8px 0 0}" +
  // costruttivi-3 (C3a): firma
  ".btn.pr:disabled{opacity:.45;cursor:not-allowed}.cs-attesa-firma{margin:8px 0 0;font-size:.82rem;color:var(--s)}.cs-regole a{color:var(--pr-s);font-weight:700}" +
  "@media (max-width:1100px){.cs-fr{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.cs-th{display:none}.cs-fr .cs-fn{grid-column:1/-1}.cs-fr .c-tit{grid-column:1/-1}" +
  ".cs-fr .et{display:block;font-size:.7rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--s);margin-bottom:3px}}" +
  "@media (max-width:680px){main{padding:14px 16px 40px}.cs-card{padding:16px 14px 14px}h1{font-size:1.35rem}" +
  ".cs-az-testa{width:100%}.cs-az-testa .btn{flex:1 1 auto}.cs-cifre{grid-template-columns:repeat(2,minmax(0,1fr))}.cs-campo{flex:1 1 100%}" +
  ".cs-tv{grid-template-columns:minmax(0,1fr) auto}.cs-tv .cs-cod{flex-direction:row;align-items:center;grid-column:1;grid-row:1}" +
  ".cs-tv .cs-lato{display:contents}.cs-tv .cs-st{grid-column:2;grid-row:1;justify-self:end;white-space:normal;text-align:right}.cs-tv .cs-corpo{grid-column:1/-1}" +
  ".cs-tv .cs-az{grid-column:1/-1;justify-content:flex-start}.cs-sez h2 small{flex-basis:100%;margin-left:36px}.cs-form-az .btn{flex:1 1 auto}}";

const SCRIPT = String.raw`(function(){try{
var D=document;function $(i){return D.getElementById(i);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function leggiChi(){try{return localStorage.getItem('tix_pg_chi')||'';}catch(e){return '';}}
function scriviChi(v){try{if(v)localStorage.setItem('tix_pg_chi',v);}catch(e){}}
function mb(n){n=Number(n)||0;if(n>=1048576)return (Math.round(n/104857.6)/10).toString().replace('.',',')+' MB';return Math.max(1,Math.round(n/1024))+' KB';}
function b64url(s){var u=unescape(encodeURIComponent(s));return btoa(u).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function esa(buf){return Array.prototype.map.call(new Uint8Array(buf),function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
// ---- dal nome del file: codice, revisione, titolo e «Riguarda le strutture» (stesse regole dei Progetti)
function leggiNome(n){var base=String(n||'').replace(/\.(pdf|p7m)$/i,'').replace(/\.(pdf)$/i,'');var rev='',cod='',tit=base,nuovo=false;
var ms=base.match(/^([A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*)[\s_\-.]+(\d{1,3})([A-Za-z])?(?=$|[\s_\-.])[\s_\-.]*(.*)$/);
if(ms&&ms[1].length>=4&&/\d/.test(ms[1])&&!/(?:^|[\s_.\-(])rev(?:isione)?[\s_.\-]*[A-Za-z0-9]/i.test(base)){cod=ms[1].toUpperCase()+'_'+ms[2];rev=(ms[3]||'').toUpperCase();tit=ms[4]||'';nuovo=true;}
if(!nuovo){
var mr=base.match(/(?:^|[\s_.\-(])rev(?:isione)?[\s_.\-]*([A-Za-z0-9]{1,3})(?=$|[\s_.\-)])/i);if(mr){rev=mr[1].toUpperCase();tit=tit.replace(mr[0],' ');}
var mc=tit.match(/^\s*([A-Za-z]{1,5}[\s_\-.]?\d{1,4}[A-Za-z]?)(?=$|[\s_\-.])/);if(mc){cod=mc[1].toUpperCase().replace(/[\s_.]/,'-');tit=tit.slice(mc[0].length);}}
tit=tit.replace(/[_]+/g,' ').replace(/\s*[-–]\s*$/,'').replace(/^\s*[-–.]\s*/,'').replace(/\s{2,}/g,' ').trim();
var p=nuovo?'':cod.replace(/[^A-Z]/g,'');var l=base.toLowerCase();
var str=/^(STR|S|ST|CA|CLS|FOND|CARP|CM)$/.test(p)||/struttur|carpenteri|armatur|travi|pilastr|solai|fondazion|capriat|lamellar|tirant|ancoragg|orditur/.test(l);
return {codice:cod,revisione:rev,titolo:tit,strutture:str};}
window.__csLeggiNome=leggiNome;
// ---- filtri e ricerca
var filtro='';var q=$('cs-q');
function applica(){var t=(q&&q.value||'').toLowerCase().trim();var vis=0;
D.querySelectorAll('.cs-tv').forEach(function(el){var ok=(!filtro||(filtro==='strutture'?el.getAttribute('data-str')==='1':filtro==='visto'?el.getAttribute('data-vis')==='1':el.getAttribute('data-stato')===filtro))&&(!t||el.getAttribute('data-q').indexOf(t)!==-1);el.classList.toggle('cs-via',!ok);if(ok)vis++;});
D.querySelectorAll('.cs-sez').forEach(function(s){s.classList.toggle('cs-via',!s.querySelector('.cs-tv:not(.cs-via)'));});
var n=$('cs-nessuno');if(n)n.hidden=vis>0||!D.querySelector('.cs-tv');}
D.querySelectorAll('.cs-filtri button[data-f]').forEach(function(b){b.addEventListener('click',function(){filtro=b.getAttribute('data-f')||'';D.querySelectorAll('.cs-filtri button[data-f]').forEach(function(x){x.classList.toggle('on',x===b);});applica();});});
if(q)q.addEventListener('input',applica);
// ---- caricamento
var inp=$('cs-file'),drop=$('cs-drop'),righe=$('cs-righe'),forn=$('cs-forn'),FILE=[];
function vuoto(v){return !String(v||'').trim();}
function mancano(){var n=FILE.filter(function(f){return !f.no&&!f.ok&&(vuoto(f.codice)||vuoto(f.revisione));}).length;var a=$('cs-mancano');
if(a){a.hidden=!n;a.innerHTML=n?'<b>'+(n===1?'In 1 costruttivo manca':'In '+n+' costruttivi mancano')+' il codice o la revisione</b> (i campi in rosso). Codice = il numero del disegno scritto nel cartiglio, per esempio <b>COP-01</b>; revisione = la lettera o il numero della revisione, per esempio <b>A</b>. Se la revisione è la stessa per tutti, usa «Stessa revisione per tutti».':'';}return n;}
function disegna(){if(!righe)return;$('cs-fl').hidden=!FILE.length;$('cs-az').hidden=!FILE.length;$('cs-chi-box').hidden=!FILE.length;if($('cs-tutte'))$('cs-tutte').hidden=FILE.filter(function(f){return !f.no&&!f.ok;}).length<2;
var buoni=FILE.filter(function(f){return !f.no&&!f.ok;}).length;$('cs-salva').textContent=buoni===1?'Salva 1 costruttivo':'Salva '+buoni+' costruttivi';$('cs-salva').disabled=!buoni;
righe.innerHTML=FILE.map(function(f,i){var ext=(String(f.file.name).match(/\.([A-Za-z0-9]{1,4})$/)||['',''])[1].toUpperCase()||'FILE';var testa='<div class="cs-fn"><span class="cs-pdf">'+esc(ext)+'</span><span class="cs-nm">'+esc(f.file.name)+'<span>'+mb(f.file.size)+'</span></span></div>';
if(f.no)return '<div class="cs-fr no">'+testa+'<div class="cs-esito">'+esc(f.no)+'</div></div>';
if(f.ok)return '<div class="cs-fr ok">'+testa+'<div class="cs-esito">'+esc(f.ok)+'</div></div>';
return '<div class="cs-fr" data-i="'+i+'">'+testa+
'<div><span class="et">Codice</span><input type="text" class="mono'+(vuoto(f.codice)?' manca':'')+'" data-k="codice" maxlength="60" value="'+esc(f.codice)+'" placeholder="es. COP-01" aria-label="Codice"></div>'+
'<div class="c-tit"><span class="et">Titolo</span><input type="text" data-k="titolo" maxlength="200" value="'+esc(f.titolo)+'" placeholder="es. Copertura in legno lamellare" aria-label="Titolo"></div>'+
'<div><span class="et">Revisione</span><input type="text" class="mono'+(vuoto(f.revisione)?' manca':'')+'" data-k="revisione" maxlength="30" value="'+esc(f.revisione)+'" placeholder="es. A" aria-label="Revisione"></div>'+
'<div><span class="et">Strutture</span><label class="cs-ck"><input type="checkbox" data-k="strutture"'+(f.strutture?' checked':'')+'> Sì</label></div>'+
(f.err?'<div class="cs-esito" style="color:#B3261E;font-weight:600">'+esc(f.err)+'</div>':'')+'</div>';}).join('');mancano();}
function aggiungi(lista){Array.prototype.forEach.call(lista||[],function(file){var f={file:file,strutture:false};
if(!/\.(pdf|p7m)$/i.test(file.name))f.no='Questo file non è un PDF: carica il costruttivo in PDF, anche firmato digitalmente (.p7m). I file DWG per ora TIX non li legge.';
else if(file.size>CFG.max)f.no='Questo file pesa '+mb(file.size)+': il massimo è '+CFG.maxMb+' MB. Chiedi al fornitore il PDF salvato dal programma di disegno, oppure dividilo in più file.';
else if(!file.size)f.no='Il file è vuoto.';
else{var g=leggiNome(file.name);f.codice=g.codice;f.revisione=g.revisione;f.titolo=g.titolo;f.strutture=g.strutture;}
FILE.push(f);});disegna();var c=$('cs-chi');if(c&&!c.value)c.value=leggiChi();$('cs-msg').textContent='';}
if(inp)inp.addEventListener('change',function(){aggiungi(inp.files);inp.value='';});
if(drop){['dragenter','dragover'].forEach(function(t){drop.addEventListener(t,function(ev){ev.preventDefault();drop.classList.add('sopra');});});
['dragleave','drop'].forEach(function(t){drop.addEventListener(t,function(ev){ev.preventDefault();drop.classList.remove('sopra');});});
drop.addEventListener('drop',function(ev){if(ev.dataTransfer)aggiungi(ev.dataTransfer.files);});}
if(forn)forn.addEventListener('input',function(){forn.classList.toggle('manca',false);});
if(righe){righe.addEventListener('input',function(ev){var el=ev.target,r=el.closest('[data-i]');if(!r)return;var f=FILE[+r.getAttribute('data-i')];var k=el.getAttribute('data-k');if(!f||!k)return;f[k]=el.type==='checkbox'?el.checked:el.value;
if(k==='codice'||k==='revisione'){el.classList.toggle('manca',vuoto(el.value));mancano();}});
righe.addEventListener('change',function(ev){var el=ev.target,r=el.closest('[data-i]');if(!r)return;var f=FILE[+r.getAttribute('data-i')];var k=el.getAttribute('data-k');if(!f||!k)return;f[k]=el.type==='checkbox'?el.checked:el.value;});}
if($('cs-rev-applica'))$('cs-rev-applica').addEventListener('click',function(){var v=$('cs-rev-tutte').value.trim();if(!v){$('cs-rev-tutte').focus();return;}
FILE.forEach(function(f){if(!f.no&&!f.ok)f.revisione=v;});disegna();});
if($('cs-annulla'))$('cs-annulla').addEventListener('click',function(){FILE=[];disegna();$('cs-msg').textContent='';});
function manda(f,chi,fornitore){return f.file.arrayBuffer().then(function(buf){return crypto.subtle.digest('SHA-256',buf).then(function(h){
var dati={t:CFG.t,c:CFG.c,fornitore:fornitore,codice:String(f.codice||'').trim(),titolo:String(f.titolo||'').trim(),revisione:String(f.revisione||'').trim(),strutture:!!f.strutture,autore:chi,nome:f.file.name,byte:buf.byteLength,sha256:esa(h)};
return fetch(CFG.u+'/carica',{method:'POST',headers:{'X-Costruttivi-Dati':b64url(JSON.stringify(dati)),'Content-Type':'application/octet-stream'},body:buf}).then(function(r){return r.json().catch(function(){return {esito:'errore'};});});});});}
var salvati=0;
if($('cs-salva'))$('cs-salva').addEventListener('click',function(){var b=$('cs-salva'),m=$('cs-msg'),chi=$('cs-chi').value.trim(),fornitore=forn?forn.value.trim():'';
if(!fornitore){m.textContent='Scegli o scrivi il fornitore: è la ditta che ti ha mandato i costruttivi.';if(forn){forn.classList.add('manca');forn.focus();}return;}
if(!chi){m.textContent='Scrivi il tuo nome: resta scritto chi ha caricato i costruttivi.';$('cs-chi').focus();return;}
var da=FILE.filter(function(f){return !f.no&&!f.ok;});
if(mancano()){m.textContent='Prima di salvare scrivi codice e revisione nei campi in rosso (vedi il riquadro sopra l\'elenco).';var pr=righe.querySelector('input.manca');if(pr)pr.focus();return;}
scriviChi(chi);b.disabled=true;m.textContent='';var i=0;
(function prossimo(){if(i>=da.length){b.disabled=false;disegna();if(salvati&&!FILE.some(function(f){return !f.no&&!f.ok;})){m.style.color='#146C43';m.textContent='Fatto. Aggiorno la pagina…';setTimeout(function(){location.reload();},900);}return;}
var f=da[i++];b.textContent='Salvo '+i+' di '+da.length+'…';f.err='';
manda(f,chi,fornitore).then(function(r){if(r&&r.esito==='ok'){salvati++;f.ok='Salvato: '+f.codice+' rev. '+f.revisione+' di '+fornitore+', da approvare'+(r.superate?' · la revisione di prima ora è «Superata»':'');}
else f.err=(r&&r.messaggio)||'Non si è salvato: riprova.';}).catch(function(){f.err='Non si è salvato: controlla la connessione e riprova.';}).then(prossimo);})();});
// ---- togli (solo «Da approvare»)
var dlg=$('cs-dlg'),corr=null;
D.querySelectorAll('[data-togli]').forEach(function(b){b.addEventListener('click',function(){corr=b.getAttribute('data-togli');$('cs-dlg-cod').textContent=b.getAttribute('data-cod')||'';$('cs-dlg-chi').value=leggiChi();$('cs-dlg-mot').value='';$('cs-dlg-msg').textContent='';$('cs-dlg-si').disabled=false;
if(dlg&&typeof dlg.showModal==='function')dlg.showModal();else if(dlg)dlg.setAttribute('open','');});});
if($('cs-dlg-si'))$('cs-dlg-si').addEventListener('click',function(){var chi=$('cs-dlg-chi').value.trim(),m=$('cs-dlg-msg');if(!chi){m.textContent='Scrivi il tuo nome.';return;}scriviChi(chi);
this.disabled=true;var self=this;fetch(CFG.u+'/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:'annulla',id:corr,dati:{chi:chi,motivo:$('cs-dlg-mot').value.trim()}})})
.then(function(r){return r.json();}).then(function(r){if(r&&r.esito==='ok'){location.reload();return;}self.disabled=false;m.textContent=(r&&r.messaggio)||'Non è andata: riprova.';}).catch(function(){self.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
// ---- firma per approvazione (costruttivi-3, fase C3a): il firmatore comune si carica solo quando serve
function firmatore(){return window.TIXFirma?Promise.resolve(window.TIXFirma):new Promise(function(ok,ko){var s=D.createElement('script');s.src=CFG.b+'/firma/firma-tix.js';s.onload=function(){window.TIXFirma?ok(window.TIXFirma):ko(new Error('firma'));};s.onerror=function(){ko(new Error('firma'));};D.head.appendChild(s);});}
D.querySelectorAll('[data-firma]').forEach(function(b){b.addEventListener('click',function(){var id=b.getAttribute('data-firma');b.disabled=true;
firmatore().then(function(F){b.disabled=false;F.apri({base:CFG.b,t:CFG.t,c:CFG.c,tipo:'progetto_costruttivo',rif_id:id,pdf:CFG.u+'/file?t='+CFG.t+'&c='+CFG.c+'&id='+id,
impostazioni:CFG.b+'/firma/impostazioni?t='+CFG.t+'&c='+CFG.c+'&da=costruttivi',onFatto:function(){location.reload();}});})
.catch(function(){b.disabled=false;alert('Il firmatore non si carica: controlla la connessione e riprova.');});});});
// ---- chiedi il visto di strutturista e DL (costruttivi-2, fase C2)
var vdlg=$('cs-vs-dlg'),vId='';
D.querySelectorAll('[data-visto]').forEach(function(b){b.addEventListener('click',function(){if(!vdlg)return;vId=b.getAttribute('data-visto');$('cs-vs-cod').textContent=b.getAttribute('data-cod')||'';$('cs-vs-chi').value=leggiChi();$('cs-vs-msg').textContent='';$('cs-vs-si').disabled=false;
if(typeof vdlg.showModal==='function')vdlg.showModal();else vdlg.setAttribute('open','');});});
if($('cs-vs-si'))$('cs-vs-si').addEventListener('click',function(){var chi=$('cs-vs-chi').value.trim(),m=$('cs-vs-msg');m.textContent='';if(!chi){m.textContent='Scrivi il tuo nome: resta scritto chi ha chiesto il visto.';$('cs-vs-chi').focus();return;}scriviChi(chi);
var self=this;self.disabled=true;fetch(CFG.u+'/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:'visto_chiedi',id:vId,dati:{chi:chi}})})
.then(function(r){return r.json();}).then(function(r){if(r&&r.esito==='ok'){location.reload();return;}self.disabled=false;m.textContent=(r&&r.messaggio)||(r&&r.esito==='spento'?'Il visto non è disponibile.':'Non è andata: riprova.');}).catch(function(){self.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
}catch(err){}})();`;

// Solo per il banco di prova locale (pagina con dati inventati, senza database): stessa pagina della rotta vera.
export function costruttiviPaginaProva(base, h, p, d) {
  return pagina(base, h, p, d, base + "/?t=" + p.tok + "&c=" + p.c);
}
