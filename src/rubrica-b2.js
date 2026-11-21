// ============================================================================
// «SALVA IN RUBRICA» nelle sezioni della chat B2 (21/11/2026, salva-rubrica-b2-1). Regola di Filippo del 21/11
// («tassativamente sempre»): chi si scrive a mano e non è nella Rubrica si può salvare in Rubrica con i suoi dati.
// Primo blocco (ok di Filippo «Si salva in rubrica in due blocchi»): DDT da Excel (fornitore), Economie (impresa
// subappaltatrice), «Aggiungi a questo giorno» (fornitore del DDT), Rapportini (squadra o impresa).
// Riquadro e controlli: il modulo comune della B1 (src/salva-rubrica.js), senza copie.
// Elenco e salvataggio: POST {base}/giornale/rubrica { t, c, azione: "elenco" | "salva", dati } → rubrica_da_sezione della B13
// con la sezione «agenda»: queste pagine usano lo stesso accesso dell'Agenda (_agenda_accesso), quindi stesso controllo
// del gettone e del cantiere, stessi doppioni, stessa rubrica_salva.
// Nel browser: b2Aggancia({ campo, base, t, c, modo, rapporto, dopoDi, dopo }) — come srAggancia, con elenco e salvataggio già messi.
// ============================================================================

import { SALVA_RUBRICA_CSS, SALVA_RUBRICA_JS } from "./salva-rubrica.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function jsonRisposta(oggetto, stato) {
  return new Response(JSON.stringify(oggetto), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

export async function portaleRubricaB2(request, env, h) {
  if (env.SALVA_RUBRICA_B2 === "off") return jsonRisposta({ esito: "spento" }, 404);
  if (!env.SUPABASE_SERVICE_KEY) return jsonRisposta({ esito: "non_configurato" }, 503);
  if (request.method !== "POST") return jsonRisposta({ esito: "metodo_non_consentito" }, 405);
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return jsonRisposta({ esito: "errore" }, 415);
  let b;
  try { const t = await request.text(); if (t.length > 20000) return jsonRisposta({ esito: "errore" }, 413); b = JSON.parse(t); } catch (e) { b = null; }
  if (!b || typeof b !== "object") return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  const t = String(b.t || "").toLowerCase();
  const c = String(b.c || "").toLowerCase();
  const azione = String(b.azione || "");
  if (!/^[0-9a-f]{64}$/.test(t)) return jsonRisposta({ esito: "gettone" }, 403);
  if (!UUID.test(c) || (azione !== "elenco" && azione !== "salva")) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  let dati = {};
  if (azione === "salva") {
    const x = b.dati && typeof b.dati === "object" ? b.dati : {};
    const s = (k, n) => String(x[k] == null ? "" : x[k]).trim().slice(0, n);
    dati = { impresa: s("impresa", 120), nome: s("nome", 120), tipo_rapporto: s("tipo_rapporto", 20).toLowerCase(), telefono: s("telefono", 40),
      email: s("email", 160).toLowerCase(), partita_iva: s("partita_iva", 20), note: s("note", 500) };
  }
  const r = await h.rpc(env, "rubrica_da_sezione", { p_token: t, p_commessa: c, p_sezione: "agenda", p_azione: azione, p_dati: dati }, 15000).catch(() => null);
  if (r === null || typeof r !== "object") return jsonRisposta({ esito: "incerto" }, 502);
  return jsonRisposta(r, r.esito === "gettone" ? 403 : 200);
}

// Una sola volta per pagina (il Diario ha più finestre di sezioni diverse): stile in fondo al body, modulo comune, aiuto b2Aggancia.
const AIUTO_JS = String.raw`
window.b2Rubrica=function(base,t,c){if(!window._b2R)window._b2R=fetch(base+'/giornale/rubrica',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:t,c:c,azione:'elenco'})})
 .then(function(r){return r.json();}).then(function(r){var s={};if(r&&r.esito==='ok')(r.nomi||[]).forEach(function(x){s[srNorm(x)]=1;});else s=null;return s;}).catch(function(){return null;});return window._b2R;};
window.b2Aggancia=function(o){if(typeof srAggancia!=='function'||!o||!o.campo)return null;
 var noto={},pronto=false;
 var a=srAggancia({campo:o.campo,base:o.base,t:o.t,c:o.c,sezione:'agenda',modo:o.modo||'ditta',rapporto:o.rapporto||'fornitore',dopoDi:o.dopoDi,
  conosciuto:function(x){if(!pronto)return true;var n=srNorm(x);return !!noto[n]||(o.anche&&o.anche(n));},
  salva:function(d){return fetch(o.base+'/giornale/rubrica',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:o.t,c:o.c,azione:'salva',dati:d})}).then(function(r){return r.json().catch(function(){return{esito:'errore'};});});},
  dopo:function(k,es){[k&&k.impresa,k&&k.nome].forEach(function(x){if(x)noto[srNorm(x)]=1;});if(o.dopo)try{o.dopo(k,es);}catch(e){}}});
 window.b2Rubrica(o.base,o.t,o.c).then(function(s){if(!s)s={};noto=Object.assign({},s,noto);pronto=true;if(a)a.aggiorna();});
 return a;};`;

export function rubricaB2Iniezione() {
  const css = SALVA_RUBRICA_CSS + ".sr-box{color:#23302A}";
  return "<script>if(!window.b2Aggancia){" + SALVA_RUBRICA_JS +
    "\nwindow.srAggancia=srAggancia;window.srNorm=srNorm;" +
    "(function(){var s=document.createElement('style');s.textContent=" + JSON.stringify(css) + ";(document.body||document.documentElement).appendChild(s);})();" +
    AIUTO_JS + "}</script>";
}
