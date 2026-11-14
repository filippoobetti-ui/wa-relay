// ============================================================================
// OFFERTE DEI FORNITORI — area riservata (09/11/2026, offerte-1, fase O1). Sezione a parte della pagina del cantiere (scelte di
// Filippo del 09/11/2026): le offerte di materiale dei cantieri aperti (calcestruzzo, ferro, laterizi, noli…). Per ogni offerta:
// PDF o foto con impronta SHA-256, fornitore (dalla Rubrica o scritto a mano), materiale, descrizione, numero, data, «valida fino
// al», note e, se servono, le righe dei prezzi (+ IVA). Stati: «Da decidere» → «Accettata» / «Non scelta» (si cambiano, con nome e
// storico); «Scaduta» si calcola dalla validità. Le offerte dello stesso materiale stanno una accanto all'altra e il prezzo più
// basso della stessa voce è segnato. La vedono SOLO le persone dell'impresa con l'accesso all'app (gettoni di dashboard_accessi,
// mai l'Area professionisti, mai WhatsApp). Copia su Drive 30 minuti dopo il caricamento (scenario Make a parte).
//   GET  /offerte?t=<gettone>&c=<cantiere>        → pagina (database: offerte_contesto)
//   POST /offerte/carica   corpo = 8 cifre con la lunghezza del JSON + JSON {t, c, fornitore, materiale, descrizione, numero, data,
//                          valida_fino, note, autore, nome, byte, sha256, righe:[{descrizione, unita, prezzo, note}]} + il file
//                          (PDF, .p7m, JPG o PNG, fino a progetti_max_mb). Il JSON sta nel corpo e non in un'intestazione: le righe
//                          dei prezzi possono essere tante.
//   POST /offerte/azione   {t, c, azione: "stato" | "modifica" | "righe" | "togli", id, dati}
//   GET  /offerte/file?t=…&c=…&id=…[&scarica=1]   → il file dell'offerta
//   POST /offerte/leggi    (10/11/2026, offerte-2, fase O2a) LETTURA AUTOMATICA con l'IA: stesso corpo del caricamento (8 cifre + JSON
//                          {t, c, nome, byte, sha256} + il file) per il file appena scelto, oppure JSON {t, c, id} per un'offerta già
//                          caricata. Il relay manda il PDF o la foto a Claude (API Anthropic, chiave ANTHROPIC_API_KEY del Worker) e
//                          restituisce la PROPOSTA dei campi: la pagina li riempie segnati «da controllare»; non si salva niente da solo.
//                          Prima offerte_lettura_controlla (accesso, offerte_ia_attiva, letture del mese, tetto), dopo offerte_lettura_registra.
//                          La lettura vera la fa il lettore comune src/lettore-offerte.js (usato anche dalle Richieste di offerta dei Preventivi).
// Interruttori: impostazioni.offerte_attiva (no / prova = solo l'accesso «Tutte le aziende» / si) e OFFERTE = "off";
// lettura automatica: impostazioni.offerte_ia_attiva e OFFERTE_IA = "off".
// ============================================================================

import { leggiOffertaFornitore, pulisciPropostaOfferta } from "./lettore-offerte.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERIFICA_MAX = 5 * 1024 * 1024;   // il Worker ricalcola l'impronta solo fino a 5 MB
const JSON_MAX = 60000;                 // dati dell'offerta nel corpo del caricamento

function supabaseUrl(env) {
  return env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co";
}
function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: {
    "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
function lista(a) { return Array.isArray(a) ? a : []; }
function testo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function testoLungo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function casuale(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function esadecimale(buf) { return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join(""); }
function percorsoStorage(p) { return String(p).split("/").map(encodeURIComponent).join("/"); }
function parametri(inUrl) {
  const s = inUrl.searchParams;
  const m = String(s.get("t") || "").match(/[0-9a-fA-F]{64}/);
  const c = String(s.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  return { tok: m ? m[0].toLowerCase() : "", c };
}
function dataIso(x) { const s = String(x || "").trim(); return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) ? s : ""; }
function dataIt(iso) { return /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(String(iso || "")) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : ""; }
function quando(ts) {   // "2026-11-09T18:20" → "09/11/2026 alle 18:20"
  const s = String(ts || "");
  return dataIt(s) + (/T[0-9]{2}:[0-9]{2}/.test(s) ? " alle " + s.slice(11, 16) : "");
}
function giorni(da, a) {   // giorni tra due date ISO (a - da)
  const x = Date.parse(da + "T00:00:00Z"), y = Date.parse(a + "T00:00:00Z");
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : null;
}
function mb(n) {
  const x = Number(n) || 0;
  if (x >= 1048576) return (Math.round(x / 104857.6) / 10).toString().replace(".", ",") + " MB";
  return Math.max(1, Math.round(x / 1024)) + " KB";
}
function euro(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  const dec = Math.round(x * 10000) % 100 ? 4 : 2;
  const s = x.toFixed(dec).replace(/0{1,2}$/, (m) => (dec === 4 ? "" : m));
  const [i, d] = s.split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (d ? "," + d : "") + " €";
}
function righePulite(a) {
  return lista(a).slice(0, 60).map((r) => {
    const o = r && typeof r === "object" ? r : {};
    // la pagina manda già il prezzo con il punto decimale (i punti delle migliaia li toglie lei): qui niente altre pulizie,
    // altrimenti 1,045 €/kg diventerebbe 1045
    const p = String(o.prezzo == null ? "" : o.prezzo).trim().replace(/\s+/g, "").replace(",", ".");
    return { descrizione: testo(o.descrizione, 300), unita: testo(o.unita, 20), prezzo: /^[0-9]{1,7}(\.[0-9]{1,4})?$/.test(p) ? p : "", note: testo(o.note, 300) };
  }).filter((r) => r.descrizione);
}

// ---------------------------------------------------------------------------- pulsante nella pagina del cantiere
// Chiamata fatta da index.js insieme a dashboard_html: qualsiasi errore o attesa oltre 8 secondi = nessun pulsante.
export async function offertePulsante(env, token, commessa) {
  if (!env || !env.SUPABASE_SERVICE_KEY || env.OFFERTE === "off") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(supabaseUrl(env) + "/rest/v1/rpc/offerte_pulsante", {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_token: token, p_commessa: commessa }), signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j !== "object" || j.esito !== "ok" || j.attiva !== true) return null;
    return { attiva: true, modo: String(j.modo || ""), offerte: Math.max(0, Math.min(9999, Number(j.offerte) || 0)),
      da_decidere: Math.max(0, Math.min(999, Number(j.da_decidere) || 0)) };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Ottavo pulsante della riga dei pulsanti del cantiere, subito dopo «Costruttivi» (o dopo «Progetti» se i Costruttivi non ci sono).
// index.js mette questo script DOPO quelli di Progetti e Costruttivi nella catena: a ogni giro (subito, 0, 60, 150, 400 ms e al
// caricamento) si rimette dopo di loro. Da solo, se la riga non c'è, va accanto a loro sotto le schede.
export function offerteIniezione(base, token, commessa, daDecidere) {
  const u = base + "/offerte?t=" + token + "&c=" + encodeURIComponent(commessa);
  const n = Math.max(0, Math.min(999, Number(daDecidere) || 0));
  const icona = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';
  const etichetta = icona + " Offerte ricevute" + (n ? ' <span class="gl-of-n" title="Da decidere">' + n + "</span>" : "");
  return "<style>.gl-of-barra{max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right}" +
    ".gl-of-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 16px;border:1.5px solid #66741C;border-radius:10px;background:#F3F5E6;color:#4E5915;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none;box-shadow:0 0 0 3px rgba(102,116,28,.14)}" +
    ".gl-of-b:hover,.gl-of-b:focus-visible{background:#66741C;color:#fff;outline:none}" +
    ".gl-of-n{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#B45309;color:#fff;font-size:.74rem;font-weight:800}" +
    ".gl-pg-barra .gl-of-b,.gl-cs-barra .gl-of-b,.gl-of-barra .gl-pg-b,.gl-of-barra .gl-cs-b{margin-left:8px}" +
    // con otto pulsanti: 4 colonne sul computer (due righe), 2 fino a 900 px, 1 sul telefono
    ".gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8{grid-template-columns:repeat(4,minmax(0,1fr))}" +
    "@media (max-width:900px){.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
    "@media (max-width:640px){.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8{grid-template-columns:minmax(0,1fr)}}" +
    "@media (prefers-color-scheme:dark){.gl-of-b{background:#2a2f14;color:#e3e8c4;border-color:#9AA84A}}</style>" +
    "<script>(function(){try{var a=document.createElement('a');a.className='gl-of-b';a.href=" + JSON.stringify(u) + ";a.innerHTML=" + JSON.stringify(etichetta) + ";" +
    "function metti(){var r=document.querySelector('.gl-azioni');" +
    "if(r){var prima=r.querySelector('.gl-cs-b')||r.querySelector('.gl-pg-b');if(prima){if(prima.nextElementSibling!==a)r.insertBefore(a,prima.nextSibling);}else if(r.lastElementChild!==a)r.appendChild(a);" +
    "var v=document.querySelector('.gl-of-barra');if(v&&!v.children.length&&v.parentNode)v.parentNode.removeChild(v);" +
    "var n=r.children.length;r.classList.toggle('gl-az4',n===4);r.classList.toggle('gl-az5',n>=5);r.classList.toggle('gl-az6',n>=6);r.classList.toggle('gl-az7',n>=7);r.classList.toggle('gl-az8',n>=8);return;}" +
    "var pb=document.querySelector('.gl-cs-barra')||document.querySelector('.gl-pg-barra');if(pb){if(pb.lastElementChild!==a)pb.appendChild(a);return;}" +
    "if(a.parentNode)return;var b=document.createElement('div');b.className='gl-of-barra';b.appendChild(a);var nav=document.querySelector('nav.schede');" +
    "if(nav&&nav.parentNode){nav.parentNode.insertBefore(b,nav.nextSibling);}else{document.body.insertBefore(b,document.body.firstChild);}}" +
    "metti();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',metti);setTimeout(metti,0);setTimeout(metti,60);setTimeout(metti,150);setTimeout(metti,400);" +
    "window.addEventListener('load',metti);}catch(e){}})();</script>";
}

// ---------------------------------------------------------------------------- rotte
export async function portaleOfferte(request, env, base, inUrl, h) {
  if (env.OFFERTE === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");
  if (sotto === "/offerte/carica") return carica(request, env, h);
  if (sotto === "/offerte/azione") return azione(request, env, h);
  if (sotto === "/offerte/file") return apriFile(request, env, base, inUrl, h);
  if (sotto === "/offerte/leggi") return leggi(request, env, h);
  if (sotto !== "/offerte") return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const p = parametri(inUrl);
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!UUID.test(p.c)) return Response.redirect(inUrl.origin + base + "/?t=" + p.tok, 303);
  const torna = base + "/?t=" + p.tok + "&c=" + p.c;
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>';
  const d = await h.rpc(env, "offerte_contesto", { p_token: p.tok, p_commessa: p.c }, 20000).catch(() => null);
  if (!d || typeof d !== "object") return h.risposta(h.foglio(base, "Offerte ricevute dai fornitori", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Offerte ricevute dai fornitori", "Questa pagina non è disponibile per questo cantiere.", indietro), 404);
  // offerte-3 (14/11/2026): «Chiedi un preventivo a un fornitore» porta alla rotta /preventivi/richiedi della B3; il pulsante c'è solo
  // se i Preventivi sono accesi per questo accesso (preventivi_pulsante); qualsiasi errore = nessun pulsante, la pagina si apre lo stesso
  const pv = await h.rpc(env, "preventivi_pulsante", { p_token: p.tok, p_commessa: p.c }, 8000).catch(() => null);
  d.chiedi = !!(pv && typeof pv === "object" && pv.esito === "ok" && pv.attiva === true);
  return h.risposta(pagina(base, h, p, d, torna));
}

// ---------------------------------------------------------------------------- caricamento (un file per richiesta)
function tipoDaiByte(b) {
  if (!b || b.length < 8) return "";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x30) return "p7m";
  const testa = String.fromCharCode.apply(null, Array.from(b.subarray(0, 1024)));
  return testa.indexOf("%PDF-") !== -1 ? "pdf" : "";
}
const MIME = { pdf: "application/pdf", p7m: "application/pkcs7-mime", jpg: "image/jpeg", png: "image/png" };

async function carica(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  const dichiarati = Number(request.headers.get("Content-Length") || 0);
  if (dichiarati && dichiarati > 60 * 1048576) return json({ esito: "grande", messaggio: "Il file è troppo grande." }, 413);
  const tutto = new Uint8Array(await request.arrayBuffer());
  if (tutto.length < 10) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const lunTesto = String.fromCharCode.apply(null, Array.from(tutto.subarray(0, 8)));
  if (!/^[0-9]{8}$/.test(lunTesto)) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const lun = Number(lunTesto);
  if (!lun || lun > JSON_MAX || 8 + lun >= tutto.length) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  let d = null;
  try { d = JSON.parse(new TextDecoder().decode(tutto.subarray(8, 8 + lun))); } catch (e) { d = null; }
  if (!d || typeof d !== "object") return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c)) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const bytes = tutto.subarray(8 + lun);
  const nome = testo(d.nome, 200).replace(/[\\/]+/g, " ");
  const byte = Number(d.byte);
  const sha = String(d.sha256 || "").toLowerCase();
  const dati = {
    fornitore: testo(d.fornitore, 120), materiale: testo(d.materiale, 80), descrizione: testo(d.descrizione, 300), numero: testo(d.numero, 60),
    data: dataIso(d.data), valida_fino: dataIso(d.valida_fino), note: testoLungo(d.note, 1000), autore: testo(d.autore, 120),
    nome, byte, sha256: sha, righe: righePulite(d.righe)
  };
  if (!Number.isFinite(byte) || byte <= 0 || !bytes.length) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length !== byte) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  // prima l'accesso, l'interruttore, il cantiere aperto e la misura: chi non può caricare non scrive niente nell'archivio
  const ctl = await h.rpc(env, "offerte_carica_controlla", { p_token: tok, p_commessa: c,
    p_dati: { fornitore: dati.fornitore, materiale: dati.materiale, nome, byte } }, 10000).catch(() => null);
  if (!ctl || typeof ctl !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 502);
  if (ctl.esito !== "ok") return json(ctl, ctl.esito === "gettone" ? 403 : 200);
  const cartella = "documenti/" + c + "/offerte/";
  const est = MIME[ctl.est] ? ctl.est : "";
  const max = Number(ctl.max_byte) || 0;
  if (ctl.cartella !== cartella || !est || !max) return json({ esito: "errore", messaggio: "Richiesta non valida: ricarica la pagina." }, 502);
  if (bytes.length > max) return json({ esito: "grande", messaggio: "Il file è troppo grande: in TIX un'offerta arriva fino a " + Math.round(max / 1048576) + " MB." }, 413);
  if (!/^[0-9a-f]{64}$/.test(sha)) return json({ esito: "errore", messaggio: "Manca l'impronta del file: ricarica la pagina e riprova." }, 400);
  const vero = tipoDaiByte(bytes);
  if (vero !== est) {
    const atteso = { pdf: "un PDF", p7m: "un PDF firmato (.p7m) nel formato binario", jpg: "una foto JPG", png: "un'immagine PNG" }[est];
    return json({ esito: "formato", messaggio: "Il file non sembra " + atteso + ": controlla di aver scelto quello giusto." }, 415);
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
      headers: { Authorization: "Bearer " + svc, apikey: svc, "Content-Type": MIME[est], "x-upsert": "false" },
      body: bytes, signal: ctrl.signal
    });
    if (!up.ok) return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } catch (e) {
    await togli(env, percorso, c);
    return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } finally {
    clearTimeout(timer);
  }
  const r = await h.rpc(env, "offerte_registra", { p_token: tok, p_commessa: c,
    p_dati: Object.assign({}, dati, { byte: bytes.length, percorso }) }, 15000).catch(() => null);
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Non so se l'offerta è stata registrata: ricarica la pagina prima di riprovare." }, 502);
  if (r.esito !== "ok") {
    await togli(env, percorso, c);
    return json(r, r.esito === "gettone" ? 403 : 200);
  }
  return json({ esito: "ok", id: r.id, righe: r.righe });
}

