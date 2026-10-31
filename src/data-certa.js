// ============================================================================
// DATA CERTA — Area riservata (13/10/2026)
// Opzione «data certa con marca temporale», accesa e spenta dall'impresa da sola (decisione di Filippo del
// 13/10/2026, 17:01: «deve essere una cosa autonoma che il mio cliente deve fare da solo cliccando sull'icona
// corretta»). Regole di pagamento approvate alle 17:24: a giorni, sulla base di 9 € + IVA al mese per cantiere,
// sempre in anticipo; allo spegnimento i giorni non usati si detraggono dalla fattura successiva.
//   GET  /data-certa?t=<gettone>[&a=<impresa>]   → pagina: cantieri attivi, stato dell'opzione, Accendi/Spegni
//   POST /data-certa/anteprima {t, a?, c, azione} → importo esatto per il riquadro di conferma
//   POST /data-certa/cambia    {t, a?, c, azione} → esegue il cambio
// Le due POST vanno alla Edge Function «data-certa» di Supabase, che fa tutto (database, Stripe, registro).
// Il relay aggiunge l'intestazione x-chiave-data-certa (letta da impostazioni con la chiave di servizio) e l'IP
// del cliente (cf-connecting-ip), che finisce nel registro data_certa_eventi. Il relay non scrive e non conserva nulla.
// L'icona indaco nella riga dei servizi la mette il database (portale_azioni_html), solo per le imprese abilitate.
// ============================================================================

const FUNZIONE = "/functions/v1/data-certa";
const SUPABASE_PREDEFINITO = "https://rvigugiufrjmzedjstuz.supabase.co";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GETTONE = /^[0-9a-f]{64}$/;

export const DATA_CERTA_ICONA =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3.5" y="5" width="17" height="15.5" rx="2.4"/><path d="M8 3v4M16 3v4M3.5 10h17"/><path d="M8.7 15.2l2.3 2.3 4.4-4.6"/></svg>';

let chiaveCache = null; // { v, t }: la chiave cambia di rado, si rilegge ogni 5 minuti

async function chiaveDataCerta(env) {
  if (chiaveCache && Date.now() - chiaveCache.t < 300000) return chiaveCache.v;
  const base = env.SUPABASE_URL || SUPABASE_PREDEFINITO;
  try {
    const r = await fetch(base + "/rest/v1/impostazioni?chiave=eq.data_certa_chiave&select=valore", {
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, Accept: "application/json" }
    });
    if (!r.ok) return "";
    const j = await r.json();
    const v = Array.isArray(j) && j[0] && typeof j[0].valore === "string" ? j[0].valore : "";
    if (v) chiaveCache = { v, t: Date.now() };
    return v;
  } catch (e) {
    return "";
  }
}

// Inoltro alla Edge Function. «incerto» = nessuna risposta in tempo: la richiesta potrebbe essere arrivata.
async function inoltra(env, percorso, corpo) {
  const base = env.SUPABASE_URL || SUPABASE_PREDEFINITO;
  const chiave = await chiaveDataCerta(env);
  const intestazioni = { "Content-Type": "application/json" };
  if (chiave) intestazioni["x-chiave-data-certa"] = chiave;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 50000);
  try {
    const r = await fetch(base + FUNZIONE + percorso, {
      method: "POST", headers: intestazioni, body: JSON.stringify(corpo), signal: ctrl.signal
    });
    const t = await r.text();
    try {
      const j = JSON.parse(t);
      return j && typeof j === "object" ? j : { esito: "errore" };
    } catch (e) {
      return { esito: "errore" };
    }
  } catch (e) {
    return { esito: "incerto" };
  } finally {
    clearTimeout(timer);
  }
}

