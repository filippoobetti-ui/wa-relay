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
//                piva: function () { ... },               // partita IVA proposta (per esempio letta dalla fattura)
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
  "@media print{.sr-box{display:none!important}}" +
  // telefono con bandierina e prefisso (srTelefono, 21/11/2026)
  ".srt-box{position:relative;display:flex;gap:6px;width:100%}.srt-box input{flex:1;min-width:0}" +
  ".srt-paese{flex:0 0 auto;display:flex;align-items:center;gap:6px;min-height:40px;padding:0 10px;border:1px solid var(--bordo,#c9d1cc);border-radius:8px;background:#fff;color:#23302A;font:inherit;font-size:.92rem;font-weight:600;cursor:pointer}" +
  ".srt-paese svg,.srt-op svg{width:24px;height:16px;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.18);flex:0 0 auto}" +
  ".srt-lista{position:absolute;left:0;top:calc(100% + 4px);z-index:60;width:min(320px,86vw);max-height:300px;overflow:auto;padding:6px;border:1px solid var(--bordo,#c9d1cc);border-radius:12px;background:#fff;color:#23302A;box-shadow:0 12px 32px rgba(0,0,0,.18)}" +
  ".srt-lista input{width:100%;box-sizing:border-box;margin:0 0 6px;padding:8px 10px;border:1px solid var(--bordo,#c9d1cc);border-radius:8px;font:inherit}" +
  ".srt-op{display:flex;align-items:center;gap:10px;width:100%;padding:8px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;font-size:.9rem;text-align:left;cursor:pointer}" +
  ".srt-op:hover,.srt-op[aria-selected=true]{background:rgba(37,99,235,.1)}.srt-op b{margin-left:auto;font-weight:600;opacity:.75}";

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
 var imp=em?(o.impresa?o.impresa()||'':''):(o.modo==='ditta'?x:'');var nome=o.modo==='persona'?x:(o.nome?o.nome()||'':'');var piva=o.piva?String(o.piva()||'').replace(/[^0-9]/g,''):'';var mail=em?x:'';
 box.innerHTML='<b>Salva in Rubrica</b> <small>per una ditta serve la ragione sociale, per una persona nome e cognome; il resto lo puoi completare anche dopo, dalla Rubrica</small>'+
  '<div class="sr-grid">'+
  '<label>Ragione sociale<input type="text" data-sf="impresa" maxlength="120" value="'+srEsc(imp)+'"></label>'+
  '<label>Rapporto<select data-sf="tipo_rapporto">'+SR_RAPP.map(function(r){return '<option value="'+r[0]+'"'+(r[0]===rp?' selected':'')+'>'+r[1]+'</option>';}).join('')+'</select></label>'+
  '<label>Referente o nome e cognome<input type="text" data-sf="nome" maxlength="120" value="'+srEsc(nome)+'"></label>'+
  '<label>Cellulare<input type="tel" data-sf="telefono" maxlength="40" placeholder="+39 333 123 4567"></label>'+
  '<label>Email<input type="email" data-sf="email" maxlength="160" value="'+srEsc(mail)+'"></label>'+
  '<label>Partita IVA<input type="text" data-sf="partita_iva" maxlength="20" inputmode="numeric" value="'+srEsc(piva)+'"></label>'+
  '<label class="sr-larga">Note<input type="text" data-sf="note" maxlength="500"></label></div>'+
  '<div><button type="button" class="sr-btn sr-pr" data-sr="salva">Salva in Rubrica</button><button type="button" class="sr-btn" data-sr="no">Non adesso</button></div>'+
  '<p class="sr-msg" aria-live="polite"></p>';
 var te=box.querySelector('[data-sf="telefono"]');if(te)srTelefono(te);
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
/* ---- TELEFONO CON BANDIERINA E PREFISSO (21/11/2026, richiesta di Filippo: ogni campo telefono di TIX, Italia +39 di base,
   tutti gli altri paesi nell'elenco, si scrive solo il numero). srTelefono(input): la casella della pagina resta quella che si
   legge e si salva (valore «+39…», come vuole _pc_telefono) ma viene nascosta; accanto compaiono il pulsante del paese e una
   casella dove si scrive solo il numero. Le bandiere disegnate sono quelle di Rubrica e Persone del cantiere; gli altri paesi
   hanno la sigla. Il rosso dei campi mancanti si vede sulla casella del numero. */