// Toglie dall'archivio una copia di questo cantiere appena caricata (mai altro).
async function togli(env, percorso, c) {
  const p = String(percorso || "");
  if (!UUID.test(c) || !new RegExp("^documenti/" + c + "/offerte/[0-9]{8}-[0-9a-f]{12}\\.(pdf|p7m|jpg|png)$").test(p)) return false;
  try {
    const r = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(p), {
      method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } });
    return r.ok;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------- azioni sulle offerte
async function azione(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  if (Number(request.headers.get("Content-Length") || 0) > 60000) return json({ esito: "richiesta_non_valida" }, 413);
  let d = null;
  try { d = await request.json(); } catch (e) { d = null; }
  if (!d || typeof d !== "object") return json({ esito: "richiesta_non_valida" }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const id = String(d.id || "").toLowerCase();
  const a = String(d.azione || "");
  const x = d.dati && typeof d.dati === "object" && !Array.isArray(d.dati) ? d.dati : {};
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(id) || ["stato", "modifica", "righe", "togli"].indexOf(a) === -1) return json({ esito: "richiesta_non_valida" }, 400);
  let dati = { chi: testo(x.chi, 120) };
  if (a === "stato") dati.stato = ["ricevuta", "accettata", "non_scelta"].indexOf(String(x.stato)) !== -1 ? String(x.stato) : "";
  if (a === "modifica") {
    dati = Object.assign(dati, { fornitore: testo(x.fornitore, 120), materiale: testo(x.materiale, 80), descrizione: testo(x.descrizione, 300),
      numero: testo(x.numero, 60), data: dataIso(x.data), valida_fino: dataIso(x.valida_fino), note: testoLungo(x.note, 1000) });
  }
  if (a === "righe") dati.righe = righePulite(x.righe);
  if (a === "togli") dati.motivo = testo(x.motivo, 300);
  const r = await h.rpc(env, "offerte_azione", { p_token: tok, p_id: id, p_azione: a, p_dati: dati }, 15000).catch(() => null);
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 503);
  return json(r, r.esito === "gettone" ? 403 : 200);
}

