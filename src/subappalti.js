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
    s("nome_cantiere", 160); s("prezzo_ora_economia", 20); // S2, 11/11/2026
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
    if (["contabilita", "finale", "svincolo"].indexOf(String(d.tipo || "")) !== -1) o.tipo = String(d.tipo); // S3a, 11/11/2026
    if (d.svincola === "si" || d.svincola === "no") o.svincola = d.svincola;
  } else if (azione === "sal_stato") {
    s("azione", 12); s("data", 10); s("nota", 300); s("motivo", 300); s("autore", 120);
    if (d.conferma_durc === "si") o.conferma_durc = "si"; // S2: pagata anche senza DURC valido, scelta scritta nel registro
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
  if (sotto === "/sal/sub/api") return apiImpresa(request, env, base, inUrl, h, fn);
  if (sotto === "/sal/sub/doc") return docImpresa(request, env, base, inUrl, h, fn);
  if (sotto === "/sal/sub/foto") return fotoImpresa(request, env, base, inUrl, h);
  if (sotto === "/sal/sub/firma-file") return firmaFileImpresa(request, env, inUrl, h);
  if (sotto === "/sal/sub/porta") return porta(request, env, base, inUrl, h);
  if (sotto === "/sal/sub/porta/api") return apiPorta(request, env, h, fn);
  if (sotto === "/sal/sub/porta/firma") return request.method === "POST" ? firmaPortaCarica(request, env, h) : firmaPortaFile(request, env, inUrl, h);
  if (sotto === "/sal/sub/porta/foto") return request.method === "POST" ? fotoPortaCarica(request, env, inUrl, h) : fotoPortaVedi(request, env, inUrl, h);
  if (sotto === "/sal/sub/porta/doc") return docPorta(request, env, base, inUrl, h, fn);
  return new Response("Not Found", { status: 404 });
}

