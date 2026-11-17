// ============================================================================
// PANNELLO DI FILIPPO (B18). pannello-1 e pannello-2 del 16/11/2026; pannello-3 (16/11 notte) = versione 2 interattiva,
// richiesta di Filippo: «per ogni cliente, quando clicco, si apre la pagina interna del cliente con tutte le comunicazioni,
// i pagamenti e tutte le cose che vanno». Progetto e confronto con HubSpot, Stripe, Intercom e Vitally:
// Strumenti/pannello-filippo/02-progetto-grafico.md.
//
// Si apre solo con l'accesso personale di Filippo, dal suo dispositivo registrato:
//  1. la porta della B16 (accessiPorta) lavora prima, e qui si vuole esito «ok» (mai richiamare accessi_controlla: accordo B16);
//  2. le funzioni del database pannello_* ricontrollano gettone, utente «tutte le imprese», elenco pannello_ammessi e
//     dispositivo (cookie protetto tix_disp) con _pannello_chi; il collegamento condiviso non entra mai;
//  3. impostazioni.pannello_attivo (no / prova / si). Interruttore d'emergenza del Worker: PANNELLO = "off".
// Rotte: /pannello                 link fisso: riprende la sessione ricordata dal browser (gl_portale_t)
//        /pannello?t=…             l'applicazione (elenco dei clienti, «Oggi», pagina del cliente con #c=<impresa>)
//        /pannello/azione          POST JSON {t, azione, dati}: dati, impresa, nota, regala_crediti
// Funzioni del database (chiuse ad anon): pannello_dati, pannello_impresa, pannello_nota, pannello_regala_crediti.
// Privacy (parere B12 via B6, 16/11): per le persone solo numeri, mai orari o accessi persona per persona.
// ============================================================================

import { accessiChiave } from "./accessi.js";

const ESA64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f-]{36}$/i;