function json(o, stato) {
  return new Response(JSON.stringify(o), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

// Solo i campi che servono alla pagina: niente id Stripe o dati interni verso il telefono.
function risposta(j) {
  const o = { esito: String(j.esito || "errore") };
  for (const k of ["messaggio", "testo", "stato", "importo_eur", "iva_eur", "totale_eur", "giorni", "rinnovo", "compresa"]) {
    if (j[k] !== undefined && j[k] !== null && (typeof j[k] !== "object")) o[k] = j[k];
  }
  return o;
}

async function azione(request, env, percorso) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  // Solo JSON: un modulo di un altro sito non puo' mandare questa richiesta senza il permesso del browser.
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return json({ esito: "errore" }, 415);
  let b;
  try {
    const t = await request.text();
    if (t.length > 2000) return json({ esito: "errore" }, 413);
    b = JSON.parse(t);
  } catch (e) {
    return json({ esito: "errore" }, 400);
  }
  const tok = String((b && b.t) || "").toLowerCase();
  const az = String((b && b.a) || "").toLowerCase();
  const c = String((b && b.c) || "").toLowerCase();
  const cosa = String((b && b.azione) || "");
  if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c) || (az && !UUID.test(az)) || (cosa !== "accendi" && cosa !== "spegni")) return json({ esito: "errore" }, 400);
  const corpo = { token: tok, azienda: az, commessa: c, azione: cosa };
  if (percorso === "/cambia") corpo.ip = (request.headers.get("cf-connecting-ip") || "").slice(0, 64) || null;
  return json(risposta(await inoltra(env, percorso, corpo)));
}

export async function portaleDataCerta(request, env, base, inUrl, h) {
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length);
  if (sotto === "/data-certa/anteprima") return azione(request, env, "/anteprima");
  if (sotto === "/data-certa/cambia") return azione(request, env, "/cambia");
  if (sotto !== "/data-certa") return new Response("Not Found", { status: 404 });
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const az = String(inUrl.searchParams.get("a") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  const torna = base + "/?t=" + tok;
  const indietro = '<p class="piede"><a href="' + torna + '">&larr; Torna ai cantieri</a></p>';
  const d = await h.rpc(env, "data_certa_contesto", { p_token: tok, p_azienda: az });
  if (!d) {
    return h.risposta(h.foglio(base, "Data certa", "",
      '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>' + indietro), 503);
  }
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito === "scegli") {
    const lista = (Array.isArray(d.aziende) ? d.aziende : []).map((x) =>
      '<a class="btn" href="' + base + '/data-certa?t=' + tok + '&amp;a=' + h.esc(x.id) + '">' + h.esc(x.nome) + '</a>').join("");
    return h.risposta(h.foglio(base, "Data certa", "Per quale impresa?", (lista || '<p>Nessuna impresa attiva.</p>') + indietro));
  }
  if (d.esito !== "ok" || d.abilitata !== true) {
    return h.risposta(h.foglio(base, "Data certa", d.azienda_nome ? h.esc(d.azienda_nome) : "",
      '<p>La data certa con marca temporale non è ancora disponibile per la tua impresa.</p>' + indietro));
  }
  return new Response(metodo === "HEAD" ? null : paginaDataCerta(base, tok, az, d, h), { status: 200, headers: h.headers() });
}

// ---------------------------------------------------------------------------- pagina
function dataIt(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(t));
}

function rigaCantiere(x, e) {
  const st = String(x.stato || "spenta");
  const acceso = st === "attiva";
  const inCorso = st === "in_attivazione";
  const n = Number(x.marche) || 0;
  let stato;
  if (acceso) stato = '<span class="pill on">Accesa' + (x.dal ? " dal " + e(dataIt(x.dal)) : "") + '</span>';
  else if (inCorso) stato = '<span class="pill att">In attivazione&hellip;</span>';
  else if (x.sospeso) stato = '<span class="pill sos">Cantiere sospeso</span>';
  else stato = '<span class="pill off">Spenta</span>';
  const marcati = n > 0 ? '<span>' + n + (n === 1 ? " documento marcato" : " documenti marcati") + '</span>' : "";
  const nota = !acceso && !inCorso && x.sospeso ? '<span>si potrà accendere dopo il saldo</span>' : "";
  let bottone;
  if (acceso) bottone = '<button type="button" class="spe" data-c="' + e(x.id) + '" data-az="spegni">Spegni</button>';
  else bottone = '<button type="button" class="acc" data-c="' + e(x.id) + '" data-az="accendi"' + (inCorso || x.sospeso ? " disabled" : "") + '>Accendi</button>';
  return '<div class="dc' + (acceso ? " on" : "") + '" data-nome="' + e(x.nome) + '">' +
    '<div class="info"><div class="n">' + e(x.nome) + '</div>' + (x.ubicazione ? '<div class="u">' + e(x.ubicazione) + '</div>' : "") +
    '<div class="s">' + stato + marcati + nota + '</div></div>' + bottone + '</div>';
}