// ---------------------------------------------------------------------------- lato impresa
async function apiImpresa(request, env, base, inUrl, h, fn) {
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
  } else if (az === "firma_prepara") {
    // S3b (11/11/2026): PDF da firmare scritto una volta sola e registrato con l'impronta, poi firmatore comune (tipo 'sal')
    const kid = String(b.k || "").toLowerCase();
    if (!UUID.test(id) || !UUID.test(kid)) return json({ esito: "errore" }, 400);
    r = await preparaPdfFirma(env, fn,
      () => chiama("sub_firma_file", { p_token: tok, p_commessa: c, p_sal: id, p_cosa: "impresa" }),
      () => chiama("sub_doc_dati", { p_token: tok, p_commessa: c, p_contratto: kid, p_sal: id }),
      (d) => chiama("sub_sal_pdf_registra", { p_token: tok, p_commessa: c, p_sal: id, p_dati: d }));
    if (r && r.esito === "ok") r = { esito: "ok", rif_id: "sub:" + id, pdf: base + "/sal/sub/firma-file?t=" + tok + "&c=" + c + "&id=" + id + "&cosa=impresa" };
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
  // 10/11/2026: logo dell'impresa cliente in testata (sal.js, preparaLogo)
  if (r && r.esito === "ok" && fn.preparaLogo) r.logo = await fn.preparaLogo(r.logo_impresa);
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

async function apiPorta(request, env, h, fn) {
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
  } else if (az === "firma_prepara") {
    // S3b: il sub firma la copia dell'impresa se c'è, altrimenti il PDF (scritto qui se non c'è ancora)
    const id = String(b.id || "").toLowerCase();
    if (!UUID.test(id)) return json({ esito: "errore" }, 400);
    const info = () => chiama("sub_porta_firma_file", { p_k: k, p_sal: id, p_cosa: "sub" });
    r = await preparaPdfFirma(env, fn, info,
      () => chiama("sub_porta_doc", { p_k: k, p_sal: id }),
      (d) => chiama("sub_porta_pdf_registra", { p_k: k, p_sal: id, p_dati: d }));
    if (r && r.esito === "ok") {
      const i = await info();
      if (!i || i.esito !== "ok" || !i.doc) return json({ esito: "incerto" });
      r = { esito: "ok", firma_attiva: i.firma_attiva === true, gia: i.gia === true,
        doc: { sha256: i.doc.sha256, p7m: i.doc.p7m === true, nome: i.doc.nome, chi: i.doc.chi } };
    }
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
  // 10/11/2026: logo dell'impresa cliente in testata (sal.js, preparaLogo)
  if (r && r.esito === "ok" && fn.preparaLogo) r.logo = await fn.preparaLogo(r.logo_impresa);
  return rispostaFile(r, inUrl.searchParams.get("f") === "pdf" ? "pdf" : "xlsx", fn, metodo, h, base, inUrl, base + "/sal/sub/porta");
}

// ---------------------------------------------------------------------------- firma (S3b, 11/11/2026)
// Il PDF da firmare si scrive una volta sola, si salva in wa-media/documenti/<cantiere>/sub/<contratto>/firma/ e il database ne registra
// l'impronta. L'impresa firma con il firmatore comune (firma.js, tipo 'sal', rif_id 'sub:<id>'); il sub firma dal suo link, con il dito
// (il browser scrive la firma sul PDF con pdf-lib) oppure caricando il file firmato digitalmente. Chi firma per secondo firma la copia dell'altro.
const MAX_FIRMATO = 20 * 1024 * 1024;
const CARTELLA_FIRMA = /^documenti\/[0-9a-f-]{36}\/sub\/[0-9a-f-]{36}\/firma\/$/;
function urlArchivio(env, percorso) {
  return (env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co") + "/storage/v1/object/wa-media/" + String(percorso).split("/").map(encodeURIComponent).join("/");
}
async function salvaArchivio(env, percorso, bytes, mime) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(urlArchivio(env, percorso), { method: "POST", signal: ctrl.signal,
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY, "Content-Type": mime, "x-upsert": "false" }, body: bytes });
    return r.ok;
  } catch (e) { return false; } finally { clearTimeout(timer); }
}
async function togliArchivio(env, percorso) {
  if (!CARTELLA_FIRMA.test(String(percorso).replace(/[^/]+$/, ""))) return;
  await fetch(urlArchivio(env, percorso), { method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
}
function esadecimale(buf) { return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join(""); }
function oggiCompatto() {
  const o = new Date();
  return o.getUTCFullYear() + String(o.getUTCMonth() + 1).padStart(2, "0") + String(o.getUTCDate()).padStart(2, "0");
}
async function preparaPdfFirma(env, fn, chiamaInfo, chiamaDati, chiamaRegistra) {
  const i = await chiamaInfo();
  if (!i || i.esito !== "ok") return i || { esito: "incerto" };
  if (i.doc && i.doc.sha256) return { esito: "ok" };
  const cart = String(i.cartella || "");
  if (!CARTELLA_FIRMA.test(cart) || !fn || !fn.salPdf) return { esito: "errore", messaggio: "Il PDF non si prepara: riprova." };
  const d = await chiamaDati();
  if (!d || d.esito !== "ok") return d || { esito: "incerto" };
  if (fn.preparaLogo) d.logo = await fn.preparaLogo(d.logo_impresa);
  const file = fn.salPdf(d);
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  const sha = esadecimale(await crypto.subtle.digest("SHA-256", bytes));
  const perc = cart + oggiCompatto() + "-" + casuale().slice(0, 12) + ".pdf";
  if (!(await salvaArchivio(env, perc, bytes, "application/pdf"))) return { esito: "archivio", messaggio: "Il PDF non si è salvato: riprova tra un minuto." };
  const r = await chiamaRegistra({ percorso: perc, sha256: sha, byte: bytes.length });
  if (!r || r.esito !== "ok") { await togliArchivio(env, perc); return r || { esito: "incerto" }; }
  if (r.fisso) await togliArchivio(env, perc);          // qualcuno ha firmato nel frattempo: vale il PDF di prima
  else if (r.vecchio) await togliArchivio(env, r.vecchio);
  return { esito: "ok" };
}
async function mandaDoc(env, doc, metodo, scarica) {
  const perc = String((doc && doc.percorso) || "");
  if (!perc || perc.indexOf("..") !== -1 || !/^(documenti\/[0-9a-f-]{36}\/sub\/|firme\/[0-9a-f-]{36}\/documenti\/)/.test(perc)) return new Response("Not Found", { status: 404 });
  const f = await fetch(urlArchivio(env, perc), { headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  if (!f || !f.ok) return new Response("File non disponibile in questo momento: riprova tra un minuto.", { status: 502, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  const p7m = doc.mime === "application/pkcs7-mime";
  const nome = String(doc.nome || (p7m ? "contabilita.pdf.p7m" : "contabilita.pdf"));
  return new Response(metodo === "HEAD" ? null : f.body, { status: 200, headers: {
    "Content-Type": p7m ? "application/pkcs7-mime" : "application/pdf",
    "Content-Disposition": (scarica || p7m ? "attachment" : "inline") + '; filename="' + nomeScarico(nome, p7m ? "contabilita.pdf.p7m" : "contabilita.pdf") + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}
async function firmaFileImpresa(request, env, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const tok = String(inUrl.searchParams.get("t") || "").toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  const cosa = String(inUrl.searchParams.get("cosa") || "impresa");
  if (!GETTONE.test(tok) || !UUID.test(c) || !UUID.test(id)) return new Response("Not Found", { status: 404 });
  const r = await h.rpc(env, "sub_firma_file", { p_token: tok, p_commessa: c, p_sal: id, p_cosa: cosa }, 10000).catch(() => null);
  if (!r || r.esito !== "ok" || !r.doc) return new Response("Not Found", { status: 404 });
  return mandaDoc(env, r.doc, metodo, inUrl.searchParams.get("scarica") === "1");
}
async function firmaPortaFile(request, env, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD, POST" } });
  const k = leggiK(request);
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  if (!k || !UUID.test(id)) return new Response("Not Found", { status: 404 });
  const r = await h.rpc(env, "sub_porta_firma_file", { p_k: k, p_sal: id, p_cosa: String(inUrl.searchParams.get("cosa") || "sub") }, 10000).catch(() => null);
  if (!r || r.esito !== "ok" || !r.doc) return new Response("Not Found", { status: 404 });
  return mandaDoc(env, r.doc, metodo, inUrl.searchParams.get("scarica") === "1");
}
function daB64url(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return new TextDecoder().decode(u);
}
function contieneAscii(bytes, testo) {
  const passo = 4 * 1024 * 1024, dec = new TextDecoder("latin1");
  for (let i = 0; i < bytes.length; i += passo - testo.length) {
    if (dec.decode(bytes.subarray(i, Math.min(bytes.length, i + passo))).indexOf(testo) !== -1) return true;
  }
  return false;
}
async function firmaPortaCarica(request, env, h) {
  const k = leggiK(request);
  if (!k) return json({ esito: "link" }, 403);
  let d = null;
  try { const g = String(request.headers.get("X-Firma-Dati") || ""); if (g.length < 4000 && /^[A-Za-z0-9_-]+$/.test(g)) d = JSON.parse(daB64url(g)); } catch (e) { d = null; }
  if (!d || typeof d !== "object") return json({ esito: "errore", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const id = String(d.id || "").toLowerCase(), tipo = d.tipo === "digitale" ? "digitale" : d.tipo === "semplice" ? "semplice" : "";
  if (!UUID.test(id) || !tipo) return json({ esito: "errore", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  if (Number(request.headers.get("Content-Length") || 0) > MAX_FIRMATO) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 20 MB)." }, 413);
  const i = await h.rpc(env, "sub_porta_firma_file", { p_k: k, p_sal: id, p_cosa: "sub" }, 10000).catch(() => null);
  if (!i) return json({ esito: "incerto" }, 503);
  if (i.esito !== "ok") return json(i, 403);
  if (i.firma_attiva !== true) return json({ esito: "spento", messaggio: "La firma non è ancora attiva." }, 403);
  if (i.gia === true) return json({ esito: "errore", messaggio: "Hai già firmato questa contabilità." }, 409);
  if (!i.doc || String(d.sha256_originale || "").toLowerCase() !== i.doc.sha256) return json({ esito: "errore", messaggio: "Il documento è cambiato mentre lo firmavi: ricarica la pagina e firma di nuovo." }, 409);
  const cart = String(i.cartella || "");
  if (!CARTELLA_FIRMA.test(cart)) return json({ esito: "errore" }, 400);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length > MAX_FIRMATO) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 20 MB)." }, 413);
  const pdf = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) === "%PDF-";
  const der = bytes[0] === 0x30 && (bytes[1] & 0x80) === 0x80;                       // .p7m binario
  const b64 = String.fromCharCode(bytes[0], bytes[1], bytes[2]) === "MII";              // .p7m in base64
  let est = "";
  if (tipo === "semplice") { if (pdf) est = ".pdf"; }
  else if (pdf && contieneAscii(bytes, "/ByteRange")) est = ".pdf";                     // PDF firmato digitalmente (PAdES)
  else if (der || b64) est = ".p7m";
  if (!est) return json({ esito: "formato", messaggio: tipo === "semplice" ? "Il file firmato non è un PDF: riprova." :
    "Il file non risulta firmato digitalmente: carica il .p7m oppure il PDF firmato." }, 400);
  const sha = esadecimale(await crypto.subtle.digest("SHA-256", bytes));
  const perc = cart + oggiCompatto() + "-" + casuale().slice(0, 12) + est;
  if (!(await salvaArchivio(env, perc, bytes, est === ".pdf" ? "application/pdf" : "application/pkcs7-mime"))) {
    return json({ esito: "archivio", messaggio: "La copia firmata non si è salvata: riprova tra un minuto." }, 502);
  }
  const r = await h.rpc(env, "sub_porta_firma_registra", { p_k: k, p_sal: id, p_dati: { tipo, sha256_originale: i.doc.sha256, sha256: sha,
    byte: bytes.length, percorso: perc, nome: String(d.nome || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 120) } }, 15000).catch(() => null);
  if (!r || r.esito !== "ok") { await togliArchivio(env, perc); return json(r || { esito: "incerto" }, r ? 400 : 503); }
  return json({ esito: "ok" });
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
  ".fl{font-size:.88rem;font-weight:700;margin:0 0 4px}.fl small{font-weight:400;color:#6b7280}.foto-b{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 4px}" +
  ".foto-b label.fb{display:inline-flex;align-items:center;gap:6px;min-height:46px;margin:0;padding:0 14px;border:1.5px solid var(--sub);border-radius:10px;background:#FBF0EC;color:var(--sub-s);font-weight:700;cursor:pointer}" +
  ".foto-b input{display:none}" +
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
  // S3b: firma con il dito
  "#fi-pad{display:block;width:100%;height:170px;border:2px dashed var(--sub-b);border-radius:12px;background:#fff;touch-action:none;cursor:crosshair}" +
  ".tab{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}.tab .b{min-height:40px;padding:0 12px}.tab .b.on{background:var(--sub);color:#fff}" +
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
  // S2 (11/11/2026): ore in economia della ditta segnate nel Diario del cantiere
  var co=K.conto||{};
  if(Number(co.economie_ore_tot)||Number(co.economie))h+='<div class="pann"><h2>Ore in economia</h2><p style="margin:0">Il Diario del cantiere segna <b>'+qt(co.economie_ore_tot)+' ore</b> in economia della tua ditta'+(K.inizio?' dal '+di(K.inizio):'')+'.'+
    (vuoto(co.economie_prezzo)?' L’impresa non ha ancora scritto il prezzo dell’ora: per ora non entrano nella contabilità.':
      ' Prezzo dell’ora: '+eur(co.economie_prezzo)+' € + IVA.'+(Number(co.economie_periodo)?' Nella prossima contabilità entrano '+qt(co.economie_ore_periodo)+' ore, '+eur(co.economie_periodo)+' € + IVA.':''))+'</p></div>';
  var S=K.sal||[];
  h+='<div class="pann"><h2>Le tue contabilità</h2>'+(S.length?'<ul class="ms">'+S.map(function(s){return '<li><b>'+(s.tipo==='finale'?'Contabilità finale n. ':s.tipo==='svincolo'?'Svincolo delle ritenute n. ':'n. ')+s.numero+'</b> · dal '+di(s.periodo_da)+' al '+di(s.periodo_a)+'<div><span class="q">'+eur(s.dovuto)+' € + IVA</span> <span class="sub">· approvata il '+es(s.emesso_il||'')+'</span> '+
      (s.pagato_il?'<span class="st ok">pagata il '+di(s.pagato_il)+'</span>':'<span class="st am">da pagare</span>')+'</div>'+
      // S3b (11/11/2026): firme
      (s.firma_impresa?'<div class="sub">&#9997;&#65039; Firmata per l’impresa da '+es(s.firma_impresa.nome)+' il '+es(s.firma_impresa.il)+'</div>':'')+
      (s.firma_sub?'<div class="sub">&#9997;&#65039; Firmata da te ('+es(s.firma_sub.nome)+') il '+es(s.firma_sub.il)+'</div>':'')+
      '<div class="riga-b">'+(s.firma_impresa||s.firma_sub?'<a class="b" href="'+es(C.u+'/firma?id='+s.id+'&cosa=ultima')+'" target="_blank" rel="noopener">PDF firmato</a>':'<a class="b" href="'+es(C.u+'/doc?id='+s.id+'&f=pdf')+'">PDF</a>')+
      '<a class="b" href="'+es(C.u+'/doc?id='+s.id+'&f=xlsx')+'">Excel</a>'+(D.firma_sub&&!s.firma_sub?'<button type="button" class="b pr" data-fi="'+s.id+'">Firma</button>':'')+'</div></li>';}).join('')+'</ul>':'<p class="nota" style="margin:0">Ancora nessuna.</p>')+
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
    // 10/11/2026 (Filippo): oltre alle foto già fatte, anche la fotocamera del telefono
    '<p class="fl">Foto <small>(fino a 6)</small></p><div class="foto-b">'+
    '<label class="fb">&#128247; Scatta una foto<input type="file" id="m-cam" accept="image/*" capture="environment"></label>'+
    '<label class="fb">&#128444;&#65039; Scegli dalle foto<input type="file" id="m-file" accept="image/*" multiple></label></div><div class="ft" id="m-ft"></div>'+
    '<label>Chi scrive <small>(nome e cognome)</small><input type="text" id="m-chi" maxlength="120" autocomplete="name" value="'+es(ls('sp_chi'))+'"></label>';
  dlg(m.id?(m.stato==='osservazione'?'Correggi la misura':'Modifica la misura'):'Nuova misura',m.osservazione&&m.stato==='osservazione'?'Osservazione: '+m.osservazione:'',c,'Salva',function(){
    if(INVIO){$('#sp-dlg-m').textContent='Aspetta la fine dell’invio delle foto.';return;}
    var d={id:m.id||'',voce_id:$('#m-v').value,data:$('#m-d').value,lotto:$('#m-lotto').value,piano:$('#m-piano').value,zona:$('#m-zona').value,
      pu:$('#m-pu').value,l:$('#m-l').value,w:$('#m-w').value,h:$('#m-h').value,quantita:$('#m-q').disabled?'':$('#m-q').value,meno:$('#m-meno').checked,
      descrizione:$('#m-ds').value,foto:FOTO,autore:$('#m-chi').value};
    ls('sp_chi',d.autore);ls('sp_lotto',d.lotto);var b=$('#sp-dlg-si');b.disabled=true;
    api('misura',{dati:d}).then(function(r){b.disabled=false;if(r&&r.esito==='ok'){chiudi();avviso('Misura salvata: '+qt(r.quantita));ricarica();}else $('#sp-dlg-m').textContent=errore(r);});});
  ['m-pu','m-l','m-w','m-h','m-v'].forEach(function(i){var x=$('#'+i);if(x)x.addEventListener('input',calcola);});calcola();fotoLista();}
// ---- S3b (11/11/2026): firma del sub, con il dito (pdf-lib scrive la firma in fondo all'ultima pagina, a sinistra) o digitale (file caricato)
var BASE=C.u.replace(/\/sal\/sub\/porta$/,''),PDFLIB='https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',FI={};
function esa(buf){return Array.prototype.map.call(new Uint8Array(buf),function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
function b64url(s){var u=unescape(encodeURIComponent(s));return btoa(u).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function wa(s){return String(s==null?'':s).replace(/[\r\n\t]+/g,' ').replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g,'?');}
function ora(){var d=new Date(),p=function(n){return ('0'+n).slice(-2);};return p(d.getDate())+'/'+p(d.getMonth()+1)+'/'+d.getFullYear()+' alle '+p(d.getHours())+':'+p(d.getMinutes());}
function libPdf(){return window.PDFLib?Promise.resolve():new Promise(function(ok,ko){var s=document.createElement('script');s.src=PDFLIB;s.onload=ok;s.onerror=function(){ko(new Error('lib'));};document.head.appendChild(s);});}
function pad(cv){var x=cv.getContext('2d'),giu=false;FI.vuoto=true;x.lineWidth=4;x.lineCap='round';x.lineJoin='round';x.strokeStyle='#1b2a6b';
  function pt(e){var r=cv.getBoundingClientRect();return [(e.clientX-r.left)*cv.width/r.width,(e.clientY-r.top)*cv.height/r.height];}
  cv.addEventListener('pointerdown',function(e){giu=true;FI.vuoto=false;var p=pt(e);x.beginPath();x.moveTo(p[0],p[1]);x.lineTo(p[0]+0.1,p[1]+0.1);x.stroke();try{cv.setPointerCapture(e.pointerId);}catch(er){}e.preventDefault();});
  cv.addEventListener('pointermove',function(e){if(!giu)return;var p=pt(e);x.lineTo(p[0],p[1]);x.stroke();e.preventDefault();});
  ['pointerup','pointercancel'].forEach(function(n){cv.addEventListener(n,function(){giu=false;});});
  FI.pulisci=function(){x.clearRect(0,0,cv.width,cv.height);FI.vuoto=true;};}
function scriviFirma(doc,nome,cv){return Promise.all([libPdf(),fetch(C.u+'/firma?id='+FI.id+'&cosa=sub',{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('file');return r.arrayBuffer();})])
  .then(function(a){var buf=a[1];return crypto.subtle.digest('SHA-256',buf).then(function(h){if(esa(h)!==String(doc.sha256||''))throw new Error('impronta');return buf;});})
  .then(function(buf){var L=window.PDFLib;return Promise.all([L.PDFDocument.load(buf,{ignoreEncryption:true,updateMetadata:false}),new Promise(function(ok){cv.toBlob(function(b){b.arrayBuffer().then(ok);},'image/png');}),
    fetch(BASE+'/marchio-tix.png',{credentials:'same-origin'}).then(function(r){return r.ok?r.arrayBuffer():null;}).catch(function(){return null;})])
  .then(function(a){var out=a[0];return Promise.all([out.embedFont(L.StandardFonts.Helvetica),out.embedFont(L.StandardFonts.HelveticaBold),out.embedPng(a[1]),a[2]?out.embedPng(a[2]).catch(function(){return null;}):null]).then(function(f){
    var pg=out.getPage(out.getPageCount()-1),W=230,H=96,x0=36,y0=62,terr=L.rgb(0.54,0.23,0.15),gr=L.rgb(0.36,0.4,0.45),nero=L.rgb(0.1,0.1,0.1),im=f[2],mk=f[3];
    pg.drawRectangle({x:x0,y:y0,width:W,height:H,color:L.rgb(1,1,1),opacity:0.92,borderColor:terr,borderWidth:1});
    pg.drawText(wa('Per il subappaltatore'),{x:x0+8,y:y0+H-11,size:6.5,font:f[0],color:gr});
    pg.drawText(wa(String(K.impresa_nome||'')).slice(0,46),{x:x0+8,y:y0+H-21,size:8.2,font:f[1],color:terr});
    var s=Math.min((W-16)/im.width,44/im.height);pg.drawImage(im,{x:x0+8,y:y0+26,width:im.width*s,height:im.height*s});
    pg.drawText(wa(nome).slice(0,50),{x:x0+8,y:y0+16,size:7.2,font:f[1],color:nero});pg.drawText(wa(ora()),{x:x0+8,y:y0+9,size:6.3,font:f[0],color:gr});
    pg.drawText(wa('Impronta del documento '+String(doc.sha256).slice(0,16)+'...'),{x:x0+8,y:y0+3,size:5,font:f[0],color:gr});
    if(mk){var hm=9,lm=mk.width*(hm/mk.height);pg.drawImage(mk,{x:x0+W-6-lm,y:y0+3,width:lm,height:hm});}
    return out.save({useObjectStreams:false});});});});}
function mandaFirma(bytes,tipo,doc,nome){var dd={id:FI.id,tipo:tipo,sha256_originale:String(doc.sha256||''),nome:nome};
  return fetch(C.u+'/firma',{method:'POST',credentials:'same-origin',headers:{'X-Firma-Dati':b64url(JSON.stringify(dd)),'Content-Type':'application/octet-stream'},body:bytes})
    .then(function(r){return r.json();}).catch(function(){return {esito:'incerto'};});}
function firma(id){var s=(K.sal||[]).filter(function(x){return x.id===id;})[0];if(!s)return;FI={id:id,modo:'f'};
  var tit=(s.tipo==='finale'?'Contabilità finale n. ':s.tipo==='svincolo'?'Svincolo delle ritenute n. ':'Contabilità n. ')+s.numero;
  dlg('Firma: '+tit,'Preparo il documento…','<p class="nota">Un momento…</p>','Firma e salva',function(){
    var nome=($('#fi-nome')||{}).value||'',m=$('#sp-dlg-m'),b=$('#sp-dlg-si');nome=nome.trim();
    if(!FI.doc){m.textContent='Il documento non è ancora pronto: aspetta un momento.';return;}
    if(nome.length<3){m.textContent='Scrivi nome e cognome di chi firma.';return;}ls('sp_chi',nome);
    var fine=function(r){b.disabled=false;if(r&&r.esito==='ok'){chiudi();avviso('Contabilità firmata.');ricarica();}else m.textContent=errore(r);};
    if(FI.modo==='d'){var f=$('#fi-file').files&&$('#fi-file').files[0];if(!f){m.textContent='Scegli il file firmato.';return;}b.disabled=true;m.textContent='Carico il file firmato…';
      f.arrayBuffer().then(function(buf){return mandaFirma(buf,'digitale',FI.doc,nome);}).then(fine).catch(function(){fine(null);});return;}
    if(FI.vuoto){m.textContent='Firma nel riquadro con il dito.';return;}b.disabled=true;m.textContent='Metto la firma sul PDF…';
    scriviFirma(FI.doc,nome,$('#fi-pad')).then(function(bytes){m.textContent='Salvo la copia firmata…';return mandaFirma(bytes,'semplice',FI.doc,nome);}).then(fine)
      .catch(function(e){b.disabled=false;m.textContent=e&&e.message==='impronta'?'Il documento è cambiato: ricarica la pagina.':'Non sono riuscito a scrivere la firma sul PDF: usa la firma digitale, oppure riprova.';});});
  api('firma_prepara',{id:id}).then(function(r){if(!r||r.esito!=='ok'){$('#sp-dlg-s').textContent='';$('#sp-dlg-c').innerHTML='<p class="oss">'+es(errore(r))+'</p>';return;}
    var doc=r.doc||{},p7m=!!doc.p7m;FI.doc=doc;FI.modo=p7m?'d':'f';
    $('#sp-dlg-s').textContent=doc.chi==='impresa'?'L’impresa l’ha già firmata: firmi la sua copia, così il documento ha tutte e due le firme.':'Dopo la tua firma la firma anche l’impresa.';
    $('#sp-dlg-c').innerHTML='<div class="tab">'+(p7m?'':'<button type="button" class="b on" data-tm="f">Firma con il dito</button>')+'<button type="button" class="b'+(p7m?' on':'')+'" data-tm="d">Firma digitale</button></div>'+
      '<label>Nome e cognome di chi firma<input type="text" id="fi-nome" maxlength="120" autocomplete="name" value="'+es(ls('sp_chi'))+'"></label>'+
      '<div data-f'+(p7m?' hidden':'')+'><p class="nota" style="margin:0 0 6px">Firma qui sotto con il dito. La firma va in fondo all’ultima pagina, a sinistra, con il tuo nome, la data e l’ora.</p>'+
      '<canvas id="fi-pad" width="700" height="240"></canvas><div class="riga-b"><button type="button" class="b" id="fi-pulisci">Cancella la firma</button></div></div>'+
      '<div data-d'+(p7m?'':' hidden')+'><p class="nota" style="margin:0 0 6px">'+(p7m?'Il documento è già firmato digitalmente (.p7m): si firma solo con la firma digitale. ':'')+
      'Scarica il file, firmalo con la tua firma digitale (chiavetta o firma remota) e carica qui il file firmato: .p7m oppure PDF firmato.</p>'+
      '<a class="b" href="'+es(C.u+'/firma?id='+id+'&cosa=sub&scarica=1')+'">Scarica il file da firmare</a><label style="margin-top:10px">File firmato<input type="file" id="fi-file" accept=".p7m,.pdf,application/pdf,application/pkcs7-mime"></label></div>';
    if(!p7m)pad($('#fi-pad'));});}
document.addEventListener('change',function(ev){if(ev.target.id==='m-file'||ev.target.id==='m-cam'){caricaFoto(ev.target.files);ev.target.value='';}});
document.addEventListener('click',function(ev){var t=ev.target.closest?ev.target.closest('button,a'):null;if(!t)return;
  if(t.id==='sp-dlg-no'){chiudi();return;}
  if(t.id==='sp-dlg-si'){if(dlg.fn)dlg.fn();return;}
  if(t.id==='sp-nuova'){modulo(null);return;}
  // S3b: firma
  if(t.hasAttribute('data-fi')){firma(t.getAttribute('data-fi'));return;}
  if(t.hasAttribute('data-tm')){FI.modo=t.getAttribute('data-tm');[].forEach.call(document.querySelectorAll('[data-tm]'),function(x){x.classList.toggle('on',x===t);});
    var df=$('[data-f]'),dd=$('[data-d]');if(df)df.hidden=FI.modo!=='f';if(dd)dd.hidden=FI.modo!=='d';$('#sp-dlg-m').textContent='';return;}
  if(t.id==='fi-pulisci'){if(FI.pulisci)FI.pulisci();return;}
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
  // S2 (11/11/2026): controlli in giallo, margine voce per voce, economie
  ".sb-avv{background:#FFF8E1;border:1px solid #F2D27A;border-left:5px solid #D99A00;border-radius:12px;padding:10px 14px;margin:10px 0 12px;color:#4A3300}" +
  ".sb-avv h4{margin:0 0 6px;font-size:.95rem;color:#7A4A00}.sb-avv ul{margin:0;padding-left:18px}.sb-avv li{margin:3px 0;font-size:.9rem}.sb-avv p{font-size:.88rem}" +
  ".sb-avv.ok{background:#E6F6EC;border-color:#A7DAB9;border-left-color:#0B8A4E;color:#0B4A2C}" +
  ".tag-g{display:inline-block;margin-top:4px;background:#FFF4DC;color:#7A4A00;font-size:.75rem;font-weight:800;border-radius:6px;padding:2px 8px}" +
  "table.mg tr.neg td{background:#FEF2F2}table.mg tr.tot td{border-top:2px solid var(--sub);background:var(--sub-c)}table.mg td b{font-variant-numeric:tabular-nums}" +
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
// ---- S2 (11/11/2026): controlli che vede solo l'impresa (k.controlli, dal database)
function ctl(k){return (k&&k.controlli)||null;}
function nomeC(k){var c=ctl(k);return (c&&c.nome)||k.impresa_nome||'';}
function giorni(a,b){if(!a||!b)return null;return Math.round((Date.parse(String(b).slice(0,10))-Date.parse(String(a).slice(0,10)))/864e5);}
function durcInfo(k){var c=ctl(k),d=c&&c.durc;if(!d)return null;var s=d.stato,g=giorni(SD.oggi,d.scade_il),nm='«'+es(nomeC(k))+'»';
  if(s==='valido')return g!==null&&g<=15?{cl:'am',chip:'DURC in scadenza il '+di(d.scade_il),t:'Il DURC di '+nm+' scade il '+di(d.scade_il)+'.'}:{cl:'ok',chip:'DURC valido fino al '+di(d.scade_il),t:''};
  if(s==='scaduto')return {cl:'ro',chip:'DURC scaduto',t:'Il DURC di '+nm+' è scaduto il '+di(d.scade_il)+': carica quello nuovo nella Sicurezza del cantiere.'};
  if(s==='senza_scadenza')return {cl:'am',chip:'DURC senza scadenza',t:'Il DURC di '+nm+' non ha la data di scadenza: scrivila nella Sicurezza del cantiere.'};
  return {cl:'am',chip:'Manca il DURC',t:'Nella Sicurezza del cantiere manca il DURC di '+nm+'.'};}
function avvisi(k){var c=ctl(k);if(!c)return [];var a=[],p=c.presenze||{},nm='«'+es(nomeC(k))+'»';
  if((p.senza||[]).length){var gg=[];p.senza.forEach(function(x){var d=di(x.data);if(gg.indexOf(d)<0)gg.push(d);});
    a.push((p.senza.length===1?'1 riga è':p.senza.length+' righe sono')+' in giorni in cui il Diario non segna la ditta '+nm+': '+gg.join(', ')+'.');}
  else if(p.dal&&!p.controllate)a.push('Non è stato possibile confrontare le misure con il Diario: riprova più tardi.');
  (c.sal||[]).forEach(function(v){a.push('Voce n. '+es(v.nr)+' (computo n. '+es(v.computo_nr)+'): il sub ha misurato '+qt(v.q_sub)+' '+es(v.unita||'')+', nel tuo SAL verso il committente ce ne sono '+qt(v.q_impresa)+'.');});
  (c.oltre||[]).forEach(function(v){a.push('Voce n. '+es(v.nr)+': misurati '+qt(v.q_misurata)+' '+es(v.unita||'')+', il contratto del sub ne prevede '+qt(v.q_contratto)+'.');});
  return a;}
// S3b: firme (impresa con il firmatore comune, sub dal suo link)
function firmaU(id,cosa){return C.u+'/sub/firma-file?t='+C.t+'&c='+C.c+'&id='+id+'&cosa='+cosa;}
function notaFirme(s){var a=[],fi=s.firma_impresa,fs=s.firma_sub;
  if(fi)a.push('Firmata per l’impresa da <b>'+es(fi.nome)+'</b> il '+es(fi.il)+(fi.qualificata?' (firma digitale)':''));
  if(fs)a.push('Firmata dal sub: <b>'+es(fs.nome)+'</b> il '+es(fs.il)+(fs.tipo==='digitale'?' (firma digitale)':' (con il dito, dal telefono)')+' · <a href="'+es(firmaU(s.id,'copia_sub'))+'" target="_blank" rel="noopener">la sua copia</a>');
  if(!a.length)return '';return '<p class="nota" style="margin:0 0 6px">&#9997;&#65039; '+a.join('<br>&#9997;&#65039; ')+'</p>';}
function caricaFirmatore(base){return window.TIXFirma?Promise.resolve(window.TIXFirma):new Promise(function(ok,ko){var s=document.createElement('script');s.src=base+'/firma/firma-tix.js';
  s.onload=function(){window.TIXFirma?ok(window.TIXFirma):ko(new Error('firma'));};s.onerror=function(){ko(new Error('firma'));};document.head.appendChild(s);});}
// S3a: nomi delle contabilità e ritenute ancora da svincolare dopo la finale
function nomeSal(s){return s.tipo==='finale'?'Contabilità finale n. '+s.numero:s.tipo==='svincolo'?'Svincolo delle ritenute n. '+s.numero:'Contabilità n. '+s.numero;}
function daSvincolare(k){var f=k.finale;return !!(f&&!f.svincola&&!f.svincolo&&Number(f.ritenuta)>0);}
function senzaDiario(k,id){var c=ctl(k),s=(c&&c.presenze&&c.presenze.senza)||[];for(var i=0;i<s.length;i++)if(s[i].id===id)return true;return false;}
function boxControlli(k){var c=ctl(k);if(!c)return '';var a=avvisi(k),du=durcInfo(k),dt=du&&du.t?[du.t]:[],tutti=a.concat(dt);
  if(!tutti.length)return '<div class="sb-avv ok"><b>Controlli:</b> nessun avviso. Le misure del sub tornano con il Diario e con il tuo SAL verso il committente; il DURC è valido.</div>';
  var p=c.presenze||{};
  return '<div class="sb-avv"><h4>&#9888;&#65039; Controlli da guardare ('+tutti.length+')</h4><ul>'+tutti.map(function(x){return '<li>'+x+'</li>';}).join('')+'</ul>'+
    ((p.senza||[]).length&&!k.nome_cantiere?'<p style="margin:8px 0 0">Se nel Diario e nelle Persone del cantiere la ditta ha un altro nome, scrivilo in «Modifica il contratto del sub», alla voce «Nome della ditta nel Diario».</p>':'')+
    '<p style="margin:8px 0 0">Sono solo avvisi: decidi tu se accettare le righe. Il sub non li vede.</p></div>';}
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
    (function(){var du=durcInfo(k),n=avvisi(k).length,mg=ctl(k)&&ctl(k).margine,neg=mg&&(mg.voci||[]).filter(function(v){return Number(v.margine_unitario)<0;}).length;
      return (k.finale?'<span class="sb-chip ok">Contabilità finale n. '+k.finale.numero+' approvata</span>':'')+(daSvincolare(k)?'<span class="sb-chip am">ritenute da svincolare: '+eur(k.finale.ritenuta)+' €</span>':'')+
        (n&&!ch?'<span class="sb-chip am">&#9888;&#65039; '+(n===1?'1 avviso':n+' avvisi')+' sulle misure</span>':'')+(du&&!ch?'<span class="sb-chip '+du.cl+'">'+es(du.chip)+'</span>':'')+
        (neg?'<span class="sb-chip ro">'+(neg===1?'1 voce':neg+' voci')+' in perdita</span>':'');})()+
    '<div class="s-cifre" style="margin-top:10px"><div class="s-cifra"><small>Contratto del sub</small><b>'+eur(co.importo_contratto)+' €</b><span>'+(function(n){return n===1?'1 voce':n+' voci';})((k.voci||[]).filter(function(v){return !v.tolta;}).length)+'</span></div>'+
    '<div class="s-cifra"><small>Accettato a oggi</small><b>'+eur(co.totale!=null?co.totale:co.lavori)+' €</b><span>'+(Number(co.economie)?'lavori '+eur(co.lavori)+' € + economie '+eur(co.economie)+' €':'già in contabilità '+eur(co.lavori_prec)+' €')+'</span></div>'+
    '<div class="s-cifra"><small>Prossima contabilità</small><b>'+eur(co.dovuto)+' €</b><span>+ IVA, con le righe accettate</span></div>'+
    (function(){var mg=ctl(k)&&ctl(k).margine;if(!mg||!(mg.voci||[]).length)return '';var T=mg.totale||{};
      return '<div class="s-cifra"><small>Tuo margine a oggi</small><b>'+eur(T.margine)+' €</b><span>sulle voci collegate al computo'+(Number(T.ricavo)?', '+(Number(T.margine)/Number(T.ricavo)*100).toFixed(1).replace('.',',')+'%':'')+'</span></div>';})()+'</div>';
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
    (senzaDiario(k,m.id)?'<br><span class="tag-g">&#9888;&#65039; quel giorno il Diario non segna la ditta</span>':'')+
    ((m.foto||[]).length?'<span class="sb-ft">'+m.foto.map(function(f){return '<a href="'+es(fotoU(f.path))+'" target="_blank" rel="noopener"><img src="'+es(fotoU(f.path))+'" alt="foto" loading="lazy"></a>';}).join('')+'</span>':'')+'</span>'+
    '<span class="q">'+qt(m.quantita)+' '+es(m.unita||'')+'</span><span class="q">'+eur(Number(m.quantita)*Number(v.prezzo||0))+' €</span>'+
    (ro?'':modo==='dec'?'<button type="button" class="b ok" data-sb="accetta" data-id="'+m.id+'">Accetta</button><button type="button" class="b ro" data-sb="oss" data-id="'+m.id+'">Osservazione</button>'
      :modo==='acc'?'<button type="button" class="b" data-sb="riapri" data-id="'+m.id+'">Riapri</button>':'')+'</li>';}
function dettagli(k){var M=k.misure||[],ch=k.stato!=='attivo',ro=SD.chiuso,co=k.conto||{};
  var da=M.filter(function(m){return m.stato==='inviata';}),oss=M.filter(function(m){return m.stato==='osservazione';}),acc=M.filter(function(m){return m.stato==='accettata'&&!m.sal_numero;}),ins=M.filter(function(m){return m.sal_numero;});
  var h=boxControlli(k)+'<h3>Da decidere ('+da.length+')</h3>'+(da.length?'<ul class="sb-ms">'+da.map(function(m){return rigaM(k,m,'dec');}).join('')+'</ul>'+(ro?'':'<div class="riga-b"><button type="button" class="b ok" data-sb="tutte" data-id="'+k.id+'">Accetta tutte le righe da decidere</button></div>'):'<p class="nota" style="margin:0">Nessuna riga da decidere.</p>');
  if(oss.length)h+='<h3>In correzione dal sub ('+oss.length+')</h3><ul class="sb-ms">'+oss.map(function(m){return rigaM(k,m,'oss');}).join('')+'</ul>';
  h+='<h3>Accettate, non ancora in contabilità ('+acc.length+')</h3>'+(acc.length?'<ul class="sb-ms">'+acc.map(function(m){return rigaM(k,m,'acc');}).join('')+'</ul>':'<p class="nota" style="margin:0">Nessuna.</p>');
  var eco=Number(co.economie)||0,oreT=Number(co.economie_ore_tot)||0;
  h+='<h3>Contabilità del sub</h3><table class="conto"><tr><td>Lavori accettati a oggi</td><td class="n">'+eur(co.lavori)+' €</td></tr>'+
    (eco||oreT?'<tr><td>+ Economie a oggi <span class="sub">'+(vuoto(co.economie_prezzo)?qt(oreT)+' ore nel Diario, senza prezzo dell’ora: '+(Number(co.economie_prec)?'le nuove non entrano':'non entrano'):
      Number(co.economie_prec)?(Number(co.economie_ore_periodo)?qt(co.economie_ore)+' ore; le '+qt(co.economie_ore_periodo)+' nuove a '+eur(co.economie_prezzo)+' € l’ora':qt(co.economie_ore)+' ore, già in contabilità'):qt(co.economie_ore)+' ore a '+eur(co.economie_prezzo)+' € l’ora')+'</span></td><td class="n">'+eur(eco)+' €</td></tr>'+
      '<tr><td><b>= Totale a oggi</b></td><td class="n"><b>'+eur(co.totale!=null?co.totale:co.lavori)+' €</b></td></tr>':'')+
    (Number(co.ritenuta)?'<tr><td>− Ritenuta a garanzia '+pc(co.ritenuta_pct)+'</td><td class="n">'+eur(co.ritenuta)+' €</td></tr>':'')+
    '<tr><td>− Contabilità già approvate</td><td class="n">'+eur(co.precedenti)+' €</td></tr><tr class="fin" style="background:var(--sub-c)"><td>Prossima contabilità</td><td class="n">'+eur(co.dovuto)+' € + IVA</td></tr></table>'+
    '<div class="riga-b">'+(ro||ch?'':'<button type="button" class="b sb-pr" data-sb="emetti" data-id="'+k.id+'">Approva la contabilità n. '+((k.sal||[]).length?Math.max.apply(null,k.sal.map(function(s){return s.numero;}))+1:1)+'</button>'+
      // S3a (11/11/2026): contabilità finale (chiude il subappalto) e svincolo delle ritenute
      '<button type="button" class="b sb" data-sb="finale" data-id="'+k.id+'">Contabilità finale</button>')+
    (!ro&&daSvincolare(k)?'<button type="button" class="b sb-pr" data-sb="svincolo" data-id="'+k.id+'">Svincola le ritenute ('+eur(k.finale.ritenuta)+' €)</button>':'')+
    (ch&&k.finale?'':'<a class="b" href="'+es(docU(k.id,'','pdf'))+'">Anteprima PDF</a><a class="b ex" href="'+es(docU(k.id,'','xlsx'))+'">Excel a oggi</a>')+'</div>';
  var S=k.sal||[];
  if(S.length)h+='<div class="sal-el" style="margin-top:10px">'+S.map(function(s,i){return '<div class="sal-c"><div class="r1"><b>'+nomeSal(s)+'</b><span>dal '+di(s.periodo_da)+' al '+di(s.periodo_a)+'</span>'+
      (s.tipo==='finale'&&s.svincola&&Number(k.ritenuta_pct)?'<span class="st ok">ritenute svincolate</span>':s.tipo==='finale'&&Number(s.ritenuta)?'<span class="st fi">ritenute trattenute: '+eur(s.ritenuta)+' €</span>':'')+
      (s.pagato_il?'<span class="st ok">pagata il '+di(s.pagato_il)+'</span>':'<span class="st fi">da pagare</span>')+
      (s.pagato_il&&s.pagato_durc_confermato?'<span class="st fi" title="Segnata pagata dopo l’avviso sul DURC">DURC non valido al pagamento</span>':'')+'<span class="imp" style="margin-left:auto">'+eur(s.dovuto)+' € + IVA</span></div>'+
      '<p class="nota" style="margin:6px 0">Approvata il '+es(s.emesso_il||'')+' da '+es(s.emesso_da||'')+(s.pagato_nota?' · '+es(s.pagato_nota):'')+'</p>'+notaFirme(s)+'<div class="riga-b">'+
      (s.firma_impresa||s.firma_sub?'<a class="b ok" href="'+es(firmaU(s.id,'ultima'))+'" target="_blank" rel="noopener">PDF firmato</a>':'<a class="b" href="'+es(docU(k.id,s.id,'pdf'))+'">PDF da firmare</a>')+
      (!ro&&SD.firma_impresa&&!s.firma_impresa?'<button type="button" class="b sb-pr" data-sb="firma" data-id="'+s.id+'" data-k="'+k.id+'">Firma</button>':'')+
      '<a class="b ex" href="'+es(docU(k.id,s.id,'xlsx'))+'">Excel</a>'+
      (ro?'':s.pagato_il?'<button type="button" class="b" data-sb="nonpagata" data-id="'+s.id+'">Togli «pagata»</button>':'<button type="button" class="b ok" data-sb="pagata" data-id="'+s.id+'">Segna pagata</button>')+
      (!ro&&i===0&&!s.pagato_il?'<button type="button" class="b ro" data-sb="annulla" data-id="'+s.id+'">Annulla</button>':'')+'</div></div>';}).join('')+'</div>';
  if(ins.length)h+='<details style="margin-top:10px"><summary>Righe già nelle contabilità ('+ins.length+')</summary><ul class="sb-ms">'+ins.map(function(m){return rigaM(k,m,'sal');}).join('')+'</ul></details>';
  h+=economie(k)+margine(k);
  h+='<h3>Elenco prezzi del sub</h3><table class="av"><thead><tr><th class="t">N.</th><th class="t">Voce</th><th class="t">U.M.</th><th>Prezzo</th><th>Q. contratto</th><th>Misurato</th><th>Accettato</th></tr></thead><tbody>'+
    (k.voci||[]).map(function(v){var oltre=!vuoto(v.quantita)&&Number(v.accettato)>Number(v.quantita);return '<tr class="kv'+(v.tolta?' alt':'')+(oltre?' oltre':'')+'"><td class="t" data-l="N.">'+es(v.nr)+'</td><td class="t"><span class="vd">'+es(v.descrizione)+'</span>'+(v.tariffa?'<span class="vs">'+es(v.tariffa)+'</span>':'')+
      (v.tolta?'<span class="vs">voce tolta dal contratto</span>':'')+(oltre?'<span class="tag-o">oltre la quantità del contratto</span>':'')+'</td><td class="t" data-l="U.M.">'+es(v.unita||'')+'</td><td data-l="Prezzo">'+eur(v.prezzo)+'</td><td data-l="Q. contratto">'+qt(v.quantita)+'</td>'+
      '<td data-l="Misurato">'+qt(v.misurato)+'</td><td data-l="Accettato">'+qt(v.accettato)+'</td></tr>';}).join('')+'</tbody></table>';
  if(!ro&&ch&&k.finale)h+='<p class="nota">Subappalto chiuso con la contabilità finale n. '+k.finale.numero+': il sub può solo guardare e scaricare. Per riaprirlo annulla la finale'+(k.finale.svincolo?' (prima lo svincolo delle ritenute)':'')+'.</p>';
  else if(!ro)h+='<div class="riga-b">'+(ch?'<button type="button" class="b" data-sb="riapri_k" data-id="'+k.id+'">Riapri il subappalto</button>':
    '<button type="button" class="b sb" data-sb="modifica" data-id="'+k.id+'">Modifica il contratto del sub</button><button type="button" class="b ro" data-sb="chiudi" data-id="'+k.id+'">Chiudi il subappalto</button>')+'</div>';
  return h;}
// ---- S2: ore in economia del sub (dal Diario) e margine voce per voce (solo l'impresa)
function economie(k){var c=ctl(k),e=c&&c.economie;if(!e||(!Number(e.ore)&&vuoto(e.prezzo)))return '';var R=e.righe||[],nm='«'+es(nomeC(k))+'»';
  var h='<h3>Ore in economia del sub</h3><p class="nota" style="margin-top:0">Le ore che il Diario segna in economia per la ditta '+nm+(k.inizio?' dal '+di(k.inizio):'')+'. '+
    (vuoto(e.prezzo)?'<b>Scrivi il prezzo dell’ora nel contratto del sub</b> per metterle nella contabilità.':'Entrano nella contabilità a '+eur(e.prezzo)+' € l’ora + IVA.')+'</p>';
  if(!R.length)return h+'<p class="nota">Nessuna ora in economia nel Diario finora.</p>';
  // solo le ore: gli euro sono nel conto qui sopra (le ore già in contabilità restano al prezzo di allora)
  return h+'<table class="av"><thead><tr><th class="t">Giorno</th><th class="t">Lavoro</th><th>Ore</th></tr></thead><tbody>'+
    R.slice(0,80).map(function(r){return '<tr class="kv"><td class="t" data-l="Giorno">'+di(r.data)+'</td><td class="t"><span class="vd">'+es(r.descrizione||'')+'</span></td><td data-l="Ore">'+qt(r.ore)+'</td></tr>';}).join('')+
    (R.length>80?'<tr><td class="t" colspan="3"><small>… e altri '+(R.length-80)+' giorni</small></td></tr>':'')+
    '<tr class="kv"><td class="t"><b>Totale</b></td><td class="t"></td><td data-l="Ore"><b>'+qt(e.ore)+' h</b></td></tr></tbody></table>';}
function margine(k){var c=ctl(k),mg=c&&c.margine;if(!mg)return '';var V=mg.voci||[],T=mg.totale||{},sc=Number(mg.scollegate)||0;
  var h='<h3>Margine voce per voce <small>(lo vedi solo tu)</small></h3>';
  if(!V.length)return h+'<p class="nota" style="margin-top:0">'+(sc?'Collega le voci del sub al tuo computo («Voce computo» in «Modifica il contratto del sub») per vedere il margine.':'Nessuna voce del sub collegata al computo.')+'</p>';
  var pc1=function(x){return vuoto(x)?'':Number(x).toFixed(1).replace('.',',')+'%';};
  return h+'<p class="nota" style="margin-top:0">Prezzo verso il committente'+(Number(mg.ribasso_pct)?' al netto del ribasso del '+pc(mg.ribasso_pct):'')+', sulle quantità del sub già accettate.'+
    (sc?' '+(sc===1?'1 voce del sub non è collegata':sc+' voci del sub non sono collegate')+' al computo e non entra qui.':'')+'</p>'+
    '<table class="av mg"><thead><tr><th class="t">N.</th><th class="t">Voce</th><th>Prezzo sub</th><th>Prezzo committente</th><th>Margine unitario</th><th>Margine %</th><th>Q. accettata</th><th>Costo sub</th><th>Ricavo</th><th>Margine €</th></tr></thead><tbody>'+
    V.map(function(v){var neg=Number(v.margine_unitario)<0;return '<tr class="kv'+(neg?' neg':'')+'"><td class="t" data-l="N.">'+es(v.nr)+'</td><td class="t"><span class="vd">'+es(v.descrizione)+'</span>'+
      '<span class="vs">computo n. '+es(v.computo_nr)+(v.computo_d?' · '+es(v.computo_d):'')+'</span>'+(v.unita_diverse?'<span class="tag-g">unità diverse: sub '+es(v.unita||'')+', computo '+es(v.unita_computo||'')+'</span>':'')+
      (neg?'<span class="tag-o">il prezzo del sub supera quello verso il committente</span>':'')+'</td>'+
      '<td data-l="Prezzo sub">'+eur(v.prezzo_sub)+'</td><td data-l="Prezzo committente">'+eur(v.prezzo_committente)+'</td><td data-l="Margine unitario">'+eur(v.margine_unitario)+'</td><td data-l="Margine %">'+pc1(v.margine_pct)+'</td>'+
      '<td data-l="Q. accettata">'+qt(v.q_accettata)+' '+es(v.unita||'')+'</td><td data-l="Costo sub">'+eur(v.costo)+'</td><td data-l="Ricavo">'+eur(v.ricavo)+'</td><td data-l="Margine €"><b>'+eur(v.margine)+'</b></td></tr>';}).join('')+
    '<tr class="kv tot"><td class="t"></td><td class="t"><b>Totale delle voci collegate</b></td><td></td><td></td><td></td><td data-l="Margine %"><b>'+(Number(T.ricavo)?pc1(Number(T.margine)/Number(T.ricavo)*100):'')+'</b></td><td></td>'+
    '<td data-l="Costo sub"><b>'+eur(T.costo)+'</b></td><td data-l="Ricavo"><b>'+eur(T.ricavo)+'</b></td><td data-l="Margine €"><b>'+eur(T.margine)+'</b></td></tr></tbody></table>'+
    '<p class="nota">Le economie del sub non sono nel margine: si vedono sopra. Costi e margine di tutto il cantiere sono nella pagina «Costi e margine».</p>';}
// ---- S2: pagata senza DURC valido → chiede conferma (scelta 5 del 09/11)
function chiediDurc(id,dd,r){var nm='«'+es(r.impresa||'')+'»',s=r.stato,t=s==='scaduto'?'Il DURC di '+nm+' è scaduto il '+di(r.scade_il)+'.':s==='senza_scadenza'?'Il DURC di '+nm+' non ha la data di scadenza.':'Nella Sicurezza del cantiere non c’è il DURC di '+nm+'.';
  dlg('DURC del sub al '+di(r.data),'Controllo del DURC prima di segnare il pagamento.',
    '<div class="sb-avv"><p style="margin:0"><b>'+t+'</b></p><p style="margin:6px 0 0">Prima di pagare un subappaltatore si controlla che il suo DURC sia valido. Puoi caricarlo nella Sicurezza del cantiere e poi segnare il pagamento, oppure segnarlo lo stesso: la scelta resta scritta nel registro del subappalto.</p></div>',
    'Segna pagata lo stesso',function(){dd.conferma_durc='si';dopo(api('sal_stato',{id:id,dati:dd}),'Segnata pagata.');});}
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
    '<label>Ritenuta a garanzia <small>(%, di solito 0)</small><input type="text" id="sk-rit" inputmode="decimal" value="'+n(k.ritenuta_pct)+'"></label>'+
    // S2 (11/11/2026): nome nel Diario (per i controlli e le economie) e prezzo dell'ora in economia
    '<label>Nome della ditta nel Diario <small>(solo se nel Diario e nelle Persone del cantiere si chiama in un altro modo)</small><input type="text" id="sk-nc" maxlength="160" list="sb-impc" value="'+es(k.nome_cantiere||'')+'"></label>'+
    '<label>Prezzo dell’ora in economia <small>(€ + IVA; vuoto = le ore in economia non entrano in contabilità)</small><input type="text" id="sk-peco" inputmode="decimal" value="'+n(k.prezzo_ora_economia)+'"></label></div>'+
    '<datalist id="sb-impc">'+(SD.imprese_cantiere||[]).map(function(x){return '<option value="'+es(x)+'"></option>';}).join('')+'</datalist>'+
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
      regola:(document.querySelector('input[name=sk-reg]:checked')||{}).value||'mensile',soglia_importo:$('#sk-soglia').value,autore:$('#sk-chi').value,
      nome_cantiere:$('#sk-nc').value,prezzo_ora_economia:$('#sk-peco').value};
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
function mostraLink(k,r,prima){var u=r.url,cn=(SD&&SD.cantiere_nome)||(((window.SAL_D||{}).cantiere||{}).nome)||'',testo='Ciao, questo è il tuo link personale per scrivere le misure '+(cn?'del cantiere «'+cn+'» ':'')+'in TIX: '+u;
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
  if(a==='emetti'){var oggi=SD.oggi||'';dlg('Approvare la contabilità del sub?','Entrano le righe accettate e le ore in economia fino al giorno che scegli. Con l’approvazione riceve il numero e l’impronta SHA-256 e non cambia più.',
      '<label>Righe fino al<input type="date" id="se-a" max="'+es(oggi)+'" value="'+es(oggi)+'"></label><label>Approvata da <small>(nome e cognome)</small><input type="text" id="se-chi" maxlength="120" value="'+es(chi)+'"></label>','Approva',function(){
      var nm=$('#se-chi').value;ls('sal_autore',nm);dopo(api('emetti',{id:id,dati:{periodo_a:$('#se-a').value,autore:nm}}),'Contabilità approvata.');});return;}
  // S3b (11/11/2026): firma dell'impresa con il firmatore comune (tipo 'sal', rif_id 'sub:<id>')
  if(a==='firma'){t.disabled=true;api('firma_prepara',{id:id,k:t.getAttribute('data-k')}).then(function(r){t.disabled=false;
      if(!r||r.esito!=='ok'){avv(errore(r));return;}var base=C.u.replace(/\/sal$/,'');
      caricaFirmatore(base).then(function(F){F.apri({base:base,t:C.t,c:C.c,tipo:'sal',rif_id:r.rif_id,pdf:r.pdf,impostazioni:base+'/firma/impostazioni?t='+C.t+'&c='+C.c,
        onFatto:function(){avv('Contabilità firmata.');carica();}});}).catch(function(){avv('Il firmatore non si carica: riprova tra un minuto.');});});return;}
  // S3a (11/11/2026): contabilità finale e svincolo delle ritenute
  if(a==='finale'){var of=SD.oggi||'',cf=k.conto||{},rf=Number(cf.ritenuta)||0;
    dlg('Contabilità finale di '+k.impresa_nome+'?','Entrano tutte le righe accettate e le ore in economia fino al giorno che scegli. Poi il subappalto si chiude: il sub può solo guardare e scaricare. Finché non è segnata pagata si può annullare, e il subappalto si riapre.',
      '<label>Righe fino al<input type="date" id="sf-a" max="'+es(of)+'" value="'+es(of)+'"></label>'+
      (rf||Number(k.ritenuta_pct)?'<h3>Ritenute a garanzia</h3><div class="scelte"><label><input type="radio" name="sf-sv" value="si" checked> Restituiscile con questa contabilità finale ('+eur(rf)+' € a oggi)</label>'+
        '<label><input type="radio" name="sf-sv" value="no"> Trattienile ancora: le restituisci dopo con «Svincola le ritenute»</label></div>':'')+
      '<label>Approvata da <small>(nome e cognome)</small><input type="text" id="sf-chi" maxlength="120" value="'+es(chi)+'"></label>','Approva la contabilità finale',function(){
      var nm=$('#sf-chi').value,sv=(document.querySelector('input[name=sf-sv]:checked')||{}).value||'si';ls('sal_autore',nm);
      dopo(api('emetti',{id:id,dati:{tipo:'finale',svincola:sv,periodo_a:$('#sf-a').value,autore:nm}}),'Contabilità finale approvata: il subappalto è chiuso.');});return;}
  if(a==='svincolo'){var fz=k.finale||{};dlg('Svincolare le ritenute di '+k.impresa_nome+'?','Le ritenute a garanzia trattenute fino alla contabilità finale n. '+fz.numero+' diventano da pagare. È un documento a sé, con numero e impronta.',
      '<p style="margin:0 0 10px"><b>Ritenute da svincolare: '+eur(fz.ritenuta)+' € + IVA</b></p><label>Approvato da <small>(nome e cognome)</small><input type="text" id="sv-chi" maxlength="120" value="'+es(chi)+'"></label>','Svincola le ritenute',function(){
      var nm=$('#sv-chi').value;ls('sal_autore',nm);dopo(api('emetti',{id:id,dati:{tipo:'svincolo',autore:nm}}),'Ritenute svincolate.');});return;}
  if(a==='pagata'){var o2=SD.oggi||'';dlg('Segnare pagata?','Si segna solo in TIX: non parte nessun pagamento. TIX controlla il DURC del sub alla data del pagamento.','<label>Pagata il<input type="date" id="sp-d" max="'+es(o2)+'" value="'+es(o2)+'"></label><label>Nota <small>(facoltativa, es. bonifico)</small><input type="text" id="sp-n" maxlength="300"></label>','Segna pagata',function(){
      var dd={azione:'pagato',data:$('#sp-d').value,nota:$('#sp-n').value,autore:chi},b=$('#sb-dlg-si');b.disabled=true;
      api('sal_stato',{id:id,dati:dd}).then(function(r){b.disabled=false;if(r&&r.esito==='durc'){chiediDurc(id,dd,r);return;}if(r&&r.esito==='ok'){chiudi();avv('Segnata pagata.');carica();}else msg(errore(r));});});return;}
  if(a==='nonpagata'){t.disabled=true;api('sal_stato',{id:id,dati:{azione:'non_pagato',autore:chi}}).then(function(r){t.disabled=false;if(r&&r.esito==='ok'){avv('Tolto «pagata».');carica();}else avv(errore(r));});return;}
  if(a==='annulla'){dlg('Annullare la contabilità?','Le sue righe tornano accettate e libere per la prossima. Il numero non si riusa. Se è la contabilità finale, il subappalto si riapre.','<label>Motivo<textarea id="sa-m" maxlength="300"></textarea></label>','Annulla la contabilità',function(){
      dopo(api('sal_stato',{id:id,dati:{azione:'annulla',motivo:$('#sa-m').value,autore:chi}}),'Contabilità annullata.');});return;}
  if(a==='chiudi'){dlg('Chiudere il subappalto?','Il sub potrà solo guardare e scaricare le sue contabilità. Si può riaprire.','','Chiudi il subappalto',function(){dopo(api('chiudi',{id:id,dati:{autore:chi}}),'Subappalto chiuso.');});return;}
  if(a==='riapri_k'){t.disabled=true;api('riapri',{id:id,dati:{autore:chi}}).then(function(r){t.disabled=false;if(r&&r.esito==='ok'){avv('Subappalto riaperto.');carica();}else avv(errore(r));});return;}
});
})();`;
