// ============================================================================
// SUBAPPALTI — contabilità dei subappaltatori nella pagina SAL (09/11/2026, fase S1, chat SAL).
// Piano e scelte di Filippo del 09/11: Strumenti/sal-tix/subappalti/01-piano.md.
// Lato impresa (gettone dell'area riservata, scheda «Subappalti» della pagina SAL):
//   POST /sal/sub/api   {t, c, azione, id?, dati?}   → sub_contesto, sub_contratto_salva, sub_contratto_azione,
//                                                       sub_misura_decidi, sub_sal_emetti, sub_sal_stato
//   GET  /sal/sub/doc?t=&c=&k=<subappalto>[&id=<contabilità>]&f=pdf|xlsx → PDF ed Excel (gli stessi del SAL)
//   GET  /sal/sub/foto?t=&c=&p=<percorso>            → foto di una misura del sub
//   GET  /sal/subappaltatori?t=&c=                   → pagina «Subappaltatori» a sé (sal.js, 10/11/2026), aperta dal
//                                                       pulsante nella pagina del cantiere (subPulsante / subIniezione)
// Porta del sub (link personale senza password: un cantiere, scadenza, revoca, registro):
//   GET  /sal/sub/porta?k=<codice>   → il codice va in un cookie (tix_sub, HttpOnly) e sparisce dall'indirizzo
//   GET  /sal/sub/porta              → pagina del sub: misure dal telefono, osservazioni, contabilità
//   POST /sal/sub/porta/api          → sub_porta_contesto, sub_porta_misura_salva, sub_porta_misura_annulla
//   POST /sal/sub/porta/foto?nome=   → foto già rimpicciolita dal telefono, nell'archivio del cantiere
//   GET  /sal/sub/porta/foto?p=      → foto
//   GET  /sal/sub/porta/doc?id=&f=   → PDF ed Excel delle sue contabilità
// Il database decide tutto (impostazioni.subappalti_attivo). Nel database c'è solo l'impronta del codice del link.
// Si spegne anche con la variabile del Worker SUBAPPALTI = "off".
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GETTONE = /^[0-9a-f]{64}$/;
const MAX_FOTO = 8 * 1024 * 1024;

