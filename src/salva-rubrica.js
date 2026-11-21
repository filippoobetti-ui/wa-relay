// ============================================================================
// «SALVA IN RUBRICA» (21/11/2026, salva-rubrica-b1-1, chat B1). Regola di Filippo del 21/11 («tassativamente sempre»):
// in ogni sezione di TIX, chi si scrive a mano (persona, operaio, professionista, fornitore) e non è nella Rubrica
// si può salvare in Rubrica con i suoi dati. Stesso aspetto e stessi campi del modello della B3 (rubForm nei Preventivi).
// Il salvataggio passa da POST /agenda/contatto con da_salva = true e sezione → rubrica_da_sezione(…, 'salva') nel database
// (funzione unica della B13: accesso della sezione, doppioni per nome, email o cellulare, poi rubrica_salva con i suoi controlli:
// cellulare con prefisso, email, partita IVA di 11 cifre). Un'altra pagina può passare la sua funzione con «salva».
//
// Uso nel browser (dopo CAMPI_ROSSI_JS, se c'è, e prima dello script della pagina):
//   srAggancia({ campo: elemento, base, t, c, sezione: 'agenda' | 'progetti' | 'costruttivi' | …,
//                modo: 'ditta' | 'persona' | 'email',     // cosa c'è scritto nella casella
//                multi: true,                             // più nomi o email separati da virgola
//                rapporto: 'fornitore',                   // rapporto proposto
//                conosciuto: function (testo) { ... },    // true se è già nella Rubrica
//                impresa: function () { ... },            // ragione sociale proposta (modo 'email')
//                dopo: function (contatto) { ... },       // collega il contatto salvato a ciò che si compila
//                salva: function (dati) { ... } })        // facoltativo: salvataggio della pagina (es. preventivo senza cantiere),
//                                                         // promessa con la stessa risposta di /agenda/contatto
// ============================================================================

export const SALVA_RUBRICA_CSS =
  ".sr-box{margin:8px 0 4px;padding:10px 12px;border:1px solid #E7C873;background:#FFF8E6;border-radius:10px;font-size:.9rem;line-height:1.4;text-align:left}" +
  ".sr-box b{font-weight:700}.sr-box small{color:#5b6560}.sr-box.sr-ok{border-color:#9BD3B4;background:#E8F6EE}" +
  ".sr-btn{display:inline-flex;align-items:center;min-height:36px;margin:4px 6px 0 0;padding:0 14px;border-radius:8px;border:1px solid #c9d1cc;background:#fff;color:#23302A;font:inherit;font-size:.88rem;font-weight:700;cursor:pointer}" +
  ".sr-btn.sr-pr{background:#0A7D48;border-color:#0A7D48;color:#fff}.sr-btn:disabled{opacity:.55;cursor:default}" +
  ".sr-grid{display:flex;flex-wrap:wrap;gap:8px 10px;margin-top:8px}.sr-grid label{display:flex;flex-direction:column;gap:3px;flex:1 1 210px;font-size:.82rem;font-weight:600;color:#23302A}" +
  ".sr-grid label.sr-larga{flex-basis:100%}.sr-grid input,.sr-grid select{width:100%;min-height:40px;padding:6px 10px;border:1px solid #c9d1cc;border-radius:8px;font:inherit;font-size:.92rem;font-weight:400;background:#fff;color:#111;box-sizing:border-box}" +
  ".sr-msg{margin:6px 0 0;font-size:.86rem;font-weight:600}.sr-msg.sr-err{color:#B3261E}" +
  "@media print{.sr-box{display:none!important}}";

