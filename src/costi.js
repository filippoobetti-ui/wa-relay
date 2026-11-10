// ============================================================================
// COSTI E MARGINE DEL CANTIERE — area riservata (10/11/2026, costi-1, fase MG1). Scelte di Filippo del 10/11/2026 (piano
// Strumenti/restyling-tix/costi-margine/01-piano.md): quanto ha speso il cantiere, quanto ha maturato con l'ultimo SAL e quanto
// resta (margine «al SAL»), con i costi dopo il SAL a parte, il previsto a fine lavori, le spese generali in una riga a parte e la
// soglia del margine. Costi: manodopera (ore ENTRO/ESCO × costo orario per qualifica), mezzi propri (uso × costo interno),
// subappalti (contabilità dei sub della chat SAL) e costi scritti a mano. Tutti i conti li fa il database (costi_contesto).
// La vedono SOLO le persone dell'impresa con l'accesso all'app (gettoni di dashboard_accessi, mai l'Area professionisti, mai i
// link dei subappaltatori, mai WhatsApp), come le Offerte.
//   GET  /costi?t=<gettone>&c=<cantiere>   → pagina del cantiere (database: costi_contesto)
//   GET  /costi?t=<gettone>                → riepilogo di tutti i cantieri dell'impresa (database: costi_riepilogo)
//   POST /costi/azione   {t, c, azione: "costo_impresa" | "costo_mezzo" | "manuale_salva" | "manuale_togli", dati}
// Interruttori: impostazioni.costi_margine_attiva (no / prova = solo l'accesso «Tutte le aziende» / si) e COSTI = "off".
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AZIONI = ["costo_impresa", "costo_mezzo", "manuale_salva", "manuale_togli"];
const VOCI = [
  ["manodopera_operaio_comune", "Operaio comune", "€/ora"],
  ["manodopera_operaio_qualificato", "Operaio qualificato", "€/ora"],
  ["manodopera_operaio_specializzato", "Operaio specializzato", "€/ora"],
  ["manodopera_quarto_livello", "4° livello (capo squadra)", "€/ora"],
  ["spese_generali_pct", "Spese generali", "% dei costi"],
  ["soglia_margine_pct", "Soglia di avviso del margine", "%"]
];
const CATEGORIE = [
  ["materiali", "Materiali"], ["noli", "Noli e mezzi a noleggio"], ["manodopera_esterna", "Manodopera esterna (autonomi, agenzia)"],
  ["subappalti", "Subappalti fuori da TIX"], ["trasporti", "Trasporti"], ["smaltimenti", "Smaltimenti"], ["altro", "Altro"]
];
const UNITA = { ora: "ora", giorno: "giorno", mezza_giornata: "mezza giornata" };

