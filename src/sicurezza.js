// ============================================================================
// SICUREZZA DEL CANTIERE — area riservata (02/11/2026, sicurezza-1). Il pulsante «🦺 Sicurezza» della pagina del cantiere
// apre la pagina dei documenti della sicurezza: PSC, notifica preliminare, POS delle imprese, PiMUS, verbali del CSE, piano di
// emergenza, idoneità tecnico-professionale e DURC delle imprese, altri documenti. Per ogni documento: tipo, impresa, versione,
// date, scadenza, chi l'ha caricato, impronta SHA-256, stato («Da verificare», «Visto dal CSE», «Superato») e archivio su Drive.
// TIX conserva e ordina i documenti e ricorda le scadenze: non ne controlla il contenuto. «Visto dal CSE» è un'etichetta che
// mette l'impresa, non la firma del CSE (la pagina lo dice).
//   GET  /sicurezza?t=<gettone>&c=<cantiere>                 → pagina (database: sicurezza_contesto)
//   POST /sicurezza/carica   intestazione X-Sicurezza-Dati = JSON in base64url {t, c, tipo, impresa, …, byte, sha256},
//                            corpo = il file (PDF o .p7m, fino a impostazioni.sicurezza_max_mb)
//   POST /sicurezza/azione   {t, c, azione, id, dati}        → visto, da_verificare, ripristina, dati, annulla, impresa_salva,
//                                                             impresa_togli
//   GET  /sicurezza/file?t=…&c=…&id=…[&scarica=1]            → il file (copia di passaggio o copia ripresa dall'archivio);
//                                                             se c'è solo su Drive: «Sto riprendendo il documento…»
// Caricamento: prima il controllo dell'accesso nel database (sicurezza_carica_controlla), poi il corpo; tipo letto dai primi
// byte; impronta ricalcolata qui solo fino a 5 MB (CPU del piano gratuito), altrimenti vale quella del browser, che Make
// confronta poi con quella di Google Drive. Il file va in wa-media (documenti/<cantiere>/sicurezza/AAAAMMGG-<12 esadecimali>),
// con un collegamento firmato di 30 giorni per Make. La sveglia di Make la manda il database (CONTRATTO.md, deviazione D4).
// Interruttori: impostazioni.sicurezza_attiva (no / prova = solo Filippo / si) e SICUREZZA = "off" nel Worker (pagina e pulsante).
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIORNO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const SETTIMANA = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const VERIFICA_MAX = 5 * 1024 * 1024;   // il Worker ricalcola l'impronta solo fino a 5 MB
const LINK_SECONDI = 2592000;           // collegamento firmato di 30 giorni per Make (CONTRATTO §2)
const ATTESA_GIRI = 24;                 // «Sto riprendendo…»: un giro ogni 4 secondi, poi «Ci vuole più del solito»

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
// intestazione X-Sicurezza-Dati: JSON in UTF-8 codificato base64url (niente dati nell'indirizzo)
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

// ---------------------------------------------------------------------------- date e misure
function dataIt(iso) { return GIORNO.test(String(iso || "").slice(0, 10)) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : ""; }
function ggmm(iso) { return GIORNO.test(String(iso || "").slice(0, 10)) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : ""; }
function quando(ts) {   // "2026-11-02T16:40" → "02/11/2026 alle 16:40"
  const s = String(ts || "");
  return dataIt(s) + (/T[0-9]{2}:[0-9]{2}/.test(s) ? " alle " + s.slice(11, 16) : "");
}
function giornoLungo(iso) {   // "2026-11-02" → "lunedì 2 novembre"
  if (!GIORNO.test(String(iso || ""))) return String(iso || "");
  const d = new Date(iso + "T12:00:00Z");
  return SETTIMANA[d.getUTCDay()] + " " + d.getUTCDate() + " " + MESI[d.getUTCMonth()];
}
function giornoSett(iso) {   // "2026-11-14" → "sabato 14/11/2026"
  if (!GIORNO.test(String(iso || ""))) return "";
  return SETTIMANA[new Date(iso + "T12:00:00Z").getUTCDay()] + " " + dataIt(iso);
}
function mb(n) {
  const x = Number(n) || 0;
  if (x >= 1048576) return (Math.round(x / 104857.6) / 10).toString().replace(".", ",") + " MB";
  return Math.max(1, Math.round(x / 1024)) + " KB";
}
function traGiorni(g) {
  const n = Number(g);
  if (n === 0) return "oggi";
  if (n === 1) return "domani";
  return "tra " + n + " giorni";
}

// ---------------------------------------------------------------------------- pulsante nella pagina del cantiere
// Chiamata fatta da index.js insieme a dashboard_html: qualsiasi errore o attesa oltre 8 secondi = nessun pulsante.
export async function sicurezzaPulsante(env, token, commessa) {
  if (!env || !env.SUPABASE_SERVICE_KEY || env.SICUREZZA === "off") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(supabaseUrl(env) + "/rest/v1/rpc/sicurezza_pulsante", {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_token: token, p_commessa: commessa }), signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j !== "object" || j.esito !== "ok" || j.attiva !== true) return null;
    return { attiva: true, modo: String(j.modo || ""), da_verificare: Math.max(0, Math.min(999, Number(j.da_verificare) || 0)) };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Quarto pulsante della riga dei pulsanti del cantiere (la riga la compone economie.js, riga()); da solo, se la riga non
// c'è, va sotto le schede come «Persone del cantiere». Numerino arancione = documenti «Da verificare».
export function sicurezzaIniezione(base, token, commessa, n) {
  const u = base + "/sicurezza?t=" + token + "&c=" + encodeURIComponent(commessa);
  const k = Math.max(0, Math.min(999, Number(n) || 0));
  const etichetta = "&#129466; Sicurezza" + (k ? ' <span class="gl-sc-n" title="Documenti da verificare">' + k + "</span>" : "");
  return "<style>.gl-sc-barra{max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right}" +
    ".gl-sc-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 16px;border:1.5px solid #087F5B;border-radius:10px;background:#E6F7EF;color:#065F46;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none;box-shadow:0 0 0 3px rgba(8,127,91,.14)}" +
    ".gl-sc-b:hover,.gl-sc-b:focus-visible{background:#087F5B;color:#fff;outline:none}" +
    ".gl-sc-n{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:#FFF3E8;border:1px solid #F7B98A;color:#9A4308;font-size:.75rem;font-weight:800;line-height:1}" +
    "@media (prefers-color-scheme:dark){.gl-sc-b{background:#0f2e25;color:#bfeedd;border-color:#0CA678}}</style>" +
    "<script>(function(){try{var a=document.createElement('a');a.className='gl-sc-b';a.href=" + JSON.stringify(u) + ";a.innerHTML=" + JSON.stringify(etichetta) + ";" +
    "var r=document.querySelector('.gl-azioni');if(r){r.appendChild(a);r.classList.add('gl-az4');return;}" +
    "var b=document.createElement('div');b.className='gl-sc-barra';b.appendChild(a);var nav=document.querySelector('nav.schede');" +
    "if(nav&&nav.parentNode){nav.parentNode.insertBefore(b,nav.nextSibling);}else{document.body.insertBefore(b,document.body.firstChild);}}catch(e){}})();</script>";
}

// ---------------------------------------------------------------------------- rotte
export async function portaleSicurezza(request, env, base, inUrl, h) {
  if (env.SICUREZZA === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");
  if (sotto === "/sicurezza/carica") return carica(request, env, h);
  if (sotto === "/sicurezza/azione") return azione(request, env, h);
  if (sotto === "/sicurezza/file") return apriFile(request, env, base, inUrl, h);
  if (sotto !== "/sicurezza") return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const p = parametri(inUrl);
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!UUID.test(p.c)) return Response.redirect(inUrl.origin + base + "/?t=" + p.tok, 303);
  const torna = base + "/?t=" + p.tok + "&c=" + p.c;
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>';
  const d = await h.rpc(env, "sicurezza_contesto", { p_token: p.tok, p_commessa: p.c }, 20000).catch(() => null);
  if (!d || typeof d !== "object") return h.risposta(h.foglio(base, "Sicurezza del cantiere", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Sicurezza del cantiere", "Questa pagina non è disponibile per questo cantiere.", indietro), 404);
  return h.risposta(pagina(base, h, p, d, torna));
}

// ---------------------------------------------------------------------------- caricamento
async function carica(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  const grezzo = String(request.headers.get("X-Sicurezza-Dati") || "");
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
    tipo: testo(d.tipo, 40), impresa: testo(d.impresa, 160), impresa_ruolo: testo(d.impresa_ruolo, 20),
    titolo: testo(d.titolo, 200), versione: testo(d.versione, 60), data: testo(d.data, 10), scadenza: testo(d.scadenza, 10),
    nota: String(d.nota == null ? "" : d.nota).slice(0, 1000), autore: testo(d.autore, 120), nome, byte, sha256: sha
  };
  const dichiarati = Number(request.headers.get("Content-Length") || 0);
  if (!Number.isFinite(byte) || byte <= 0) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (dichiarati && dichiarati !== byte) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  // prima l'accesso, l'interruttore, il cantiere aperto e la misura: chi non può caricare non scrive niente nell'archivio
  const ctl = await h.rpc(env, "sicurezza_carica_controlla", { p_token: tok, p_commessa: c,
    p_dati: { tipo: dati.tipo, impresa: dati.impresa, nome, byte } }, 10000).catch(() => null);
  if (!ctl || typeof ctl !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 502);
  if (ctl.esito !== "ok") return json(ctl, ctl.esito === "gettone" ? 403 : 200);
  const cartella = "documenti/" + c + "/sicurezza/";
  const est = ctl.est === "p7m" ? "p7m" : ctl.est === "pdf" ? "pdf" : "";
  const max = Number(ctl.max_byte) || 0;
  if (ctl.cartella !== cartella || !est || !max) return json({ esito: "errore", messaggio: "Richiesta non valida: ricarica la pagina." }, 502);
  if (dichiarati > max) return json({ esito: "grande", messaggio: "Il file è troppo grande: il massimo è " + Math.round(max / 1048576) + " MB." }, 413);
  if (!/^[0-9a-f]{64}$/.test(sha)) return json({ esito: "errore", messaggio: "Manca l'impronta del file: ricarica la pagina e riprova." }, 400);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length > max) return json({ esito: "grande", messaggio: "Il file è troppo grande: il massimo è " + Math.round(max / 1048576) + " MB." }, 413);
  if (bytes.length !== byte) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  // il tipo si legge dai primi byte: «%PDF-» (entro i primi 1024 byte, come fanno i lettori PDF) o la busta firmata DER (0x30)
  if (est === "pdf") {
    const testa = String.fromCharCode.apply(null, Array.from(bytes.subarray(0, 1024)));
    if (testa.indexOf("%PDF-") === -1) return json({ esito: "formato", messaggio: "Il file non sembra un PDF: controlla di aver scelto quello giusto." }, 415);
  } else if (bytes[0] !== 0x30) {
    return json({ esito: "formato", messaggio: "Il file .p7m non è nel formato binario dei documenti firmati: salvalo di nuovo dal programma di firma, oppure carica il PDF." }, 415);
  }
  let verificato = false;
  if (bytes.length <= VERIFICA_MAX) {
    if (esadecimale(await crypto.subtle.digest("SHA-256", bytes)) !== sha) {
      return json({ esito: "impronta", messaggio: "Il file non è arrivato intero: riprova." }, 400);
    }
    verificato = true;
  }
  const ora = new Date();
  const giorno = ora.getUTCFullYear() + String(ora.getUTCMonth() + 1).padStart(2, "0") + String(ora.getUTCDate()).padStart(2, "0");
  const percorso = cartella + giorno + "-" + casuale(6) + "." + est;
  const svc = env.SUPABASE_SERVICE_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let url = "", scade = "";
  try {
    const up = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(percorso), {
      method: "POST",
      headers: { Authorization: "Bearer " + svc, apikey: svc, "Content-Type": ctl.mime === "application/pkcs7-mime" ? "application/pkcs7-mime" : "application/pdf", "x-upsert": "false" },
      body: bytes, signal: ctrl.signal
    });
    if (!up.ok) return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
    // collegamento firmato di 30 giorni: Make scarica la copia di passaggio solo da qui (CONTRATTO, deviazione D1)
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
  const r = await h.rpc(env, "sicurezza_documento_registra", { p_token: tok, p_commessa: c,
    p_dati: Object.assign({}, dati, { byte: bytes.length, percorso, url, url_scade: scade, verificato }) }, 15000).catch(() => null);
  // senza risposta il file resta: è sotto documenti/<cantiere>/, quindi si cancella comunque con i dati del cantiere
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Non so se il documento è stato registrato: ricarica la pagina prima di riprovare." }, 502);
  if (r.esito !== "ok") {
    await togli(env, percorso, c);
    return json(r, r.esito === "gettone" ? 403 : 200);
  }
  return json({ esito: "ok", id: r.id, superati: r.superati, scadenza: r.scadenza, verificato });
}

// Toglie dall'archivio una copia di passaggio di questo cantiere appena caricata (mai altro).
async function togli(env, percorso, c) {
  const p = String(percorso || "");
  if (!UUID.test(c) || !new RegExp("^documenti/" + c + "/sicurezza/[0-9]{8}-[0-9a-f]{12}\\.(pdf|p7m)$").test(p)) return false;
  try {
    const r = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(p), {
      method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } });
    return r.ok;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------- azioni sui documenti e sulle imprese