var SRT_PAESI=[
["it","Italia","39","v:#009246,#fff,#ce2b37"],
["af", "Afghanistan", "93"],
["al","Albania","355","s:#e41e20",'<path d="M15 4l3.5 4-1.5 1 2 3-4 4-4-4 2-3-1.5-1z" fill="#000"/>'],
["dz","Algeria","213","v:#006233,#fff",'<circle cx="15" cy="10" r="4.5" fill="#d21034"/><circle cx="16.4" cy="10" r="3.7" fill="#fff"/>'],
["ad", "Andorra", "376"],
["ao", "Angola", "244"],
["ag", "Antigua e Barbuda", "1"],
["sa", "Arabia Saudita", "966"],
["ar", "Argentina", "54"],
["am", "Armenia", "374"],
["au", "Australia", "61"],
["at","Austria","43","h:#ed2939,#fff,#ed2939"],
["az", "Azerbaigian", "994"],
["bs", "Bahamas", "1"],
["bh", "Bahrein", "973"],
["bd","Bangladesh","880","s:#006a4e",'<circle cx="13" cy="10" r="6" fill="#f42a41"/>'],
["bb", "Barbados", "1"],
["be","Belgio","32","v:#000,#fdda24,#ef3340"],
["bz", "Belize", "501"],
["bj", "Benin", "229"],
["bt", "Bhutan", "975"],
["by", "Bielorussia", "375"],
["bo", "Bolivia", "591"],
["ba","Bosnia ed Erzegovina","387","s:#002395",'<path d="M9 0h12v20z" fill="#fecb00"/>'],
["bw", "Botswana", "267"],
["br","Brasile","55","s:#009c3b",'<path d="M15 2l13 8-13 8L2 10z" fill="#ffdf00"/><circle cx="15" cy="10" r="4.5" fill="#002776"/>'],
["bn", "Brunei", "673"],
["bg","Bulgaria","359","h:#fff,#00966e,#d62612"],
["bf", "Burkina Faso", "226"],
["bi", "Burundi", "257"],
["kh", "Cambogia", "855"],
["cm", "Camerun", "237"],
["ca", "Canada", "1"],
["cv", "Capo Verde", "238"],
["td", "Ciad", "235"],
["cl", "Cile", "56"],
["cn","Cina","86","s:#de2910","*6,6,3.5,#ffde00"],
["cy", "Cipro", "357"],
["va", "Città del Vaticano", "39"],
["co", "Colombia", "57"],
["km", "Comore", "269"],
["cg", "Congo", "242"],
["cd", "Congo (Rep. Democratica)", "243"],
["kp", "Corea del Nord", "850"],
["kr", "Corea del Sud", "82"],
["ci","Costa d'Avorio","225","v:#f77f00,#fff,#009e60"],
["cr", "Costa Rica", "506"],
["hr","Croazia","385","h:#ff0000,#fff,#171796"],
["cu", "Cuba", "53"],
["dk", "Danimarca", "45"],
["dm", "Dominica", "1"],
["ec","Ecuador","593","h:#ffdd00,#ffdd00,#034ea2,#ed1c24"],
["eg","Egitto","20","h:#ce1126,#fff,#000"],
["sv", "El Salvador", "503"],
["ae", "Emirati Arabi Uniti", "971"],
["er", "Eritrea", "291"],
["ee", "Estonia", "372"],
["sz", "Eswatini", "268"],
["et", "Etiopia", "251"],
["fo", "Fær Øer", "298"],
["fj", "Figi", "679"],
["ph","Filippine","63","h:#0038a8,#ce1126",'<path d="M0 0l17.3 10L0 20z" fill="#fff"/><circle cx="5.5" cy="10" r="2" fill="#fcd116"/>'],
["fi", "Finlandia", "358"],
["fr","Francia","33","v:#0055a4,#fff,#ef4135"],
["ga", "Gabon", "241"],
["gm","Gambia","220","h:#ce1126,#0c1c8c,#3a7728",'<rect y="6.2" width="30" height="1" fill="#fff"/><rect y="12.8" width="30" height="1" fill="#fff"/>'],
["ge","Georgia","995","s:#fff",'<rect x="13" width="4" height="20" fill="#f00"/><rect y="8" width="30" height="4" fill="#f00"/>'],
["de","Germania","49","h:#000,#dd0000,#ffce00"],
["gh","Ghana","233","h:#ce1126,#fcd116,#006b3f","*15,10,3.2,#000"],
["jm", "Giamaica", "1"],
["jp", "Giappone", "81"],
["gi", "Gibilterra", "350"],
["dj", "Gibuti", "253"],
["jo", "Giordania", "962"],
["gr", "Grecia", "30"],
["gd", "Grenada", "1"],
["gl", "Groenlandia", "299"],
["gt", "Guatemala", "502"],
["gn", "Guinea", "224"],
["gq", "Guinea Equatoriale", "240"],
["gw", "Guinea-Bissau", "245"],
["gy", "Guyana", "592"],
["ht", "Haiti", "509"],
["hn", "Honduras", "504"],
["hk", "Hong Kong", "852"],
["in","India","91","h:#ff9933,#fff,#138808",'<circle cx="15" cy="10" r="2.5" fill="none" stroke="#000080" stroke-width=".8"/>'],
["id", "Indonesia", "62"],
["ir", "Iran", "98"],
["iq", "Iraq", "964"],
["ie", "Irlanda", "353"],
["is", "Islanda", "354"],
["mh", "Isole Marshall", "692"],
["sb", "Isole Salomone", "677"],
["il", "Israele", "972"],
["kz", "Kazakistan", "7"],
["ke", "Kenya", "254"],
["kg", "Kirghizistan", "996"],
["ki", "Kiribati", "686"],
["xk","Kosovo","383","s:#244aa5",'<path d="M11 8h8l-1 6h-6z" fill="#d0a650"/>'],
["kw", "Kuwait", "965"],
["la", "Laos", "856"],
["ls", "Lesotho", "266"],
["lv", "Lettonia", "371"],
["lb", "Libano", "961"],
["lr", "Liberia", "231"],
["ly", "Libia", "218"],
["li", "Liechtenstein", "423"],
["lt", "Lituania", "370"],
["lu", "Lussemburgo", "352"],
["mo", "Macao", "853"],
["mk","Macedonia del Nord","389","s:#d20000",'<circle cx="15" cy="10" r="3.5" fill="#ffe600"/>'],
["mg", "Madagascar", "261"],
["mw", "Malawi", "265"],
["my", "Malaysia", "60"],
["mv", "Maldive", "960"],
["ml","Mali","223","v:#14b53a,#fcd116,#ce1126"],
["mt", "Malta", "356"],
["ma","Marocco","212","s:#c1272d","o15,10,4,#006233"],
["mr", "Mauritania", "222"],
["mu", "Mauritius", "230"],
["mx", "Messico", "52"],
["fm", "Micronesia", "691"],
["md","Moldavia","373","v:#0046ae,#ffd200,#cc092f"],
["mc", "Monaco", "377"],
["mn", "Mongolia", "976"],
["me", "Montenegro", "382"],
["mz", "Mozambico", "258"],
["mm", "Myanmar", "95"],
["na", "Namibia", "264"],
["nr", "Nauru", "674"],
["np", "Nepal", "977"],
["ni", "Nicaragua", "505"],
["ne", "Niger", "227"],
["ng","Nigeria","234","v:#008751,#fff,#008751"],
["no", "Norvegia", "47"],
["nz", "Nuova Zelanda", "64"],
["om", "Oman", "968"],
["nl","Paesi Bassi","31","h:#ae1c28,#fff,#21468b"],
["pk","Pakistan","92","s:#01411c",'<rect width="7.5" height="20" fill="#fff"/><circle cx="18" cy="10" r="5" fill="#fff"/><circle cx="19.6" cy="8.8" r="4.3" fill="#01411c"/>'],
["pw", "Palau", "680"],
["ps", "Palestina", "970"],
["pa", "Panama", "507"],
["pg", "Papua Nuova Guinea", "675"],
["py", "Paraguay", "595"],
["pe","Perù","51","v:#d91023,#fff,#d91023"],
["pl","Polonia","48","h:#fff,#dc143c"],
["pr", "Porto Rico", "1"],
["pt","Portogallo","351","s:#f00",'<rect width="12" height="20" fill="#060"/><circle cx="12" cy="10" r="3.5" fill="#fc0"/>'],
["qa", "Qatar", "974"],
["gb","Regno Unito","44","s:#012169",'<path d="M0 0l30 20M30 0L0 20" stroke="#fff" stroke-width="4"/><path d="M0 0l30 20M30 0L0 20" stroke="#c8102e" stroke-width="1.4"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#c8102e" stroke-width="3.4"/>'],
["cz", "Repubblica Ceca", "420"],
["cf", "Repubblica Centrafricana", "236"],
["do", "Repubblica Dominicana", "1"],
["re", "Riunione", "262"],
["ro","Romania","40","v:#002b7f,#fcd116,#ce1126"],
["rw", "Ruanda", "250"],
["ru","Russia","7","h:#fff,#0039a6,#d52b1e"],
["kn", "Saint Kitts e Nevis", "1"],
["vc", "Saint Vincent e Grenadine", "1"],
["ws", "Samoa", "685"],
["sm","San Marino","378","h:#fff,#5eb6e4"],
["lc", "Santa Lucia", "1"],
["sn","Senegal","221","v:#00853f,#fdef42,#e31b23","*15,10,3,#00853f"],
["rs","Serbia","381","h:#c6363c,#0c4076,#fff"],
["sc", "Seychelles", "248"],
["sl", "Sierra Leone", "232"],
["sg", "Singapore", "65"],
["sy", "Siria", "963"],
["sk", "Slovacchia", "421"],
["si", "Slovenia", "386"],
["so", "Somalia", "252"],
["es","Spagna","34","h:#aa151b,#f1bf00,#f1bf00,#aa151b"],
["lk","Sri Lanka","94","s:#ffb700",'<rect x="11" y="1.5" width="17.5" height="17" fill="#8d153a"/><rect x="1.5" y="1.5" width="4" height="17" fill="#00534e"/><rect x="6" y="1.5" width="4" height="17" fill="#eb7400"/>'],
["us", "Stati Uniti", "1"],
["za", "Sudafrica", "27"],
["sd", "Sudan", "249"],
["ss", "Sudan del Sud", "211"],
["sr", "Suriname", "597"],
["se", "Svezia", "46"],
["ch","Svizzera","41","s:#da291c",'<path d="M13 4h4v4h4v4h-4v4h-4v-4H9V8h4z" fill="#fff"/>'],
["st", "São Tomé e Príncipe", "239"],
["tj", "Tagikistan", "992"],
["tw", "Taiwan", "886"],
["tz", "Tanzania", "255"],
["th", "Thailandia", "66"],
["tl", "Timor Est", "670"],
["tg", "Togo", "228"],
["to", "Tonga", "676"],
["tt", "Trinidad e Tobago", "1"],
["tn","Tunisia","216","s:#e70013",'<circle cx="15" cy="10" r="5" fill="#fff"/><circle cx="15.6" cy="10" r="3.6" fill="#e70013"/><circle cx="16.7" cy="10" r="2.9" fill="#fff"/>'],
["tr","Turchia","90","s:#e30a17",'<circle cx="12" cy="10" r="5" fill="#fff"/><circle cx="13.3" cy="10" r="4" fill="#e30a17"/>',"*18.6,10,2,#fff"],
["tm", "Turkmenistan", "993"],
["tv", "Tuvalu", "688"],
["ua","Ucraina","380","h:#0057b7,#ffd700"],
["ug", "Uganda", "256"],
["hu","Ungheria","36","h:#ce2939,#fff,#477050"],
["uy", "Uruguay", "598"],
["uz", "Uzbekistan", "998"],
["vu", "Vanuatu", "678"],
["ve", "Venezuela", "58"],
["vn", "Vietnam", "84"],
["ye", "Yemen", "967"],
["zm", "Zambia", "260"],
["zw", "Zimbabwe", "263"],
["xx","Altro paese (scrivi il numero con +)","","s:#e5e7eb",'<circle cx="15" cy="10" r="6" fill="none" stroke="#6b7280" stroke-width="1.2"/><path d="M9 10h12M15 4c-3 3-3 9 0 12M15 4c3 3 3 9 0 12" fill="none" stroke="#6b7280" stroke-width="1"/>']
];
function srtStella(cx,cy,r,col,vuota){var p=[];for(var i=0;i<10;i++){var a=Math.PI/5*i-Math.PI/2,rr=i%2?r*.4:r;p.push((cx+rr*Math.cos(a)).toFixed(2)+','+(cy+rr*Math.sin(a)).toFixed(2));}
 return '<polygon points="'+p.join(' ')+'" '+(vuota?'fill="none" stroke="'+col+'" stroke-width=".9"':'fill="'+col+'"')+'/>';}