async function rpc(env, nome, corpo, ms) {
  const url = (env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co") + "/rest/v1/rpc/" + nome;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 15000);
  try {
    const r = await fetch(url, { method: "POST", signal: ctrl.signal, body: JSON.stringify(corpo),
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" } });
    if (!r.ok) return null;
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

function intestazioni() {
  return { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
}

export async function portalePannello(request, env, base, sotto, inUrl, h) {
  if ((env && env.PANNELLO === "off") || !env.SUPABASE_SERVICE_KEY) return new Response("Not Found", { status: 404 });
  const stato = h && h.stato ? h.stato.get(request) : null;
  const disp = accessiChiave(request);
  const fuori = () => new Response(h.foglio(base, "Pannello", "", '<p>Questa pagina si apre solo con l\'accesso personale dell\'amministratore di TIX, dal suo dispositivo registrato.</p>' +
    '<p>Se sei l\'amministratore, entra con la tua email e la tua password (non con il collegamento condiviso) e riapri questo link.</p>' +
    '<p class="piede"><a href="' + base + '/accedi?dopo=/pannello">Entra con email e password</a> &nbsp;·&nbsp; <a href="' + base + '/">&larr; Torna ai cantieri</a></p>'), { status: 200, headers: intestazioni() });

  if (sotto === "/pannello/azione") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" } });
    let b = {};
    try { b = JSON.parse((await request.text()).slice(0, 20000)); } catch (e) { b = {}; }
    const tok = String(b.t || "").toLowerCase();
    if (!ESA64.test(tok) || !stato || stato.esito !== "ok") return j({ esito: "no" }, 403);
    const d = b.dati || {};
    const az = UUID.test(String(d.azienda || "")) ? String(d.azienda).toLowerCase() : null;
    if (b.azione === "dati") return j((await rpc(env, "pannello_dati", { p_token: tok, p_disp: disp })) || { esito: "servizio" });
    // pannello-6 (17/11, C1): centrale delle email (Brevo), di tutte o di una sola impresa
    if (b.azione === "email") {
      const g = Number(d.giorni);
      return j((await rpc(env, "pannello_email", { p_token: tok, p_disp: disp, p_az: az, p_giorni: Number.isInteger(g) && g >= 1 && g <= 400 ? g : 30 })) || { esito: "servizio" });
    }
    // pannello-7 (17/11, F1): rubrica dei fornitori da invitare nell'Elenco fornitori TIX (della B3, solo letto)
    if (b.azione === "fornitori") return j((await rpc(env, "pannello_fornitori_dati", { p_token: tok, p_disp: disp })) || { esito: "servizio" });
    // pannello-11 (17/11, F3): email informative agli iscritti dell'Elenco con il consenso (regole B3/B12)
    if (b.azione === "fornitori_scrivi") {
      const ids = (Array.isArray(d.ids) ? d.ids : []).map(String).filter((x) => UUID.test(x)).slice(0, 300);
      const nonce = /^[0-9a-f]{24,64}$/.test(String(d.nonce || "")) ? String(d.nonce) : null;
      if (!nonce) return j({ esito: "codice" }, 400);
      return j((await rpc(env, "pannello_fornitori_scrivi", { p_token: tok, p_disp: disp, p_ids: ids, p_oggetto: String(d.oggetto || "").slice(0, 150), p_testo: String(d.testo || "").slice(0, 6000), p_nonce: nonce })) || { esito: "servizio" });
    }
    if (b.azione === "fornitore") {
      const op = String(d.op || "");
      if (!/^(salva|importa|contattato|non_interessato|togli)$/.test(op)) return j({ esito: "azione" }, 400);
      const righe = Array.isArray(d.righe) ? d.righe.slice(0, 2000) : undefined;
      const r = await rpc(env, "pannello_fornitore", { p_token: tok, p_disp: disp, p_azione: op, p_dati: Object.assign({}, d.scheda || {}, { id: d.id || null }, righe ? { righe: righe, origine: String(d.origine || "").slice(0, 120) } : {}) });
      return j(r || { esito: "servizio" });
    }
    if (!az) return j({ esito: "nontrovata" }, 400);
    if (b.azione === "impresa") return j((await rpc(env, "pannello_impresa", { p_token: tok, p_disp: disp, p_az: az })) || { esito: "servizio" });
    // pannello-13 (17/11, accordo B11): dati di fatturazione dell'impresa (solo i campi concordati, controlli nel DB)
    if (b.azione === "fatturazione") {
      const s = d.scheda && typeof d.scheda === "object" ? d.scheda : {};
      const ok = {}; ["nome_completo", "partita_iva", "codice_fiscale", "codice_sdi", "pec", "indirizzo_sede", "cap", "citta", "provincia", "email_impresa", "telefono", "referente_nome", "referente_email", "referente_telefono"]
        .forEach((kk) => { if (s[kk] != null) ok[kk] = String(s[kk]).slice(0, 200); });
      return j((await rpc(env, "pannello_impresa_fatturazione", { p_token: tok, p_disp: disp, p_az: az, p_dati: ok })) || { esito: "servizio" });
    }
    if (b.azione === "nota") {
      const togli = /^\d{1,12}$/.test(String(d.togli || "")) ? Number(d.togli) : null;
      const r = await rpc(env, "pannello_nota", { p_token: tok, p_disp: disp, p_az: az, p_testo: togli ? null : String(d.testo || "").slice(0, 4000), p_togli: togli });
      return j(r || { esito: "servizio" });
    }
    if (b.azione === "regala_crediti") {
      const n = Number(d.n);
      if (!Number.isInteger(n) || n < 1 || n > 50) return j({ esito: "numero", campo: "n" }, 400);
      // codice unico della finestra: un secondo invio dello stesso regalo non carica niente (richiesta B0)
      const nonce = /^[0-9a-f]{24,64}$/.test(String(d.nonce || "")) ? String(d.nonce) : null;
      if (!nonce) return j({ esito: "codice" }, 400);
      const r = await rpc(env, "pannello_regala_crediti", { p_token: tok, p_disp: disp, p_az: az, p_n: n, p_descrizione: String(d.descrizione || "").slice(0, 200), p_nonce: nonce });
      return j(r || { esito: "servizio" });
    }
    return j({ esito: "azione" }, 400);
  }

  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  // pannello-2: il link fisso /pannello, senza gettone, riprende la sessione ricordata dal browser; altrimenti all'accesso.
  if (!m) {
    if (request.method !== "GET") return Response.redirect(inUrl.origin + base + "/", 303);
    const vai = JSON.stringify(base + "/pannello?t=").replace(/</g, "\\u003c");
    // pannello-12 (accordo B16, accessi-4): senza sessione si va all'accesso con ritorno al pannello (parametro «dopo»)
    const casa = JSON.stringify(base + "/accedi?dopo=/pannello").replace(/</g, "\\u003c");
    return new Response('<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="robots" content="noindex, nofollow"><title>Pannello - TIX</title></head><body style="font-family:system-ui,sans-serif;background:#f4f6f5;color:#1b1f1d">' +
      '<p style="text-align:center;margin-top:20vh">Apro il pannello…</p><script>(function(){var t="";try{t=localStorage.getItem("gl_portale_t")||"";}catch(e){}' +
      'location.replace((/^[0-9a-f]{64}$/i.test(t)?' + vai + '+t.toLowerCase():' + casa + ')+location.hash);})();</script></body></html>', { status: 200, headers: intestazioni() });
  }
  const tok = m[0].toLowerCase();
  if (!stato || stato.esito !== "ok" || !ESA64.test(disp)) return fuori();
  const p = await rpc(env, "pannello_dati", { p_token: tok, p_disp: disp });
  if (!p) return new Response(h.foglio(base, "Pannello", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), { status: 503, headers: intestazioni() });
  if (p.esito !== "ok") return fuori();
  // vecchio indirizzo ?a=<impresa> (pannello-1): si apre la stessa impresa nella versione nuova
  const a = UUID.test(inUrl.searchParams.get("a") || "") ? inUrl.searchParams.get("a").toLowerCase() : "";
  return new Response(paginaApp(base, tok, p, h, a), { status: 200, headers: intestazioni() });
}

// ---------------------------------------------------------------------------------------------------------------------------
// La pagina: guscio HTML + stile + applicazione che gira nel browser (app), con i dati iniziali dentro la pagina.
export function paginaApp(base, tok, dati, h, apri) {
  const cfg = JSON.stringify({ base, t: tok, u: base + "/pannello/azione", apri: apri || "", dati }).replace(/</g, "\\u003c");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>Pannello di TIX</title>' + (h && h.testa ? h.testa(base) : "") +
    '<style id="pstile">' + STILE + '</style></head><body><script>document.querySelectorAll("head style:not(#pstile),head link[rel=stylesheet]").forEach(function(s){s.remove()});</script><div id="app" class="app" aria-live="polite"></div>' +
    '<dialog id="dlg"></dialog><div id="toast" role="status" hidden></div>' +
    '<script id="cfg" type="application/json">' + cfg + '</script><script>var __name=function(f){return f};(' + app.toString() + ')();</script></body></html>';
}

const STILE = `
/* «Scuro elegante», versione riposante (Filippo, 16/11: «colore non staccante per gli occhi perché lo userò diverse ore al giorno»):
   fondo grigio-blu morbido (non nero), testo grigio chiaro (mai bianco puro), arancio TIX smorzato, niente bagliori né sfumature forti,
   contrasti intorno a 10:1 sul testo (leggibile ma non abbagliante). Sempre scuro. */
:root{color-scheme:dark;--blu:#d9894f;--ara:#d9894f;--t:#d5dce6;--t2:#e3e8ef;--s:#8b97a8;--f:#1b2330;--c:#222c3b;--c2:#252f3f;--l:#323e51;--l2:#2a3546;
--ok:#7cc4a0;--okb:rgba(124,196,160,.12);--gi:#d8b46a;--gib:rgba(216,180,106,.12);--ro:#e08f8a;--rob:rgba(224,143,138,.12);--az:#93b4dc;--azb:rgba(147,180,220,.12);
--om:none}
*{box-sizing:border-box}html,body{margin:0;height:100%;color:var(--t);background:var(--f)}
body{font:15px/1.6 "Segoe UI Variable","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;background:var(--f)}
::selection{background:rgba(217,137,79,.3)}
.lato{background:#1e2735!important;border-right-color:var(--l2)!important}
.marchio .logo{background:var(--ara)!important;color:#1b2330!important}
.k .v{font-size:1.6rem!important;letter-spacing:-.01em;color:var(--t2);font-weight:650!important}
.k.ro{box-shadow:inset 0 2px 0 var(--ro)}.k.gi{box-shadow:inset 0 2px 0 var(--gi)}
h1{font-size:1.6rem!important;letter-spacing:-.015em;color:var(--t2);font-weight:650}
.bt{background:var(--c2)!important;color:var(--t)!important;border-color:var(--l)!important}
.bt.pri,.bt.ar{background:var(--ara)!important;border-color:var(--ara)!important;color:#1b2330!important}
.chip[aria-pressed="true"]{background:rgba(217,137,79,.18)!important;border-color:var(--ara)!important;color:var(--t2)!important}
.cl[aria-current="true"]{background:rgba(217,137,79,.1)!important;box-shadow:inset 3px 0 0 var(--ara)}
.scheda[aria-selected="true"]{color:var(--t2)}
#toast{background:var(--c2)!important;color:var(--t2)!important;border:1px solid var(--ara)}
.cerca input,textarea,input[type=number],input[type=text]{background:#1a2230!important}
.i-nota{background:rgba(217,137,79,.12)!important}
.ev{border-top-color:var(--l2)!important}
a{color:var(--az)}button{font:inherit;cursor:pointer}
.app{display:grid;grid-template-columns:310px 1fr;height:100vh}
.lato{border-right:1px solid var(--l);background:var(--c);display:flex;flex-direction:column;min-height:0}
.marchio{display:flex;align-items:center;gap:10px;padding:14px 16px 10px}.marchio b{font-size:1.05rem}.marchio .logo{width:30px;height:30px;border-radius:8px;background:var(--blu);color:#fff;display:grid;place-items:center;font-weight:800}
.marchio .prova{margin-left:auto;font-size:.7rem;font-weight:700;color:var(--gi);background:var(--gib);border-radius:999px;padding:2px 8px}
.voceoggi{margin:0 10px 8px;display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;border:0;background:transparent;color:var(--t);font-weight:600;text-align:left}
.voceoggi[aria-current="page"],.voceoggi:hover{background:var(--l2)}
.titlato{margin:14px 16px 8px;padding-top:12px;border-top:1px solid var(--l);font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--t2,#93a0b2);display:flex;justify-content:space-between;align-items:center}
.titlato.primo{border-top:0;padding-top:0;margin-top:6px}.titlato .n{font-weight:600;letter-spacing:0;text-transform:none}
.cerca{margin:0 10px 8px;position:relative}.cerca input{width:100%;padding:9px 12px;border:1px solid var(--l);border-radius:10px;background:var(--f);color:var(--t);font:inherit}
.filtri{display:flex;gap:6px;flex-wrap:wrap;padding:0 10px 10px}
.chip{border:1px solid var(--l);background:var(--c);color:var(--s);border-radius:999px;padding:4px 10px;font-size:.8rem;font-weight:600}
.chip[aria-pressed="true"]{background:var(--blu);border-color:var(--blu);color:var(--c)}
.chip .n{opacity:.7;margin-left:4px}
.elenco{overflow:auto;flex:1;padding:0 6px 16px}
.cl{display:flex;gap:10px;width:100%;text-align:left;border:0;background:transparent;color:var(--t);padding:10px;border-radius:10px;align-items:flex-start}
.cl:hover{background:var(--l2)}.cl[aria-current="true"]{background:var(--azb)}
.cl .nm{font-weight:650;display:block}.cl .sb{color:var(--s);font-size:.8rem;display:block;margin-top:1px}
.pal{width:10px;height:10px;border-radius:50%;flex:none;margin-top:6px}.p-verde{background:var(--ok)}.p-giallo{background:var(--gi)}.p-rosso{background:var(--ro)}.p-grigio{background:var(--s)}
.corpo{overflow:auto;min-width:0}
.wrap{max-width:1180px;margin:0 auto;padding:22px 24px 60px}
h1{font-size:1.45rem;margin:0;line-height:1.2}h2{font-size:1rem;margin:0 0 12px}h3{font-size:.9rem;margin:16px 0 8px;color:var(--s);text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--s);font-size:.88rem}
.card{background:var(--c);border:1px solid var(--l);border-radius:14px;padding:16px;box-shadow:var(--om)}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.k{background:var(--c);border:1px solid var(--l);border-radius:14px;padding:14px;box-shadow:var(--om);min-width:0}
.k .et{color:var(--s);font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.k .v{font-size:1.35rem;font-weight:750;margin-top:4px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.k .n2{color:var(--s);font-size:.8rem;margin-top:2px}
.k.ro{border-color:var(--ro)}.k.gi{border-color:var(--gi)}
.barra{height:8px;background:var(--l2);border-radius:999px;overflow:hidden;margin-top:8px}.barra i{display:block;height:100%;background:var(--blu);border-radius:999px}
.barra.gi i{background:var(--gi)}.barra.ro i{background:var(--ro)}
.testa{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.testa .tit{flex:1;min-width:220px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:.78rem;font-weight:700;border-radius:999px;padding:3px 10px;margin-top:8px}
.b-verde{background:var(--okb);color:var(--ok)}.b-giallo{background:var(--gib);color:var(--gi)}.b-rosso{background:var(--rob);color:var(--ro)}.b-grigio{background:var(--l2);color:var(--s)}
.motivi{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:6px}.motivi li{font-size:.8rem;border-radius:8px;padding:3px 8px}
.motivi .r{background:var(--rob);color:var(--ro)}.motivi .g{background:var(--gib);color:var(--gi)}
.azioni{display:flex;gap:8px;flex-wrap:wrap}
.bt{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--l);background:var(--c);color:var(--t);border-radius:10px;padding:8px 12px;font-weight:600;font-size:.88rem;text-decoration:none}
.bt:hover{border-color:var(--blu)}.bt.pri{background:var(--blu);border-color:var(--blu);color:var(--c)}.bt.ar{background:var(--ara);border-color:var(--ara);color:#fff}
.bt[disabled],.bt.off{opacity:.45;pointer-events:none}
.schede{display:flex;gap:2px;border-bottom:1px solid var(--l);margin:8px 0 16px;overflow-x:auto}
.scheda{border:0;background:transparent;color:var(--s);padding:10px 14px;font-weight:650;border-bottom:2px solid transparent;white-space:nowrap}
.scheda[aria-selected="true"]{color:var(--t);border-bottom-color:var(--ara)}
.griglia2{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:18px;align-items:start}
.dati dl{display:grid;grid-template-columns:110px 1fr;gap:6px 10px;margin:0;font-size:.86rem}.dati dt{color:var(--s)}.dati dd{margin:0;overflow-wrap:anywhere;display:flex;gap:6px;align-items:flex-start;justify-content:space-between}
.copia{border:0;background:transparent;color:var(--s);font-size:.75rem;padding:0 2px}.copia:hover{color:var(--az)}
.crono{list-style:none;margin:0;padding:0}
.mese{font-size:.78rem;font-weight:700;color:var(--s);text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px}
.ev{display:grid;grid-template-columns:34px 1fr auto;gap:10px;padding:10px 0;border-top:1px solid var(--l2);align-items:start}
.ev:first-child{border-top:0}
.ic{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-size:.8rem;font-weight:800}
.i-pagamento{background:var(--azb);color:var(--az)}.i-pagato{background:var(--okb);color:var(--ok)}.i-ritardo{background:var(--rob);color:var(--ro)}
.i-crediti{background:var(--gib);color:var(--gi)}.i-email{background:var(--l2);color:var(--blu)}.i-cantiere{background:var(--l2);color:var(--s)}
.i-nota{background:#fff1e6;color:var(--ara)}.i-inizio,.i-contratto{background:var(--okb);color:var(--ok)}.i-assistenza{background:var(--azb);color:var(--az)}
.ev .ti{font-weight:600}.ev .d{color:var(--s);font-size:.85rem;white-space:pre-wrap;overflow-wrap:anywhere}.ev .q{color:var(--s);font-size:.8rem;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:.86rem}th,td{text-align:left;padding:8px 6px;border-top:1px solid var(--l2);vertical-align:top}th{color:var(--s);font-weight:600;border-top:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.stato{font-size:.75rem;font-weight:700;border-radius:999px;padding:2px 8px;white-space:nowrap}
.s-pagato{background:var(--okb);color:var(--ok)}.s-in_attesa{background:var(--gib);color:var(--gi)}.s-annullato{background:var(--l2);color:var(--s)}
.vuoto{color:var(--s);text-align:center;padding:26px 10px}
.avv{display:flex;gap:10px;align-items:center;width:100%;text-align:left;border:1px solid var(--l);background:var(--c);color:var(--t);border-radius:12px;padding:12px;margin:8px 0}
.avv:hover{border-color:var(--blu)}.avv .m{color:var(--s);font-size:.85rem}
.cant{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
textarea{width:100%;min-height:90px;font:inherit;padding:10px;border:1px solid var(--l);border-radius:10px;background:var(--f);color:var(--t)}
input[type=number],input[type=text]{font:inherit;padding:9px 10px;border:1px solid var(--l);border-radius:10px;background:var(--f);color:var(--t);width:100%}
.err{color:var(--ro);font-size:.85rem;font-weight:600}.campo-rosso{border-color:var(--ro)!important}
.nt{padding:12px 0;border-top:1px solid var(--l2)}.nt:first-child{border-top:0}.nt p{margin:4px 0 0;white-space:pre-wrap}
dialog{border:0;border-radius:16px;padding:0;max-width:440px;width:calc(100% - 32px);background:var(--c);color:var(--t);box-shadow:0 20px 50px rgba(0,0,0,.25)}
dialog::backdrop{background:rgba(15,20,25,.45)}.dl{padding:20px}.dl h2{font-size:1.1rem}.dl label{display:block;font-weight:600;margin:12px 0 6px;font-size:.88rem}
.dl .azioni{justify-content:flex-end;margin-top:18px}
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--blu);color:var(--c);padding:10px 16px;border-radius:10px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:9}
.caric{display:grid;gap:12px}.sk{height:16px;border-radius:8px;background:linear-gradient(90deg,var(--l2),var(--l),var(--l2));background-size:200% 100%;animation:sk 1.2s infinite}
@keyframes sk{to{background-position:-200% 0}}
.indietro{display:none}
@media (max-width:1100px){.griglia2{grid-template-columns:1fr}}
@media (max-width:820px){.app{grid-template-columns:1fr;height:auto;min-height:100vh}.lato{border-right:0;min-height:100vh}.app.dentro .lato{display:none}.app:not(.dentro) .corpo{display:none}
 .corpo{overflow:visible}.wrap{padding:14px 14px 50px}.indietro{display:inline-flex;margin-bottom:10px}.kpi{grid-template-columns:repeat(2,minmax(0,1fr))}.k .v{font-size:1.1rem}
 .ev{grid-template-columns:30px 1fr}.ev .q{grid-column:2}.dati dl{grid-template-columns:96px 1fr}}
@media (prefers-reduced-motion:reduce){.sk{animation:none}}
`;

// ---------------------------------------------------------------------------------------------------------------------------
// L'applicazione nel browser. Si serializza con toString(): non deve usare niente di fuori da questa funzione.
// pannello-4 (17/11): il bundler di Cloudflare aggiunge __name(...) alle funzioni interne; la pagina lo definisce prima (sopra).
// pannello-5 (17/11): lo strato «premium» del portale (stile-premium.js, chiaro) si aggiunge in fondo all'head e copriva lo stile
//   scuro: la pagina toglie ogni foglio di stile che non sia il suo (#pstile) prima di disegnare.
function app() {
  var C = JSON.parse(document.getElementById("cfg").textContent);
  var D = C.dati, CACHE = {}, MAIL = {}, FO = null, S = { c: "", p: "", tab: "crono", f: "tutti", q: "", cf: "tutto", ef: "tutte", eq: "", eg: 30, ff: "tutti", fq: "", ft: "logo" };
  var $ = function (id) { return document.getElementById(id); };
  var E = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var EUR = function (n) { return (n === null || n === undefined || n === "") ? "—" : Number(n).toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " €"; };
  var DT = function (s, ora) {
    if (!s) return "—"; var t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T12:00:00Z" : s;
    try { return new Date(t).toLocaleString("it-IT", Object.assign({ timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric" }, ora ? { hour: "2-digit", minute: "2-digit" } : {})); } catch (e) { return ""; }
  };
  var FA = function (s) {
    if (!s) return "mai"; var d = (Date.now() - new Date(s).getTime()) / 1000;
    if (d < 3600) return "da poco"; if (d < 86400) return Math.floor(d / 3600) + " ore fa"; if (d < 172800) return "ieri";
    if (d < 86400 * 30) return Math.floor(d / 86400) + " giorni fa"; return DT(s);
  };
  var MESE = function (s) { try { return new Date(s).toLocaleString("it-IT", { timeZone: "Europe/Rome", month: "long", year: "numeric" }); } catch (e) { return ""; } };
  var SEM = { verde: "Tutto a posto", giallo: "Da guardare", rosso: "Serve un intervento", grigio: "Non attiva" };
  var PAG = { regolare: "In regola", promemoria: "Promemoria mandato", avviso: "Avviso mandato", sospesa: "Sospesa", chiusa: "Chiusa", errore: "Non letto" };
  var IC = { pagamento: "€", pagato: "✓", ritardo: "!", crediti: "C", email: "@", cantiere: "▦", nota: "✎", inizio: "★", contratto: "§", assistenza: "?" };
  var CF = [["tutto", "Tutto"], ["soldi", "Pagamenti"], ["crediti", "Crediti"], ["email", "Email"], ["cantiere", "Cantieri"], ["nota", "Note"], ["assistenza", "Assistenza"]];
  var TABS = [["crono", "Cronologia"], ["pag", "Pagamenti"], ["mail", "Email"], ["uso", "Uso"], ["pers", "Persone e numeri"], ["cant", "Cantieri"], ["note", "Note"]];

  function toast(t) { var x = $("toast"); x.textContent = t; x.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(function () { x.hidden = true; }, 2600); }
  function chiama(az, dati) {
    return fetch(C.u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: C.t, azione: az, dati: dati || {} }) })
      .then(function (r) { return r.json(); }).catch(function () { return { esito: "servizio" }; });
  }
  function cliente(id) { return (D.clienti || []).filter(function (c) { return c.id === id; })[0]; }
  function veri() { return (D.clienti || []).filter(function (c) { return !c.prova; }); }

  // ---- hash: #c=<impresa>&s=<scheda>
  function leggiHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    S.c = /^[0-9a-f-]{36}$/i.test(p.get("c") || "") ? p.get("c") : "";
    S.tab = TABS.some(function (t) { return t[0] === p.get("s"); }) ? p.get("s") : "crono";
    S.p = !S.c && (p.get("p") === "email" || p.get("p") === "fornitori") ? p.get("p") : "";
  }
  function vai(c, tab, pag) {
    var h = c ? "#c=" + c + (tab && tab !== "crono" ? "&s=" + tab : "") : pag ? "#p=" + pag : "#";
    if (location.hash !== h) location.hash = h; else disegna();
  }

  // ---- colonna dei clienti
  function lato() {
    var cl = D.clienti || [];
    var conta = { tutti: cl.length, rosso: 0, giallo: 0, nuovo: 0, prova: 0 };
    cl.forEach(function (c) { if (c.semaforo === "rosso") conta.rosso++; if (c.semaforo === "giallo") conta.giallo++; if (c.nuovo && !c.prova) conta.nuovo++; if (c.prova) conta.prova++; });
    var F = [["tutti", "Tutti"], ["rosso", "Da sistemare"], ["giallo", "Da guardare"], ["nuovo", "Nuovi"], ["prova", "Prova"]];
    var q = S.q.toLowerCase();
    var lista = cl.filter(function (c) {
      var okf = S.f === "tutti" || (S.f === "rosso" && c.semaforo === "rosso") || (S.f === "giallo" && c.semaforo === "giallo") || (S.f === "nuovo" && c.nuovo && !c.prova) || (S.f === "prova" && c.prova);
      var okq = !q || [c.nome, c.nome_completo, c.titolare, c.email].join(" ").toLowerCase().indexOf(q) !== -1;
      return okf && okq;
    });
    return '<div class="marchio"><span class="logo">T</span><b>Pannello di TIX</b>' + (D.stato === "prova" ? '<span class="prova">in prova</span>' : '') + '</div>' +
      '<div class="titlato primo">Centrale di TIX</div>' +
      '<button class="voceoggi" data-oggi' + (S.c || S.p ? '' : ' aria-current="page"') + '>☀ Oggi</button>' +
      '<button class="voceoggi" data-pag="email"' + (S.p === "email" ? ' aria-current="page"' : '') + '>✉ Email</button>' +
      '<button class="voceoggi" data-pag="fornitori"' + (S.p === "fornitori" ? ' aria-current="page"' : '') + '>🏗 Fornitori TIX</button>' +
      '<div class="titlato">Clienti di TIX <span class="n">' + cl.filter(function (c) { return !c.prova; }).length + (conta.prova ? ' + ' + conta.prova + ' di prova' : '') + '</span></div>' +
      '<div class="cerca"><input id="q" type="search" placeholder="Cerca tra i clienti…" aria-label="Cerca tra i clienti di TIX" value="' + E(S.q) + '"></div>' +
      '<div class="filtri" role="group" aria-label="Filtra i clienti">' + F.map(function (f) {
        return '<button class="chip" data-f="' + f[0] + '" aria-pressed="' + (S.f === f[0]) + '">' + f[1] + '<span class="n">' + conta[f[0]] + '</span></button>';
      }).join("") + '</div>' +
      '<nav class="elenco" aria-label="Clienti">' + (lista.length ? lista.map(function (c) {
        return '<button class="cl" data-c="' + c.id + '" aria-current="' + (S.c === c.id) + '"><span class="pal p-' + c.semaforo + '" title="' + SEM[c.semaforo] + '"></span><span>' +
          '<span class="nm">' + E(c.nome) + '</span><span class="sb">' + (c.prova ? 'impresa di prova · ' : '') + (c.listino_v5 ? EUR(c.canone_eur) + ' + IVA al mese' : 'listino vecchio') +
          ' · ultimo uso ' + FA(c.ultimo_uso) + '</span></span></button>';
      }).join("") : '<p class="vuoto">Nessun cliente trovato.</p>') + '</nav>';
  }

  // ---- pagina «Oggi»
  function oggi() {
    var v = veri(), s = D.soldi || {}, si = D.sistema || {};
    var avv = [];
    (D.clienti || []).forEach(function (c) {
      (c.rossi || []).forEach(function (m) { avv.push({ c: c, m: m, l: "rosso" }); });
      (c.gialli || []).forEach(function (m) { avv.push({ c: c, m: m, l: "giallo" }); });
    });
    avv.sort(function (a, b) { return (a.l === "rosso" ? 0 : 1) - (b.l === "rosso" ? 0 : 1); });
    var nuovi = v.filter(function (c) { return c.nuovo; });
    var ora = new Date().getHours();
    return '<div class="wrap"><h1>' + (ora < 13 ? "Buongiorno" : ora < 18 ? "Buon pomeriggio" : "Buonasera") + ', Filippo</h1>' +
      '<p class="sub">Aggiornato ' + DT(D.ora, true) + ' · ' + (D.stato === "prova" ? 'in prova: lo vedi solo tu' : 'lo vedi solo tu') + '</p>' +
      '<div class="kpi">' +
        k("Clienti", v.length, nuovi.length ? nuovi.length + " nuovi negli ultimi 30 giorni" : "nessuno nuovo questo mese") +
        k("Da sistemare", v.filter(function (c) { return c.semaforo === "rosso"; }).length, "pallino rosso", v.some(function (c) { return c.semaforo === "rosso"; }) ? "ro" : "") +
        k("Da guardare", v.filter(function (c) { return c.semaforo === "giallo"; }).length, "pallino giallo", v.some(function (c) { return c.semaforo === "giallo"; }) ? "gi" : "") +
        k("Incassato nel mese", EUR(s.incassato_mese), "+ IVA") +
        k("Da incassare", EUR(s.atteso), "canoni da pagare, + IVA") +
        k("In ritardo", s.ritardi || 0, "pagamenti non arrivati", s.ritardi ? "ro" : "") +
      '</div>' +
      '<div class="griglia2"><section class="card"><h2>Da fare oggi</h2>' + (avv.length ? avv.map(function (a) {
        return '<button class="avv" data-c="' + a.c.id + '"><span class="pal p-' + a.l + '"></span><span><b>' + E(a.c.nome) + '</b>' + (a.c.prova ? ' <span class="sub">(prova)</span>' : '') +
          '<span class="m"> — ' + E(a.m) + '</span></span></button>';
      }).join("") : '<p class="vuoto">Niente da fare: tutti i clienti sono a posto. ✓</p>') + '</section>' +
      '<aside class="card"><h2>Sistema</h2><p class="sub">Ultime 24 ore</p><div class="dati"><dl>' +
        '<dt>Errori di Make</dt><dd>' + (si.errori_make_24h || 0) + '</dd><dt>WhatsApp fermi</dt><dd>' + (si.messaggi_fermi_24h || 0) + '</dd></dl></div>' +
        (nuovi.length ? '<h3>Clienti nuovi</h3>' + nuovi.map(function (c) { return '<button class="avv" data-c="' + c.id + '"><span class="pal p-' + c.semaforo + '"></span><span><b>' + E(c.nome) + '</b><span class="m"> dal ' + DT(c.inizio) + '</span></span></button>'; }).join("") : '') +
      '</aside></div></div>';
  }
  function k(et, v, n2, cls) { return '<div class="k ' + (cls || "") + '"><div class="et">' + et + '</div><div class="v">' + E(v) + '</div>' + (n2 ? '<div class="n2">' + E(n2) + '</div>' : '') + '</div>'; }

  // ---- pagina del cliente
  function paginaCliente() {
    var c = cliente(S.c);
    if (!c) return '<div class="wrap"><p class="vuoto">Cliente non trovato.</p></div>';
    var p = CACHE[S.c];
    var v = c.voci || {}, perc = Math.max(0, Math.min(100, Number(v.percentuale || 0)));
    var pag = (c.pagamento || {}).stato || "regolare";
    var att = (c.in_attesa || [])[0];
    var mail = c.email, tel = c.telefono;
    var motivi = (c.rossi || []).map(function (m) { return '<li class="r">' + E(m) + '</li>'; }).concat((c.gialli || []).map(function (m) { return '<li class="g">' + E(m) + '</li>'; })).join("");
    var x = '<div class="wrap"><button class="bt indietro" data-oggi>← Clienti</button>' +
      '<div class="testa"><div class="tit"><h1>' + E(c.nome) + '</h1>' +
      '<div class="sub">' + E(c.nome_completo && c.nome_completo !== c.nome ? c.nome_completo + ' · ' : '') + 'cliente dal ' + DT(c.inizio) + (c.titolare ? ' · titolare ' + E(c.titolare) : '') + '</div>' +
      '<span class="badge b-' + c.semaforo + '"><span class="pal p-' + c.semaforo + '" style="margin:0"></span>' + SEM[c.semaforo] + '</span>' + (c.prova ? ' <span class="badge b-grigio">impresa di prova, non si conta</span>' : '') +
      (motivi ? '<ul class="motivi">' + motivi + '</ul>' : '') + '</div>' +
      '<div class="azioni">' +
        '<a class="bt pri' + (mail ? '' : ' off') + '" href="' + (mail ? 'mailto:' + E(mail) : '#') + '" title="' + (mail ? 'Scrivi a ' + E(mail) : 'Manca l\'email del titolare') + '">✉ Scrivi email</a>' +
        '<a class="bt' + (tel ? '' : ' off') + '" href="' + (tel ? 'tel:' + E(String(tel).replace(/\s/g, "")) : '#') + '" title="' + (tel ? E(tel) : 'Manca il telefono del titolare') + '">☎ Chiama</a>' +
        '<button class="bt" data-tab="note" data-fuoco="1">✎ Nota</button>' +
        '<button class="bt ar" data-regala>🎁 Regala crediti</button>' +
        '<button class="bt" data-copia-tutto>⧉ Copia dati</button>' +
      '</div></div>' +
      '<div class="kpi">' +
        k("Pagamento", PAG[pag] || pag, att ? "da pagare " + EUR(att.importo) + " entro il " + DT(att.scadenza) : "nessun canone in attesa", (pag === "sospesa" || pag === "chiusa") ? "ro" : (att || pag !== "regolare") ? "gi" : "") +
        k("Canone", c.listino_v5 ? EUR(c.canone_eur) : "listino vecchio", c.listino_v5 ? "+ IVA al mese · " + (c.persone_canone || 0) + " persone" : "") +
        '<div class="k' + (perc >= 95 ? ' ro' : perc >= 80 ? ' gi' : '') + '"><div class="et">Voci del mese</div><div class="v">' + (v.voci_usate == null ? "—" : v.voci_usate + " / " + v.voci_disponibili) + '</div>' +
          '<div class="barra' + (perc >= 95 ? ' ro' : perc >= 80 ? ' gi' : '') + '"><i style="width:' + perc + '%"></i></div><div class="n2">' + perc + ' % usate</div></div>' +
        k("Crediti", (c.crediti || {}).totale == null ? "—" : c.crediti.totale, (c.crediti || {}).prossima_scadenza ? "scadenza " + c.crediti.prossima_scadenza : "") +
        k("Persone", c.persone_reali == null ? "—" : c.persone_reali, (c.numeri || 0) + " numeri WhatsApp") +
        k("Ultimo uso", FA(c.ultimo_uso), (c.cantieri || 0) + (c.cantieri === 1 ? " cantiere attivo" : " cantieri attivi")) +
      '</div>' +
      '<div class="schede" role="tablist">' + TABS.map(function (t) { return '<button class="scheda" role="tab" data-tab="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '">' + t[1] + '</button>'; }).join("") + '</div>';
    if (!p) return x + '<div class="caric"><div class="sk" style="width:60%"></div><div class="sk"></div><div class="sk" style="width:80%"></div><div class="sk"></div></div></div>';
    if (p.esito !== "ok") return x + '<p class="err">Non è stato possibile leggere questo cliente. Ricarica la pagina.</p></div>';
    x += '<div class="griglia2"><div>' + ({ crono: tCrono, pag: tPag, mail: tMail, uso: tUso, pers: tPers, cant: tCant, note: tNote }[S.tab])(c, p) + '</div>' + colonnaDati(c, p) + '</div></div>';
    return x;
  }

  function colonnaDati(c, p) {
    var a = p.anagrafica || {};
    // regola «campi mancanti in rosso» (14/11): i dati per la fattura che mancano si segnano in rosso
    // per la fattura basta uno tra SDI e PEC (regola B11): l'altro non si segna in rosso
    var FATT = { "Ragione sociale": a.nome_completo, "Partita IVA": a.partita_iva, "Cod. fiscale": a.codice_fiscale, "SDI": a.sdi || a.pec, "PEC": a.pec || a.sdi, "Sede": a.indirizzo };
    var manca = Object.keys(FATT).filter(function (kk) { return !FATT[kk]; });
    if (manca.indexOf("PEC") !== -1) { manca.splice(manca.indexOf("PEC"), 1); manca[manca.indexOf("SDI")] = "SDI o PEC"; }
    var r = function (et, v, tipo) {
      if (!v) return '<dt>' + et + '</dt><dd>' + (FATT.hasOwnProperty(et) && !FATT[et] ? '<span class="err">manca</span>' : '<span class="sub">—</span>') + '</dd>';
      var vis = tipo === "mail" ? '<a href="mailto:' + E(v) + '">' + E(v) + '</a>' : tipo === "tel" ? '<a href="tel:' + E(String(v).replace(/\s/g, "")) + '">' + E(v) + '</a>' : E(v);
      return '<dt>' + et + '</dt><dd><span>' + vis + '</span><button class="copia" data-copia="' + E(v) + '" aria-label="Copia ' + et + '">copia</button></dd>';
    };
    return '<aside class="card dati"><h2>Dati dell\'impresa</h2>' +
      (manca.length ? '<p class="err" style="margin:0 0 8px">Per la fattura mancano ' + manca.length + (manca.length === 1 ? ' dato: ' : ' dati: ') + E(manca.join(", ")) + '.</p>' : '<p class="sub" style="margin:0 0 8px">Dati per la fattura completi ✓</p>') +
      '<button class="bt' + (manca.length ? ' pri' : '') + '" data-fatt style="margin:0 0 10px">✎ ' + (manca.length ? 'Completa i dati di fatturazione' : 'Modifica i dati di fatturazione') + '</button><dl>' +
      r("Ragione sociale", a.nome_completo) + r("Partita IVA", a.partita_iva) + r("Cod. fiscale", a.codice_fiscale) + r("SDI", a.sdi) + r("PEC", a.pec, "mail") +
      r("Sede", a.indirizzo) + r("Email", a.email_impresa, "mail") + r("Telefono", a.telefono, "tel") + r("Titolare", a.titolare) +
      r("Email titolare", a.titolare_email, "mail") + r("Tel. titolare", a.titolare_telefono, "tel") + '</dl>' +
      '<h3>Contratto</h3><dl><dt>Listino</dt><dd>' + (c.listino_v5 ? "89 · 22 · 12" : E("vecchio (" + (a.listino || "") + ")")) + '</dd>' +
      '<dt>Termini</dt><dd>' + (p.contratto ? DT(p.contratto.termini_il) + " · v. " + E(p.contratto.versione || "") : '<span class="sub">non ancora accettati</span>') + '</dd>' +
      '<dt>Carta</dt><dd>' + (a.stripe ? "registrata su Stripe" : '<span class="sub">nessuna</span>') + '</dd>' +
      (a.disdetta ? '<dt>Disdetta</dt><dd>' + DT(a.disdetta) + '</dd>' : '') + '</dl></aside>';
  }

  function tCrono(c, p) {
    var tipi = { soldi: ["pagamento", "pagato", "ritardo", "contratto", "inizio"], crediti: ["crediti"], email: ["email"], cantiere: ["cantiere"], nota: ["nota"], assistenza: ["assistenza"] };
    var ev = (p.cronologia || []).filter(function (e) { return S.cf === "tutto" || (tipi[S.cf] || []).indexOf(e.t) !== -1; });
    var x = '<div class="filtri" style="padding:0 0 10px" role="group" aria-label="Filtra la cronologia">' + CF.map(function (f) {
      return '<button class="chip" data-cf="' + f[0] + '" aria-pressed="' + (S.cf === f[0]) + '">' + f[1] + '</button>';
    }).join("") + '</div>';
    if (!ev.length) return x + '<div class="card vuoto">Niente da mostrare qui.</div>';
    var m = "", out = "";
    ev.forEach(function (e) {
      var mm = MESE(e.q);
      if (mm !== m) { if (m) out += '</ul>'; m = mm; out += '<div class="mese">' + E(mm) + '</div><ul class="crono">'; }
      out += '<li class="ev"><span class="ic i-' + e.t + '">' + (IC[e.t] || "•") + '</span><div><div class="ti">' + E(e.ti).replace(/(\d)\.(\d\d) €/g, "$1,$2 €") + '</div>' + (e.d ? '<div class="d">' + E(e.d) + '</div>' : '') + '</div><span class="q">' + DT(e.q, true) + '</span></li>';
    });
    return x + '<div class="card">' + out + '</ul></div>';
  }

  function tPag(c, p) {
    var att = c.in_attesa || [];
    var x = '<div class="card"><h2>Da pagare</h2>' + (att.length ? '<table><thead><tr><th>Scadenza</th><th class="num">Importo</th><th>Modo</th><th>Causale del bonifico</th></tr></thead><tbody>' +
      att.map(function (r) { return '<tr><td>' + DT(r.scadenza) + '</td><td class="num">' + EUR(r.importo) + ' + IVA</td><td>' + E(r.modo || "") + '</td><td>' + E(r.riferimento || "") + ' <button class="copia" data-copia="' + E(r.riferimento || "") + '">copia</button></td></tr>'; }).join("") + '</tbody></table>'
      : '<p class="sub">Niente da pagare.</p>') + '</div>';
    x += '<div class="card" style="margin-top:14px"><h2>Canoni</h2>' + ((p.canoni || []).length ? '<table><thead><tr><th>Periodo</th><th class="num">Persone</th><th class="num">Importo</th><th>Stato</th><th>Pagato il</th></tr></thead><tbody>' +
      p.canoni.map(function (r) { return '<tr><td>' + DT(r.dal) + ' – ' + DT(r.al) + '</td><td class="num">' + (r.persone || 0) + '</td><td class="num">' + EUR(r.importo) + '</td><td><span class="stato s-' + E(r.stato) + '">' + ({ in_attesa: "da pagare", pagato: "pagato", annullato: "annullato" }[r.stato] || E(r.stato)) + '</span> <span class="sub">' + E(r.modo || "") + '</span></td><td>' + (r.pagato_il ? DT(r.pagato_il) : '—') + '</td></tr>'; }).join("") + '</tbody></table>'
      : '<p class="sub">Nessun canone con il listino nuovo.</p>') + '</div>';
    if ((p.ritardi || []).length) x += '<div class="card" style="margin-top:14px"><h2>Ritardi</h2><table><thead><tr><th>Scadenza</th><th>Promemoria</th><th>Avviso</th><th>Sospesa</th><th>Chiusa</th><th>Riaperta</th></tr></thead><tbody>' +
      p.ritardi.map(function (r) { return '<tr><td>' + DT(r.scadenza) + '</td><td>' + DT(r.promemoria_il) + '</td><td>' + DT(r.avviso_il) + '</td><td>' + DT(r.sospesa_dal) + '</td><td>' + DT(r.chiusa_il) + '</td><td>' + DT(r.riaperta_il) + '</td></tr>'; }).join("") + '</tbody></table></div>';
    if ((p.pagamenti_vecchi || []).length) x += '<div class="card" style="margin-top:14px"><h2>Pagamenti del listino vecchio</h2><table><thead><tr><th>Tipo</th><th>Periodo</th><th class="num">Importo</th><th>Incassato</th></tr></thead><tbody>' +
      p.pagamenti_vecchi.map(function (r) { return '<tr><td>' + E(r.tipo || "") + '</td><td>' + DT(r.dal) + (r.al ? ' – ' + DT(r.al) : '') + '</td><td class="num">' + EUR(r.importo) + '</td><td>' + (r.incassato ? DT(r.incassato_il) : "no") + '</td></tr>'; }).join("") + '</tbody></table></div>';
    return x;
  }

  function tUso(c, p) {
    var v = c.voci || {}, cr = c.crediti || {}, as = c.assistenza, f = p.servizi_fermi || {};
    var perc = Math.max(0, Math.min(100, Number(v.percentuale || 0)));
    return '<div class="card"><h2>Voci del mese</h2><p class="sub">Dal ' + DT(v.dal) + ' al ' + DT(v.al) + '</p>' +
      '<div class="barra' + (perc >= 95 ? ' ro' : perc >= 80 ? ' gi' : '') + '" style="height:12px"><i style="width:' + perc + '%"></i></div>' +
      '<div class="kpi">' + k("Usate", v.voci_usate == null ? "—" : v.voci_usate) + k("Comprese", v.voci_comprese == null ? "—" : v.voci_comprese) + k("Dei pacchetti", v.voci_pacchetti || 0) +
        k("In più", v.voci_in_piu || 0, v.pacchetti_da_comprare ? v.pacchetti_da_comprare + " pacchetti da comprare" : "", v.voci_in_piu ? "gi" : "") + '</div>' +
      '<p>' + (f.fermi ? '<span class="err">Servizi fermi per voci finite' + (f.motivo ? ': ' + E(f.motivo) : '') + '</span>' : 'Nessun servizio fermo.') + '</p></div>' +
      '<div class="card" style="margin-top:14px"><h2>Crediti e assistenza</h2><div class="kpi">' +
        k("Crediti", cr.totale == null ? "—" : cr.totale, "comprati " + (cr.comprati || 0) + " · compresi " + (cr.compresi || 0)) +
        k("Scadenza crediti", cr.prossima_scadenza || "—") +
        k("Ore di assistenza", as ? Math.round((as.credito_minuti || 0) / 6) / 10 + " h" : "—", as ? "rimaste · " + (as.minuti_mese_corrente || 0) + " minuti usati nel mese" : "nessuna comprata", as && as.oltre_soglia ? "gi" : "") +
      '</div></div>';
  }

  function tPers(c, p) {
    var pc = p.contate || {};
    var x = '<div class="kpi">' + k("Persone contate", pc.persone || 0, "ultimi 30 giorni") + k("Con l'app", pc.accessi || 0) + k("Con WhatsApp", pc.numeri || 0) + '</div>' +
      '<p class="sub">Gli orari e gli accessi delle singole persone non si mostrano: servono solo alla sicurezza (informativa).</p>';
    x += '<div class="card"><h2>Accessi personali all\'app</h2>' + ((p.utenti || []).length ? '<table><thead><tr><th>Nome</th><th>Email</th><th>Ruolo</th><th class="num">Dispositivi</th></tr></thead><tbody>' +
      p.utenti.map(function (u) { return '<tr><td>' + E(u.nome) + (u.attivo ? '' : ' <span class="stato s-annullato">tolto</span>') + '</td><td><a href="mailto:' + E(u.email) + '">' + E(u.email) + '</a></td><td>' + E(u.ruolo || "") + '</td><td class="num">' + (u.dispositivi || 0) + '</td></tr>'; }).join("") + '</tbody></table>'
      : '<p class="sub">Nessuno ha ancora l\'accesso personale.</p>') + '</div>';
    if ((p.collegamenti || []).length) x += '<div class="card" style="margin-top:14px"><h2>Collegamenti condivisi</h2><table><thead><tr><th>Collegamento</th><th>Attivo</th><th>Ultimo uso</th><th class="num">Usi</th></tr></thead><tbody>' +
      p.collegamenti.map(function (u) { return '<tr><td>' + E(u.etichetta) + '</td><td>' + (u.attivo ? "sì" : "no") + '</td><td>' + DT(u.ultimo, true) + '</td><td class="num">' + (u.accessi || 0) + '</td></tr>'; }).join("") + '</tbody></table></div>';
    x += '<div class="card" style="margin-top:14px"><h2>Numeri WhatsApp</h2>' + ((p.numeri || []).length ? '<table><thead><tr><th>Nome</th><th>Telefono</th><th>Ruolo</th><th>Rapporto</th><th>Registrato il</th></tr></thead><tbody>' +
      p.numeri.map(function (u) { return '<tr><td>' + E(u.nome) + '</td><td><a href="tel:+' + E(u.telefono) + '">+' + E(u.telefono) + '</a></td><td>' + E(u.ruolo || "") + '</td><td>' + E(u.rapporto || "dipendente") + '</td><td>' + DT(u.registrato) + '</td></tr>'; }).join("") + '</tbody></table>'
      : '<p class="sub">Nessun numero.</p>') + '</div>';
    return x;
  }

  function tCant(c, p) {
    var cs = p.cantieri || [];
    if (!cs.length) return '<div class="card vuoto">Nessun cantiere.</div>';
    return '<div class="cant">' + cs.map(function (k2) {
      return '<div class="card"><b>' + E(k2.nome) + '</b><div class="sub">' + (k2.chiuso ? 'chiuso il ' + DT(k2.chiuso) : 'attivo') + (k2.inizio ? ' · dal ' + DT(k2.inizio) : '') + '</div>' +
        '<div class="kpi" style="margin:10px 0 0;grid-template-columns:1fr 1fr">' + k("Voci del mese", k2.voci_mese || 0) + k("Chi scrive", k2.chi_scrive || 0, "persone in 30 giorni") + '</div>' +
        '<div class="sub" style="margin-top:8px">Ultima voce: ' + FA(k2.ultima_voce) + '</div></div>';
    }).join("") + '</div>';
  }

  function tNote(c, p) {
    return '<div class="card"><h2>Le tue note</h2><p class="sub">Le vedi solo tu. Solo fatti sul rapporto con il cliente.</p>' +
      '<textarea id="nn" maxlength="4000" placeholder="Scrivi una nota…" aria-label="Nuova nota"></textarea><div id="nn-err" class="err"></div>' +
      '<div class="azioni" style="margin-top:8px"><button class="bt pri" data-salva-nota>Salva la nota</button></div>' +
      '<div style="margin-top:12px">' + ((p.note || []).length ? p.note.map(function (n) {
        return '<div class="nt"><div class="sub">' + DT(n.quando, true) + ' · <button class="copia" data-togli="' + n.id + '">togli</button></div><p>' + E(n.testo) + '</p></div>';
      }).join("") : '<p class="vuoto">Nessuna nota.</p>') + '</div></div>';
  }

  // ---- centrale delle email (C1, 17/11): dati di Brevo letti ogni 10 minuti dal database
  var DEST_PROB = function (e) { return e.colore === "rosso" || e.colore === "giallo"; };
  function tabellaEmail(lista, conImpresa) {
    if (!lista.length) return '<p class="vuoto">Nessuna email qui.</p>';
    return '<table><thead><tr><th>Quando</th><th>A chi</th>' + (conImpresa ? '<th>Impresa</th>' : '') + '<th>Oggetto</th><th>Destino</th></tr></thead><tbody>' +
      lista.map(function (e) {
        var det = e.motivo ? ' title="' + E(e.motivo) + '"' : '';
        var dove = e.cliccata_il ? 'cliccata ' + DT(e.cliccata_il, true) : e.aperta_il ? 'aperta ' + DT(e.aperta_il, true) : '';
        return '<tr><td style="white-space:nowrap">' + DT(e.quando, true) + '</td><td>' + (e.a ? E(e.a) : '<span class="sub">—</span>') + '</td>' +
          (conImpresa ? '<td>' + (e.azienda_id ? '<button class="copia" data-c="' + e.azienda_id + '">' + E(e.azienda || "impresa") + '</button>' : '<span class="sub">—</span>') + '</td>' : '') +
          '<td>' + E(e.oggetto || "") + '</td><td><span class="badge b-' + E(e.colore) + '"' + det + '>' + E(e.destino) + '</span>' +
          (dove ? '<div class="sub">' + dove + (e.apertura_incerta ? '' : '') + '</div>' : '') + (e.motivo ? '<div class="err">' + E(e.motivo) + '</div>' : '') + '</td></tr>';
      }).join("") + '</tbody></table>';
  }
  function paginaEmail() {
    var m = MAIL[""];
    var testa = '<div class="wrap"><button class="bt indietro" data-oggi>← Oggi</button><h1>Email</h1>';
    if (!m) { caricaMail(""); return testa + '<div class="caric"><div class="sk" style="width:60%"></div><div class="sk"></div><div class="sk" style="width:80%"></div></div></div>'; }
    if (m.esito !== "ok") return testa + '<p class="err">Non è stato possibile leggere le email. Ricarica la pagina.</p></div>';
    var pi = (m.piano || [])[0] || {}, og = m.oggi || {}, tr = m.trenta || {};
    var lim = 300, rest = pi.credits == null ? null : Number(pi.credits);
    var usate = rest == null ? (og.requests || 0) : lim - rest;
    var pc = function (a, b) { return b ? Math.round(100 * a / b) + " %" : "—"; };
    var rimb = (tr.hardBounces || 0) + (tr.softBounces || 0), male = (tr.spamReports || 0) + (tr.blocked || 0) + (tr.invalid || 0) + (tr.error || 0);
    var tutte = m.email || [];
    var q = S.eq.toLowerCase();
    var lista = tutte.filter(function (e) {
      var okf = S.ef === "tutte" || (S.ef === "problemi" && DEST_PROB(e)) || (S.ef === "aperte" && (e.aperta_il || e.cliccata_il)) || (S.ef === "nonaperte" && e.colore === "verde" && !e.aperta_il && !e.cliccata_il);
      var okq = !q || [e.a, e.oggetto, e.azienda].join(" ").toLowerCase().indexOf(q) !== -1;
      return okf && okq;
    });
    var nprob = tutte.filter(DEST_PROB).length;
    var F = [["tutte", "Tutte", tutte.length], ["problemi", "Problemi", nprob], ["aperte", "Aperte", tutte.filter(function (e) { return e.aperta_il || e.cliccata_il; }).length], ["nonaperte", "Consegnate non aperte", tutte.filter(function (e) { return e.colore === "verde" && !e.aperta_il && !e.cliccata_il; }).length]];
    var dom = m.domini || [], mit = m.mittenti || [], bl = m.bloccati || [];
    var x = testa + '<p class="sub">Da Brevo, piano ' + E(pi.type === "free" ? "Free (gratuito)" : (pi.type || "—")) + ' · aggiornato ' + DT(m.aggiornato_il, true) + ' · si aggiorna da solo ogni 10 minuti · <a href="https://app.brevo.com/" target="_blank" rel="noopener">apri Brevo</a></p>' +
      '<div class="kpi">' +
        '<div class="k' + (usate >= 270 ? ' ro' : usate >= 250 ? ' gi' : '') + '"><div class="et">Inviate oggi</div><div class="v">' + usate + ' / ' + lim + '</div><div class="barra' + (usate >= 270 ? ' ro' : usate >= 250 ? ' gi' : '') + '"><i style="width:' + Math.min(100, Math.round(100 * usate / lim)) + '%"></i></div><div class="n2">' + (rest == null ? '' : 'ne restano ' + rest + ' fino a mezzanotte') + '</div></div>' +
        k("Consegnate", pc(tr.delivered || 0, tr.requests || 0), (tr.delivered || 0) + " su " + (tr.requests || 0) + " in 30 giorni", (tr.requests && (tr.delivered || 0) < tr.requests) ? "gi" : "") +
        k("Aperte", pc(tr.uniqueOpens || 0, tr.delivered || 0), (tr.uniqueOpens || 0) + " persone hanno aperto · " + (tr.uniqueClicks || 0) + " hanno cliccato") +
        k("Rimbalzi", rimb, (tr.hardBounces || 0) + " definitivi · " + (tr.softBounces || 0) + " temporanei", tr.hardBounces ? "ro" : rimb ? "gi" : "") +
        k("Spam e blocchi", male, (tr.spamReports || 0) + " spam · " + (tr.blocked || 0) + " bloccate · " + (tr.invalid || 0) + " non valide", male ? "ro" : "") +
        k("Ferme in TIX", m.coda_tix || 0, "non ancora passate a Brevo", m.coda_tix ? "gi" : "") +
      '</div>' +
      '<div class="griglia2"><section class="card"><h2>Ogni email e il suo destino</h2>' +
        '<div class="filtri" style="padding:0 0 8px" role="group" aria-label="Filtra le email">' + F.map(function (f) {
          return '<button class="chip" data-ef="' + f[0] + '" aria-pressed="' + (S.ef === f[0]) + '">' + f[1] + '<span class="n">' + f[2] + '</span></button>';
        }).join("") +
        ' <select id="eg" aria-label="Periodo">' + [[7, "7 giorni"], [30, "30 giorni"], [90, "90 giorni"], [365, "12 mesi"]].map(function (o) { return '<option value="' + o[0] + '"' + (S.eg === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join("") + '</select></div>' +
        '<div class="cerca" style="padding:0 0 10px"><input id="eq" type="search" placeholder="Cerca per indirizzo, oggetto o impresa…" aria-label="Cerca tra le email" value="' + E(S.eq) + '"></div>' +
        tabellaEmail(lista, true) +
        '<p class="sub" style="margin-top:8px">Brevo manda le aperture senza dire chi ha aperto: TIX le abbina all\'email solo quando l\'oggetto è unico. Alcuni programmi di posta (per esempio Apple Mail) segnano «aperta» da soli.</p>' +
      '</section>' +
      '<aside class="card dati"><h2>Salute dell\'invio</h2><dl>' +
        dom.map(function (d) { return '<dt>Dominio ' + E(d.nome) + '</dt><dd>' + (d.autenticato && d.verificato ? '<span class="badge b-verde">autenticato ✓</span>' : '<span class="badge b-rosso">da sistemare</span>') + '</dd>'; }).join("") +
        '</dl><h3>Mittenti</h3><dl>' + mit.map(function (s) { return '<dt>' + E(s.email) + '</dt><dd>' + (s.active ? 'attivo' : '<span class="err">non attivo</span>') + '</dd>'; }).join("") + '</dl>' +
        '<h3>Indirizzi bloccati</h3>' + (bl.length ? '<dl>' + bl.map(function (b2) { return '<dt>' + E(b2.email) + '</dt><dd>' + E((b2.reason && (b2.reason.message || b2.reason.code)) || "bloccato") + '</dd>'; }).join("") + '</dl>' : '<p class="sub">Nessuno: tutti gli indirizzi ricevono.</p>') +
        '<h3>Liste di contatti</h3>' + ((m.liste || []).length ? '<dl>' + m.liste.map(function (l) { return '<dt>' + E(l.nome) + '</dt><dd>' + (l.iscritti || 0) + '</dd>'; }).join("") + '</dl>' : '<p class="sub">Nessuna.</p>') +
        '<h3>Modelli in Brevo</h3>' + ((m.modelli || []).length ? '<dl>' + m.modelli.map(function (t) { return '<dt>' + E(t.nome) + '</dt><dd>' + (t.attivo ? 'attivo' : 'spento') + '</dd>'; }).join("") + '</dl>' : '<p class="sub">Nessuno.</p>') +
        '<p class="sub">Campagne inviate: ' + E(m.campagne || 0) + '. Le email di TIX non usano i modelli di Brevo: i testi stanno in TIX.</p>' +
      '</aside></div></div>';
    return x;
  }
  function tMail(c) {
    var m = MAIL[c.id];
    if (!m) { caricaMail(c.id); return '<div class="caric"><div class="sk" style="width:60%"></div><div class="sk"></div></div>'; }
    if (m.esito !== "ok") return '<p class="err">Email non lette. Ricarica la pagina.</p>';
    var l = m.email || [];
    return '<div class="card"><h2>Email mandate da TIX a questa impresa</h2><p class="sub">Ultimi 12 mesi · abbinate dall\'indirizzo (titolare, impresa, persone, accessi)</p>' + tabellaEmail(l, false) + '</div>';
  }
  function caricaMail(id) {
    if (MAIL["_" + id]) return; MAIL["_" + id] = 1;
    chiama("email", id ? { azienda: id, giorni: 365 } : { giorni: S.eg }).then(function (r) { MAIL[id] = r || { esito: "servizio" }; delete MAIL["_" + id]; disegna(); });
  }

  // ---- fornitori da invitare nell'Elenco TIX (F1, 17/11). L'Elenco è della B3: qui si legge soltanto.
  var FO_ST = { da_contattare: ["Da contattare", "grigio"], invitato: ["Invitato", "giallo"], sollecitato: ["Sollecitato", "giallo"], non_interessato: ["Non interessato", "grigio"] };
  var EL_ST = { da_confermare: "Iscritto, deve confermare l'email", da_approvare: "Iscritto, da approvare", approvato: "Nell'elenco", rifiutato: "Rifiutato", nascosto: "Nascosto" };
  function foRiga(id) { return ((FO && FO.righe) || []).filter(function (r) { return String(r.id) === String(id); })[0]; }
  function foFase(r) {
    var el = r.elenco;
    if (el && el.riquadro) return ["logo", "Logo TIX sul sito ✓", "verde"];
    if (el && el.stato === "approvato") return ["iscritto", "Nell'elenco · manca il logo", "giallo"];
    if (el) return ["iscritto", EL_ST[el.stato] || el.stato, el.stato === "rifiutato" ? "rosso" : "giallo"];
    var s = FO_ST[r.stato] || [r.stato, "grigio"];
    return [r.stato === "sollecitato" ? "invitato" : r.stato, s[0], s[1]];
  }
  // testo del parere B12 (17/11): si manda solo dopo il «sì» del fornitore (telefono, di persona o richiesta sua)
  var FO_COME = { telefono: ["al telefono", "come d'accordo al telefono"], di_persona: ["di persona", "come d'accordo quando ci siamo visti"], richiesta: ["l'ha chiesto lui", "come mi ha chiesto"] };
  var FO_ORIG = ["dal vostro sito", "da un'impresa cliente di TIX", "da una telefonata", "da un incontro di persona", "da una fiera"];
  function foMailto(r) {
    var corpo = "Buongiorno" + (r.referente ? " " + r.referente : "") + ",\n" +
      (FO_COME[r.consenso_come] || FO_COME.telefono)[1] + ", le mando l'invito all'Elenco fornitori di TIX · Diario di cantiere (www.tixcantiere.it), l'app che le imprese edili usano per il diario di cantiere, i preventivi e le richieste di offerta ai fornitori.\n" +
      "Nell'elenco le imprese che usano TIX vi trovano per zona e per lavorazione e vi mandano le richieste di offerta direttamente. L'iscrizione è gratuita e richiede pochi minuti: " + (FO && FO.link || "") + "\n" +
      "L'unica condizione è pubblicare sul vostro sito il riquadro «Siamo nell'elenco fornitori di TIX», che vi mandiamo noi.\n" +
      "Il vostro indirizzo lo abbiamo " + (r.origine || "da una telefonata") + ". Se non volete ricevere altre comunicazioni da TIX, rispondete a questa email con «NO»: vi togliamo subito dalla nostra rubrica. Informativa: www.tixcantiere.it/privacy-policy\n" +
      "Cordiali saluti\nFilippo Obetti\nTIX · Diario di cantiere — info@tixcantiere.it";
    return "mailto:" + String(r.email || "").replace(/[^\w.@+-]/g, "") + "?subject=" + encodeURIComponent("Elenco fornitori di TIX: " + r.ragione_sociale) + "&body=" + encodeURIComponent(corpo);
  }
  function caricaFornitori() {
    if (caricaFornitori.v) return; caricaFornitori.v = 1;
    chiama("fornitori").then(function (r) { FO = r || { esito: "servizio" }; caricaFornitori.v = 0; disegna(); });
  }
  function paginaFornitori() {
    var testa = '<div class="wrap"><button class="bt indietro" data-oggi>← Oggi</button><h1>Fornitori TIX</h1>';
    if (!FO) { caricaFornitori(); return testa + '<div class="caric"><div class="sk" style="width:60%"></div><div class="sk"></div></div></div>'; }
    if (FO.esito !== "ok") return testa + '<p class="err">Non è stato possibile leggere i fornitori. Ricarica la pagina.</p></div>';
    var rr = FO.righe || [], el = FO.elenco || {};
    var conta = { tutti: rr.length, da_contattare: 0, invitato: 0, iscritto: 0, logo: 0, non_interessato: 0 };
    rr.forEach(function (r) { var f = foFase(r)[0]; if (conta[f] != null) conta[f]++; });
    var q = S.fq.toLowerCase();
    var lista = rr.filter(function (r) {
      var okf = S.ff === "tutti" || foFase(r)[0] === S.ff;
      var okq = !q || [r.ragione_sociale, r.categoria, r.comune, r.provincia, r.email, r.referente].join(" ").toLowerCase().indexOf(q) !== -1;
      return okf && okq;
    });
    var F = [["tutti", "Tutti"], ["da_contattare", "Da contattare"], ["invitato", "Invitati"], ["iscritto", "Iscritti"], ["logo", "Con il logo TIX"], ["non_interessato", "Non interessati"]];
    var isc = FO.iscritti || [];
    var conLogo = isc.filter(function (f) { return f.riquadro; });
    var FT = [["logo", "Con il logo TIX sul sito", conLogo.length], ["iscritti", "Iscritti all'elenco", isc.length], ["rubrica", "Da contattare", conta.da_contattare + conta.invitato]];
    var x = testa + '<p class="sub">I fornitori di materiali, i noleggi e i subappaltatori dell\'<b>Elenco fornitori di TIX</b>, dove le imprese li cercano quando chiedono un preventivo, e la tua rubrica di quelli da contattare. ' +
        'Quando un fornitore della rubrica si iscrive (stessa partita IVA o stessa email) lo stato cambia da solo. L\'approvazione si fa nei Preventivi, nel riquadro «Elenco fornitori TIX · solo per te».' +
        (FO.elenco_attivo !== "si" ? ' <span class="badge b-giallo">Elenco in prova: le imprese non lo vedono ancora</span>' : '') + '</p>' +
      (FO.email_inviti !== "si" ? '<p class="badge b-giallo" style="display:block;padding:8px 12px;margin:0 0 12px">Le email d\'invito partono dal lancio: l\'informativa sul sito non ha ancora la riga sugli inviti (B6 e B12). Telefonate e «sì» all\'invito si possono già segnare.</p>' : '') +
      '<div class="kpi">' +
        k("In rubrica", rr.length, conta.da_contattare + " da contattare") +
        k("Invitati", conta.invitato, "in attesa che si iscrivano", conta.invitato ? "gi" : "") +
        k("Iscritti all'elenco", el.iscritti || 0, (el.da_approvare || 0) + " da approvare", el.da_approvare ? "gi" : "") +
        k("Nell'elenco", el.approvati || 0, "approvati") +
        k("Con il logo TIX", el.con_riquadro || 0, "riquadro sul loro sito") +
        k("Non interessati", conta.non_interessato, "") +
      '</div>' +
      '<div class="card"><h2>Link d\'invito</h2><p class="sub">È lo stesso link che trovi nei Preventivi. Va nell\'email di invito (il pulsante «Prepara email» lo mette da solo).</p>' +
        '<dl class="dati"><dt>Link</dt><dd><span>' + E(FO.link) + '</span><button class="copia" data-copia="' + E(FO.link) + '">copia</button></dd></dl></div>' +
      '<div class="schede" role="tablist" style="margin-top:14px">' + FT.map(function (t) { return '<button class="scheda" role="tab" data-ft="' + t[0] + '" aria-selected="' + (S.ft === t[0]) + '">' + t[1] + ' <span class="n">' + t[2] + '</span></button>'; }).join("") + '</div>';
    if (S.ft !== "rubrica") {
      var lst = S.ft === "logo" ? conLogo : isc;
      var conC = lst.filter(function (f) { return f.consenso_email; });
      x += '<section class="card" style="margin-top:10px"><div class="azioni" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h2 style="margin:0">' + (S.ft === "logo" ? 'Fornitori con il logo TIX sul loro sito' : 'Tutti gli iscritti all\'Elenco') + '</h2>' +
        (FO.email_info === "si" ? '<button class="bt pri" data-fo-scrivi="' + S.ft + '"' + (conC.length ? '' : ' disabled') + '>✉ Scrivi a chi ha dato il consenso (' + conC.length + ')</button>'
          : '<span class="bt off" title="Si accende quando la pagina per non ricevere più email è online (B3)">✉ Email ai fornitori: non ancora attive</span>') + '</div>' +
        '<p class="sub">' + (S.ft === "logo" ? 'Hanno pubblicato il riquadro «Siamo nell\'elenco fornitori di TIX»: le imprese li trovano nelle richieste di offerta.' : 'Arrivano dal link d\'invito (e, quando sarà pronto, dal pulsante sul sito di TIX). Iscrivendosi accettano le regole dell\'Elenco e confermano la loro email.') + '</p>' +
        (lst.length ? '<table><thead><tr><th>Fornitore</th><th>Cosa fa</th><th>Contatti</th><th>Stato</th><th>Iscritto il</th></tr></thead><tbody>' + lst.map(function (f) {
          var vv = f.tipi || [];
          return '<tr><td><b>' + E(f.ragione_sociale) + '</b><div class="sub">' + E([f.sede, f.partita_iva && "P.IVA " + f.partita_iva].filter(Boolean).join(" · ")) + '</div>' + (f.in_rubrica ? '<div class="sub">anche nella tua rubrica</div>' : '') + '</td>' +
            '<td>' + E(f.tipo || "") + '<div class="sub">' + E(vv.slice(0, 4).join(", ") + (vv.length > 4 ? " e altre " + (vv.length - 4) : "")) + '</div>' + ((f.province || []).length ? '<div class="sub">lavora in ' + E(f.province.join(", ")) + '</div>' : '') + '</td>' +
            '<td>' + (f.email ? '<div><a href="mailto:' + E(f.email) + '">' + E(f.email) + '</a></div>' : '') + (f.telefono ? '<div><a href="tel:' + E(String(f.telefono).replace(/\s/g, "")) + '">' + E(f.telefono) + '</a></div>' : '') +
              (f.referente ? '<div class="sub">' + E(f.referente) + '</div>' : '') + (f.sito ? '<div><a href="' + E(/^https?:/i.test(f.sito) ? f.sito : "https://" + f.sito) + '" target="_blank" rel="noopener">sito</a>' + (f.riquadro_url ? ' · <a href="' + E(f.riquadro_url) + '" target="_blank" rel="noopener">pagina col logo</a>' : '') + '</div>' : '') + '</td>' +
            '<td><span class="badge b-' + (f.riquadro ? "verde" : f.stato === "approvato" ? "giallo" : f.stato === "rifiutato" ? "rosso" : "grigio") + '">' + E(f.riquadro ? "Logo TIX sul sito ✓" : f.stato === "approvato" ? "Nell'elenco · manca il logo" : (EL_ST[f.stato] || f.stato)) + '</span>' +
              (f.email_confermata_il ? '' : '<div class="sub">email non ancora confermata</div>') +
              '<div class="sub">' + (f.consenso_email ? '✉ accetta le email di TIX dal ' + DT(f.consenso_email_il) : 'non vuole email informative') + '</div></td>' +
            '<td>' + DT(f.iscritto_il) + '</td></tr>';
        }).join("") + '</tbody></table>' : '<p class="vuoto">' + (S.ft === "logo" ? 'Nessun fornitore ha ancora pubblicato il logo TIX.' : 'Ancora nessun iscritto all\'Elenco.') + '</p>') + '</section>';
      if ((FO.invii_info || []).length) x += '<section class="card" style="margin-top:14px"><h2>Email informative mandate</h2><table><thead><tr><th>Quando</th><th>Oggetto</th><th class="num">Destinatari</th></tr></thead><tbody>' +
        FO.invii_info.map(function (i) { return '<tr><td>' + DT(i.quando, true) + '</td><td>' + E(i.oggetto) + '</td><td class="num">' + (i.destinatari || 0) + '</td></tr>'; }).join("") + '</tbody></table><p class="sub">Il destino di ogni email (consegnata, aperta…) è nella pagina «Email».</p></section>';
      return x + '</div>';
    }
    x += '<section class="card" style="margin-top:10px"><div class="azioni" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h2 style="margin:0">Da contattare</h2><span>' +
        '<button class="bt pri" data-fo-nuovo>+ Aggiungi fornitore</button> <button class="bt" data-fo-importa>⇪ Importa da Excel</button></span></div>' +
        '<div class="filtri" style="padding:10px 0 8px" role="group" aria-label="Filtra i fornitori">' + F.map(function (f) {
          return '<button class="chip" data-ff="' + f[0] + '" aria-pressed="' + (S.ff === f[0]) + '">' + f[1] + '<span class="n">' + conta[f[0]] + '</span></button>';
        }).join("") + '</div>' +
        '<div class="cerca" style="padding:0 0 10px"><input id="fq" type="search" placeholder="Cerca per nome, categoria, comune, provincia, email…" aria-label="Cerca tra i fornitori" value="' + E(S.fq) + '"></div>' +
        (lista.length ? '<table><thead><tr><th>Fornitore</th><th>Contatti</th><th>Stato</th><th>Ultimo contatto</th><th>Azioni</th></tr></thead><tbody>' + lista.map(function (r) {
          var fa = foFase(r);
          return '<tr><td><b>' + E(r.ragione_sociale) + '</b><div class="sub">' + E([r.categoria, [r.comune, r.provincia && "(" + r.provincia + ")"].filter(Boolean).join(" ")].filter(Boolean).join(" · ")) + '</div>' +
              (r.note ? '<div class="sub">✎ ' + E(r.note) + '</div>' : '') + '</td>' +
            '<td>' + (r.email ? '<div>' + E(r.email) + '</div>' : '<div class="err">manca l\'email</div>') + (r.telefono ? '<div><a href="tel:' + E(String(r.telefono).replace(/\s/g, "")) + '">' + E(r.telefono) + '</a></div>' : '') +
              (r.sito ? '<div><a href="' + E(/^https?:/i.test(r.sito) ? r.sito : "https://" + r.sito) + '" target="_blank" rel="noopener">sito</a>' + (r.elenco && r.elenco.riquadro_url ? ' · <a href="' + E(r.elenco.riquadro_url) + '" target="_blank" rel="noopener">pagina col logo</a>' : '') + '</div>' : '') + '</td>' +
            '<td><span class="badge b-' + fa[2] + '">' + E(fa[1]) + '</span>' +
              (r.stato === "non_interessato" ? '<div class="sub">ha detto no il ' + DT(r.no_il) + '</div>' :
                r.consenso_il ? '<div class="sub">sì all\'invito ' + E((FO_COME[r.consenso_come] || [""])[0]) + ' il ' + DT(r.consenso_il) + '</div>' : (!r.elenco ? '<div class="sub">manca il sì all\'invito</div>' : '')) +
              (r.contatti_n ? '<div class="sub">' + r.contatti_n + (r.contatti_n === 1 ? ' contatto' : ' contatti') + '</div>' : '') + '</td>' +
            '<td>' + (r.ultimo_contatto_il ? DT(r.ultimo_contatto_il) + '<div class="sub">' + FA(r.ultimo_contatto_il) + '</div>' : '<span class="sub">mai</span>') + '</td>' +
            '<td style="white-space:nowrap">' +
              (!r.elenco && r.stato !== "non_interessato" && !r.consenso_il ? '<button class="bt pri" data-fo-mod="' + r.id + '" title="Prima chiedi per telefono o di persona se puoi mandare l\'invito, poi segna il sì">📞 Segna il sì</button> ' : '') +
              (r.email && !r.elenco && r.stato !== "non_interessato" && r.consenso_il ? (FO.email_inviti === "si"
                ? '<a class="bt pri" data-fo-mail="' + r.id + '" href="' + E(foMailto(r)) + '">✉ ' + (r.stato === "da_contattare" ? "Prepara email" : "Sollecita") + '</a> '
                : '<span class="bt off" title="Le email d\'invito partono dal lancio: l\'informativa sul sito non ha ancora la riga sugli inviti">✉ Email dal lancio</span> ') : '') +
              (!r.elenco && r.stato !== "non_interessato" ? '<button class="bt" data-fo-op="contattato" data-fo-id="' + r.id + '" title="Hai telefonato o l\'hai visto di persona">✓ Contattato</button> ' : '') +
              (r.stato !== "non_interessato" ? '<button class="bt" data-fo-mod="' + r.id + '">Modifica</button> ' : '') +
              (!r.elenco && r.stato !== "non_interessato" ? '<button class="bt" data-fo-op="non_interessato" data-fo-id="' + r.id + '">Ha detto no</button>' : '') +
              (r.stato === "non_interessato" ? '<button class="bt" data-fo-op="togli" data-fo-id="' + r.id + '">Togli</button>' : '') +
            '</td></tr>';
        }).join("") + '</tbody></table>' : '<p class="vuoto">' + (rr.length ? 'Nessun fornitore con questi filtri.' : 'La rubrica è vuota: aggiungi un fornitore o importa il tuo file Excel.') + '</p>') +
      '</section>';
    x += '<div class="card" style="margin-top:14px"><h2>Regole per gli inviti (parere della B12)</h2><ul class="motivi">' +
      '<li>Prima chiedi il permesso <b>per telefono o di persona</b>: «Le posso mandare un\'email con l\'invito all\'Elenco fornitori di TIX?». Se dice sì, clicca <b>«📞 Segna il sì»</b> e scrivi come e quando: solo allora si attiva «Prepara email».</li>' +
      '<li>Non telefonare ai numeri presi da elenchi pubblici se sono iscritti al Registro delle opposizioni; i numeri di lavoro che già conosci vanno bene.</li>' +
      '<li>Se un fornitore risponde «NO», clicca <b>«Ha detto no»</b>: restano solo nome, email e data, così non lo ricontatti.</li>' +
      '<li>Le email partono dal tuo programma di posta, una alla volta, con mittente info@tixcantiere.it. Chi resta «da contattare» per 12 mesi senza nessun contatto si cancella da solo.</li></ul></div></div>';
    return x;
  }
  function opFornitore(id, op) {
    var r = foRiga(id); if (!r) return;
    if (op === "non_interessato" && !confirm(r.ragione_sociale + " ha detto no? Restano solo nome, email e data del no, così non lo ricontatti. Gli altri dati si cancellano.")) return;
    if (op === "togli" && !confirm("Togliere " + r.ragione_sociale + " dalla rubrica?")) return;
    chiama("fornitore", { op: op, id: Number(id) }).then(function (x) {
      if (x && x.esito === "ok") { toast({ contattato: "Segnato come contattato", non_interessato: "Segnato: ha detto no", togli: "Tolto dalla rubrica" }[op] || "Fatto"); FO = null; if ($("dlg").open) $("dlg").close(); disegna(); }
      else toast("Non salvato: riprova");
    });
  }
  function schedaFornitore(r) {
    var d = $("dlg"), v = r || {};
    var cam = [["ragione_sociale", "Ragione sociale *", 200], ["categoria", "Cosa fa (materiali, ponteggi, noleggi…)", 200], ["comune", "Comune", 100], ["provincia", "Provincia (sigla)", 2],
      ["email", "Email", 200], ["telefono", "Telefono", 40], ["sito", "Sito internet", 200], ["partita_iva", "Partita IVA", 20], ["referente", "Referente", 120]];
    d.innerHTML = '<form class="dl" method="dialog"><h2>' + (r ? "Modifica " + E(r.ragione_sociale) : "Nuovo fornitore") + '</h2>' +
      cam.map(function (c) { return '<label for="fo-' + c[0] + '">' + c[1] + '</label><input id="fo-' + c[0] + '" maxlength="' + c[2] + '" value="' + E(v[c[0]] || "") + '">'; }).join("") +
      '<label for="fo-origine">Da dove viene il contatto</label><select id="fo-origine"><option value="">— scegli —</option>' +
        FO_ORIG.concat(v.origine && FO_ORIG.indexOf(v.origine) === -1 ? [v.origine] : []).map(function (o) { return '<option' + (v.origine === o ? ' selected' : '') + '>' + E(o) + '</option>'; }).join("") + '</select>' +
      '<label for="fo-note">Note (le vedi solo tu)</label><textarea id="fo-note" maxlength="2000">' + E(v.note || "") + '</textarea>' +
      '<fieldset style="margin-top:12px;border:1px solid var(--b,#3a4658);border-radius:10px;padding:10px"><legend>Sì all\'invito</legend>' +
        '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="fo-si"' + (v.consenso_il ? ' checked' : '') + ' style="width:auto"> Ha detto sì a ricevere l\'email di invito</label>' +
        '<label for="fo-come">Come</label><select id="fo-come"><option value="">— scegli —</option>' + Object.keys(FO_COME).map(function (c) { return '<option value="' + c + '"' + (v.consenso_come === c ? ' selected' : '') + '>' + FO_COME[c][0] + '</option>'; }).join("") + '</select>' +
        '<label for="fo-quando">Quando</label><input id="fo-quando" type="date" value="' + E(v.consenso_il || "") + '" max="' + new Date().toISOString().slice(0, 10) + '">' +
        '<p class="sub">Resta come prova del permesso. Senza il sì, «Prepara email» non si attiva.</p></fieldset>' +
      '<div id="fo-err" class="err"></div><div class="azioni">' + (r ? '<button class="bt" id="fo-togli" value="">Togli dalla rubrica</button>' : '') +
      '<button class="bt" value="no">Annulla</button><button class="bt pri" id="fo-ok" value="">Salva</button></div></form>';
    d.showModal();
    if (r) $("fo-togli").addEventListener("click", function (ev) { ev.preventDefault(); opFornitore(r.id, "togli"); });
    $("fo-ok").addEventListener("click", function (ev) {
      ev.preventDefault();
      var s = {}; cam.forEach(function (c) { s[c[0]] = $("fo-" + c[0]).value.trim(); }); s.note = $("fo-note").value.trim(); s.origine = $("fo-origine").value;
      document.querySelectorAll(".dl .campo-rosso").forEach(function (e) { e.classList.remove("campo-rosso"); });
      if (!s.ragione_sociale) { $("fo-ragione_sociale").classList.add("campo-rosso"); $("fo-err").textContent = "Scrivi la ragione sociale."; return; }
      if ($("fo-si").checked) {
        s.consenso_come = $("fo-come").value; s.consenso_il = $("fo-quando").value;
        if (!s.consenso_come) { $("fo-come").classList.add("campo-rosso"); $("fo-err").textContent = "Scegli come ha detto sì."; return; }
        if (!s.consenso_il) { $("fo-quando").classList.add("campo-rosso"); $("fo-err").textContent = "Scrivi quando ha detto sì."; return; }
        if (!s.origine) { $("fo-origine").classList.add("campo-rosso"); $("fo-err").textContent = "Scegli da dove viene il contatto: va scritto nell'email."; return; }
        if (!s.email) { $("fo-email").classList.add("campo-rosso"); $("fo-err").textContent = "Per mandare l'invito serve l'email."; return; }
      } else { s.consenso_come = ""; s.consenso_il = ""; }
      if (s.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) { $("fo-email").classList.add("campo-rosso"); $("fo-err").textContent = "L'email non è scritta bene."; return; }
      this.disabled = true; var bt = this;
      chiama("fornitore", { op: "salva", id: r ? r.id : null, scheda: s }).then(function (x) {
        if (x && x.esito === "ok") { d.close(); toast("Fornitore salvato"); FO = null; disegna(); return; }
        bt.disabled = false;
        if (x && x.esito === "doppio") { $("fo-err").textContent = "C'è già un fornitore con questa partita IVA o questa email."; return; }
        if (x && x.esito === "no_detto") { $("fo-err").textContent = "Questo fornitore ha detto no: non si modifica."; return; }
        if (x && /^consenso_/.test(x.campo || "")) { var cc = $(x.campo === "consenso_come" ? "fo-come" : "fo-quando"); if (cc) cc.classList.add("campo-rosso"); $("fo-err").textContent = "Controlla come e quando ha detto sì (la data non può essere nel futuro)."; return; }
        if (x && x.campo) { var c = $("fo-" + x.campo); if (c) c.classList.add("campo-rosso"); $("fo-err").textContent = x.campo === "email" ? "L'email non è scritta bene." : "Manca un dato obbligatorio."; return; }
        $("fo-err").textContent = "Non salvato: riprova.";
      });
    });
  }
  // email informativa agli iscritti con il consenso: la decide Filippo (finestra + conferma), una volta sola
  function scriviFornitori(lista) {
    var isc = (FO && FO.iscritti) || [];
    var dest = isc.filter(function (f) { return f.consenso_email && (lista !== "logo" || f.riquadro); });
    if (!dest.length) return;
    var d = $("dlg");
    var nonce = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(16)), function (b2) { return ("0" + b2.toString(16)).slice(-2); }).join("");
    d.innerHTML = '<form class="dl" method="dialog"><h2>Email ai fornitori</h2>' +
      '<p class="sub">Parte da info@tixcantiere.it solo ai fornitori che hanno accettato le email di TIX. In fondo TIX aggiunge da sola il link per non riceverne più e quello all\'informativa.</p>' +
      '<label>Destinatari</label><div style="max-height:160px;overflow:auto;border:1px solid var(--b,#3a4658);border-radius:8px;padding:6px 10px">' +
        dest.map(function (f) { return '<label style="display:flex;gap:8px;align-items:center;margin:4px 0"><input type="checkbox" class="fo-dest" value="' + E(f.id) + '" checked style="width:auto"> ' + E(f.ragione_sociale) + ' <span class="sub">' + E(f.email || "") + '</span></label>'; }).join("") + '</div>' +
      '<label for="fs-ogg">Oggetto</label><input id="fs-ogg" maxlength="150" placeholder="Per esempio: Novità dall\'Elenco fornitori di TIX">' +
      '<label for="fs-txt">Testo</label><textarea id="fs-txt" maxlength="6000" style="min-height:200px" placeholder="Buongiorno,&#10;…"></textarea>' +
      '<p class="sub">Solo informazioni sull\'Elenco e su TIX. Niente prezzi o offerte senza averlo chiesto alla B12.</p>' +
      '<div id="fs-err" class="err"></div><div class="azioni"><button class="bt" value="no">Annulla</button><button class="bt pri" id="fs-ok" value="">Manda</button></div></form>';
    d.showModal();
    $("fs-ok").addEventListener("click", function (ev) {
      ev.preventDefault();
      var ids = Array.prototype.map.call(document.querySelectorAll(".fo-dest:checked"), function (c) { return c.value; });
      var og = $("fs-ogg").value.trim(), tx = $("fs-txt").value.trim();
      document.querySelectorAll(".dl .campo-rosso").forEach(function (e) { e.classList.remove("campo-rosso"); });
      if (!ids.length) { $("fs-err").textContent = "Scegli almeno un destinatario."; return; }
      if (!og) { $("fs-ogg").classList.add("campo-rosso"); $("fs-err").textContent = "Scrivi l'oggetto."; return; }
      if (!tx) { $("fs-txt").classList.add("campo-rosso"); $("fs-err").textContent = "Scrivi il testo."; return; }
      if (!confirm("Confermi? Mandi l'email «" + og + "» a " + ids.length + (ids.length === 1 ? " fornitore." : " fornitori."))) return;
      this.disabled = true; var bt = this;
      chiama("fornitori_scrivi", { ids: ids, oggetto: og, testo: tx, nonce: nonce }).then(function (r) {
        if (r && (r.esito === "ok" || r.esito === "gia_fatto")) { d.close(); toast(r.esito === "ok" ? "Email in partenza a " + r.destinatari + (r.destinatari === 1 ? " fornitore" : " fornitori") : "Già mandata"); FO = null; disegna(); return; }
        bt.disabled = false;
        $("fs-err").textContent = ({ spento: "Le email ai fornitori non sono ancora attive.", limite: "Troppe email per oggi (limite di Brevo): riprova domani o con meno destinatari.", nessuno: "Nessuno dei destinatari ha il consenso." }[r && r.esito]) || "Non mandata: riprova.";
      });
    });
  }
  function importaFornitori() {
    var d = $("dlg");
    var COL = ["ragione_sociale", "email", "telefono", "comune", "provincia", "categoria", "sito", "partita_iva", "referente"];
    d.innerHTML = '<form class="dl" method="dialog"><h2>Importa fornitori da Excel</h2>' +
      '<p class="sub">In Excel seleziona le righe (anche con la riga dei titoli), copia con Ctrl + C e incolla qui con Ctrl + V. Colonne in quest\'ordine: <b>Ragione sociale, Email, Telefono, Comune, Provincia, Categoria, Sito, Partita IVA, Referente</b>. Le colonne mancanti si lasciano vuote. I doppi (stessa partita IVA, stessa email o stesso nome) si saltano.</p>' +
      '<textarea id="fo-imp" style="min-height:180px" placeholder="Incolla qui le righe copiate da Excel…"></textarea><div id="fo-anteprima" class="sub"></div>' +
      '<label for="fo-imp-orig">Da dove vengono questi contatti</label><select id="fo-imp-orig"><option value="">— scegli —</option>' + FO_ORIG.map(function (o) { return '<option>' + E(o) + '</option>'; }).join("") + '</select>' +
      '<p class="sub">Il «sì all\'invito» non si importa: lo segni fornitore per fornitore dopo la telefonata.</p><div id="fo-err" class="err"></div>' +
      '<div class="azioni"><button class="bt" value="no">Annulla</button><button class="bt pri" id="fo-imp-ok" value="">Importa</button></div></form>';
    d.showModal();
    var leggi = function () {
      var testo = $("fo-imp").value.replace(/\r/g, "");
      return testo.split("\n").map(function (l) { return l.split(l.indexOf("\t") !== -1 ? "\t" : ";"); })
        .filter(function (c) { return c.join("").trim() && !/^ragione|^nome|^azienda|^fornitore/i.test(String(c[0]).trim()); })
        .map(function (c) { var o = {}; COL.forEach(function (k2, i) { o[k2] = String(c[i] == null ? "" : c[i]).trim(); }); return o; });
    };
    $("fo-imp").addEventListener("input", function () { var n = leggi().length; $("fo-anteprima").textContent = n ? n + (n === 1 ? " riga pronta" : " righe pronte") + " da importare." : ""; });
    $("fo-imp-ok").addEventListener("click", function (ev) {
      ev.preventDefault();
      var righe = leggi();
      if (!righe.length) { $("fo-imp").classList.add("campo-rosso"); $("fo-err").textContent = "Incolla almeno una riga con la ragione sociale."; return; }
      if (righe.length > 2000) { $("fo-err").textContent = "Al massimo 2.000 righe per volta."; return; }
      this.disabled = true; var bt = this;
      chiama("fornitore", { op: "importa", righe: righe, origine: $("fo-imp-orig").value }).then(function (x) {
        if (x && x.esito === "ok") { d.close(); toast("Importati " + x.nuovi + (x.doppi ? " · " + x.doppi + " doppi saltati" : "")); FO = null; disegna(); return; }
        bt.disabled = false; $("fo-err").textContent = "Importazione non riuscita: riprova.";
      });
    });
  }

  // ---- regalo di crediti (finestra con conferma)
  function regala() {
    var c = cliente(S.c); if (!c) return;
    var d = $("dlg");
    // codice unico di questa finestra: anche con due clic o un invio ripetuto il regalo si fa una volta sola
    var nonce = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(16)), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    d.innerHTML = '<form class="dl" method="dialog"><h2>Regala crediti a ' + E(c.nome) + '</h2>' +
      '<p class="sub">I crediti valgono 12 mesi. L\'impresa vede la descrizione nei «Movimenti dei crediti».</p>' +
      '<label for="rg-n">Quanti crediti (da 1 a 50)</label><input id="rg-n" type="number" min="1" max="50" value="1">' +
      '<label for="rg-d">Descrizione</label><input id="rg-d" type="text" maxlength="200" value="Crediti in regalo da TIX">' +
      '<div id="rg-err" class="err"></div><div class="azioni"><button class="bt" value="no">Annulla</button><button class="bt ar" id="rg-ok" value="">Regala</button></div></form>';
    d.showModal();
    $("rg-ok").addEventListener("click", function (ev) {
      ev.preventDefault();
      var n = Number($("rg-n").value), de = $("rg-d").value.trim();
      if (!(n >= 1 && n <= 50 && Math.floor(n) === n)) { $("rg-n").classList.add("campo-rosso"); $("rg-err").textContent = "Scrivi un numero intero da 1 a 50."; return; }
      if (!confirm("Confermi? Regali " + n + " credit" + (n === 1 ? "o" : "i") + " a " + c.nome + ".")) return;
      this.disabled = true;
      chiama("regala_crediti", { azienda: c.id, n: n, descrizione: de, nonce: nonce }).then(function (r) {
        if (r && r.esito === "ok") { d.close(); toast("Regalati " + n + " crediti a " + c.nome); ricarica(true); return; }
        $("rg-ok").disabled = false; $("rg-err").textContent = "Regalo non fatto: " + (r && r.messaggio ? r.messaggio : "riprova") + ".";
      });
    });
  }

  // dati di fatturazione dell'impresa (accordo B11): stessi controlli del modulo d'attivazione, campo sbagliato in rosso
  function fatturazione() {
    var c = cliente(S.c), p = CACHE[S.c]; if (!c || !p) return;
    var a = p.anagrafica || {}, d = $("dlg");
    var CAMPI = [["nome_completo", "Ragione sociale *", a.nome_completo], ["partita_iva", "Partita IVA *", a.partita_iva], ["codice_fiscale", "Codice fiscale", a.codice_fiscale],
      ["codice_sdi", "Codice SDI (7 caratteri)", a.sdi], ["pec", "PEC", a.pec], ["indirizzo_sede", "Indirizzo della sede", a.sede_via], ["cap", "CAP", a.cap], ["citta", "Città", a.citta],
      ["provincia", "Provincia (sigla)", a.provincia], ["email_impresa", "Email dell'impresa", a.email_impresa], ["telefono", "Telefono", a.telefono],
      ["referente_nome", "Titolare o referente", a.titolare], ["referente_email", "Email del titolare", a.titolare_email], ["referente_telefono", "Telefono del titolare", a.titolare_telefono]];
    d.innerHTML = '<form class="dl" method="dialog"><h2>Dati di fatturazione di ' + E(c.nome) + '</h2>' +
      '<p class="sub">Servono per le fatture di TIX. Obbligatori: ragione sociale, partita IVA e almeno uno tra codice SDI e PEC. Le fatture già emesse non cambiano.</p>' +
      CAMPI.map(function (f) { return '<label for="ft-' + f[0] + '">' + f[1] + '</label><input id="ft-' + f[0] + '" maxlength="200" value="' + E(f[2] || "") + '"' + (!f[2] && /\*/.test(f[1]) ? ' class="campo-rosso"' : '') + '>'; }).join("") +
      '<div id="ft-err" class="err"></div><div class="azioni"><button class="bt" value="no">Annulla</button><button class="bt pri" id="ft-ok" value="">Salva</button></div></form>';
    d.showModal();
    $("ft-ok").addEventListener("click", function (ev) {
      ev.preventDefault();
      var s = {}; CAMPI.forEach(function (f) { s[f[0]] = $("ft-" + f[0]).value.trim(); });
      document.querySelectorAll(".dl .campo-rosso").forEach(function (e) { e.classList.remove("campo-rosso"); });
      this.disabled = true; var bt = this;
      chiama("fatturazione", { azienda: c.id, scheda: s }).then(function (r) {
        if (r && r.esito === "ok") { d.close(); toast("Dati di fatturazione salvati"); delete CACHE[S.c]; ricarica(true); return; }
        bt.disabled = false;
        if (r && r.esito === "campo") { var x = $("ft-" + r.campo); if (x) { x.classList.add("campo-rosso"); x.focus(); } $("ft-err").textContent = r.messaggio || "Controlla il campo in rosso."; return; }
        $("ft-err").textContent = "Non salvato: riprova.";
      });
    });
  }

  function copia(t) {
    try { navigator.clipboard.writeText(t).then(function () { toast("Copiato"); }, function () { toast("Non copiato"); }); } catch (e) { toast("Non copiato"); }
  }
  function copiaTutto() {
    var p = CACHE[S.c], a = (p && p.anagrafica) || {};
    var t = [a.nome_completo, a.indirizzo, a.partita_iva && "P.IVA " + a.partita_iva, a.codice_fiscale && "C.F. " + a.codice_fiscale, a.sdi && "SDI " + a.sdi, a.pec && "PEC " + a.pec,
      a.titolare && "Titolare " + a.titolare, a.titolare_email, a.titolare_telefono].filter(Boolean).join("\n");
    copia(t || "");
  }

  // ---- disegno e dati
  function disegna() {
    var a = $("app");
    a.className = "app" + (S.c || S.p ? " dentro" : "");
    var ae0 = document.activeElement, fid = ae0 && (ae0.id === "q" || ae0.id === "eq" || ae0.id === "fq") ? ae0.id : "";
    a.innerHTML = '<aside class="lato">' + lato() + '</aside><main class="corpo" id="corpo">' + (S.c ? paginaCliente() : S.p === "email" ? paginaEmail() : S.p === "fornitori" ? paginaFornitori() : oggi()) + '</main>';
    if (fid && $(fid)) { var q = $(fid); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    document.title = (S.c && cliente(S.c) ? cliente(S.c).nome + " - " : S.p === "email" ? "Email - " : S.p === "fornitori" ? "Fornitori - " : "") + "Pannello di TIX";
    if (S.c && !CACHE[S.c]) carica(S.c);
  }
  function carica(id) {
    chiama("impresa", { azienda: id }).then(function (r) { CACHE[id] = r || { esito: "servizio" }; if (r && r.riga) aggiornaRiga(r.riga); if (S.c === id) disegna(); });
  }
  function aggiornaRiga(r) { (D.clienti || []).forEach(function (c, i) { if (c.id === r.id) D.clienti[i] = r; }); }
  function ricarica(anche) {
    chiama("dati").then(function (r) {
      if (r && r.esito === "ok") D = r;
      if (anche && S.c) { delete CACHE[S.c]; }
      MAIL = {};
      // l'aggiornamento automatico non ridisegna mentre Filippo scrive o ha una finestra aperta
      var ae = document.activeElement, scrive = ae && (ae.tagName === "TEXTAREA" || (ae.tagName === "INPUT" && ae.id !== "q"));
      if (anche || (!scrive && !$("dlg").open && !($("nn") && $("nn").value))) disegna();
    });
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button,a") : null; if (!b) return;
    if (b.hasAttribute("data-c")) { vai(b.getAttribute("data-c"), "crono"); var co = $("corpo"); if (co) co.scrollTop = 0; window.scrollTo(0, 0); return; }
    if (b.hasAttribute("data-oggi")) { vai("", ""); return; }
    if (b.hasAttribute("data-pag")) { vai("", "", b.getAttribute("data-pag")); return; }
    if (b.hasAttribute("data-ef")) { S.ef = b.getAttribute("data-ef"); disegna(); return; }
    if (b.hasAttribute("data-ff")) { S.ff = b.getAttribute("data-ff"); disegna(); return; }
    if (b.hasAttribute("data-ft")) { S.ft = b.getAttribute("data-ft"); disegna(); return; }
    if (b.hasAttribute("data-fo-scrivi")) { scriviFornitori(b.getAttribute("data-fo-scrivi")); return; }
    if (b.hasAttribute("data-fo-nuovo")) { schedaFornitore(null); return; }
    if (b.hasAttribute("data-fo-importa")) { importaFornitori(); return; }
    if (b.hasAttribute("data-fo-mod")) { schedaFornitore(foRiga(b.getAttribute("data-fo-mod"))); return; }
    if (b.hasAttribute("data-fo-op")) { opFornitore(b.getAttribute("data-fo-id"), b.getAttribute("data-fo-op")); return; }
    if (b.hasAttribute("data-fo-mail")) { var fr = foRiga(b.getAttribute("data-fo-mail")); setTimeout(function () { if (fr && fr.stato !== "non_interessato" && confirm("Hai mandato l'email a " + fr.ragione_sociale + "? Se sì, la segno come contattata.")) opFornitore(fr.id, "contattato"); }, 1500); return; }
    if (b.hasAttribute("data-f")) { S.f = b.getAttribute("data-f"); disegna(); return; }
    if (b.hasAttribute("data-cf")) { S.cf = b.getAttribute("data-cf"); disegna(); return; }
    if (b.hasAttribute("data-tab")) { var fu = b.hasAttribute("data-fuoco"); vai(S.c, b.getAttribute("data-tab")); if (fu) setTimeout(function () { var n = $("nn"); if (n) n.focus(); }, 60); return; }
    if (b.hasAttribute("data-regala")) { regala(); return; }
    if (b.hasAttribute("data-fatt")) { fatturazione(); return; }
    if (b.hasAttribute("data-copia")) { copia(b.getAttribute("data-copia")); return; }
    if (b.hasAttribute("data-copia-tutto")) { copiaTutto(); return; }
    if (b.hasAttribute("data-salva-nota")) {
      var n = $("nn"); if (!n.value.trim()) { n.classList.add("campo-rosso"); $("nn-err").textContent = "Scrivi la nota prima di salvarla."; n.focus(); return; }
      b.disabled = true;
      chiama("nota", { azienda: S.c, testo: n.value }).then(function (r) { if (r && r.esito === "ok") { toast("Nota salvata"); delete CACHE[S.c]; disegna(); } else { b.disabled = false; $("nn-err").textContent = "Nota non salvata: riprova."; } });
      return;
    }
    if (b.hasAttribute("data-togli")) {
      if (!confirm("Togliere questa nota?")) return;
      chiama("nota", { azienda: S.c, togli: b.getAttribute("data-togli") }).then(function (r) { if (r && r.esito === "ok") { toast("Nota tolta"); delete CACHE[S.c]; disegna(); } else toast("Nota non tolta"); });
    }
  });
  document.addEventListener("input", function (ev) {
    if (ev.target && ev.target.id === "q") { S.q = ev.target.value; disegna(); }
    if (ev.target && ev.target.id === "eq") { S.eq = ev.target.value; disegna(); }
    if (ev.target && ev.target.id === "fq") { S.fq = ev.target.value; disegna(); }
  });
  document.addEventListener("change", function (ev) {
    if (ev.target && ev.target.id === "eg") { S.eg = Number(ev.target.value) || 30; delete MAIL[""]; disegna(); }
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "/" && document.activeElement && ["INPUT", "TEXTAREA"].indexOf(document.activeElement.tagName) === -1) { ev.preventDefault(); var q = $("q"); if (q) q.focus(); }
  });
  window.addEventListener("hashchange", function () { leggiHash(); disegna(); });
  if (C.apri && !location.hash) location.hash = "#c=" + C.apri;
  leggiHash(); disegna();
  setInterval(function () { if (document.visibilityState === "visible") ricarica(false); }, 300000);
}
