// ============================================================================
// ECONOMIE DEI SUBAPPALTATORI — area riservata (29/10/2026, richiesta di Filippo; NON pubblicato).
// Le ore in economia scritte su WhatsApp dai subappaltatori (e dagli autonomi) sono lavori extra per l'impresa,
// non per il committente: qui si vedono per mese e per impresa, si stampa la lista mensile da firmare e, se l'impresa
// rifattura il lavoro al committente, si riporta anche nella lista settimanale per il committente.
//   GET  /economie?t=<gettone>&c=<cantiere>&mese=AAAA-MM&impresa=<nome>  → pagina
//   GET  /economie/stampa?t=…&c=…&mese=…&impresa=…                         → lista mensile da stampare o salvare in PDF
//   POST /economie/riporta  {t, c, id, si}                                 → riporta o togli dalla lista del committente
// Il database decide tutto (RPC economie_impresa_portale ed economia_riporta). Si spegne con ECONOMIE_SUB = "off".
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MESE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

function num(x) {
  const n = Number(x);
  if (!isFinite(n)) return "-";
  return (Math.round(n * 100) / 100).toString().replace(".", ",");
}

function parametri(inUrl) {
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  const mese = MESE.test(inUrl.searchParams.get("mese") || "") ? inUrl.searchParams.get("mese") : "";
  const impresa = String(inUrl.searchParams.get("impresa") || "").slice(0, 200);
  return { tok: m ? m[0].toLowerCase() : "", c, mese, impresa };
}