export function paginaDataCerta(base, tok, az, d, h) {
  const e = h.esc;
  const torna = base + "/?t=" + tok;
  const compresa = d.modalita !== "stripe";
  const prezzo = String(Number(d.prezzo_mese_eur) || 9).replace(".", ",");
  const cantieri = Array.isArray(d.cantieri) ? d.cantieri : [];
  const logoImpresa = d.logo_impresa
    ? '<div class="dx"><div class="logo-impresa"><img src="' + e(d.logo_impresa) + '" alt="' + e(d.azienda_nome) + '"></div></div>'
    : '<div class="dx"></div>';
  const comePaghi = compresa
    ? '<p class="prezzo">Per la tua impresa è <b>compresa nel servizio</b>: nessun addebito.</p>'
    : '<p class="prezzo">A giorni, sulla base di <b>' + e(prezzo) + ' € + IVA al mese</b> per cantiere: paghi in anticipo fino al rinnovo e, se la spegni, i giorni non usati ti vengono detratti.</p>';
  const elenco = cantieri.length
    ? cantieri.map((x) => rigaCantiere(x, e)).join("")
    : '<div class="vuoto">Non ci sono cantieri attivi. Quando ne apri uno, da qui puoi accendere la data certa.</div>';
  const dati = JSON.stringify({ base: base, t: tok, a: az, compresa: compresa }).replace(/</g, "\\u003c");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    '<title>Data certa - ' + e(d.azienda_nome) + '</title>' + h.testa(base) +
    '<style>' + STILE + '</style></head><body>' +
    '<header>' + (d.logo_html || '<div class="marchio">TIX · Diario di cantiere</div>') +
    '<div class="centro"><h1>Data certa</h1><p>' + e(d.azienda_nome) + '</p></div>' + logoImpresa + '</header>' +
    '<main><a class="indietro" href="' + torna + '"><span class="sott">&larr; Tutti i cantieri</span></a>' +
    '<section class="intro"><span class="ic" aria-hidden="true">' + DATA_CERTA_ICONA + '</span><div>' +
    '<h2>Data certa con marca temporale</h2>' +
    '<p>Marca temporale qualificata (eIDAS) sul diario di cantiere di ogni sera e sul rapportino settimanale delle ore in economia: dimostra che il documento esisteva in quella forma alla data e all\'ora indicate.</p>' +
    comePaghi + '</div></section>' +
    '<h3 class="tit">I tuoi cantieri attivi</h3>' + elenco +
    '<p class="nota">La accendi e la spegni tu, cantiere per cantiere. Ogni accensione e spegnimento viene registrato con data, ora e indirizzo IP. ' +
    'La marca è un file .tsr che trovi nella pagina del cantiere, accanto al PDF del documento.</p>' +
    '<noscript><p class="nota"><b>Per accendere o spegnere la data certa serve JavaScript attivo nel browser.</b></p></noscript>' +
    '</main>' +
    '<dialog id="dc-dlg" aria-labelledby="dc-tit"><form method="dialog">' +
    '<div class="dl-t"><h2 id="dc-tit"></h2><p id="dc-cant"></p></div>' +
    '<div class="dl-c"><div class="importo info" id="dc-imp" aria-live="polite"></div><p class="pic" id="dc-pic"></p></div>' +
    '<div class="dl-b"><button type="button" class="no" id="dc-no">Annulla</button><button type="button" class="si" id="dc-si" disabled></button></div>' +
    '</form></dialog>' +
    '<script>var GL_DC=' + dati + ';' + SCRIPT + '</script></body></html>';
}