// ---------------------------------------------------------------------------- apertura del file
async function apriFile(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const p = parametri(inUrl);
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  const scarica = inUrl.searchParams.get("scarica") === "1";
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const e = h.esc;
  const torna = base + "/offerte?t=" + p.tok + "&c=" + p.c;
  const indietro = '<a class="btn" href="' + e(torna) + '">Torna alle Offerte ricevute</a>';
  if (!UUID.test(p.c) || !UUID.test(id)) return h.risposta(h.foglio(base, "Offerta non trovata", "", indietro), 404);
  const info = await h.rpc(env, "offerte_file_info", { p_token: p.tok, p_id: id }, 10000).catch(() => null);
  if (!info || typeof info !== "object") return h.risposta(h.foglio(base, "Offerta", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (info.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (info.esito === "tolta") return h.risposta(h.foglio(base, "Questa offerta è stata tolta", "Non è più tra le offerte del cantiere.", indietro), 410);
  if (info.esito !== "ok" || String(info.commessa_id || "") !== p.c) return h.risposta(h.foglio(base, "Offerta non trovata", "", indietro), 404);
  const ps = String(info.percorso || "");
  if (!new RegExp("^documenti/" + p.c + "/offerte/[0-9]{8}-[0-9a-f]{12}\\.(pdf|p7m|jpg|png)$").test(ps)) {
    return h.risposta(h.foglio(base, "Offerta", "Il file di questa offerta non è disponibile in questo momento.", indietro), 404);
  }
  const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(ps), {
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  if (f && f.ok) return servi(f, info, scarica, metodo);
  if (f && (f.status === 400 || f.status === 404)) return h.risposta(h.foglio(base, "Offerta", "Il file di questa offerta non è disponibile nell'archivio. Scrivici e lo recuperiamo noi.", indietro), 404);
  return h.risposta(h.foglio(base, "Offerta", "Il file non si legge dall'archivio in questo momento: riprova tra un minuto.", indietro), 502);
}

// Il tipo del file lo decide la riga del database, mai quello salvato nell'archivio.
function servi(f, info, scarica, metodo) {
  const mime = Object.values(MIME).indexOf(info.mime) !== -1 ? info.mime : "application/pdf";
  const p7m = mime === "application/pkcs7-mime";
  const nome = String(info.nome || "offerta");
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "offerta";
  const hd = {
    "Content-Type": mime,
    "Content-Disposition": (scarica || p7m ? "attachment" : "inline") + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff"
  };
  const lun = f.headers.get("Content-Length");
  if (lun && /^[0-9]+$/.test(lun)) hd["Content-Length"] = lun;
  return new Response(metodo === "HEAD" ? null : f.body, { status: 200, headers: hd });
}

// ---------------------------------------------------------------------------- lettura automatica con l'IA (offerte-2, fase O2a)
// Qui solo accesso, tetto e registro; la lettura del file la fa il lettore comune src/lettore-offerte.js.
async function leggi(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  if (env.OFFERTE_IA === "off" || !env.ANTHROPIC_API_KEY) return json({ esito: "spento" });
  const tutto = new Uint8Array(await request.arrayBuffer());
  if (tutto.length < 10 || tutto.length > 60 * 1048576) return json({ esito: "richiesta_non_valida" }, 400);
  let d = null, bytes = null;
  if (tutto[0] === 0x7b) {
    // offerta già caricata: {t, c, id}
    try { d = JSON.parse(new TextDecoder().decode(tutto)); } catch (e) { d = null; }
  } else {
    const lunTesto = String.fromCharCode.apply(null, Array.from(tutto.subarray(0, 8)));
    const lun = /^[0-9]{8}$/.test(lunTesto) ? Number(lunTesto) : 0;
    if (!lun || lun > JSON_MAX || 8 + lun >= tutto.length) return json({ esito: "richiesta_non_valida" }, 400);
    try { d = JSON.parse(new TextDecoder().decode(tutto.subarray(8, 8 + lun))); } catch (e) { d = null; }
    bytes = tutto.subarray(8 + lun);
  }
  if (!d || typeof d !== "object") return json({ esito: "richiesta_non_valida" }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c)) return json({ esito: "richiesta_non_valida" }, 400);
  const ctl = await h.rpc(env, "offerte_lettura_controlla", { p_token: tok, p_commessa: c }, 10000).catch(() => null);
  if (!ctl || typeof ctl !== "object") return json({ esito: "incerto", messaggio: "La lettura automatica non risponde: compila i campi a mano." }, 502);
  if (ctl.esito !== "ok") return json(ctl, ctl.esito === "gettone" ? 403 : 200);
  let nome = "", sha = "", offertaId = null;
  if (bytes) {
    nome = testo(d.nome, 200);
    sha = String(d.sha256 || "").toLowerCase();
    if (bytes.length !== Number(d.byte)) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  } else {
    offertaId = String(d.id || "").toLowerCase();
    if (!UUID.test(offertaId)) return json({ esito: "richiesta_non_valida" }, 400);
    const info = await h.rpc(env, "offerte_file_info", { p_token: tok, p_id: offertaId }, 10000).catch(() => null);
    if (!info || info.esito !== "ok" || String(info.commessa_id || "") !== c) return json({ esito: "errore", messaggio: "L'offerta non si trova: ricarica la pagina." });
    const ps = String(info.percorso || "");
    if (!new RegExp("^documenti/" + c + "/offerte/[0-9]{8}-[0-9a-f]{12}\\.(pdf|p7m|jpg|png)$").test(ps)) return json({ esito: "errore", messaggio: "Il file di questa offerta non è disponibile." });
    const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(ps), {
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
    if (!f || !f.ok) return json({ esito: "archivio", messaggio: "Il file non si legge dall'archivio in questo momento: riprova tra un minuto." }, 502);
    bytes = new Uint8Array(await f.arrayBuffer());
    nome = testo(info.nome, 200);
  }
  const r = await leggiOffertaFornitore(env, { bytes, nome, modello: ctl.modello, effort: ctl.effort, fornitori: ctl.fornitori,
    materiali: lista(ctl.materiali).concat(MATERIALI_BASE) });
  // file non leggibile (.p7m o altro), troppo grande o chiave mancante: l'API non è stata chiamata, niente da registrare
  if (r.esito === "formato" || r.esito === "grande" || r.esito === "spento") return json({ esito: r.esito, messaggio: r.messaggio });
  if (!/^[0-9a-f]{64}$/.test(sha)) sha = esadecimale(await crypto.subtle.digest("SHA-256", bytes));
  const reg = await h.rpc(env, "offerte_lettura_registra", { p_token: tok, p_commessa: c, p_dati: {
    esito: r.esito, offerta_id: offertaId, sha256: sha, modello: r.modello,
    token_in: r.token_in, token_out: r.token_out, ms: String(r.ms || 0), errore: r.errore || "" } }, 10000).catch(() => null);
  const usate = reg && reg.esito === "ok" ? Number(reg.usate) || 0 : (Number(ctl.usate) || 0) + 1;
  if (r.esito === "ok") return json({ esito: "ok", proposta: r.proposta, usate, limite: ctl.limite });
  if (r.esito === "vuota") return json({ esito: "vuota", messaggio: r.messaggio, usate, limite: ctl.limite });
  return json({ esito: "errore", messaggio: r.messaggio || "Non sono riuscito a leggere l'offerta: compila i campi a mano.", usate, limite: ctl.limite });
}

// ---------------------------------------------------------------------------- pagina
const SVG = {
  chiedi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  piu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  su: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-3"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14l3-3 3 3"/></svg>',
  cerca: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  lucchetto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  orologio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
};
const MATERIALI_BASE = ["Calcestruzzo", "Ferro per c.a.", "Rete elettrosaldata", "Laterizi e blocchi", "Inerti", "Malte e premiscelati",
  "Isolanti", "Impermeabilizzazioni", "Carpenteria metallica", "Legname", "Ponteggi (noleggio)", "Noleggio mezzi", "Trasporti",
  "Smaltimento rifiuti", "Prefabbricati", "Serramenti", "Impianti"];
const UNITA = ["m³", "m²", "m", "kg", "t", "cad", "ora", "giorno", "viaggio", "a corpo", "%"];
function statoDi(x) {
  if (x.stato === "accettata") return ["ok", "Accettata"];
  if (x.stato === "non_scelta") return ["no", "Non scelta"];
  if (x.scaduta) return ["sc", "Scaduta"];
  return ["da", "Da decidere"];
}
function chiaveRiga(r) { return String(r.descrizione || "").toLowerCase().replace(/[^a-z0-9àèéìòù/]+/g, " ").trim() + "|" + String(r.unita || "").toLowerCase(); }

function pagina(base, h, p, d, torna) {
  const e = h.esc;
  const voci = lista(d.offerte);
  const chiuso = !!d.chiuso;
  const oggi = dataIso(d.oggi) || new Date().toISOString().slice(0, 10);
  const maxMb = Math.max(1, Math.min(50, Number(d.max_mb) || 25));
  const qui = base + "/offerte";
  const fornitoriRubrica = lista(d.fornitori).map((x) => testo(x, 120)).filter(Boolean);
  const materialiUsati = lista(d.materiali).map((x) => testo(x, 80)).filter(Boolean);
  const materiali = Array.from(new Set(materialiUsati.concat(MATERIALI_BASE.filter((m) => !materialiUsati.some((u) => u.toLowerCase() === m.toLowerCase())))));
  const gruppo = (x) => (x.stato === "accettata" ? "accettate" : x.stato === "non_scelta" ? "non_scelte" : x.scaduta ? "scadute" : "da_decidere");
  const conta = (k) => voci.filter((x) => gruppo(x) === k).length;
  const daDecidere = conta("da_decidere"), accettate = conta("accettate"), nonScelte = conta("non_scelte"), scadute = conta("scadute");
  const inScadenza = voci.filter((x) => gruppo(x) === "da_decidere" && x.valida_fino && (giorni(oggi, x.valida_fino) ?? 99) <= 7);
  // offerte-2 (fase O2a): lettura automatica del file con l'IA
  const ia = d.ia && typeof d.ia === "object" ? d.ia : {};
  const iaAttiva = ia.attiva === true;
  const iaLimite = Math.max(0, Number(ia.limite) || 0), iaUsate = Math.max(0, Number(ia.usate) || 0);

  const cifre = '<div class="of-cifre">' +
    '<div class="of-c-pr"><b>' + voci.length + '</b><span>Offerte</span></div>' +
    '<div class="of-c-da"><b>' + daDecidere + '</b><span>Da decidere</span></div>' +
    '<div class="of-c-ok"><b>' + accettate + '</b><span>Accettate</span></div>' +
    '<div class="of-c-gr"><b>' + scadute + '</b><span>Scadute senza decisione</span></div></div>';

  const regole = '<div class="of-regole">' + SVG.lucchetto + '<div><b>Come funziona.</b> Qui carichi le offerte che i fornitori mandano per questo cantiere: ' +
    'il PDF (o la foto), la validità e, se vuoi, i prezzi + IVA voce per voce. Le offerte dello stesso materiale stanno una accanto all\'altra e TIX ' +
    'segna il prezzo più basso della stessa voce. Quando decidi, segna l\'offerta come «Accettata» o «Non scelta». ' +
    '<b>Le vedono solo le persone della tua impresa</b> che hanno l\'accesso all\'app: mai i professionisti, mai i subappaltatori, mai WhatsApp. ' +
    'Mezz\'ora dopo il caricamento TIX ne mette una copia su Drive, nella cartella «Offerte dei fornitori» del cantiere.' +
    (iaAttiva ? ' <b>Quando scegli il file, TIX lo legge da solo</b> e compila fornitore, date, prezzi e condizioni: i campi in giallo vanno controllati prima di salvare' +
      (iaLimite ? ' (letture automatiche di questo mese: ' + iaUsate + ' di ' + iaLimite + ')' : '') + '.' : '') + '</div></div>';

  const scadenza = inScadenza.length ? '<div class="of-scad">' + SVG.orologio + '<div><b>' + (inScadenza.length === 1 ? "Un'offerta scade" : inScadenza.length + " offerte scadono") +
    ' entro 7 giorni.</b> ' + inScadenza.map((x) => {
      const g = giorni(oggi, x.valida_fino);
      return e(x.fornitore) + " (" + e(x.materiale) + "), " + (g === 0 ? "scade oggi" : g === 1 ? "scade domani" : "scade il " + e(dataIt(x.valida_fino)));
    }).join(" · ") + '</div></div>' : "";

  const filtri = '<div class="of-cerca"><div class="of-filtri" role="group" aria-label="Mostra">' +
    '<button type="button" class="on" data-f="">Tutte <i>' + voci.length + '</i></button>' +
    '<button type="button" data-f="da_decidere"' + (daDecidere ? "" : " hidden") + '>Da decidere <i>' + daDecidere + '</i></button>' +
    '<button type="button" data-f="accettate"' + (accettate ? "" : " hidden") + '>Accettate <i>' + accettate + '</i></button>' +
    '<button type="button" data-f="non_scelte"' + (nonScelte ? "" : " hidden") + '>Non scelte <i>' + nonScelte + '</i></button>' +
    '<button type="button" data-f="scadute"' + (scadute ? "" : " hidden") + '>Scadute <i>' + scadute + '</i></button></div>' +
    '<label class="of-campo">' + SVG.cerca + '<input type="search" id="of-q" placeholder="Cerca: calcestruzzo, fornitore, numero…" aria-label="Cerca un\'offerta"></label></div>';

  // un gruppo per materiale (scritto allo stesso modo, senza badare a maiuscole e spazi)
  const gruppi = new Map();
  voci.forEach((x) => {
    const k = String(x.materiale || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!gruppi.has(k)) gruppi.set(k, { nome: String(x.materiale || "").trim(), voci: [] });
    gruppi.get(k).voci.push(x);
  });
  let sezioni = "";
  let num = 0;
  Array.from(gruppi.values()).sort((a, b) => a.nome.localeCompare(b.nome, "it", { sensitivity: "base" })).forEach((g) => {
    num++;
    // prezzo più basso per la stessa voce (stessa descrizione e unità) tra le offerte ancora valide del gruppo
    const minimi = {};
    g.voci.filter((x) => x.stato !== "non_scelta" && !x.scaduta).forEach((x) => lista(x.righe).forEach((r) => {
      const v = Number(r.prezzo);
      if (r.prezzo == null || !Number.isFinite(v)) return;
      const k = chiaveRiga(r);
      minimi[k] = minimi[k] || { min: v, n: 0 };
      minimi[k].min = Math.min(minimi[k].min, v);
      minimi[k].n++;
    }));
    sezioni += '<section class="of-sez"><h2><span class="n">' + num + '</span>' + e(g.nome) + ' <small>' + g.voci.length + (g.voci.length === 1 ? " offerta" : " offerte") + '</small></h2>' +
      '<div class="of-griglia">' + g.voci.map((x) => scheda(e, qui, p, x, chiuso, oggi, minimi)).join("") + '</div></section>';
  });
  if (!voci.length) {
    sezioni = '<div class="of-vuoto">' + SVG.tag + '<p><b>Nessuna offerta ancora.</b> ' +
      (chiuso ? "Il cantiere è chiuso." : "Carica le offerte che ti mandano i fornitori di materiale: calcestruzzo, ferro, laterizi, noli, trasporti.") + '</p></div>';
  }

  const listaFor = fornitoriRubrica.length ? '<datalist id="of-fornitori">' + fornitoriRubrica.map((x) => '<option value="' + e(x) + '">').join("") + '</datalist>' : "";
  const listaMat = '<datalist id="of-materiali">' + materiali.map((x) => '<option value="' + e(x) + '">').join("") + '</datalist>';
  const listaUn = '<datalist id="of-unita">' + UNITA.map((x) => '<option value="' + e(x) + '">').join("") + '</datalist>';
  const campiDati = (pre) =>
    '<div class="of-campi">' +
    '<label class="of-l2"><span>Fornitore</span><input id="' + pre + '-forn" maxlength="120" list="of-fornitori" autocomplete="off" placeholder="Dalla Rubrica o scritto a mano"></label>' +
    '<label><span>Cosa offre</span><input id="' + pre + '-mat" maxlength="80" list="of-materiali" autocomplete="off" placeholder="es. Calcestruzzo"></label>' +
    '<label class="of-l2"><span>Descrizione (facoltativa)</span><input id="' + pre + '-descr" maxlength="300" placeholder="es. C25/30 XC2 S4 per fondazioni"></label>' +
    '<label><span>Numero dell\'offerta</span><input id="' + pre + '-num" maxlength="60" placeholder="facoltativo"></label>' +
    '<label><span>Data dell\'offerta</span><input id="' + pre + '-data" type="date"></label>' +
    '<label><span>Valida fino al</span><input id="' + pre + '-val" type="date"></label>' +
    '<label class="of-l3"><span>Note (condizioni, consegna, pagamento…)</span><textarea id="' + pre + '-note" maxlength="1000" rows="2" placeholder="es. Pompa a parte, minimo 6 m³ a viaggio, sabato +10%"></textarea></label></div>';
  const editorPrezzi = (pre) =>
    '<div class="of-prezzi-ed"><div class="of-pr-th"><span>Voce</span><span>Unità</span><span>Prezzo + IVA (€)</span><span></span></div>' +
    '<div id="' + pre + '-righe"></div><button type="button" class="btn sm sec" id="' + pre + '-agg">' + SVG.piu + 'Aggiungi una voce</button></div>';
  const form = chiuso ? "" :
    '<section class="of-form" id="carica"><h3><span class="of-mini">' + SVG.su + '</span>Carica un\'offerta</h3>' +
    '<p class="of-sotto">Un\'offerta alla volta: il PDF che ti ha mandato il fornitore, oppure la foto se è su carta.</p>' +
    '<label class="of-drop" id="of-drop"><span class="of-scegli">' + SVG.file + '<span id="of-file-nome">Trascina qui il file o tocca per sceglierlo<small>PDF, PDF firmato (.p7m), JPG o PNG, fino a ' + maxMb + ' MB · l\'impronta la calcola il tuo telefono o computer</small></span></span>' +
    '<span class="btn sm sec">Scegli il file</span><input type="file" id="of-file" accept="application/pdf,.pdf,.p7m,image/jpeg,image/png,.jpg,.jpeg,.png" hidden></label>' +
    (iaAttiva ? '<div class="of-ia" id="of-ia" role="status" hidden></div>' : '') +
    campiDati("of-c") +
    '<details class="of-det" id="of-c-det"><summary>Prezzi voce per voce (facoltativi, si possono aggiungere anche dopo)</summary>' + editorPrezzi("of-c") + '</details>' +
    '<div class="of-chi"><label for="of-c-chi">Il tuo nome</label><input id="of-c-chi" maxlength="120" autocomplete="name" placeholder="Resta scritto chi ha caricato l\'offerta"></div>' +
    '<p class="of-msg" id="of-c-msg" role="status"></p>' +
    '<div class="of-form-az"><button type="button" class="btn pr" id="of-c-salva">' + SVG.su + 'Salva l\'offerta</button></div></section>';

  const cfg = JSON.stringify({ u: qui, b: base, t: p.tok, c: p.c, max: maxMb * 1048576, maxMb, ia: iaAttiva,
    voci: voci.map((x) => ({ id: x.id, fornitore: x.fornitore, materiale: x.materiale, descrizione: x.descrizione || "", numero: x.numero || "",
      data: x.data || "", valida_fino: x.valida_fino || "", note: x.note || "", stato: x.stato, righe: lista(x.righe) })) }).replace(/</g, "\\u003c");

  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>Offerte ricevute dai fornitori - TIX · Diario di cantiere</title>" + h.testa(base) +
    "<style>" + STILE + "</style></head><body><main>" +
    '<a class="of-torna" href="' + e(torna) + '">‹ Torna al cantiere</a>' +
    '<div class="of-card">' +
    '<div class="of-testa"><div>' + (d.cantiere ? '<p class="of-cant">' + e(d.cantiere) + '</p>' : "") +
    '<h1><span class="of-ic" aria-hidden="true">' + SVG.tag + '</span>Offerte ricevute dai fornitori</h1>' +
    '<p class="of-sotto">Qui carichi le offerte che i fornitori ti hanno mandato.' + (d.chiedi && !chiuso ? ' Per chiedere tu un preventivo a un fornitore usa il pulsante «Chiedi un preventivo a un fornitore».' : '') + '</p>' +
    (d.modo === "prova" ? '<p class="of-prova">In prova: questa pagina la vede solo l\'accesso «Tutte le aziende»</p>' : "") + '</div>' +
    (chiuso ? "" : '<div class="of-az-testa">' + (d.chiedi ? '<a class="btn pr" id="of-chiedi" href="' + e(base + "/preventivi/richiedi?t=" + p.tok + "&c=" + p.c) + '">' + SVG.chiedi + 'Chiedi un preventivo a un fornitore</a>' : "") +
      '<a class="btn ' + (d.chiedi ? "sec" : "pr") + '" href="#carica">' + SVG.piu + 'Carica un\'offerta</a></div>') + '</div>' +
    cifre + regole + scadenza + (voci.length ? filtri : "") + sezioni + '<p class="of-nessuno" id="of-nessuno" hidden>Nessuna offerta con questa ricerca.</p>' +
    listaFor + listaMat + listaUn + form +
    '<p class="of-fonti">TIX™ conserva le offerte dei fornitori e le tiene in ordine. I prezzi sono quelli scritti dall\'impresa: fa fede il documento del fornitore.</p>' +
    '</div></main>' +
    // finestre: stato, prezzi, modifica, togli
    '<dialog class="of-dlg" id="of-st-dlg"><form method="dialog"><h3 id="of-st-tit">Segna l\'offerta</h3><p id="of-st-txt"></p>' +
    '<label for="of-st-chi">Il tuo nome</label><input id="of-st-chi" maxlength="120" autocomplete="name">' +
    '<p class="of-msg" id="of-st-msg" role="status"></p>' +
    '<div class="of-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn pr" id="of-st-si">Conferma</button></div></form></dialog>' +
    '<dialog class="of-dlg of-dlg-l" id="of-pr-dlg"><form method="dialog"><h3 id="of-pr-tit">Prezzi dell\'offerta</h3>' +
    '<p>Scrivi i prezzi come nell\'offerta, + IVA. Le voci scritte allo stesso modo in più offerte dello stesso materiale si confrontano.</p>' +
    (iaAttiva ? '<p class="of-p-leggi"><button type="button" class="btn sm sec" id="of-p-leggi">Leggi i prezzi dal documento</button></p><div class="of-ia" id="of-p-ia" role="status" hidden></div>' : '') +
    editorPrezzi("of-p") +
    '<label for="of-p-chi">Il tuo nome</label><input id="of-p-chi" maxlength="120" autocomplete="name">' +
    '<p class="of-msg" id="of-p-msg" role="status"></p>' +
    '<div class="of-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn pr" id="of-p-si">Salva i prezzi</button></div></form></dialog>' +
    '<dialog class="of-dlg of-dlg-l" id="of-m-dlg"><form method="dialog"><h3>Modifica i dati dell\'offerta</h3>' + campiDati("of-m") +
    '<label for="of-m-chi">Il tuo nome</label><input id="of-m-chi" maxlength="120" autocomplete="name">' +
    '<p class="of-msg" id="of-m-msg" role="status"></p>' +
    '<div class="of-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn pr" id="of-m-si">Salva</button></div></form></dialog>' +
    '<dialog class="of-dlg" id="of-t-dlg"><form method="dialog"><h3>Togli l\'offerta <span id="of-t-cod"></span></h3>' +
    '<p>Usalo per un file caricato per sbaglio o per un\'offerta che non serve più. Resta registrata come tolta. Se era già su Drive, la copia su Drive resta.</p>' +
    '<label for="of-t-chi">Il tuo nome</label><input id="of-t-chi" maxlength="120" autocomplete="name">' +
    '<label for="of-t-mot">Perché (facoltativo)</label><input id="of-t-mot" maxlength="300" placeholder="Per esempio: file sbagliato">' +
    '<p class="of-msg" id="of-t-msg" role="status"></p>' +
    '<div class="of-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn rosso" id="of-t-si">Togli</button></div></form></dialog>' +
    "<script>var CFG=" + cfg + ";" + SCRIPT + "</script></body></html>";
}

function scheda(e, qui, p, x, chiuso, oggi, minimi) {
  const apri = qui + "/file?t=" + p.tok + "&c=" + p.c + "&id=" + encodeURIComponent(x.id);
  const [cls, etichetta] = statoDi(x);
  const meta = [];
  if (x.numero || x.data) meta.push("Offerta" + (x.numero ? " n. <b>" + e(x.numero) + "</b>" : "") + (x.data ? " del " + e(dataIt(x.data)) : ""));
  if (x.valida_fino) {
    const g = giorni(oggi, x.valida_fino);
    const vicino = x.stato === "ricevuta" && g !== null && g >= 0 && g <= 7;
    meta.push('<span class="' + (x.scaduta ? "of-scaduta" : vicino ? "of-vicina" : "") + '">' + (x.scaduta ? "Scaduta il " : "Valida fino al ") + e(dataIt(x.valida_fino)) +
      (vicino ? (g === 0 ? " · scade oggi" : g === 1 ? " · scade domani" : " · mancano " + g + " giorni") : "") + "</span>");
  } else {
    meta.push('<span class="of-tenue">Validità non indicata</span>');
  }
  meta.push("caricata da <b>" + e(x.caricato_da || "") + "</b> il " + e(quando(x.caricato_il)) + " · " + e(mb(x.byte)));
  if (x.stato !== "ricevuta" && x.stato_da) meta.push((x.stato === "accettata" ? "accettata" : "segnata non scelta") + " da <b>" + e(x.stato_da) + "</b> il " + e(quando(x.stato_il)));
  const dv = x.drive && typeof x.drive === "object" ? x.drive : null;
  if (dv) {
    if (dv.stato === "archiviato" && /^https:\/\/(drive|docs)\.google\.com\//.test(String(dv.link || ""))) meta.push('su Drive: <a href="' + e(dv.link) + '" target="_blank" rel="noopener">apri la copia</a>');
    else if (dv.stato === "da_archiviare") meta.push('<span class="of-tenue">su Drive tra poco</span>');
    else if (dv.stato === "errore") meta.push('<span class="of-tenue">su Drive: non ancora, lo stiamo controllando</span>');
  }
  meta.push('<span class="of-imp" title="Impronta SHA-256 del file: ' + e(x.sha256 || "") + '">impronta ' + e(String(x.sha256 || "").slice(0, 8)) + "…</span>");
  const righe = lista(x.righe);
  const prezzi = righe.length ? '<table class="of-tab"><thead><tr><th>Voce</th><th>Unità</th><th class="n">Prezzo + IVA</th></tr></thead><tbody>' +
    righe.map((r) => {
      const v = Number(r.prezzo);
      const ha = r.prezzo != null && Number.isFinite(v);
      const k = chiaveRiga(r);
      const basso = ha && x.stato !== "non_scelta" && !x.scaduta && minimi[k] && minimi[k].n > 1 && v === minimi[k].min;
      return '<tr' + (basso ? ' class="min"' : "") + '><td>' + e(r.descrizione) + (r.note ? '<small>' + e(r.note) + '</small>' : "") + '</td><td>' + e(r.unita || "") +
        '</td><td class="n">' + (ha ? e(euro(v)) + (basso ? '<em>più basso</em>' : "") : '<span class="of-tenue">—</span>') + '</td></tr>';
    }).join("") + '</tbody></table>' : '<p class="of-noprezzi">Prezzi non scritti: sono nel documento.</p>';
  const isImg = /^image\//.test(String(x.mime || ""));
  const az = '<a class="btn sm sec" href="' + e(apri) + '" target="_blank" rel="noopener">' + (isImg ? "Apri la foto" : "Apri") + '</a>' +
    '<a class="btn sm tenue" href="' + e(apri + "&scarica=1") + '">Scarica</a>' +
    (chiuso ? "" :
      (x.stato !== "accettata" ? '<button type="button" class="btn sm pr" data-st="accettata" data-id="' + e(x.id) + '">Accetta</button>' : "") +
      (x.stato === "ricevuta" ? '<button type="button" class="btn sm tenue" data-st="non_scelta" data-id="' + e(x.id) + '">Non scelta</button>' : "") +
      (x.stato !== "ricevuta" ? '<button type="button" class="btn sm tenue" data-st="ricevuta" data-id="' + e(x.id) + '">Rimetti da decidere</button>' : "") +
      '<button type="button" class="btn sm tenue" data-pr="' + e(x.id) + '">Prezzi</button>' +
      '<button type="button" class="btn sm tenue" data-mod="' + e(x.id) + '">Modifica</button>' +
      '<button type="button" class="btn sm togli" data-togli="' + e(x.id) + '">Togli</button>');
  const q = (String(x.fornitore || "") + " " + String(x.materiale || "") + " " + String(x.descrizione || "") + " " + String(x.numero || "") + " " +
    righe.map((r) => r.descrizione).join(" ")).toLowerCase();
  const grp = x.stato === "accettata" ? "accettate" : x.stato === "non_scelta" ? "non_scelte" : x.scaduta ? "scadute" : "da_decidere";
  return '<article class="of-of of-' + cls + '" id="o-' + e(x.id) + '" data-stato="' + grp + '" data-q="' + e(q) + '">' +
    '<div class="of-of-testa"><h3>' + e(x.fornitore) + '</h3><span class="of-st ' + cls + '">' + e(etichetta) + '</span></div>' +
    (x.descrizione ? '<p class="of-descr">' + e(x.descrizione) + '</p>' : "") +
    '<p class="of-meta">' + meta.join(" · ") + '</p>' + prezzi +
    (x.note ? '<p class="of-note">' + e(x.note) + '</p>' : "") +
    '<div class="of-az">' + az + '</div></article>';
}

const STILE =
  ":root{--navy:#1B2F4A;--arancio:#F26A10;--pr:#66741C;--pr-2:#7E8C2A;--pr-s:#4E5915;--pr-f:#F3F5E6;--pr-b:#D5DCAE;" +
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
  ".of-torna{display:inline-block;margin:0 0 12px;padding:6px 14px;border-radius:999px;border:1px solid var(--l);background:var(--c);color:var(--navy);font-weight:600;text-decoration:none}" +
  ".of-card{position:relative;background:var(--c);border-radius:16px;padding:18px 18px 16px;box-shadow:var(--ombra)}" +
  ".of-card::before{content:\"\";position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#F26A10);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}" +
  ".of-testa{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:0 0 14px}" +
  ".of-cant{margin:0;font-size:.88rem;color:var(--s)}" +
  "h1{display:flex;align-items:center;gap:10px;margin:4px 0 0;font-size:1.5rem;letter-spacing:-.02em;color:var(--navy)}" +
  ".of-ic{flex:none;width:38px;height:38px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#A9B65A,#7E8C2A 45%,#4E5915);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 6px 14px -6px rgba(78,89,21,.65)}" +
  ".of-ic svg{width:21px;height:21px}" +
  ".of-prova{display:inline-block;margin:8px 0 0;padding:3px 10px;border:1px dashed var(--pr-b);border-radius:999px;background:var(--pr-f);color:var(--pr-s);font-size:.8rem;font-weight:600}" +
  ".of-az-testa{display:flex;gap:8px;flex-wrap:wrap}" +
  ".btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:42px;padding:0 16px;border-radius:12px;border:1px solid var(--navy);background:var(--c);color:var(--navy);font:inherit;font-weight:700;font-size:.92rem;text-decoration:none;white-space:nowrap;cursor:pointer;background-image:linear-gradient(180deg,#FFFFFF,#F4F7FA);box-shadow:0 1px 2px rgba(16,27,43,.05)}" +
  ".btn svg{width:17px;height:17px}" +
  ".btn.pr{border-color:var(--pr);color:#fff;background-image:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,.05) 48%,rgba(255,255,255,0) 52%),linear-gradient(180deg,#7E8C2A,#66741C);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 22px -12px rgba(78,89,21,.8)}" +
  ".btn.pr:disabled{opacity:.6;cursor:wait}" +
  ".btn.sec{border-color:var(--pr);color:var(--pr-s);background-image:none;background-color:var(--pr-f)}" +
  ".btn.sm{min-height:34px;padding:0 12px;font-size:.84rem;border-radius:10px}" +
  ".btn.tenue{border-color:rgba(16,27,43,.16);color:var(--t)}" +
  ".btn.togli{border-color:var(--ro-b);color:var(--ro);background-image:none}" +
  ".btn.rosso{border-color:var(--ro);color:#fff;background-image:none;background-color:var(--ro)}" +
  ".btn:hover,.btn:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(102,116,28,.24)}" +
  ".of-cifre{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 14px}" +
  ".of-cifre div{position:relative;border:1px solid var(--l);border-radius:12px;padding:10px 12px 10px 14px;background:var(--c);overflow:hidden}" +
  ".of-cifre div::before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--navy)}" +
  ".of-cifre b{display:block;font-size:1.55rem;line-height:1.2;color:var(--navy)}.of-cifre span{font-size:.82rem;color:var(--s)}" +
  ".of-cifre .of-c-pr::before{background:var(--pr)}.of-cifre .of-c-pr b{color:var(--pr-s)}" +
  ".of-cifre .of-c-da::before{background:#D08A1C}.of-cifre .of-c-da b{color:var(--da)}" +
  ".of-cifre .of-c-ok::before{background:var(--ok)}.of-cifre .of-c-ok b{color:var(--ok)}.of-cifre .of-c-gr::before{background:#8A96A3}" +
  ".of-regole,.of-scad{display:flex;gap:10px;align-items:flex-start;margin:0 0 6px;padding:12px 14px;border-radius:14px;border:1px solid var(--pr-b);background:var(--pr-f);font-size:.9rem;line-height:1.5;color:var(--t)}" +
  ".of-regole svg,.of-scad svg{flex:none;width:20px;height:20px;color:var(--pr);margin-top:2px}.of-regole b{color:var(--pr-s)}" +
  ".of-scad{border-color:var(--da-b);background:var(--da-f)}.of-scad svg{color:var(--da)}.of-scad b{color:var(--da)}" +
  ".of-cerca{display:flex;gap:10px 14px;align-items:center;flex-wrap:wrap;margin:16px 0 2px}" +
  ".of-filtri{display:flex;gap:6px;flex-wrap:wrap;flex:1 1 420px}" +
  ".of-filtri button{padding:6px 12px;border-radius:999px;border:1px solid var(--l);background:var(--c);font:inherit;font-size:.84rem;font-weight:600;color:var(--t);cursor:pointer}" +
  ".of-filtri button i{font-style:normal;color:var(--s);margin-left:4px}" +
  ".of-filtri button.on{background:var(--navy);border-color:var(--navy);color:#fff}.of-filtri button.on i{color:rgba(255,255,255,.75)}" +
  ".of-campo{display:flex;align-items:center;gap:8px;flex:0 1 320px;min-width:0;min-height:40px;padding:0 12px;border:1px solid rgba(16,27,43,.16);border-radius:12px;background:var(--c)}" +
  ".of-campo svg{flex:none;width:17px;height:17px;color:var(--s)}.of-campo input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:.92rem;color:var(--t)}" +
  ".of-sez{margin:24px 0 0}" +
  ".of-sez h2{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0 0 10px;padding:0 0 8px;border-bottom:2px solid rgba(102,116,28,.22);font-size:.95rem;letter-spacing:.01em;color:var(--navy)}" +
  ".of-sez h2 .n{flex:none;width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--pr);color:#fff;font-size:.82rem;letter-spacing:0;box-shadow:0 0 0 2px #fff,0 0 0 3.5px rgba(102,116,28,.35)}" +
  ".of-sez h2 small{margin-left:auto;font-size:.82rem;font-weight:600;letter-spacing:0;color:var(--s)}" +
  ".of-griglia{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;align-items:start}" +
  ".of-of{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--l);border-left:4px solid #D08A1C;border-radius:14px;background:var(--c);box-shadow:0 1px 2px rgba(16,27,43,.04)}" +
  ".of-of.of-ok{border-left-color:var(--ok)}.of-of.of-no{border-left-color:#A7B0BA;background:#FBFCFD}.of-of.of-sc{border-left-color:var(--ro)}" +
  ".of-of.of-via,.of-sez.of-via{display:none}" +
  ".of-of-testa{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.of-of-testa h3{margin:0;font-size:1rem;color:var(--navy);overflow-wrap:anywhere}" +
  ".of-st{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:.78rem;font-weight:700;line-height:1.7;white-space:nowrap}" +
  ".of-st.da{border:1px solid var(--da-b);background:var(--da-f);color:var(--da)}.of-st.ok{border:1px solid var(--ok-b);background:var(--ok-f);color:var(--ok)}" +
  ".of-st.no{border:1px solid #CBD2DA;background:#F2F4F7;color:#4A5563}.of-st.sc{border:1px solid var(--ro-b);background:var(--ro-f);color:var(--ro)}" +
  ".of-descr{margin:0;font-weight:600;font-size:.92rem;overflow-wrap:anywhere}" +
  ".of-meta{margin:0;font-size:.84rem;line-height:1.55;color:var(--s)}.of-meta b{color:var(--t);font-weight:600}.of-meta a{color:var(--pr-s);font-weight:700}" +
  ".of-vicina{color:var(--da);font-weight:700}.of-scaduta{color:var(--ro);font-weight:700}.of-tenue{color:#8A96A3}" +
  ".of-imp{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.78rem}" +
  ".of-tab{width:100%;border-collapse:collapse;font-size:.86rem;margin:4px 0 0}.of-tab th,.of-tab td{padding:6px 6px;border-bottom:1px solid #E9EDF1;text-align:left;vertical-align:top}" +
  ".of-tab th{font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;color:var(--s);font-weight:700}.of-tab .n{text-align:right;white-space:nowrap}" +
  ".of-tab small{display:block;color:var(--s);font-size:.78rem}.of-tab tr.min td{background:#EEF1E2}.of-tab tr.min .n{font-weight:800;color:var(--pr-s)}" +
  ".of-tab em{display:block;font-style:normal;font-size:.7rem;font-weight:800;color:var(--pr);text-transform:uppercase;letter-spacing:.04em}" +
  ".of-noprezzi{margin:2px 0 0;font-size:.84rem;color:var(--s)}" +
  ".of-note{margin:4px 0 0;padding:6px 10px;border-radius:10px;background:var(--z);font-size:.86rem;line-height:1.45;white-space:pre-wrap}" +
  ".of-az{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}" +
  ".of-vuoto{display:flex;gap:14px;align-items:center;margin:18px 0 0;padding:18px;border:1.5px dashed var(--pr-b);border-radius:14px;background:var(--pr-f);color:var(--pr-s)}" +
  ".of-vuoto svg{flex:none;width:34px;height:34px}.of-vuoto p{margin:0;line-height:1.45}" +
  ".of-nessuno{margin:16px 0 0;color:var(--s);font-size:.92rem}" +
  ".of-form{margin-top:26px;padding:16px;border:1px solid var(--pr-b);border-radius:16px;background:linear-gradient(180deg,#F9FAF2,#FFFFFF 60%)}" +
  ".of-form h3{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 4px;font-size:1.15rem;color:var(--navy)}" +
  ".of-mini{flex:none;width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--pr);color:#fff}.of-mini svg{width:17px;height:17px}" +
  ".of-sotto{margin:0 0 14px;font-size:.88rem;color:var(--s);line-height:1.45}" +
  ".of-drop{display:flex;align-items:center;gap:12px 16px;flex-wrap:wrap;padding:14px;border:2px dashed var(--pr-b);border-radius:14px;background:var(--pr-f);cursor:pointer}" +
  ".of-drop.sopra{border-color:var(--pr);background:#E8ECD0}.of-drop.ok{border-style:solid;border-color:var(--pr)}" +
  ".of-scegli{display:flex;align-items:center;gap:10px;font-size:.92rem;color:var(--pr-s);font-weight:600;flex:1 1 300px;overflow-wrap:anywhere}.of-scegli svg{flex:none;width:26px;height:26px}" +
  ".of-scegli small{display:block;margin-top:2px;font-size:.8rem;font-weight:500;color:var(--s)}" +
  ".of-campi{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 12px;margin:14px 0 0}" +
  ".of-campi label{display:flex;flex-direction:column;gap:4px}.of-campi .of-l2{grid-column:span 2}.of-campi .of-l3{grid-column:1/-1}" +
  ".of-campi span,.of-chi label,.of-dlg label{font-size:.84rem;font-weight:700;color:var(--navy)}" +
  ".of-campi input,.of-campi textarea,.of-chi input,.of-dlg input,.of-prezzi-ed input{width:100%;min-height:38px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;background:var(--c);font:inherit;font-size:.9rem;color:var(--t)}" +
  ".of-campi textarea{padding:8px 10px;resize:vertical;min-height:56px}" +
  ".of-campi input.manca,.of-chi input.manca,.of-dlg input.manca{border:2px solid var(--ro);background:var(--ro-f)}" +
  ".of-det{margin:14px 0 0;border:1px solid var(--pr-b);border-radius:12px;background:#fff}.of-det summary{cursor:pointer;padding:10px 12px;font-weight:700;color:var(--pr-s);font-size:.9rem}" +
  ".of-det[open] summary{border-bottom:1px solid var(--pr-b)}.of-det .of-prezzi-ed{padding:10px 12px}" +
  ".of-pr-th,.of-pr-r{display:grid;grid-template-columns:minmax(0,1fr) 110px 150px 40px;gap:8px;align-items:center}" +
  ".of-pr-th{font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--s);margin:0 0 6px}" +
  ".of-pr-r{margin:0 0 6px}.of-pr-r input.n{text-align:right}.of-pr-r input.o{grid-column:1/-1;font-size:.85rem}.of-pr-x{min-height:38px;border:1px solid var(--ro-b);border-radius:10px;background:#fff;color:var(--ro);font:inherit;font-weight:800;cursor:pointer}" +
  ".of-chi{margin-top:12px;display:flex;flex-direction:column;gap:4px;max-width:420px}" +
  ".of-msg{margin:10px 0 0;font-size:.9rem;font-weight:600;color:var(--ro);min-height:1px}.of-msg.ok{color:var(--ok)}" +
  ".of-form-az{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:14px}" +
  ".of-fonti{margin:20px 0 0;font-size:.82rem;line-height:1.5;color:var(--s)}" +
  ".of-dlg{max-width:460px;width:calc(100vw - 32px);border:0;border-radius:16px;padding:18px;box-shadow:0 24px 60px -20px rgba(16,27,43,.45)}" +
  ".of-dlg.of-dlg-l{max-width:820px}" +
  ".of-dlg::backdrop{background:rgba(16,27,43,.45)}.of-dlg h3{margin:0 0 8px;color:var(--navy)}.of-dlg p{margin:0 0 12px;font-size:.9rem;line-height:1.45;color:var(--s)}" +
  ".of-dlg form{display:flex;flex-direction:column;gap:6px}" +
  // offerte-2 (O2a): lettura automatica, campi proposti da controllare
  ".of-ia{margin:12px 0 0;padding:10px 12px;border-radius:12px;border:1px solid #E8D48A;background:#FFF9E6;font-size:.88rem;line-height:1.5;color:#5C4500}" +
  ".of-ia b{color:#5C4500}.of-ia ul{margin:6px 0 0;padding-left:18px}.of-ia .of-ia-az{margin:8px 0 0}" +
  ".of-ia.at{border-color:var(--pr-b);background:var(--pr-f);color:var(--pr-s)}.of-ia.no{border-color:var(--ro-b);background:var(--ro-f);color:#7a1c16}" +
  ".of-gira{display:inline-block;width:14px;height:14px;margin-right:8px;vertical-align:-2px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:ofgira .8s linear infinite}" +
  "@keyframes ofgira{to{transform:rotate(360deg)}}" +
  ".of-campi input.ia,.of-campi textarea.ia,.of-prezzi-ed input.ia{background:#FFF4C2;border-color:#D9B23C}" +
  ".of-p-leggi{margin:0 0 6px!important}" +
  "@media (max-width:900px){.of-campi{grid-template-columns:repeat(2,minmax(0,1fr))}.of-campi .of-l2,.of-campi .of-l3{grid-column:1/-1}}" +
  "@media (max-width:680px){main{padding:14px 16px 40px}.of-card{padding:16px 14px 14px}h1{font-size:1.35rem}" +
  ".of-az-testa{width:100%}.of-az-testa .btn{flex:1 1 auto}.of-cifre{grid-template-columns:repeat(2,minmax(0,1fr))}.of-campo{flex:1 1 100%}" +
  ".of-griglia{grid-template-columns:minmax(0,1fr)}.of-campi{grid-template-columns:minmax(0,1fr)}.of-sez h2 small{flex-basis:100%;margin-left:36px}" +
  ".of-pr-th{display:none}.of-pr-r{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 40px;padding:8px;border:1px solid var(--l);border-radius:10px}.of-pr-r .d{grid-column:1/-1}" +
  ".of-form-az .btn{flex:1 1 auto}}";

const SCRIPT = String.raw`(function(){try{
var D=document;function $(i){return D.getElementById(i);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function leggiChi(){try{return localStorage.getItem('tix_pg_chi')||'';}catch(e){return '';}}
function scriviChi(v){try{if(v)localStorage.setItem('tix_pg_chi',v);}catch(e){}}
function mb(n){n=Number(n)||0;if(n>=1048576)return (Math.round(n/104857.6)/10).toString().replace('.',',')+' MB';return Math.max(1,Math.round(n/1024))+' KB';}
function esa(buf){return Array.prototype.map.call(new Uint8Array(buf),function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
function voce(id){for(var i=0;i<CFG.voci.length;i++){if(CFG.voci[i].id===id)return CFG.voci[i];}return null;}
function chiamaA(az,id,dati){return fetch(CFG.u+'/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:az,id:id,dati:dati})}).then(function(r){return r.json();});}
function prezzoIt(v){if(v===null||v===undefined||v==='')return '';var n=Number(v);if(!isFinite(n))return '';return String(n).replace('.',',');}
// ---- filtri e ricerca
var filtro='',q=$('of-q');
function applica(){var t=(q&&q.value||'').toLowerCase().trim();var vis=0;
Array.prototype.forEach.call(D.querySelectorAll('.of-sez'),function(s){var n=0;Array.prototype.forEach.call(s.querySelectorAll('.of-of'),function(o){
var ok=(!filtro||o.getAttribute('data-stato')===filtro)&&(!t||(o.getAttribute('data-q')||'').indexOf(t)!==-1);o.classList.toggle('of-via',!ok);if(ok)n++;});
s.classList.toggle('of-via',!n);vis+=n;});var ns=$('of-nessuno');if(ns)ns.hidden=!!vis||!D.querySelector('.of-of');}
Array.prototype.forEach.call(D.querySelectorAll('.of-filtri button'),function(b){b.addEventListener('click',function(){
Array.prototype.forEach.call(D.querySelectorAll('.of-filtri button'),function(x){x.classList.remove('on');});b.classList.add('on');filtro=b.getAttribute('data-f')||'';applica();});});
if(q)q.addEventListener('input',applica);
// ---- editor dei prezzi (righe: voce, unità, prezzo)
function rigaEd(cont,r){var d=D.createElement('div');d.className='of-pr-r';
d.innerHTML='<input class="d" maxlength="300" placeholder="es. C25/30 XC2 S4" aria-label="Voce"><input class="u" maxlength="20" list="of-unita" placeholder="m³" aria-label="Unità"><input class="n" inputmode="decimal" maxlength="14" placeholder="0,00" aria-label="Prezzo + IVA"><button type="button" class="of-pr-x" aria-label="Togli la voce">×</button>'+(r&&r.note?'<input class="o" maxlength="300" aria-label="Note della voce" placeholder="Note della voce: minimi, sconti, maggiorazioni">':'');
var i=d.querySelectorAll('input');i[0].value=r&&r.descrizione||'';i[1].value=r&&r.unita||'';i[2].value=r?prezzoIt(r.prezzo):'';if(i[3])i[3].value=r.note;
d.querySelector('.of-pr-x').addEventListener('click',function(){cont.removeChild(d);if(!cont.children.length)rigaEd(cont);});cont.appendChild(d);return d;}
function righeDi(cont){var out=[],bad=false;Array.prototype.forEach.call(cont.querySelectorAll('.of-pr-r'),function(d){var i=d.querySelectorAll('input');
var ds=i[0].value.trim(),u=i[1].value.trim(),p=i[2].value.trim().replace(/\s+/g,'').replace(/\.(?=\d{3}(\D|$))/g,'').replace(',','.');
i[2].classList.remove('manca');if(!ds&&!p)return;if(!ds){i[0].classList.add('manca');bad=true;return;}
if(p&&!/^[0-9]{1,7}(\.[0-9]{1,4})?$/.test(p)){i[2].classList.add('manca');bad=true;return;}out.push({descrizione:ds,unita:u,prezzo:p,note:i[3]?i[3].value.trim():''});});return bad?null:out;}
function prepEd(pre,righe){var cont=$(pre+'-righe');if(!cont)return;cont.innerHTML='';(righe&&righe.length?righe:[null]).forEach(function(r){rigaEd(cont,r);});
var agg=$(pre+'-agg');if(agg&&!agg._ok){agg._ok=1;agg.addEventListener('click',function(){var r=rigaEd(cont);r.querySelector('input').focus();});}}
function campi(pre){return{fornitore:$(pre+'-forn').value.trim(),materiale:$(pre+'-mat').value.trim(),descrizione:$(pre+'-descr').value.trim(),numero:$(pre+'-num').value.trim(),
data:$(pre+'-data').value,valida_fino:$(pre+'-val').value,note:$(pre+'-note').value.trim()};}
function controlla(pre,x,msg){var ok=true;[['forn','fornitore'],['mat','materiale']].forEach(function(k){var el=$(pre+'-'+k[0]);el.classList.toggle('manca',!x[k[1]]);if(!x[k[1]])ok=false;});
if(!ok){msg.textContent='Scrivi il fornitore e cosa offre.';return false;}
if(x.data&&x.valida_fino&&x.valida_fino<x.data){msg.textContent='La validità finisce prima della data dell\u2019offerta: controlla le due date.';return false;}return true;}
// ---- caricamento
var FILE=null,drop=$('of-drop'),inp=$('of-file');
function scegli(f){if(!f)return;var est=(f.name.match(/\.([A-Za-z0-9]{1,5})$/)||[])[1];est=(est||'').toLowerCase();var msg=$('of-c-msg');msg.className='of-msg';msg.textContent='';
if(['pdf','p7m','jpg','jpeg','png'].indexOf(est)===-1){FILE=null;msg.textContent='Carica l\u2019offerta in PDF (anche firmato, .p7m) oppure la foto (JPG o PNG).';return;}
if(f.size>CFG.max){FILE=null;msg.textContent='Il file è troppo grande: in TIX un\u2019offerta arriva fino a '+CFG.maxMb+' MB.';return;}
FILE=f;$('of-file-nome').innerHTML=esc(f.name)+'<small>'+esc(mb(f.size))+' · tocca per cambiarlo</small>';drop.classList.add('ok');
if(CFG.ia&&['pdf','jpg','jpeg','png'].indexOf(est)!==-1)leggiFile(f);}
// ---- lettura automatica con l'IA (offerte-2): la proposta riempie solo i campi vuoti, in giallo; niente si salva da solo
var LETTURA=0;
function boxIa(id,cls,html){var b=$(id);if(!b)return;b.hidden=!html;b.className='of-ia'+(cls?' '+cls:'');b.innerHTML=html||'';}
function segna(el,v){if(!el||v===undefined||v===null||String(v)==='')return false;if(String(el.value||'').trim())return false;el.value=v;el.classList.add('ia');return true;}
function righeIa(cont,righe){cont.innerHTML='';righe.forEach(function(x){var d=rigaEd(cont,x);Array.prototype.forEach.call(d.querySelectorAll('input'),function(i){if(i.value)i.classList.add('ia');});});}
function applicaIa(pre,p){var ex=[],fe=$(pre+'-forn'),fv=fe?String(fe.value||'').trim():'';
if(fv&&p.fornitore&&fv.toLowerCase()!==String(p.fornitore).toLowerCase())ex.push('Nel documento il fornitore è «'+p.fornitore+'»: è rimasto quello che hai scritto tu.');
segna($(pre+'-forn'),p.fornitore);segna($(pre+'-mat'),p.materiale);segna($(pre+'-descr'),p.descrizione);segna($(pre+'-num'),p.numero);
segna($(pre+'-data'),p.data);segna($(pre+'-val'),p.valida_fino);segna($(pre+'-note'),p.note);
var cont=$(pre+'-righe'),piene=cont?righeDi(cont):null;if(cont&&p.righe&&p.righe.length&&piene&&!piene.length){righeIa(cont,p.righe);var det=$(pre+'-det');if(det)det.open=true;}return ex;}
function riassunto(p,r,ex){var h='<b>TIX ha letto l’offerta e compilato i campi in giallo: controllali prima di salvare.</b>';var l=[];
(ex||[]).concat(p.dubbi||[]).forEach(function(x){l.push(esc(x));});if(p.mancano&&p.mancano.length)l.push('Non trovati nel documento: '+esc(p.mancano.join(', '))+'.');
if(l.length)h+='<ul><li>'+l.join('</li><li>')+'</li></ul>';if(r.limite)h+='<p class="of-ia-az">Letture automatiche di questo mese: '+esc(r.usate)+' di '+esc(r.limite)+'.</p>';return h;}
function leggiFile(f){var mio=++LETTURA;var sv=$('of-c-salva');
Array.prototype.forEach.call(D.querySelectorAll('#carica .ia'),function(el){el.value='';el.classList.remove('ia');});
if(sv)sv.disabled=true;boxIa('of-ia','at','<span class="of-gira"></span>TIX sta leggendo l’offerta: di solito bastano 10–30 secondi. <button type="button" class="btn sm tenue" id="of-ia-salta">Compila a mano</button>');
var sb=$('of-ia-salta');if(sb)sb.addEventListener('click',function(){LETTURA++;if(sv)sv.disabled=false;boxIa('of-ia','','');});
f.arrayBuffer().then(function(buf){return crypto.subtle.digest('SHA-256',buf).then(function(h){var dati={t:CFG.t,c:CFG.c,nome:f.name,byte:buf.byteLength,sha256:esa(h)};
var js=new TextEncoder().encode(JSON.stringify(dati));var lun=String(js.length);while(lun.length<8)lun='0'+lun;
var corpo=new Uint8Array(8+js.length+buf.byteLength);corpo.set(new TextEncoder().encode(lun),0);corpo.set(js,8);corpo.set(new Uint8Array(buf),8+js.length);
return fetch(CFG.u+'/leggi',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:corpo});});}).then(function(r){return r.json();}).then(function(r){
if(mio!==LETTURA)return;if(sv)sv.disabled=false;
if(r&&r.esito==='ok'&&r.proposta){var ex=applicaIa('of-c',r.proposta);boxIa('of-ia','',riassunto(r.proposta,r,ex));return;}
if(r&&r.esito==='spento'){boxIa('of-ia','','');return;}
boxIa('of-ia','no',esc((r&&r.messaggio)||'Non sono riuscito a leggere l’offerta: compila i campi a mano.'));})
.catch(function(){if(mio!==LETTURA)return;if(sv)sv.disabled=false;boxIa('of-ia','no','Non sono riuscito a leggere l’offerta: compila i campi a mano.');});}
D.addEventListener('input',function(ev){var t=ev.target;if(t&&t.classList&&t.classList.contains('ia'))t.classList.remove('ia');},true);
if(drop){['dragenter','dragover'].forEach(function(t){drop.addEventListener(t,function(ev){ev.preventDefault();drop.classList.add('sopra');});});
['dragleave','drop'].forEach(function(t){drop.addEventListener(t,function(ev){ev.preventDefault();drop.classList.remove('sopra');});});
drop.addEventListener('drop',function(ev){var f=ev.dataTransfer&&ev.dataTransfer.files&&ev.dataTransfer.files[0];scegli(f);});
inp.addEventListener('change',function(){scegli(inp.files&&inp.files[0]);});prepEd('of-c',[]);if($('of-c-chi'))$('of-c-chi').value=leggiChi();}
var salva=$('of-c-salva');
if(salva)salva.addEventListener('click',function(){var msg=$('of-c-msg');msg.className='of-msg';msg.textContent='';
if(!FILE){msg.textContent='Scegli il file dell\u2019offerta.';return;}
var x=campi('of-c');if(!controlla('of-c',x,msg))return;
var righe=righeDi($('of-c-righe'));if(righe===null){$('of-c-det').open=true;msg.textContent='Controlla le voci segnate in rosso: serve la voce e un prezzo come 98,50.';return;}
var chi=$('of-c-chi').value.trim();$('of-c-chi').classList.toggle('manca',!chi);if(!chi){msg.textContent='Scrivi il tuo nome.';return;}scriviChi(chi);
salva.disabled=true;msg.className='of-msg ok';msg.textContent='Calcolo l\u2019impronta e salvo l\u2019offerta…';
FILE.arrayBuffer().then(function(buf){return crypto.subtle.digest('SHA-256',buf).then(function(h){
var dati={t:CFG.t,c:CFG.c,fornitore:x.fornitore,materiale:x.materiale,descrizione:x.descrizione,numero:x.numero,data:x.data,valida_fino:x.valida_fino,note:x.note,
autore:chi,nome:FILE.name,byte:buf.byteLength,sha256:esa(h),righe:righe};
var js=new TextEncoder().encode(JSON.stringify(dati));var lun=String(js.length);while(lun.length<8)lun='0'+lun;
var corpo=new Uint8Array(8+js.length+buf.byteLength);corpo.set(new TextEncoder().encode(lun),0);corpo.set(js,8);corpo.set(new Uint8Array(buf),8+js.length);
return fetch(CFG.u+'/carica',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:corpo});});}).then(function(r){return r.json();}).then(function(r){
if(r&&r.esito==='ok'){msg.textContent='Offerta salvata.';location.href=location.pathname+location.search+'#o-'+r.id;location.reload();return;}
salva.disabled=false;msg.className='of-msg';msg.textContent=(r&&r.messaggio)||(r&&r.esito==='spento'?'Le offerte non sono disponibili per questo cantiere.':'Non è andata: riprova.');})
.catch(function(){salva.disabled=false;msg.className='of-msg';msg.textContent='Non è andata: controlla la connessione e riprova.';});});
// ---- stato
var stDlg=$('of-st-dlg'),stId='',stVal='';
var TESTI={accettata:['Accetta l\u2019offerta','L\u2019offerta diventa quella scelta per questo materiale. Le altre restano come sono: se vuoi, segnale «Non scelta».'],
non_scelta:['Segna «Non scelta»','L\u2019offerta resta in archivio, ma il suo prezzo non conta più nel confronto.'],ricevuta:['Rimetti da decidere','L\u2019offerta torna tra quelle da decidere.']};
Array.prototype.forEach.call(D.querySelectorAll('[data-st]'),function(b){b.addEventListener('click',function(){stId=b.getAttribute('data-id');stVal=b.getAttribute('data-st');var v=voce(stId);
$('of-st-tit').textContent=TESTI[stVal][0];$('of-st-txt').textContent=(v?v.fornitore+' · '+v.materiale+'. ':'')+TESTI[stVal][1];$('of-st-chi').value=leggiChi();$('of-st-msg').textContent='';stDlg.showModal();});});
if($('of-st-si'))$('of-st-si').addEventListener('click',function(){var chi=$('of-st-chi').value.trim(),m=$('of-st-msg');if(!chi){$('of-st-chi').classList.add('manca');m.textContent='Scrivi il tuo nome.';return;}
scriviChi(chi);var self=this;self.disabled=true;chiamaA('stato',stId,{stato:stVal,chi:chi}).then(function(r){if(r&&r.esito==='ok'){location.reload();return;}self.disabled=false;m.textContent=(r&&r.messaggio)||'Non è andata: riprova.';})
.catch(function(){self.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
// ---- prezzi
var prDlg=$('of-pr-dlg'),prId='';
Array.prototype.forEach.call(D.querySelectorAll('[data-pr]'),function(b){b.addEventListener('click',function(){prId=b.getAttribute('data-pr');var v=voce(prId);
$('of-pr-tit').textContent='Prezzi · '+(v?v.fornitore+' · '+v.materiale:'');prepEd('of-p',v?v.righe:[]);$('of-p-chi').value=leggiChi();$('of-p-msg').textContent='';boxIa('of-p-ia','','');prDlg.showModal();});});
var pLeggi=$('of-p-leggi');
if(pLeggi)pLeggi.addEventListener('click',function(){var self=this;self.disabled=true;boxIa('of-p-ia','at','<span class="of-gira"></span>TIX sta leggendo i prezzi dal documento…');
fetch(CFG.u+'/leggi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,id:prId})}).then(function(r){return r.json();}).then(function(r){self.disabled=false;
if(r&&r.esito==='ok'&&r.proposta){var righe=r.proposta.righe||[];if(!righe.length){boxIa('of-p-ia','no','Nel documento non ho trovato prezzi da ricopiare.');return;}
righeIa($('of-p-righe'),righe);var dd=r.proposta.dubbi||[];
boxIa('of-p-ia','','<b>Ho ricopiato '+righe.length+(righe.length===1?' voce':' voci')+' dal documento: controllale, poi «Salva i prezzi».</b>'+(dd.length?'<ul><li>'+dd.map(esc).join('</li><li>')+'</li></ul>':''));return;}
boxIa('of-p-ia','no',esc((r&&r.messaggio)||'Non sono riuscito a leggere i prezzi: scrivili a mano.'));})
.catch(function(){self.disabled=false;boxIa('of-p-ia','no','Non sono riuscito a leggere i prezzi: scrivili a mano.');});});
if($('of-p-si'))$('of-p-si').addEventListener('click',function(){var m=$('of-p-msg');var righe=righeDi($('of-p-righe'));if(righe===null){m.textContent='Controlla le voci segnate in rosso: serve la voce e un prezzo come 98,50.';return;}
var chi=$('of-p-chi').value.trim();if(!chi){$('of-p-chi').classList.add('manca');m.textContent='Scrivi il tuo nome.';return;}scriviChi(chi);var self=this;self.disabled=true;
chiamaA('righe',prId,{righe:righe,chi:chi}).then(function(r){if(r&&r.esito==='ok'){location.reload();return;}self.disabled=false;m.textContent=(r&&r.messaggio)||'Non è andata: riprova.';})
.catch(function(){self.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
// ---- modifica
var mDlg=$('of-m-dlg'),mId='';
Array.prototype.forEach.call(D.querySelectorAll('[data-mod]'),function(b){b.addEventListener('click',function(){mId=b.getAttribute('data-mod');var v=voce(mId)||{};
$('of-m-forn').value=v.fornitore||'';$('of-m-mat').value=v.materiale||'';$('of-m-descr').value=v.descrizione||'';$('of-m-num').value=v.numero||'';$('of-m-data').value=v.data||'';
$('of-m-val').value=v.valida_fino||'';$('of-m-note').value=v.note||'';$('of-m-chi').value=leggiChi();$('of-m-msg').textContent='';mDlg.showModal();});});
if($('of-m-si'))$('of-m-si').addEventListener('click',function(){var m=$('of-m-msg');var x=campi('of-m');if(!controlla('of-m',x,m))return;
var chi=$('of-m-chi').value.trim();if(!chi){$('of-m-chi').classList.add('manca');m.textContent='Scrivi il tuo nome.';return;}scriviChi(chi);x.chi=chi;var self=this;self.disabled=true;
chiamaA('modifica',mId,x).then(function(r){if(r&&r.esito==='ok'){location.reload();return;}self.disabled=false;m.textContent=(r&&r.messaggio)||'Non è andata: riprova.';})
.catch(function(){self.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
// ---- togli
var tDlg=$('of-t-dlg'),tId='';
Array.prototype.forEach.call(D.querySelectorAll('[data-togli]'),function(b){b.addEventListener('click',function(){tId=b.getAttribute('data-togli');var v=voce(tId);
$('of-t-cod').textContent=v?'di '+v.fornitore:'';$('of-t-chi').value=leggiChi();$('of-t-mot').value='';$('of-t-msg').textContent='';tDlg.showModal();});});
if($('of-t-si'))$('of-t-si').addEventListener('click',function(){var chi=$('of-t-chi').value.trim(),m=$('of-t-msg');if(!chi){$('of-t-chi').classList.add('manca');m.textContent='Scrivi il tuo nome.';return;}
scriviChi(chi);var self=this;self.disabled=true;chiamaA('togli',tId,{chi:chi,motivo:$('of-t-mot').value.trim()}).then(function(r){if(r&&r.esito==='ok'){location.reload();return;}
self.disabled=false;m.textContent=(r&&r.messaggio)||'Non è andata: riprova.';}).catch(function(){self.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
}catch(err){}})();`;

// Solo per il banco di prova locale (pagina con dati inventati, senza database): stessa pagina della rotta vera.
export function offertePaginaProva(base, h, p, d) {
  return pagina(base, h, p, d, base + "/?t=" + p.tok + "&c=" + p.c);
}
// Solo per il banco di prova: la pulizia della proposta letta dall'IA.
export function offerteIaProva(p, fornitori, materiali) {
  return pulisciPropostaOfferta(p, fornitori, materiali);
}
