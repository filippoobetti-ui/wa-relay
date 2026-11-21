// ============================================================================
// «SALVA IN RUBRICA» NEL MODULO «NUOVO CANTIERE» (21/11/2026, nuovo-cantiere-rubrica-1, chat B15).
// Regola di Filippo del 21/11 («tassativamente sempre»): chi si scrive a mano e non è nella Rubrica si può salvare.
// Qui: Committente, Direttore dei Lavori e referente di cantiere (decisione di Filippo del 21/11; il campo
// «Imprese e subappaltatori previsti» resta com'è). Riquadro e modulo sono quelli comuni della B1 (src/salva-rubrica.js);
// il salvataggio passa da rubrica_da_sezione della B13 con la sezione 'nuovo_cantiere' (il cantiere non esiste ancora:
// conta l'impresa dell'accesso o, con «Tutte le aziende», quella scelta con ?a=).
//   POST /nuovo-cantiere/rubrica {t, a, azione: "elenco" | "salva", dati}
// L'invio del modulo del cantiere (Make) non cambia. NC_RUBRICA = "off" nel Worker spegne la rotta (il modulo resta com'era).
// ============================================================================

function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: {
    "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
function corto(x, max) { return x == null ? "" : String(x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function ncRubricaApi(request, env, h) {
  if (env.NC_RUBRICA === "off") return json({ esito: "spento" });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  if (!env.SUPABASE_SERVICE_KEY) return json({ esito: "errore" }, 503);
  let b = null;
  try { b = await request.json(); } catch (e) { b = null; }
  const tok = (String(b && b.t || "").match(/^[0-9a-fA-F]{64}$/) || [""])[0].toLowerCase();
  const az = String(b && b.azione || "");
  const a = String(b && b.a || "").toLowerCase();
  if (!tok) return json({ esito: "gettone" }, 400);
  if (az !== "elenco" && az !== "salva") return json({ esito: "errore" }, 400);
  const d = b && b.dati && typeof b.dati === "object" ? b.dati : {};
  const dati = { azienda_id: UUID.test(a) ? a : "" };
  if (az === "salva") {
    dati.nome = corto(d.nome, 120);
    dati.impresa = corto(d.impresa, 120);
    dati.tipo_rapporto = corto(d.tipo_rapporto, 30);
    dati.telefono = corto(d.telefono, 40);
    dati.email = corto(d.email, 160);
    dati.partita_iva = corto(d.partita_iva, 20);
    dati.note = corto(d.note, 500);
  }
  const r = await h.rpc(env, "rubrica_da_sezione",
    { p_token: tok, p_commessa: "", p_sezione: "nuovo_cantiere", p_azione: az, p_dati: dati }, 15000).catch(() => null);
  return json(r || { esito: "errore" }, r ? 200 : 503);
}

// Le regole della pagina (button a tutta larghezza, margini delle label) non devono toccare il riquadro comune.
export const NC_RUBRICA_CSS =
  "#modulo-nc .sr-btn{display:inline-flex;width:auto;margin:4px 6px 0 0;padding:0 14px;font-size:.88rem;min-height:36px}" +
  "#modulo-nc .sr-btn:not(.sr-pr){background:#fff;color:#23302A;border:1px solid #c9d1cc}" +
  "#modulo-nc .sr-grid label{margin:0}#modulo-nc .sr-grid input,#modulo-nc .sr-grid select{margin:0}";

// Nel browser, dopo SALVA_RUBRICA_JS e dopo lo script del modulo (PORTALE_NC_SCRIPT). Serve GL_NC_RUB = {base, t, a}.
// Se l'elenco della Rubrica non arriva (rotta spenta, sezione non disponibile) il modulo resta esattamente com'era.
export const NC_RUBRICA_JS = String.raw`(function(){try{
var R=typeof GL_NC_RUB!=='undefined'?GL_NC_RUB:null;if(!R||typeof srAggancia!=='function')return;
var f=document.getElementById('modulo-nc');if(!f)return;
// Invio dentro il riquadro della Rubrica: non deve spedire il modulo del cantiere
f.addEventListener('keydown',function(ev){var x=ev.target;if(ev.key==='Enter'&&x&&x.closest&&x.closest('.sr-box'))ev.preventDefault();},true);
function api(azione,dati){return fetch(R.base+'/nuovo-cantiere/rubrica',{method:'POST',headers:{'Content-Type':'application/json'},
 body:JSON.stringify({t:R.t,a:R.a,azione:azione,dati:dati||{}})}).then(function(r){return r.json().catch(function(){return{esito:'errore'};});});}
api('elenco').then(function(r){if(!r||r.esito!=='ok')return;
 var NOMI={},MAIL={};(r.nomi||[]).forEach(function(x){NOMI[srNorm(x)]=1;});(r.email||[]).forEach(function(x){MAIL[srNorm(x)]=1;});
 // il referente di cantiere di solito è un dipendente dell'impresa: la voce si aggiunge solo in questa pagina
 if(typeof SR_RAPP!=='undefined'&&!SR_RAPP.some(function(x){return x[0]==='dipendente';}))SR_RAPP.splice(5,0,['dipendente','Dipendente dell\'impresa']);
 var lista=document.createElement('datalist');lista.id='nc-rub-nomi';
 lista.innerHTML=(r.nomi||[]).map(function(x){return '<option value="'+srEsc(x)+'">';}).join('');f.appendChild(lista);
 function ricorda(k){if(!k)return;if(k.nome)NOMI[srNorm(k.nome)]=1;if(k.impresa)NOMI[srNorm(k.impresa)]=1;if(k.email)MAIL[srNorm(k.email)]=1;}
 function salva(dati){return api('salva',dati);}
 function noto(x){return !!NOMI[srNorm(x)];}
 var co=f.elements['committente'],dl=f.elements['direttore_lavori'],rn=f.elements['referente_nome'],re=f.elements['referente_email'],rt=f.elements['referente_telefono'];
 [co,dl,rn].forEach(function(x){if(x&&x.tagName==='INPUT')x.setAttribute('list','nc-rub-nomi');});
 if(co)srAggancia({campo:co,modo:'persona',rapporto:'esterno',sezione:'nuovo_cantiere',conosciuto:noto,salva:salva,dopo:ricorda});
 if(dl)srAggancia({campo:dl,modo:'persona',rapporto:'professionista',sezione:'nuovo_cantiere',conosciuto:noto,salva:salva,dopo:ricorda});
 if(rn){var o=srAggancia({campo:rn,modo:'persona',rapporto:'dipendente',sezione:'nuovo_cantiere',
   conosciuto:function(x){return noto(x)||!!(re&&re.value.trim()&&MAIL[srNorm(re.value)]);},salva:salva,
   dopo:function(k){ricorda(k);if(re&&!re.value.trim()&&k&&k.email)re.value=k.email;if(rt&&!rt.value.trim()&&k&&k.telefono)rt.value='+'+String(k.telefono).replace(/^\+/,'');}});
  // nel modulo della Rubrica entrano da soli l'email e il cellulare già scritti per il referente
  if(o&&o._box)o._box.addEventListener('click',function(ev){var b=ev.target&&ev.target.closest&&ev.target.closest('[data-sr="apri"]');if(!b)return;
   setTimeout(function(){var g=function(k){return o._box.querySelector('[data-sf="'+k+'"]');};
    if(re&&g('email')&&!g('email').value)g('email').value=re.value.trim();if(rt&&g('telefono')&&!g('telefono').value)g('telefono').value=rt.value.trim();},0);});}
}).catch(function(){});
}catch(e){}})();`;