const STILE =
  ':root{--accento:#0A7D48;--bordo:#d5dcd8;--sfondo:#F4F6F5;--ind:#4F46E5;--ind-s:#3730A3;--ind-c:#F5F5FF;--ind-b:#C7CBF7}' +
  '*{box-sizing:border-box}body{margin:0;padding:0 0 40px;background:var(--sfondo);color:#111;line-height:1.45;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
  'header{background:#052A21;color:#fff;padding:16px 20px 18px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;column-gap:16px}' +
  'header .logo{display:block;height:44px;width:auto}header .marchio{font-weight:800;font-size:1.05rem}' +
  'header .centro{grid-column:2;grid-row:1;text-align:center}header .centro p{margin:4px 0 0;font-size:.88rem;opacity:.9}' +
  '@keyframes gl-argento{0%{background-position:0% 50%}100%{background-position:100% 50%}}' +
  'header h1{margin:0;font-size:clamp(1.4rem,3vw,1.9rem);letter-spacing:-.01em;background:linear-gradient(90deg,#9AA6AB 0%,#E9EEF0 22%,#FFFFFF 38%,#C9D3D6 55%,#F4F7F8 72%,#9AA6AB 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent}' +
  '@media (prefers-reduced-motion:no-preference){header h1{animation:gl-argento 3.5s ease-in-out infinite alternate}}' +
  'header .dx{grid-column:3;grid-row:1;justify-self:end}' +
  'header .logo-impresa{display:inline-block;background:#fff;border-radius:12px;padding:8px 14px;box-shadow:0 2px 10px rgba(0,0,0,.12)}' +
  'header .logo-impresa img{display:block;height:52px;width:auto;max-width:240px;object-fit:contain}' +
  '@media (max-width:640px){header{grid-template-columns:1fr auto}header .centro{grid-column:1/-1;grid-row:2;margin-top:12px}header .dx{grid-column:2}header .logo{height:36px}header .logo-impresa img{height:40px}}' +
  'main{max-width:620px;margin:0 auto;padding:16px 16px 0}' +
  // 31/10/2026 (Filippo): sul computer la pagina è larga fino a 1000 px, come le schede del cantiere
  '@media screen and (min-width:760px){main{max-width:min(1000px,calc(100vw - 48px))}}@media screen and (min-width:900px){main{max-width:min(1000px,calc(100vw - 200px))}}' +
  'a.indietro .sott{padding-bottom:2px;background:linear-gradient(90deg,#8E9AA6 0%,#E9EEF1 25%,#B4BEC6 50%,#F4F7F8 75%,#8E9AA6 100%) 0 100%/200% 2px repeat-x;animation:gl-arg 3.2s linear infinite}@keyframes gl-arg{to{background-position:-200% 100%}}@media (prefers-reduced-motion:reduce){a.indietro .sott{animation:none}}' +
  'a.indietro{display:inline-flex;align-items:center;min-height:44px;padding:0 12px 0 0;margin:-8px 0 4px;font-size:.95rem;font-weight:800;color:#0A7D48;text-decoration:none}' +
  '.intro{display:flex;gap:14px;align-items:flex-start;background:var(--ind-c);border:1px solid var(--ind-b);border-radius:14px;padding:14px 16px;margin:0 0 18px}' +
  '.intro .ic{flex-shrink:0;width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#8B93F8,#4F46E5 55%,#3730A3);box-shadow:0 2px 6px rgba(0,0,0,.18)}' +
  '.intro .ic svg{width:25px;height:25px;display:block}' +
  '.intro h2{margin:1px 0 4px;font-size:1.02rem;color:var(--ind-s)}' +
  '.intro p{margin:0 0 6px;font-size:.9rem;color:#2b2f3a}.intro p:last-child{margin:0}.intro .prezzo{color:var(--ind-s)}' +
  'h3.tit{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ind-s);margin:0 0 8px}' +
  '.dc{background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:12px 14px;margin-bottom:10px;display:flex;justify-content:space-between;gap:12px;align-items:center}' +
  '.dc.on{border-color:#A5ACF5;box-shadow:inset 5px 0 0 var(--ind);padding-left:18px}' +
  '.dc .info{min-width:0}.dc .n{font-weight:700;font-size:1.02rem;color:var(--accento);overflow-wrap:anywhere}' +
  '.dc .u{font-size:.84rem;color:#555;margin-top:1px;overflow-wrap:anywhere}' +
  '.dc .s{margin-top:6px;font-size:.8rem;color:#4A524E;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}' +
  '.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-weight:700;font-size:.78rem}' +
  '.pill.on{background:#E8E9FD;color:var(--ind-s)}.pill.off{background:#EEF0EF;color:#4A524E}.pill.att{background:#FFF4DC;color:#7A5300}.pill.sos{background:#fdeaea;color:#8c1d18}' +
  '.dc button{flex-shrink:0;min-width:100px;min-height:44px;font:inherit;font-size:.95rem;font-weight:700;border-radius:10px;padding:0 16px;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
  '.dc button.acc{background:var(--ind);color:#fff;border:1px solid var(--ind)}' +
  '.dc button.spe{background:#fff;color:var(--ind-s);border:1px solid #A5ACF5}' +
  '.dc button:disabled{opacity:.5;cursor:not-allowed}.dc button:focus-visible{outline:3px solid #052A21;outline-offset:2px}' +
  '@media (max-width:360px){.dc{flex-direction:column;align-items:stretch}.dc button{width:100%}}' +
  '.vuoto{background:#fff;border:1px dashed #B9C3BE;border-radius:12px;padding:16px;color:#4A524E;font-size:.92rem}' +
  '.nota{font-size:.82rem;color:#5b6560;margin:16px 2px 0;line-height:1.5}' +
  'dialog{border:0;border-radius:16px;padding:0;width:min(440px,calc(100vw - 32px));box-shadow:0 18px 50px rgba(0,0,0,.28);color:#111}' +
  'dialog::backdrop{background:rgba(5,20,15,.55)}dialog form{margin:0}' +
  '.dl-t{background:var(--ind-c);border-bottom:1px solid #E0E3FB;padding:16px 18px 12px}' +
  '.dl-t h2{margin:0;font-size:1.1rem;color:var(--ind-s)}.dl-t p{margin:4px 0 0;font-size:.92rem;color:#4A524E;overflow-wrap:anywhere}' +
  '.dl-c{padding:14px 18px 2px}' +
  '.importo{border-radius:0 10px 10px 0;padding:12px 14px;font-size:.98rem;line-height:1.45}' +
  '.importo b{white-space:nowrap}' +
  '.importo.paga{background:#FFF4DC;border-left:4px solid #E8A317;color:#5a4206}' +
  '.importo.credito,.importo.ok{background:#E9F7EF;border-left:4px solid #1a9c4b;color:#14532d}' +
  '.importo.info{background:#F4F5F7;border-left:4px solid #9AA3AD;color:#333}' +
  '.importo.ko{background:#fdecea;border-left:4px solid #b3261e;color:#8c1d18}' +
  '.pic{font-size:.84rem;color:#5b6560;margin:10px 0 0}.pic:empty{display:none}' +
  '.dl-b{display:flex;gap:10px;padding:16px 18px 18px}' +
  '.dl-b button{flex:1;min-height:46px;font:inherit;font-weight:700;font-size:1rem;border-radius:10px;cursor:pointer}' +
  '.dl-b .no{background:#fff;color:#333;border:1px solid #c9d1cc}' +
  '.dl-b .si{background:var(--ind);color:#fff;border:1px solid var(--ind)}.dl-b .si:disabled{opacity:.5;cursor:wait}' +
  '.dl-b .si[hidden]{display:none}';

