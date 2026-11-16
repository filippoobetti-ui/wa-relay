// ============================================================================
// ABBONAMENTO E VOCI — area riservata (16/11/2026, listino-v5-1, chat B11). Listino 89 · 22 · 12 deciso da Filippo:
// 89 € + IVA al mese fino a 2 persone, +22 € dalla 3ª alla 15ª, +12 € dalla 16ª; 150 voci a persona (almeno 300);
// oltre le voci comprese si compra in anticipo il pacchetto da 150 voci a 22 € + IVA; la persona aggiunta si paga subito
// per i giorni che mancano alla fine del mese. Carta (scenario Make 8613656 → Stripe) oppure bonifico (richiesta + email a Filippo).
//   GET  /listino?t=<gettone>[&a=<impresa>]   → pagina (database: listino_v5_portale; «a» solo con l'accesso «Tutte le aziende»)
//   POST /listino/api  {t, a, azione, dati}    → carta | bonifico (listino_v5_azione)
// Interruttori: impostazioni.listino_v5_attivo (no / prova / si) e LISTINO_V5 = "off" nel Worker.
// ============================================================================
import { CAMPI_ROSSI_CSS, CAMPI_ROSSI_JS } from "./campi-rossi.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: {
    "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
function testo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function gettone(x) { const m = String(x || "").match(/^[0-9a-fA-F]{64}$/); return m ? m[0].toLowerCase() : ""; }
function impresa(x) { const a = String(x || "").toLowerCase().trim(); return UUID.test(a) ? a : ""; }
function eur(n) { const v = Number(n || 0); return v.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export async function portaleListinoV5(request, env, base, inUrl, h) {
  if (env.LISTINO_V5 === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");

  if (sotto === "/listino/api") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    let b = null;
    try { b = await request.json(); } catch (e) { b = null; }
    const tok = gettone(b && b.t), a = impresa(b && b.a), az = String(b && b.azione || "");
    if (!tok) return json({ esito: "gettone" }, 400);
    if (az !== "carta" && az !== "bonifico") return json({ esito: "errore" }, 400);
    const d = b && b.dati && typeof b.dati === "object" ? b.dati : {};
    const dati = { cosa: d.cosa === "persona" ? "persona" : "voci", quanti: testo(d.quanti, 3), persona: testo(d.persona, 200) };
    const r = await h.rpc(env, "listino_v5_azione", { p_token: tok, p_azienda: a, p_azione: az, p_dati: dati }, 20000).catch(() => null);
    return json(r || { esito: "errore" }, r ? 200 : 503);
  }

  if (sotto !== "/listino") return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const tok = gettone((String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/) || [""])[0]);
  if (!tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const a = impresa(inUrl.searchParams.get("a"));
  const torna = base + "/?t=" + tok;
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna ai cantieri</a></p>';
  const d = await h.rpc(env, "listino_v5_portale", { p_token: tok, p_azienda: a }, 15000).catch(() => null);
  if (!d) return h.risposta(h.foglio(base, "Abbonamento e voci", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Abbonamento e voci", "Questa pagina non è ancora disponibile.", indietro), 404);
  return h.risposta(pagina(base, h, tok, d, torna));
}

function pagina(base, h, tok, d, torna) {
  const e = h.esc;
  const az = d.azienda || null;
  const imprese = Array.isArray(d.imprese) ? d.imprese : [];
  const scelta = d.filippo
    ? '<form class="lv-scegli" method="get" action="' + e(base + "/listino") + '"><input type="hidden" name="t" value="' + e(tok) + '">' +
      '<label>Impresa <select name="a" onchange="this.form.submit()"><option value="">Scegli l\'impresa…</option>' +
      imprese.map((x) => '<option value="' + e(x.id) + '"' + (az && az.id === x.id ? " selected" : "") + ">" + e(x.nome) + "</option>").join("") +
      "</select></label></form>"
    : "";
  let corpo = "";
  if (az) {
    const c = d.canone || {}, v = d.voci || {}, f = d.fermi || {}, p = d.persona || {};
    const perc = Math.max(0, Math.min(100, Number(v.percentuale || 0)));
    const avviso = !d.acceso
      ? '<p class="lv-nota">Il listino nuovo non è ancora acceso per questa impresa: i numeri sono solo di prova.</p>'
      : (f.fermi
        ? '<p class="lv-fermo">' + (f.motivo === "mese_prima_da_pagare"
            ? "Le voci comprese del mese scorso sono finite: le letture con l'IA e il fascicolo del giorno sono fermi finché non compri il pacchetto."
            : "Le voci comprese di questo mese sono finite: le letture con l'IA e il fascicolo del giorno sono fermi finché non compri il pacchetto.") +
          " Il diario e il PDF della sera continuano sempre.</p>"
        : (perc >= 80 ? '<p class="lv-nota">Hai usato l\'' + perc + "% delle voci di questo mese.</p>" : ""));
    const consigliati = Math.max(1, Number(f.pacchetti_da_comprare || 1));
    corpo =
      '<section class="lv-box"><h2>Il tuo abbonamento</h2>' +
      '<p class="lv-grande">' + eur(c.canone_eur) + ' € <small>+ IVA al mese</small></p>' +
      '<p>' + e(String(c.persone || 0)) + (Number(c.persone) === 1 ? " persona" : " persone") + ' (chi ha usato TIX negli ultimi 30 giorni)' +
      (Number(c.sospese) ? " · " + e(String(c.sospese)) + " sospese per 30 giorni senza uso" : "") + '.</p>' +
      '<p class="lv-piccolo">89 € + IVA fino a 2 persone, +22 € dalla 3ª alla 15ª, +12 € dalla 16ª.</p></section>' +
      '<section class="lv-box"><h2>Voci di questo mese</h2>' +
      '<div class="lv-barra"><span style="width:' + perc + '%"></span></div>' +
      '<p><strong>' + e(String(v.voci_usate || 0)) + '</strong> usate su <strong>' + e(String(v.voci_disponibili || 0)) + '</strong> (' + perc + '%)' +
      (Number(v.voci_pacchetti) ? ", di cui " + e(String(v.voci_pacchetti)) + " con i pacchetti comprati" : "") + '.</p>' +
      '<p class="lv-piccolo">150 voci a persona, almeno 300. Ogni testo, vocale, foto o documento del diario è una voce.</p>' + avviso + '</section>' +
      '<section class="lv-box"><h2>Compra un pacchetto da ' + e(String(d.pacchetto_voci || 150)) + ' voci</h2>' +
      '<p>' + eur(d.pacchetto_eur) + ' € + IVA ciascuno, pagato subito.</p>' +
      '<label>Quanti pacchetti <input id="lv-quanti" type="number" min="1" max="50" value="' + consigliati + '"></label>' +
      '<div class="lv-pulsanti"><button data-az="carta" data-cosa="voci">Paga con carta</button><button data-az="bonifico" data-cosa="voci" class="lv-sec">Paga con bonifico</button></div></section>' +
      '<section class="lv-box"><h2>Aggiungi una persona</h2>' +
      (p.esito === "ok"
        ? (p.gratis ? "<p>Con 89 € + IVA sono già comprese 2 persone: la prossima non costa niente.</p>"
                    : "<p>" + eur(p.prezzo_mese_eur) + " € + IVA al mese. Per questo mese paghi solo i " + e(String(p.giorni)) + " giorni che mancano: <strong>" + eur(p.importo_eur) + " € + IVA</strong>.</p>")
        : "<p>Prezzo disponibile quando il listino nuovo è acceso.</p>") +
      '<label>Nome e cognome <input id="lv-persona" type="text" maxlength="200"></label>' +
      '<div class="lv-pulsanti"><button data-az="carta" data-cosa="persona">Paga con carta</button><button data-az="bonifico" data-cosa="persona" class="lv-sec">Paga con bonifico</button></div></section>' +
      (Array.isArray(d.bonifici) && d.bonifici.length
        ? '<section class="lv-box"><h2>Bonifici in attesa</h2><ul>' + d.bonifici.map((x) => "<li>" + e(x.cosa) + " · " + eur(x.importo_eur) + " € + IVA · rif. " + e(x.riferimento) + " · " + e(x.chiesto) + "</li>").join("") + "</ul></section>"
        : "") +
      '<p id="lv-esito" role="status"></p>';
  } else if (d.filippo) {
    corpo = "<p>Scegli l'impresa per vedere abbonamento e voci.</p>";
  }
  const cfg = JSON.stringify({ u: base + "/listino/api", t: tok, a: az ? az.id : "" }).replace(/</g, "\\u003c");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><title>Abbonamento e voci · TIX</title><style>' +
    'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f3f0;color:#1a1a1a;margin:0;padding:24px 16px;line-height:1.5}' +
    'main{max-width:760px;margin:0 auto}h1{font-size:22px;margin:0 0 12px;color:#14213d}h2{font-size:17px;margin:0 0 8px;color:#14213d}' +
    '.lv-box{background:#fff;border:1px solid #e0ded9;border-top:4px solid #c9a227;border-radius:8px;padding:16px 18px;margin:0 0 14px}' +
    '.lv-grande{font-size:28px;font-weight:700;margin:0 0 4px;color:#14213d}.lv-grande small{font-size:14px;font-weight:400;color:#555}' +
    '.lv-piccolo{font-size:13px;color:#666}.lv-barra{height:12px;background:#eee;border-radius:6px;overflow:hidden;margin:6px 0}' +
    '.lv-barra span{display:block;height:100%;background:linear-gradient(90deg,#14213d,#f08a24)}' +
    '.lv-nota{background:#fff8e1;border:1px solid #f0d27a;border-radius:6px;padding:8px 10px}.lv-fermo{background:#fdecea;border:1px solid #f5b5ad;border-radius:6px;padding:8px 10px}' +
    'label{display:block;margin:8px 0}input{font:inherit;padding:8px;border:1px solid #ccc;border-radius:6px;width:100%;max-width:320px;box-sizing:border-box}' +
    '.lv-pulsanti{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}button{font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:6px;background:#14213d;color:#fff;cursor:pointer}' +
    'button.lv-sec{background:#fff;color:#14213d;border:1px solid #14213d}#lv-esito{font-weight:600}.lv-scegli select{font:inherit;padding:6px}' +
    CAMPI_ROSSI_CSS + '</style></head><body><main>' +
    '<p><a href="' + e(torna) + '">← Torna ai cantieri</a></p><h1>Abbonamento e voci' + (az ? " · " + e(az.nome) : "") + '</h1>' + scelta + corpo +
    '</main><script>' + CAMPI_ROSSI_JS + '\nconst LV=' + cfg + ';\n' +
    'document.querySelectorAll("button[data-az]").forEach(function(b){b.addEventListener("click",async function(){' +
    'var es=document.getElementById("lv-esito");var cosa=b.dataset.cosa;var pers=document.getElementById("lv-persona");' +
    'if(cosa==="persona"&&!crControlla([{el:pers,testo:"Scrivi il nome e cognome della persona da aggiungere."}]))return;' +
    'var dati={cosa:cosa,quanti:(document.getElementById("lv-quanti")||{}).value||"1",persona:pers?pers.value:""};' +
    'b.disabled=true;es.textContent="Un momento…";try{var r=await fetch(LV.u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({t:LV.t,a:LV.a,azione:b.dataset.az,dati:dati})});' +
    'var j=await r.json();if(j.esito==="ok"&&j.url){location.href=j.url;return;}' +
    'if(j.campo){crSegna(document.getElementById("lv-"+j.campo),j.messaggio);}' +
    'es.textContent=j.messaggio||(j.esito==="ok"||j.esito==="gratis"?"Fatto.":"Non è stato possibile completare la richiesta.");}catch(x){es.textContent="Il servizio non risponde: riprova tra poco.";}b.disabled=false;});});' +
    '</script></body></html>';
}