export const SALVA_RUBRICA_JS = String.raw`
var SR_DITTE=['fornitore','subappaltatore','noleggio','laboratorio'];
var SR_RAPP=[['fornitore','Fornitore di materiali'],['subappaltatore','Impresa subappaltatrice'],['noleggio','Noleggio di mezzi e attrezzature'],['laboratorio','Laboratorio prove sui materiali'],['professionista','Professionista con partita IVA'],['autonomo','Lavoratore autonomo'],['esterno','Altro (esterno all\'impresa)']];
function srEsc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function srNorm(s){return String(s||'').toLowerCase().replace(/\s+/g,' ').trim();}
function srEmailOk(s){return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s||'').trim());}
function srParti(o){var v=String(o.campo.value||'');var a=o.multi?v.split(o.modo==='email'?/[,;\s]+/:/[,;]+/):[v];
 return a.map(function(x){return x.trim();}).filter(function(x){return x.length>=2&&(o.modo!=='email'||srEmailOk(x));});}
function srManca(o){var ps=srParti(o);for(var i=0;i<ps.length;i++){var x=ps[i];if(o._fatti[srNorm(x)])continue;if(o.conosciuto&&o.conosciuto(x))continue;return x;}return '';}
function srAggiorna(o){var box=o._box;if(box.dataset.aperto==='1')return;var x=srManca(o);
 if(!x){if(!box.classList.contains('sr-ok')){box.hidden=true;box.innerHTML='';}return;}
 box.classList.remove('sr-ok');box.hidden=false;o._x=x;
 box.innerHTML='<b>«'+srEsc(x)+'» non è nella Rubrica.</b> <button type="button" class="sr-btn sr-pr" data-sr="apri">Salva in Rubrica</button>'+
  ' <small>con i suoi dati: la prossima volta lo scegli dall\'elenco</small>';}
function srForm(o){var box=o._box,x=o._x||'',em=o.modo==='email';box.dataset.aperto='1';box.classList.remove('sr-ok');box.hidden=false;
 var rp=o.rapporto||(o.modo==='ditta'?'fornitore':'professionista');
 var imp=em?(o.impresa?o.impresa()||'':''):(o.modo==='ditta'?x:'');var nome=o.modo==='persona'?x:(o.nome?o.nome()||'':'');var mail=em?x:'';
 box.innerHTML='<b>Salva in Rubrica</b> <small>per una ditta serve la ragione sociale, per una persona nome e cognome; il resto lo puoi completare anche dopo, dalla Rubrica</small>'+
  '<div class="sr-grid">'+
  '<label>Ragione sociale<input type="text" data-sf="impresa" maxlength="120" value="'+srEsc(imp)+'"></label>'+
  '<label>Rapporto<select data-sf="tipo_rapporto">'+SR_RAPP.map(function(r){return '<option value="'+r[0]+'"'+(r[0]===rp?' selected':'')+'>'+r[1]+'</option>';}).join('')+'</select></label>'+
  '<label>Referente o nome e cognome<input type="text" data-sf="nome" maxlength="120" value="'+srEsc(nome)+'"></label>'+
  '<label>Cellulare<input type="tel" data-sf="telefono" maxlength="40" placeholder="+39 333 123 4567"></label>'+
  '<label>Email<input type="email" data-sf="email" maxlength="160" value="'+srEsc(mail)+'"></label>'+
  '<label>Partita IVA<input type="text" data-sf="partita_iva" maxlength="20" inputmode="numeric"></label>'+
  '<label class="sr-larga">Note<input type="text" data-sf="note" maxlength="500"></label></div>'+
  '<div><button type="button" class="sr-btn sr-pr" data-sr="salva">Salva in Rubrica</button><button type="button" class="sr-btn" data-sr="no">Non adesso</button></div>'+
  '<p class="sr-msg" aria-live="polite"></p>';
 var f=box.querySelector(em?'[data-sf="impresa"]':(o.modo==='persona'?'[data-sf="telefono"]':'[data-sf="nome"]'));if(f)try{f.focus();}catch(e){}}
function srMsg(o,t,err){var m=o._box.querySelector('.sr-msg');if(m){m.textContent=t||'';m.className='sr-msg'+(err?' sr-err':'');}}
function srRosso(el,t){if(!el)return;if(typeof crSegna==='function')crSegna(el,t);else{el.style.borderColor='#B3261E';}}
function srSalva(o,b){var box=o._box,g=function(k){return box.querySelector('[data-sf="'+k+'"]');},v=function(k){var e=g(k);return e?String(e.value||'').trim():'';};
 if(typeof crPulisci==='function')crPulisci(box);
 var rp=v('tipo_rapporto'),ditta=SR_DITTE.indexOf(rp)>=0,imp=v('impresa'),nome=v('nome'),mail=v('email'),piva=v('partita_iva'),tel=v('telefono'),err=[];
 if(ditta&&imp.length<2)err.push([g('impresa'),'Scrivi la ragione sociale della ditta']);
 if(!ditta&&nome.length<2)err.push([g('nome'),'Scrivi nome e cognome']);
 var td=tel.replace(/[^0-9]/g,'');if(td.indexOf('00')===0)td=td.slice(2);if(td.length===10&&td.charAt(0)==='3')td='39'+td;
 if(tel&&(td.length<10||td.length>15))err.push([g('telefono'),'Scrivi il cellulare con il prefisso, per esempio +39 333 123 4567']);
 if(mail&&!srEmailOk(mail))err.push([g('email'),'L\'email non sembra giusta']);
 if(piva&&piva.replace(/\D/g,'').length!==11)err.push([g('partita_iva'),'La partita IVA ha 11 cifre']);
 if(err.length){err.forEach(function(x){srRosso(x[0],x[1]);});try{err[0][0].focus();}catch(e){}srMsg(o,'Completa i campi segnati in rosso.',true);return;}
 b.disabled=true;srMsg(o,'Un momento…');
 var dati={nome:nome||imp,impresa:imp,tipo_rapporto:rp,telefono:tel,email:mail,partita_iva:piva,note:v('note')};
 var invio=o.salva?Promise.resolve(o.salva(dati)):fetch(o.base+'/agenda/contatto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:o.t,c:o.c,da_salva:true,sezione:o.sezione||'agenda',dati:dati})})
 .then(function(r){return r.json().catch(function(){return{esito:'errore'};});});
 invio.then(function(r){b.disabled=false;
  if(r&&r.esito==='gettone'){srMsg(o,'L\'accesso è scaduto: ricarica la pagina.',true);return;}
  if(r&&r.esito==='spento'){srMsg(o,'Il salvataggio in Rubrica non è disponibile in questo momento: aggiungilo dalla Rubrica.',true);return;}
  if(r&&(r.esito==='ok'||r.esito==='gia'||r.esito==='senza_email')){var k=r.contatto||{};o._fatti[srNorm(o._x)]=1;box.dataset.aperto='';box.classList.add('sr-ok');box.hidden=false;
   var chi=k.impresa||k.nome||o._x;box.innerHTML=r.esito==='ok'?'<b>✓ «'+srEsc(chi)+'» è salvato in Rubrica.</b>':'<b>✓ «'+srEsc(chi)+'» era già nella Rubrica</b> <small>'+(r.per==='nome'?'con lo stesso nome':(r.per==='email'?'con la stessa email':'con lo stesso cellulare'))+': non l\'ho aggiunto una seconda volta.</small>';
   if(o.dopo)try{o.dopo(k,r.esito);}catch(e){}setTimeout(function(){box.classList.remove('sr-ok');srAggiorna(o);},5000);return;}
  var mappa={nome:ditta?'impresa':'nome',telefono:'telefono',email:'email',partita_iva:'partita_iva'};var cm=r&&mappa[r.campo];
  var t=(r&&r.messaggio)||'Non sono riuscito a salvare: riprova tra poco.';if(cm)srRosso(g(cm),t);srMsg(o,t,true);
 }).catch(function(){b.disabled=false;srMsg(o,'Connessione assente: riprova.',true);});}
function srAggancia(o){if(!o||!o.campo||o.campo._sr)return null;o.campo._sr=o;o._fatti={};
 var box=document.createElement('div');box.className='sr-box';box.hidden=true;o._box=box;
 var dopo=o.dopoDi||o.campo,par=dopo.parentNode;var cr=dopo.nextElementSibling;
 while(cr&&cr.classList&&cr.classList.contains('cr-msg')){dopo=cr;cr=cr.nextElementSibling;}
 par.insertBefore(box,dopo.nextSibling);
 var t=null;o.campo.addEventListener('input',function(){clearTimeout(t);t=setTimeout(function(){srAggiorna(o);},700);});
 o.campo.addEventListener('change',function(){srAggiorna(o);});
 box.addEventListener('click',function(ev){var b=ev.target.closest('[data-sr]');if(!b)return;var a=b.getAttribute('data-sr');
  if(a==='apri')srForm(o);else if(a==='salva')srSalva(o,b);else if(a==='no'){o._fatti[srNorm(o._x)]=1;box.dataset.aperto='';box.hidden=true;box.innerHTML='';srAggiorna(o);}});
 // se la pagina svuota o cambia la casella da sola (Aggiungi, finestra chiusa e riaperta) il riquadro si rimette in pari
 document.addEventListener('click',function(ev){if(box.contains(ev.target))return;setTimeout(function(){if(box.dataset.aperto!=='1')srAggiorna(o);},1200);},true);
 o.aggiorna=function(){srAggiorna(o);};
 o.chiudi=function(){box.dataset.aperto='';box.classList.remove('sr-ok');box.hidden=true;box.innerHTML='';};
 srAggiorna(o);return o;}
`;