// Riquadro di conferma: prima l'anteprima (importo esatto), poi il cambio. Dopo il cambio la pagina si ricarica.
const SCRIPT = String.raw`(function(){try{
var D=GL_DC,dlg=document.getElementById('dc-dlg');if(!dlg||typeof dlg.showModal!=='function'){
 var bs=document.querySelectorAll('.dc button');for(var i=0;i<bs.length;i++)bs[i].disabled=true;
 var nt=document.querySelector('.nota');if(nt)nt.insertAdjacentHTML('beforebegin','<p class="nota"><b>Questo browser non mostra il riquadro di conferma: aggiornalo o usa un altro browser per accendere o spegnere la data certa.</b></p>');return;}
var tit=document.getElementById('dc-tit'),cant=document.getElementById('dc-cant'),imp=document.getElementById('dc-imp'),pic=document.getElementById('dc-pic'),
 no=document.getElementById('dc-no'),si=document.getElementById('dc-si'),cor=null,fatto=false,occupato=false;
function eur(v){var n=Math.abs(Number(v)||0);return n.toFixed(2).replace('.',',');}
function riq(cl,html){imp.className='importo '+cl;imp.innerHTML=html;}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function post(p,az){return fetch(D.base+'/data-certa/'+p,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
 body:JSON.stringify({t:D.t,a:D.a,c:cor.c,azione:az})}).then(function(r){return r.json();});}
function apri(c,az,nome){cor={c:c,az:az,nome:nome};fatto=false;occupato=false;
 tit.textContent=az==='accendi'?'Accendere la data certa?':'Spegnere la data certa?';cant.textContent=nome;
 pic.textContent='';no.textContent='Annulla';si.hidden=false;si.disabled=true;si.textContent=az==='accendi'?(D.compresa?'Accendi':'Accendi e paga'):'Spegni';
 riq('info','Calcolo l’importo…');dlg.showModal();
 post('anteprima',az).then(function(j){if(!cor||cor.c!==c)return;
  if(j.esito!=='ok'){riq('ko',esc(j.messaggio||'Non riesco a calcolare l’importo in questo momento: riprova tra poco.'));si.hidden=true;no.textContent='Chiudi';return;}
  if(az==='accendi'){
   if(j.compresa||D.compresa){riq('info','Per la tua impresa la data certa è compresa: nessun addebito.');}
   else{riq('paga','Paghi ora <b>'+eur(j.importo_eur)+' € + IVA</b>'+(j.totale_eur?' ('+eur(j.totale_eur)+' € IVA compresa)':'')+' per '+(j.giorni==1?'il giorno':'i '+esc(j.giorni)+' giorni')+' fino al rinnovo del '+esc(j.rinnovo)+'.');
    pic.textContent='L’addebito va sulla carta dell’abbonamento; dal rinnovo la data certa si paga in anticipo con il canone.';}
   pic.textContent=(pic.textContent?pic.textContent+' ':'')+'Vale per i documenti da adesso in poi.';
  }else{
   if(j.compresa||D.compresa){riq('info','Per la tua impresa la data certa è compresa: nessun conguaglio.');}
   else if(Number(j.importo_eur)<0){riq('credito','Ti verranno detratti <b>'+eur(j.importo_eur)+' € + IVA</b> dalla prossima fattura, per '+(j.giorni==1?'il giorno':'i '+esc(j.giorni)+' giorni')+' non usati.');}
   else{riq('info','Oggi è l’ultimo giorno già pagato: non resta nulla da detrarre.');}
   pic.textContent='Da adesso i nuovi documenti di questo cantiere non ricevono più la marca; quelle già apposte restano valide.';
  }
  si.disabled=false;try{si.focus();}catch(x){}
 }).catch(function(){if(!cor||cor.c!==c)return;riq('ko','Il servizio non risponde: controlla la connessione e riprova.');si.hidden=true;no.textContent='Chiudi';});
}
si.addEventListener('click',function(){if(!cor||occupato)return;occupato=true;var az=cor.az;si.disabled=true;si.textContent='Attendi…';no.disabled=true;pic.textContent='';
 riq('info',az==='accendi'&&!D.compresa?'Pagamento in corso: non chiudere la pagina…':'Un momento…');
 post('cambia',az).then(function(j){fatto=true;occupato=false;no.disabled=false;si.hidden=true;no.textContent='Chiudi';
  if(j.esito==='ok'||j.esito==='fatto'){
   if(az==='accendi')riq('ok','<b>Data certa accesa.</b> Da adesso il diario di cantiere di ogni sera e il rapportino settimanale delle ore in economia di questo cantiere ricevono la marca temporale.'+(Number(j.importo_eur)>0?' Pagati '+eur(j.importo_eur)+' € + IVA.':''));
   else riq('ok','<b>Data certa spenta.</b>'+(Number(j.importo_eur)<0?' '+eur(j.importo_eur)+' € + IVA verranno detratti dalla prossima fattura.':''));
  }else if(j.esito==='gia'){riq('info','Era già '+(j.stato==='attiva'?'accesa':'spenta')+'.');}
  else if(j.esito==='rifiutato'){riq('ko','<b>Pagamento non riuscito:</b> la data certa resta spenta. Controlla la carta dell’abbonamento e riprova.');}
  else if(j.esito==='in_corso'){riq('info',esc(j.messaggio||'C’è già un cambio in corso: riprova tra qualche secondo.'));}
  else if(j.esito==='incerto'){riq('info','Non ho avuto risposta in tempo. Ricarica la pagina tra un minuto per vedere lo stato: se qualcosa non torna lo sistemiamo noi.');}
  else if(j.esito==='gettone'){location.href=D.base+'/';}
  else{riq('ko',esc(j.messaggio||'Il cambio non è riuscito: riprova tra poco.'));}
 }).catch(function(){fatto=true;occupato=false;no.disabled=false;si.hidden=true;no.textContent='Chiudi';
  riq('info','Non ho avuto risposta. Ricarica la pagina tra un minuto per vedere lo stato.');});
});
no.addEventListener('click',function(){if(occupato)return;dlg.close();});
dlg.addEventListener('cancel',function(ev){if(occupato)ev.preventDefault();});
dlg.addEventListener('close',function(){var f=fatto;cor=null;fatto=false;if(f)location.reload();});
var bs=document.querySelectorAll('.dc button[data-c]');
for(var k=0;k<bs.length;k++)bs[k].addEventListener('click',function(){var r=this.closest('.dc');apri(this.getAttribute('data-c'),this.getAttribute('data-az'),r?r.getAttribute('data-nome'):'');});
window.addEventListener('pageshow',function(ev){if(ev.persisted)location.reload();});
}catch(x){}})();
`;