function srtBandiera(pa){var s='<svg viewBox="0 0 30 20" aria-hidden="true" focusable="false">',spec=pa[3];
 if(!spec)return s+'<rect width="30" height="20" fill="#e5e7eb"/><text x="15" y="14" font-size="10" font-family="Arial,sans-serif" font-weight="700" text-anchor="middle" fill="#374151">'+pa[0].toUpperCase()+'</text></svg>';
 var t=spec.charAt(0),c=spec.slice(2).split(',');
 if(t==='s')s+='<rect width="30" height="20" fill="'+c[0]+'"/>';
 else c.forEach(function(col,i){var n=c.length;s+=t==='v'?'<rect x="'+(30/n*i)+'" width="'+(30/n+.05)+'" height="20" fill="'+col+'"/>':'<rect y="'+(20/n*i)+'" width="30" height="'+(20/n+.05)+'" fill="'+col+'"/>';});
 pa.slice(4).forEach(function(x){if(x.charAt(0)==='*'||x.charAt(0)==='o'){var q=x.slice(1).split(',');s+=srtStella(+q[0],+q[1],+q[2],q[3],x.charAt(0)==='o');}else s+=x;});
 return s+'</svg>';}
function srtPaese(cod){for(var i=0;i<SRT_PAESI.length;i++)if(SRT_PAESI[i][0]===cod)return SRT_PAESI[i];return SRT_PAESI[0];}
function srTelefono(orig){if(!orig||!orig.parentNode)return null;if(orig._srTel)return orig._srTel;
 var proto=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value'),interno=false,paese='it';
 var box=document.createElement('div');box.className='srt-box';
 var b=document.createElement('button');b.type='button';b.className='srt-paese';b.setAttribute('aria-haspopup','listbox');b.setAttribute('aria-expanded','false');
 var vis=document.createElement('input');vis.type='tel';vis.inputMode='tel';vis.autocomplete='tel-national';vis.maxLength=24;vis.className=orig.className;
 if(orig.id){vis.id=orig.id+'-numero';var lb=document.querySelector('label[for="'+orig.id+'"]');if(lb)lb.setAttribute('for',vis.id);}
 if(orig.getAttribute('aria-label'))vis.setAttribute('aria-label',orig.getAttribute('aria-label'));
 vis.disabled=orig.disabled;vis.required=orig.required;orig.required=false;
 orig.parentNode.insertBefore(box,orig);box.appendChild(b);box.appendChild(vis);box.parentNode.insertBefore(orig,box.nextSibling);orig.style.display='none';orig.tabIndex=-1;
 function scrivi(v){interno=true;proto.set.call(orig,v);interno=false;}
 function mostra(){var pa=srtPaese(paese);b.innerHTML=srtBandiera(pa)+'<span>'+(pa[2]?'+'+pa[2]:'+')+'</span>';
  b.setAttribute('aria-label','Paese del numero: '+pa[1]+(pa[2]?', prefisso +'+pa[2]:'')+'. Tocca per cambiarlo');
  vis.placeholder=pa[2]==='39'?'333 123 4567':(pa[2]?'numero senza prefisso':'+ prefisso e numero');}
 function componi(){var v=vis.value.trim(),pa=srtPaese(paese),out='';
  if(v){if(v.charAt(0)==='+'||v.indexOf('00')===0||!pa[2])out=v;else{var n=v.replace(/[^0-9]/g,'');if(pa[2]!=='39')n=n.replace(/^0+/,'');out=n?'+'+pa[2]+n:'';}}
  scrivi(out);orig.dispatchEvent(new Event('input',{bubbles:true}));orig.dispatchEvent(new Event('change',{bubbles:true}));}
 function imposta(num){var raw=String(num==null?'':num).trim(),d=raw.replace(/[^0-9]/g,'');if(raw.charAt(0)!=='+'&&d.indexOf('00')===0)d=d.slice(2);
  if(d.length===10&&d.charAt(0)==='3'&&raw.charAt(0)!=='+')d='39'+d;var cod='it',resto='';
  if(d){var m=null;SRT_PAESI.forEach(function(pa){if(pa[2]&&d.indexOf(pa[2])===0&&d.length>pa[2].length+5&&(!m||pa[2].length>m[2].length))m=pa;});
   if(m){cod=m[0];resto=d.slice(m[2].length);}else{cod='xx';resto='+'+d;}}
  paese=cod;mostra();vis.value=resto;scrivi(d?(m?'+'+d:'+'+d):'');}
 try{Object.defineProperty(orig,'value',{configurable:true,get:function(){return proto.get.call(orig);},set:function(v){proto.set.call(orig,v);if(!interno)imposta(v);}});}catch(e){}
 vis.addEventListener('input',componi);vis.addEventListener('change',componi);
 new MutationObserver(function(){vis.classList.toggle('cr-err',orig.classList.contains('cr-err'));if(orig.getAttribute('aria-invalid'))vis.setAttribute('aria-invalid','true');else vis.removeAttribute('aria-invalid');vis.disabled=orig.disabled;})
  .observe(orig,{attributes:true,attributeFilter:['class','aria-invalid','disabled']});
 var lista=null;
 function chiudi(){if(lista){lista.remove();lista=null;b.setAttribute('aria-expanded','false');document.removeEventListener('mousedown',fuori,true);}}
 function fuori(e){if(!box.contains(e.target))chiudi();}
 function disegna(q){var h='';q=(q||'').toLowerCase().replace(/^\+/,'');SRT_PAESI.forEach(function(pa){if(q&&pa[1].toLowerCase().indexOf(q)<0&&pa[2].indexOf(q)!==0)return;
  h+='<button type="button" class="srt-op" role="option" data-c="'+pa[0]+'" aria-selected="'+(pa[0]===paese)+'">'+srtBandiera(pa)+'<span>'+srEsc(pa[1])+'</span><b>'+(pa[2]?'+'+pa[2]:'')+'</b></button>';});
  lista.querySelector('.srt-ops').innerHTML=h||'<p style="margin:6px;opacity:.7">Nessun paese trovato</p>';}
 b.addEventListener('click',function(){if(lista){chiudi();return;}
  lista=document.createElement('div');lista.className='srt-lista';lista.setAttribute('role','listbox');lista.setAttribute('aria-label','Paese del numero');
  lista.innerHTML='<input type="search" placeholder="Cerca il paese o il prefisso" aria-label="Cerca il paese"><div class="srt-ops"></div>';box.appendChild(lista);disegna('');
  b.setAttribute('aria-expanded','true');var c=lista.querySelector('input');c.addEventListener('input',function(){disegna(c.value);});
  lista.addEventListener('click',function(e){var op=e.target.closest('.srt-op');if(!op)return;paese=op.getAttribute('data-c');
   if(paese==='xx'&&vis.value&&vis.value.charAt(0)!=='+')vis.value='+'+vis.value;mostra();componi();chiudi();vis.focus();});
  lista.addEventListener('keydown',function(e){if(e.key==='Escape'){e.stopPropagation();chiudi();b.focus();}});
  document.addEventListener('mousedown',fuori,true);var sel=lista.querySelector('[aria-selected="true"]');if(sel)sel.scrollIntoView({block:'nearest'});c.focus();});
 imposta(proto.get.call(orig));
 var o={input:vis,imposta:imposta,valore:function(){return proto.get.call(orig);}};orig._srTel=o;return o;}
`;
