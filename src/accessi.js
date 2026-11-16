// ============================================================================
// ACCESSI PERSONALI DELL'UFFICIO (15/11/2026, accessi-1, chat B16). Decisione di Filippo (B11, 15/11): «Il conteggio delle persone
// che usano il computer viene fatto con email e password date ad ogni utente, non si invia un link unico a tutti».
// Piano: Strumenti/accessi-ufficio (15-11-2026)/01 - piano.md.
//
// Come funziona. Le pagine dell'area riservata continuano a usare il gettone ?t= (e "t" nei corpi JSON) come prima: nessun file
// delle altre chat cambia. Questa PORTA, chiamata in cima a portaleRoute, guarda se il gettone è una sessione personale dentro le
// regole nuove (impostazioni.accessi_personali_attivo: no / prova = solo «tutte le imprese» / si) e controlla che sia aperta sul
// suo dispositivo: la chiave del dispositivo sta nel cookie protetto tix_disp (HttpOnly, Secure), mai nell'indirizzo.
// Con impostazioni.accessi_personali_modo = registro la porta annota soltanto; con «blocco» ferma la richiesta.
// Interruttore d'emergenza del Worker: ACCESSI = "off" spegne porta, codice e pagina (si torna a prima).
//
// Rotte: /accedi/codice (codice di 6 cifre per un dispositivo nuovo), /accessi e /accessi/azione (pagina «Accessi e numeri»).
// Funzioni del database (tutte chiuse alla chiave pubblica): accessi_dopo_login, accessi_codice_conferma, accessi_codice_nuovo,
// accessi_controlla, accessi_senza_gettone, accessi_pagina, accessi_azione, accessi_persone_contate.
// ============================================================================

import { CAMPI_ROSSI_CSS, CAMPI_ROSSI_JS } from "./campi-rossi.js";

const COOKIE = "tix_disp";
const ESA64 = /^[0-9a-f]{64}$/;
const CACHE = new Map();            // gettone:chiave -> { r, fino }
const CACHE_MS = 60000;
let ULTIMO_ERRORE = 0;
const SALTA = new Set(["/accedi", "/accedi/codice", "/password-dimenticata", "/imposta", "/manifest.webmanifest", "/sw.js", "/robots.txt"]);

export function accessiAcceso(env) { return !(env && env.ACCESSI === "off"); }

export function accessiChiave(request) {
  const m = /(?:^|;\s*)tix_disp=([0-9a-f]{64})(?:;|$)/.exec(request.headers.get("Cookie") || "");
  return m ? m[1] : "";
}

function cookieImposta(base, k) {
  return COOKIE + "=" + k + "; Path=" + (base || "") + "/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax";
}

function ipBreve(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split(".").slice(0, 3).join(".") + ".x";
  if (ip.indexOf(":") !== -1) return ip.split(":").slice(0, 3).join(":") + "::x";
  return "";
}

// Nome breve del dispositivo (non si salva il testo intero dell'User-Agent).
function dispositivoDi(request) {
  const ua = request.headers.get("User-Agent") || "";
  const telefono = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  const so = /iPhone|iPod/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox"
    : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  const nome = (telefono ? (/iPad/.test(ua) ? "Tablet" : "Telefono") : "Computer") + (so ? " " + so : "") + (br ? " · " + br : "");
  return { nome, tipo: telefono ? "telefono" : "computer" };
}