async function azione(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  if (Number(request.headers.get("Content-Length") || 0) > 20000) return json({ esito: "richiesta_non_valida" }, 413);
  let d = null;
  try { d = await request.json(); } catch (e) { d = null; }
  if (!d || typeof d !== "object") return json({ esito: "richiesta_non_valida" }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  const id = String(d.id || "").toLowerCase();
  const a = String(d.azione || "");
  const dati = d.dati && typeof d.dati === "object" && !Array.isArray(d.dati) ? d.dati : {};
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c)) return json({ esito: "richiesta_non_valida" }, 400);
  let r = null;
  if (["visto", "da_verificare", "ripristina", "dati"].indexOf(a) !== -1) {
    if (!UUID.test(id)) return json({ esito: "richiesta_non_valida" }, 400);
    r = await h.rpc(env, "sicurezza_documento_aggiorna", { p_token: tok, p_id: id, p_azione: a, p_dati: dati }, 15000).catch(() => null);
  } else if (a === "annulla") {
    if (!UUID.test(id)) return json({ esito: "richiesta_non_valida" }, 400);
    r = await h.rpc(env, "sicurezza_documento_annulla", { p_token: tok, p_id: id, p_motivo: testo(dati.motivo, 300), p_chi: testo(dati.chi, 120) }, 15000).catch(() => null);
  } else if (a === "impresa_salva") {
    r = await h.rpc(env, "sicurezza_impresa_salva", { p_token: tok, p_commessa: c, p_dati: dati }, 15000).catch(() => null);
  } else if (a === "impresa_togli") {
    r = await h.rpc(env, "sicurezza_impresa_togli", { p_token: tok, p_commessa: c, p_chiave: testo(dati.chiave, 160) }, 15000).catch(() => null);
  } else {
    return json({ esito: "richiesta_non_valida" }, 400);
  }
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
  const riprova = inUrl.searchParams.get("riprova") === "1";
  const giro = Math.max(0, Math.min(99, parseInt(inUrl.searchParams.get("n") || "0", 10) || 0));
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const e = h.esc;
  const torna = base + "/sicurezza?t=" + p.tok + "&c=" + p.c;
  const indietro = '<a class="btn" href="' + e(torna) + '">Torna alla Sicurezza del cantiere</a>';
  if (!UUID.test(p.c) || !UUID.test(id)) return h.risposta(h.foglio(base, "Documento non trovato", "", indietro), 404);
  const info = await h.rpc(env, "sicurezza_file_info", { p_token: p.tok, p_id: id }, 10000).catch(() => null);
  if (!info || typeof info !== "object") return h.risposta(h.foglio(base, "Documento", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (info.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (info.esito !== "ok" || String(info.commessa_id || "") !== p.c) return h.risposta(h.foglio(base, "Documento non trovato", "", indietro), 404);
  const radice = "documenti/" + p.c + "/sicurezza/";
  let cacheMancante = false, guasto = false;
  for (const [percorso, copia] of [[info.transito, "transito"], [info.cache, "cache"]]) {
    const ps = String(percorso || "");
    if (!ps || ps.indexOf(radice) !== 0 || ps.indexOf("..") !== -1) continue;
    const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(ps), {
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
    if (f && f.ok) return servi(f, info, scarica, metodo);
    // l'archivio risponde 400 o 404 quando la copia non c'è più; altri errori = archivio che non risponde
    if (f && (f.status === 400 || f.status === 404)) { if (copia === "cache") cacheMancante = true; }
    else guasto = true;
  }
  if (guasto) return h.risposta(h.foglio(base, "Documento", "Il file non si legge dall'archivio in questo momento: riprova tra un minuto.", indietro), 502);
  if (!info.drive) return h.risposta(h.foglio(base, "Documento", "Il file di questo documento non è disponibile in questo momento. Riprova tra qualche minuto.", indietro), 404);
  // c'è solo su Drive: si chiede a Make di riprenderlo (la sveglia la manda il database) e la pagina aspetta
  const qui = base + "/sicurezza/file?t=" + p.tok + "&c=" + p.c + "&id=" + id + (scarica ? "&scarica=1" : "");
  const rec = await h.rpc(env, "sicurezza_recupero_chiedi", { p_token: p.tok, p_id: id,
    p_dati: Object.assign({}, cacheMancante ? { cache_mancante: true } : {}, riprova ? { riprova: true } : {}) }, 10000).catch(() => null);
  if (!rec || typeof rec !== "object") return h.risposta(h.foglio(base, "Documento", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (rec.esito === "fallito") {
    return h.risposta(h.foglio(base, "Non riesco a riprenderlo dall'archivio", "Il documento è nell'archivio Drive di TIX, ma adesso non riesco a riprenderlo. Riprova tra qualche minuto; se non va, scrivici e lo recuperiamo noi.",
      '<a class="btn" href="' + e(qui + "&riprova=1") + '">Riprova</a><p class="piede"><a href="' + e(torna) + '">Torna alla Sicurezza del cantiere</a></p>'), 200);
  }
  if (rec.esito === "pronto" || rec.esito === "chiesto" || rec.esito === "in_corso") {
    if (giro >= ATTESA_GIRI) {
      return h.risposta(h.foglio(base, "Ci vuole più del solito", "L'archivio Drive sta rispondendo piano. Riprova tra qualche minuto.",
        '<a class="btn" href="' + e(qui) + '">Riprova</a><p class="piede"><a href="' + e(torna) + '">Torna alla Sicurezza del cantiere</a></p>'), 200);
    }
    const dopo = qui + "&n=" + (giro + 1);
    const pag = h.foglio(base, "Sto riprendendo il documento dall'archivio", "Ci vogliono 10–20 secondi: la pagina si aggiorna da sola e poi apre il documento.",
      '<p class="sc-giro" aria-hidden="true" style="text-align:center;font-size:1.6rem;margin:0 0 6px">&#8987;</p>' +
      '<p class="piede"><a href="' + e(torna) + '">Torna alla Sicurezza del cantiere</a></p>');
    return h.risposta(pag.replace("</head>", '<meta http-equiv="refresh" content="' + (rec.esito === "pronto" ? 0 : 4) + ";url=" + e(dopo) + '"></head>'), 200);
  }
  return h.risposta(h.foglio(base, "Documento", "Il file di questo documento non è disponibile in questo momento.", indietro), 404);
}

// Il tipo del file lo decide la riga del database, mai quello salvato nell'archivio (CONTRATTO, deviazione D2).
function servi(f, info, scarica, metodo) {
  const p7m = info.mime === "application/pkcs7-mime";
  const nome = String(info.nome || (p7m ? "documento.p7m" : "documento.pdf"));
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || (p7m ? "documento.p7m" : "documento.pdf");
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
const RUOLI = { affidataria: "impresa affidataria", subappaltatrice: "subappalto", autonomo: "artigiano autonomo", altra: "altra impresa" };
const SVG = {
  casco: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 15.5a7.5 7.5 0 0 1 15 0"/><path d="M2.5 15.5h19v1.4a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3z"/><path d="M12 8v4.8M8.6 9.4l.9 3.4M15.4 9.4l-.9 3.4"/></svg>',
  piu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  spunta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
  orologio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  triangolo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17.2v.1"/></svg>',
  cerchio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.1"/></svg>',
  su: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M7.5 9.5 12 5l4.5 4.5"/><path d="M5 19.5h14"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 17v-6M9.5 13.5 12 11l2.5 2.5"/></svg>',
  cartella: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
};

// data del documento (altrimenti del caricamento) per mettere in ordine le versioni: la più recente prima
function chiaveTempo(x) { return String(x.data || String(x.caricato_il || "").slice(0, 10)) + "|" + String(x.caricato_il || ""); }
function piuRecenti(a, b) { return chiaveTempo(a) < chiaveTempo(b) ? 1 : chiaveTempo(a) > chiaveTempo(b) ? -1 : 0; }

function pagina(base, h, p, d, torna) {
  const e = h.esc;
  const cant = d.cantiere || {};
  const T = {};
  lista(d.tipi).forEach((t) => { T[t.chiave] = t; });
  const imprese = lista(d.imprese);
  const IMP = {};
  imprese.forEach((i) => { IMP[i.chiave] = i; });
  const docs = lista(d.documenti);
  const vivi = docs.filter((x) => !x.annullato_il);
  const annullati = docs.filter((x) => x.annullato_il);
  const chiuso = !!d.chiuso;
  const cifre = d.cifre || {};
  const pre = (d.impostazioni && Number(d.impostazioni.preavviso_giorni)) || 30;
  const maxMb = (d.impostazioni && Number(d.impostazioni.max_mb)) || 25;

  // gruppi «stesso tipo, stessa impresa»: in vigore (dal più recente) e versioni superate, attaccate al più recente in vigore
  const gruppi = {};
  vivi.forEach((x) => {
    const k = x.tipo + "|" + (x.impresa_chiave || "");
    (gruppi[k] = gruppi[k] || { vigore: [], superati: [] })[x.stato === "superato" ? "superati" : "vigore"].push(x);
  });
  const versioni = {};
  const inVista = [];   // documenti da mostrare (in vigore, o superati rimasti senza un documento in vigore)
  Object.keys(gruppi).forEach((k) => {
    const g = gruppi[k];
    g.vigore.sort(piuRecenti); g.superati.sort(piuRecenti);
    if (g.vigore.length) { versioni[g.vigore[0].id] = g.superati; g.vigore.forEach((x) => inVista.push(x)); }
    else g.superati.forEach((x) => inVista.push(x));
  });
  inVista.sort(piuRecenti);
  const diTipo = (t) => inVista.filter((x) => x.tipo === t);
  const diImpresa = (t, k) => inVista.filter((x) => x.tipo === t && x.impresa_chiave === k);
  const ctx = { e, base, p, T, versioni, chiuso, cse: cant.cse || "" };

  // ---- testata, cifre, avvisi
  const ruoli = [cant.cse ? "CSE: <b>" + e(cant.cse) + "</b>" : "", cant.dl ? "Direzione Lavori: <b>" + e(cant.dl) + "</b>" : ""].filter(Boolean).join(" · ");
  const sottoTesta = [cant.nome || "", cant.impresa || ""].filter(Boolean).map(e).join(" · ");
  const scad = (Number(cifre.in_scadenza) || 0) + (Number(cifre.scaduti) || 0);
  const cifreHtml = '<div class="sc-cifre">' +
    '<div class="sc-c-ok"><b>' + e(cifre.presenti || 0) + "</b><span>Documenti presenti</span></div>" +
    '<div class="sc-c-dv"><b>' + e(cifre.da_verificare || 0) + "</b><span>Da verificare</span></div>" +
    '<div class="sc-c-sc"><b>' + e(scad) + "</b><span>" + (Number(cifre.scaduti) ? "Scaduti o in scadenza" : "In scadenza entro " + e(pre) + " giorni") + "</span></div>" +
    '<div class="sc-c-ro"><b>' + e(cifre.mancanti || 0) + "</b><span>Mancanti</span></div></div>";

  const avvisi = [];
  inVista.filter((x) => x.stato !== "superato" && (x.scadenza === "scaduto" || x.scadenza === "in_scadenza"))
    .sort((a, b) => String(a.scade).localeCompare(String(b.scade))).slice(0, 4).forEach((x) => {
      const nn = AVVISO_NOMI[x.tipo] || ["Il documento", 0];
      const cosa = nn[0] + (x.tipo === "altro" && x.titolo ? " «" + x.titolo + "»" : "") + (x.impresa ? " di " + x.impresa : "");
      const scaduto = x.scadenza === "scaduto";
      const pulsante = chiuso ? "" : '<button type="button" class="sc-btn sc-sm' + (scaduto ? " sc-rosso" : "") + '" data-carica="' + e(x.tipo + "|" + (x.impresa_chiave || "")) + '">Carica ' + e(x.tipo === "durc" ? "il DURC nuovo" : "quello nuovo") + "</button>";
      avvisi.push('<div class="sc-avv' + (scaduto ? " sc-avv-ro" : "") + '"><div class="sc-tx">' + (scaduto ? SVG.cerchio : SVG.triangolo) + "<span><b>" + e(cosa) +
        (scaduto ? " è scadut" + (nn[1] ? "a" : "o") + "</b> " + e(giornoSett(x.scade)) : " scade " + e(traGiorni(x.giorni)) + "</b>, " + e(giornoSett(x.scade))) + ". " +
        (x.impresa ? "Chiedi all'impresa quello nuovo e caricalo qui: l'avviso sparisce da solo." : "Quando hai quello nuovo, caricalo qui: l'avviso sparisce da solo.") + "</span></div>" + pulsante + "</div>");
    });
  const conManca = imprese.filter((i) => i.attiva && lista(i.manca).length);
  const NOMI_MANCA = { pos: "POS", itp: "idoneità tecnico-professionale", durc: "DURC" };
  const elenco = (a) => a.length > 1 ? a.slice(0, -1).join(", ") + " e " + a[a.length - 1] : a.join("");
  if (conManca.length && conManca.length <= 3) {
    conManca.forEach((i) => {
      const m = lista(i.manca).map((k) => NOMI_MANCA[k] || k);
      avvisi.push('<div class="sc-avv sc-avv-ro"><div class="sc-tx">' + SVG.cerchio + "<span><b>" + e(i.nome) + (i.dal ? " è nel cantiere dal " + e(dataIt(i.dal)) : "") + "</b>" +
        (i.dal ? " e" : ":") + " in TIX " + (m.length > 1 ? "mancano ancora " : "manca ancora ") + e(elenco(m)) + ".</span></div>" +
        (chiuso ? "" : '<button type="button" class="sc-btn sc-sm sc-rosso" data-carica="' + e(lista(i.manca)[0] + "|" + i.chiave) + '">Carica i documenti</button>') + "</div>");
    });
  } else if (conManca.length > 3) {
    const nomi = conManca.slice(0, 3).map((i) => i.nome);
    avvisi.push('<div class="sc-avv sc-avv-ro"><div class="sc-tx">' + SVG.cerchio + "<span><b>" + e(conManca.length) + " imprese</b> non hanno ancora in TIX tutti i documenti: " +
      e(nomi.join(", ")) + (conManca.length > 3 ? " e altre " + e(conManca.length - 3) : "") + ". Le trovi qui sotto, con «Manca».</span></div></div>");
  }

  const filtri = '<div class="sc-filtri" role="group" aria-label="Mostra">' +
    '<button type="button" class="sc-on" aria-pressed="true" data-f="">Tutti <i>' + e(cifre.presenti || 0) + "</i></button>" +
    '<button type="button" aria-pressed="false" data-f="dv">Da verificare <i>' + e(cifre.da_verificare || 0) + "</i></button>" +
    '<button type="button" aria-pressed="false" data-f="sc">In scadenza <i>' + e(scad) + "</i></button>" +
    '<button type="button" aria-pressed="false" data-f="mn">Mancanti <i>' + e(cifre.mancanti || 0) + "</i></button>" +
    '<button type="button" aria-pressed="false" data-f="sup">Versioni superate <i>' + e(cifre.superati || 0) + "</i></button></div>";

  // ---- le otto sezioni
  const vuoto = (testoVuoto, tipo) => '<p class="sc-vuoto">' + e(testoVuoto) + (chiuso ? "" : ' <button type="button" class="sc-lk" data-carica="' + e(tipo) + '|">+ Carica</button>') + "</p>";
  const carte = (t, testoVuoto) => { const a = diTipo(t); return a.length ? a.map((x) => carta(ctx, x, true)).join("") : vuoto(testoVuoto, t); };
  const sez = (n, titolo, piccolo, corpo, nota) => '<section class="sc-sez" aria-label="' + e(titolo) + '"><h2><span class="sc-n">' + n + '</span><span class="sc-h2t">' + e(titolo) + "</span>" +
    (piccolo ? " <small>" + e(piccolo) + "</small>" : "") + "</h2>" + corpo + (nota ? '<p class="sc-nota">' + nota + "</p>" : "") + "</section>";

  // imprese da mostrare nelle tabelle: quelle nell'elenco, più quelle tolte che hanno documenti di quel tipo
  const impreseDi = (tipi) => imprese.filter((i) => i.attiva || tipi.some((t) => diImpresa(t, i.chiave).length));
  const docSenzaImpresa = (t) => inVista.filter((x) => x.tipo === t && !(x.impresa_chiave && IMP[x.impresa_chiave]));

  // 3. POS delle imprese
  let righePos = "";
  impreseDi(["pos"]).forEach((i) => {
    const a = diImpresa("pos", i.chiave);
    const testaImp = impresaCella(ctx, i);
    if (!a.length) {
      const manca = i.attiva && i.pos === "richiesto";
      righePos += '<div class="sc-riga' + (manca ? " sc-manca" : "") + '" data-fx="' + (manca ? "mn" : "") + '">' + testaImp +
        '<div class="sc-c-doc">—<span>' + (manca ? "nessun POS in TIX" : i.pos === "richiesto" ? "nessun POS in TIX" : "POS non richiesto per questa impresa") + "</span></div>" +
        '<div class="sc-c-st">' + (manca ? '<span class="sc-st sc-man">Manca</span>' : i.pos === "richiesto" ? "" : '<span class="sc-st sc-nr">POS non richiesto</span>') + "</div>" +
        '<div class="sc-c-az">' + (manca && !chiuso ? '<button type="button" class="sc-btn sc-sm sc-pr" data-carica="pos|' + e(i.chiave) + '">Carica il POS</button>' : "") + "</div></div>";
    } else {
      a.forEach((x) => { righePos += rigaDoc(ctx, x, testaImp, (x.versione ? x.versione + " " : "") + (x.data ? "del " + dataIt(x.data) : "senza data")); });
    }
  });
  docSenzaImpresa("pos").forEach((x) => { righePos += rigaDoc(ctx, x, '<div class="sc-imp"><b>' + e(x.impresa || "Impresa") + "</b></div>", (x.versione ? x.versione + " " : "") + (x.data ? "del " + dataIt(x.data) : "")); });
  const tolte = imprese.filter((i) => !i.attiva);
  const piedePos = '<div class="sc-piede"><span>L\'elenco parte dall\'impresa del cantiere, dalle imprese subappaltatrici e dagli artigiani autonomi di «Persone del cantiere» e dalle imprese che hanno già documenti. «Manca» vuol dire che in TIX non c\'è ancora.' +
    (tolte.length ? " Tolte dall'elenco: " + tolte.map((i) => '<button type="button" class="sc-lk" data-az="impresa" data-imp="' + e(i.chiave) + '">' + e(i.nome) + "</button>").join(", ") + "." : "") + "</span>" +
    (chiuso ? "" : '<button type="button" class="sc-lk" data-az="impresa" data-imp="">+ Aggiungi un\'impresa</button>') + "</div>";
  const pos = '<div class="sc-righe"><div class="sc-riga sc-th" aria-hidden="true"><span>Impresa</span><span>POS</span><span>Stato</span><span></span></div>' +
    (righePos || '<p class="sc-vuoto sc-in">Nessuna impresa nell\'elenco.</p>') + piedePos + "</div>";

  // 5. Verbali del CSE
  const verbali = diTipo("verbale_cse");
  const righeVerbali = verbali.map((x) => rigaDoc(ctx, x, null, null, true)).join("");

  // 7. Idoneità tecnico-professionale e DURC
  let righeId = "";
  impreseDi(["itp", "durc"]).forEach((i) => {
    const celle = ["itp", "durc"].map((t) => cellaId(ctx, i, t, diImpresa(t, i.chiave)));
    const fxr = celle.map((c) => c.fx).join(" ").trim();
    righeId += '<div class="sc-riga sc-id' + (celle.some((c) => c.manca) ? " sc-manca" : "") + '" data-fx="' + e(fxr) + '">' + impresaCella(ctx, i) + celle.map((c) => c.html).join("") + "</div>" +
      celle.map((c) => c.det).join("");
  });
  ["itp", "durc"].forEach((t) => docSenzaImpresa(t).forEach((x) => { righeId += rigaDoc(ctx, x, '<div class="sc-imp"><b>' + e(x.impresa || "Impresa") + "</b><span>" + e((T[t] || {}).breve || "") + "</span></div>", x.data ? "del " + dataIt(x.data) : ""); }));
  const idoneita = '<div class="sc-righe"><div class="sc-riga sc-id sc-th" aria-hidden="true"><span>Impresa</span><span>Idoneità tecnico-professionale</span><span>DURC</span></div>' +
    (righeId || '<p class="sc-vuoto sc-in">Nessuna impresa nell\'elenco.</p>') + "</div>";

  const sezioni =
    sez(1, "Piano di Sicurezza e Coordinamento", "PSC", carte("psc", "Nessun PSC in TIX.")) +
    sez(2, "Notifica preliminare", "con gli aggiornamenti", carte("notifica", "Nessuna notifica preliminare in TIX.")) +
    sez(3, "POS delle imprese", "uno per impresa", pos) +
    sez(4, "PiMUS", "ponteggi", carte("pimus", "Nessun PiMUS in TIX.")) +
    sez(5, "Verbali del CSE", "coordinamento e sopralluogo", verbali.length ? '<div class="sc-righe">' + righeVerbali + "</div>" : vuoto("Nessun verbale del CSE in TIX.", "verbale_cse"),
      verbali.length ? "I verbali restano tutti: uno nuovo non prende il posto di quello di prima." : "") +
    sez(6, "Piano di emergenza", "", carte("piano_emergenza", "Nessun piano di emergenza in TIX.")) +
    sez(7, "Idoneità e DURC delle imprese", "", idoneita, "Per il DURC TIX propone la scadenza a 120 giorni dalla data del documento: puoi cambiarla quando lo carichi.") +
    sez(8, "Altri documenti", "", carte("altro", "Nessun altro documento in TIX."));

  const annullatiHtml = annullati.length ? '<details class="sc-annullati"><summary>Documenti annullati (' + annullati.length + ")</summary>" +
    annullati.map((x) => '<div class="sc-vp-r"><span><b>' + e(titoloDoc(T, x)) + "</b>" + (x.versione ? " · " + e(x.versione) : "") + (x.data ? " · documento del " + e(dataIt(x.data)) : "") +
      "<br>Annullato da " + e(x.annullato_da || "-") + " il " + e(quando(x.annullato_il)) + " · motivo: «" + e(x.annullato_motivo || "") + "»</span>" +
      (x.apri !== "no" ? '<a class="sc-btn sc-sm sc-tenue" href="' + e(fileUrl(ctx, x)) + '" target="_blank" rel="noopener">Apri</a>' : "") + "</div>").join("") +
    '<p class="sc-nota">Un documento annullato non si cancella: resta qui, con il motivo.</p></details>' : "";

  // ---- modulo «Aggiungi documento»
  const opzTipi = lista(d.tipi).map((t) => '<option value="' + e(t.chiave) + '">' + e(t.etichetta) + "</option>").join("");
  const modulo = chiuso ? "" :
    '<section class="sc-form" id="aggiungi" aria-label="Aggiungi documento"><h3><span class="sc-ic-mini" aria-hidden="true">' + SVG.su + "</span>Aggiungi documento</h3>" +
    '<p class="sc-sotto">Scegli il tipo e l\'impresa, poi il PDF. Se c\'è già un documento dello stesso tipo per la stessa impresa, quello di prima diventa «Superato» e resta tra le versioni precedenti.</p>' +
    '<form id="sc-f" novalidate><div class="sc-campi">' +
    '<div class="sc-c3"><label for="f-tipo">Tipo di documento</label><select id="f-tipo"><option value="">Scegli il tipo…</option>' + opzTipi + "</select></div>" +
    '<div class="sc-c3" id="f-imp-box"><label for="f-imp" id="f-imp-et">Impresa</label><select id="f-imp"></select>' +
    '<div class="sc-altra" id="f-altra" hidden><input id="f-altra-nome" maxlength="160" placeholder="Nome dell\'impresa" autocomplete="off">' +
    '<select id="f-altra-ruolo" aria-label="Rapporto con il cantiere"><option value="subappaltatrice">Impresa subappaltatrice</option><option value="autonomo">Artigiano autonomo</option><option value="altra">Altra impresa</option></select></div>' +
    '<p class="sc-aiuto">Non è nell\'elenco? Scegli «+ Altra impresa».</p></div>' +
    '<div class="sc-c6" id="f-tit-box"><label for="f-tit">Titolo <small>(facoltativo)</small></label><input id="f-tit" maxlength="200" placeholder="Per esempio: Verbale di coordinamento n. 3"></div>' +
    '<div class="sc-c2"><label for="f-ver">Versione o revisione <small>(se c\'è)</small></label><input id="f-ver" maxlength="60" placeholder="rev. 1" autocomplete="off"></div>' +
    '<div class="sc-c2"><label for="f-data">Data del documento</label><input type="date" id="f-data"></div>' +
    '<div class="sc-c2"><label for="f-scad">Scadenza <small>(se c\'è)</small></label><input type="date" id="f-scad"><p class="sc-aiuto" id="f-scad-aiuto" hidden>Per il DURC la propone TIX: 120 giorni dalla data.</p></div>' +
    '<div class="sc-c6"><span class="sc-et">File</span><div class="sc-drop" id="f-drop">' +
    '<label class="sc-scegli" for="f-file">' + SVG.file + "<span>Trascina qui il PDF o scegli il file<small>PDF, anche firmato (.p7m), fino a " + e(maxMb) + " MB</small></span></label>" +
    '<input type="file" id="f-file" class="sc-nascosto" accept=".pdf,.p7m,application/pdf,application/pkcs7-mime">' +
    '<div class="sc-file" id="f-scelto" hidden></div></div></div>' +
    '<div class="sc-c6"><label for="f-nota">Note <small>(facoltative)</small></label><textarea id="f-nota" maxlength="1000" rows="2" placeholder="Per esempio: consegnato a mano in cantiere dal titolare"></textarea></div>' +
    '<div class="sc-c3"><label for="f-chi">Il tuo nome</label><input id="f-chi" maxlength="120" autocomplete="name" placeholder="Nome e cognome"><p class="sc-aiuto">Resta scritto chi ha caricato il documento.</p></div>' +
    "</div>" +
    '<div class="sc-archivio">' + SVG.cartella + "<span>Il file va nella cartella «Sicurezza» del cantiere, nell'archivio Drive di TIX, e parte come «Da verificare». Il tuo dispositivo calcola l'impronta SHA-256 prima di mandarlo.</span></div>" +
    '<div class="sc-prog" id="f-prog" hidden><i></i></div><p class="sc-msg" id="f-msg" aria-live="polite"></p>' +
    '<div class="sc-form-az"><button type="reset" class="sc-btn sc-tenue">Svuota</button><button type="submit" class="sc-btn sc-pr" id="f-invia">Carica nella Sicurezza</button></div></form></section>';

  // ---- dati per lo script della pagina (moduli e finestre)
  const cfg = JSON.stringify({
    u: base + "/sicurezza", t: p.tok, c: p.c, max: maxMb, oggi: d.oggi || "", cse: cant.cse || "", chiuso,
    tipi: lista(d.tipi).map((t) => ({ k: t.chiave, e: t.etichetta, b: t.breve, pi: !!t.per_impresa, fa: !!t.impresa_facoltativa, sg: t.scadenza_giorni || 0 })),
    imprese: imprese.map((i) => ({ k: i.chiave, n: i.nome, r: i.ruolo, p: i.pos, a: !!i.attiva, l: i.lavorazione || "" })),
    docs: Object.fromEntries(vivi.map((x) => [x.id, { n: titoloDoc(T, x), tipo: x.tipo, ik: x.impresa_chiave || "", imp: x.impresa || "", tit: x.titolo || "",
      ver: x.versione || "", data: x.data || "", scad: x.scade || "", nota: x.nota || "" }]))
  }).replace(/</g, "\\u003c");

  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>Sicurezza del cantiere - TIX · Diario di cantiere</title>" + h.testa(base) +
    "<style>" + STILE + "</style></head><body><main>" +
    '<a class="sc-torna" href="' + e(torna) + '">‹ Torna al cantiere</a>' +
    '<div class="sc-card">' +
    (d.modo === "prova" ? '<p class="sc-prova">Sezione in prova: per ora la vedi solo tu.</p>' : "") +
    '<div class="sc-testa"><div><p class="sc-chi">' + sottoTesta + "</p>" +
    '<h1><span class="sc-ic-sic" aria-hidden="true">' + SVG.casco + "</span>Sicurezza del cantiere</h1>" +
    (ruoli ? '<p class="sc-ruoli">' + ruoli + "</p>" : "") + "</div>" +
    (chiuso ? "" : '<div class="sc-az-testa"><button type="button" class="sc-btn sc-pr" data-carica="|">' + SVG.piu + "Aggiungi documento</button></div>") + "</div>" +
    '<p class="sc-agg"><b>Aggiornato a oggi</b>, ' + e(giornoLungo(d.oggi)) + ", alle " + e(d.ora || "") + "</p>" +
    (chiuso ? '<p class="sc-chiuso">Cantiere chiuso: i documenti si consultano e si scaricano, non se ne caricano di nuovi.</p>' : "") +
    cifreHtml + (chiuso ? "" : avvisi.join("")) + filtri + sezioni + annullatiHtml + modulo +
    '<p class="sc-fonti">Ogni documento ha la sua impronta SHA-256, calcolata quando lo carichi e confrontata con la copia nell\'archivio Drive: se il file cambia anche di poco, l\'impronta non torna più. ' +
    "TIX conserva i documenti, li tiene in ordine e ti ricorda le scadenze; il contenuto lo valuta chi li riceve. «Visto dal CSE» è un'etichetta che mette la tua impresa: non è la firma del CSE.</p>" +
    "</div></main>" + finestre(ctx) +
    '<div class="sc-toast" id="sc-toast" role="status" hidden></div>' +
    "<script>" + SCRIPT.replace("__CFG__", cfg) + "</script></body></html>";
}

// Titolo della scheda: per verbali e altri documenti il titolo scritto; per gli altri il tipo (e l'impresa), il titolo va sotto.
function titoloDoc(T, x) {
  const t = T[x.tipo] || {};
  if (x.tipo === "verbale_cse" || x.tipo === "altro") {
    return (x.titolo || t.etichetta || "Documento") + (x.tipo === "altro" && x.impresa ? " · " + x.impresa : "");
  }
  if (x.tipo === "psc" || x.tipo === "notifica" || x.tipo === "piano_emergenza") return t.etichetta || "Documento";
  return (t.breve || t.etichetta || "Documento") + (x.impresa ? " · " + x.impresa : "");
}
// soggetto degli avvisi di scadenza: [come si chiama, femminile]
const AVVISO_NOMI = { psc: ["Il PSC", 0], notifica: ["La notifica preliminare", 1], pos: ["Il POS", 0], pimus: ["Il PiMUS", 0], verbale_cse: ["Il verbale del CSE", 0],
  piano_emergenza: ["Il piano di emergenza", 0], itp: ["L'idoneità tecnico-professionale", 1], durc: ["Il DURC", 0], altro: ["Il documento", 0] };
function fileUrl(ctx, x, scarica) {
  return ctx.base + "/sicurezza/file?t=" + ctx.p.tok + "&c=" + ctx.p.c + "&id=" + x.id + (scarica ? "&scarica=1" : "");
}
function statoChip(ctx, x) {
  if (x.stato === "visto_cse") {
    return '<span class="sc-st sc-vis" title="' + ctx.e("Segnato da " + (x.stato_da || "-") + (x.visto_da ? " · CSE: " + x.visto_da : "") + ". È un'etichetta dell'impresa, non la firma del CSE.") + '">' +
      SVG.spunta + "Visto dal CSE" + (x.visto_il ? " · " + ctx.e(ggmm(x.visto_il)) : "") + "</span>";
  }
  if (x.stato === "superato") return '<span class="sc-st sc-sup">Superato' + (x.superato_il ? " il " + ctx.e(dataIt(x.superato_il)) : "") + "</span>";
  return '<span class="sc-st sc-dv">Da verificare</span>';
}
function scadChip(ctx, x) {
  if (!x.scade) return "";
  if (x.scadenza === "scaduto") return '<span class="sc-st sc-ro">' + SVG.orologio + "Scaduto il " + ctx.e(dataIt(x.scade)) + "</span>";
  if (x.scadenza === "in_scadenza") return '<span class="sc-st sc-scad">' + SVG.orologio + "Scade " + ctx.e(traGiorni(x.giorni)) + "</span>";
  return '<span class="sc-st sc-ok">Valido fino al ' + ctx.e(dataIt(x.scade)) + "</span>";
}
function archivio(x) {
  if (x.archivio === "archiviato") return x.impronta === "uguale" ? '<span class="sc-arch sc-arch-ok">✓&nbsp;Archiviato su Drive · impronta verificata</span>' : '<span class="sc-arch sc-arch-ok">Archiviato su Drive</span>';
  if (x.archivio === "errore") return '<span class="sc-arch sc-arch-e">Archivio su Drive da ricontrollare: il file resta in TIX, ce ne occupiamo noi</span>';
  if (x.annullato_il) return '<span class="sc-arch">Annullato prima dell\'archivio su Drive</span>';
  return x.archivio_riprova ? '<span class="sc-arch sc-arch-r">Errore di archiviazione: TIX riprova da solo</span>' : '<span class="sc-arch">In archiviazione su Drive…</span>';
}
function fx(ctx, x) {
  const a = [];
  if (x.stato === "da_verificare") a.push("dv");
  if (x.stato !== "superato" && (x.scadenza === "in_scadenza" || x.scadenza === "scaduto")) a.push("sc");
  if ((ctx.versioni[x.id] || []).length) a.push("sup");
  return a.join(" ");
}

// Scheda completa di un documento: dati, impronta, archivio, stato, azioni e versioni precedenti.
function carta(ctx, x, sola) {
  const e = ctx.e, t = ctx.T[x.tipo] || {};
  const vers = ctx.versioni[x.id] || [];
  const meta1 = [x.titolo && t.versioni ? "«" + e(x.titolo) + "»" : "", x.data ? "Documento del <b>" + e(dataIt(x.data)) + "</b>" : "Senza data del documento",
    x.scade ? "scade il <b>" + e(dataIt(x.scade)) + "</b>" : (x.tipo === "durc" ? "scadenza non indicata" : "senza scadenza")].filter(Boolean).join(" · ");
  const p7m = x.mime === "application/pkcs7-mime";
  const sha = String(x.sha256 || "");
  const azioni = [];
  if (x.apri !== "no") azioni.push('<a class="sc-btn sc-sm" href="' + e(fileUrl(ctx, x, p7m)) + '" target="_blank" rel="noopener"' +
    (x.apri === "archivio" ? ' title="Si riprende dall\'archivio Drive: qualche secondo"' : "") + ">" + (p7m ? "Scarica il .p7m" : "Apri il PDF") + "</a>");
  if (!ctx.chiuso && x.stato === "da_verificare") azioni.push('<button type="button" class="sc-btn sc-sm sc-sic" data-az="visto" data-id="' + e(x.id) + '">Visto dal CSE</button>');
  if (!ctx.chiuso && x.stato === "superato") azioni.push('<button type="button" class="sc-btn sc-sm sc-tenue" data-az="ripristina" data-id="' + e(x.id) + '">Rimetti in vigore</button>');
  const altro = [];
  if (x.apri !== "no" && !p7m) altro.push('<a href="' + e(fileUrl(ctx, x, true)) + '">Scarica</a>');
  if (!ctx.chiuso) {
    if (x.stato === "visto_cse") altro.push('<button type="button" data-az="togli-visto" data-id="' + e(x.id) + '">Togli «Visto dal CSE»</button>');
    altro.push('<button type="button" data-az="modifica" data-id="' + e(x.id) + '">Modifica dati</button>');
    if (t.versioni && x.stato !== "superato") altro.push('<button type="button" data-az="nuova" data-id="' + e(x.id) + '">Nuova versione</button>');
    altro.push('<button type="button" class="sc-rosso" data-az="annulla" data-id="' + e(x.id) + '">Annulla il documento</button>');
  }
  if (altro.length) azioni.push('<details class="sc-altro"><summary class="sc-btn sc-sm sc-tenue">Altro</summary><div class="sc-menu">' + altro.join("") + "</div></details>");
  const vp = vers.length ? '<details class="sc-vp"><summary>Versioni precedenti (' + vers.length + ")</summary>" + vers.map((v) =>
    '<div class="sc-vp-r" id="d-' + e(v.id) + '"><span><b>' + e(v.versione || "versione senza nome") + "</b>" + (v.data ? " · documento del " + e(dataIt(v.data)) : "") +
    " · caricato da " + e(v.caricato_da || "-") + " il " + e(dataIt(v.caricato_il)) + "</span><span class=\"sc-vp-az\">" + statoChip(ctx, v) +
    (v.apri !== "no" ? '<a class="sc-btn sc-sm sc-tenue" href="' + e(fileUrl(ctx, v, v.mime === "application/pkcs7-mime")) + '" target="_blank" rel="noopener">Apri</a>' : "") +
    (ctx.chiuso ? "" : '<button type="button" class="sc-btn sc-sm sc-tenue" data-az="ripristina" data-id="' + e(v.id) + '">Rimetti in vigore</button>') + "</span></div>").join("") + "</details>" : "";
  return '<article class="sc-doc" id="d-' + e(x.id) + '"' + (sola ? ' data-fx="' + fx(ctx, x) + '"' : "") + "><div>" +
    '<p class="sc-tit">' + e(titoloDoc(ctx.T, x)) + (x.versione ? ' <span class="sc-rev">' + e(x.versione) + "</span>" : "") + "</p>" +
    '<p class="sc-meta">' + meta1 + "</p>" +
    '<p class="sc-meta" title="' + e(x.accesso ? "Accesso: " + x.accesso : "") + '">Caricato da <b>' + e(x.caricato_da || "-") + "</b> il " + e(quando(x.caricato_il)) + " · " + (p7m ? "PDF firmato (.p7m)" : "PDF") + ", " + e(mb(x.byte)) + "</p>" +
    '<p class="sc-meta">Impronta SHA-256 <button type="button" class="sc-impr" data-sha="' + e(sha) + '" title="Copia l\'impronta intera">' + e(sha.slice(0, 12)) + "…</button> · " + archivio(x) + "</p>" +
    (x.nota ? '<p class="sc-meta sc-nota-doc">Nota: ' + e(x.nota) + "</p>" : "") +
    "</div>" +
    '<div class="sc-lato">' + (x.scadenza === "in_scadenza" || x.scadenza === "scaduto" ? scadChip(ctx, x) : "") + statoChip(ctx, x) +
    '<div class="sc-az">' + azioni.join("") + "</div></div>" + vp + "</article>";
}

// Riga compatta (POS, verbali, documenti senza impresa) con «Dettagli» che apre la scheda completa sotto la riga.
function rigaDoc(ctx, x, testaImp, sottoTitolo, verbale) {
  const e = ctx.e;
  const p7m = x.mime === "application/pkcs7-mime";
  const doc = verbale
    ? '<div class="sc-c-doc"><b>' + e(x.titolo || "Verbale del CSE") + "</b><span>caricato da " + e(x.caricato_da || "-") + " il " + e(dataIt(x.caricato_il)) + "</span></div>" +
      '<div class="sc-imp"><span>' + e(x.data ? dataIt(x.data) : "senza data") + "</span></div>"
    : testaImp + '<div class="sc-c-doc">' + e(sottoTitolo || "") + "<span>caricato da " + e(x.caricato_da || "-") + " il " + e(dataIt(x.caricato_il)) + "</span></div>";
  const fxx = fx(ctx, x);
  return '<div class="sc-riga' + (verbale ? " sc-vb" : "") + '" data-fx="' + fxx + '">' + doc +
    '<div class="sc-c-st">' + (x.scadenza === "in_scadenza" || x.scadenza === "scaduto" ? scadChip(ctx, x) : "") + statoChip(ctx, x) + "</div>" +
    '<div class="sc-c-az">' + (x.apri !== "no" ? '<a class="sc-btn sc-sm" href="' + e(fileUrl(ctx, x, p7m)) + '" target="_blank" rel="noopener">' + (p7m ? "Scarica" : "Apri") + "</a>" : "") +
    '<button type="button" class="sc-btn sc-sm sc-tenue" data-az="det" data-id="' + e(x.id) + '" aria-expanded="false">Dettagli</button></div></div>' +
    '<div class="sc-det" id="det-' + e(x.id) + '" data-fx="' + fxx + '" hidden>' + carta(ctx, x, false) + "</div>";
}

function impresaCella(ctx, i) {
  const e = ctx.e;
  const sotto = [RUOLI[i.ruolo] || "", i.lavorazione || "", !i.attiva ? "tolta dall'elenco" : ""].filter(Boolean).join(" · ");
  return '<div class="sc-imp"><b>' + e(i.nome) + "</b><span>" + e(sotto) +
    (ctx.chiuso ? "" : ' <button type="button" class="sc-lk" data-az="impresa" data-imp="' + e(i.chiave) + '">Modifica</button>') + "</span></div>";
}

// Cella «Idoneità» o «DURC» della tabella delle imprese.
function cellaId(ctx, i, t, docs) {
  const e = ctx.e;
  const et = t === "itp" ? "Idoneità" : "DURC";
  if (!docs.length) {
    const manca = !!i.attiva;
    return { manca, fx: manca ? "mn" : "", det: "",
      html: '<div class="sc-cel" data-et="' + et + '">' + (manca ? '<span class="sc-st sc-man">Manca</span>' + (ctx.chiuso ? "" : '<button type="button" class="sc-lk" data-carica="' + e(t + "|" + i.chiave) + '">Carica</button>') : "—") + "</div>" };
  }
  const x = docs[0];
  const p7m = x.mime === "application/pkcs7-mime";
  const chip = t === "durc" && x.scade ? scadChip(ctx, x) : statoChip(ctx, x);
  const riga2 = [x.data ? "documento del " + dataIt(x.data) : "caricato il " + dataIt(x.caricato_il),
    t === "durc" && x.stato === "da_verificare" ? "da verificare" : t === "durc" && x.stato === "visto_cse" ? "visto dal CSE" : ""].filter(Boolean).join(" · ");
  const html = '<div class="sc-cel" data-et="' + et + '">' + chip + "<span>" + e(riga2) + (docs.length > 1 ? " · e altri " + (docs.length - 1) : "") + "</span>" +
    '<span class="sc-riga-az">' + (x.apri !== "no" ? '<a class="sc-lk" href="' + e(fileUrl(ctx, x, p7m)) + '" target="_blank" rel="noopener">' + (p7m ? "Scarica" : "Apri") + "</a>" : "") +
    '<button type="button" class="sc-lk" data-az="det" data-id="' + e(x.id) + '" aria-expanded="false">Dettagli</button>' +
    (t === "durc" && (x.scadenza === "in_scadenza" || x.scadenza === "scaduto") && !ctx.chiuso ? '<button type="button" class="sc-lk" data-carica="durc|' + e(i.chiave) + '">Carica il nuovo</button>' : "") + "</span></div>";
  const det = docs.map((y) => '<div class="sc-det" id="det-' + e(y.id) + '" data-fx="' + fx(ctx, y) + '" hidden>' + carta(ctx, y, false) + "</div>").join("");
  const f = docs.map((y) => fx(ctx, y)).join(" ").trim();
  return { manca: false, fx: f, det, html };
}

// Finestre: «Visto dal CSE», «Modifica dati», «Annulla il documento», impresa del cantiere.
function finestre(ctx) {
  if (ctx.chiuso) return "";
  const chi = '<label for="__-chi">Il tuo nome</label><input id="__-chi" maxlength="120" autocomplete="name" placeholder="Nome e cognome">';
  const pie = (id, si, rosso) => '<p class="sc-msg" id="' + id + '-msg" aria-live="polite"></p><div class="sc-dlg-az"><button type="button" class="sc-btn sc-tenue" data-chiudi>Chiudi</button>' +
    '<button type="button" class="sc-btn ' + (rosso ? "sc-rosso-p" : "sc-pr") + '" id="' + id + '-si">' + si + "</button></div>";
  return '<dialog class="sc-dlg" id="sc-dv" aria-labelledby="dv-h"><h3 id="dv-h">Visto dal CSE</h3><p class="sc-dlg-sotto" id="dv-tit"></p>' +
    '<p class="sc-dlg-nota">È un\'etichetta che metti tu, per ricordare che il CSE ha visto il documento: non è la firma del CSE.</p>' +
    '<label for="dv-il">Il giorno</label><input type="date" id="dv-il"><label for="dv-da">Nome del CSE</label><input id="dv-da" maxlength="120" placeholder="Per esempio: ing. Paolo Ferri">' +
    chi.replace(/__/g, "dv") + pie("dv", "Segna «Visto dal CSE»") + "</dialog>" +
    '<dialog class="sc-dlg" id="sc-dm" aria-labelledby="dm-h"><h3 id="dm-h">Modifica dati</h3><p class="sc-dlg-sotto" id="dm-tit"></p>' +
    '<label for="dm-tipo">Tipo di documento</label><select id="dm-tipo"></select>' +
    '<div id="dm-imp-box"><label for="dm-imp" id="dm-imp-et">Impresa</label><select id="dm-imp"></select>' +
    '<div class="sc-altra" id="dm-altra" hidden><input id="dm-altra-nome" maxlength="160" placeholder="Nome dell\'impresa" autocomplete="off">' +
    '<select id="dm-altra-ruolo" aria-label="Rapporto con il cantiere"><option value="subappaltatrice">Impresa subappaltatrice</option><option value="autonomo">Artigiano autonomo</option><option value="altra">Altra impresa</option></select></div></div>' +
    '<label for="dm-tit-in">Titolo <small>(facoltativo)</small></label><input id="dm-tit-in" maxlength="200">' +
    '<div class="sc-dlg-2"><div><label for="dm-ver">Versione</label><input id="dm-ver" maxlength="60"></div><div><label for="dm-data">Data del documento</label><input type="date" id="dm-data"></div></div>' +
    '<label for="dm-scad">Scadenza <small>(se c\'è)</small></label><input type="date" id="dm-scad">' +
    '<label for="dm-nota">Note</label><textarea id="dm-nota" maxlength="1000" rows="2"></textarea>' +
    chi.replace(/__/g, "dm") + pie("dm", "Salva") + "</dialog>" +
    '<dialog class="sc-dlg" id="sc-da" aria-labelledby="da-h"><h3 id="da-h">Annulla il documento</h3><p class="sc-dlg-sotto" id="da-tit"></p>' +
    '<p class="sc-dlg-nota">Il documento non si cancella: resta in fondo alla pagina, tra i documenti annullati, con il motivo e il tuo nome. Se aveva preso il posto di una versione precedente, quella torna in vigore.</p>' +
    '<label for="da-mot">Motivo</label><textarea id="da-mot" maxlength="300" rows="2" placeholder="Per esempio: caricato per errore, era di un altro cantiere"></textarea>' +
    chi.replace(/__/g, "da") + pie("da", "Annulla il documento", true) + "</dialog>" +
    '<dialog class="sc-dlg" id="sc-di" aria-labelledby="di-h"><h3 id="di-h">Impresa del cantiere</h3><p class="sc-dlg-nota" id="di-nota"></p>' +
    '<label for="di-nome">Nome dell\'impresa</label><input id="di-nome" maxlength="160" autocomplete="off">' +
    '<label for="di-ruolo">Rapporto con il cantiere</label><select id="di-ruolo"><option value="affidataria">Impresa affidataria</option><option value="subappaltatrice">Impresa subappaltatrice</option><option value="autonomo">Artigiano autonomo</option><option value="altra">Altra impresa</option></select>' +
    '<label for="di-lav">Lavorazione <small>(facoltativa)</small></label><input id="di-lav" maxlength="120" placeholder="Per esempio: ponteggi">' +
    '<span class="sc-et">POS</span><div class="sc-radio"><label><input type="radio" name="di-pos" value="richiesto"> Richiesto</label><label><input type="radio" name="di-pos" value="non_richiesto"> Non richiesto</label></div>' +
    '<p class="sc-aiuto">Gli artigiani autonomi senza dipendenti di solito non hanno il POS: per loro TIX parte da «Non richiesto». Decidi tu.</p>' +
    chi.replace(/__/g, "di") +
    '<p class="sc-msg" id="di-msg" aria-live="polite"></p><div class="sc-dlg-az"><button type="button" class="sc-btn sc-rosso" id="di-togli">Togli dall\'elenco</button>' +
    '<button type="button" class="sc-btn sc-tenue" data-chiudi>Chiudi</button><button type="button" class="sc-btn sc-pr" id="di-si">Salva</button></div></dialog>';
}

const STILE =
  ":root{color-scheme:light;--navy:#1B2F4A;--sic:#087F5B;--sic-2:#0CA678;--sic-s:#065F46;--sic-f:#E6F7EF;--sic-b:#9FDCC4;--t:#17212E;--s:#5B6672;--c:#FFFFFF;--z:#F5F7FA;--l:rgba(16,27,43,.11);" +
  "--dv-f:#FFF3E8;--dv:#9A4308;--dv-b:#F7B98A;--ro-f:#FDECEA;--ro:#B3261E;--ro-b:#F2B8B5;--gr-f:#EEF1F4;--gr:#5B6672;--gr-b:#D9DFE6;--scad-f:#FFF1E6;--scad:#C2410C;--scad-b:#FDBA8C;" +
  "--ombra:0 1px 2px rgba(16,27,43,.05),0 8px 20px -14px rgba(16,27,43,.20),0 0 0 1px rgba(16,27,43,.03)}" +
  "*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}" +
  "body{margin:0;color:var(--t);font-family:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"Inter\",\"Segoe UI Variable Text\",\"Segoe UI\",Roboto,system-ui,sans-serif;letter-spacing:-.006em;" +
  "background:radial-gradient(1100px 600px at 100% -10%,rgba(242,106,16,.05),transparent 60%),radial-gradient(900px 600px at -10% 0%,rgba(27,47,74,.06),transparent 60%),#F8FAFC}" +
  "h1,h2,h3{letter-spacing:-.02em}svg{display:block}" +
  "main{max-width:960px;margin:0 auto;padding:16px 16px 48px}" +
  // 31/10/2026 (Filippo): sul computer le pagine del cantiere sono larghe fino a 1000 px
  "@media screen and (min-width:760px){main{max-width:min(1000px,calc(100vw - 48px));padding:20px 12px 56px}}@media screen and (min-width:900px){main{max-width:min(1000px,calc(100vw - 200px))}}" +
  ".sc-torna{display:inline-block;margin:0 0 12px;padding:6px 14px;border-radius:999px;border:1px solid var(--l);background:var(--c);color:var(--navy);font-weight:600;text-decoration:none}" +
  // cornice sfumata blu TIX → arancione, come le altre pagine del cantiere
  ".sc-card{position:relative;background:var(--c);border:1px solid transparent;border-radius:16px;padding:18px 18px 16px;background-image:linear-gradient(180deg,rgba(255,255,255,.7),rgba(255,255,255,0) 44%);box-shadow:var(--ombra)}" +
  ".sc-card::before{content:\"\";position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#F26A10);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}" +
  ".sc-prova{display:inline-block;margin:0 0 10px;padding:4px 12px;border-radius:999px;border:1px dashed var(--sic);background:var(--sic-f);color:var(--sic-s);font-size:.82rem;font-weight:700}" +
  ".sc-testa{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}" +
  ".sc-chi{margin:0;font-size:.88rem;color:var(--s);overflow-wrap:anywhere}" +
  ".sc-testa h1{display:flex;align-items:center;gap:10px;margin:4px 0 0;font-size:1.5rem;color:var(--navy)}" +
  ".sc-ic-sic{flex:none;width:38px;height:38px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#3DD9A4,#0CA678 45%,#065F46);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 6px 14px -6px rgba(6,95,70,.65)}" +
  ".sc-ic-sic svg{width:22px;height:22px}" +
  ".sc-ruoli{margin:8px 0 0;font-size:.9rem;color:var(--s)}.sc-ruoli b{color:var(--t);font-weight:600}" +
  ".sc-az-testa{display:flex;gap:8px;flex-wrap:wrap}" +
  ".sc-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:42px;padding:0 16px;border-radius:12px;border:1px solid var(--navy);background:var(--c);color:var(--navy);font:inherit;font-weight:700;font-size:.92rem;text-decoration:none;white-space:nowrap;cursor:pointer;" +
  "background-image:linear-gradient(180deg,#FFFFFF,#F4F7FA);box-shadow:0 1px 2px rgba(16,27,43,.05)}" +
  ".sc-btn svg{width:17px;height:17px}.sc-btn[disabled]{opacity:.6;cursor:wait}" +
  ".sc-btn.sc-pr{border-color:var(--sic);color:#fff;background-image:linear-gradient(180deg,rgba(255,255,255,.24),rgba(255,255,255,.06) 48%,rgba(255,255,255,0) 52%),linear-gradient(180deg,#13A579,#087F5B);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 22px -12px rgba(8,127,91,.8)}" +
  ".sc-btn.sc-sic{border-color:var(--sic);color:var(--sic-s);background-image:none;background-color:var(--sic-f)}" +
  ".sc-btn.sc-sm{min-height:34px;padding:0 12px;font-size:.84rem;border-radius:10px}" +
  ".sc-btn.sc-tenue{border-color:rgba(16,27,43,.16);color:var(--t)}" +
  ".sc-btn.sc-rosso{border-color:var(--ro);color:var(--ro)}" +
  ".sc-btn.sc-rosso-p{border-color:var(--ro);color:#fff;background-image:linear-gradient(180deg,#C8352B,#B3261E)}" +
  ".sc-agg{margin:10px 0 14px;font-size:.86rem;color:var(--s)}.sc-agg b{color:var(--t)}" +
  ".sc-chiuso{margin:0 0 12px;padding:8px 12px;border-radius:10px;background:var(--z);font-size:.88rem}" +
  ".sc-cifre{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 14px}" +
  ".sc-cifre div{position:relative;border:1px solid var(--l);border-radius:12px;padding:10px 12px 10px 14px;background:var(--c);overflow:hidden}" +
  ".sc-cifre div::before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--navy)}" +
  ".sc-cifre b{display:block;font-size:1.55rem;line-height:1.2;color:var(--navy)}.sc-cifre span{font-size:.82rem;color:var(--s)}" +
  ".sc-cifre .sc-c-ok::before{background:var(--sic)}.sc-cifre .sc-c-ok b{color:var(--sic-s)}" +
  ".sc-cifre .sc-c-dv::before{background:#E8913E}.sc-cifre .sc-c-dv b{color:var(--dv)}" +
  ".sc-cifre .sc-c-sc::before{background:var(--scad)}.sc-cifre .sc-c-sc b{color:var(--scad)}" +
  ".sc-cifre .sc-c-ro::before{background:var(--ro)}.sc-cifre .sc-c-ro b{color:var(--ro)}" +
  ".sc-avv{display:flex;align-items:center;justify-content:space-between;gap:10px 14px;flex-wrap:wrap;margin:0 0 10px;padding:12px 14px;border-radius:14px;border:1px solid var(--scad-b);background:var(--scad-f)}" +
  ".sc-avv .sc-tx{display:flex;gap:10px;align-items:flex-start;flex:1 1 320px;min-width:0;font-size:.92rem;line-height:1.45}" +
  ".sc-avv .sc-tx svg{flex:none;width:22px;height:22px;color:var(--scad);margin-top:1px}.sc-avv .sc-tx b{color:var(--scad)}" +
  ".sc-avv.sc-avv-ro{border-color:var(--ro-b);background:var(--ro-f)}.sc-avv.sc-avv-ro .sc-tx svg,.sc-avv.sc-avv-ro .sc-tx b{color:var(--ro)}" +
  ".sc-filtri{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0 2px}" +
  ".sc-filtri button{padding:6px 12px;border-radius:999px;border:1px solid var(--l);background:var(--c);font:inherit;font-size:.84rem;font-weight:600;color:var(--t);cursor:pointer}" +
  ".sc-filtri button i{font-style:normal;color:var(--s);margin-left:4px}" +
  ".sc-filtri button.sc-on{background:var(--navy);border-color:var(--navy);color:#fff}.sc-filtri button.sc-on i{color:rgba(255,255,255,.75)}" +
  ".sc-via{display:none!important}" +
  ".sc-sez{margin:24px 0 0}" +
  ".sc-sez h2{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0 0 10px;padding:0 0 8px;border-bottom:2px solid rgba(8,127,91,.16);font-size:.92rem;text-transform:uppercase;letter-spacing:.06em;color:var(--navy)}" +
  ".sc-sez h2 .sc-n{flex:none;width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--sic);color:#fff;font-size:.82rem;letter-spacing:0;box-shadow:0 0 0 2px #fff,0 0 0 3.5px rgba(8,127,91,.35)}" +
  ".sc-sez h2 .sc-h2t{flex:1 1 0;min-width:0}" +
  ".sc-sez h2 small{margin-left:auto;font-size:.82rem;font-weight:600;letter-spacing:0;text-transform:none;color:var(--s)}" +
  ".sc-doc{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;padding:12px 14px;border:1px solid var(--l);border-radius:14px;background:var(--c);box-shadow:0 1px 2px rgba(16,27,43,.04)}" +
  ".sc-doc+.sc-doc{margin-top:10px}.sc-doc.sc-luce{box-shadow:0 0 0 3px rgba(8,127,91,.28)}" +
  ".sc-tit{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px;font-weight:700;font-size:1rem;overflow-wrap:anywhere}" +
  ".sc-rev{padding:1px 8px;border-radius:999px;border:1px solid var(--l);background:var(--z);color:var(--navy);font-size:.74rem;font-weight:700}" +
  ".sc-meta{margin:0;font-size:.86rem;line-height:1.55;color:var(--s);overflow-wrap:anywhere}.sc-meta b{color:var(--t);font-weight:600}" +
  ".sc-impr{font-family:ui-monospace,SFMono-Regular,Consolas,\"Cascadia Mono\",monospace;font-size:.78rem;padding:0 6px;border-radius:6px;border:1px solid var(--l);background:var(--z);color:var(--t);cursor:copy;line-height:1.6}" +
  ".sc-arch{white-space:normal}.sc-arch-ok{color:var(--sic-s);font-weight:600}.sc-arch-r{color:var(--dv);font-weight:600}.sc-arch-e{color:var(--ro);font-weight:600}" +
  ".sc-lato{display:flex;flex-direction:column;align-items:flex-end;gap:8px}" +
  ".sc-az{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:flex-start}" +
  ".sc-st{display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border-radius:999px;border:1px solid transparent;font-size:.78rem;font-weight:700;line-height:1.7;white-space:nowrap}" +
  ".sc-st svg{width:13px;height:13px}" +
  ".sc-st.sc-vis{background:var(--sic-f);border-color:var(--sic-b);color:var(--sic-s)}" +
  ".sc-st.sc-dv{background:var(--dv-f);border-color:var(--dv-b);color:var(--dv)}" +
  ".sc-st.sc-sup,.sc-st.sc-nr{background:var(--gr-f);border-color:var(--gr-b);color:var(--gr)}" +
  ".sc-st.sc-man{background:#FFFFFF;border:1.5px dashed var(--ro);color:var(--ro)}" +
  ".sc-st.sc-man::before{content:\"!\";display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:var(--ro);color:#fff;font-size:.66rem;font-weight:800}" +
  ".sc-st.sc-scad{background:var(--scad-f);border-color:var(--scad-b);color:var(--scad)}" +
  ".sc-st.sc-ro{background:var(--ro-f);border-color:var(--ro-b);color:var(--ro)}" +
  ".sc-st.sc-ok{background:var(--c);border-color:var(--sic-b);color:var(--sic-s)}" +
  "details.sc-altro{position:relative}details.sc-altro>summary{list-style:none}details.sc-altro>summary::-webkit-details-marker{display:none}" +
  "details.sc-altro>summary::after{content:\"\";width:7px;height:7px;margin-left:2px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-2px)}" +
  ".sc-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:5;min-width:220px;padding:6px;border:1px solid var(--l);border-radius:12px;background:#fff;box-shadow:0 18px 40px -18px rgba(16,27,43,.45)}" +
  ".sc-menu a,.sc-menu button{display:block;width:100%;padding:9px 10px;border:0;border-radius:8px;background:none;font:inherit;font-size:.88rem;font-weight:600;color:var(--t);text-align:left;text-decoration:none;cursor:pointer}" +
  ".sc-menu a:hover,.sc-menu button:hover{background:var(--z)}.sc-menu .sc-rosso{color:var(--ro)}" +
  "details.sc-vp{grid-column:1/-1;margin-top:2px;padding-top:8px;border-top:1px dashed var(--l)}" +
  "details.sc-vp summary,details.sc-annullati summary{cursor:pointer;font-size:.86rem;font-weight:600;color:var(--navy)}" +
  ".sc-vp-r{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--z);font-size:.84rem;color:var(--s)}" +
  ".sc-vp-r>span:first-child{min-width:0;flex:1 1 260px;overflow-wrap:anywhere}.sc-vp-r b{color:var(--gr);font-weight:600}.sc-vp-az{display:flex;gap:6px;flex-wrap:wrap;align-items:center}" +
  "details.sc-annullati{margin:24px 0 0;padding:12px 14px;border:1px dashed var(--l);border-radius:14px}" +
  ".sc-righe{border:1px solid var(--l);border-radius:14px;background:var(--c);box-shadow:0 1px 2px rgba(16,27,43,.04)}" +
  ".sc-righe>:first-child{border-top-left-radius:14px;border-top-right-radius:14px}" +
  ".sc-riga{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr) 170px 180px;gap:10px 14px;align-items:center;padding:12px 14px}" +
  ".sc-riga+.sc-riga,.sc-det+.sc-riga,.sc-riga+.sc-det{border-top:1px solid var(--l)}" +
  ".sc-riga.sc-th{padding:8px 14px;background:var(--z);font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--s)}" +
  ".sc-imp{min-width:0;overflow-wrap:anywhere}.sc-imp b{display:block;font-size:.95rem}.sc-imp span{font-size:.82rem;color:var(--s)}" +
  ".sc-c-doc{font-size:.88rem;color:var(--t);min-width:0;overflow-wrap:anywhere}.sc-c-doc span{display:block;font-size:.8rem;color:var(--s)}.sc-c-doc b{display:block}" +
  ".sc-c-st{display:flex;flex-wrap:wrap;gap:4px}.sc-c-az{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}" +
  ".sc-riga.sc-manca{background:linear-gradient(90deg,rgba(179,38,30,.06),rgba(179,38,30,0) 70%)}" +
  ".sc-riga.sc-id{grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) minmax(0,1.25fr)}" +
  ".sc-riga.sc-vb{grid-template-columns:minmax(0,1fr) 110px 170px 180px}" +
  ".sc-cel{display:flex;flex-direction:column;align-items:flex-start;gap:4px;font-size:.86rem;color:var(--s);min-width:0}" +
  ".sc-riga-az{display:flex;gap:10px;align-items:center;flex-wrap:wrap}" +
  ".sc-det{padding:10px 12px;background:var(--z)}.sc-det .sc-doc{box-shadow:none}" +
  ".sc-piede{display:flex;align-items:center;justify-content:space-between;gap:8px 14px;flex-wrap:wrap;padding:10px 14px;border-top:1px solid var(--l);font-size:.84rem;color:var(--s)}" +
  ".sc-piede>span{flex:1 1 320px;min-width:0}" +
  ".sc-lk{display:inline;padding:0;border:0;background:none;font:inherit;font-weight:700;color:var(--sic-s);text-decoration:none;cursor:pointer}" +
  ".sc-lk:hover{text-decoration:underline}" +
  ".sc-nota{margin:8px 2px 0;font-size:.82rem;line-height:1.45;color:var(--s)}" +
  ".sc-vuoto{margin:0;padding:12px 14px;border:1px dashed var(--l);border-radius:12px;color:var(--s);font-size:.9rem}.sc-vuoto.sc-in{border:0;border-radius:0}" +
  // Aggiungi documento
  ".sc-form{margin-top:26px;padding:16px;border:1px solid var(--sic-b);border-radius:16px;background:linear-gradient(180deg,#F7FCFA,#FFFFFF 60%);scroll-margin-top:12px}" +
  ".sc-form h3{display:flex;align-items:center;gap:10px;margin:0 0 4px;font-size:1.15rem;color:var(--navy)}" +
  ".sc-ic-mini{flex:none;width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--sic);color:#fff}.sc-ic-mini svg{width:17px;height:17px}" +
  ".sc-sotto{margin:0 0 14px;font-size:.88rem;color:var(--s);line-height:1.45}" +
  ".sc-campi{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}" +
  ".sc-c3{grid-column:span 3}.sc-c2{grid-column:span 2}.sc-c6{grid-column:1/-1}.sc-c2,.sc-c3,.sc-c6{min-width:0}" +
  ".sc-campi label,.sc-et,.sc-dlg label{display:block;margin:0 0 4px;font-size:.8rem;font-weight:700;color:var(--navy)}" +
  ".sc-campi label small,.sc-dlg label small{font-weight:500;color:var(--s)}" +
  ".sc-campi input,.sc-campi select,.sc-campi textarea,.sc-dlg input:not([type=radio]),.sc-dlg select,.sc-dlg textarea{display:block;width:100%;min-height:44px;padding:0 12px;border:1px solid rgba(16,27,43,.16);border-radius:12px;background:#fff;font:inherit;font-size:.95rem;color:var(--t)}" +
  ".sc-campi textarea,.sc-dlg textarea{padding:10px 12px;min-height:64px;resize:vertical}" +
  ".sc-altra{display:grid;gap:8px;margin-top:8px}" +
  ".sc-aiuto{margin:4px 0 0;font-size:.78rem;line-height:1.4;color:var(--s)}" +
  ".sc-campi input.sc-nascosto{position:absolute;left:0;top:0;width:1px;height:1px;min-height:0;padding:0;border:0;opacity:0;pointer-events:none;overflow:hidden}" +
  ".sc-drop{position:relative;display:flex;align-items:center;gap:12px 16px;flex-wrap:wrap;padding:12px;border:2px dashed var(--sic-b);border-radius:14px;background:var(--sic-f)}" +
  ".sc-drop.sc-sopra{border-color:var(--sic);background:#D3F0E3}" +
  ".sc-drop .sc-scegli{display:flex;align-items:center;gap:10px;margin:0;font-size:.9rem;color:var(--sic-s);font-weight:600;cursor:pointer}" +
  ".sc-drop .sc-scegli svg{flex:none;width:24px;height:24px}" +
  ".sc-drop .sc-scegli small{display:block;margin-top:2px;font-size:.78rem;font-weight:500;color:var(--s)}" +
  ".sc-file{display:flex;align-items:center;gap:10px;flex:1 1 280px;min-width:0;padding:8px 10px;border:1px solid var(--l);border-radius:12px;background:var(--c)}" +
  ".sc-pdf{flex:none;width:32px;height:38px;border-radius:5px;border:1px solid var(--ro-b);background:#fff;display:flex;align-items:flex-end;justify-content:center;padding-bottom:4px;font-size:.6rem;font-weight:800;color:var(--ro)}" +
  ".sc-nm{min-width:0;font-size:.88rem;font-weight:600;overflow-wrap:anywhere}.sc-nm span{display:block;font-size:.78rem;font-weight:500;color:var(--s);overflow-wrap:anywhere}" +
  ".sc-archivio{display:flex;gap:10px;align-items:flex-start;margin:14px 0 0;padding:10px 12px;border-radius:12px;background:var(--z);font-size:.84rem;line-height:1.45;color:var(--s)}" +
  ".sc-archivio svg{flex:none;width:20px;height:20px;color:var(--sic)}" +
  ".sc-prog{height:8px;margin:12px 0 0;border-radius:999px;background:var(--z);overflow:hidden}.sc-prog i{display:block;height:100%;width:0;background:linear-gradient(90deg,#0CA678,#087F5B);transition:width .2s}" +
  ".sc-msg{margin:10px 0 0;font-size:.9rem;font-weight:600;color:var(--ro)}.sc-msg:empty{display:none}.sc-msg.sc-ok{color:var(--sic-s)}" +
  ".sc-form-az{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:14px}" +
  ".sc-fonti{margin:20px 0 0;font-size:.82rem;line-height:1.5;color:var(--s)}" +
  // finestre
  "dialog.sc-dlg{width:min(520px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:18px 18px 16px;border:1px solid var(--l);border-radius:20px;background:#fff;color:var(--t)}" +
  "dialog.sc-dlg::backdrop{background:rgba(16,27,43,.45)}" +
  ".sc-dlg h3{margin:0 0 2px;font-size:1.15rem;color:var(--navy)}.sc-dlg-sotto{margin:0 0 8px;font-size:.88rem;color:var(--s);overflow-wrap:anywhere}" +
  ".sc-dlg-nota{margin:0 0 10px;padding:8px 10px;border-radius:10px;background:var(--sic-f);color:var(--sic-s);font-size:.84rem;line-height:1.45}.sc-dlg-nota:empty{display:none}" +
  ".sc-dlg label{margin-top:10px}.sc-dlg .sc-et{margin-top:10px}" +
  ".sc-dlg-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}" +
  ".sc-radio{display:flex;gap:16px;flex-wrap:wrap}.sc-radio label{display:flex;align-items:center;gap:6px;margin:0;font-weight:600;color:var(--t)}" +
  ".sc-dlg-az{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:14px}" +
  ".sc-toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:20;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;background:rgba(27,47,74,.92);color:#fff;font-size:.9rem;font-weight:600;box-shadow:0 12px 30px -12px rgba(16,27,43,.6)}" +
  "@media (max-width:680px){main{padding:14px 16px 40px}.sc-card{padding:16px 14px 14px}.sc-testa h1{font-size:1.35rem}" +
  ".sc-az-testa{width:100%}.sc-az-testa .sc-btn{flex:1 1 auto}" +
  ".sc-cifre{grid-template-columns:repeat(2,minmax(0,1fr))}.sc-avv .sc-btn{width:100%}" +
  ".sc-doc{grid-template-columns:minmax(0,1fr)}.sc-lato{flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:flex-start}.sc-az{justify-content:flex-start;width:100%}" +
  "details.sc-altro[open]{flex-basis:100%}.sc-menu{position:static;margin-top:6px;min-width:0;box-shadow:none}" +
  ".sc-riga,.sc-riga.sc-id,.sc-riga.sc-vb{grid-template-columns:minmax(0,1fr) auto}.sc-riga.sc-th{display:none}" +
  ".sc-riga .sc-imp{grid-column:1;grid-row:1}.sc-riga .sc-c-st{grid-column:2;grid-row:1;justify-content:flex-end}" +
  ".sc-riga .sc-c-doc{grid-column:1/-1;grid-row:2}.sc-riga .sc-c-az{grid-column:1/-1;grid-row:3;justify-content:flex-start}" +
  ".sc-riga.sc-id .sc-imp,.sc-riga.sc-id .sc-cel{grid-column:1/-1;grid-row:auto}" +
  ".sc-cel::before{content:attr(data-et);font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--s)}" +
  ".sc-riga.sc-vb .sc-c-doc{grid-column:1;grid-row:1}.sc-riga.sc-vb .sc-imp{grid-column:1/-1;grid-row:2;font-size:.84rem;color:var(--s)}.sc-riga.sc-vb .sc-c-st{grid-row:1}" +
  ".sc-sez h2 small{flex-basis:100%;margin-left:36px}" +
  ".sc-campi{grid-template-columns:minmax(0,1fr)}.sc-c2,.sc-c3,.sc-c6{grid-column:1/-1}.sc-form{padding:14px 12px}.sc-form-az .sc-btn{flex:1 1 auto}" +
  ".sc-dlg-az .sc-btn{flex:1 1 auto}}" +
  "@media print{.sc-torna,.sc-az-testa,.sc-filtri,.sc-form,.sc-az,.sc-c-az,.sc-riga-az,.sc-lk,dialog,.sc-toast,.sc-avv .sc-btn{display:none!important}" +
  ".sc-card::before{display:none}.sc-card{box-shadow:none}body{background:#fff}.sc-doc,.sc-riga{break-inside:avoid}}";

// Script della pagina: filtri, «Dettagli», impronta da copiare, finestre e caricamento con l'impronta calcolata nel browser.
const SCRIPT = String.raw`(function(){try{
var CFG=__CFG__;var D=document;function $(id){return D.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
var tt=null;function toast(m){var t=$('sc-toast');if(!t)return;t.textContent=m;t.hidden=false;clearTimeout(tt);tt=setTimeout(function(){t.hidden=true;},3500);}
function leggiChi(){try{return localStorage.getItem('tix_sic_chi')||'';}catch(e){return '';}}
function scriviChi(v){try{if(v)localStorage.setItem('tix_sic_chi',v);}catch(e){}}
var TIPI={};CFG.tipi.forEach(function(t){TIPI[t.k]=t;});var IMP={};CFG.imprese.forEach(function(i){IMP[i.k]=i;});
function apriDlg(d){if(!d)return;if(typeof d.showModal==='function'){try{d.showModal();return;}catch(e){}}d.setAttribute('open','');}
function chiudiDlg(d){if(!d)return;if(typeof d.close==='function'){try{d.close();return;}catch(e){}}d.removeAttribute('open');}
D.querySelectorAll('dialog [data-chiudi]').forEach(function(b){b.addEventListener('click',function(){chiudiDlg(b.closest('dialog'));});});
function chiama(azione,id,dati){return fetch(CFG.u+'/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:azione,id:id||null,dati:dati||{}})})
 .then(function(r){return r.json().catch(function(){return null;});},function(){return {esito:'rete'};});}
var FRASI={rete:'Connessione assente: riprova.',gettone:'Il collegamento non vale più: rientra dall\'area riservata.',non_trovato:'Non trovato: ricarica la pagina.',
 spento:'La sezione Sicurezza non è attiva per questo accesso.',cantiere:'Questo cantiere non è più tra i tuoi: ricarica la pagina.'};
function esito(r,btn,msg,id){if(r&&r.esito==='ok'){try{sessionStorage.setItem('sc_vai',id||'');}catch(e){}location.reload();return;}
 if(btn)btn.disabled=false;var m=(r&&r.messaggio)||(r&&FRASI[r.esito])||'Non è stato possibile salvare. Riprova tra un minuto.';
 if(msg)msg.textContent=m;else toast(m);}
function opzTipi(sel,val){sel.innerHTML=CFG.tipi.map(function(t){return '<option value="'+esc(t.k)+'"'+(t.k===val?' selected':'')+'>'+esc(t.e)+'</option>';}).join('');}
function opzImprese(sel,val,primo){var h='<option value="">'+esc(primo)+'</option>';CFG.imprese.forEach(function(i){if(i.a||i.k===val)h+='<option value="'+esc(i.k)+'"'+(i.k===val?' selected':'')+'>'+esc(i.n)+'</option>';});
 h+='<option value="+">+ Altra impresa…</option>';sel.innerHTML=h;if(val&&sel.value!==val)sel.value='';}
// impresa scelta in un modulo: {nome, ruolo} o null se manca
function impresaScelta(sel,nome,ruolo){if(sel.value==='+')return {n:nome.value.trim(),r:ruolo.value};if(sel.value&&IMP[sel.value])return {n:IMP[sel.value].n,r:''};return {n:'',r:''};}
function adatta(tipo,box,et,sel,altra,val){var t=TIPI[tipo]||{};box.hidden=!(t.pi||t.fa);et.textContent=t.pi?'Impresa':'Impresa (facoltativa)';
 opzImprese(sel,val===undefined?sel.value:val,t.pi?'Scegli l\'impresa…':'Nessuna impresa');altra.hidden=sel.value!=='+';}
function piuGiorni(iso,n){var d=new Date(iso+'T12:00:00Z');if(isNaN(d))return '';d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
// ---- filtri
var fb=D.querySelectorAll('.sc-filtri button');
function applica(f){D.querySelectorAll('[data-fx]').forEach(function(el){var ok=!f||(' '+el.getAttribute('data-fx')+' ').indexOf(' '+f+' ')!==-1;el.classList.toggle('sc-via',!ok);
  if(f==='sup'&&ok){var v=el.querySelector('details.sc-vp');if(v)v.open=true;}});
 D.querySelectorAll('section.sc-sez').forEach(function(s){var tot=s.querySelectorAll('[data-fx]').length,vis=s.querySelectorAll('[data-fx]:not(.sc-via)').length;s.classList.toggle('sc-via',!!f&&(tot===0||vis===0));});}
fb.forEach(function(b){b.addEventListener('click',function(){var f=b.getAttribute('data-f');fb.forEach(function(x){x.classList.toggle('sc-on',x===b);x.setAttribute('aria-pressed',x===b?'true':'false');});applica(f);});});
// ---- menu «Altro»: si chiude cliccando altrove
D.addEventListener('click',function(e){D.querySelectorAll('details.sc-altro[open]').forEach(function(x){if(!x.contains(e.target))x.open=false;});});
// ---- impronta da copiare
function copia(t){if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(t);return new Promise(function(ok,ko){var a=D.createElement('textarea');a.value=t;a.style.position='fixed';a.style.opacity='0';D.body.appendChild(a);a.select();try{D.execCommand('copy')?ok():ko();}catch(e){ko(e);}D.body.removeChild(a);});}
D.querySelectorAll('[data-sha]').forEach(function(b){b.addEventListener('click',function(){copia(b.getAttribute('data-sha')).then(function(){toast('Impronta SHA-256 copiata');},function(){toast(b.getAttribute('data-sha'));});});});
// ---- modulo «Aggiungi documento»
var F=$('sc-f');var prepara=function(){};
if(F){
 var fTipo=$('f-tipo'),fImp=$('f-imp'),fImpBox=$('f-imp-box'),fImpEt=$('f-imp-et'),fAltra=$('f-altra'),fAltraN=$('f-altra-nome'),fAltraR=$('f-altra-ruolo'),fVer=$('f-ver'),fData=$('f-data'),fScad=$('f-scad'),
  fNota=$('f-nota'),fTit=$('f-tit'),fChi=$('f-chi'),fFile=$('f-file'),fDrop=$('f-drop'),fScelto=$('f-scelto'),fMsg=$('f-msg'),fInvia=$('f-invia'),fProg=$('f-prog');
 var scelto=null,lettura=0,scadAuto='';
 fChi.value=leggiChi();
 function aggiornaTipo(val){adatta(fTipo.value,fImpBox,fImpEt,fImp,fAltra,val);var t=TIPI[fTipo.value]||{};$('f-scad-aiuto').hidden=!t.sg;proponi();}
 function proponi(){var t=TIPI[fTipo.value]||{};if(!t.sg||!fData.value)return;if(fScad.value&&fScad.value!==scadAuto)return;scadAuto=piuGiorni(fData.value,t.sg);fScad.value=scadAuto;}
 fTipo.addEventListener('change',function(){aggiornaTipo();});fData.addEventListener('change',proponi);fData.addEventListener('input',proponi);
 fImp.addEventListener('change',function(){fAltra.hidden=fImp.value!=='+';if(fImp.value==='+')fAltraN.focus();});
 aggiornaTipo('');
 function misura(n){return n>=1048576?(Math.round(n/104857.6)/10).toString().replace('.',',')+' MB':Math.max(1,Math.round(n/1024))+' KB';}
 function esa(buf){return Array.prototype.map.call(new Uint8Array(buf),function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
 function mostra(f,est,riga){fScelto.innerHTML='<span class="sc-pdf">'+(est==='p7m'?'P7M':'PDF')+'</span><div class="sc-nm">'+esc(f.name)+'<span>'+esc(misura(f.size)+' · '+riga)+'</span></div>';fScelto.hidden=false;}
 function scegli(f){scelto=null;fMsg.className='sc-msg';fMsg.textContent='';fScelto.hidden=true;var mio=++lettura;if(!f)return;
  var m=/\.(pdf|p7m)$/i.exec(f.name||'');
  if(!m){fMsg.textContent='Carica un PDF, anche firmato digitalmente (.p7m). Per le foto di un documento fai prima un PDF.';return;}
  if(!f.size){fMsg.textContent='Il file è vuoto.';return;}
  if(f.size>CFG.max*1048576){fMsg.textContent='Il file è troppo grande: il massimo è '+CFG.max+' MB. Comprimi il PDF o dividilo in più parti.';return;}
  var est=m[1].toLowerCase();mostra(f,est,'calcolo l\'impronta SHA-256…');
  f.slice(0,1024).arrayBuffer().then(function(testa){var b=new Uint8Array(testa);
   if(est==='pdf'){var s='';for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);if(s.indexOf('%PDF-')===-1)throw new Error('Il file non sembra un PDF: controlla di aver scelto quello giusto.');}
   else if(b[0]!==0x30){var s2=String.fromCharCode(b[0]||0,b[1]||0,b[2]||0);throw new Error(s2==='MII'?'Questo .p7m è salvato come testo (base64): TIX accetta il .p7m binario. Salvalo di nuovo dal programma di firma, oppure carica il PDF.':'Il file .p7m non sembra un documento firmato: controlla di aver scelto quello giusto.');}
   if(!window.crypto||!crypto.subtle)throw new Error('Questo browser non calcola l\'impronta del file: usa Chrome, Edge, Safari o Firefox aggiornati.');
   return f.arrayBuffer().then(function(buf){return crypto.subtle.digest('SHA-256',buf);});
  }).then(function(h){if(mio!==lettura)return;scelto={file:f,sha:esa(h),est:est};mostra(f,est,'impronta SHA-256 calcolata sul tuo dispositivo: '+scelto.sha.slice(0,12)+'…'+scelto.sha.slice(-8));})
  .catch(function(e){if(mio!==lettura)return;scelto=null;fScelto.hidden=true;fMsg.textContent=(e&&e.message)||'Non riesco a leggere il file.';});}
 fFile.addEventListener('change',function(){scegli(fFile.files&&fFile.files[0]);});
 ['dragenter','dragover'].forEach(function(n){fDrop.addEventListener(n,function(e){e.preventDefault();fDrop.classList.add('sc-sopra');});});
 ['dragleave','drop'].forEach(function(n){fDrop.addEventListener(n,function(e){e.preventDefault();fDrop.classList.remove('sc-sopra');});});
 fDrop.addEventListener('drop',function(e){var f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];if(f)scegli(f);});
 function b64url(s){var b=new TextEncoder().encode(s),t='';for(var i=0;i<b.length;i++)t+=String.fromCharCode(b[i]);return btoa(t).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
 function barra(v){var i=fProg.querySelector('i');if(i)i.style.width=Math.round(v*100)+'%';}
 F.addEventListener('reset',function(){setTimeout(function(){scelto=null;lettura++;fScelto.hidden=true;fMsg.textContent='';fChi.value=leggiChi();scadAuto='';aggiornaTipo('');},0);});
 F.addEventListener('submit',function(ev){ev.preventDefault();fMsg.className='sc-msg';fMsg.textContent='';
  var t=TIPI[fTipo.value];if(!t){fMsg.textContent='Scegli il tipo di documento.';return;}
  var im=fImpBox.hidden?{n:'',r:''}:impresaScelta(fImp,fAltraN,fAltraR);
  if(fImp.value==='+'&&!im.n&&!fImpBox.hidden){fMsg.textContent='Scrivi il nome dell\'impresa.';fAltraN.focus();return;}
  if(t.pi&&!im.n){fMsg.textContent='Scegli l\'impresa a cui si riferisce il documento.';fImp.focus();return;}
  if(!scelto){fMsg.textContent=fFile.files&&fFile.files.length&&!fScelto.hidden?'Aspetta un momento: sto calcolando l\'impronta del file.':'Scegli il file da caricare.';return;}
  var chi=fChi.value.trim();if(!chi){fMsg.textContent='Scrivi il tuo nome: resta scritto chi ha caricato il documento.';fChi.focus();return;}
  if(fScad.value&&fData.value&&fScad.value<fData.value){fMsg.textContent='La scadenza è prima della data del documento: ricontrollala.';return;}
  scriviChi(chi);
  var dati={t:CFG.t,c:CFG.c,tipo:fTipo.value,impresa:im.n,impresa_ruolo:im.r,titolo:fTit.value.trim(),versione:fVer.value.trim(),data:fData.value,scadenza:fScad.value,
   nota:fNota.value.trim(),autore:chi,nome:scelto.file.name,byte:scelto.file.size,sha256:scelto.sha};
  var x=new XMLHttpRequest();fInvia.disabled=true;fProg.hidden=false;barra(0);
  try{x.open('POST',CFG.u+'/carica');x.setRequestHeader('Content-Type','application/octet-stream');x.setRequestHeader('X-Sicurezza-Dati',b64url(JSON.stringify(dati)));}catch(e){fInvia.disabled=false;fProg.hidden=true;fMsg.textContent='Non riesco a preparare l\'invio: ricarica la pagina.';return;}
  x.upload.onprogress=function(e){if(e.lengthComputable)barra(e.loaded/e.total);};
  x.onload=function(){var r=null;try{r=JSON.parse(x.responseText);}catch(e){}fProg.hidden=true;
   if(r&&r.esito==='ok'){fMsg.className='sc-msg sc-ok';fMsg.textContent='Caricato.'+(r.superati?' La versione di prima ora è tra le versioni precedenti.':'')+' Aggiorno la pagina…';
    try{sessionStorage.setItem('sc_vai',r.id||'');}catch(e){}setTimeout(function(){location.reload();},800);return;}
   fInvia.disabled=false;fMsg.textContent=(r&&r.messaggio)||(r&&FRASI[r.esito])||(x.status===413?'Il file è troppo grande.':'Il documento non si è caricato: riprova tra un minuto.');};
  x.onerror=function(){fInvia.disabled=false;fProg.hidden=true;fMsg.textContent='Connessione assente: il documento non si è caricato. Riprova.';};
  x.send(scelto.file);});
 prepara=function(tipo,chiave){if(tipo&&TIPI[tipo])fTipo.value=tipo;aggiornaTipo(chiave||'');if(chiave&&IMP[chiave]&&fImp.value!==chiave){fImp.value='+';fAltra.hidden=false;fAltraN.value=IMP[chiave].n;}
  $('aggiungi').scrollIntoView({behavior:'smooth',block:'start'});setTimeout(function(){try{(fData.value?fFile:fVer).focus({preventScroll:true});}catch(e){}},450);};
}
// ---- finestre
var corr=null;
function riempi(pre){var x=$(pre+'-chi');if(x)x.value=leggiChi();var m=$(pre+'-msg');if(m)m.textContent='';}
var dmTipo=$('dm-tipo');
if(dmTipo){dmTipo.addEventListener('change',function(){adatta(dmTipo.value,$('dm-imp-box'),$('dm-imp-et'),$('dm-imp'),$('dm-altra'));var t=TIPI[dmTipo.value]||{};var dd=$('dm-data');if(t.sg&&dd.value&&!$('dm-scad').value)$('dm-scad').value=piuGiorni(dd.value,t.sg);});
 $('dm-imp').addEventListener('change',function(){$('dm-altra').hidden=$('dm-imp').value!=='+';});}
function apriImpresa(k){corr=k||null;var i=k?IMP[k]:null;$('di-h').textContent=i?'Impresa del cantiere':'Aggiungi un\'impresa';$('di-nome').value=i?i.n:'';$('di-ruolo').value=i?i.r:'subappaltatrice';$('di-lav').value=i&&i.l||'';
 var pos=i?i.p:'richiesto';D.querySelectorAll('input[name=di-pos]').forEach(function(r){r.checked=r.value===pos;});$('di-togli').hidden=!(i&&i.a);
 $('di-nota').textContent=i&&!i.a?'Questa impresa è tolta dall\'elenco: con «Salva» torna nell\'elenco.':'';riempi('di');apriDlg($('sc-di'));}
var diR=$('di-ruolo');if(diR)diR.addEventListener('change',function(){if(corr)return;var v=diR.value==='autonomo'?'non_richiesto':'richiesto';D.querySelectorAll('input[name=di-pos]').forEach(function(r){r.checked=r.value===v;});});
D.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('[data-carica],[data-az]'):null;if(!b)return;
 if(b.hasAttribute('data-carica')){e.preventDefault();var p=b.getAttribute('data-carica').split('|');prepara(p[0],p[1]||'');return;}
 var az=b.getAttribute('data-az'),id=b.getAttribute('data-id')||'',doc=CFG.docs[id]||{};var menu=b.closest('details.sc-altro');if(menu)menu.open=false;
 if(az==='det'){var d=$('det-'+id);if(!d)return;d.hidden=!d.hidden;b.setAttribute('aria-expanded',d.hidden?'false':'true');b.textContent=d.hidden?'Dettagli':'Chiudi';return;}
 if(az==='impresa'){apriImpresa(b.getAttribute('data-imp'));return;}
 if(az==='visto'){corr=id;$('dv-tit').textContent=doc.n||'';$('dv-il').value=CFG.oggi;$('dv-da').value=CFG.cse||'';riempi('dv');apriDlg($('sc-dv'));return;}
 if(az==='modifica'){corr=id;$('dm-tit').textContent=doc.n||'';opzTipi(dmTipo,doc.tipo);adatta(doc.tipo,$('dm-imp-box'),$('dm-imp-et'),$('dm-imp'),$('dm-altra'),doc.ik);
  if(doc.ik&&$('dm-imp').value!==doc.ik&&doc.imp){$('dm-imp').value='+';$('dm-altra').hidden=false;$('dm-altra-nome').value=doc.imp;}
  $('dm-tit-in').value=doc.tit||'';$('dm-ver').value=doc.ver||'';$('dm-data').value=doc.data||'';$('dm-scad').value=doc.scad||'';$('dm-nota').value=doc.nota||'';riempi('dm');apriDlg($('sc-dm'));return;}
 if(az==='annulla'){corr=id;$('da-tit').textContent=doc.n||'';$('da-mot').value='';riempi('da');apriDlg($('sc-da'));return;}
 if(az==='nuova'){prepara(doc.tipo,doc.ik);return;}
 if(az==='togli-visto'||az==='ripristina'){if(!confirm(az==='ripristina'?'Rimetti in vigore questa versione? Torna con lo stato che aveva prima.':'Togli «Visto dal CSE» da questo documento? Torna «Da verificare».'))return;
  b.disabled=true;chiama(az==='ripristina'?'ripristina':'da_verificare',id,{chi:leggiChi()}).then(function(r){esito(r,b,null,id);});return;}
});
function salva(pre,azione,dati,rosso){var b=$(pre+'-si'),m=$(pre+'-msg');var chi=$(pre+'-chi')?$(pre+'-chi').value.trim():'';if(!chi){m.textContent='Scrivi il tuo nome: resta scritto chi ha fatto la modifica.';$(pre+'-chi').focus();return;}
 scriviChi(chi);dati.chi=chi;b.disabled=true;m.textContent='';chiama(azione,azione.indexOf('impresa')===0?null:corr,dati).then(function(r){esito(r,b,m,azione.indexOf('impresa')===0?'':corr);});}
if($('dv-si'))$('dv-si').addEventListener('click',function(){salva('dv','visto',{il:$('dv-il').value,da:$('dv-da').value.trim()});});
if($('dm-si'))$('dm-si').addEventListener('click',function(){var t=TIPI[dmTipo.value]||{};var im=$('dm-imp-box').hidden?{n:'',r:''}:impresaScelta($('dm-imp'),$('dm-altra-nome'),$('dm-altra-ruolo'));
 if(t.pi&&!im.n){$('dm-msg').textContent='Scegli l\'impresa a cui si riferisce il documento.';return;}
 salva('dm','dati',{tipo:dmTipo.value,impresa:im.n,impresa_ruolo:im.r,titolo:$('dm-tit-in').value.trim(),versione:$('dm-ver').value.trim(),data:$('dm-data').value,scadenza:$('dm-scad').value,nota:$('dm-nota').value.trim()});});
if($('da-si'))$('da-si').addEventListener('click',function(){var mot=$('da-mot').value.trim();if(mot.length<3){$('da-msg').textContent='Scrivi il motivo: resta scritto con il documento.';$('da-mot').focus();return;}salva('da','annulla',{motivo:mot});});
if($('di-si'))$('di-si').addEventListener('click',function(){var n=$('di-nome').value.trim();if(!n){$('di-msg').textContent='Scrivi il nome dell\'impresa.';$('di-nome').focus();return;}
 var pos='';D.querySelectorAll('input[name=di-pos]').forEach(function(r){if(r.checked)pos=r.value;});
 salva('di','impresa_salva',{chiave:corr||'',nome:n,ruolo:$('di-ruolo').value,lavorazione:$('di-lav').value.trim(),pos:pos});});
if($('di-togli'))$('di-togli').addEventListener('click',function(){var i=IMP[corr];if(!i||!confirm('Togli «'+i.n+'» dall\'elenco delle imprese del cantiere? I suoi documenti restano.'))return;
 var b=$('di-togli');b.disabled=true;chiama('impresa_togli',null,{chiave:corr}).then(function(r){esito(r,b,$('di-msg'),'');});});
// ---- dopo un salvataggio: torna al documento
function vai(id){var el=$('d-'+id);if(!el)return;var det=el.closest('.sc-det');if(det){det.hidden=false;var bt=D.querySelector('[data-az=det][data-id="'+id+'"]');if(bt){bt.textContent='Chiudi';bt.setAttribute('aria-expanded','true');}}
 var vp=el.closest('details.sc-vp');if(vp)vp.open=true;el.scrollIntoView({block:'center'});el.classList.add('sc-luce');setTimeout(function(){el.classList.remove('sc-luce');},2500);}
try{var v=sessionStorage.getItem('sc_vai');sessionStorage.removeItem('sc_vai');if(v)vai(v);else if(/^#d-[0-9a-f-]{36}$/.test(location.hash))vai(location.hash.slice(3));}catch(e){}
}catch(e){}})();`;
