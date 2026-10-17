// ---------------------------------------------------------------------------
// Cestino dell'area riservata (17/10/2026, richiesta di Filippo): l'ufficio toglie voci, foto, DDT,
// rapportini e presenze di prova PRIMA della pubblicazione alla Direzione Lavori.
// - Nulla si cancella: la voce passa in public.giornale_voci_annullate (annulla_voce_giornale) o la
//   timbratura viene marcata annullata; dal «Cestino» si ripristina tutto.
// - Solo area riservata: la verifica la fa il database (cestino_verifica: gettone attivo di
//   dashboard_accessi + commessa dell'azienda). Le funzioni cestino_* si eseguono solo con la chiave di servizio.
// - Il relay non conserva nulla: riceve la richiesta del browser, la gira al database e restituisce l'esito.
// Rollback: vedi claude/log-cestino-17-10-2026.md (script SQL + revert del commit).
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CESTINO_AZIONI = { sposta: "cestino_sposta", elenco: "cestino_elenco", ripristina: "cestino_ripristina" };

function jsonRisposta(oggetto, stato) {
  return new Response(JSON.stringify(oggetto), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

// POST {base}/cestino  — corpo JSON { t, c, azione: "sposta"|"elenco"|"ripristina", tipo, ref, motivo }
export async function portaleCestino(request, env, rpc) {
  if (request.method !== "POST") return jsonRisposta({ esito: "metodo_non_consentito" }, 405);
  if (!env.SUPABASE_SERVICE_KEY) return jsonRisposta({ esito: "non_configurato" }, 503);
  let b;
  try { b = await request.json(); } catch (e) { return jsonRisposta({ esito: "richiesta_non_valida" }, 400); }
  const t = String((b && b.t) || "").toLowerCase();
  const c = String((b && b.c) || "").toLowerCase();
  const nome = CESTINO_AZIONI[b && b.azione];
  if (!/^[0-9a-f]{64}$/.test(t) || !UUID.test(c) || !nome) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);

  let corpo;
  if (b.azione === "elenco") {
    corpo = { p_token: t, p_commessa: c };
  } else {
    const tipo = String(b.tipo || "");
    const ref = String(b.ref || "").slice(0, 300);
    if ((tipo !== "voce" && tipo !== "timbratura" && tipo !== "agenda") || !ref) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
    if (tipo === "timbratura" && !UUID.test(ref)) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
    if (tipo === "agenda" && !/^[0-9]{1,15}$/.test(ref)) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
    corpo = { p_token: t, p_commessa: c, p_tipo: tipo, p_ref: ref };
    if (b.azione === "sposta") corpo.p_motivo = String(b.motivo || "").slice(0, 200);
  }
  const r = await rpc(env, nome, corpo);
  if (r === null || typeof r !== "object") return jsonRisposta({ esito: "errore" }, 502);
  return jsonRisposta(r);
}

// Stile e script iniettati nella pagina del cantiere (area riservata). base = "" oppure "/portale".
export function cestinoIniezione(base, token, commessa) {
  const cfg = JSON.stringify({ u: base + "/cestino", t: token, c: commessa });
  const stile = "<style>" +
    ".gl-ct-b{position:absolute;top:6px;right:6px;z-index:3;width:30px!important;height:30px!important;min-width:0!important;min-height:0!important;padding:0!important;border-radius:50%;border:1px solid #c9d1cd;background:rgba(255,255,255,.94);color:#8a2b2b;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;font-size:15px;line-height:1;box-shadow:0 1px 3px rgba(0,0,0,.2)}" +
    ".gl-ct-b:hover,.gl-ct-b:focus-visible{background:#fff1f1;border-color:#c0392b;outline:none}" +
    ".gl-ct-p{position:relative}" +
    ".gl-ct-vai{display:block;max-width:720px;margin:14px auto 0;padding:0 16px;text-align:center;font-family:system-ui,-apple-system,sans-serif;font-size:.9rem}" +
    ".gl-ct-vai button{display:inline-block!important;width:auto!important;min-width:0!important;max-width:max-content!important;min-height:0!important;flex:none!important;margin:0!important;background:#fdecec;border:2px solid #c62828;border-radius:999px;padding:4px 14px!important;color:#c62828;font-family:inherit;font-size:1.1rem;font-weight:800;cursor:pointer;box-shadow:0 1px 4px rgba(198,40,40,.25)}.gl-ct-vai button:hover,.gl-ct-vai button:focus-visible{background:#c62828;color:#fff;outline:none}" +
    ".gl-ct-ov{position:fixed;inset:0;z-index:9999;background:rgba(10,18,28,.55);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".gl-ct-bx{background:#fff;color:#1b1f1d;border-radius:14px;max-width:460px;width:100%;max-height:86vh;overflow:auto;padding:20px 20px 16px;box-shadow:0 10px 40px rgba(0,0,0,.35)}" +
    ".gl-ct-bx h3{margin:0 0 8px;font-size:1.1rem;color:#1B2F4A}.gl-ct-bx p{margin:0 0 12px;font-size:.92rem;line-height:1.45}" +
    ".gl-ct-bx .anteprima{background:#f4f6f5;border-radius:8px;padding:8px 10px;font-size:.85rem;margin:0 0 12px;word-break:break-word}" +
    ".gl-ct-bx label{display:block;font-size:.85rem;font-weight:600;margin:0 0 4px}" +
    ".gl-ct-bx input[type=text]{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #c9d1cd;border-radius:8px;font:inherit;font-size:.95rem;margin:0 0 14px;background:#fff;color:#1b1f1d}" +
    ".gl-ct-az{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}" +
    ".gl-ct-az button{padding:10px 16px;border-radius:10px;border:1px solid #c9d1cd;background:#fff;color:#1b1f1d;font:inherit;font-weight:600;cursor:pointer}" +
    ".gl-ct-az button.pr{background:#8a2b2b;border-color:#8a2b2b;color:#fff}.gl-ct-az button[disabled]{opacity:.55;cursor:wait}" +
    ".gl-ct-avv{background:#fff7e6;border:1px solid #f0c36a;border-radius:8px;padding:8px 10px;font-size:.85rem;margin:0 0 12px}" +
    ".gl-ct-err{color:#a11;font-size:.88rem;margin:0 0 10px}" +
    ".gl-ct-el{border-top:1px solid #e3e8e5;padding:10px 0;display:flex;gap:10px;align-items:flex-start}.gl-ct-el:first-of-type{border-top:0}" +
    ".gl-ct-el .tx{flex:1;font-size:.88rem;word-break:break-word}.gl-ct-el .tx small{display:block;color:#5b6560;margin-top:2px}" +
    ".gl-ct-el button{padding:7px 12px;border-radius:8px;border:1px solid #1B2F4A;background:#fff;color:#1B2F4A;font:inherit;font-size:.85rem;font-weight:600;cursor:pointer;white-space:nowrap}" +
    "@media (prefers-color-scheme:dark){.gl-ct-b{background:rgba(26,32,29,.94);border-color:#3a4540;color:#ff9a9a}.gl-ct-b:hover{background:#3a1c1c}.gl-ct-bx{background:#1a201d;color:#eef2f0}.gl-ct-bx h3{color:#cfe0ff}.gl-ct-bx .anteprima{background:#232b27}.gl-ct-bx input[type=text]{background:#111513;color:#eef2f0;border-color:#3a4540}.gl-ct-az button{background:#232b27;color:#eef2f0;border-color:#3a4540}.gl-ct-az button.pr{background:#b23b3b;border-color:#b23b3b;color:#fff}.gl-ct-avv{background:#3a2f12;border-color:#7a6320}.gl-ct-el{border-color:#2c3531}.gl-ct-el button{background:#232b27;color:#cfe0ff;border-color:#5c7aa8}.gl-ct-vai button{background:#3a1c1c;border-color:#ff6b6b;color:#ff8a8a}.gl-ct-vai button:hover,.gl-ct-vai button:focus-visible{background:#ff6b6b;color:#1a0f0f}}" +
    "</style>";
  const script = "<script>" + String.raw`(function(){try{
var CFG=` + cfg + String.raw`;
var NOMI={voce:'la voce',timbratura:'la presenza'};
function el(t,c,h){var e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(x){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x];});}
function chiama(corpo){corpo.t=CFG.t;corpo.c=CFG.c;return fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(corpo)}).then(function(r){return r.json();});}
function chiudi(ov){if(ov&&ov.parentNode)ov.parentNode.removeChild(ov);}
function finestra(){var ov=el('div','gl-ct-ov'),bx=el('div','gl-ct-bx');ov.appendChild(bx);ov.addEventListener('click',function(e){if(e.target===ov)chiudi(ov);});document.body.appendChild(ov);return {ov:ov,bx:bx};}
function anteprimaDi(n){var t=(n.innerText||n.textContent||'').replace(/\uD83D\uDDD1/g,'').replace(/\s+/g,' ').trim();if(!t&&n.querySelector('img'))t='Foto';return t.length>160?t.slice(0,160)+'…':t;}
function conferma(tipo,ref,nodi){
 var w=finestra(),bx=w.bx;
 bx.innerHTML='<h3>Spostare nel cestino?</h3><p>'+(tipo==='agenda'?'Verrà tolto dall\'agenda e dal calendario. Non partirà nessun avviso WhatsApp.':'Verrà tolto da giornale, rapportini, DDT, foto e documenti.')+' Non viene cancellato: dal <b>Cestino</b> in fondo alla pagina potrai ripristinarlo.</p>'+
  '<div class="anteprima">'+esc(anteprimaDi(nodi[0]))+'</div>'+
  '<label for="gl-ct-mot">Motivo (facoltativo)</label><input type="text" id="gl-ct-mot" maxlength="150" placeholder="es. foto di prova">'+
  '<div class="gl-ct-err" style="display:none"></div><div class="gl-ct-az"><button type="button" class="an">Annulla</button><button type="button" class="pr">Sposta nel cestino</button></div>';
 var err=bx.querySelector('.gl-ct-err'),pr=bx.querySelector('.pr');
 bx.querySelector('.an').onclick=function(){chiudi(w.ov);};
 pr.onclick=function(){
  pr.disabled=true;err.style.display='none';
  chiama({azione:'sposta',tipo:tipo,ref:ref,motivo:bx.querySelector('#gl-ct-mot').value}).then(function(r){
   if(r&&r.esito==='ok'){
    nodi.forEach(function(n){n.style.display='none';});
    var avv=r.consolidato_gia_emesso, ncr=Number(r.crono_effetti)||0;
    var haAvv=avv&&(avv===true||(Array.isArray(avv)&&avv.length)||typeof avv==='object');
    if(haAvv||ncr>0){
     bx.innerHTML='<h3>Spostato nel cestino</h3>'+(haAvv?'<div class="gl-ct-avv"><b>Attenzione:</b> il giornale di quel giorno era già stato emesso in PDF. Il PDF già emesso non cambia: va rigenerato dall\'ufficio prima di inviarlo alla Direzione Lavori.</div>':'')+(ncr>0?'<div class="gl-ct-avv"><b>Cronoprogramma:</b> questa voce aveva aggiornato l\'avanzamento ('+ncr+(ncr===1?' registrazione':' registrazioni')+'). Le date reali e le percentuali del cronoprogramma non sono state toccate: se non sono corrette, vanno sistemate dall\'ufficio.</div>':'')+'<div class="gl-ct-az"><button type="button" class="pr">Ho capito</button></div>';
     bx.querySelector('.pr').onclick=function(){chiudi(w.ov);};
    }else chiudi(w.ov);
   }else{
    pr.disabled=false;
    err.textContent=r&&r.esito==='non_trovata'?'Elemento non trovato (forse già rimosso). Ricarica la pagina.':(r&&r.esito==='non_autorizzato'?'Collegamento non valido o scaduto.':'Operazione non riuscita. Riprova.');
    err.style.display='block';
   }
  }).catch(function(){pr.disabled=false;err.textContent='Connessione assente. Riprova.';err.style.display='block';});
 };
}
function aggiungiPulsanti(){
 var gia={};
 document.querySelectorAll('[data-mid],[data-tid],.ag[data-id]').forEach(function(n){
  var tipo=n.hasAttribute('data-tid')?'timbratura':(n.hasAttribute('data-mid')?'voce':'agenda');
  var ref=n.getAttribute(tipo==='timbratura'?'data-tid':(tipo==='voce'?'data-mid':'data-id'));
  if(!ref||n.querySelector(':scope > .gl-ct-b'))return;
  n.classList.add('gl-ct-p');
  var b=el('button','gl-ct-b','&#128465;');b.type='button';b.title='Sposta nel cestino';b.setAttribute('aria-label','Sposta nel cestino');
  b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();
   var sel=tipo==='timbratura'?'[data-tid="'+ref.replace(/"/g,'')+'"]':(tipo==='agenda'?'.ag[data-id="'+ref.replace(/"/g,'')+'"]':'[data-mid="'+ref.replace(/"/g,'')+'"]');
   conferma(tipo,ref,Array.prototype.slice.call(document.querySelectorAll(sel)));});
  n.appendChild(b);
 });
}
function apriCestino(){
 var w=finestra(),bx=w.bx;bx.innerHTML='<h3>Cestino</h3><p>Caricamento…</p>';
 chiama({azione:'elenco'}).then(function(r){
  if(!r||r.esito!=='ok'){bx.innerHTML='<h3>Cestino</h3><p>Non riesco a leggere il cestino. Riprova.</p><div class="gl-ct-az"><button type="button" class="an">Chiudi</button></div>';bx.querySelector('.an').onclick=function(){chiudi(w.ov);};return;}
  var el_=r.elementi||[];
  var h='<h3>Cestino</h3><p>'+(el_.length?'Elementi tolti dall\'area riservata. «Ripristina» li rimette dove erano.':'Il cestino è vuoto.')+'</p>';
  el_.forEach(function(x,i){h+='<div class="gl-ct-el"><div class="tx"><b>'+esc(x.sezione||x.tipo)+'</b> · '+esc(x.quando||'')+(x.con_file?' · con file':'')+'<br>'+esc(x.testo||'')+'<small>'+esc(x.motivo||'')+'</small></div><button type="button" data-i="'+i+'">Ripristina</button></div>';});
  h+='<div class="gl-ct-az"><button type="button" class="an">Chiudi</button></div>';
  bx.innerHTML=h;
  bx.querySelector('.an').onclick=function(){chiudi(w.ov);};
  bx.querySelectorAll('button[data-i]').forEach(function(bt){bt.onclick=function(){
   var x=el_[+bt.getAttribute('data-i')];bt.disabled=true;
   chiama({azione:'ripristina',tipo:x.tipo,ref:x.ref}).then(function(q){
    if(q&&q.esito==='ok'){location.reload();}else{bt.disabled=false;bt.textContent='Non riuscito';}
   }).catch(function(){bt.disabled=false;bt.textContent='Non riuscito';});
  };});
 }).catch(function(){bx.innerHTML='<h3>Cestino</h3><p>Connessione assente. Riprova.</p>';});
}
aggiungiPulsanti();
var v=el('div','gl-ct-vai','<button type="button">&#128465; Cestino</button>');
v.querySelector('button').onclick=apriCestino;
document.body.appendChild(v);
}catch(x){}})();
` + "</script>";
  return stile + script;
}
