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
    '<p class="piede"><a href="' + base + '/?esci">Entra con email e password</a> &nbsp;·&nbsp; <a href="' + base + '/">&larr; Torna ai cantieri</a></p>'), { status: 200, headers: intestazioni() });

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
    if (!az) return j({ esito: "nontrovata" }, 400);
    if (b.azione === "impresa") return j((await rpc(env, "pannello_impresa", { p_token: tok, p_disp: disp, p_az: az })) || { esito: "servizio" });
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
    const casa = JSON.stringify(base + "/").replace(/</g, "\\u003c");
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
    '<style>' + STILE + '</style></head><body><div id="app" class="app" aria-live="polite"></div>' +
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
function app() {
  var C = JSON.parse(document.getElementById("cfg").textContent);
  var D = C.dati, CACHE = {}, S = { c: "", tab: "crono", f: "tutti", q: "", cf: "tutto" };
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
  var TABS = [["crono", "Cronologia"], ["pag", "Pagamenti"], ["uso", "Uso"], ["pers", "Persone e numeri"], ["cant", "Cantieri"], ["note", "Note"]];

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
  }
  function vai(c, tab) {
    var h = c ? "#c=" + c + (tab && tab !== "crono" ? "&s=" + tab : "") : "#";
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
      '<button class="voceoggi" data-oggi' + (S.c ? '' : ' aria-current="page"') + '>☀ Oggi</button>' +
      '<div class="cerca"><input id="q" type="search" placeholder="Cerca un cliente…" aria-label="Cerca un cliente" value="' + E(S.q) + '"></div>' +
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
    x += '<div class="griglia2"><div>' + ({ crono: tCrono, pag: tPag, uso: tUso, pers: tPers, cant: tCant, note: tNote }[S.tab])(c, p) + '</div>' + colonnaDati(c, p) + '</div></div>';
    return x;
  }

  function colonnaDati(c, p) {
    var a = p.anagrafica || {};
    var r = function (et, v, tipo) {
      if (!v) return '<dt>' + et + '</dt><dd><span class="sub">—</span></dd>';
      var vis = tipo === "mail" ? '<a href="mailto:' + E(v) + '">' + E(v) + '</a>' : tipo === "tel" ? '<a href="tel:' + E(String(v).replace(/\s/g, "")) + '">' + E(v) + '</a>' : E(v);
      return '<dt>' + et + '</dt><dd><span>' + vis + '</span><button class="copia" data-copia="' + E(v) + '" aria-label="Copia ' + et + '">copia</button></dd>';
    };
    return '<aside class="card dati"><h2>Dati dell\'impresa</h2><dl>' +
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
    a.className = "app" + (S.c ? " dentro" : "");
    var su = $("q") && document.activeElement === $("q");
    a.innerHTML = '<aside class="lato">' + lato() + '</aside><main class="corpo" id="corpo">' + (S.c ? paginaCliente() : oggi()) + '</main>';
    if (su) { var q = $("q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    document.title = (S.c && cliente(S.c) ? cliente(S.c).nome + " - " : "") + "Pannello di TIX";
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
      // l'aggiornamento automatico non ridisegna mentre Filippo scrive o ha una finestra aperta
      var ae = document.activeElement, scrive = ae && (ae.tagName === "TEXTAREA" || (ae.tagName === "INPUT" && ae.id !== "q"));
      if (anche || (!scrive && !$("dlg").open && !($("nn") && $("nn").value))) disegna();
    });
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button,a") : null; if (!b) return;
    if (b.hasAttribute("data-c")) { vai(b.getAttribute("data-c"), "crono"); var co = $("corpo"); if (co) co.scrollTop = 0; window.scrollTo(0, 0); return; }
    if (b.hasAttribute("data-oggi")) { vai("", ""); return; }
    if (b.hasAttribute("data-f")) { S.f = b.getAttribute("data-f"); disegna(); return; }
    if (b.hasAttribute("data-cf")) { S.cf = b.getAttribute("data-cf"); disegna(); return; }
    if (b.hasAttribute("data-tab")) { var fu = b.hasAttribute("data-fuoco"); vai(S.c, b.getAttribute("data-tab")); if (fu) setTimeout(function () { var n = $("nn"); if (n) n.focus(); }, 60); return; }
    if (b.hasAttribute("data-regala")) { regala(); return; }
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
  document.addEventListener("input", function (ev) { if (ev.target && ev.target.id === "q") { S.q = ev.target.value; disegna(); } });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "/" && document.activeElement && ["INPUT", "TEXTAREA"].indexOf(document.activeElement.tagName) === -1) { ev.preventDefault(); var q = $("q"); if (q) q.focus(); }
  });
  window.addEventListener("hashchange", function () { leggiHash(); disegna(); });
  if (C.apri && !location.hash) location.hash = "#c=" + C.apri;
  leggiHash(); disegna();
  setInterval(function () { if (document.visibilityState === "visible") ricarica(false); }, 300000);
}