function supabaseUrl(env) { return env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co"; }
function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: {
    "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
function lista(a) { return Array.isArray(a) ? a : []; }
function ogg(o) { return o && typeof o === "object" && !Array.isArray(o) ? o : {}; }
function testo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function parametri(inUrl) {
  const s = inUrl.searchParams;
  const m = String(s.get("t") || "").match(/[0-9a-fA-F]{64}/);
  const c = String(s.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  return { tok: m ? m[0].toLowerCase() : "", c };
}
function dataIso(x) { const s = String(x || "").trim(); return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) ? s : ""; }
function dataIt(iso) { return /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(String(iso || "")) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : ""; }
function n(x) { if (x === null || x === undefined || x === "") return null; const v = Number(x); return Number.isFinite(v) ? v : null; }
function cifre(v, dec) {
  const s = Math.abs(v).toFixed(dec);
  const [i, d] = s.split(".");
  return (v < 0 ? "−" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (d ? "," + d : "");
}
function euro(x) { const v = n(x); return v === null ? "—" : cifre(v, 2) + " €"; }
function euroTondo(x) { const v = n(x); return v === null ? "—" : cifre(Math.round(v), 0) + " €"; }
function pct(x) { const v = n(x); return v === null ? "—" : cifre(v, 1) + "%"; }
function ore(x) { const v = n(x); if (v === null) return "—"; return (Number.isInteger(v) ? cifre(v, 0) : cifre(v, 1)) + (v === 1 ? " ora" : " ore"); }
function valoreIt(x) { const v = n(x); if (v === null) return ""; return String(Math.round(v * 100) / 100).replace(".", ","); }
function puliscoDati(a, x) {
  const t = (k, m) => testo(x[k], m);
  if (a === "costo_impresa") return { voce: t("voce", 60), valore: t("valore", 20), valido_dal: dataIso(x.valido_dal), autore: t("autore", 120) };
  if (a === "costo_mezzo") return { mezzo_id: UUID.test(String(x.mezzo_id || "")) ? String(x.mezzo_id) : "", costo: t("costo", 20), valido_dal: dataIso(x.valido_dal), autore: t("autore", 120) };
  if (a === "manuale_salva") return { id: UUID.test(String(x.id || "")) ? String(x.id) : "", data: dataIso(x.data), categoria: t("categoria", 30),
    fornitore: t("fornitore", 120), descrizione: t("descrizione", 300), numero: t("numero", 60), importo: t("importo", 20), autore: t("autore", 120) };
  return { id: UUID.test(String(x.id || "")) ? String(x.id) : "", motivo: t("motivo", 300), autore: t("autore", 120) };
}

// ---------------------------------------------------------------------------- pulsanti
async function chiama(env, nome, corpo) {
  if (!env || !env.SUPABASE_SERVICE_KEY || env.COSTI === "off") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(supabaseUrl(env) + "/rest/v1/rpc/" + nome, {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpo), signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === "object" && j.esito === "ok" && j.attiva === true ? { attiva: true, modo: String(j.modo || "") } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
// Chiamate fatte da index.js insieme a dashboard_html: qualsiasi errore o attesa oltre 8 secondi = nessun pulsante.
export function costiPulsante(env, token, commessa) { return chiama(env, "costi_pulsante", { p_token: token, p_commessa: commessa }); }
export function costiImpresaPulsante(env, token) { return chiama(env, "costi_impresa_pulsante", { p_token: token }); }

const ICONA = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/></svg>';

// Ultimo pulsante della riga del cantiere: subito dopo «Subappaltatori» (chat SAL), altrimenti dopo «Offerte» (o Costruttivi /
// Progetti). index.js mette questo script DOPO quelli di Subappaltatori e Offerte nella catena: a ogni giro si rimette dopo di loro.
// Da solo, se la riga non c'è, va in una barra sotto le schede. Con dieci pulsanti: classe gl-az10 (accordo con la chat SAL).
export function costiIniezione(base, token, commessa) {
  const u = base + "/costi?t=" + token + "&c=" + encodeURIComponent(commessa);
  const etichetta = ICONA + " Costi e margine";
  return "<style>.gl-cm-barra{max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right}" +
    ".gl-cm-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 16px;border:1.5px solid #0F766E;border-radius:10px;background:#E6F4F2;color:#0B4F4A;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none;box-shadow:0 0 0 3px rgba(15,118,110,.14)}" +
    ".gl-cm-b:hover,.gl-cm-b:focus-visible{background:#0F766E;color:#fff;outline:none}" +
    ".gl-sb-barra .gl-cm-b,.gl-of-barra .gl-cm-b,.gl-cs-barra .gl-cm-b,.gl-pg-barra .gl-cm-b,.gl-cm-barra .gl-of-b{margin-left:8px}" +
    // con nove pulsanti: 3 colonne sul computer (tre righe); con dieci: 5 colonne (due righe); 2 fino a 900 px, 1 sul telefono
    ".gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9{grid-template-columns:repeat(3,minmax(0,1fr))}" +
    ".gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9.gl-az10{grid-template-columns:repeat(5,minmax(0,1fr))}" +
    "@media (max-width:900px){.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9,.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9.gl-az10{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
    "@media (max-width:640px){.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9,.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9.gl-az10{grid-template-columns:minmax(0,1fr)}}" +
    "@media (prefers-color-scheme:dark){.gl-cm-b{background:#12302d;color:#cdeee9;border-color:#3FB3A6}}</style>" +
    "<script>(function(){try{var a=document.createElement('a');a.className='gl-cm-b';a.href=" + JSON.stringify(u) + ";a.innerHTML=" + JSON.stringify(etichetta) + ";" +
    "function metti(){var r=document.querySelector('.gl-azioni');" +
    "if(r){var prima=r.querySelector('.gl-sb-b')||r.querySelector('.gl-of-b')||r.querySelector('.gl-cs-b')||r.querySelector('.gl-pg-b');if(prima){if(prima.nextElementSibling!==a)r.insertBefore(a,prima.nextSibling);}else if(r.lastElementChild!==a)r.appendChild(a);" +
    "var v=document.querySelector('.gl-cm-barra');if(v&&!v.children.length&&v.parentNode)v.parentNode.removeChild(v);" +
    "var k=r.children.length;r.classList.toggle('gl-az4',k===4);r.classList.toggle('gl-az5',k>=5);r.classList.toggle('gl-az6',k>=6);r.classList.toggle('gl-az7',k>=7);r.classList.toggle('gl-az8',k>=8);r.classList.toggle('gl-az9',k>=9);r.classList.toggle('gl-az10',k>=10);return;}" +
    "var pb=document.querySelector('.gl-sb-barra')||document.querySelector('.gl-of-barra')||document.querySelector('.gl-cs-barra')||document.querySelector('.gl-pg-barra');if(pb){if(pb.lastElementChild!==a)pb.appendChild(a);return;}" +
    "if(a.parentNode)return;var b=document.createElement('div');b.className='gl-cm-barra';b.appendChild(a);var nav=document.querySelector('nav.schede');" +
    "if(nav&&nav.parentNode){nav.parentNode.insertBefore(b,nav.nextSibling);}else{document.body.insertBefore(b,document.body.firstChild);}}" +
    "metti();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',metti);setTimeout(metti,0);setTimeout(metti,60);setTimeout(metti,150);setTimeout(metti,400);" +
    "window.addEventListener('load',metti);}catch(e){}})();</script>";
}

// Nell'elenco dei cantieri: una barra con «Costi e margine di tutti i cantieri», subito sotto i servizi dell'impresa.
export function costiImpresaIniezione(base, token) {
  const u = base + "/costi?t=" + token;
  return "<style>.gl-cmi{max-width:960px;margin:10px auto 0;padding:0 12px;display:flex;justify-content:flex-end}" +
    ".gl-cmi a{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:0 16px;border:1.5px solid #0F766E;border-radius:10px;background:#E6F4F2;color:#0B4F4A;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none;box-shadow:0 0 0 3px rgba(15,118,110,.14)}" +
    ".gl-cmi a:hover,.gl-cmi a:focus-visible{background:#0F766E;color:#fff;outline:none}@media (max-width:640px){.gl-cmi a{flex:1 1 auto;justify-content:center}}" +
    "@media (prefers-color-scheme:dark){.gl-cmi a{background:#12302d;color:#cdeee9;border-color:#3FB3A6}}</style>" +
    "<script>(function(){try{function metti(){if(document.querySelector('.gl-cmi'))return;var nav=document.querySelector('nav.gl-azioni');if(!nav||!nav.parentNode)return;" +
    "var b=document.createElement('div');b.className='gl-cmi';b.innerHTML='<a href=\"'+" + JSON.stringify(u) + "+'\">'+" + JSON.stringify(ICONA + " Costi e margine di tutti i cantieri") + "+'</a>';" +
    "nav.parentNode.insertBefore(b,nav.nextSibling);}metti();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',metti);setTimeout(metti,0);setTimeout(metti,150);" +
    "window.addEventListener('load',metti);}catch(e){}})();</script>";
}

// ---------------------------------------------------------------------------- rotte
export async function portaleCosti(request, env, base, inUrl, h) {
  if (env.COSTI === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");
  if (sotto === "/costi/azione") return azione(request, env, h);
  if (sotto !== "/costi") return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const p = parametri(inUrl);
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const elenco = base + "/?t=" + p.tok;
  if (!p.c) {
    const indietro = '<p><a href="' + h.esc(elenco) + '">Torna ai cantieri</a></p>';
    const d = await h.rpc(env, "costi_riepilogo", { p_token: p.tok }, 25000).catch(() => null);
    if (!d || typeof d !== "object") return h.risposta(h.foglio(base, "Costi e margine", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
    if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
    if (d.esito !== "ok") return h.risposta(h.foglio(base, "Costi e margine", "Questa pagina non è disponibile.", indietro), 404);
    return h.risposta(riepilogo(base, h, p, d, elenco));
  }
  if (!UUID.test(p.c)) return Response.redirect(inUrl.origin + elenco, 303);
  const torna = elenco + "&c=" + p.c;
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>';
  const d = await h.rpc(env, "costi_contesto", { p_token: p.tok, p_commessa: p.c }, 25000).catch(() => null);
  if (!d || typeof d !== "object") return h.risposta(h.foglio(base, "Costi e margine", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Costi e margine", "Questa pagina non è disponibile per questo cantiere.", indietro), 404);
  return h.risposta(pagina(base, h, p, d, torna, elenco));
}

async function azione(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  if (Number(request.headers.get("Content-Length") || 0) > 20000) return json({ esito: "richiesta_non_valida" }, 413);
  let d = null;
  try { d = await request.json(); } catch (e) { d = null; }
  if (!d || typeof d !== "object") return json({ esito: "richiesta_non_valida" }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  const a = String(d.azione || "");
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c) || AZIONI.indexOf(a) === -1) return json({ esito: "richiesta_non_valida" }, 400);
  const dati = puliscoDati(a, ogg(d.dati));
  const r = await h.rpc(env, "costi_azione", { p_token: tok, p_commessa: c, p_azione: a, p_dati: dati }, 15000).catch(() => null);
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 503);
  return json(r, r.esito === "gettone" ? 403 : 200);
}

// ---------------------------------------------------------------------------- pagina del cantiere
function testaHtml(h, base, titolo) {
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>" + titolo + " - TIX · Diario di cantiere</title>" + h.testa(base) + "<style>" + STILE + "</style></head><body><main>";
}
function riquadro(cls, etichetta, valore, sotto) {
  return '<div class="cm-r ' + cls + '"><span>' + etichetta + '</span><b>' + valore + '</b>' + (sotto ? '<small>' + sotto + '</small>' : "") + '</div>';
}
function avviso(cls, html) { return '<div class="cm-av ' + cls + '">' + html + '</div>'; }

function pagina(base, h, p, d, torna, elenco) {
  const e = h.esc;
  const q = ogg(d.quadro);
  const ult = q.ultimo && typeof q.ultimo === "object" ? q.ultimo : null;
  const cal = ogg(ult ? q.costi_al : q.costi_ora);
  const cora = ogg(q.costi_ora);
  const dopo = ogg(q.dopo);
  const man = ogg(cal.manodopera), mez = ogg(cal.mezzi), mano = ogg(cal.manuali), sub = ogg(cal.subappalti);
  const manOra = ogg(cora.manodopera);
  const soglia = n(q.soglia) ?? 10;
  const sotto = q.stato === "sotto";
  const voci = ogg(d.voci);
  const linkSal = base + "/sal?t=" + p.tok + "&c=" + p.c;
  const oggi = dataIso(d.oggi) || new Date().toISOString().slice(0, 10);

  // 1. il quadro
  let quadro = "";
  if (!q.ricavi_disponibili) quadro += avviso("gi", "<b>Il collegamento con i ricavi della sezione SAL non è attivo:</b> il margine non si può calcolare.");
  if (ult) {
    const avz = n(q.avanzamento);
    quadro += '<div class="cm-quadro">' +
      riquadro("ric", "Ricavo al SAL n. " + e(String(ult.numero ?? "")), euroTondo(q.ricavo), "lavori fino al " + e(dataIt(q.al)) + (avz !== null ? " · lavori al " + pct(avz) : "")) +
      riquadro("cos", "Costi fino al " + e(dataIt(q.al)), euroTondo(q.costi), "manodopera, mezzi, subappalti, costi a mano") +
      riquadro("mar " + (sotto ? "no" : "ok"), "Margine al SAL n. " + e(String(ult.numero ?? "")), euroTondo(q.margine), pct(q.margine_pct) + (sotto ? " · sotto la soglia del " + pct(soglia) : " · soglia " + pct(soglia))) +
      riquadro("pre" + (n(q.previsto_pct) !== null && n(q.previsto_pct) < soglia ? " no" : ""), "Previsto a fine lavori",
        n(q.previsto_pct) !== null ? pct(q.previsto_pct) : "—",
        n(q.previsto_pct) !== null ? "circa " + euroTondo(q.previsto) + " su " + euroTondo(q.contratto) + " di contratto" : "si vede quando i lavori superano il " + pct(q.previsto_da)) +
      '</div>';
    if (n(q.spese_generali_pct) !== null) {
      quadro += '<p class="cm-sg">Dopo le spese generali (' + pct(q.spese_generali_pct) + ' dei costi): <b>' + euroTondo(q.margine_dopo_sg) + '</b>' +
        (n(q.ricavo) > 0 ? " (" + pct(n(q.margine_dopo_sg) / n(q.ricavo) * 100) + ")" : "") + '</p>';
    }
    const dt = n(dopo.totale) || 0, eco = n(q.economia_ore_dopo) || 0;
    quadro += '<div class="cm-dopo"><b>In attesa del prossimo SAL</b> (dal ' + e(dataIt(addGiorno(q.al))) + '): spesi ' + euroTondo(dt) +
      (dt ? ' — manodopera ' + euroTondo(dopo.manodopera) + ', mezzi ' + euroTondo(dopo.mezzi) + ', costi a mano ' + euroTondo(dopo.manuali) + ', subappalti ' + euroTondo(dopo.subappalti) : "") +
      '. Non si tolgono dal margine: entreranno con il prossimo SAL.' +
      (eco ? ' Ore in economia per il committente da mettere a SAL: <b>' + ore(eco) + '</b> (gli euro sono nel Registro delle economie).' : "") + '</div>';
  } else {
    quadro += '<div class="cm-quadro">' +
      riquadro("ric", "Contratto", n(q.contratto) !== null ? euroTondo(q.contratto) : "—", n(q.contratto) !== null ? "dal computo della sezione SAL, varianti comprese" : "si legge dal computo della sezione SAL") +
      riquadro("cos", "Speso finora", euroTondo(cora.totale), n(q.speso_pct_contratto) !== null ? pct(q.speso_pct_contratto) + " del contratto" : "manodopera, mezzi, subappalti, costi a mano") +
      riquadro("mar", "Margine", "dal primo SAL", "il margine si calcola sul ricavo del SAL") +
      '</div>' +
      avviso("bl", "<b>Il margine compare con il primo SAL.</b> TIX confronta il ricavo del SAL con i costi fino alla sua data; i costi dopo restano a parte, così il margine non scende per finta tra un SAL e l'altro. " +
        '<a href="' + e(linkSal) + '">Vai al SAL del cantiere</a>');
  }

  // 2. dove vanno i soldi
  const col = ult ? "Fino al " + e(dataIt(q.al)) : "Finora";
  const rigaT = (et, a, b) => '<tr><th scope="row">' + et + '</th><td class="n">' + euroTondo(a) + '</td>' + (ult ? '<td class="n">' + euroTondo(b) + '</td>' : "") + '</tr>';
  const tabella = '<div class="cm-tabw"><table class="cm-tab"><thead><tr><th>Costi</th><th class="n">' + col + '</th>' + (ult ? '<th class="n">Dopo il SAL</th>' : "") + '</tr></thead><tbody>' +
    rigaT("Manodopera", man.euro, dopo.manodopera) + rigaT("Mezzi propri", mez.euro, dopo.mezzi) +
    rigaT("Costi a mano (materiali, noli…)", mano.euro, dopo.manuali) + rigaT("Subappalti", sub.euro, dopo.subappalti) +
    '</tbody><tfoot><tr><th scope="row">Totale</th><td class="n">' + euroTondo(cal.totale) + '</td>' + (ult ? '<td class="n">' + euroTondo(dopo.totale) + '</td>' : "") + '</tr></tfoot></table></div>';

  // 3. avvisi
  let avvisi = "";
  const sq = lista(d.senza_qualifica).map((x) => testo(x, 80)).filter(Boolean);
  const oreNoQ = n(manOra.ore_senza_qualifica) || 0, oreNoC = n(manOra.ore_senza_costo) || 0, parz = Number(manOra.giorni_parziali) || 0;
  if (oreNoQ > 0) avvisi += avviso("gi", "<b>Costo parziale: " + ore(oreNoQ) + " senza qualifica.</b> Sono contate ma senza costo, perché TIX non sa se sono di un operaio comune, qualificato o specializzato." +
    (sq.length ? " Dipendenti senza qualifica: " + sq.map(e).join(", ") + "." : "") +
    (d.link_tesserini ? ' La qualifica si scrive nella <a href="' + e(d.link_tesserini) + '">scheda del tesserino</a> della persona.' : " La qualifica si scrive nella scheda del tesserino della persona."));
  else if (sq.length) avvisi += avviso("gi", "<b>Dipendenti del cantiere senza qualifica:</b> " + sq.map(e).join(", ") + ". Quando faranno ENTRO/ESCO, le loro ore non avranno costo finché non scrivi la qualifica" +
    (d.link_tesserini ? ' nella <a href="' + e(d.link_tesserini) + '">scheda del tesserino</a>.' : " nella scheda del tesserino."));
  if (oreNoC > 0) avvisi += avviso("gi", "<b>Costo parziale: " + ore(oreNoC) + " di una qualifica senza costo orario.</b> Scrivilo qui sotto, in «Costi della tua impresa».");
  if (parz > 0) avvisi += avviso("gi", "<b>Costo parziale: in " + parz + (parz === 1 ? " giorno" : " giorni") + " mancano le presenze.</b> Ci sono solo le ore in economia, non l'intera giornata, quindi il costo è più basso del vero. Le ore vere arrivano con ENTRO ed ESCO (cartello con il QR del cantiere).");
  if ((n(manOra.ore) || 0) === 0) avvisi += avviso("bl", "<b>Nessuna ora registrata finora.</b> Le ore degli operai arrivano da ENTRO ed ESCO: l'operaio inquadra il QR code del cartello del cantiere e manda il messaggio. Se qualcuno dimentica, l'ufficio aggiunge l'entrata o l'uscita dalla pagina delle timbrature.");
  const mezSenza = lista(ogg(cora.mezzi).senza_costo).map((x) => testo(x, 80)).filter(Boolean);
  if (mezSenza.length) avvisi += avviso("gi", "<b>Mezzi senza costo interno:</b> " + mezSenza.map(e).join(", ") + ". Scrivilo qui sotto, in «Costi della tua impresa».");
  if (ogg(cora.mezzi).fonte === "economia") avvisi += avviso("bl", "<b>Mezzi propri:</b> TIX conta i giorni in cui il mezzo è segnato nelle economie. I mezzi a noleggio si pagano con la fattura del noleggiatore: scrivila nei costi a mano.");
  if (!ogg(cora.subappalti).disponibile) avvisi += avviso("bl", "<b>Subappalti:</b> il collegamento con la contabilità dei subappaltatori della sezione SAL non è attivo.");
  avvisi += avviso("bl", "<b>Materiali, noli e trasporti:</b> scrivi le fatture dei fornitori nei costi a mano, qui sotto.");

  // 4. dettagli
  const nomeVoce = (v) => (VOCI.find((x) => x[0] === v) || [v, "Senza qualifica"])[1];
  const righeMan = lista(manOra.righe);
  const manDett = '<details class="cm-det" id="manodopera"><summary>Manodopera <span>' + euroTondo(manOra.euro) + ' · ' + ore(manOra.ore) + '</span></summary><div class="cm-det-c">' +
    (lista(manOra.voci).length ? '<div class="cm-tabw"><table class="cm-tab"><thead><tr><th>Qualifica</th><th class="n">Ore</th><th class="n">Costo</th></tr></thead><tbody>' +
      lista(manOra.voci).map((x) => '<tr><td>' + e(nomeVoce(x.voce)) + (x.mancano ? ' <em class="cm-man">costo mancante</em>' : "") + '</td><td class="n">' + ore(x.ore) + '</td><td class="n">' + euroTondo(x.euro) + '</td></tr>').join("") +
      '</tbody></table></div>' : '<p class="cm-vuoto">Nessuna ora registrata.</p>') +
    (righeMan.length ? '<details class="cm-sotto"><summary>Giorno per giorno (' + righeMan.length + ')</summary><div class="cm-tabw"><table class="cm-tab cm-pic"><thead><tr><th>Giorno</th><th>Chi</th><th>Qualifica</th><th class="n">Ore</th><th class="n">€/ora</th><th class="n">Costo</th><th>Da dove</th></tr></thead><tbody>' +
      righeMan.slice(0, 400).map((x) => '<tr' + (x.parziale ? ' class="pz"' : "") + '><td>' + e(dataIt(x.giorno)) + '</td><td>' + e(testo(x.chi, 80)) + '</td><td>' + e(nomeVoce(x.voce)) + '</td><td class="n">' + ore(x.ore) +
        '</td><td class="n">' + (n(x.costo_ora) !== null ? euro(x.costo_ora) : "—") + '</td><td class="n">' + (n(x.euro) !== null ? euro(x.euro) : "—") + '</td><td>' +
        (x.fonte === "presenze" ? "ENTRO/ESCO" : x.fonte === "rapportino" ? "rapportino (solo economia)" : "WhatsApp (solo economia)") + '</td></tr>').join("") +
      '</tbody></table></div></details>' : "") + '</div></details>';

  const mezOra = ogg(cora.mezzi);
  const mezDett = '<details class="cm-det" id="mezzi"><summary>Mezzi propri <span>' + euroTondo(mezOra.euro) + '</span></summary><div class="cm-det-c">' +
    (lista(mezOra.mezzi).length ? '<div class="cm-tabw"><table class="cm-tab"><thead><tr><th>Mezzo</th><th class="n">Uso</th><th class="n">Giorni</th><th class="n">Costo</th></tr></thead><tbody>' +
      lista(mezOra.mezzi).map((x) => '<tr><td>' + e(testo(x.nome, 80)) + (x.senza_costo ? ' <em class="cm-man">costo mancante</em>' : "") + '</td><td class="n">' + e(valoreIt(x.quantita)) + " " + e(UNITA[x.unita] || x.unita || "") +
        '</td><td class="n">' + (Number(x.giorni) || 0) + '</td><td class="n">' + euroTondo(x.euro) + '</td></tr>').join("") +
      '</tbody></table></div>' : '<p class="cm-vuoto">Nessun uso di mezzi propri registrato.</p>') + '</div></details>';

  const manuali = lista(d.manuali);
  const nomeCat = (k) => (CATEGORIE.find((x) => x[0] === k) || [k, k])[1];
  const opzCat = CATEGORIE.map((x) => '<option value="' + x[0] + '">' + e(x[1]) + '</option>').join("");
  const manoDett = '<details class="cm-det" id="manuali"' + (manuali.length ? "" : " open") + '><summary>Costi scritti a mano <span>' + euroTondo(ogg(cora.manuali).euro) + '</span></summary><div class="cm-det-c">' +
    '<p class="cm-nota">Materiali, noli, trasporti, smaltimenti, autonomi: scrivi l\'importo + IVA della fattura o del documento. Un subappaltatore con la sua contabilità in TIX non va scritto qui, altrimenti si conta due volte.</p>' +
    (manuali.length ? '<div class="cm-tabw"><table class="cm-tab"><thead><tr><th>Data</th><th>Tipo</th><th>Che cosa</th><th class="n">Importo</th><th></th></tr></thead><tbody>' +
      manuali.map((x) => '<tr><td>' + e(dataIt(x.data)) + '</td><td>' + e(nomeCat(x.categoria)) + '</td><td>' + e(testo(x.descrizione, 300)) +
        (x.fornitore || x.numero ? '<small>' + e([testo(x.fornitore, 120), x.numero ? "n. " + testo(x.numero, 60) : ""].filter(Boolean).join(" · ")) + '</small>' : "") +
        '<small>scritto da ' + e(testo(x.autore, 120)) + (x.modificato_da ? ", modificato da " + e(testo(x.modificato_da, 120)) : "") + '</small></td><td class="n">' + euro(x.importo) +
        '</td><td class="cm-az"><button type="button" class="btn sm tenue" data-mod="' + e(x.id) + '">Modifica</button> <button type="button" class="btn sm togli" data-tog="' + e(x.id) + '">Togli</button></td></tr>').join("") +
      '</tbody></table></div>' : '<p class="cm-vuoto">Nessun costo scritto a mano.</p>') +
    '<form class="cm-form" id="cm-f" autocomplete="off"><h3 id="cm-f-tit">Aggiungi un costo</h3><input type="hidden" id="cm-f-id">' +
    '<div class="cm-campi"><label><span>Data</span><input type="date" id="cm-f-data" value="' + e(oggi) + '"></label>' +
    '<label><span>Tipo</span><select id="cm-f-cat">' + opzCat + '</select></label>' +
    '<label><span>Importo + IVA (€)</span><input id="cm-f-imp" inputmode="decimal" placeholder="1.234,50"></label>' +
    '<label class="l2"><span>Che cosa è</span><input id="cm-f-descr" maxlength="300" placeholder="Per esempio: fattura del ferro di ottobre"></label>' +
    '<label><span>Fornitore (facoltativo)</span><input id="cm-f-forn" maxlength="120"></label>' +
    '<label><span>Numero del documento (facoltativo)</span><input id="cm-f-num" maxlength="60"></label></div>' +
    '<div class="cm-chi"><label for="cm-f-chi">Il tuo nome</label><input id="cm-f-chi" maxlength="120" autocomplete="name"></div>' +
    '<p class="cm-msg" id="cm-f-msg" role="status"></p><div class="cm-form-az"><button type="button" class="btn tenue" id="cm-f-annulla" hidden>Annulla la modifica</button><button type="button" class="btn pr" id="cm-f-salva">Salva il costo</button></div></form>' +
    '</div></details>';

  const subOra = ogg(cora.subappalti);
  const subDett = '<details class="cm-det" id="subappalti"><summary>Subappalti <span>' + euroTondo(subOra.euro) + '</span></summary><div class="cm-det-c">' +
    (lista(subOra.contratti).length ? '<div class="cm-tabw"><table class="cm-tab"><thead><tr><th>Subappaltatore</th><th class="n">Contratto</th><th class="n">Lavori contabilizzati</th></tr></thead><tbody>' +
      lista(subOra.contratti).map((x) => '<tr><td>' + e(testo(x.impresa_nome, 120)) + '</td><td class="n">' + euroTondo(x.importo_contratto) + '</td><td class="n">' + euroTondo(x.lavori_ora ?? x.lavori_al) + '</td></tr>').join("") +
      '</tbody></table></div>' : '<p class="cm-vuoto">Nessun subappaltatore con la contabilità in TIX.</p>') +
    '<p class="cm-nota">Conta l\'ultimo SAL approvato di ogni subappaltatore, ritenuta compresa. Il margine voce per voce è nella scheda Subappalti della ' +
    '<a href="' + e(linkSal) + '">pagina SAL</a>.</p></div></details>';

  // 5. costi della tua impresa
  const campoVoce = (v) => {
    const x = ogg(voci[v[0]]);
    const st = lista(x.storico);
    return '<label><span>' + e(v[1]) + ' <i>' + e(v[2]) + '</i></span><input id="cm-v-' + v[0] + '" data-voce="' + v[0] + '" inputmode="decimal" value="' + e(valoreIt(x.valore)) + '" data-prima="' + e(valoreIt(x.valore)) + '"' +
      (v[0] === "soglia_margine_pct" && n(x.valore) === null ? ' placeholder="' + e(valoreIt(soglia)) + '"' : v[0] === "spese_generali_pct" ? ' placeholder="non scritte"' : ' placeholder="da scrivere"') + '>' +
      (st.length ? '<small>' + st.slice(0, 2).map((s) => (n(s.valore) !== null ? valoreIt(s.valore) : "tolto") + " dal " + dataIt(s.dal) + " (" + testo(s.autore, 60) + ")").map(e).join(" · ") + '</small>' : "") + '</label>';
  };
  const mezziProp = lista(d.mezzi).filter((m) => m.proprieta === "proprieta");
  const mezziNol = lista(d.mezzi).filter((m) => m.proprieta !== "proprieta");
  const impresa = '<section class="cm-imp" id="impresa"><h2>Costi della tua impresa</h2>' +
    '<p class="cm-nota">Valgono per tutti i cantieri della tua impresa. Scrivi il <b>costo</b> per l\'impresa (paga, contributi, ferie, assicurazione), non il prezzo che fai pagare al committente. Mai lo stipendio della singola persona: solo per qualifica. Ogni cambio resta registrato con la data e il nome, e vale dalla data che scrivi.</p>' +
    '<div class="cm-campi cm-voci">' + VOCI.map(campoVoce).join("") + '</div>' +
    (mezziProp.length ? '<h3>Costo interno dei mezzi propri</h3><div class="cm-campi cm-voci">' + mezziProp.map((m) => {
      const k = ogg(m.costo);
      return '<label><span>' + e(testo(m.nome, 80)) + (m.targa ? ' <i>' + e(testo(m.targa, 30)) + '</i>' : "") + ' <i>€ per ' + e(UNITA[m.unita] || m.unita) + '</i></span>' +
        '<input data-mezzo="' + e(m.id) + '" inputmode="decimal" value="' + e(valoreIt(k.costo)) + '" data-prima="' + e(valoreIt(k.costo)) + '" placeholder="da scrivere">' +
        (k.dal ? '<small>dal ' + e(dataIt(k.dal)) + ' (' + e(testo(k.autore, 60)) + ')</small>' : "") + '</label>';
    }).join("") + '</div>' : '<p class="cm-nota">Nessun mezzo proprio nella sezione Mezzi e attrezzature' + (d.mezzi_attiva !== "no" ? ': aggiungili dall\'elenco dei cantieri, pulsante «Mezzi e attrezzature».' : '.') + '</p>') +
    (mezziNol.length ? '<p class="cm-nota">Mezzi a noleggio (' + mezziNol.map((m) => e(testo(m.nome, 60))).join(", ") + '): si pagano con la fattura del noleggiatore, da scrivere nei costi a mano. Così non si pagano due volte.</p>' : "") +
    '<div class="cm-campi"><label><span>Valido dal</span><input type="date" id="cm-v-dal" value="' + e(oggi) + '"></label>' +
    '<label class="l2"><span>Il tuo nome</span><input id="cm-v-chi" maxlength="120" autocomplete="name"></label></div>' +
    '<p class="cm-msg" id="cm-v-msg" role="status"></p><div class="cm-form-az"><button type="button" class="btn pr" id="cm-v-salva">Salva i costi</button></div></section>';

  const fonti = '<p class="cm-fonti"><b>Da dove vengono i numeri.</b> Ricavo: l\'ultimo SAL valido (emesso, firmato dall\'impresa o vistato dal DL) della sezione SAL. ' +
    'Manodopera: le ore di ENTRO/ESCO dei dipendenti × il costo orario della loro qualifica; nei giorni senza ENTRO/ESCO contano le ore in economia del rapportino firmato o di WhatsApp (costo parziale). ' +
    'Le ore dei subappaltatori non entrano qui: entra il loro SAL. Mezzi propri: uso × costo interno. Spese generali: in una riga a parte, solo se le scrivi. ' +
    '<b>Questa pagina la vedono solo le persone della tua impresa</b> con l\'accesso all\'app: mai il DL, il committente, i professionisti, i subappaltatori o gli operai su WhatsApp. Tutti gli importi sono + IVA.</p>';

  const cfg = JSON.stringify({ u: base + "/costi/azione", t: p.tok, c: p.c, manuali: manuali.map((x) => ({ id: x.id, data: x.data, categoria: x.categoria,
    fornitore: x.fornitore || "", descrizione: x.descrizione || "", numero: x.numero || "", importo: x.importo })) }).replace(/</g, "\\u003c");

  return testaHtml(h, base, "Costi e margine") +
    '<nav class="cm-nav"><a class="cm-torna" href="' + e(torna) + '">‹ Torna al cantiere</a><a class="cm-torna" href="' + e(base + "/costi?t=" + p.tok) + '">Tutti i cantieri</a></nav>' +
    '<div class="cm-card' + (sotto ? " cm-rosso" : "") + '"><div class="cm-testa"><div>' + (d.cantiere ? '<p class="cm-cant">' + e(d.cantiere) + '</p>' : "") +
    '<h1><span class="cm-ic" aria-hidden="true">' + ICONA + '</span>Costi e margine</h1>' +
    (d.modo === "prova" ? '<p class="cm-prova">In prova: questa pagina la vede solo l\'accesso «Tutte le aziende»</p>' : "") + '</div></div>' +
    quadro + tabella + avvisi + manDett + mezDett + manoDett + subDett + impresa + fonti + '</div></main>' +
    '<dialog class="cm-dlg" id="cm-t-dlg"><form method="dialog"><h3>Togli il costo</h3><p id="cm-t-txt"></p>' +
    '<label for="cm-t-chi">Il tuo nome</label><input id="cm-t-chi" maxlength="120" autocomplete="name">' +
    '<label for="cm-t-mot">Perché (facoltativo)</label><input id="cm-t-mot" maxlength="300" placeholder="Per esempio: scritto due volte">' +
    '<p class="cm-msg" id="cm-t-msg" role="status"></p><div class="cm-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn rosso" id="cm-t-si">Togli</button></div></form></dialog>' +
    "<script>var CFG=" + cfg + ";" + SCRIPT + "</script></body></html>";
}
function addGiorno(iso) {
  const t = Date.parse(String(iso || "") + "T00:00:00Z");
  return Number.isFinite(t) ? new Date(t + 86400000).toISOString().slice(0, 10) : "";
}

// ---------------------------------------------------------------------------- riepilogo di tutti i cantieri
function riepilogo(base, h, p, d, elenco) {
  const e = h.esc;
  const cc = lista(d.cantieri);
  const sotto = cc.filter((x) => x.stato === "sotto").length;
  const righe = cc.map((x) => {
    const u = base + "/costi?t=" + p.tok + "&c=" + encodeURIComponent(String(x.id || ""));
    const st = x.stato === "sotto" ? '<span class="cm-st no">sotto la soglia</span>' : x.stato === "ok" ? '<span class="cm-st ok">ok</span>' : '<span class="cm-st gr">senza SAL</span>';
    return '<tr' + (x.stato === "sotto" ? ' class="no"' : "") + '><td><a href="' + e(u) + '">' + e(testo(x.nome, 120)) + '</a>' + (d.filippo && x.impresa ? '<small>' + e(testo(x.impresa, 80)) + '</small>' : "") +
      (x.chiuso ? '<small>chiuso</small>' : "") + (x.parziale ? '<small class="cm-man">costo parziale</small>' : "") + '</td>' +
      '<td class="n" data-l="Ultimo SAL">' + (x.sal ? "n. " + e(String(x.sal)) + "<small>al " + e(dataIt(x.al)) + "</small>" : "—") + '</td>' +
      '<td class="n" data-l="Ricavo">' + (n(x.ricavo) !== null && x.sal ? euroTondo(x.ricavo) : "—") + '</td>' +
      '<td class="n" data-l="' + (x.sal ? "Costi al SAL" : "Speso finora") + '">' + euroTondo(x.sal ? x.costi : x.speso) + '</td>' +
      '<td class="n" data-l="Margine"><b>' + (x.sal ? pct(x.margine_pct) : "—") + '</b>' + (x.sal ? "<small>" + euroTondo(x.margine) + "</small>" : "") + '</td>' +
      '<td class="n" data-l="Previsto">' + (n(x.previsto_pct) !== null ? pct(x.previsto_pct) : "—") + '</td><td data-l="Stato">' + st + '</td></tr>';
  }).join("");
  return testaHtml(h, base, "Costi e margine") +
    '<nav class="cm-nav"><a class="cm-torna" href="' + e(elenco) + '">‹ Torna ai cantieri</a></nav>' +
    '<div class="cm-card"><div class="cm-testa"><div><h1><span class="cm-ic" aria-hidden="true">' + ICONA + '</span>Costi e margine di tutti i cantieri</h1>' +
    (d.modo === "prova" ? '<p class="cm-prova">In prova: questa pagina la vede solo l\'accesso «Tutte le aziende»</p>' : "") + '</div></div>' +
    (sotto ? avviso("ro", "<b>" + (sotto === 1 ? "Un cantiere è" : sotto + " cantieri sono") + " sotto la soglia del margine.</b> Aprilo per vedere dove vanno i costi.") : "") +
    (cc.length ? '<div class="cm-tabw"><table class="cm-tab cm-riep"><thead><tr><th>Cantiere</th><th class="n">Ultimo SAL</th><th class="n">Ricavo</th><th class="n">Costi</th><th class="n">Margine</th><th class="n">Previsto</th><th>Stato</th></tr></thead><tbody>' +
      righe + '</tbody></table></div>' : '<p class="cm-vuoto">Nessun cantiere.</p>') +
    '<p class="cm-fonti">Il margine di ogni cantiere si calcola all\'ultimo SAL: ricavo del SAL meno i costi fino alla sua data. Senza SAL, «Costi» è quanto si è speso finora. ' +
    'Lo vedono solo le persone della tua impresa con l\'accesso all\'app. Importi + IVA.</p></div></main></body></html>';
}

// ---------------------------------------------------------------------------- stile e script della pagina
const STILE =
  ":root{--navy:#1B2F4A;--cm:#0F766E;--cm-2:#14958A;--cm-s:#0B4F4A;--cm-f:#E6F4F2;--cm-b:#A7D8D1;" +
  "--t:#17212E;--s:#5B6672;--c:#FFFFFF;--z:#F5F7FA;--l:rgba(16,27,43,.11);--ro-f:#FDECEA;--ro:#B3261E;--ro-b:#F2B8B5;" +
  "--ok-f:#E9F6EF;--ok:#146C43;--ok-b:#A8D8BD;--gi-f:#FFF9E6;--gi:#5C4500;--gi-b:#E8D48A;--bl-f:#EEF4FA;--bl-b:#C9D8E8;" +
  "--ombra:0 1px 2px rgba(16,27,43,.05),0 8px 20px -14px rgba(16,27,43,.20),0 0 0 1px rgba(16,27,43,.03)}" +
  "*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-font-smoothing:antialiased}" +
  "body{margin:0;color:var(--t);font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,system-ui,sans-serif;letter-spacing:-.006em;" +
  "background:radial-gradient(1100px 600px at 100% -10%,rgba(15,118,110,.06),transparent 60%),radial-gradient(900px 600px at -10% 0%,rgba(27,47,74,.06),transparent 60%),#F8FAFC}" +
  "main{max-width:960px;margin:0 auto;padding:16px 16px 48px}" +
  "@media screen and (min-width:760px){main{max-width:min(1600px,calc(100vw - 48px));padding:20px 12px 56px}}" +
  "@media screen and (min-width:900px){main{max-width:min(1600px,calc(100vw - 96px))}}" +
  "svg{display:block}a{color:var(--cm-s);font-weight:600}" +
  ".cm-nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}" +
  ".cm-torna{display:inline-block;padding:6px 14px;border-radius:999px;border:1px solid var(--l);background:var(--c);color:var(--navy);font-weight:600;text-decoration:none}" +
  ".cm-card{position:relative;background:var(--c);border-radius:16px;padding:18px 18px 16px;box-shadow:var(--ombra)}" +
  ".cm-card::before{content:\"\";position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#0F766E);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}" +
  ".cm-card.cm-rosso::before{background:linear-gradient(135deg,#1B2F4A,#B3261E)}" +
  ".cm-testa{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:0 0 14px}" +
  ".cm-cant{margin:0;font-size:.88rem;color:var(--s)}" +
  "h1{display:flex;align-items:center;gap:10px;margin:4px 0 0;font-size:1.5rem;letter-spacing:-.02em;color:var(--navy)}" +
  ".cm-ic{flex:none;width:38px;height:38px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#3FB3A6,#14958A 45%,#0B4F4A);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 6px 14px -6px rgba(11,79,74,.65)}" +
  ".cm-ic svg{width:21px;height:21px}" +
  ".cm-prova{display:inline-block;margin:8px 0 0;padding:3px 10px;border:1px dashed var(--cm-b);border-radius:999px;background:var(--cm-f);color:var(--cm-s);font-size:.8rem;font-weight:600}" +
  ".cm-quadro{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 10px}" +
  ".cm-r{position:relative;border:1px solid var(--l);border-radius:14px;padding:12px 14px 12px 16px;background:var(--c);overflow:hidden;display:flex;flex-direction:column;gap:2px}" +
  ".cm-r::before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--navy)}" +
  ".cm-r span{font-size:.82rem;font-weight:700;color:var(--s)}.cm-r b{font-size:1.5rem;line-height:1.25;color:var(--navy);font-variant-numeric:tabular-nums}" +
  ".cm-r small{font-size:.8rem;color:var(--s);line-height:1.4}" +
  ".cm-r.ric::before{background:#7C5CD6}.cm-r.cos::before{background:#D08A1C}.cm-r.mar::before,.cm-r.pre::before{background:var(--cm)}" +
  ".cm-r.mar.ok{background:var(--ok-f);border-color:var(--ok-b)}.cm-r.mar.ok b{color:var(--ok)}" +
  ".cm-r.no{background:var(--ro-f);border-color:var(--ro-b)}.cm-r.no::before{background:var(--ro)}.cm-r.no b{color:var(--ro)}" +
  ".cm-sg{margin:4px 0 8px;font-size:.92rem;color:var(--t)}" +
  ".cm-dopo{margin:0 0 14px;padding:10px 14px;border-radius:12px;border:1px solid var(--bl-b);background:var(--bl-f);font-size:.9rem;line-height:1.5}" +
  ".cm-av{margin:0 0 8px;padding:10px 14px;border-radius:12px;font-size:.88rem;line-height:1.5}" +
  ".cm-av.gi{border:1px solid var(--gi-b);background:var(--gi-f);color:var(--gi)}.cm-av.bl{border:1px solid var(--bl-b);background:var(--bl-f);color:var(--t)}" +
  ".cm-av.ro{border:1px solid var(--ro-b);background:var(--ro-f);color:#7a1c16}" +
  ".cm-tabw{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 12px}" +
  ".cm-tab{width:100%;border-collapse:collapse;font-size:.9rem}.cm-tab th,.cm-tab td{padding:8px 8px;border-bottom:1px solid #E9EDF1;text-align:left;vertical-align:top}" +
  ".cm-tab thead th{font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;color:var(--s);font-weight:700}.cm-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}" +
  ".cm-tab tfoot th,.cm-tab tfoot td{font-weight:800;border-top:2px solid var(--cm-b);border-bottom:0}.cm-tab small{display:block;color:var(--s);font-size:.78rem}" +
  ".cm-tab tr.pz td{background:#FFFBEA}.cm-tab tr.no td{background:var(--ro-f)}.cm-pic{font-size:.84rem}" +
  ".cm-man{font-style:normal;font-size:.72rem;font-weight:800;color:#8A4B00;text-transform:uppercase;letter-spacing:.03em}" +
  ".cm-st{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.78rem;font-weight:700;white-space:nowrap}" +
  ".cm-st.ok{background:var(--ok-f);color:var(--ok);border:1px solid var(--ok-b)}.cm-st.no{background:var(--ro-f);color:var(--ro);border:1px solid var(--ro-b)}.cm-st.gr{background:#F2F4F7;color:#4A5563;border:1px solid #CBD2DA}" +
  ".cm-det{margin:12px 0 0;border:1px solid var(--cm-b);border-radius:14px;background:#fff}" +
  ".cm-det>summary{cursor:pointer;display:flex;justify-content:space-between;gap:10px;padding:12px 14px;font-weight:800;color:var(--navy)}" +
  ".cm-det>summary span{font-weight:700;color:var(--cm-s);font-variant-numeric:tabular-nums}.cm-det[open]>summary{border-bottom:1px solid var(--cm-b)}" +
  ".cm-det-c{padding:10px 14px}.cm-sotto summary{cursor:pointer;font-weight:700;color:var(--cm-s);margin:6px 0}" +
  ".cm-vuoto{margin:4px 0 10px;color:var(--s);font-size:.9rem}.cm-nota{margin:0 0 10px;font-size:.86rem;line-height:1.5;color:var(--s)}" +
  ".cm-az{white-space:nowrap;text-align:right}" +
  ".btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:42px;padding:0 16px;border-radius:12px;border:1px solid var(--navy);background:var(--c);color:var(--navy);font:inherit;font-weight:700;font-size:.92rem;text-decoration:none;white-space:nowrap;cursor:pointer}" +
  ".btn.pr{border-color:var(--cm);color:#fff;background:linear-gradient(180deg,#14958A,#0F766E);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 22px -12px rgba(11,79,74,.8)}" +
  ".btn.pr:disabled{opacity:.6;cursor:wait}.btn.sm{min-height:32px;padding:0 10px;font-size:.82rem;border-radius:10px}.btn.tenue{border-color:rgba(16,27,43,.16);color:var(--t)}" +
  ".btn.togli{border-color:var(--ro-b);color:var(--ro)}.btn.rosso{border-color:var(--ro);color:#fff;background:var(--ro)}" +
  ".btn:hover,.btn:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(15,118,110,.24)}" +
  ".cm-form{margin:14px 0 4px;padding:14px;border:1px solid var(--cm-b);border-radius:14px;background:linear-gradient(180deg,#F2FAF8,#FFFFFF 60%)}" +
  ".cm-form h3,.cm-imp h3{margin:0 0 8px;font-size:1.02rem;color:var(--navy)}" +
  ".cm-imp{margin:22px 0 0;padding:16px;border:1px solid var(--cm-b);border-radius:16px;background:linear-gradient(180deg,#F2FAF8,#FFFFFF 50%)}" +
  ".cm-imp h2{margin:0 0 6px;font-size:1.15rem;color:var(--navy)}.cm-imp h3{margin-top:14px}" +
  ".cm-campi{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 12px;margin:0 0 6px}.cm-campi .l2{grid-column:span 2}" +
  ".cm-campi label,.cm-chi{display:flex;flex-direction:column;gap:4px}.cm-campi span,.cm-chi label,.cm-dlg label{font-size:.84rem;font-weight:700;color:var(--navy)}" +
  ".cm-campi span i{font-style:normal;font-weight:600;color:var(--s)}.cm-campi small{font-size:.76rem;color:var(--s)}" +
  ".cm-campi input,.cm-campi select,.cm-chi input,.cm-dlg input{width:100%;min-height:40px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;background:var(--c);font:inherit;font-size:.92rem;color:var(--t)}" +
  ".cm-campi input.manca,.cm-chi input.manca,.cm-dlg input.manca{border:2px solid var(--ro);background:var(--ro-f)}" +
  ".cm-chi{max-width:420px;margin:8px 0 0}.cm-msg{margin:10px 0 0;font-size:.9rem;font-weight:600;color:var(--ro);min-height:1px}.cm-msg.ok{color:var(--ok)}" +
  ".cm-form-az{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:12px}" +
  ".cm-fonti{margin:20px 0 0;font-size:.82rem;line-height:1.55;color:var(--s)}" +
  ".cm-riep td a{font-weight:700}" +
  ".cm-dlg{max-width:460px;width:calc(100vw - 32px);border:0;border-radius:16px;padding:18px;box-shadow:0 24px 60px -20px rgba(16,27,43,.45)}" +
  ".cm-dlg::backdrop{background:rgba(16,27,43,.45)}.cm-dlg h3{margin:0 0 8px;color:var(--navy)}.cm-dlg p{margin:0 0 12px;font-size:.9rem;line-height:1.45;color:var(--s)}.cm-dlg form{display:flex;flex-direction:column;gap:6px}" +
  "@media (max-width:900px){.cm-quadro{grid-template-columns:repeat(2,minmax(0,1fr))}.cm-campi{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
  "@media (max-width:640px){main{padding:14px 16px 40px}.cm-card{padding:16px 14px 14px}h1{font-size:1.3rem}.cm-quadro{grid-template-columns:minmax(0,1fr)}" +
  ".cm-campi{grid-template-columns:minmax(0,1fr)}.cm-campi .l2{grid-column:auto}.cm-form-az .btn{flex:1 1 auto}.cm-r b{font-size:1.35rem}" +
  // riepilogo sul telefono: un riquadro per cantiere invece della tabella larga
  ".cm-riep thead{display:none}.cm-riep,.cm-riep tbody,.cm-riep tr{display:block}" +
  ".cm-riep tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;padding:10px 12px;margin:0 0 10px;border:1px solid var(--l);border-radius:12px}" +
  ".cm-riep td{display:block;padding:0;border:0;text-align:left!important;white-space:normal}.cm-riep td:first-child{grid-column:1/-1;font-size:1rem}" +
  ".cm-riep tr.no{background:var(--ro-f);border-color:var(--ro-b)}.cm-riep tr.no td{background:transparent}" +
  ".cm-riep td[data-l]::before{content:attr(data-l);display:block;font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--s)}}";

const SCRIPT = String.raw`(function(){try{
var D=document;function $(i){return D.getElementById(i);}
function leggiChi(){try{return localStorage.getItem('tix_pg_chi')||'';}catch(e){return '';}}
function scriviChi(v){try{if(v)localStorage.setItem('tix_pg_chi',v);}catch(e){}}
function numero(s){s=String(s==null?'':s).replace(/\s| |€/g,'');if(!s)return '';if(s.indexOf(',')!==-1)s=s.replace(/\./g,'').replace(',','.');else if(/^-?\d{1,3}(\.\d{3})+$/.test(s))s=s.replace(/\./g,'');return /^-?\d{1,9}(\.\d{1,4})?$/.test(s)?s:null;}
function invia(az,dati){return fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:az,dati:dati})}).then(function(r){return r.json();});}
function chiDi(id,msg){var el=$(id);var v=(el.value||'').trim();el.classList.toggle('manca',!v);if(!v){msg.className='cm-msg';msg.textContent='Scrivi il tuo nome: resta registrato chi ha fatto la modifica.';return '';}scriviChi(v);return v;}
['cm-f-chi','cm-v-chi','cm-t-chi'].forEach(function(i){var el=$(i);if(el&&!el.value)el.value=leggiChi();});
// costi della tua impresa: una richiesta per ogni voce cambiata
var vs=$('cm-v-salva');if(vs)vs.addEventListener('click',function(){var msg=$('cm-v-msg');var chi=chiDi('cm-v-chi',msg);if(!chi)return;
var dal=$('cm-v-dal').value||'';var lav=[],bad=false;
Array.prototype.forEach.call(D.querySelectorAll('[data-voce]'),function(i){var v=i.value.trim();if(v===(i.getAttribute('data-prima')||''))return;var x=numero(v);i.classList.toggle('manca',x===null);if(x===null){bad=true;return;}lav.push(['costo_impresa',{voce:i.getAttribute('data-voce'),valore:x,valido_dal:dal,autore:chi}]);});
Array.prototype.forEach.call(D.querySelectorAll('[data-mezzo]'),function(i){var v=i.value.trim();if(v===(i.getAttribute('data-prima')||''))return;var x=numero(v);i.classList.toggle('manca',x===null);if(x===null){bad=true;return;}lav.push(['costo_mezzo',{mezzo_id:i.getAttribute('data-mezzo'),costo:x,valido_dal:dal,autore:chi}]);});
if(bad){msg.className='cm-msg';msg.textContent='Scrivi i numeri così: 32,50 (euro) oppure 12 (percentuale).';return;}
if(!lav.length){msg.className='cm-msg';msg.textContent='Non hai cambiato niente.';return;}
vs.disabled=true;msg.className='cm-msg ok';msg.textContent='Salvo…';
(function prossimo(k){if(k>=lav.length){msg.textContent='Salvato.';location.reload();return;}invia(lav[k][0],lav[k][1]).then(function(r){if(r&&r.esito==='ok')return prossimo(k+1);vs.disabled=false;msg.className='cm-msg';msg.textContent=(r&&r.messaggio)||'Non sono riuscito a salvare: riprova.';}).catch(function(){vs.disabled=false;msg.className='cm-msg';msg.textContent='Il servizio non risponde: riprova tra un minuto.';});})(0);});
// costi a mano: aggiungi, modifica, togli
var fs=$('cm-f-salva');
function svuota(){$('cm-f-id').value='';$('cm-f-tit').textContent='Aggiungi un costo';$('cm-f-annulla').hidden=true;fs.textContent='Salva il costo';['cm-f-imp','cm-f-descr','cm-f-forn','cm-f-num'].forEach(function(i){$(i).value='';});}
if(fs)fs.addEventListener('click',function(){var msg=$('cm-f-msg');var chi=chiDi('cm-f-chi',msg);if(!chi)return;
var imp=numero($('cm-f-imp').value),descr=$('cm-f-descr').value.trim(),dt=$('cm-f-data').value;
$('cm-f-imp').classList.toggle('manca',!imp);$('cm-f-descr').classList.toggle('manca',!descr);$('cm-f-data').classList.toggle('manca',!dt);
if(!imp||!descr||!dt){msg.className='cm-msg';msg.textContent='Servono la data, che cosa è e l’importo + IVA (per esempio 1.234,50).';return;}
fs.disabled=true;msg.className='cm-msg ok';msg.textContent='Salvo…';
invia('manuale_salva',{id:$('cm-f-id').value,data:dt,categoria:$('cm-f-cat').value,fornitore:$('cm-f-forn').value.trim(),descrizione:descr,numero:$('cm-f-num').value.trim(),importo:imp,autore:chi}).then(function(r){
if(r&&r.esito==='ok'){msg.textContent='Salvato.';location.hash='manuali';location.reload();return;}fs.disabled=false;msg.className='cm-msg';msg.textContent=(r&&r.messaggio)||'Non sono riuscito a salvare: riprova.';}).catch(function(){fs.disabled=false;msg.className='cm-msg';msg.textContent='Il servizio non risponde: riprova tra un minuto.';});});
var an=$('cm-f-annulla');if(an)an.addEventListener('click',svuota);
function voceM(id){for(var i=0;i<CFG.manuali.length;i++){if(CFG.manuali[i].id===id)return CFG.manuali[i];}return null;}
Array.prototype.forEach.call(D.querySelectorAll('[data-mod]'),function(b){b.addEventListener('click',function(){var x=voceM(b.getAttribute('data-mod'));if(!x)return;
$('cm-f-id').value=x.id;$('cm-f-data').value=x.data||'';$('cm-f-cat').value=x.categoria;$('cm-f-forn').value=x.fornitore||'';$('cm-f-descr').value=x.descrizione||'';$('cm-f-num').value=x.numero||'';
$('cm-f-imp').value=String(x.importo==null?'':x.importo).replace('.',',');$('cm-f-tit').textContent='Modifica il costo';$('cm-f-annulla').hidden=false;fs.textContent='Salva la modifica';$('cm-f').scrollIntoView({behavior:'smooth',block:'center'});});});
var dlg=$('cm-t-dlg'),daTogliere='';
Array.prototype.forEach.call(D.querySelectorAll('[data-tog]'),function(b){b.addEventListener('click',function(){var x=voceM(b.getAttribute('data-tog'));if(!x)return;daTogliere=x.id;
$('cm-t-txt').textContent='«'+x.descrizione+'»: resta registrato come tolto, con il tuo nome.';$('cm-t-msg').textContent='';if(dlg.showModal)dlg.showModal();else dlg.setAttribute('open','');});});
var ts=$('cm-t-si');if(ts)ts.addEventListener('click',function(){var msg=$('cm-t-msg');var chi=chiDi('cm-t-chi',msg);if(!chi)return;ts.disabled=true;
invia('manuale_togli',{id:daTogliere,motivo:$('cm-t-mot').value.trim(),autore:chi}).then(function(r){if(r&&r.esito==='ok'){location.hash='manuali';location.reload();return;}ts.disabled=false;msg.className='cm-msg';msg.textContent=(r&&r.messaggio)||'Non sono riuscito a toglierlo: riprova.';}).catch(function(){ts.disabled=false;msg.className='cm-msg';msg.textContent='Il servizio non risponde: riprova tra un minuto.';});});
if(location.hash){var t=D.querySelector(location.hash);if(t&&t.tagName==='DETAILS')t.open=true;}
}catch(e){}})();`;

// ---------------------------------------------------------------------------- per il banco di prova
export function costiPaginaProva(base, h, p, d) { return pagina(base, h, p, d, base + "/?t=" + p.tok + "&c=" + p.c, base + "/?t=" + p.tok); }
export function costiRiepilogoProva(base, h, p, d) { return riepilogo(base, h, p, d, base + "/?t=" + p.tok); }
