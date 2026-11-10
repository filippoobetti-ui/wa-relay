// ============================================================================
// ELENCO FORNITORI E SUBAPPALTATORI DI TIX (10/11/2026, elenco-1, chat 02B). Scelte di Filippo del 09/11: iscrizione solo con
// il link d'invito, approvazione di Filippo, riquadro «Siamo nell'elenco fornitori di TIX» obbligatorio, referente visibile se
// scritto, NESSUNA pagina pubblica dell'elenco (le imprese lo vedono solo dentro l'app). Pagine noindex, servite da www:
//   GET  /elenco/iscriviti?k=<codice>   modulo d'iscrizione (si apre solo con il codice d'invito)
//   POST /elenco/iscrivi                {k, campi…} → elenco_iscrivi (doppia conferma dell'email)
//   POST /elenco/logo?k=… | ?t=…        corpo = logo PNG/JPEG/WEBP fino a 1 MB → {esito, percorso} in wa-media/elenco/
//   GET  /elenco/conferma?t=…           conferma dell'email
//   GET  /elenco/mia?t=…                pagina personale: modifica, «Siamo ancora attivi», cancellazione definitiva
//   POST /elenco/mia/api                {t, azione: vedi | salva | conferma_annuale | cancella, dati}
//   GET  /elenco/logo?p=elenco/…        logo di un'azienda (per le schede nell'app)
// Controlli, salvataggio ed email li fa il database (funzioni elenco_*); qui solo trappole contro i programmi automatici,
// l'impronta giornaliera dell'IP (cancellata entro 24 ore) e i loghi. Nessun dato del modulo va a fornitori di IA.
// Interruttore per le imprese: impostazioni.elenco_fornitori_attivo (no / prova / si).
// ============================================================================

const ELENCO_ORIGINI = new Set(["https://www.tixcantiere.it", "https://wa-relay.filippo-obetti.workers.dev"]);
const ELENCO_TOKEN = /^[0-9a-f]{48}$/;
const ELENCO_LOGO = /^elenco\/[0-9]{6}\/[0-9a-f]{24}\.(png|jpg|webp)$/;
const ELENCO_LOGO_MAX = 1024 * 1024;

// sigla, nome, regione (107 province)
const PROVINCE = [
  ["TO","Torino","Piemonte"],["VC","Vercelli","Piemonte"],["NO","Novara","Piemonte"],["CN","Cuneo","Piemonte"],["AT","Asti","Piemonte"],
  ["AL","Alessandria","Piemonte"],["BI","Biella","Piemonte"],["VB","Verbano-Cusio-Ossola","Piemonte"],["AO","Aosta","Valle d'Aosta"],
  ["VA","Varese","Lombardia"],["CO","Como","Lombardia"],["SO","Sondrio","Lombardia"],["MI","Milano","Lombardia"],["BG","Bergamo","Lombardia"],
  ["BS","Brescia","Lombardia"],["PV","Pavia","Lombardia"],["CR","Cremona","Lombardia"],["MN","Mantova","Lombardia"],["LC","Lecco","Lombardia"],
  ["LO","Lodi","Lombardia"],["MB","Monza e Brianza","Lombardia"],["BZ","Bolzano","Trentino-Alto Adige"],["TN","Trento","Trentino-Alto Adige"],
  ["VR","Verona","Veneto"],["VI","Vicenza","Veneto"],["BL","Belluno","Veneto"],["TV","Treviso","Veneto"],["VE","Venezia","Veneto"],
  ["PD","Padova","Veneto"],["RO","Rovigo","Veneto"],["UD","Udine","Friuli-Venezia Giulia"],["GO","Gorizia","Friuli-Venezia Giulia"],
  ["TS","Trieste","Friuli-Venezia Giulia"],["PN","Pordenone","Friuli-Venezia Giulia"],["IM","Imperia","Liguria"],["SV","Savona","Liguria"],
  ["GE","Genova","Liguria"],["SP","La Spezia","Liguria"],["PC","Piacenza","Emilia-Romagna"],["PR","Parma","Emilia-Romagna"],
  ["RE","Reggio Emilia","Emilia-Romagna"],["MO","Modena","Emilia-Romagna"],["BO","Bologna","Emilia-Romagna"],["FE","Ferrara","Emilia-Romagna"],
  ["RA","Ravenna","Emilia-Romagna"],["FC","Forlì-Cesena","Emilia-Romagna"],["RN","Rimini","Emilia-Romagna"],["MS","Massa-Carrara","Toscana"],
  ["LU","Lucca","Toscana"],["PT","Pistoia","Toscana"],["FI","Firenze","Toscana"],["LI","Livorno","Toscana"],["PI","Pisa","Toscana"],
  ["AR","Arezzo","Toscana"],["SI","Siena","Toscana"],["GR","Grosseto","Toscana"],["PO","Prato","Toscana"],["PG","Perugia","Umbria"],
  ["TR","Terni","Umbria"],["PU","Pesaro e Urbino","Marche"],["AN","Ancona","Marche"],["MC","Macerata","Marche"],["AP","Ascoli Piceno","Marche"],
  ["FM","Fermo","Marche"],["VT","Viterbo","Lazio"],["RI","Rieti","Lazio"],["RM","Roma","Lazio"],["LT","Latina","Lazio"],["FR","Frosinone","Lazio"],
  ["AQ","L'Aquila","Abruzzo"],["TE","Teramo","Abruzzo"],["PE","Pescara","Abruzzo"],["CH","Chieti","Abruzzo"],["CB","Campobasso","Molise"],
  ["IS","Isernia","Molise"],["CE","Caserta","Campania"],["BN","Benevento","Campania"],["NA","Napoli","Campania"],["AV","Avellino","Campania"],
  ["SA","Salerno","Campania"],["FG","Foggia","Puglia"],["BA","Bari","Puglia"],["TA","Taranto","Puglia"],["BR","Brindisi","Puglia"],
  ["LE","Lecce","Puglia"],["BT","Barletta-Andria-Trani","Puglia"],["PZ","Potenza","Basilicata"],["MT","Matera","Basilicata"],
  ["CS","Cosenza","Calabria"],["CZ","Catanzaro","Calabria"],["RC","Reggio Calabria","Calabria"],["KR","Crotone","Calabria"],
  ["VV","Vibo Valentia","Calabria"],["TP","Trapani","Sicilia"],["PA","Palermo","Sicilia"],["ME","Messina","Sicilia"],["AG","Agrigento","Sicilia"],
  ["CL","Caltanissetta","Sicilia"],["EN","Enna","Sicilia"],["CT","Catania","Sicilia"],["RG","Ragusa","Sicilia"],["SR","Siracusa","Sicilia"],
  ["SS","Sassari","Sardegna"],["NU","Nuoro","Sardegna"],["CA","Cagliari","Sardegna"],["OR","Oristano","Sardegna"],["SU","Sud Sardegna","Sardegna"]
];