// gli ultimi 12 mesi, dal più recente
function mesiRecenti() {
  const oggi = new Date(), out = [];
  for (let k = 0; k < 12; k++) {
    const d = new Date(oggi.getFullYear(), oggi.getMonth() - k, 1);
    out.push({ v: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"), t: MESI[d.getMonth()] + " " + d.getFullYear() });
  }
  return out;
}

export async function portaleEconomie(request, env, base, inUrl, h) {
  if (env.ECONOMIE_SUB === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const percorso = inUrl.pathname.replace(/\/+$/, "");

  if (percorso.endsWith("/economie/riporta")) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    let d = null;
    try { d = await request.json(); } catch (e) { d = null; }
    const tok = String(d && d.t || "").match(/^[0-9a-fA-F]{64}$/) ? String(d.t).toLowerCase() : "";
    const c = String(d && d.c || "").toLowerCase();
    const id = String(d && d.id || "").toLowerCase();
    if (!tok || !UUID.test(c) || !UUID.test(id)) return json({ esito: "errore" }, 400);
    const r = await h.rpc(env, "economia_riporta", { p_token: tok, p_commessa: c, p_id: id, p_si: !!(d && d.si) }, 15000).catch(() => null);
    return json(r || { esito: "errore" }, r ? 200 : 503);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const p = parametri(inUrl);
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!UUID.test(p.c)) return Response.redirect(inUrl.origin + base + "/?t=" + p.tok, 303);
  const torna = base + "/?t=" + p.tok + "&c=" + p.c;

  // prima l'elenco delle imprese del mese, poi la lista di quella scelta (o della prima)
  const elenco = await h.rpc(env, "economie_impresa_portale", { p_token: p.tok, p_commessa: p.c, p_mese: p.mese, p_impresa: "" }, 15000).catch(() => null);
  if (!elenco) return h.risposta(h.foglio(base, "Economie dei subappaltatori", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", '<p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>'), 503);
  if (elenco.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (elenco.esito !== "ok") return h.risposta(h.foglio(base, "Economie dei subappaltatori", "Questa pagina non è disponibile per questo cantiere.", '<p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>'), 400);
  const mese = elenco.mese || p.mese;
  const imprese = Array.isArray(elenco.imprese) ? elenco.imprese : [];
  const scelta = p.impresa && imprese.some((x) => x.impresa === p.impresa) ? p.impresa : (imprese[0] && imprese[0].impresa) || "";
  let lista = null;
  if (scelta) lista = await h.rpc(env, "economie_impresa_portale", { p_token: p.tok, p_commessa: p.c, p_mese: mese, p_impresa: scelta }, 15000).catch(() => null);

  if (percorso.endsWith("/economie/stampa")) {
    if (!lista || lista.esito !== "ok" || typeof lista.html !== "string") {
      return h.risposta(h.foglio(base, "Lista mensile", "Nessuna lista da stampare per questo mese.", '<p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>'), 404);
    }
    const stampa = lista.html.replace("</body>", '<script>addEventListener("load",function(){setTimeout(function(){window.print();},300);});</script></body>');
    return new Response(request.method === "HEAD" ? null : stampa, { status: 200, headers: h.headers ? h.headers() : { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } });
  }

  return h.risposta(pagina(base, h, p, mese, imprese, scelta, lista, torna));
}

function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" } });
}

function pagina(base, h, p, mese, imprese, scelta, lista, torna) {
  const e = h.esc;
  const url = (m, imp) => base + "/economie?t=" + p.tok + "&c=" + p.c + "&mese=" + m + (imp ? "&impresa=" + encodeURIComponent(imp) : "");
  const opzMesi = mesiRecenti().map((m) => '<option value="' + m.v + '"' + (m.v === mese ? " selected" : "") + ">" + m.t + "</option>").join("");
  const chips = imprese.map((x) => '<a class="ec-chip' + (x.impresa === scelta ? " on" : "") + '" href="' + e(url(mese, x.impresa)) + '">' +
    e(x.impresa) + " · " + num(x.ore) + " h</a>").join("");
  const voci = lista && Array.isArray(lista.voci) ? lista.voci : [];
  const chiuso = !!(lista && lista.chiuso);
  const righe = voci.map((v) => '<div class="ec-riga" data-id="' + e(v.id) + '" data-tot="' + Number(v.totale || 0) + '">' +
    '<span class="ec-data">' + e(v.data) + "</span>" +
    '<div><p class="ec-cosa">' + e(v.descrizione || "Lavoro extra") + "</p>" +
    '<p class="ec-chi">' + e(v.squadra || "") + " · " + e(v.operai) + " operai × " + num(v.ore) + " h = " + num(v.totale) + " h</p>" +
    '<span class="ec-tag"' + (v.riportata ? "" : " hidden") + ">Anche nella lista per il committente</span></div>" +
    (chiuso ? "" : '<button type="button" class="ec-b" data-si="' + (v.riportata ? "0" : "1") + '">' +
      (v.riportata ? "Togli dalla lista del committente" : "Riporta nella lista del committente") + "</button>") + "</div>").join("");
  const vuoto = '<p class="ec-vuoto">Nessuna ora in economia dei subappaltatori in questo mese. Le ore extra che i subappaltatori scrivono su WhatsApp compaiono qui.</p>';
  const cfg = JSON.stringify({ u: base + "/economie/riporta", t: p.tok, c: p.c });
  const stampa = base + "/economie/stampa?t=" + p.tok + "&c=" + p.c + "&mese=" + mese + "&impresa=" + encodeURIComponent(scelta);

  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>Economie dei subappaltatori - TIX · Diario di cantiere</title>" + h.testa(base) +
    "<style>" +
    ":root{--t:#1b1f1d;--s:#5b6560;--b:#f4f6f5;--c:#fff;--l:#dfe5e2;--ar:#1B2F4A;--v:#1D6F42}" +
    "@media (prefers-color-scheme:dark){:root{--t:#eef2f0;--s:#a9b3ae;--b:#111513;--c:#1a201d;--l:#2c3531;--ar:#cfe0ff;--v:#7fd6a3}}" +
    "*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--b);color:var(--t)}" +
    "main{max-width:960px;margin:0 auto;padding:20px 12px 40px}.ec-torna{display:inline-block;margin:0 0 12px;color:var(--ar);font-weight:600;text-decoration:none}" +
    ".ec-card{background:var(--c);border:1px solid var(--l);border-radius:14px;padding:18px 18px 14px}" +
    ".ec-testa{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 12px}" +
    ".ec-testa p{margin:0;font-size:.88rem;color:var(--s)}.ec-testa h1{margin:2px 0 0;font-size:1.3rem;color:var(--ar)}" +
    ".ec-testa select{font:inherit;padding:8px 10px;border:1px solid var(--l);border-radius:10px;background:var(--c);color:var(--t)}" +
    ".ec-spiega{font-size:.9rem;color:var(--s);line-height:1.45;margin:0 0 12px}" +
    ".ec-chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 6px}.ec-chip{padding:6px 12px;border-radius:999px;border:1px solid var(--l);color:var(--t);text-decoration:none;font-size:.9rem;font-weight:600}" +
    ".ec-chip.on{background:var(--ar);border-color:var(--ar);color:#fff}" +
    ".ec-riga{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 0;border-top:1px solid var(--l)}" +
    ".ec-data{font-size:.88rem;color:var(--s)}.ec-cosa{margin:0;font-weight:600}.ec-chi{margin:2px 0 0;font-size:.84rem;color:var(--s)}" +
    ".ec-tag{display:inline-block;margin-top:5px;font-size:.8rem;font-weight:700;padding:2px 10px;border-radius:999px;background:#E8F4EC;color:#1D6F42}" +
    ".ec-tag[hidden]{display:none}" +
    ".ec-b{min-height:40px;padding:0 14px;border-radius:10px;border:1px solid var(--l);background:var(--c);color:var(--t);font:inherit;font-size:.88rem;font-weight:600;cursor:pointer;white-space:nowrap}" +
    ".ec-b:hover{border-color:var(--ar)}.ec-b[disabled]{opacity:.6;cursor:wait}" +
    ".ec-piede{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid var(--l);padding-top:12px;margin-top:2px}" +
    ".ec-piede p{margin:0;font-size:.95rem}.ec-pdf{display:inline-flex;align-items:center;min-height:42px;padding:0 16px;border-radius:10px;background:var(--ar);color:#fff;font-weight:700;text-decoration:none}" +
    ".ec-vuoto{color:var(--s);margin:10px 0}.ec-msg{font-size:.88rem;color:#b3261e;margin:8px 0 0}.ec-msg:empty{display:none}" +
    "@media (max-width:620px){.ec-riga{grid-template-columns:44px minmax(0,1fr)}.ec-b{grid-column:1/3;width:100%}}" +
    "</style></head><body><main>" +
    '<a class="ec-torna" href="' + e(torna) + '">‹ Torna al cantiere</a>' +
    '<div class="ec-card"><div class="ec-testa"><div><p>' + e((lista && lista.cantiere) || "") + (lista && lista.impresa_cliente ? " · " + e(lista.impresa_cliente) : "") + "</p>" +
    "<h1>Economie dei subappaltatori</h1></div>" +
    '<form method="get" action="' + e(base + "/economie") + '"><input type="hidden" name="t" value="' + e(p.tok) + '"><input type="hidden" name="c" value="' + e(p.c) + '">' +
    '<select name="mese" aria-label="Mese" onchange="this.form.submit()">' + opzMesi + "</select></form></div>" +
    '<p class="ec-spiega">Lavori extra fatti dai subappaltatori per l\'impresa, fuori dal contratto di subappalto. Non entrano nella lista per il committente: se un lavoro lo fate pagare anche al committente, premete «Riporta nella lista del committente». Vale per le liste settimanali che devono ancora uscire.</p>' +
    (imprese.length ? '<div class="ec-chips">' + chips + "</div>" : "") +
    '<div id="ec-righe">' + (voci.length ? righe : vuoto) + "</div>" +
    (voci.length ? '<div class="ec-piede"><p>Totale del mese: <b>' + num(lista.ore) + ' h</b> · riportate al committente: <b id="ec-rip">' + num(lista.ore_riportate || 0) + " h</b></p>" +
      '<a class="ec-pdf" href="' + e(stampa) + '" target="_blank" rel="noopener">Stampa o salva la lista in PDF</a></div>' : "") +
    '<p class="ec-msg" id="ec-msg" aria-live="polite"></p></div></main>' +
    "<script>(function(){var CFG=" + cfg + ";" +
    "var msg=document.getElementById('ec-msg'),rip=document.getElementById('ec-rip');" +
    "function totale(){var t=0;document.querySelectorAll('.ec-riga').forEach(function(r){if(!r.querySelector('.ec-tag').hidden)t+=Number(r.getAttribute('data-tot'))||0;});if(rip)rip.textContent=(Math.round(t*100)/100).toString().replace('.',',')+' h';}" +
    "document.querySelectorAll('.ec-b').forEach(function(b){b.addEventListener('click',function(){" +
    "var r=b.closest('.ec-riga'),si=b.getAttribute('data-si')==='1';b.disabled=true;msg.textContent='';" +
    "fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,id:r.getAttribute('data-id'),si:si})})" +
    ".then(function(x){return x.json();}).then(function(j){b.disabled=false;if(!j||j.esito!=='ok'){msg.textContent='Non è stato possibile salvare la scelta. Riprova tra qualche minuto.';return;}" +
    "r.querySelector('.ec-tag').hidden=!si;b.setAttribute('data-si',si?'0':'1');b.textContent=si?'Togli dalla lista del committente':'Riporta nella lista del committente';totale();})" +
    ".catch(function(){b.disabled=false;msg.textContent='Non è stato possibile salvare la scelta. Riprova tra qualche minuto.';});});});})();</script>" +
    "</body></html>";
}

// Pulsante nella pagina del cantiere, accanto a «Scarica in Excel».
export function economieIniezione(base, token, commessa) {
  const u = base + "/economie?t=" + token + "&c=" + encodeURIComponent(commessa);
  return "<style>.gl-ec-b{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:0 16px;margin-left:8px;border:1px solid #1B2F4A;border-radius:10px;background:#EEF2F8;color:#1B2F4A;font-size:.92rem;font-weight:700;text-decoration:none}" +
    ".gl-ec-b:hover,.gl-ec-b:focus-visible{background:#1B2F4A;color:#fff;outline:none}" +
    "@media (prefers-color-scheme:dark){.gl-ec-b{background:#1d2633;color:#cfe0ff;border-color:#3a4a63}}</style>" +
    "<script>(function(){try{var a=document.createElement('a');a.className='gl-ec-b';a.href=" + JSON.stringify(u) + ";a.textContent='Economie dei subappaltatori';" +
    "function metti(){var x=document.querySelector('.gl-xl-barra');if(x){x.appendChild(a);return true;}var nav=document.querySelector('nav.schede');" +
    "if(nav&&nav.parentNode){var d=document.createElement('div');d.className='gl-xl-barra';d.style.cssText='max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right';d.appendChild(a);nav.parentNode.insertBefore(d,nav.nextSibling);return true;}return false;}" +
    "if(!metti())document.addEventListener('DOMContentLoaded',metti);}catch(e){}})();</script>";
}