async function rpc(env, nome, corpo, ms) {
  const url = (env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co") + "/rest/v1/rpc/" + nome;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(url, { method: "POST", signal: ctrl.signal, body: JSON.stringify(corpo),
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" } });
    if (!r.ok) return null;
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

// Gettone della richiesta: ?t= nell'indirizzo, oppure "t" nel corpo (JSON, modulo, multipart).
async function gettoneDi(request, inUrl) {
  const q = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (q) return q[0].toLowerCase();
  if (request.method !== "POST" && request.method !== "PUT") return "";
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  const lung = Number(request.headers.get("Content-Length") || "0");
  if (lung > 30 * 1048576) return "";
  try {
    if (ct.indexOf("multipart/form-data") !== -1) {
      const fd = await request.clone().formData();
      const v = String(fd.get("t") || "").match(/[0-9a-fA-F]{64}/);
      return v ? v[0].toLowerCase() : "";
    }
    const testo = await request.clone().text();
    let m = /"t"\s*:\s*"([0-9a-fA-F]{64})"/.exec(testo) || /(?:^|&)t=([0-9a-fA-F]{64})(?:&|$)/.exec(testo);
    return m ? m[1].toLowerCase() : "";
  } catch (e) { return ""; }
}

const MOTIVI = {
  altro_dispositivo: (n) => "Questo collegamento è l'accesso personale di " + n + " e non vale su questo dispositivo. Entra con la tua email e la tua password.",
  dispositivo_chiuso: () => "Questo dispositivo è stato scollegato dal tuo accesso. Entra di nuovo con email e password.",
  non_verificato: () => "Entra di nuovo con email e password: ti mandiamo un codice per questo dispositivo.",
  scaduta: () => "Per sicurezza, sul computer dopo 12 ore senza uso bisogna entrare di nuovo con email e password.",
  contemporaneo: () => "Il tuo accesso è in uso su un altro dispositivo in questo momento. Ogni accesso è personale: entra di nuovo con email, password e codice.",
  sessione_chiusa: () => "La sessione è chiusa. Entra di nuovo con email e password."
};

// La PORTA. Restituisce una Response (richiesta fermata) oppure null (si va avanti come prima).
export async function accessiPorta(request, env, base, sotto, inUrl, h) {
  if (!accessiAcceso(env) || !env.SUPABASE_SERVICE_KEY) return null;
  if (SALTA.has(sotto) || sotto.startsWith("/studio") || sotto.startsWith("/caratteri/") || /^\/icona|^\/apple-touch/.test(sotto)) return null;
  const tok = await gettoneDi(request, inUrl);
  const k = accessiChiave(request);
  if (!tok) {
    if (k && request.method === "POST") await rpc(env, "accessi_senza_gettone", { p_disp: k, p_percorso: sotto, p_metodo: request.method,
      p_tipo: (request.headers.get("Content-Type") || "").slice(0, 60) }, 3000);
    return null;
  }
  const chiave = tok + ":" + k;
  const ora = Date.now();
  let r = null;
  const c = CACHE.get(chiave);
  if (c && c.fino > ora) r = c.r;
  else {
    r = await rpc(env, "accessi_controlla", { p_token: tok, p_disp: k, p_ip: ipBreve(request), p_percorso: sotto }, 5000);
    if (!r) {
      // il database non risponde: si va avanti come prima, ma si annota (accessi-2, richiesta della B14; al massimo una volta l'ora)
      if (ora - ULTIMO_ERRORE > 3600000) { ULTIMO_ERRORE = ora; await rpc(env, "accessi_porta_errore", { p_percorso: sotto, p_cosa: "accessi_controlla senza risposta" }, 3000); }
      return null;
    }
    if (r.esito !== "blocca") {
      if (CACHE.size > 5000) CACHE.clear();
      CACHE.set(chiave, { r, fino: ora + CACHE_MS });
    }
  }
  if (h && h.stato) h.stato.set(request, r);
  if (r.esito !== "blocca") return null;
  CACHE.delete(chiave);
  const msg = (MOTIVI[r.motivo] || MOTIVI.sessione_chiusa)(h.esc(r.nome || ""));
  const accetta = request.headers.get("Accept") || "";
  if (request.method === "GET" && (accetta.indexOf("text/html") !== -1 || sotto === "/" || sotto === "/index.html")) {
    let html = h.ingresso(base, msg, "");
    // il telefono non deve riaprire da solo il collegamento ricordato
    html = html.replace("</body>", "<script>try{if(localStorage.getItem('gl_portale_t')==='" + tok + "')localStorage.removeItem('gl_portale_t')}catch(e){}</script></body>");
    return new Response(html, { status: 200, headers: h.headers() });
  }
  return new Response(JSON.stringify({ ok: false, esito: "accesso", motivo: r.motivo, errore: msg }), {
    status: 401, headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" } });
}

// Il link in fondo all'elenco dei cantieri: «Accessi e numeri» per chi è dentro le regole nuove e gestisce le persone.
// accessi-2 (16/11, richiesta di Filippo: nell'app manca il logout): anche «Esci», per chi è dentro le regole nuove.
export function accessiLink(h, request, base, tok) {
  const r = h && h.stato ? h.stato.get(request) : null;
  if (!r || (r.esito === "fuori" && !r.gestisce)) return null;
  const st = ' style="color:#1B2F4A;font-weight:600"';
  return (r.gestisce ? '<a href="' + base + '/accessi?t=' + tok + '"' + st + '>&#128101; Accessi e numeri</a> &nbsp;·&nbsp; ' : '') +
    '<a href="' + base + '/accessi?t=' + tok + '&esci=1"' + st + '>&#x23CF; Esci</a>';
}

// Dopo email e password giuste: lega la sessione al dispositivo, oppure chiede il codice.
export async function accessiDopoLogin(request, env, base, tok, h) {
  const vai = (t, k) => {
    const hh = new Headers({ Location: base + "/?t=" + t, "Cache-Control": "no-store" });
    if (k) hh.append("Set-Cookie", cookieImposta(base, k));
    return new Response(null, { status: 303, headers: hh });
  };
  if (!accessiAcceso(env)) return vai(tok, "");
  const d = dispositivoDi(request);
  const r = await rpc(env, "accessi_dopo_login", { p_token: tok, p_disp: accessiChiave(request), p_nome: d.nome, p_tipo: d.tipo, p_ip: ipBreve(request) }, 10000);
  if (!r || r.esito === "fuori") return vai(tok, "");
  if (r.esito === "ok") return vai(r.token || tok, ESA64.test(r.disp || "") ? r.disp : "");
  const hh = h.headers();
  if (ESA64.test(r.disp || "")) hh.append("Set-Cookie", cookieImposta(base, r.disp));
  if (r.esito === "troppi") return new Response(h.ingresso(base, "Hai chiesto troppi codici in un'ora. Riprova più tardi.", ""), { status: 200, headers: hh });
  return new Response(paginaCodice(base, h, r.email || "", ""), { status: 200, headers: hh });
}

function paginaCodice(base, h, email, avviso) {
  return h.foglio(base, "Codice per questo dispositivo",
    "Stai entrando da un dispositivo nuovo. Ti abbiamo mandato un codice di 6 cifre" + (email ? " a <strong>" + h.esc(email) + "</strong>" : "") + ".",
    (avviso ? '<p class="err">' + avviso + '</p>' : '') +
    '<form method="post" action="' + base + '/accedi/codice">' +
    '<label for="cd">Codice</label><input id="cd" name="codice" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>' +
    '<button type="submit">Entra</button></form>' +
    '<form method="post" action="' + base + '/accedi/codice"><input type="hidden" name="nuovo" value="1">' +
    '<button type="submit" style="background:transparent;color:var(--v);border:1px solid var(--l)">Mandami un altro codice</button></form>' +
    '<p class="piede">Il codice vale 10 minuti. Il tuo accesso è personale: non darlo a nessuno.</p>' +
    '<p class="piede"><a href="' + base + '/">&larr; Torna all\'accesso</a></p>');
}

export async function accessiCodice(request, env, base, h) {
  if (request.method !== "POST") return Response.redirect(new URL(request.url).origin + base + "/", 303);
  const f = new URLSearchParams((await request.text()).slice(0, 2000));
  const k = accessiChiave(request);
  if (f.get("nuovo")) {
    const r = await rpc(env, "accessi_codice_nuovo", { p_disp: k }, 10000);
    if (r && r.esito === "codice") return new Response(paginaCodice(base, h, r.email || "", ""), { status: 200, headers: h.headers() });
    const m = r && r.esito === "troppi" ? "Hai chiesto troppi codici in un'ora. Riprova più tardi." : "Il codice è scaduto: entra di nuovo con email e password.";
    return new Response(h.ingresso(base, m, ""), { status: 200, headers: h.headers() });
  }
  const r = await rpc(env, "accessi_codice_conferma", { p_disp: k, p_codice: (f.get("codice") || "").slice(0, 12) }, 10000);
  if (r && r.esito === "ok" && ESA64.test(r.token || "")) {
    return new Response(null, { status: 303, headers: { Location: base + "/?t=" + r.token, "Cache-Control": "no-store" } });
  }
  if (r && r.esito === "sbagliato") {
    return new Response(paginaCodice(base, h, "", "Il codice non è giusto. Puoi riprovare ancora " + (r.restano || 0) + " volte."), { status: 200, headers: h.headers() });
  }
  return new Response(h.ingresso(base, r ? "Il codice è scaduto: entra di nuovo con email e password." : "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", ""),
    { status: 200, headers: h.headers() });
}

// ---------------------------------------------------------------------------
// Pagina «Accessi e numeri»: /accessi?t=<gettone>[&a=<impresa>] e /accessi/azione (POST JSON {t, azione, dati}).
export async function portaleAccessi(request, env, base, sotto, inUrl, h) {
  if (!accessiAcceso(env)) return new Response("Not Found", { status: 404 });
  if (sotto === "/accessi/azione") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    let b = {};
    try { b = JSON.parse((await request.text()).slice(0, 20000)); } catch (e) { b = {}; }
    const tok = String(b.t || "").toLowerCase();
    const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" } });
    if (!ESA64.test(tok)) return j({ esito: "no" }, 400);
    const r = await rpc(env, "accessi_azione", { p_token: tok, p_azione: String(b.azione || "").slice(0, 30), p_dati: b.dati || {}, p_base: inUrl.origin + base }, 15000);
    return j(r || { esito: "servizio" });
  }
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  if (inUrl.searchParams.get("esci") === "1") {
    // «Esci»: chiude la sessione personale (accessi_esci) e fa dimenticare al telefono il collegamento ricordato (/?esci)
    await rpc(env, "accessi_esci", { p_token: tok }, 8000);
    CACHE.forEach((v, k) => { if (k.indexOf(tok) === 0) CACHE.delete(k); });
    return new Response(null, { status: 303, headers: { Location: base + "/?esci", "Cache-Control": "no-store" } });
  }
  const a = /^[0-9a-f-]{36}$/i.test(inUrl.searchParams.get("a") || "") ? inUrl.searchParams.get("a").toLowerCase() : null;
  const p = await rpc(env, "accessi_pagina", { p_token: tok, p_azienda: a }, 15000);
  if (!p) return new Response(h.foglio(base, "Accessi e numeri", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), { status: 503, headers: h.headers() });
  if (p.esito !== "ok") return new Response(h.foglio(base, "Accessi e numeri", "", '<p>Questa pagina si apre solo con l\'accesso personale del titolare o di un amministratore dell\'impresa.</p><p class="piede"><a href="' + base + '/?t=' + tok + '">&larr; Torna ai cantieri</a></p>'), { status: 200, headers: h.headers() });
  return new Response(paginaAccessi(base, tok, p, h), { status: 200, headers: h.headers() });
}

function quando(s) {
  if (!s) return "mai";
  try { return new Date(s).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
}

const RUOLI = { titolare: "Titolare", amministratore: "Amministratore", utente: "Utente" };
const EVENTI = { entrata: "Entrata", dispositivo_nuovo: "Dispositivo nuovo", codice_inviato: "Codice mandato", codice_sbagliato: "Codice sbagliato",
  dispositivo_verificato: "Dispositivo confermato", dispositivo_chiuso: "Dispositivo scollegato", altro_dispositivo: "Collegamento aperto da un altro dispositivo",
  contemporaneo: "Usato da due dispositivi insieme", scaduta: "Sessione scaduta", codice_servirebbe: "Dispositivo nuovo (codice non ancora chiesto: prova)",
  senza_gettone: "Richiesta senza gettone (controllo tecnico)", sessione_chiusa: "Sessione chiusa", esci_tutti: "Uscita da tutti i dispositivi",
  accesso_tolto: "Accesso tolto", accesso_riattivato: "Accesso riattivato", non_verificato: "Dispositivo da confermare", dispositivo_chiuso_: "" };

function paginaAccessi(base, tok, p, h) {
  const e = h.esc;
  const imp = p.impresa;
  const prova = p.stato === "prova";
  const avviso = prova
    ? '<div class="nota">In prova: le regole nuove valgono solo per gli accessi «Tutte le aziende»' + (p.modo === "registro" ? ", e per ora annotano soltanto senza fermare nessuno" : "") + '. Le imprese non vedono ancora niente di diverso.</div>' : "";
  let scelta = "";
  if (p.chi && p.chi.admin) {
    scelta = '<form method="get" action="' + base + '/accessi" class="riga"><input type="hidden" name="t" value="' + tok + '">' +
      '<label for="imp">Impresa</label><select id="imp" name="a" onchange="this.form.submit()"><option value="">Scegli l\'impresa…</option>' +
      (p.imprese || []).map((x) => '<option value="' + x.id + '"' + (imp && imp.id === x.id ? " selected" : "") + '>' + e(x.nome) + '</option>').join("") +
      '</select><noscript><button>Apri</button></noscript></form>';
  }
  let corpo = "";
  if (imp) {
    const ut = p.utenti || [];
    corpo += '<section><h2>Persone con l\'accesso all\'app</h2>' +
      (ut.length ? ut.map((u) => {
        // accessi-2 (15/11, paletto della B12): degli altri si vedono solo i dispositivi attivi, mai gli orari (non è un registro presenze)
        const disp = (u.dispositivi || []).map((d) => '<li>' + e(d.nome || "Dispositivo") + (d.verificato ? "" : ' <span class="tag">da confermare</span>') + '</li>').join("");
        return '<div class="pers' + (u.attivo ? "" : " tolta") + '"><div class="cap"><strong>' + e(u.nome || u.email) + '</strong>' +
          '<span class="tag">' + (u.attivo ? (u.in_attesa ? "invito mandato" : RUOLI[u.ruolo] || "Utente") : "tolto il " + quando(u.tolto_il)) + '</span></div>' +
          '<div class="sub">' + e(u.email) + '</div>' +
          (disp ? '<ul class="disp">' + disp + '</ul>' : '') +
          '<div class="az">' +
          (u.attivo ? '<select data-ruolo="' + u.id + '" aria-label="Ruolo">' + Object.keys(RUOLI).map((r) => '<option value="' + r + '"' + (u.ruolo === r ? " selected" : "") + '>' + RUOLI[r] + '</option>').join("") + '</select>' +
            (u.in_attesa ? '<button data-az="reinvita" data-u="' + u.id + '">Rimanda l\'invito</button>' : '') +
            '<button data-az="esci_tutti" data-u="' + u.id + '">Esci da tutti i dispositivi</button>' +
            '<button class="rosso" data-az="togli" data-u="' + u.id + '">Togli l\'accesso</button>'
            : '<button data-az="riattiva" data-u="' + u.id + '">Riattiva</button>') +
          '</div></div>';
      }).join("") : '<p>Nessuna persona ha ancora il suo accesso. Invitala qui sotto.</p>') + '</section>';
    corpo += '<section><h2>Invita una persona</h2><p class="sub">Riceve un\'email per scegliere la sua password. Ogni accesso è personale: una persona, un accesso.</p>' +
      '<form id="inv"><label for="in-n">Nome e cognome</label><input id="in-n" autocomplete="off">' +
      '<label for="in-e">Email personale</label><input id="in-e" type="email" autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '<label for="in-r">Ruolo</label><select id="in-r"><option value="utente">Utente</option><option value="amministratore">Amministratore (può invitare e togliere persone)</option><option value="titolare">Titolare</option></select>' +
      '<button type="submit">Invita</button><p id="in-ok" class="ok" hidden></p></form></section>';
    const c = p.contate;
    if (c) {
      corpo += '<section><h2>Persone contate negli ultimi 30 giorni</h2>' +
        '<p class="tot"><strong>' + c.persone + '</strong> persone · ' + c.accessi + ' con l\'accesso all\'app · ' + c.numeri + ' con il numero WhatsApp</p>' +
        '<p class="sub">' + e(c.regola) + '</p><table><thead><tr><th>Persona</th><th>Come</th><th>Conta nel mese</th></tr></thead><tbody>' +
        (c.righe || []).map((r) => '<tr><td>' + e(r.nome || "") + '</td><td>' + (r.fonte === "accesso" ? "App" : "WhatsApp") + '</td><td>' + (r.conta ? "sì" : (r.sospesa ? "no (sospesa)" : "no")) + '</td></tr>').join("") +
        '</tbody></table></section>';
    }
  } else if (p.chi && p.chi.admin) {
    corpo += '<p>Scegli un\'impresa per vedere le sue persone.</p>';
  }
  if ((p.miei || []).length) {
    corpo += '<section><h2>I tuoi dispositivi</h2><p class="sub">Il tuo accesso vale al massimo su ' + p.max_dispositivi + ' dispositivi. Se non ne riconosci uno, scollegalo.</p><ul class="disp">' +
      p.miei.map((d) => '<li>' + e(d.nome || "Dispositivo") + ' · ' + quando(d.ultimo) + (d.verificato ? "" : ' <span class="tag">da confermare</span>') +
        ' <button class="piccolo" data-az="chiudi_mio" data-d="' + d.id + '">Scollega</button></li>').join("") + '</ul>' +
      ((p.registro || []).length ? '<details><summary>Ultimi accessi</summary><ul class="reg">' + p.registro.map((r) => '<li>' + quando(r.quando) + ' · ' + e(EVENTI[r.evento] || r.evento) + (r.dispositivo ? ' · ' + e(r.dispositivo) : '') + '</li>').join("") + '</ul></details>' : '') +
      '</section>';
  }
  const cfg = JSON.stringify({ u: base + "/accessi/azione", t: tok, a: imp ? imp.id : "" }).replace(/</g, "\\u003c");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>Accessi e numeri - TIX · Diario di cantiere</title>' + h.testa(base) +
    '<style>:root{--v:#1B2F4A;--t:#1b1f1d;--s:#5b6560;--b:#f4f6f5;--c:#fff;--l:#dfe5e2;--r:#B3261E}' +
    '@media (prefers-color-scheme:dark){:root{--v:#8fb0d6;--t:#eef2f0;--s:#a9b3ae;--b:#111513;--c:#1a201d;--l:#2c3531;--r:#f2b8b5}}' +
    '*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--b);color:var(--t)}' +
    'main{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.35rem;margin:8px 0 4px}h2{font-size:1.05rem;margin:0 0 10px}' +
    'section{background:var(--c);border:1px solid var(--l);border-radius:14px;padding:18px;margin:14px 0}' +
    '.sub{color:var(--s);font-size:.9rem;margin:2px 0 8px}.nota{background:#fff7e0;color:#5a4500;border-radius:10px;padding:10px 12px;margin:10px 0;font-size:.9rem}' +
    '@media (prefers-color-scheme:dark){.nota{background:#3a3214;color:#f3e3a6}}' +
    'label{display:block;font-weight:600;margin:12px 0 6px}input,select{width:100%;font-size:1rem;padding:10px;border:1px solid var(--l);border-radius:10px;background:var(--b);color:var(--t)}' +
    'button{font-size:.95rem;font-weight:600;padding:9px 14px;border:0;border-radius:10px;background:var(--v);color:#fff;cursor:pointer}' +
    '@media (prefers-color-scheme:dark){button{color:#111513}}' +
    '#inv button{width:100%;margin-top:14px;padding:12px}.rosso{background:var(--r)}.piccolo{padding:4px 10px;font-size:.82rem}' +
    '.pers{border-top:1px solid var(--l);padding:12px 0}.pers:first-of-type{border-top:0}.tolta{opacity:.6}.cap{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
    '.tag{font-size:.75rem;font-weight:700;background:var(--b);border:1px solid var(--l);border-radius:999px;padding:2px 8px;color:var(--s)}' +
    '.az{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.az select{width:auto}.disp,.reg{margin:6px 0 0;padding-left:18px;color:var(--s);font-size:.9rem}.disp li{margin:4px 0}' +
    'table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:6px 4px;border-top:1px solid var(--l)}' +
    '.ok{color:var(--v);font-weight:600}.tot{margin:0 0 6px}.riga{max-width:420px}a{color:var(--v);font-weight:600}' +
    CAMPI_ROSSI_CSS + '</style></head><body><main>' +
    '<p><a href="' + base + '/?t=' + tok + '">&larr; Torna ai cantieri</a></p>' +
    '<h1>Accessi e numeri' + (imp ? ' · ' + e(imp.nome) : '') + '</h1>' +
    '<p class="sub">Chi entra nell\'app, da quali dispositivi, e chi conta come persona nel canone.</p>' + avviso + scelta + corpo +
    '</main><script>' + CAMPI_ROSSI_JS + '</script><script>(function(){var C=' + cfg + ';' +
    'function chiama(az,dati){dati=dati||{};if(C.a)dati.azienda=C.a;return fetch(C.u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({t:C.t,azione:az,dati:dati})}).then(function(r){return r.json();});}' +
    'var ERR={email:"Scrivi un\'email giusta",nome:"Scrivi nome e cognome",altra:"Questa email è già usata per un\'altra impresa",professionista:"Questa email è già un accesso da professionista",senza_portale:"L\'impresa non ha ancora l\'area riservata",permesso:"Non hai il permesso per questa azione",te_stesso:"Non puoi togliere il tuo accesso",servizio:"Il servizio non risponde: riprova",accesso:"Entra di nuovo con email e password"};' +
    'var f=document.getElementById("inv");if(f)f.addEventListener("submit",function(ev){ev.preventDefault();var n=document.getElementById("in-n"),e=document.getElementById("in-e"),ru=document.getElementById("in-r");' +
    'if(!crControlla([{el:n,testo:"Scrivi nome e cognome della persona"},{el:e,ok:function(x){return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(x.value.trim());},testo:"Scrivi l\'email personale della persona"}]))return;' +
    'var b=f.querySelector("button");b.disabled=true;chiama("invita",{nome:n.value.trim(),email:e.value.trim(),ruolo:ru.value}).then(function(r){b.disabled=false;' +
    'if(r&&r.esito==="ok"){var o=document.getElementById("in-ok");o.hidden=false;o.textContent="Invito mandato a "+e.value.trim()+".";setTimeout(function(){location.reload();},1200);return;}' +
    'var el=r&&r.campo==="nome"?n:e;crSegna(el,ERR[r&&r.esito]||"Non è stato possibile mandare l\'invito");}).catch(function(){b.disabled=false;crSegna(e,ERR.servizio);});});' +
    'var DOM={togli:"Togliere l\'accesso a questa persona? Non potrà più entrare finché non la riattivi.",esci_tutti:"Chiudere tutte le sessioni di questa persona? Dovrà entrare di nuovo con email, password e codice.",chiudi_mio:"Scollegare questo dispositivo?"};' +
    'document.addEventListener("click",function(ev){var b=ev.target.closest&&ev.target.closest("button[data-az]");if(!b)return;var az=b.getAttribute("data-az");' +
    'if(DOM[az]&&!confirm(DOM[az]))return;b.disabled=true;chiama(az,{utente:b.getAttribute("data-u"),dispositivo:b.getAttribute("data-d")}).then(function(r){' +
    'if(r&&r.esito==="ok"){location.reload();return;}b.disabled=false;crSegna(b,ERR[r&&r.esito]||"Non è stato possibile");}).catch(function(){b.disabled=false;crSegna(b,ERR.servizio);});});' +
    'document.querySelectorAll("select[data-ruolo]").forEach(function(s){s.addEventListener("change",function(){chiama("ruolo",{utente:s.getAttribute("data-ruolo"),ruolo:s.value}).then(function(r){if(!r||r.esito!=="ok")crSegna(s,ERR[r&&r.esito]||"Ruolo non cambiato");});});});' +
    '})();</script></body></html>';
}