const REGOLE = [
  "L'iscrizione è gratuita, in cambio del riquadro «Siamo nell'elenco fornitori di TIX» sul vostro sito (regola 6), e si può modificare o cancellare in ogni momento dal link personale.",
  "TIX controlla ogni iscrizione prima di pubblicarla e può non pubblicarla o toglierla, per esempio se i dati non sono veri o l'azienda non lavora nell'edilizia.",
  "L'elenco è ordinato per vicinanza o per nome. TIX non dà giudizi, classifiche o garanzie sulle aziende iscritte, e non è parte dei rapporti tra aziende e imprese.",
  "I dati visibili alle imprese sono quelli scritti nel modulo. I dati delle imprese clienti di TIX non sono mai visibili alle aziende iscritte.",
  "Una volta all'anno vi chiediamo di confermare l'iscrizione; senza conferma l'iscrizione viene nascosta.",
  "Il riquadro «Siamo nell'elenco fornitori di TIX» sul vostro sito è obbligatorio per restare nell'elenco: ve lo mandiamo quando TIX apre al pubblico. Se non viene pubblicato entro 30 giorni dall'invio, TIX può nascondere l'iscrizione."
];

const INFORMATIVA = "<b>Come usiamo i dati di questo modulo.</b> Titolare del trattamento è Obetti Filippo, ditta individuale (TIX · Diario di cantiere), " +
  "Via Bassa II, 57 — 35011 Campodarsego (PD), privacy@tixcantiere.it. Usiamo i dati per iscrivere la vostra azienda all'elenco fornitori di TIX, " +
  "controllare l'iscrizione prima di pubblicarla, mostrarla alle imprese che usano TIX e permettere loro di inviarvi richieste di offerta; una volta " +
  "all'anno vi chiediamo per email se siete ancora attivi. Base giuridica: la vostra richiesta d'iscrizione (art. 6, par. 1, lett. b, GDPR) e, per il " +
  "nome e il ruolo della persona di riferimento, il legittimo interesse a un contatto professionale (lett. f). Alle imprese clienti di TIX sono visibili " +
  "solo i dati che scrivete nel modulo, compresi nome e ruolo della persona di riferimento se li indicate: consigliamo contatti aziendali. I dati stanno " +
  "su server in Irlanda (Supabase); le email di conferma partono da Brevo (Francia). Conservazione: finché l'iscrizione è attiva; se non confermate " +
  "l'email entro 7 giorni l'iscrizione si cancella da sola; se non rispondete alla richiesta annuale, l'iscrizione viene nascosta e cancellata dopo " +
  "12 mesi. Potete modificare o cancellare l'iscrizione in ogni momento dal link personale che ricevete per email, oppure scrivendo a " +
  "privacy@tixcantiere.it, dove potete esercitare anche gli altri diritti previsti dagli artt. 15–22 GDPR; potete inoltre rivolgervi al Garante per " +
  "la protezione dei dati personali. Informativa completa: <a href=\"https://www.tixcantiere.it/privacy-policy\">www.tixcantiere.it/privacy-policy</a>.";

function elEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function elUrl(env) { return env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co"; }

async function elRpc(env, nome, corpo) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(elUrl(env) + "/rest/v1/rpc/" + nome, {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpo), signal: ctrl.signal
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

async function elImpronta(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function elJson(dati, stato) {
  return new Response(JSON.stringify(dati), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

function elOrigineOk(request) {
  const o = request.headers.get("origin") || "";
  return !o || ELENCO_ORIGINI.has(o);
}

// solo i campi che il database conosce, già accorciati
function elCampi(d) {
  const x = d && typeof d === "object" ? d : {};
  const t = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, n);
  const lista = (v, max, n) => (Array.isArray(v) ? v : []).slice(0, max).map((y) => t(y, n)).filter(Boolean);
  return {
    ragione_sociale: t(x.ragione_sociale, 160), partita_iva: t(x.partita_iva, 20), tipi: lista(x.tipi, 3, 20), voci: lista(x.voci, 450, 30),
    altro: t(x.altro, 300), province: lista(x.province, 110, 2), sede_comune: t(x.sede_comune, 80), sede_provincia: t(x.sede_provincia, 2),
    email: t(x.email, 160), telefono: t(x.telefono, 30), sito: t(x.sito, 200), referente_nome: t(x.referente_nome, 80),
    referente_ruolo: t(x.referente_ruolo, 80), descrizione: t(x.descrizione, 300),
    logo_path: ELENCO_LOGO.test(String(x.logo_path || "")) ? String(x.logo_path) : "", togli_logo: x.togli_logo === true
  };
}

async function elTogliLogo(env, percorso) {
  if (!ELENCO_LOGO.test(String(percorso || ""))) return;
  await fetch(elUrl(env) + "/storage/v1/object/wa-media/" + percorso, {
    method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
}

// ---------------------------------------------------------------------------- pagina
const ELENCO_CSS =
  "*{box-sizing:border-box}html,body{margin:0}body{background:#F4F3F0;color:#1B2F4A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.5}" +
  "header{background:#1B2F4A;color:#fff;padding:14px 18px}header b{color:#F26A10;letter-spacing:.02em}header span{opacity:.8;margin-left:8px;font-size:.92rem}" +
  "main{max-width:860px;margin:0 auto;padding:22px 16px 60px}h1{font-size:clamp(22px,4vw,30px);margin:6px 0 8px}h2{font-size:1.08rem;margin:26px 0 8px;color:#1B2F4A}" +
  ".sotto{color:#5B6270;margin:0 0 14px}.box{background:#fff;border-radius:14px;padding:18px;border:1px solid #E3E1DA;margin:14px 0}" +
  "label{display:block;margin:10px 0}label>span{display:block;font-size:.86rem;color:#3A4757;margin-bottom:4px;font-weight:600}" +
  "input[type=text],input[type=email],input[type=tel],input[type=url],select,textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid #C9CFD8;border-radius:10px;background:#fff;color:#1B2F4A}" +
  "textarea{min-height:80px}input:focus,select:focus,textarea:focus{outline:2px solid #F26A10;outline-offset:1px}.due{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}" +
  ".spunte{display:flex;flex-wrap:wrap;gap:8px 18px}.spunte label{display:flex;gap:8px;align-items:center;margin:4px 0;font-weight:600}" +
  ".cerca{margin:6px 0 10px}.macro{border:1px solid #E3E1DA;border-radius:10px;margin:6px 0;background:#FBFAF7}.macro summary{cursor:pointer;padding:9px 12px;font-weight:600}" +
  ".macro summary small{color:#5B6270;font-weight:400}.voci{padding:4px 12px 10px;display:grid;grid-template-columns:1fr 1fr;gap:2px 14px}.voci label{display:flex;gap:8px;align-items:flex-start;margin:3px 0;font-size:.9rem;font-weight:400}" +
  ".tipo-t{margin:14px 0 4px;font-size:.95rem;color:#B34E0B;text-transform:uppercase;letter-spacing:.04em}.regione{margin:8px 0}.regione b{display:block;font-size:.9rem;margin-bottom:2px}" +
  ".regione label{display:inline-flex;gap:5px;align-items:center;margin:2px 12px 2px 0;font-size:.88rem;font-weight:400}.regione .tutta{font-weight:600;color:#B34E0B}" +
  ".prov-box{max-height:340px;overflow:auto;border:1px solid #E3E1DA;border-radius:10px;padding:8px 12px;background:#FBFAF7}" +
  "button{font:inherit;font-weight:700;font-size:1rem;padding:12px 22px;border:0;border-radius:10px;background:#F26A10;color:#fff;cursor:pointer;min-height:46px}" +
  "button.sec{background:#fff;color:#1B2F4A;border:1.5px solid #1B2F4A}button.rosso{background:#fff;color:#B3261E;border:1.5px solid #B3261E}button:disabled{opacity:.6;cursor:wait}" +
  "button:focus-visible,a:focus-visible{outline:2px solid #1B2F4A;outline-offset:2px}.bott{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}" +
  ".msg{margin:12px 0 0;font-weight:600}.msg.ok{color:#12804A}.msg.err{color:#B3261E}.regole{font-size:.9rem;color:#3A4757;padding-left:20px}.regole li{margin:4px 0}" +
  ".info{font-size:.8rem;color:#5B6270;line-height:1.5;margin-top:14px}.trappola{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}" +
  ".logo-vista{max-height:70px;max-width:220px;border:1px solid #E3E1DA;border-radius:8px;padding:4px;background:#fff;display:block;margin:6px 0}" +
  ".stato{display:inline-block;padding:3px 12px;border-radius:999px;background:#EAF4EE;color:#12804A;font-weight:700;font-size:.85rem}.stato.att{background:#FFF3E8;color:#B34E0B}" +
  "footer{text-align:center;font-size:.8rem;color:#8A8A8A;padding:20px}" +
  "@media (max-width:640px){.due,.voci{grid-template-columns:1fr}main{padding:16px 12px 50px}}";

function elPagina(titolo, corpo, script) {
  const html = '<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#1B2F4A">' +
    '<title>' + elEsc(titolo) + ' — Elenco fornitori di TIX</title><style>' + ELENCO_CSS + '</style></head><body>' +
    '<header><b>TIX</b><span>Elenco fornitori e subappaltatori</span></header><main>' + corpo + '</main>' +
    '<footer>TIX · Diario di cantiere™ · www.tixcantiere.it · info@tixcantiere.it</footer>' +
    (script ? '<script>' + script + '</script>' : '') + '</body></html>';
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" } });
}

function elMessaggio(titolo, testo) {
  return elPagina(titolo, '<div class="box"><h1>' + elEsc(titolo) + '</h1>' + testo + '</div>', "");
}

// Il modulo (iscrizione e pagina personale) lo disegna il browser dai dati: voci, province, regole e, nella pagina personale, la scheda.
const ELENCO_SCRIPT = String.raw`
(function(){
var D=window.__ELENCO__||{};var VOCI=D.voci||[],PROV=D.province||[],S=D.scheda||null,MIA=!!D.mia;
function es(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function $(id){return document.getElementById(id);}
var TIPI={fornitore:'Fornitore di materiali',subappaltatore:'Subappaltatore (lavorazioni)',noleggio:'Noleggio di mezzi e attrezzature'};
var scelte={},provSel={},logo=S&&S.logo_path||'',togliLogo=false,t0=Date.now();
if(S){(S.voci||[]).forEach(function(v){scelte[v.codice]=1;});(S.province||[]).forEach(function(p){provSel[p]=1;});}
function tipiScelti(){return Array.prototype.slice.call(document.querySelectorAll('[name=tipo]:checked')).map(function(x){return x.value;});}
function disegnaVoci(){var tp=tipiScelti(),q=($('cerca').value||'').toLowerCase().trim(),h='';
 if(!tp.length){$('voci').innerHTML='<p class="sotto">Scegliete prima cosa siete (fornitore, subappaltatore, noleggio): qui compaiono le voci.</p>';return;}
 tp.forEach(function(t){var gruppi={},ord=[];VOCI.forEach(function(v){if(v.tipo!==t)return;if(q&&(v.nome+' '+v.macro).toLowerCase().indexOf(q)<0&&!scelte[v.codice])return;
   if(!gruppi[v.macro_codice]){gruppi[v.macro_codice]={nome:v.macro,v:[]};ord.push(v.macro_codice);}gruppi[v.macro_codice].v.push(v);});
  if(!ord.length)return;h+='<div class="tipo-t">'+es(TIPI[t])+'</div>';
  ord.forEach(function(m){var g=gruppi[m],n=g.v.filter(function(v){return scelte[v.codice];}).length;
   h+='<details class="macro"'+(q||n?' open':'')+'><summary>'+es(g.nome)+' <small>'+(n?'· '+n+' scelte':'')+'</small></summary><div class="voci">'+
    g.v.map(function(v){return '<label><input type="checkbox" data-voce="'+es(v.codice)+'"'+(scelte[v.codice]?' checked':'')+'><span>'+es(v.nome)+'</span></label>';}).join('')+'</div></details>';});});
 $('voci').innerHTML=h||'<p class="sotto">Nessuna voce con queste parole: scrivete in «Altro» cosa vendete o fate.</p>';}
function disegnaProv(){var reg={},ord=[];PROV.forEach(function(p){if(!reg[p[2]]){reg[p[2]]=[];ord.push(p[2]);}reg[p[2]].push(p);});
 $('prov').innerHTML=ord.map(function(r){var tutte=reg[r].every(function(p){return provSel[p[0]];});
  return '<div class="regione"><b>'+es(r)+'</b><label class="tutta"><input type="checkbox" data-reg="'+es(r)+'"'+(tutte?' checked':'')+'> tutta la regione</label>'+
   reg[r].map(function(p){return '<label><input type="checkbox" data-prov="'+p[0]+'"'+(provSel[p[0]]?' checked':'')+'> '+es(p[1])+'</label>';}).join('')+'</div>';}).join('');}
function sedi(){$('sede_provincia').innerHTML='<option value="">—</option>'+PROV.slice().sort(function(a,b){return a[1].localeCompare(b[1]);}).map(function(p){return '<option value="'+p[0]+'">'+es(p[1])+' ('+p[0]+')</option>';}).join('');
 if(S)$('sede_provincia').value=S.sede_provincia||'';}
function contaProv(){var n=Object.keys(provSel).filter(function(k){return provSel[k];}).length;$('prov-n').textContent=n?n+' province scelte':'nessuna provincia scelta';}
document.addEventListener('change',function(e){var x=e.target;
 if(x.name==='tipo'){disegnaVoci();return;}
 if(x.dataset&&x.dataset.voce){if(x.checked)scelte[x.dataset.voce]=1;else delete scelte[x.dataset.voce];return;}
 if(x.dataset&&x.dataset.prov){if(x.checked)provSel[x.dataset.prov]=1;else delete provSel[x.dataset.prov];disegnaProv();contaProv();return;}
 if(x.dataset&&x.dataset.reg){PROV.forEach(function(p){if(p[2]===x.dataset.reg){if(x.checked)provSel[p[0]]=1;else delete provSel[p[0]];}});disegnaProv();contaProv();return;}
 if(x.id==='logo'){var f=x.files&&x.files[0];if(!f)return;if(f.size>1048576||!/\.(png|jpe?g|webp)$/i.test(f.name)){msg('Il logo deve essere PNG, JPG o WEBP, fino a 1 MB.','err');x.value='';return;}msg('');}});
document.addEventListener('input',function(e){if(e.target.id==='cerca')disegnaVoci();if(e.target.id==='descrizione')$('desc-n').textContent=e.target.value.length+'/300';});
function msg(t,c){var m=$('msg');m.textContent=t||'';m.className='msg'+(c?' '+c:'');}
function campi(){var d={};['ragione_sociale','partita_iva','altro','sede_comune','sede_provincia','email','telefono','sito','referente_nome','referente_ruolo','descrizione'].forEach(function(k){var el=$(k);if(el)d[k]=el.value;});
 d.tipi=tipiScelti();var ok={};d.tipi.forEach(function(t){ok[t]=1;});
 d.voci=VOCI.filter(function(v){return scelte[v.codice]&&ok[v.tipo];}).map(function(v){return v.codice;});
 d.province=Object.keys(provSel).filter(function(k){return provSel[k];});return d;}
function caricaLogo(){var el=$('logo'),f=el&&el.files&&el.files[0];if(!f)return Promise.resolve(togliLogo?'':logo);
 msg('Carico il logo…');var q=MIA?'t='+encodeURIComponent(D.t):'k='+encodeURIComponent(D.k);
 return fetch(D.base+'/elenco/logo?'+q+'&nome='+encodeURIComponent(f.name),{method:'POST',body:f}).then(function(r){return r.json();}).then(function(r){
  if(!r||r.esito!=='ok')throw new Error(r&&r.messaggio||'Il logo non si è caricato: riprovate o toglietelo.');return r.percorso;});}
function invia(){var b=$('invia');var d=campi();
 if(!MIA){if(!$('regole_ok').checked||!$('riquadro_ok').checked){msg('Per iscrivervi servono le due spunte: le regole dell\'elenco e il riquadro sul vostro sito.','err');return;}}
 if(!d.tipi.length){msg('Indicate cosa siete: fornitore, subappaltatore o noleggio.','err');return;}
 if(!d.province.length){msg('Indicate almeno una provincia in cui lavorate.','err');return;}
 b.disabled=true;
 caricaLogo().then(function(p){d.logo_path=p||'';if(MIA){d.togli_logo=togliLogo&&!p;}
  if(MIA)return fetch(D.base+'/elenco/mia/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:D.t,azione:'salva',dati:d})});
  d.k=D.k;d.regole_ok=true;d.riquadro_ok=true;d.sito_web_2=$('sito_web_2').value;d.t_ms=Date.now()-t0;
  return fetch(D.base+'/elenco/iscrivi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});})
 .then(function(r){return r.json();}).then(function(r){b.disabled=false;
  if(r&&r.esito==='ok'){if(MIA){msg('Dati salvati.'+(S&&S.stato==='approvato'?' TIX vede la modifica.':''),'ok');return;}
   document.querySelector('main').innerHTML='<div class="box"><h1>Grazie!</h1><p>Vi abbiamo mandato un\'email: aprite il link per confermare l\'iscrizione.</p><p>Dopo il nostro controllo comparirete nell\'elenco di TIX. Se l\'email non arriva, guardate anche nella posta indesiderata.</p></div>';window.scrollTo(0,0);return;}
  msg(r&&r.messaggio?r.messaggio:(r&&r.esito==='troppi'?'Troppe iscrizioni in poco tempo: riprovate tra un\'ora.':r&&r.esito==='chiuso'?'Il modulo non è più aperto con questo link.':'Non è andato: riprovate tra un minuto.'),'err');})
 .catch(function(e){b.disabled=false;msg(e&&e.message?e.message:'Connessione assente: riprovate.','err');});}
function azioneMia(az){if(az==='cancella'&&!confirm('Cancellare definitivamente la vostra iscrizione? I dati si cancellano subito e non si possono recuperare.'))return;
 fetch(D.base+'/elenco/mia/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:D.t,azione:az,dati:{}})}).then(function(r){return r.json();}).then(function(r){
  if(!r||r.esito!=='ok'){msg(r&&r.messaggio||'Non è andato: riprovate.','err');return;}
  if(az==='cancella'){document.querySelector('main').innerHTML='<div class="box"><h1>Iscrizione cancellata</h1><p>Abbiamo cancellato i dati della vostra azienda dall\'elenco fornitori di TIX.</p></div>';return;}
  msg('Grazie: l\'iscrizione resta attiva per un altro anno.','ok');var s=$('stato-an');if(s)s.remove();}).catch(function(){msg('Connessione assente: riprovate.','err');});}
document.addEventListener('click',function(e){var x=e.target.closest&&e.target.closest('[data-az]');if(!x)return;e.preventDefault();var az=x.getAttribute('data-az');
 if(az==='invia')invia();else if(az==='togli_logo'){togliLogo=true;logo='';var v=$('logo-vista');if(v)v.remove();x.remove();}else azioneMia(az);});
sedi();disegnaProv();contaProv();
if(S){['ragione_sociale','partita_iva','altro','sede_comune','email','telefono','sito','referente_nome','referente_ruolo','descrizione'].forEach(function(k){var el=$(k);if(el&&S[k]!=null)el.value=S[k];});
 (S.tipi||[]).forEach(function(t){var c=document.querySelector('[name=tipo][value="'+t+'"]');if(c)c.checked=true;});var dn=$('desc-n');if(dn)dn.textContent=String(S.descrizione||'').length+'/300';}
disegnaVoci();
})();`;

function elModuloHtml(mia, scheda) {
  const s = scheda || {};
  const stati = { da_approvare: "In attesa del controllo di TIX", approvato: "Nell'elenco", nascosto: "Nascosta", rifiutato: "Non pubblicata", da_confermare: "Email da confermare" };
  let h = "";
  if (mia) {
    h += '<h1>La vostra iscrizione</h1><p class="sotto">' + elEsc(s.ragione_sociale || "") + ' · P. IVA ' + elEsc(s.partita_iva || "") +
      ' · <span class="stato' + (s.stato === "approvato" ? "" : " att") + '">' + elEsc(stati[s.stato] || s.stato || "") + '</span></p>';
    if (s.richiesta_annuale_il) h += '<div class="box" id="stato-an"><b>Siete ancora attivi?</b><p class="sotto">Una volta all\'anno chiediamo di confermare l\'iscrizione: senza conferma entro 30 giorni l\'iscrizione viene nascosta.</p><button type="button" data-az="conferma_annuale">Siamo ancora attivi</button></div>';
    else if (s.stato === "nascosto" && s.nascosto_per === "senza_risposta") h += '<div class="box" id="stato-an"><b>L\'iscrizione è nascosta perché non abbiamo ricevuto la conferma annuale.</b><p class="sotto">Premete il pulsante per farla tornare visibile.</p><button type="button" data-az="conferma_annuale">Siamo ancora attivi</button></div>';
  } else {
    h += '<h1>Entrate nell\'elenco fornitori di TIX</h1><p class="sotto">TIX™ · Diario di cantiere è l\'app delle imprese edili per il diario, i preventivi e le richieste di offerta. ' +
      'Le imprese che usano TIX vi trovano per zona e per lavorazione e vi possono mandare richieste di offerta. L\'iscrizione è gratuita e la controlliamo prima di pubblicarla.</p>';
  }
  h += '<div class="box"><h2 style="margin-top:0">La vostra azienda</h2>' +
    '<label><span>Ragione sociale *</span><input type="text" id="ragione_sociale" maxlength="160" autocomplete="organization"></label>' +
    '<label><span>Partita IVA *</span><input type="text" id="partita_iva" maxlength="13" inputmode="numeric"' + (mia ? ' readonly' : '') + '></label>' +
    '<div class="spunte">' + [["fornitore", "Fornitore di materiali"], ["subappaltatore", "Subappaltatore"], ["noleggio", "Noleggio"]].map((t) =>
      '<label><input type="checkbox" name="tipo" value="' + t[0] + '"> ' + t[1] + '</label>').join("") + '</div>' +
    '<h2>Cosa vendete o fate</h2><p class="sotto">Scegliete le voci: le imprese vi trovano così. Potete scrivere qui sotto per cercare.</p>' +
    '<input type="text" id="cerca" class="cerca" placeholder="Cerca una voce, per esempio «calcestruzzo» o «escavatore»">' +
    '<div id="voci"></div><label><span>Altro (se non trovate la voce giusta, fino a 300 caratteri)</span><textarea id="altro" maxlength="300"></textarea></label>' +
    '<h2>Dove lavorate *</h2><p class="sotto" id="prov-n"></p><div class="prov-box" id="prov"></div>' +
    '<h2>Sede e contatti</h2><div class="due"><label><span>Comune della sede *</span><input type="text" id="sede_comune" maxlength="80"></label>' +
    '<label><span>Provincia della sede *</span><select id="sede_provincia"></select></label></div>' +
    '<div class="due"><label><span>Email per le richieste di offerta *</span><input type="email" id="email" maxlength="160" autocomplete="email"></label>' +
    '<label><span>Telefono</span><input type="tel" id="telefono" maxlength="30" autocomplete="tel"></label></div>' +
    '<label><span>Sito web</span><input type="url" id="sito" maxlength="200" placeholder="www.vostrosito.it"></label>' +
    '<div class="due"><label><span>Persona di riferimento (facoltativo)</span><input type="text" id="referente_nome" maxlength="80"></label>' +
    '<label><span>Ruolo (facoltativo)</span><input type="text" id="referente_ruolo" maxlength="80"></label></div>' +
    '<p class="sotto" style="font-size:.85rem">Le imprese vedono i dati che scrivete qui, compresa la persona di riferimento se la indicate: consigliamo email e telefono aziendali.</p>' +
    '<label><span>Due righe su di voi (<span id="desc-n">0/300</span>)</span><textarea id="descrizione" maxlength="300"></textarea></label>' +
    '<label><span>Logo (PNG, JPG o WEBP, fino a 1 MB)</span>' +
    (mia && s.logo_path ? '<img id="logo-vista" class="logo-vista" alt="Logo attuale" src="/elenco/logo?p=' + encodeURIComponent(s.logo_path) + '">' : '') +
    '<input type="file" id="logo" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"></label>' +
    (mia && s.logo_path ? '<button type="button" class="sec" data-az="togli_logo">Togli il logo</button>' : '') +
    '<div class="trappola" aria-hidden="true"><label>Lasciate vuoto<input type="text" id="sito_web_2" tabindex="-1" autocomplete="off"></label></div>';
  if (!mia) {
    h += '<h2>Regole dell\'elenco</h2><ol class="regole">' + REGOLE.map((r) => '<li>' + elEsc(r) + '</li>').join("") + '</ol>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-weight:600"><input type="checkbox" id="regole_ok"> <span>Accetto le regole dell\'elenco *</span></label>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-weight:600"><input type="checkbox" id="riquadro_ok"> <span>Ci impegniamo a mettere sul nostro sito il riquadro «Siamo nell\'elenco fornitori di TIX» quando TIX ce lo manda *</span></label>';
  }
  h += '<div class="bott"><button type="button" id="invia" data-az="invia">' + (mia ? "Salva le modifiche" : "Iscrivimi all'elenco") + '</button></div>' +
    '<p class="msg" id="msg" aria-live="polite"></p>' +
    (mia ? '' : '<p class="info">' + INFORMATIVA + '</p>') + '</div>';
  if (mia) {
    h += '<div class="box"><h2 style="margin-top:0">Cancellare l\'iscrizione</h2><p class="sotto">I dati della vostra azienda si cancellano subito e in modo definitivo.</p>' +
      '<button type="button" class="rosso" data-az="cancella">Cancella l\'iscrizione</button><p class="info">' + INFORMATIVA + '</p></div>';
  }
  return h;
}

function elDati(o) {
  // dati per lo script della pagina: JSON dentro <script>, con «<» protetto
  return "window.__ELENCO__=" + JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") + ";";
}

// ---------------------------------------------------------------------------- rotte
export async function elencoRoute(request, env, sotto, prefisso) {
  const url = new URL(request.url);
  if (!env.SUPABASE_SERVICE_KEY) return new Response("Servizio non configurato.", { status: 503 });

  if (sotto === "/elenco/iscriviti") {
    const k = String(url.searchParams.get("k") || "").slice(0, 64);
    const r = await elRpc(env, "elenco_modulo", { p_codice: k });
    if (!r || r.esito !== "ok") return elMessaggio("Modulo non disponibile", '<p>Il modulo d\'iscrizione si apre solo con il link d\'invito che vi ha mandato TIX. Se pensate che sia un errore, scrivete a info@tixcantiere.it.</p>');
    return elPagina("Iscrizione", elModuloHtml(false, null), elDati({ base: prefisso, k, voci: r.voci || [], province: PROVINCE, mia: false }) + ELENCO_SCRIPT);
  }

  if (sotto === "/elenco/iscrivi") {
    if (request.method !== "POST") return elJson({ esito: "non_valido" }, 405);
    if (!elOrigineOk(request)) return elJson({ esito: "non_valido" }, 403);
    if (Number(request.headers.get("content-length") || 0) > 32768) return elJson({ esito: "non_valido" }, 413);
    let d;
    try { d = JSON.parse((await request.text()).slice(0, 32768)); } catch (e) { return elJson({ esito: "non_valido" }, 400); }
    if (!d || typeof d !== "object") return elJson({ esito: "non_valido" }, 400);
    // trappole per i programmi automatici: campo nascosto compilato o modulo inviato in meno di 4 secondi → finta risposta ok
    if (d.sito_web_2 || (Number(d.t_ms) >= 0 && Number(d.t_ms) < 4000)) return elJson({ esito: "ok" });
    const ip = request.headers.get("cf-connecting-ip") || "";
    const giorno = new Date().toISOString().slice(0, 10);   // impronta che cambia ogni giorno, cancellata entro 24 ore
    const ipHash = ip ? (await elImpronta("elenco|" + giorno + "|" + ip)).slice(0, 32) : null;
    const p = Object.assign(elCampi(d), { codice: String(d.k || "").slice(0, 64), regole_ok: d.regole_ok === true, riquadro_ok: d.riquadro_ok === true, ip_hash: ipHash });
    delete p.togli_logo;
    const r = await elRpc(env, "elenco_iscrivi", { p });
    return elJson(r && r.esito ? { esito: r.esito, messaggio: r.messaggio || "" } : { esito: "errore" });
  }

  if (sotto === "/elenco/logo") {
    if (request.method === "GET" || request.method === "HEAD") {
      const p = String(url.searchParams.get("p") || "");
      if (!ELENCO_LOGO.test(p)) return new Response("Not Found", { status: 404 });
      const f = await fetch(elUrl(env) + "/storage/v1/object/wa-media/" + p, {
        headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
      if (!f || !f.ok) return new Response("Not Found", { status: 404 });
      const tipo = p.endsWith(".png") ? "image/png" : p.endsWith(".webp") ? "image/webp" : "image/jpeg";
      return new Response(f.body, { status: 200, headers: { "Content-Type": tipo, "Cache-Control": "public, max-age=86400",
        "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" } });
    }
    if (request.method !== "POST") return elJson({ esito: "non_valido" }, 405);
    if (!elOrigineOk(request)) return elJson({ esito: "non_valido" }, 403);
    // il logo si carica solo con il codice d'invito valido o con il link personale valido
    const k = String(url.searchParams.get("k") || "").slice(0, 64), t = String(url.searchParams.get("t") || "").toLowerCase();
    let ok = false;
    if (k) { const r = await elRpc(env, "elenco_modulo", { p_codice: k }); ok = !!(r && r.esito === "ok"); }
    else if (ELENCO_TOKEN.test(t)) { const r = await elRpc(env, "elenco_mia", { p_token: t, p_azione: "vedi", p_dati: {} }); ok = !!(r && r.esito === "ok"); }
    if (!ok) return elJson({ esito: "non_valido", messaggio: "Il link non vale più: ricaricate la pagina dall'email." }, 403);
    if (Number(request.headers.get("content-length") || 0) > ELENCO_LOGO_MAX) return elJson({ esito: "grande", messaggio: "Il logo può essere al massimo di 1 MB." }, 413);
    const b = new Uint8Array(await request.arrayBuffer());
    if (!b.length || b.length > ELENCO_LOGO_MAX) return elJson({ esito: "grande", messaggio: "Il logo può essere al massimo di 1 MB." }, 413);
    let est = "";
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) est = "png";
    else if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) est = "jpg";
    else if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) est = "webp";
    if (!est) return elJson({ esito: "formato", messaggio: "Il logo deve essere un'immagine PNG, JPG o WEBP." }, 415);
    const ora = new Date();
    const nome = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join("");
    const percorso = "elenco/" + ora.getUTCFullYear() + String(ora.getUTCMonth() + 1).padStart(2, "0") + "/" + nome + "." + est;
    const up = await fetch(elUrl(env) + "/storage/v1/object/wa-media/" + percorso, {
      method: "POST", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY,
        "Content-Type": est === "png" ? "image/png" : est === "webp" ? "image/webp" : "image/jpeg", "x-upsert": "false" }, body: b }).catch(() => null);
    if (!up || !up.ok) return elJson({ esito: "archivio", messaggio: "Il logo non si è salvato: riprovate tra un minuto." }, 502);
    return elJson({ esito: "ok", percorso });
  }

  if (sotto === "/elenco/conferma") {
    const t = String(url.searchParams.get("t") || "").toLowerCase();
    const r = ELENCO_TOKEN.test(t) ? await elRpc(env, "elenco_conferma", { p_token: t }) : null;
    if (!r || r.esito !== "ok") return elMessaggio("Link non valido", '<p>Questo link non vale più: forse è passato troppo tempo oppure ne avete ricevuto uno più recente. Se serve, scrivete a info@tixcantiere.it.</p>');
    return elMessaggio("Email confermata", '<p>Grazie, l\'email di <b>' + elEsc(r.ragione_sociale || "") + '</b> è confermata.</p>' +
      (r.stato === "approvato" ? '<p>La vostra azienda è già nell\'elenco fornitori di TIX.</p>' : '<p>Ora controlliamo l\'iscrizione: vi scriviamo quando comparite nell\'elenco.</p>') +
      '<p><a href="' + elEsc(prefisso + "/elenco/mia?t=" + t) + '">Vedete o modificate i vostri dati</a></p>');
  }

  if (sotto === "/elenco/mia") {
    const t = String(url.searchParams.get("t") || "").toLowerCase();
    const r = ELENCO_TOKEN.test(t) ? await elRpc(env, "elenco_mia", { p_token: t, p_azione: "vedi", p_dati: {} }) : null;
    if (!r || r.esito !== "ok") return elMessaggio("Link non valido", '<p>Questo link non vale più: usate quello dell\'ultima email che vi abbiamo mandato, oppure scrivete a info@tixcantiere.it.</p>');
    return elPagina("La vostra iscrizione", elModuloHtml(true, r.scheda),
      elDati({ base: prefisso, t, voci: r.voci_tutte || [], province: PROVINCE, scheda: r.scheda, mia: true }) + ELENCO_SCRIPT);
  }

  if (sotto === "/elenco/mia/api") {
    if (request.method !== "POST") return elJson({ esito: "non_valido" }, 405);
    if (!elOrigineOk(request)) return elJson({ esito: "non_valido" }, 403);
    let d;
    try { d = JSON.parse((await request.text()).slice(0, 32768)); } catch (e) { return elJson({ esito: "non_valido" }, 400); }
    const t = String(d && d.t || "").toLowerCase(), az = String(d && d.azione || "");
    if (!ELENCO_TOKEN.test(t) || ["salva", "conferma_annuale", "cancella"].indexOf(az) < 0) return elJson({ esito: "non_valido" }, 400);
    const r = await elRpc(env, "elenco_mia", { p_token: t, p_azione: az, p_dati: az === "salva" ? elCampi(d.dati) : {} });
    if (!r) return elJson({ esito: "errore" });
    if (r.esito === "ok" && az === "salva" && r.logo_vecchio) await elTogliLogo(env, r.logo_vecchio);
    if (r.esito === "ok" && az === "cancella" && r.logo_path) await elTogliLogo(env, r.logo_path);
    return elJson({ esito: r.esito, messaggio: r.messaggio || "" });
  }

  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8", "X-Robots-Tag": "noindex" } });
}