function json(o, stato, extra) {
  const hd = { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
  if (extra) for (const k in extra) hd[k] = extra[k];
  return new Response(JSON.stringify(o), { status: stato || 200, headers: hd });
}

async function leggiCorpo(request) {
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return { errore: 415 };
  try {
    const t = await request.text();
    if (t.length > 120000) return { errore: 413 };
    const b = JSON.parse(t);
    return b && typeof b === "object" ? b : { errore: 400 };
  } catch (e) { return { errore: 400 }; }
}

function casuale() {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Solo i campi attesi, con la lunghezza massima: il database controlla comunque tutto.
function pulisci(azione, d) {
  const o = {};
  if (!d || typeof d !== "object") return o;
  const s = (k, n, da, a) => { const x = (da || d)[k]; if (x !== undefined && x !== null) (a || o)[k] = String(x).slice(0, n); };
  const u = (k, a, da) => { const x = String((da || d)[k] || "").toLowerCase(); if (UUID.test(x)) (a || o)[k] = x; };
  if (azione === "contratto") {
    u("id"); u("rdo_id");
    s("impresa_nome", 160); s("referente_nome", 120); s("referente_email", 160); s("referente_telefono", 40); s("oggetto", 400);
    s("inizio", 10); s("fine_prevista", 10); s("regola", 12); s("soglia_importo", 20); s("ritenuta_pct", 10); s("autore", 120);
    if (/^[0-9]{1,18}$/.test(String(d.rubrica_id || ""))) o.rubrica_id = String(d.rubrica_id);
    if (Array.isArray(d.voci)) {
      o.voci = d.voci.slice(0, 500).filter((v) => v && typeof v === "object").map((v) => {
        const r = {}; u("id", r, v); s("tariffa", 40, v, r); s("descrizione", 2000, v, r); s("unita", 20, v, r); s("quantita", 20, v, r); s("prezzo", 20, v, r);
        if (/^[0-9]{1,6}$/.test(String(v.computo_voce_nr || ""))) r.computo_voce_nr = String(v.computo_voce_nr);
        return r;
      });
    }
  } else if (azione === "misura") {
    s("azione", 14); s("testo", 600); s("autore", 120); s("fino_al", 10);
  } else if (azione === "emetti") {
    s("periodo_a", 10); s("autore", 120);
  } else if (azione === "sal_stato") {
    s("azione", 12); s("data", 10); s("nota", 300); s("motivo", 300); s("autore", 120);
  } else if (azione === "link" || azione === "allunga" || azione === "spegni" || azione === "chiudi" || azione === "riapri") {
    s("autore", 120);
  } else if (azione === "porta_misura") {
    u("id"); u("voce_id"); s("data", 10); s("zona", 120); s("piano", 60); s("lotto", 60); s("descrizione", 600); s("autore", 120);
    ["pu", "l", "w", "h", "quantita"].forEach((k) => s(k, 20));
    if (d.meno === true) o.meno = true;
    if (Array.isArray(d.foto)) {
      o.foto = d.foto.slice(0, 6).filter((f) => f && typeof f === "object").map((f) => {
        const r = {}; s("path", 220, f, r); s("nome", 120, f, r); if (/^[0-9]{1,9}$/.test(String(f.byte || ""))) r.byte = String(f.byte); return r;
      });
    }
  }
  return o;
}

// ---------------------------------------------------------------------------- pulsante nella pagina del cantiere (10/11/2026)
// Filippo: «Io devo avere un'icona con scritto subappaltatori … cliccando là capire quali sono i subappaltatori dentro in quel
// determinato cantiere». Chiamata fatta da index.js insieme a dashboard_html: errore o attesa oltre 8 secondi = nessun pulsante.
export async function subPulsante(env, token, commessa) {
  if (!env || !env.SUPABASE_SERVICE_KEY || env.SUBAPPALTI === "off") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch((env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co") + "/rest/v1/rpc/sub_pulsante", {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_token: token, p_commessa: commessa }), signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j !== "object" || j.esito !== "ok" || j.attiva !== true) return null;
    return { attiva: true, contratti: Math.max(0, Math.min(9999, Number(j.contratti) || 0)),
      da_decidere: Math.max(0, Math.min(999, Number(j.da_decidere) || 0)) };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Nono pulsante della riga dei pulsanti del cantiere, subito dopo «Offerte» (o dopo «Costruttivi» / «Progetti» se mancano).
// index.js mette questo script DOPO quello delle Offerte nella catena: a ogni giro (subito, 0, 60, 150, 400 ms e al caricamento)
// si rimette dopo di loro. Il numero arancione = misure mandate dai subappaltatori e ancora da decidere.
export function subIniezione(base, token, commessa, daDecidere) {
  const u = base + "/sal/subappaltatori?t=" + token + "&c=" + encodeURIComponent(commessa);
  const n = Math.max(0, Math.min(999, Number(daDecidere) || 0));
  const icona = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v2z"/><path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"/>' +
    '<path d="M4 15v-3a6 6 0 0 1 6-6"/><path d="M14 6a6 6 0 0 1 6 6v3"/></svg>';
  const etichetta = icona + " Subappaltatori" + (n ? ' <span class="gl-sb-n" title="Misure da decidere">' + n + "</span>" : "");
  return "<style>.gl-sb-barra{max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right}" +
    ".gl-sb-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 16px;border:1.5px solid #B5523B;border-radius:10px;background:#FBF0EC;color:#8A3A27;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none;box-shadow:0 0 0 3px rgba(181,82,59,.14)}" +
    ".gl-sb-b:hover,.gl-sb-b:focus-visible{background:#B5523B;color:#fff;outline:none}" +
    ".gl-sb-n{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#B45309;color:#fff;font-size:.74rem;font-weight:800}" +
    ".gl-of-barra .gl-sb-b,.gl-cs-barra .gl-sb-b,.gl-pg-barra .gl-sb-b{margin-left:8px}" +
    // con nove pulsanti: 3 colonne sul computer (tre righe), 2 fino a 900 px, 1 sul telefono
    ".gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9{grid-template-columns:repeat(3,minmax(0,1fr))}" +
    "@media (max-width:900px){.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
    "@media (max-width:640px){.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9{grid-template-columns:minmax(0,1fr)}}" +
    "@media (prefers-color-scheme:dark){.gl-sb-b{background:#3a1d15;color:#f3d6cc;border-color:#D07A63}}</style>" +
    "<script>(function(){try{var a=document.createElement('a');a.className='gl-sb-b';a.href=" + JSON.stringify(u) + ";a.innerHTML=" + JSON.stringify(etichetta) + ";" +
    "function metti(){var r=document.querySelector('.gl-azioni');" +
    "if(r){var prima=r.querySelector('.gl-of-b')||r.querySelector('.gl-cs-b')||r.querySelector('.gl-pg-b');if(prima){if(prima.nextElementSibling!==a)r.insertBefore(a,prima.nextSibling);}else if(r.lastElementChild!==a)r.appendChild(a);" +
    "var v=document.querySelector('.gl-sb-barra');if(v&&!v.children.length&&v.parentNode)v.parentNode.removeChild(v);" +
    "var n=r.children.length;r.classList.toggle('gl-az4',n===4);r.classList.toggle('gl-az5',n>=5);r.classList.toggle('gl-az6',n>=6);r.classList.toggle('gl-az7',n>=7);r.classList.toggle('gl-az8',n>=8);r.classList.toggle('gl-az9',n>=9);return;}" +
    "var pb=document.querySelector('.gl-of-barra')||document.querySelector('.gl-cs-barra')||document.querySelector('.gl-pg-barra');if(pb){if(pb.lastElementChild!==a)pb.appendChild(a);return;}" +
    "if(a.parentNode)return;var b=document.createElement('div');b.className='gl-sb-barra';b.appendChild(a);var nav=document.querySelector('nav.schede');" +
    "if(nav&&nav.parentNode){nav.parentNode.insertBefore(b,nav.nextSibling);}else{document.body.insertBefore(b,document.body.firstChild);}}" +
    "metti();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',metti);setTimeout(metti,0);setTimeout(metti,60);setTimeout(metti,150);setTimeout(metti,400);" +
    "window.addEventListener('load',metti);}catch(e){}})();</script>";
}

export async function portaleSub(request, env, base, inUrl, h, fn) {
  if (env.SUBAPPALTI === "off") return new Response("Not Found", { status: 404 });
  const sotto = inUrl.pathname.slice(base.length);
  if (sotto === "/sal/sub/api") return apiImpresa(request, env, base, inUrl, h);
  if (sotto === "/sal/sub/doc") return docImpresa(request, env, base, inUrl, h, fn);
  if (sotto === "/sal/sub/foto") return fotoImpresa(request, env, base, inUrl, h);
  if (sotto === "/sal/sub/porta") return porta(request, env, base, inUrl, h);
  if (sotto === "/sal/sub/porta/api") return apiPorta(request, env, h);
  if (sotto === "/sal/sub/porta/foto") return request.method === "POST" ? fotoPortaCarica(request, env, inUrl, h) : fotoPortaVedi(request, env, inUrl, h);
  if (sotto === "/sal/sub/porta/doc") return docPorta(request, env, base, inUrl, h, fn);
  return new Response("Not Found", { status: 404 });
}

// ---------------------------------------------------------------------------- lato impresa
async function apiImpresa(request, env, base, inUrl, h) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const b = await leggiCorpo(request);
  if (b.errore) return json({ esito: "errore" }, b.errore);
  const tok = String(b.t || "").toLowerCase();
  if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
  const c = String(b.c || "").toLowerCase();
  if (!UUID.test(c)) return json({ esito: "errore" }, 400);
  const id = String(b.id || "").toLowerCase();
  const az = String(b.azione || "");
  const dati = pulisci(az, b.dati);
  const chiama = (nome, corpo) => h.rpc(env, nome, corpo, 25000).catch(() => null);
  let r = null;
  if (az === "contesto") r = await chiama("sub_contesto", { p_token: tok, p_commessa: c });
  else if (az === "contratto") r = await chiama("sub_contratto_salva", { p_token: tok, p_commessa: c, p_dati: dati });
  else if (["link", "allunga", "spegni", "chiudi", "riapri"].indexOf(az) !== -1) {
    if (!UUID.test(id)) return json({ esito: "errore" }, 400);
    r = await chiama("sub_contratto_azione", { p_token: tok, p_commessa: c, p_id: id, p_azione: az, p_autore: dati.autore || null });
    // il codice del link si mostra una volta sola all'impresa, dentro l'indirizzo: nel database resta solo l'impronta
    if (r && r.esito === "ok" && az === "link") {
      const k = String(r.k || "");
      if (!GETTONE.test(k)) return json({ esito: "incerto" });
      r = { esito: "ok", url: inUrl.origin + base + "/sal/sub/porta?k=" + k, scade_il: r.scade_il };
    }
  } else if (az === "misura") {
    if (!UUID.test(id) || ["accetta", "osservazione", "riapri", "accetta_tutte"].indexOf(dati.azione || "") === -1) return json({ esito: "errore" }, 400);
    r = await chiama("sub_misura_decidi", { p_token: tok, p_commessa: c, p_id: id, p_azione: dati.azione, p_dati: dati });
  } else if (az === "emetti") {
    if (!UUID.test(id)) return json({ esito: "errore" }, 400);
    r = await chiama("sub_sal_emetti", { p_token: tok, p_commessa: c, p_id: id, p_dati: dati });
  } else if (az === "sal_stato") {
    if (!UUID.test(id) || ["pagato", "non_pagato", "annulla"].indexOf(dati.azione || "") === -1) return json({ esito: "errore" }, 400);
    r = await chiama("sub_sal_stato", { p_token: tok, p_commessa: c, p_id: id, p_azione: dati.azione, p_dati: dati });
  } else {
    return json({ esito: "errore" }, 400);
  }
  return r ? json(r) : json({ esito: "incerto" });
}

function nomeScarico(nome, ripiego) {
  return nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || ripiego;
}

function rispostaFile(r, f, fn, metodo, h, base, inUrl, ritorno) {
  if (!r) return h.risposta(h.foglio(base, "Subappalti", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), 503);
  if (r.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (r.esito !== "ok") {
    return h.risposta(h.foglio(base, "Subappalti", "", '<p class="err">' + h.esc(r.messaggio || (r.esito === "scaduto" ? "Il link è scaduto: chiedi all’impresa di allungarlo." : "File non preparato.")) + "</p>" +
      (ritorno ? '<p class="piede"><a href="' + h.esc(ritorno) + '">&larr; Torna indietro</a></p>' : "")), 400);
  }
  const pdf = f === "pdf";
  const file = pdf ? fn.salPdf(r) : fn.salXlsx(r);
  const nome0 = String(r.nome_file || "TIX Contabilita sub.xlsx");
  const nome = pdf ? nome0.replace(/\.xlsx$/i, "") + ".pdf" : nome0;
  return new Response(metodo === "HEAD" ? null : file, { status: 200, headers: {
    "Content-Type": pdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": 'attachment; filename="' + nomeScarico(nome, pdf ? "TIX Contabilita sub.pdf" : "TIX Contabilita sub.xlsx") + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}

async function docImpresa(request, env, base, inUrl, h, fn) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const k = String(inUrl.searchParams.get("k") || "").toLowerCase();
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  if (!UUID.test(c) || !UUID.test(k)) return new Response("Not Found", { status: 404 });
  const r = await h.rpc(env, "sub_doc_dati", { p_token: tok, p_commessa: c, p_contratto: k, p_sal: UUID.test(id) ? id : null }, 25000).catch(() => null);
  return rispostaFile(r, inUrl.searchParams.get("f") === "pdf" ? "pdf" : "xlsx", fn, metodo, h, base, inUrl, base + "/sal/subappaltatori?t=" + tok + "&c=" + c);
}

async function streamFoto(env, percorso, metodo) {
  const supabaseUrl = env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co";
  const f = await fetch(supabaseUrl + "/storage/v1/object/wa-media/" + percorso.split("/").map(encodeURIComponent).join("/"), {
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  if (!f || !f.ok) return new Response("Foto non disponibile", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  const tipo = /\.png$/i.test(percorso) ? "image/png" : /\.webp$/i.test(percorso) ? "image/webp" : "image/jpeg";
  return new Response(metodo === "HEAD" ? null : f.body, { status: 200, headers: {
    "Content-Type": tipo, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
}

async function fotoImpresa(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const tok = String(inUrl.searchParams.get("t") || "").toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const p = String(inUrl.searchParams.get("p") || "");
  if (!GETTONE.test(tok) || !UUID.test(c) || !p) return new Response("Not Found", { status: 404 });
  const r = await h.rpc(env, "sub_foto_ok", { p_token: tok, p_commessa: c, p_path: p }, 10000).catch(() => null);
  if (!r || r.esito !== "ok") return new Response("Not Found", { status: 404 });
  return streamFoto(env, p, metodo);
}

// ---------------------------------------------------------------------------- porta del sub
function leggiK(request) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)tix_sub=([0-9a-f]{64})(?:;|$)/);
  return m ? m[1] : "";
}
function cookie(base, k, eta) {
  return "tix_sub=" + k + "; Path=" + base + "/sal/sub/porta; Max-Age=" + eta + "; HttpOnly; Secure; SameSite=Lax";
}
const MSG_PORTA = {
  link: "Questo link non vale più. Chiedi all’impresa che ti ha incaricato di mandarti il link nuovo.",
  scaduto: "Il link è scaduto. Chiedi all’impresa che ti ha incaricato di allungarlo: lo fa con un clic.",
  spento: "La contabilità dei subappalti non è disponibile in questo momento.",
  nessuno: "Per entrare apri il link personale che ti ha mandato l’impresa che ti ha incaricato."
};

async function porta(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const kq = String(inUrl.searchParams.get("k") || "").toLowerCase();
  if (kq) {
    if (!GETTONE.test(kq)) return paginaErrore(base, h, "link", true);
    const r = await h.rpc(env, "sub_porta_contesto", { p_k: kq }, 15000).catch(() => null);
    if (!r) return h.risposta(h.foglio(base, "Contabilità del subappalto", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), 503);
    if (r.esito !== "ok") return paginaErrore(base, h, r.esito, true);
    // il codice passa nel cookie e sparisce dall'indirizzo (cronologia, schermate, inoltri)
    return new Response(null, { status: 303, headers: { Location: base + "/sal/sub/porta", "Set-Cookie": cookie(base, kq, 120 * 86400),
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  const k = leggiK(request);
  if (!k) return paginaErrore(base, h, "nessuno", false);
  const d = await h.rpc(env, "sub_porta_contesto", { p_k: k }, 20000).catch(() => null);
  if (!d) return h.risposta(h.foglio(base, "Contabilità del subappalto", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), 503);
  if (d.esito !== "ok") return paginaErrore(base, h, d.esito, true);
  return new Response(metodo === "HEAD" ? null : paginaPorta(base, d, h), { status: 200, headers: h.headers() });
}

function paginaErrore(base, h, esito, togliCookie) {
  const msg = MSG_PORTA[esito] || MSG_PORTA.link;
  const html = h.foglio(base, "Contabilità del subappalto", "", '<p class="err">' + h.esc(msg) + "</p>");
  return new Response(html, { status: esito === "nessuno" ? 401 : 403, headers: h.headers(togliCookie ? { "Set-Cookie": cookie(base, "", 0) } : undefined) });
}

async function apiPorta(request, env, h) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const k = leggiK(request);
  if (!k) return json({ esito: "link" }, 403);
  const b = await leggiCorpo(request);
  if (b.errore) return json({ esito: "errore" }, b.errore);
  const az = String(b.azione || "");
  const chiama = (nome, corpo) => h.rpc(env, nome, corpo, 25000).catch(() => null);
  let r = null;
  if (az === "contesto") r = await chiama("sub_porta_contesto", { p_k: k });
  else if (az === "misura") r = await chiama("sub_porta_misura_salva", { p_k: k, p_dati: pulisci("porta_misura", b.dati) });
  else if (az === "togli") {
    const id = String(b.id || "").toLowerCase();
    if (!UUID.test(id)) return json({ esito: "errore" }, 400);
    r = await chiama("sub_porta_misura_annulla", { p_k: k, p_id: id });
  } else return json({ esito: "errore" }, 400);
  return r ? json(r) : json({ esito: "incerto" });
}

// foto della misura: il telefono la rimpicciolisce prima (JPEG); qui si controlla l'accesso, il tipo e la dimensione
async function fotoPortaCarica(request, env, inUrl, h) {
  const k = leggiK(request);
  if (!k) return json({ esito: "link" }, 403);
  if (Number(request.headers.get("Content-Length") || 0) > MAX_FOTO) return json({ esito: "grande", messaggio: "La foto è troppo grande (massimo 8 MB)." }, 413);
  const r = await h.rpc(env, "sub_porta_foto_ok", { p_k: k }, 10000).catch(() => null);
  if (!r) return json({ esito: "incerto" }, 503);
  if (r.esito !== "ok" || !r.cartella) return json({ esito: String(r.esito || "errore"), messaggio: r.messaggio || "" }, 403);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ esito: "vuoto", messaggio: "La foto è vuota." }, 400);
  if (bytes.length > MAX_FOTO) return json({ esito: "grande", messaggio: "La foto è troppo grande (massimo 8 MB)." }, 413);
  let est = "", mime = "";
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) { est = ".jpg"; mime = "image/jpeg"; }
  else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) { est = ".png"; mime = "image/png"; }
  else if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "RIFF" && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === "WEBP") { est = ".webp"; mime = "image/webp"; }
  if (!est) return json({ esito: "formato", messaggio: "Carica una foto (JPEG o PNG)." }, 400);
  const ora = new Date();
  const giorno = ora.getUTCFullYear() + String(ora.getUTCMonth() + 1).padStart(2, "0") + String(ora.getUTCDate()).padStart(2, "0");
  const percorso = String(r.cartella) + giorno + "-" + casuale() + est;
  const supabaseUrl = env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const up = await fetch(supabaseUrl + "/storage/v1/object/wa-media/" + percorso, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY, "Content-Type": mime, "x-upsert": "false" },
      body: bytes, signal: ctrl.signal
    });
    if (!up.ok) return json({ esito: "archivio", messaggio: "La foto non si è salvata: riprova tra un minuto." }, 502);
  } catch (e) {
    return json({ esito: "archivio", messaggio: "La foto non si è salvata: riprova tra un minuto." }, 502);
  } finally { clearTimeout(timer); }
  const nome = String(inUrl.searchParams.get("nome") || "").replace(/[\u0000-\u001f\\/]+/g, " ").trim().slice(0, 120);
  return json({ esito: "ok", path: percorso, nome: nome || "foto" + est, byte: bytes.length });
}

async function fotoPortaVedi(request, env, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD, POST" } });
  const k = leggiK(request);
  const p = String(inUrl.searchParams.get("p") || "");
  if (!k || !p) return new Response("Not Found", { status: 404 });
  const r = await h.rpc(env, "sub_porta_foto_ok", { p_k: k, p_path: p }, 10000).catch(() => null);
  if (!r || r.esito !== "ok") return new Response("Not Found", { status: 404 });
  return streamFoto(env, p, metodo);
}

async function docPorta(request, env, base, inUrl, h, fn) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const k = leggiK(request);
  if (!k) return paginaErrore(base, h, "nessuno", false);
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  const r = await h.rpc(env, "sub_porta_doc", { p_k: k, p_sal: UUID.test(id) ? id : null }, 25000).catch(() => null);
  return rispostaFile(r, inUrl.searchParams.get("f") === "pdf" ? "pdf" : "xlsx", fn, metodo, h, base, inUrl, base + "/sal/sub/porta");
}

// ---------------------------------------------------------------------------- pagina del sub
function paginaPorta(base, d, h) {
  const e = h.esc;
  const k = (d.contratto || {});
  const cfg = JSON.stringify({ u: base + "/sal/sub/porta" }).replace(/</g, "\\u003c");
  const dati = JSON.stringify(d).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>Contabilità del subappalto - " + e(k.impresa_nome || "") + "</title>" + h.testa(base) +
    "<style>" + STILE_PORTA + "</style></head><body>" +
    '<header><div class="marchio">TIX</div><div class="centro"><h1>Contabilità del subappalto</h1><p>' + e(k.impresa_nome || "") + "</p></div></header>" +
    '<main id="sp-corpo"></main>' +
    '<dialog id="sp-dlg" aria-labelledby="sp-dlg-t"><form method="dialog" novalidate><div class="dl-t"><h2 id="sp-dlg-t"></h2><p id="sp-dlg-s"></p></div>' +
    '<div class="dl-c" id="sp-dlg-c"></div><p class="msg" id="sp-dlg-m" aria-live="polite"></p>' +
    '<div class="dl-b"><button type="button" class="no" id="sp-dlg-no">Chiudi</button><button type="button" class="si" id="sp-dlg-si">Salva</button></div></form></dialog>' +
    '<div id="sp-toast" class="toast" role="status" hidden></div>' +
    "<script>window.SP_C=" + cfg + ";window.SP_D=" + dati + ";</script><script>" + PORTA_APP + "</script></body></html>";
}

const STILE_PORTA =
  ":root{--sub:#B5523B;--sub-s:#8A3A27;--sub-c:#FBF0EC;--sub-b:#EBC9BE;--bordo:#dfe3e1;--sfondo:#F5F4F2}" +
  '*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--sfondo);color:#1b1f1d;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.45}' +
  "header{background:#052A21;color:#fff;padding:14px 16px;display:flex;gap:14px;align-items:center}header .marchio{font-weight:900;font-size:1.3rem;letter-spacing:.04em;color:#F26A10}" +
  "header h1{margin:0;font-size:1.15rem}header p{margin:2px 0 0;font-size:.9rem;opacity:.9}" +
  "main{max-width:880px;margin:0 auto;padding:14px 14px 60px}" +
  ".pann{background:#fff;border:1px solid var(--bordo);border-radius:14px;padding:14px 16px;margin:0 0 12px}.pann h2{margin:0 0 8px;font-size:1.02rem;color:var(--sub-s)}" +
  ".info{font-size:.9rem;color:#4b5550}.info b{color:#1b1f1d}.avv{background:#FFF4E5;border-left:4px solid #C27A12;border-radius:10px;padding:10px 12px;margin:0 0 12px;font-weight:700;color:#5A3D00}" +
  ".b{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 16px;border-radius:12px;border:1px solid var(--sub);background:#fff;color:var(--sub-s);font:inherit;font-weight:700;cursor:pointer;text-decoration:none}" +
  ".b.pr{background:var(--sub);color:#fff}.b.ro{border-color:#b91c1c;color:#b91c1c}.b.gr{width:100%;min-height:54px;font-size:1.05rem}.b:disabled{opacity:.5}" +
  ".riga-b{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0}" +
  ".ms{list-style:none;margin:0;padding:0}.ms li{border-top:1px solid #eee;padding:10px 0}.ms .q{font-weight:800;font-variant-numeric:tabular-nums}.ms .sub{color:#5b6560;font-size:.85rem}" +
  ".oss{background:#FEF2F2;border-left:4px solid #b91c1c;border-radius:8px;padding:8px 10px;margin:6px 0;color:#7f1d1d;font-weight:700;font-size:.9rem}" +
  ".ft{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0}.ft a,.ft span.th{position:relative;display:block;width:64px;height:64px;border-radius:8px;overflow:hidden;background:#eee}.ft img{width:100%;height:100%;object-fit:cover}" +
  ".ft .x{position:absolute;top:2px;right:2px;width:22px;height:22px;border-radius:50%;border:0;background:rgba(0,0,0,.6);color:#fff;font-weight:900;cursor:pointer}" +
  "table.el{width:100%;border-collapse:collapse;font-size:.88rem;font-variant-numeric:tabular-nums}table.el td,table.el th{padding:6px 4px;border-bottom:1px solid #eee;text-align:right;vertical-align:top}" +
  "table.el th{font-size:.72rem;text-transform:uppercase;color:var(--sub-s)}table.el .t{text-align:left}" +
  ".st{font-size:.74rem;font-weight:800;padding:2px 8px;border-radius:99px;background:#eee}.st.ok{background:#E6F6EC;color:#0B5E37}.st.am{background:#FFF4DC;color:#7A4A00}.st.ro{background:#FEF2F2;color:#7f1d1d}" +
  "label{display:block;font-size:.88rem;font-weight:700;margin:0 0 8px}label small{font-weight:400;color:#6b7280}" +
  "input,select,textarea{display:block;width:100%;margin-top:4px;min-height:46px;padding:8px 10px;border:1px solid #c9d1cd;border-radius:10px;font:inherit;font-weight:400;background:#fff;color:#111}" +
  "input[type=checkbox]{display:inline-block;width:auto;min-height:0;margin:0 6px 0 0;vertical-align:middle;accent-color:var(--sub)}" +
  ".dims{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.tre{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.calc{font-weight:800;color:var(--sub-s)}" +
  "dialog{border:0;border-radius:16px;padding:0;width:min(640px,96vw);max-height:94vh;box-shadow:0 20px 60px rgba(0,0,0,.35)}dialog::backdrop{background:rgba(10,18,28,.55)}" +
  ".dl-t{padding:14px 16px 4px;border-bottom:1px solid #eee}.dl-t h2{margin:0;font-size:1.05rem;color:var(--sub-s)}.dl-t p{margin:4px 0 8px;font-size:.86rem;color:#5b6560}" +
  ".dl-c{padding:12px 16px;overflow:auto;max-height:64vh}.dl-b{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px 14px}" +
  ".dl-b button{min-height:46px;padding:0 18px;border-radius:10px;border:1px solid #c9d1cd;background:#fff;font:inherit;font-weight:700;cursor:pointer}.dl-b .si{background:var(--sub);border-color:var(--sub);color:#fff}" +
  ".msg{margin:0 16px;color:#b91c1c;font-weight:700;font-size:.9rem;min-height:1em}" +
  ".toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#1b1f1d;color:#fff;padding:10px 16px;border-radius:12px;font-weight:700;z-index:50}" +
  ".nota{font-size:.82rem;color:#5b6560;margin:12px 0}" +
  "@media (max-width:560px){.dims{grid-template-columns:repeat(2,1fr)}.tre{grid-template-columns:1fr}table.el .nas{display:none}}";

const PORTA_APP = String.raw`(function(){"use strict";
var C=window.SP_C,D=window.SP_D,K=D.contratto||{},FOTO=[],INVIO=0;
var $=function(s,r){return (r||document).querySelector(s);};
function vuoto(n){return n===null||n===undefined||n===''||!isFinite(Number(n));}
function grp(s){return s.replace(/\B(?=(\d{3})+(?!\d))/g,'.');}
function eur(n){if(vuoto(n))return '';var x=Number(n),p=Math.abs(x).toFixed(2).split('.');return (x<0&&Math.abs(x)>=0.005?'-':'')+grp(p[0])+','+p[1];}
function qt(n){if(vuoto(n))return '';var x=Math.round(Number(n)*1000)/1000,p=Math.abs(x).toFixed(3).replace(/\.?0+$/,'').split('.');return (x<0?'-':'')+grp(p[0])+(p[1]?','+p[1]:'');}
function es(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function di(s){if(!s)return '';var p=String(s).slice(0,10).split('-');return p[2]+'/'+p[1]+'/'+p[0];}
function nu(s){if(s===null||s===undefined)return null;var t=String(s).trim().replace(/\s/g,'');if(t==='')return null;if(t.indexOf(',')>=0)t=t.replace(/\./g,'').replace(',','.');var n=Number(t);return isFinite(n)?n:NaN;}
function ls(k,v){try{if(v===undefined)return localStorage.getItem(k)||'';localStorage.setItem(k,v);}catch(e){return '';}}
function avviso(t){var a=$('#sp-toast');a.textContent=t;a.hidden=false;clearTimeout(avviso.h);avviso.h=setTimeout(function(){a.hidden=true;},3500);}
function api(azione,extra){var b={azione:azione};extra=extra||{};for(var k in extra)b[k]=extra[k];
  return fetch(C.u+'/api',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})
    .then(function(r){return r.json();}).catch(function(){return {esito:'incerto'};});}
function errore(r){if(!r)return 'Il servizio non risponde: riprova.';if(r.esito==='incerto')return 'Non sappiamo se è andata a buon fine: ricarica la pagina e controlla.';
  if(r.esito==='link'||r.esito==='scaduto')return 'Il link non vale più: chiedi all’impresa quello nuovo.';return r.messaggio||'Non è stato possibile salvare.';}
function ricarica(){return api('contesto').then(function(r){if(r&&r.esito==='ok'){D=r;K=D.contratto||{};disegna();}else if(r&&r.esito!=='incerto'){location.reload();}});}
function voce(id){var a=K.voci||[];for(var i=0;i<a.length;i++)if(a[i].id===id)return a[i];return null;}
function regola(){var r=K.regola;return r==='mensile'?'contabilità mensile':r==='soglia'?'contabilità ogni '+eur(K.soglia_importo)+' € di lavori':r==='traguardi'?'contabilità a traguardi':'contabilità unica a fine lavori';}
function fotoHtml(f,togli){return (f||[]).map(function(x,i){return '<span class="th"><a href="'+es(C.u+'/foto?p='+encodeURIComponent(x.path))+'" target="_blank" rel="noopener"><img src="'+es(C.u+'/foto?p='+encodeURIComponent(x.path))+'" alt="foto" loading="lazy"></a>'+
  (togli?'<button type="button" class="x" data-fx="'+i+'" aria-label="Togli la foto">×</button>':'')+'</span>';}).join('');}
function rigaM(m,az){var v=voce(m.voce_id)||{},dims=[m.pu,m.l,m.w,m.h].filter(function(x){return !vuoto(x);}).map(qt).join(' × ');
  var dove=[m.lotto,m.piano,m.zona].filter(Boolean).join(' · ');
  return '<li><div><b>n. '+es(m.nr)+'</b> '+es(String(v.descrizione||'').slice(0,90))+'</div><div class="sub">'+di(m.data)+(dove?' · '+es(dove):'')+(dims?' · '+es(dims):'')+'</div>'+
    '<div><span class="q">'+qt(m.quantita)+' '+es(m.unita||'')+'</span>'+(m.descrizione?' <span class="sub">· '+es(m.descrizione)+'</span>':'')+'</div>'+
    (m.osservazione&&m.stato==='osservazione'?'<div class="oss">Osservazione dell’impresa: '+es(m.osservazione)+'</div>':'')+
    ((m.foto||[]).length?'<div class="ft">'+fotoHtml(m.foto,false)+'</div>':'')+
    (az&&!D.sola_lettura?'<div class="riga-b"><button type="button" class="b" data-mod="'+m.id+'">'+(m.stato==='osservazione'?'Correggi':'Modifica')+'</button><button type="button" class="b ro" data-tg="'+m.id+'">Togli</button></div>':'')+'</li>';}
function disegna(){
  var M=K.misure||[],h='';
  h+='<div class="pann"><div class="info">Impresa appaltatrice: <b>'+es(D.impresa_appaltatrice||'')+'</b><br>Cantiere: <b>'+es((D.cantiere||{}).nome||'')+'</b>'+((D.cantiere||{}).ubicazione?' · '+es(D.cantiere.ubicazione):'')+
    (K.oggetto?'<br>Lavori: <b>'+es(K.oggetto)+'</b>':'')+'<br>'+es(regola())+(Number(K.ritenuta_pct)?' · ritenuta a garanzia '+String(K.ritenuta_pct).replace('.',',')+'%':'')+
    '<br><small>Link valido fino al '+di(D.scade_il)+'.</small></div></div>';
  if(D.sola_lettura)h+='<div class="avv">Il subappalto è chiuso: puoi guardare e scaricare le tue contabilità, ma non scrivere misure nuove.</div>';
  else h+='<div class="pann"><button type="button" class="b pr gr" id="sp-nuova">+ Nuova misura</button><p class="nota" style="margin-bottom:0">Scegli la voce, scrivi dove e le misure, aggiungi una foto. L’impresa la controlla e la accetta, oppure ti scrive un’osservazione.</p></div>';
  var oss=M.filter(function(m){return m.stato==='osservazione';}),att=M.filter(function(m){return m.stato==='inviata';}),acc=M.filter(function(m){return m.stato==='accettata'&&!m.sal_numero;}),ins=M.filter(function(m){return m.sal_numero;});
  if(oss.length)h+='<div class="pann"><h2>Da correggere ('+oss.length+')</h2><ul class="ms">'+oss.map(function(m){return rigaM(m,true);}).join('')+'</ul></div>';
  h+='<div class="pann"><h2>In attesa dell’impresa ('+att.length+')</h2>'+(att.length?'<ul class="ms">'+att.map(function(m){return rigaM(m,true);}).join('')+'</ul>':'<p class="nota" style="margin:0">Nessuna misura in attesa.</p>')+'</div>';
  h+='<div class="pann"><h2>Accettate ('+acc.length+')</h2>'+(acc.length?'<ul class="ms">'+acc.map(function(m){return rigaM(m,false);}).join('')+'</ul>':'<p class="nota" style="margin:0">Le misure accettate entrano nella prossima contabilità.</p>')+'</div>';
  var S=K.sal||[];
  h+='<div class="pann"><h2>Le tue contabilità</h2>'+(S.length?'<ul class="ms">'+S.map(function(s){return '<li><b>n. '+s.numero+'</b> · dal '+di(s.periodo_da)+' al '+di(s.periodo_a)+'<div><span class="q">'+eur(s.dovuto)+' € + IVA</span> <span class="sub">· approvata il '+es(s.emesso_il||'')+'</span> '+
      (s.pagato_il?'<span class="st ok">pagata il '+di(s.pagato_il)+'</span>':'<span class="st am">da pagare</span>')+'</div><div class="riga-b"><a class="b" href="'+es(C.u+'/doc?id='+s.id+'&f=pdf')+'">PDF</a><a class="b" href="'+es(C.u+'/doc?id='+s.id+'&f=xlsx')+'">Excel</a></div></li>';}).join('')+'</ul>':'<p class="nota" style="margin:0">Ancora nessuna.</p>')+
    (ins.length?'<details><summary>Misure già nelle contabilità ('+ins.length+')</summary><ul class="ms">'+ins.map(function(m){return rigaM(m,false);}).join('')+'</ul></details>':'')+'</div>';
  h+='<div class="pann"><h2>Il tuo elenco prezzi</h2><table class="el"><thead><tr><th class="t">N.</th><th class="t">Voce</th><th>U.M.</th><th>Prezzo €</th><th class="nas">Q. contratto</th><th>Misurato</th></tr></thead><tbody>'+
    (K.voci||[]).filter(function(v){return !v.tolta;}).map(function(v){return '<tr><td class="t">'+es(v.nr)+'</td><td class="t">'+es(v.descrizione)+(v.tariffa?' <small>('+es(v.tariffa)+')</small>':'')+'</td><td>'+es(v.unita||'')+'</td><td>'+eur(v.prezzo)+'</td><td class="nas">'+qt(v.quantita)+'</td><td>'+qt(v.misurato)+'</td></tr>';}).join('')+'</tbody></table>'+
    '<p class="nota">I prezzi li ha scritti l’impresa nel contratto: tu scegli la voce e scrivi la quantità. Importi in euro, IVA esclusa.</p></div>';
  h+='<p class="nota">TIX™ registra le tue misure, le foto e ogni accesso per l’impresa che ti ha incaricato. TIX non manda niente a nessuno.</p>';
  $('#sp-corpo').innerHTML=h;}
function dlg(t,s,c,etich,fn){$('#sp-dlg-t').textContent=t;$('#sp-dlg-s').textContent=s||'';$('#sp-dlg-c').innerHTML=c;$('#sp-dlg-m').textContent='';var b=$('#sp-dlg-si');b.textContent=etich||'Salva';b.disabled=false;b.hidden=!fn;dlg.fn=fn;var d=$('#sp-dlg');if(d.showModal)d.showModal();else d.setAttribute('open','');}
function chiudi(){var d=$('#sp-dlg');if(d.close)d.close();else d.removeAttribute('open');}
function calcola(){var x=['m-pu','m-l','m-w','m-h'].map(function(i){return nu(($('#'+i)||{}).value);}),uno=x.some(function(v){return v!==null&&!isNaN(v);}),t=1;
  x.forEach(function(v){if(v!==null&&!isNaN(v))t*=v;});var q=$('#m-q');if(q)q.disabled=uno;var v=voce(($('#m-v')||{}).value)||{};
  $('#m-calc').textContent=uno?'Quantità: '+qt(Math.round(t*1000)/1000)+' '+(v.unita||''):'';}
function fotoLista(){var el=$('#m-ft');if(el)el.innerHTML=fotoHtml(FOTO,true)+(INVIO?'<span class="sub">invio di '+INVIO+' foto…</span>':'');}
function rimpicciolisci(f){return new Promise(function(ok){if(!/^image\//.test(f.type||'')){ok(null);return;}var u=URL.createObjectURL(f),im=new Image();
  im.onload=function(){var m=1600,w=im.naturalWidth,hh=im.naturalHeight,s=Math.min(1,m/Math.max(w,hh)),c=document.createElement('canvas');c.width=Math.round(w*s);c.height=Math.round(hh*s);
    c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);c.toBlob(function(b){ok(b);},'image/jpeg',0.82);};
  im.onerror=function(){URL.revokeObjectURL(u);ok(/^image\/(jpeg|png)$/.test(f.type)?f:null);};im.src=u;});}
function caricaFoto(files){[].slice.call(files||[]).forEach(function(f){if(FOTO.length+INVIO>=6){avviso('Al massimo 6 foto per misura.');return;}INVIO++;fotoLista();
  rimpicciolisci(f).then(function(b){if(!b){INVIO--;fotoLista();avviso('Carica una foto (JPEG o PNG).');return null;}
    return fetch(C.u+'/foto?nome='+encodeURIComponent((f.name||'foto').replace(/\.[a-z0-9]+$/i,'')+'.jpg'),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'image/jpeg'},body:b})
      .then(function(r){return r.json();}).catch(function(){return {esito:'incerto'};}).then(function(r){INVIO--;if(r&&r.esito==='ok')FOTO.push({path:r.path,nome:r.nome,byte:r.byte});else avviso(errore(r));fotoLista();});});});}
function modulo(m){m=m||{};FOTO=(m.foto||[]).slice();INVIO=0;var voci=(K.voci||[]).filter(function(v){return !v.tolta||v.id===m.voce_id;});
  var n=function(x){return vuoto(x)?'':String(x).replace('.',',');},oggi=D.oggi||'';
  var c='<label>Voce dell’elenco prezzi<select id="m-v">'+voci.map(function(v){return '<option value="'+v.id+'"'+(v.id===m.voce_id?' selected':'')+'>n. '+es(v.nr)+' — '+es(String(v.descrizione).slice(0,70))+' ('+es(v.unita||'')+', '+eur(v.prezzo)+' €)</option>';}).join('')+'</select></label>'+
    '<label>Giorno<input type="date" id="m-d" max="'+es(oggi)+'" value="'+es(m.data||oggi)+'"></label>'+
    '<div class="tre"><label>Fabbricato / lotto<input type="text" id="m-lotto" maxlength="60" value="'+es(m.lotto||ls('sp_lotto'))+'"></label><label>Piano<input type="text" id="m-piano" maxlength="60" value="'+es(m.piano||'')+'"></label><label>Zona<input type="text" id="m-zona" maxlength="120" placeholder="es. scala B, alloggio 3" value="'+es(m.zona||'')+'"></label></div>'+
    '<p class="nota" style="margin:4px 0 6px">Misure (si moltiplicano) oppure la quantità.</p><div class="dims">'+
    '<label>Parti uguali<input type="text" inputmode="decimal" id="m-pu" value="'+n(m.pu)+'"></label><label>Lunghezza<input type="text" inputmode="decimal" id="m-l" value="'+n(m.l)+'"></label>'+
    '<label>Larghezza<input type="text" inputmode="decimal" id="m-w" value="'+n(m.w)+'"></label><label>Altezza / peso<input type="text" inputmode="decimal" id="m-h" value="'+n(m.h)+'"></label></div>'+
    '<p class="calc" id="m-calc"></p><label>Quantità<input type="text" inputmode="decimal" id="m-q" value="'+(vuoto(m.pu)&&vuoto(m.l)&&vuoto(m.w)&&vuoto(m.h)?n(m.quantita!=null?Math.abs(m.quantita):null):'')+'"></label>'+
    '<label><input type="checkbox" id="m-meno"'+(Number(m.quantita)<0?' checked':'')+'> Misura in meno (correzione)</label>'+
    '<label>Descrizione <small>(facoltativa; obbligatoria per una misura in meno)</small><input type="text" id="m-ds" maxlength="600" value="'+es(m.descrizione||'')+'"></label>'+
    '<label>Foto <small>(fino a 6)</small><input type="file" id="m-file" accept="image/*" multiple></label><div class="ft" id="m-ft"></div>'+
    '<label>Chi scrive <small>(nome e cognome)</small><input type="text" id="m-chi" maxlength="120" autocomplete="name" value="'+es(ls('sp_chi'))+'"></label>';
  dlg(m.id?(m.stato==='osservazione'?'Correggi la misura':'Modifica la misura'):'Nuova misura',m.osservazione&&m.stato==='osservazione'?'Osservazione: '+m.osservazione:'',c,'Salva',function(){
    if(INVIO){$('#sp-dlg-m').textContent='Aspetta la fine dell’invio delle foto.';return;}
    var d={id:m.id||'',voce_id:$('#m-v').value,data:$('#m-d').value,lotto:$('#m-lotto').value,piano:$('#m-piano').value,zona:$('#m-zona').value,
      pu:$('#m-pu').value,l:$('#m-l').value,w:$('#m-w').value,h:$('#m-h').value,quantita:$('#m-q').disabled?'':$('#m-q').value,meno:$('#m-meno').checked,
      descrizione:$('#m-ds').value,foto:FOTO,autore:$('#m-chi').value};
    ls('sp_chi',d.autore);ls('sp_lotto',d.lotto);var b=$('#sp-dlg-si');b.disabled=true;
    api('misura',{dati:d}).then(function(r){b.disabled=false;if(r&&r.esito==='ok'){chiudi();avviso('Misura salvata: '+qt(r.quantita));ricarica();}else $('#sp-dlg-m').textContent=errore(r);});});
  ['m-pu','m-l','m-w','m-h','m-v'].forEach(function(i){var x=$('#'+i);if(x)x.addEventListener('input',calcola);});calcola();fotoLista();}
document.addEventListener('change',function(ev){if(ev.target.id==='m-file'){caricaFoto(ev.target.files);ev.target.value='';}});
document.addEventListener('click',function(ev){var t=ev.target.closest?ev.target.closest('button,a'):null;if(!t)return;
  if(t.id==='sp-dlg-no'){chiudi();return;}
  if(t.id==='sp-dlg-si'){if(dlg.fn)dlg.fn();return;}
  if(t.id==='sp-nuova'){modulo(null);return;}
  if(t.hasAttribute('data-fx')){FOTO.splice(Number(t.getAttribute('data-fx')),1);fotoLista();return;}
  if(t.hasAttribute('data-mod')){var id=t.getAttribute('data-mod'),m=(K.misure||[]).filter(function(x){return x.id===id;})[0];if(m)modulo(m);return;}
  if(t.hasAttribute('data-tg')){var id2=t.getAttribute('data-tg');dlg('Togliere la misura?','Non arriva più all’impresa.','','Togli',function(){
      api('togli',{id:id2}).then(function(r){if(r&&r.esito==='ok'){chiudi();avviso('Misura tolta.');ricarica();}else $('#sp-dlg-m').textContent=errore(r);});});return;}
});
disegna();
})();`;

// ---------------------------------------------------------------------------- scheda «Subappalti» della pagina SAL (impresa)
export const SUB_STILE =
  ":root{--sub:#B5523B;--sub-s:#8A3A27;--sub-c:#FBF0EC;--sub-b:#EBC9BE}" +
  ".sal-tab button[data-s=subappalti][aria-selected=true]{background:var(--sub);box-shadow:0 2px 8px rgba(181,82,59,.35)}" +
  ".sb-k{border-left:5px solid var(--sub)}.sb-r1{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}.sb-nome{font-size:1.08rem;color:#3a1a10}" +
  ".st.sb{background:var(--sub-c);color:var(--sub-s)}.sb-ogg{margin:4px 0;color:#4b5550;font-size:.92rem}" +
  ".sb-chip{display:inline-block;font-size:.78rem;font-weight:800;border-radius:99px;padding:3px 10px;margin:4px 6px 0 0}.sb-chip.am{background:#FFF4DC;color:#7A4A00}.sb-chip.ro{background:#FEF2F2;color:#7f1d1d}.sb-chip.ok{background:#E6F6EC;color:#0B5E37}" +
  ".b.sb-pr{background:var(--sub);border-color:var(--sub);color:#fff}.b.sb{border-color:var(--sub);color:var(--sub-s)}" +
  ".sb-link{font-size:.9rem;margin:8px 0 0}.sb-ms{list-style:none;margin:0;padding:0}.sb-ms li{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:flex-start;padding:8px 0;border-top:1px solid #eee;font-size:.9rem}" +
  ".sb-ms li .sp{flex:1 1 280px}.sb-ms .q{font-weight:800;font-variant-numeric:tabular-nums}.sb-oss{color:#7f1d1d;font-weight:700}" +
  ".sb-ft{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}.sb-ft img{width:52px;height:52px;object-fit:cover;border-radius:6px;display:block}" +
  ".sb-vr{display:grid;grid-template-columns:.9fr 3fr .8fr 1fr 1fr .9fr auto;gap:6px;align-items:end;margin:0 0 6px}" +
  "@media (max-width:760px){.sb-vr{grid-template-columns:1fr 1fr}.sb-vr .x{grid-column:span 2}}";

export const SUB_APP = String.raw`(function(){"use strict";
var C=window.SAL_C,SD=null,EL=null,aperto={},carico=false;
var $=function(s,r){return (r||document).querySelector(s);};
function vuoto(n){return n===null||n===undefined||n===''||!isFinite(Number(n));}
function grp(s){return s.replace(/\B(?=(\d{3})+(?!\d))/g,'.');}
function eur(n){if(vuoto(n))return '';var x=Number(n),p=Math.abs(x).toFixed(2).split('.');return (x<0&&Math.abs(x)>=0.005?'-':'')+grp(p[0])+','+p[1];}
function qt(n){if(vuoto(n))return '';var x=Math.round(Number(n)*1000)/1000,p=Math.abs(x).toFixed(3).replace(/\.?0+$/,'').split('.');return (x<0?'-':'')+grp(p[0])+(p[1]?','+p[1]:'');}
function pc(n){if(vuoto(n))return '';return Number(n).toFixed(2).replace('.',',')+'%';}
function es(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function di(s){if(!s)return '';var p=String(s).slice(0,10).split('-');return p[2]+'/'+p[1]+'/'+p[0];}
function ls(k,v){try{if(v===undefined)return localStorage.getItem(k)||'';localStorage.setItem(k,v);}catch(e){return '';}}
function avv(t){var a=document.getElementById('sal-avviso');if(!a)return;a.textContent=t;a.hidden=false;clearTimeout(avv.h);avv.h=setTimeout(function(){a.hidden=true;},3500);}
function api(azione,extra){var b={t:C.t,c:C.c,azione:azione};extra=extra||{};for(var k in extra)b[k]=extra[k];
  return fetch(C.u+'/sub/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})
    .then(function(r){return r.json();}).catch(function(){return {esito:'incerto'};});}
function errore(r){if(!r)return 'Il servizio non risponde: riprova.';if(r.esito==='chiuso')return 'Il cantiere è chiuso.';if(r.esito==='incerto')return 'Non sappiamo se è andata a buon fine: ricarica la pagina e controlla.';return r.messaggio||'Non è stato possibile salvare.';}
function attiva(){if(C.solo)return true;var b=document.querySelector('.sal-tab button[data-s=subappalti]');return b&&b.getAttribute('aria-selected')==='true';}
function carica(){return api('contesto').then(function(r){SD=r||{esito:'incerto'};var t=document.getElementById('tab-sub');if(t)t.hidden=!(SD.esito==='ok');if(EL&&attiva())EL.innerHTML=pagina();});}
window.SUB_MOSTRA=function(el){EL=el;el.innerHTML=pagina();if(!carico){carico=true;carica();}};
// all'apertura della pagina SAL: se la contabilità dei sub è attiva per questo accesso, compare la scheda
// pagina «Subappaltatori» a sé (10/11/2026): l'elenco si apre subito
document.addEventListener('DOMContentLoaded',function(){var el=C.solo?document.getElementById('sal-corpo'):null;if(el){window.SUB_MOSTRA(el);return;}if(!carico){carico=true;carica();}});
function regola(k){var r=k.regola;return r==='mensile'?'contabilità mensile':r==='soglia'?'ogni '+eur(k.soglia_importo)+' € di lavori':r==='traguardi'?'a traguardi':'unica a fine lavori';}
function kk(id){var a=(SD&&SD.contratti)||[];for(var i=0;i<a.length;i++)if(a[i].id===id)return a[i];return null;}
function voceDi(k,id){var a=k.voci||[];for(var i=0;i<a.length;i++)if(a[i].id===id)return a[i];return null;}
function fotoU(p){return C.u+'/sub/foto?t='+C.t+'&c='+C.c+'&p='+encodeURIComponent(p);}
function docU(k,id,f){return C.u+'/sub/doc?t='+C.t+'&c='+C.c+'&k='+k+(id?'&id='+id:'')+'&f='+f;}
function pagina(){
  if(!SD)return '<div class="pann"><p class="nota" style="margin:0">Caricamento dei subappalti…</p></div>';
  if(SD.esito!=='ok')return '<div class="pann"><h2>Subappaltatori</h2><p>'+(SD.esito==='spento'?'La contabilità dei subappaltatori non è attiva per questo accesso.':errore(SD))+'</p></div>';
  var h='<div class="pann"><h2 style="color:var(--sub-s)">'+(C.solo?'Subappaltatori di questo cantiere':'Subappaltatori')+'</h2><p style="margin:0">Ogni subappaltatore scrive le sue misure dal telefono con un link personale, senza password. Tu le accetti riga per riga e approvi la sua contabilità. '+
    'Il sub vede solo le sue voci e i suoi prezzi: mai i prezzi verso il committente, il margine o gli altri subappaltatori. TIX non manda niente a nessuno: il link lo mandi tu.</p>'+
    (SD.chiuso?'':'<div class="riga-b"><button type="button" class="b sb-pr" data-sb="nuovo">+ Nuovo subappalto</button></div>')+'</div>';
  var K=SD.contratti||[];
  if(!K.length)h+='<div class="pann"><p class="nota" style="margin:0">Ancora nessun subappalto in questo cantiere.</p></div>';
  K.forEach(function(k){h+=carta(k);});
  return h;}
function carta(k){var a=k.attesa||{},co=k.conto||{},lk=k.link,ch=k.stato!=='attivo',ap=aperto[k.id],ro=SD.chiuso;
  var h='<div class="pann sb-k"><div class="sb-r1"><b class="sb-nome">'+es(k.impresa_nome)+'</b><span class="st '+(ch?'no':'sb')+'">'+(ch?'Chiuso':'Attivo')+'</span>'+
    '<span class="sub">'+es(regola(k))+(Number(k.ritenuta_pct)?' · ritenuta '+pc(k.ritenuta_pct):'')+(k.fine_prevista?' · fine prevista '+di(k.fine_prevista):'')+'</span></div>'+
    (k.oggetto?'<p class="sb-ogg">'+es(k.oggetto)+'</p>':'')+
    (Number(a.inviate)?'<span class="sb-chip am">'+a.inviate+(Number(a.inviate)===1?' riga da decidere':' righe da decidere')+'</span>':'')+
    (Number(a.osservazione)?'<span class="sb-chip ro">'+a.osservazione+' in correzione dal sub</span>':'')+
    (Number(a.accettate)?'<span class="sb-chip ok">'+a.accettate+(Number(a.accettate)===1?' accettata, pronta':' accettate, pronte')+' per la contabilità</span>':'')+
    '<div class="s-cifre" style="margin-top:10px"><div class="s-cifra"><small>Contratto del sub</small><b>'+eur(co.importo_contratto)+' €</b><span>'+(function(n){return n===1?'1 voce':n+' voci';})((k.voci||[]).filter(function(v){return !v.tolta;}).length)+'</span></div>'+
    '<div class="s-cifra"><small>Accettato a oggi</small><b>'+eur(co.lavori)+' €</b><span>già in contabilità '+eur(co.lavori_prec)+' €</span></div>'+
    '<div class="s-cifra"><small>Prossima contabilità</small><b>'+eur(co.dovuto)+' €</b><span>+ IVA, con le righe accettate</span></div></div>';
  if(!ch&&!ro){
    if(!lk)h+='<p class="sb-link">Il sub non ha ancora il link.</p><div class="riga-b"><button type="button" class="b sb-pr" data-sb="link" data-id="'+k.id+'">Crea il link per il sub</button></div>';
    else h+='<p class="sb-link">Link attivo fino al <b>'+di(lk.scade_il)+'</b>'+(lk.scaduto?' <b class="ko-v">scaduto</b>':lk.in_scadenza?' <b class="ko-v">in scadenza</b>':'')+
      (lk.ultimo_uso?' · ultimo accesso del sub '+es(lk.ultimo_uso):' · il sub non l’ha ancora aperto')+'</p>'+
      '<div class="riga-b"><button type="button" class="b sb" data-sb="allunga" data-id="'+k.id+'">Allunga di 30 giorni</button><button type="button" class="b sb" data-sb="link" data-id="'+k.id+'">Link nuovo</button><button type="button" class="b ro" data-sb="spegni" data-id="'+k.id+'">Spegni il link</button></div>';}
  h+='<div class="riga-b"><button type="button" class="b" data-sb="apri" data-id="'+k.id+'">'+(ap?'Nascondi i dettagli':'Misure, contabilità ed elenco prezzi')+'</button></div>';
  if(ap)h+=dettagli(k);
  return h+'</div>';}
function rigaM(k,m,modo){var v=voceDi(k,m.voce_id)||{},dims=[m.pu,m.l,m.w,m.h].filter(function(x){return !vuoto(x);}).map(qt).join(' × '),dove=[m.lotto,m.piano,m.zona].filter(Boolean).join(' · '),ro=SD.chiuso;
  return '<li><span class="sp"><b>n. '+es(m.nr)+'</b> '+es(String(v.descrizione||'').slice(0,80))+'<br><small>'+di(m.data)+(dove?' · '+es(dove):'')+(dims?' · '+es(dims):'')+(m.creato_da?' · scritta da '+es(m.creato_da):'')+(m.modificata?' · corretta':'')+'</small>'+
    (m.descrizione?'<br><small>'+es(m.descrizione)+'</small>':'')+(m.osservazione&&m.stato==='osservazione'?'<br><span class="sb-oss">Osservazione: '+es(m.osservazione)+'</span>':'')+
    ((m.foto||[]).length?'<span class="sb-ft">'+m.foto.map(function(f){return '<a href="'+es(fotoU(f.path))+'" target="_blank" rel="noopener"><img src="'+es(fotoU(f.path))+'" alt="foto" loading="lazy"></a>';}).join('')+'</span>':'')+'</span>'+
    '<span class="q">'+qt(m.quantita)+' '+es(m.unita||'')+'</span><span class="q">'+eur(Number(m.quantita)*Number(v.prezzo||0))+' €</span>'+
    (ro?'':modo==='dec'?'<button type="button" class="b ok" data-sb="accetta" data-id="'+m.id+'">Accetta</button><button type="button" class="b ro" data-sb="oss" data-id="'+m.id+'">Osservazione</button>'
      :modo==='acc'?'<button type="button" class="b" data-sb="riapri" data-id="'+m.id+'">Riapri</button>':'')+'</li>';}
function dettagli(k){var M=k.misure||[],ch=k.stato!=='attivo',ro=SD.chiuso,co=k.conto||{};
  var da=M.filter(function(m){return m.stato==='inviata';}),oss=M.filter(function(m){return m.stato==='osservazione';}),acc=M.filter(function(m){return m.stato==='accettata'&&!m.sal_numero;}),ins=M.filter(function(m){return m.sal_numero;});
  var h='<h3>Da decidere ('+da.length+')</h3>'+(da.length?'<ul class="sb-ms">'+da.map(function(m){return rigaM(k,m,'dec');}).join('')+'</ul>'+(ro?'':'<div class="riga-b"><button type="button" class="b ok" data-sb="tutte" data-id="'+k.id+'">Accetta tutte le righe da decidere</button></div>'):'<p class="nota" style="margin:0">Nessuna riga da decidere.</p>');
  if(oss.length)h+='<h3>In correzione dal sub ('+oss.length+')</h3><ul class="sb-ms">'+oss.map(function(m){return rigaM(k,m,'oss');}).join('')+'</ul>';
  h+='<h3>Accettate, non ancora in contabilità ('+acc.length+')</h3>'+(acc.length?'<ul class="sb-ms">'+acc.map(function(m){return rigaM(k,m,'acc');}).join('')+'</ul>':'<p class="nota" style="margin:0">Nessuna.</p>');
  h+='<h3>Contabilità del sub</h3><table class="conto"><tr><td>Lavori accettati a oggi</td><td class="n">'+eur(co.lavori)+' €</td></tr>'+(Number(co.ritenuta)?'<tr><td>− Ritenuta a garanzia '+pc(co.ritenuta_pct)+'</td><td class="n">'+eur(co.ritenuta)+' €</td></tr>':'')+
    '<tr><td>− Contabilità già approvate</td><td class="n">'+eur(co.precedenti)+' €</td></tr><tr class="fin" style="background:var(--sub-c)"><td>Prossima contabilità</td><td class="n">'+eur(co.dovuto)+' € + IVA</td></tr></table>'+
    '<div class="riga-b">'+(ro||ch?'':'<button type="button" class="b sb-pr" data-sb="emetti" data-id="'+k.id+'">Approva la contabilità n. '+((k.sal||[]).length?Math.max.apply(null,k.sal.map(function(s){return s.numero;}))+1:1)+'</button>')+
    '<a class="b" href="'+es(docU(k.id,'','pdf'))+'">Anteprima PDF</a><a class="b ex" href="'+es(docU(k.id,'','xlsx'))+'">Excel a oggi</a></div>';
  var S=k.sal||[];
  if(S.length)h+='<div class="sal-el" style="margin-top:10px">'+S.map(function(s,i){return '<div class="sal-c"><div class="r1"><b>Contabilità n. '+s.numero+'</b><span>dal '+di(s.periodo_da)+' al '+di(s.periodo_a)+'</span>'+
      (s.pagato_il?'<span class="st ok">pagata il '+di(s.pagato_il)+'</span>':'<span class="st fi">da pagare</span>')+'<span class="imp" style="margin-left:auto">'+eur(s.dovuto)+' € + IVA</span></div>'+
      '<p class="nota" style="margin:6px 0">Approvata il '+es(s.emesso_il||'')+' da '+es(s.emesso_da||'')+(s.pagato_nota?' · '+es(s.pagato_nota):'')+'</p><div class="riga-b">'+
      '<a class="b" href="'+es(docU(k.id,s.id,'pdf'))+'">PDF da firmare</a><a class="b ex" href="'+es(docU(k.id,s.id,'xlsx'))+'">Excel</a>'+
      (ro?'':s.pagato_il?'<button type="button" class="b" data-sb="nonpagata" data-id="'+s.id+'">Togli «pagata»</button>':'<button type="button" class="b ok" data-sb="pagata" data-id="'+s.id+'">Segna pagata</button>')+
      (!ro&&i===0&&!s.pagato_il?'<button type="button" class="b ro" data-sb="annulla" data-id="'+s.id+'">Annulla</button>':'')+'</div></div>';}).join('')+'</div>';
  if(ins.length)h+='<details style="margin-top:10px"><summary>Righe già nelle contabilità ('+ins.length+')</summary><ul class="sb-ms">'+ins.map(function(m){return rigaM(k,m,'sal');}).join('')+'</ul></details>';
  h+='<h3>Elenco prezzi del sub</h3><table class="av"><thead><tr><th class="t">N.</th><th class="t">Voce</th><th class="t">U.M.</th><th>Prezzo</th><th>Q. contratto</th><th>Misurato</th><th>Accettato</th></tr></thead><tbody>'+
    (k.voci||[]).map(function(v){var oltre=!vuoto(v.quantita)&&Number(v.accettato)>Number(v.quantita);return '<tr class="kv'+(v.tolta?' alt':'')+(oltre?' oltre':'')+'"><td class="t" data-l="N.">'+es(v.nr)+'</td><td class="t"><span class="vd">'+es(v.descrizione)+'</span>'+(v.tariffa?'<span class="vs">'+es(v.tariffa)+'</span>':'')+
      (v.tolta?'<span class="vs">voce tolta dal contratto</span>':'')+(oltre?'<span class="tag-o">oltre la quantità del contratto</span>':'')+'</td><td class="t" data-l="U.M.">'+es(v.unita||'')+'</td><td data-l="Prezzo">'+eur(v.prezzo)+'</td><td data-l="Q. contratto">'+qt(v.quantita)+'</td>'+
      '<td data-l="Misurato">'+qt(v.misurato)+'</td><td data-l="Accettato">'+qt(v.accettato)+'</td></tr>';}).join('')+'</tbody></table>';
  if(!ro)h+='<div class="riga-b">'+(ch?'<button type="button" class="b" data-sb="riapri_k" data-id="'+k.id+'">Riapri il subappalto</button>':
    '<button type="button" class="b sb" data-sb="modifica" data-id="'+k.id+'">Modifica il contratto del sub</button><button type="button" class="b ro" data-sb="chiudi" data-id="'+k.id+'">Chiudi il subappalto</button>')+'</div>';
  return h;}
// ---- finestra propria (non tocca quella del SAL)
function dlgEl(){var d=document.getElementById('sb-dlg');if(d)return d;d=document.createElement('dialog');d.id='sb-dlg';
  d.innerHTML='<form method="dialog" novalidate><div class="dl-t"><h2 id="sb-dlg-t"></h2><p id="sb-dlg-s"></p></div><div class="dl-c" id="sb-dlg-c"></div><p class="msg" id="sb-dlg-m" aria-live="polite"></p>'+
    '<div class="dl-b"><button type="button" class="no" id="sb-dlg-no">Chiudi</button><button type="button" class="si" id="sb-dlg-si" style="background:var(--sub);border-color:var(--sub)">Salva</button></div></form>';document.body.appendChild(d);return d;}
function dlg(t,s,c,etich,fn,largo){var d=dlgEl();$('#sb-dlg-t').textContent=t;$('#sb-dlg-s').textContent=s||'';$('#sb-dlg-c').innerHTML=c;$('#sb-dlg-m').textContent='';
  var b=$('#sb-dlg-si');b.textContent=etich||'Salva';b.disabled=false;b.hidden=!fn;dlg.fn=fn;d.classList.toggle('largo',!!largo);if(d.showModal)d.showModal();else d.setAttribute('open','');}
function chiudi(){var d=document.getElementById('sb-dlg');if(!d)return;if(d.close)d.close();else d.removeAttribute('open');}
function msg(t){$('#sb-dlg-m').textContent=t;}
function dopo(p,ok){var b=$('#sb-dlg-si');if(b)b.disabled=true;return p.then(function(r){if(b)b.disabled=false;if(r&&r.esito==='ok'){chiudi();if(ok)avv(ok);carica();return r;}msg(errore(r));return null;});}
// ---- contratto del sub
function rigaV(v){v=v||{};var n=function(x){return vuoto(x)?'':String(x).replace('.',',');};
  return '<div class="sb-vr" data-id="'+es(v.id||'')+'"><label>Tariffa<input type="text" class="v-t" maxlength="40" value="'+es(v.tariffa||'')+'"></label>'+
    '<label>Descrizione<input type="text" class="v-d" maxlength="2000" value="'+es(v.descrizione||'')+'"></label><label>U.M.<input type="text" class="v-u" maxlength="20" value="'+es(v.unita||'')+'"></label>'+
    '<label>Quantità<input type="text" class="v-q" inputmode="decimal" value="'+n(v.quantita)+'"></label><label>Prezzo €<input type="text" class="v-p" inputmode="decimal" value="'+n(v.prezzo)+'"></label>'+
    '<label>Voce computo <small>(n.)</small><input type="text" class="v-c" inputmode="numeric" list="sb-comp" value="'+es(v.computo_voce_nr||'')+'"></label>'+
    (v.in_contabilita?'<span class="st no x">in contabilità</span>':'<button type="button" class="b ro x" data-sbx="1" aria-label="Togli la voce">×</button>')+'</div>';}
function contratto(k){var nuovo=!k;k=k||{regola:'mensile',ritenuta_pct:0,voci:[{}]};
  var imp=(SD.imprese||[]),of=(SD.offerte||[]),n=function(x){return vuoto(x)?'':String(x).replace('.',',');};
  var c='<datalist id="sb-imp">'+imp.map(function(x){return '<option value="'+es(x.impresa)+'">'+(x.sub?'subappaltatore':'')+'</option>';}).join('')+'</datalist>'+
    '<datalist id="sb-comp">'+(SD.computo||[]).map(function(v){return '<option value="'+es(v.nr)+'">'+es(v.d)+' ('+es(v.u||'')+')</option>';}).join('')+'</datalist>'+
    '<div class="campi"><label>Impresa subappaltatrice<input type="text" id="sk-nome" maxlength="160" list="sb-imp" value="'+es(k.impresa_nome||'')+'"></label>'+
    '<label>Referente <small>(il geometra o il titolare del sub)</small><input type="text" id="sk-ref" maxlength="120" value="'+es(k.referente_nome||'')+'"></label>'+
    '<label>Email del referente<input type="email" id="sk-em" maxlength="160" value="'+es(k.referente_email||'')+'"></label>'+
    '<label>Telefono del referente<input type="tel" id="sk-tel" maxlength="40" value="'+es(k.referente_telefono||'')+'"></label>'+
    '<label>Lavori affidati<input type="text" id="sk-ogg" maxlength="400" placeholder="es. intonaci e rasature" value="'+es(k.oggetto||'')+'"></label>'+
    '<label>Inizio<input type="date" id="sk-ini" value="'+es(k.inizio||'')+'"></label><label>Fine prevista<input type="date" id="sk-fine" value="'+es(k.fine_prevista||'')+'"></label>'+
    '<label>Ritenuta a garanzia <small>(%, di solito 0)</small><input type="text" id="sk-rit" inputmode="decimal" value="'+n(k.ritenuta_pct)+'"></label></div>'+
    '<h3>Quando si fa la contabilità del sub</h3><div class="scelte">'+[['mensile','Ogni mese'],['soglia','A soglia d’importo: ogni volta che i lavori accettati superano una cifra'],['traguardi','A traguardi'],['fine_lavori','Unica a fine lavori']]
      .map(function(o){return '<label><input type="radio" name="sk-reg" value="'+o[0]+'"'+(k.regola===o[0]?' checked':'')+'> '+o[1]+'</label>';}).join('')+'</div>'+
    '<label id="sk-l-soglia"'+(k.regola==='soglia'?'':' hidden')+'>Soglia <small>(€)</small><input type="text" id="sk-soglia" inputmode="decimal" value="'+n(k.soglia_importo)+'"></label>'+
    '<h3>Elenco prezzi del sub</h3>'+(nuovo&&of.length?'<label>Prendi i prezzi da un’offerta dei Preventivi<select id="sk-of"><option value="">no, li scrivo qui sotto</option>'+of.map(function(o){return '<option value="'+o.rdo_id+'">'+es(o.preventivo)+' · '+es(o.destinatario||'')+' · '+o.righe+' prezzi'+(o.offerta_data?' · offerta del '+di(o.offerta_data):'')+'</option>';}).join('')+'</select></label>':'')+
    '<p class="nota" style="margin-top:0">Il sub vede queste voci e questi prezzi, e non li può cambiare. «Voce computo» (facoltativa) collega la voce al tuo computo verso il committente: serve per i controlli.</p>'+
    '<div id="sk-voci">'+(k.voci||[]).filter(function(v){return !v.tolta;}).map(rigaV).join('')+'</div><button type="button" class="b" id="sk-vagg">+ Aggiungi una voce</button>'+
    '<label style="margin-top:10px">Chi lo scrive <small>(nome e cognome)</small><input type="text" id="sk-chi" maxlength="120" value="'+es(ls('sal_autore'))+'"></label>';
  dlg(nuovo?'Nuovo subappalto':'Contratto del sub: '+k.impresa_nome,'Prezzi senza IVA. Il sub non vede mai i prezzi verso il committente.',c,'Salva il contratto',function(){
    var d={id:k.id||'',impresa_nome:$('#sk-nome').value,referente_nome:$('#sk-ref').value,referente_email:$('#sk-em').value,referente_telefono:$('#sk-tel').value,
      oggetto:$('#sk-ogg').value,inizio:$('#sk-ini').value,fine_prevista:$('#sk-fine').value,ritenuta_pct:$('#sk-rit').value,
      regola:(document.querySelector('input[name=sk-reg]:checked')||{}).value||'mensile',soglia_importo:$('#sk-soglia').value,autore:$('#sk-chi').value};
    var r1=imp.filter(function(x){return x.impresa.toLowerCase()===String(d.impresa_nome).trim().toLowerCase();})[0];if(r1)d.rubrica_id=r1.id;
    var of1=$('#sk-of')?$('#sk-of').value:'';
    if(of1)d.rdo_id=of1;else{d.voci=[];[].forEach.call(document.querySelectorAll('#sk-voci .sb-vr'),function(r){var v={id:r.getAttribute('data-id'),tariffa:$('.v-t',r).value,descrizione:$('.v-d',r).value,unita:$('.v-u',r).value,
        quantita:$('.v-q',r).value,prezzo:$('.v-p',r).value,computo_voce_nr:$('.v-c',r).value};if(v.descrizione||v.prezzo)d.voci.push(v);});}
    ls('sal_autore',d.autore);
    dopo(api('contratto',{dati:d}),nuovo?'Subappalto creato.':'Contratto salvato.').then(function(r){if(r&&r.id)aperto[r.id]=true;});},true);
  var r0=document.querySelectorAll('input[name=sk-reg]');[].forEach.call(r0,function(x){x.addEventListener('change',function(){$('#sk-l-soglia').hidden=this.value!=='soglia';});});
  var so=$('#sk-of');if(so)so.addEventListener('change',function(){$('#sk-voci').hidden=!!this.value;$('#sk-vagg').hidden=!!this.value;});
  var ni=$('#sk-nome');if(ni)ni.addEventListener('change',function(){var x=imp.filter(function(i){return i.impresa.toLowerCase()===ni.value.trim().toLowerCase();})[0];
    if(x){if(!$('#sk-ref').value)$('#sk-ref').value=x.nome||'';if(!$('#sk-em').value)$('#sk-em').value=x.email||'';if(!$('#sk-tel').value)$('#sk-tel').value=x.telefono||'';}});}
function mostraLink(k,r,prima){var u=r.url,testo='Ciao, questo è il tuo link personale per scrivere le misure del cantiere «'+((window.SAL_D||{}).cantiere||{}).nome+'» in TIX: '+u;
  dlg('Link per '+k.impresa_nome,'Valido fino al '+di(r.scade_il)+'. Mandalo solo al referente del sub: chi ha il link entra.'+(prima?' Il link di prima non vale più.':''),
    '<label>Link<input type="text" id="sl-u" readonly value="'+es(u)+'"></label><div class="riga-b"><button type="button" class="b sb-pr" id="sl-copia">Copia il link</button>'+
    '<a class="b" href="https://wa.me/?text='+encodeURIComponent(testo)+'" target="_blank" rel="noopener">Condividi su WhatsApp</a>'+
    (k.referente_email?'<a class="b" href="mailto:'+encodeURIComponent(k.referente_email)+'?subject='+encodeURIComponent('Il tuo link per la contabilità del subappalto')+'&body='+encodeURIComponent(testo)+'">Prepara l’email</a>':'')+'</div>'+
    '<p class="nota">Il link si vede solo adesso: TIX non lo conserva. Se lo perdi, crea un link nuovo.</p>','',null);}
// ---- clic
document.addEventListener('click',function(ev){var t=ev.target.closest?ev.target.closest('button,a'):null;if(!t)return;
  if(t.id==='sb-dlg-no'){chiudi();return;}
  if(t.id==='sb-dlg-si'){if(dlg.fn)dlg.fn();return;}
  if(t.id==='sk-vagg'){$('#sk-voci').insertAdjacentHTML('beforeend',rigaV({}));return;}
  if(t.hasAttribute('data-sbx')){var r=t.closest('.sb-vr');if(r)r.parentNode.removeChild(r);return;}
  if(t.id==='sl-copia'){var i=$('#sl-u');i.select();try{navigator.clipboard.writeText(i.value).then(function(){avv('Link copiato.');},function(){document.execCommand('copy');avv('Link copiato.');});}catch(e){document.execCommand('copy');avv('Link copiato.');}return;}
  var a=t.getAttribute('data-sb');if(!a)return;var id=t.getAttribute('data-id'),k=kk(id),chi=ls('sal_autore');
  if(a==='nuovo'){contratto(null);return;}
  if(a==='apri'){aperto[id]=!aperto[id];if(EL)EL.innerHTML=pagina();return;}
  if(a==='modifica'){if(k)contratto(k);return;}
  if(a==='link'){dlg(k.link?'Mandare un link nuovo?':'Creare il link per il sub?',k.link?'Il link di prima smette subito di funzionare.':'Il link vale fino alla fine prevista del subappalto più 30 giorni.','',k.link?'Link nuovo':'Crea il link',function(){
      var b=$('#sb-dlg-si');b.disabled=true;api('link',{id:id,dati:{autore:chi}}).then(function(r){b.disabled=false;if(r&&r.esito==='ok'&&r.url){chiudi();mostraLink(k,r,!!k.link);carica();}else msg(errore(r));});});return;}
  if(a==='allunga'){t.disabled=true;api('allunga',{id:id,dati:{autore:chi}}).then(function(r){t.disabled=false;if(r&&r.esito==='ok'){avv('Link allungato fino al '+di(r.scade_il)+'.');carica();}else avv(errore(r));});return;}
  if(a==='spegni'){dlg('Spegnere il link?','Il sub non entra più finché non gli mandi un link nuovo.','','Spegni',function(){dopo(api('spegni',{id:id,dati:{autore:chi}}),'Link spento.');});return;}
  if(a==='accetta'||a==='riapri'){t.disabled=true;api('misura',{id:id,dati:{azione:a,autore:chi}}).then(function(r){t.disabled=false;if(r&&r.esito==='ok'){avv(a==='accetta'?'Riga accettata.':'Riga riaperta.');carica();}else avv(errore(r));});return;}
  if(a==='oss'){dlg('Osservazione per il sub','Il sub la vede nella sua pagina, corregge la riga e te la rimanda.','<label>Osservazione<textarea id="so-t" maxlength="600" placeholder="es. il Diario segna 30 m², ricontrolla"></textarea></label>','Manda al sub',function(){
      dopo(api('misura',{id:id,dati:{azione:'osservazione',testo:$('#so-t').value,autore:chi}}),'Osservazione scritta.');});return;}
  if(a==='tutte'){var n=(k.misure||[]).filter(function(m){return m.stato==='inviata';}).length;dlg('Accettare tutte le righe da decidere?',n+(n===1?' riga':' righe')+' di '+k.impresa_nome+'.','','Accetta tutte',function(){
      dopo(api('misura',{id:id,dati:{azione:'accetta_tutte',autore:chi}}),'Righe accettate.');});return;}
  if(a==='emetti'){var oggi=(window.SAL_D||{}).oggi||'';dlg('Approvare la contabilità del sub?','Entrano le righe accettate fino al giorno che scegli. Con l’approvazione riceve il numero e l’impronta SHA-256 e non cambia più.',
      '<label>Righe fino al<input type="date" id="se-a" max="'+es(oggi)+'" value="'+es(oggi)+'"></label><label>Approvata da <small>(nome e cognome)</small><input type="text" id="se-chi" maxlength="120" value="'+es(chi)+'"></label>','Approva',function(){
      var nm=$('#se-chi').value;ls('sal_autore',nm);dopo(api('emetti',{id:id,dati:{periodo_a:$('#se-a').value,autore:nm}}),'Contabilità approvata.');});return;}
  if(a==='pagata'){var o2=(window.SAL_D||{}).oggi||'';dlg('Segnare pagata?','Si segna solo in TIX: non parte nessun pagamento.','<label>Pagata il<input type="date" id="sp-d" max="'+es(o2)+'" value="'+es(o2)+'"></label><label>Nota <small>(facoltativa, es. bonifico)</small><input type="text" id="sp-n" maxlength="300"></label>','Segna pagata',function(){
      dopo(api('sal_stato',{id:id,dati:{azione:'pagato',data:$('#sp-d').value,nota:$('#sp-n').value,autore:chi}}),'Segnata pagata.');});return;}
  if(a==='nonpagata'){t.disabled=true;api('sal_stato',{id:id,dati:{azione:'non_pagato',autore:chi}}).then(function(r){t.disabled=false;if(r&&r.esito==='ok'){avv('Tolto «pagata».');carica();}else avv(errore(r));});return;}
  if(a==='annulla'){dlg('Annullare la contabilità?','Le sue righe tornano accettate e libere per la prossima. Il numero non si riusa.','<label>Motivo<textarea id="sa-m" maxlength="300"></textarea></label>','Annulla la contabilità',function(){
      dopo(api('sal_stato',{id:id,dati:{azione:'annulla',motivo:$('#sa-m').value,autore:chi}}),'Contabilità annullata.');});return;}
  if(a==='chiudi'){dlg('Chiudere il subappalto?','Il sub potrà solo guardare e scaricare le sue contabilità. Si può riaprire.','','Chiudi il subappalto',function(){dopo(api('chiudi',{id:id,dati:{autore:chi}}),'Subappalto chiuso.');});return;}
  if(a==='riapri_k'){t.disabled=true;api('riapri',{id:id,dati:{autore:chi}}).then(function(r){t.disabled=false;if(r&&r.esito==='ok'){avv('Subappalto riaperto.');carica();}else avv(errore(r));});return;}
});
})();`;
