// ---------------------------------------------------------------------------
// Giornale modificabile dall'ufficio (23/10/2026, richiesta di Filippo): nella scheda «Giornale» del cantiere
// - «Correggi», rosso, accanto ad «Apri il file» (o sotto il testo se la voce non ha file);
// - «+ Aggiungi una voce di oggi» in cima alla scheda.
// Regole (le decide il database, giornale_ufficio):
// - prima della chiusura del diario (22:00 del giorno della voce) la correzione cambia il testo e il diario della sera
//   mostra anche il testo mandato dal cantiere;
// - dopo la chiusura il diario non si tocca: la correzione resta registrata a parte e va nell'email del sabato;
// - una voce nuova si aggiunge solo per oggi e prima delle 22:00, segnata «Ufficio — nome».
// Il relay non conserva nulla: gira la richiesta al database e restituisce l'esito.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AZIONI = ["stato", "leggi", "correggi", "aggiungi"];

function jsonRisposta(oggetto, stato) {
  return new Response(JSON.stringify(oggetto), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

// POST {base}/giornale/ufficio — corpo JSON { t, c, azione, dati }
export async function portaleGiornaleUfficio(request, env, h) {
  if (request.method !== "POST") return jsonRisposta({ esito: "metodo_non_consentito" }, 405);
  if (!env.SUPABASE_SERVICE_KEY) return jsonRisposta({ esito: "non_configurato" }, 503);
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return jsonRisposta({ esito: "errore" }, 415);
  let b;
  try { const t = await request.text(); if (t.length > 12000) return jsonRisposta({ esito: "errore" }, 413); b = JSON.parse(t); } catch (e) { b = null; }
  if (!b || typeof b !== "object") return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  const t = String(b.t || "").toLowerCase();
  const c = String(b.c || "").toLowerCase();
  const azione = String(b.azione || "");
  if (!/^[0-9a-f]{64}$/.test(t)) return jsonRisposta({ esito: "gettone" }, 403);
  if (!UUID.test(c) || AZIONI.indexOf(azione) === -1) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  const d = b.dati && typeof b.dati === "object" ? b.dati : {};
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  const dati = { mid: s(d.mid, 300), testo: s(d.testo, 4000), motivo: s(d.motivo, 600), autore: s(d.autore, 120), sezione: s(d.sezione, 10) };
  const r = await h.rpc(env, "giornale_ufficio", { p_token: t, p_commessa: c, p_azione: azione, p_dati: dati }, 15000).catch(() => null);
  if (r === null || typeof r !== "object") return jsonRisposta({ esito: "incerto" }, 502);
  return jsonRisposta(r);
}

// Stile e script iniettati nella pagina del cantiere (area riservata). base = "" oppure "/portale".
export function giornaleUfficioIniezione(base, token, commessa) {
  const cfg = JSON.stringify({ u: base + "/giornale/ufficio", t: token, c: commessa });
  const stile = "<style>" +
    ".gl-gu-b{display:inline-flex;align-items:center;gap:6px;margin:8px 8px 0 0;padding:0 14px;min-height:36px;border:1px solid #c62828;border-radius:8px;background:#fdecec;color:#c62828;font:inherit;font-size:.9rem;font-weight:700;cursor:pointer;vertical-align:middle}" +
    ".gl-gu-b:hover,.gl-gu-b:focus-visible{background:#c62828;color:#fff;outline:none}" +
    ".gl-gu-add{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;min-height:48px;margin:0 0 12px;border:0;border-radius:12px;background:#C27A12;color:#fff;font:inherit;font-weight:700;font-size:1rem;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15)}" +
    ".gl-gu-nota{background:#FFF7EA;border-left:4px solid #C27A12;border-radius:10px;padding:8px 12px;margin:0 0 12px;font-size:.88rem;color:#5A3D00}" +
    ".gl-gu-ov{position:fixed;inset:0;z-index:9999;background:rgba(10,18,28,.55);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".gl-gu-bx{background:#fff;color:#1b1f1d;border-radius:14px;max-width:520px;width:100%;max-height:90vh;overflow:auto;padding:20px 20px 16px;box-shadow:0 10px 40px rgba(0,0,0,.35)}" +
    ".gl-gu-bx h3{margin:0 0 6px;font-size:1.1rem;color:#1B2F4A}.gl-gu-bx p{margin:0 0 10px;font-size:.9rem;line-height:1.45}" +
    ".gl-gu-bx .meta{font-size:.84rem;color:#5b6560;margin:0 0 10px}" +
    ".gl-gu-bx label{display:block;font-size:.85rem;font-weight:600;margin:10px 0 4px}" +
    ".gl-gu-bx textarea,.gl-gu-bx input[type=text],.gl-gu-bx select{display:block;width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #c9d1cd;border-radius:8px;font:inherit;font-size:1rem;background:#fff;color:#1b1f1d}" +
    ".gl-gu-ok{background:#E3F3EA;border-left:4px solid #0A7D48;border-radius:8px;padding:8px 10px;font-size:.86rem;margin:0 0 6px}" +
    ".gl-gu-avv{background:#fdeaea;border-left:4px solid #c62828;border-radius:8px;padding:8px 10px;font-size:.86rem;margin:0 0 6px}" +
    ".gl-gu-stor{font-size:.8rem;color:#5b6560;margin:8px 0 0}.gl-gu-stor div{margin:3px 0}" +
    ".gl-gu-err{color:#a11;font-size:.88rem;margin:10px 0 0}" +
    ".gl-gu-az{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px}" +
    ".gl-gu-az button{padding:10px 16px;border-radius:10px;border:1px solid #c9d1cd;background:#fff;color:#1b1f1d;font:inherit;font-weight:600;cursor:pointer}" +
    ".gl-gu-az button.pr{background:#c62828;border-color:#c62828;color:#fff}.gl-gu-az button.ag{background:#C27A12;border-color:#C27A12;color:#fff}.gl-gu-az button[disabled]{opacity:.55;cursor:wait}" +
    "@media (prefers-color-scheme:dark){.gl-gu-bx{background:#1a201d;color:#eef2f0}.gl-gu-bx h3{color:#cfe0ff}.gl-gu-bx textarea,.gl-gu-bx input[type=text],.gl-gu-bx select{background:#111513;color:#eef2f0;border-color:#3a4540}.gl-gu-az button{background:#232b27;color:#eef2f0;border-color:#3a4540}.gl-gu-ok{background:#123224}.gl-gu-avv{background:#3a1c1c}.gl-gu-nota{background:#3a2f12;color:#f3e2bd}}" +
    "</style>";
  const script = "<script>" + String.raw`(function(){try{
var CFG=` + cfg + String.raw`,STATO=null;
function el(t,c,h){var e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(x){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x];});}
function chiama(azione,dati){return fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:azione,dati:dati||{}})}).then(function(r){return r.json();});}
function autore(){try{return localStorage.getItem('gl_rp_autore')||'';}catch(x){return '';}}
function ricorda(v){try{if(v)localStorage.setItem('gl_rp_autore',v);}catch(x){}}
function chiudi(ov){if(ov&&ov.parentNode)ov.parentNode.removeChild(ov);}
function finestra(){var ov=el('div','gl-gu-ov'),bx=el('div','gl-gu-bx');ov.appendChild(bx);ov.addEventListener('click',function(e){if(e.target===ov)chiudi(ov);});document.body.appendChild(ov);return {ov:ov,bx:bx};}
function dIt(s){var p=String(s||'').split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:'';}
function errore(r){if(!r)return 'Operazione non riuscita. Riprova.';if(r.esito==='gettone')return 'Collegamento non valido o scaduto: ricarica la pagina.';if(r.esito==='chiuso')return 'Il cantiere è chiuso: il diario non si modifica.';if(r.esito==='incerto')return 'Non ho avuto risposta: ricarica la pagina tra un minuto per vedere se è stato salvato.';return r.messaggio||'Operazione non riuscita. Riprova.';}
/* ---------- Correggi ---------- */
function correggi(mid){
 var w=finestra(),bx=w.bx;bx.innerHTML='<h3>Correggi la voce</h3><p>Caricamento…</p>';
 chiama('leggi',{mid:mid}).then(function(r){
  if(!r||r.esito!=='ok'){bx.innerHTML='<h3>Correggi la voce</h3><p class="gl-gu-err">'+esc(errore(r))+'</p><div class="gl-gu-az"><button type="button" class="an">Chiudi</button></div>';bx.querySelector('.an').onclick=function(){chiudi(w.ov);};return;}
  var v=r.voce,ultimo=v.testo,cc=v.correzioni||[];
  for(var i=0;i<cc.length;i++)if(cc[i].dopo_chiusura)ultimo=cc[i].dopo;
  var stor='';
  if(v.testo_trasmesso)stor+='<div>Testo mandato dal cantiere: «'+esc(v.testo_trasmesso)+'»</div>';
  for(var j=0;j<cc.length;j++)stor+='<div>'+esc(cc[j].il)+' · '+esc(cc[j].da)+(cc[j].dopo_chiusura?' (dopo la chiusura)':'')+': «'+esc(cc[j].dopo)+'» — '+esc(cc[j].motivo)+'</div>';
  bx.innerHTML='<h3>Correggi la voce</h3><div class="meta">'+esc(dIt(v.data))+' ore '+esc(v.ora)+' · '+esc(v.sezione)+' · '+esc(v.mittente)+'</div>'+
   (v.chiusa?'<div class="gl-gu-avv">Il diario del '+esc(dIt(v.data))+' è già chiuso e non cambia. La correzione resta registrata a parte, con il testo di prima, chi l’ha fatta e perché, e va nell’email del sabato.</div>':
    '<div class="gl-gu-ok">La correzione entra nel diario di stasera (chiusura alle '+esc(v.ora_chiusura)+'). Sotto resta il testo mandato dal cantiere.</div>')+
   '<label for="gl-gu-t">Testo corretto</label><textarea id="gl-gu-t" rows="5" maxlength="4000"></textarea>'+
   '<label for="gl-gu-m">Motivo della correzione</label><input type="text" id="gl-gu-m" maxlength="300" placeholder="es. l’ora era sbagliata">'+
   '<label for="gl-gu-a">Corretto da <span style="font-weight:400;color:#666">(nome e cognome)</span></label><input type="text" id="gl-gu-a" maxlength="120" autocomplete="name">'+
   (stor?'<div class="gl-gu-stor"><b>Storia della voce</b>'+stor+'</div>':'')+
   '<div class="gl-gu-err" style="display:none"></div><div class="gl-gu-az"><button type="button" class="an">Annulla</button><button type="button" class="pr">Salva la correzione</button></div>';
  var t=bx.querySelector('#gl-gu-t'),m=bx.querySelector('#gl-gu-m'),a=bx.querySelector('#gl-gu-a'),err=bx.querySelector('.gl-gu-err'),pr=bx.querySelector('.pr');
  t.value=ultimo||'';a.value=autore();
  bx.querySelector('.an').onclick=function(){chiudi(w.ov);};
  pr.onclick=function(){
   var tv=t.value.trim(),mv=m.value.trim(),av=a.value.trim();
   function no(x){err.textContent=x;err.style.display='block';}
   if(!tv)return no('Scrivi il testo corretto.');
   if(tv===String(ultimo||'').trim())return no('Il testo è uguale a quello di adesso: cambia qualcosa oppure annulla.');
   if(mv.length<5)return no('Scrivi il motivo della correzione.');
   if(!av)return no('Scrivi chi fa la correzione (nome e cognome).');
   pr.disabled=true;err.style.display='none';ricorda(av);
   chiama('correggi',{mid:mid,testo:tv,motivo:mv,autore:av}).then(function(q){
    if(q&&q.esito==='ok'){location.reload();return;}
    pr.disabled=false;no(errore(q));
   }).catch(function(){pr.disabled=false;no('Connessione assente. Riprova.');});
  };
  setTimeout(function(){try{t.focus();}catch(x){}},50);
 }).catch(function(){bx.innerHTML='<h3>Correggi la voce</h3><p class="gl-gu-err">Connessione assente. Riprova.</p>';});
}
/* ---------- Aggiungi ---------- */
function aggiungi(){
 var w=finestra(),bx=w.bx;
 bx.innerHTML='<h3>Aggiungi una voce di oggi</h3>'+
  '<div class="gl-gu-ok">La voce entra nel diario di oggi e nel PDF di stasera (chiusura alle '+esc(STATO.ora_chiusura)+'), segnata «Ufficio» con il tuo nome.</div>'+
  '<label for="gl-gu-s">Sezione</label><select id="gl-gu-s"><option value="LAV">Lavorazioni</option><option value="NOTE">Note</option><option value="VISITA">Visite</option><option value="SAL">SAL</option></select>'+
  '<label for="gl-gu-t">Testo</label><textarea id="gl-gu-t" rows="5" maxlength="4000" placeholder="es. Getto del solaio del piano 1 completato"></textarea>'+
  '<label for="gl-gu-a">Inserita da <span style="font-weight:400;color:#666">(nome e cognome)</span></label><input type="text" id="gl-gu-a" maxlength="120" autocomplete="name">'+
  '<div class="gl-gu-err" style="display:none"></div><div class="gl-gu-az"><button type="button" class="an">Annulla</button><button type="button" class="ag">Aggiungi la voce</button></div>';
 var s=bx.querySelector('#gl-gu-s'),t=bx.querySelector('#gl-gu-t'),a=bx.querySelector('#gl-gu-a'),err=bx.querySelector('.gl-gu-err'),ag=bx.querySelector('.ag');
 a.value=autore();
 bx.querySelector('.an').onclick=function(){chiudi(w.ov);};
 ag.onclick=function(){
  var tv=t.value.trim(),av=a.value.trim();
  function no(x){err.textContent=x;err.style.display='block';}
  if(!tv)return no('Scrivi il testo della voce.');
  if(!av)return no('Scrivi chi inserisce la voce (nome e cognome).');
  ag.disabled=true;err.style.display='none';ricorda(av);
  chiama('aggiungi',{sezione:s.value,testo:tv,autore:av}).then(function(q){
   if(q&&q.esito==='ok'){location.reload();return;}
   ag.disabled=false;no(errore(q));
  }).catch(function(){ag.disabled=false;no('Connessione assente. Riprova.');});
 };
 setTimeout(function(){try{t.focus();}catch(x){}},50);
}
/* ---------- tasti nella pagina ---------- */
function mettiTasti(){
 document.querySelectorAll('.voce[data-mid]').forEach(function(n){
  if(n.querySelector('.gl-gu-b'))return;
  var mid=n.getAttribute('data-mid');if(!mid)return;
  var b=el('button','gl-gu-b','&#9998; Correggi');b.type='button';b.title='Correggi il testo della voce';
  b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();correggi(mid);});
  var file=null,ll=n.querySelectorAll('a.link');
  for(var i=0;i<ll.length;i++){if(/Apri il file/.test(ll[i].textContent||'')){file=ll[i];break;}}
  if(!file&&ll.length)file=ll[ll.length-1];
  if(file)file.insertAdjacentElement('afterend',b);
  else{var tx=n.querySelectorAll(':scope > .testo');if(tx.length)tx[tx.length-1].insertAdjacentElement('afterend',b);else n.appendChild(b);}
 });
 var pg=document.getElementById('p-g');
 if(pg&&!pg.querySelector('.gl-gu-add,.gl-gu-nota')){
  var x;
  if(STATO.oggi_chiuso){x=el('div','gl-gu-nota','Il diario di oggi è chiuso (alle '+esc(STATO.ora_chiusura)+'). Le voci si possono ancora correggere; per aggiungere qualcosa usa «Nuovo rapportino» nella scheda Rapportini.');}
  else{x=el('button','gl-gu-add','+ Aggiungi una voce di oggi');x.type='button';x.addEventListener('click',aggiungi);}
  pg.insertBefore(x,pg.firstChild);
 }
}
chiama('stato').then(function(r){if(!r||r.esito!=='ok'||r.chiuso)return;STATO=r;mettiTasti();}).catch(function(){});
}catch(x){}})();
` + "</script>";
  return stile + script;
}
