// ---------------------------------------------------------------------------
// Pagina del cantiere: riquadro «Ufficio» sotto le schede (chat B15, 14/11/2026).
// Scelte di Filippo: in alto le schede di ogni giorno come oggi; sotto un riquadro «Ufficio» con due righe,
// «Squadra e tecnico» e «Soldi»; «Scarica tutto in Excel» come link piccolo in fondo; un colore per riga;
// una riga di spiegazione al primo accesso. Piano: Strumenti/restyling-tix/pagina-cantiere/01-piano.md
//
// NON crea pulsanti: prende quelli che le altre chat hanno già messo nella pagina (riga .gl-azioni o barre
// .gl-*-barra), li riconosce dalla classe, li sposta nel riquadro nell'ordine scelto e li ridisegna. Il collegamento,
// i gestori del clic e i numerini (.gl-sc-n, .gl-of-n, .gl-cs-n, .gl-sb-n) restano quelli della chat che li ha fatti.
// Le sezioni spente non mettono il pulsante, quindi qui non arrivano. Un pulsante che non conosco va in fondo alla
// riga «Squadra e tecnico» con il suo testo. Alcuni script (Costruttivi, Offerte, Subappaltatori, Costi) rimettono il
// loro pulsante in .gl-azioni fino a load + 400 ms: un MutationObserver lo riprende e la riga vuota si toglie.
// index.js mette questo script IN FONDO alla catena (script = script + ...), dopo quello delle frecce.
// Interruttore: impostazioni.pagina_cantiere_ufficio no / prova / si (funzione pagina_cantiere_pulsante);
// PAGINA_CANTIERE = "off" spegne tutto e la pagina torna com'era.
// ---------------------------------------------------------------------------

export async function paginaCantierePulsante(env, token, commessa) {
  if (!env || !env.SUPABASE_SERVICE_KEY || env.PAGINA_CANTIERE === "off") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch((env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co") + "/rest/v1/rpc/pagina_cantiere_pulsante", {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_token: token, p_commessa: commessa }), signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j !== "object" || j.esito !== "ok" || j.attiva !== true) return null;
    const prova = Array.isArray(j.prova) ? j.prova.filter(k => typeof k === "string" && /^[a-z]{2,20}$/.test(k)).slice(0, 20) : [];
    return { attiva: true, prova };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const S = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICONE = {
  persone: S + '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20v-1.2A4.8 4.8 0 0 1 8.3 14h1.4a4.8 4.8 0 0 1 4.8 4.8V20"/><path d="M16 4.6a3.2 3.2 0 0 1 0 6.2"/><path d="M18 14.2a4.8 4.8 0 0 1 2.5 4.2V20"/></svg>',
  sicurezza: S + '<path d="M12 3 5 6v5.5c0 4.3 3 7.9 7 9.5 4-1.6 7-5.2 7-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>',
  progetti: S + '<path d="M3.5 20.5 13 4"/><path d="M20.5 20.5 11 4"/><circle cx="12" cy="4" r="1.6"/><path d="M6.3 15.7c3.6 2 7.8 2 11.4 0"/></svg>',
  costruttivi: S + '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
  prove: S + '<path d="M9 3h6M10 3v6.2L4.8 18.4A1.8 1.8 0 0 0 6.4 21h11.2a1.8 1.8 0 0 0 1.6-2.6L14 9.2V3"/><path d="M7.2 15h9.6"/></svg>',
  preventivi: S + '<path d="M14 2.8H7a2.2 2.2 0 0 0-2.2 2.2v14a2.2 2.2 0 0 0 2.2 2.2h10a2.2 2.2 0 0 0 2.2-2.2V8z"/><path d="M14 2.8V8h5.2"/><path d="M14.6 12.3a2.9 2.9 0 1 0 0 4.4"/><path d="M8.6 13.7h4.2M8.6 15.4h4.2"/></svg>',
  offerte: S + '<path d="M3 9.5 12 4l9 5.5V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="m3 9.5 9 6 9-6"/></svg>',
  sub: S + '<path d="M4 15a8 8 0 0 1 16 0"/><path d="M10 8V5.5a2 2 0 0 1 4 0V8"/><path d="M2.5 15h19v2.5h-19z"/></svg>',
  costi: S + '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/></svg>',
  economie: S + '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 3.5V2.5h6v1"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/></svg>',
  excel: S + '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/></svg>',
  altro: S + '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/></svg>'
};

// Ordine scelto da Filippo il 14/11. r = riga (0 = Squadra e tecnico, 1 = Soldi, 2 = link in fondo).
const VOCI = [
  { k: "persone",     s: ".gl-pc-b", t: "Persone del cantiere", r: 0 },
  { k: "sicurezza",   s: ".gl-sc-b", t: "Sicurezza", r: 0 },
  { k: "progetti",    s: ".gl-pg-b", t: "Progetti", r: 0 },
  { k: "costruttivi", s: ".gl-cs-b", t: "Costruttivi", r: 0 },
  { k: "prove",       s: 'a.gl-pv-b[href*="/preventivi/prove?"]', t: "Prove materiali", r: 0 },
  { k: "preventivi",  s: 'a.gl-pv-b:not([href*="/preventivi/prove?"])', t: "Preventivi", r: 1 },
  { k: "offerte",     s: ".gl-of-b", t: "Offerte ricevute", r: 1 },
  { k: "sub",         s: ".gl-sb-b", t: "Subappaltatori", r: 1 },
  { k: "costi",       s: ".gl-cm-b", t: "Costi e margine", r: 1 },
  { k: "economie",    s: ".gl-ec-b", t: "Registro delle economie", r: 1 },
  { k: "excel",       s: ".gl-xl-b", t: "Scarica tutto in Excel", r: 2 }
];

const STILE = "<style>" +
  ".gl-uff{margin:12px 0 16px;padding:12px 14px 10px;background:#fff;border:1px solid #D9DEE5;border-radius:14px;font-family:inherit;box-sizing:border-box}" +
  "@media screen and (min-width:901px){.gl-uff{width:min(1180px,calc(100vw - 96px));max-width:none;margin-left:calc(50% - min(590px,calc(50vw - 48px)))}}" +
  ".gl-uff-h{margin:0 0 8px;font-size:1.05rem;font-weight:800;color:#1B2F4A;letter-spacing:0;text-transform:none}" +
  ".gl-uff-g{margin:0 0 10px}.gl-uff-g[hidden],.gl-uff[hidden],.gl-uff-cap[hidden]{display:none!important}" +
  ".gl-uff-g>h3{margin:0 0 6px;font-size:.78rem;font-weight:700;color:#5B6672;letter-spacing:.04em;text-transform:uppercase}" +
  ".gl-uff-r{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 8px}" +
  "@media (min-width:700px){.gl-uff-r{grid-template-columns:repeat(3,minmax(0,1fr))}}" +
  "@media (min-width:1024px){.gl-uff-r{grid-template-columns:repeat(5,minmax(0,1fr))}}" +
  "@media (max-width:339px){.gl-uff-r{grid-template-columns:minmax(0,1fr)}}" +
  ".gl-uff .gl-uff-b{display:flex!important;align-items:center;justify-content:flex-start;gap:8px;width:100%;min-height:48px;margin:0!important;padding:6px 10px!important;" +
  "border:1px solid #D9DEE5!important;border-radius:10px!important;background:#fff!important;color:#17212E!important;box-shadow:none!important;" +
  "font:inherit;font-size:.9rem!important;font-weight:700!important;line-height:1.2;text-align:left;text-decoration:none;white-space:normal;box-sizing:border-box;cursor:pointer}" +
  ".gl-uff .gl-uff-b>svg{flex:none;width:20px;height:20px}" +
  ".gl-uff .gl-uff-b{position:relative}" +
  ".gl-uff .gl-uff-t{flex:1 1 auto;min-width:0;overflow-wrap:break-word;hyphens:manual}" +
  "@media (max-width:420px){.gl-uff .gl-uff-b{font-size:.86rem!important;padding:6px 8px!important;gap:7px}}" +
  ".gl-uff-g[data-r='0'] .gl-uff-b>svg{color:#185FA5}.gl-uff-g[data-r='1'] .gl-uff-b>svg{color:#2E7D32}" +
  ".gl-uff-g[data-r='0'] .gl-uff-b:hover,.gl-uff-g[data-r='0'] .gl-uff-b:focus-visible{border-color:#185FA5!important;background:#EEF4FB!important;outline:none}" +
  ".gl-uff-g[data-r='1'] .gl-uff-b:hover,.gl-uff-g[data-r='1'] .gl-uff-b:focus-visible{border-color:#2E7D32!important;background:#EEF6EE!important;outline:none}" +
  ".gl-uff .gl-uff-b:focus-visible{box-shadow:0 0 0 3px rgba(24,95,165,.28)!important}" +
  ".gl-uff .gl-uff-b [class$='-n']{position:absolute;top:-8px;right:-6px;display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:999px;border:2px solid #fff;background:#B3261E;color:#fff;font-size:.75rem;font-weight:800;line-height:1}" +
  ".gl-uff-p{position:absolute;top:-8px;left:8px;font-size:.66rem;font-weight:700;line-height:1.3;color:#854F0B;background:#FAEEDA;border:1px solid #F0C98A;border-radius:6px;padding:0 5px}" +
  ".gl-uff-r{padding-top:6px}" +
  ".gl-uff-x{display:flex;justify-content:flex-end;margin:2px 0 0}" +
  ".gl-uff .gl-uff-xl{display:inline-flex!important;width:auto!important;align-items:center;gap:6px;min-height:40px;margin:0!important;padding:0 4px!important;border:0!important;background:none!important;box-shadow:none!important;" +
  "color:#1B2F4A!important;font:inherit;font-size:.88rem!important;font-weight:600!important;text-decoration:underline;text-underline-offset:3px;cursor:pointer}" +
  ".gl-uff .gl-uff-xl>svg{width:18px;height:18px}" +
  ".gl-uff .gl-uff-xl:focus-visible{outline:3px solid #185FA5;outline-offset:2px}" +
  ".gl-uff-cap{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px;padding:8px 10px;border-radius:10px;background:#E6F1FB;color:#0C447C;font-size:.88rem;line-height:1.35}" +
  ".gl-uff-cap span{flex:1 1 200px}.gl-uff-cap button{flex:none;width:auto;min-height:36px;padding:0 12px;border:1px solid #0C447C;border-radius:8px;background:#fff;color:#0C447C;font:inherit;font-size:.85rem;font-weight:700;cursor:pointer}" +
  "</style>";

export function paginaCantiereIniezione(opz) {
  const prova = (opz && Array.isArray(opz.prova)) ? opz.prova : [];
  const cfg = JSON.stringify({ v: VOCI, i: ICONE, p: prova });
  return STILE + "<script>" + String.raw`(function(){try{
var C=` + cfg + String.raw`;
var CHIAVE='gl_uff_capito';
function capito(){try{return localStorage.getItem(CHIAVE)==='1';}catch(e){return false;}}
function scatola(){
  var b=document.querySelector('.gl-uff');if(b)return b;
  b=document.createElement('section');b.className='gl-uff';b.setAttribute('aria-label','Ufficio');
  b.innerHTML='<div class="gl-uff-cap" hidden><span>Sopra: il lavoro di ogni giorno. Sotto: l’ufficio.</span><button type="button">Ho capito</button></div>'+
    '<h2 class="gl-uff-h">Ufficio</h2>'+
    '<div class="gl-uff-g" data-r="0"><h3>Squadra e tecnico</h3><div class="gl-uff-r"></div></div>'+
    '<div class="gl-uff-g" data-r="1"><h3>Soldi</h3><div class="gl-uff-r"></div></div>'+
    '<div class="gl-uff-x"></div>';
  b.querySelector('.gl-uff-cap button').addEventListener('click',function(){try{localStorage.setItem(CHIAVE,'1');}catch(e){}b.querySelector('.gl-uff-cap').hidden=true;});
  var dopo=document.querySelector('.schede-w')||document.querySelector('nav.schede');
  if(dopo&&dopo.parentNode)dopo.parentNode.insertBefore(b,dopo.nextSibling);else return null;
  return b;
}
function prepara(el,v){
  if(el.getAttribute('data-uff')===v.k)return;
  var segni=[],ch=el.children;
  for(var i=0;i<ch.length;i++){var c=ch[i];if(c.tagName!=='svg'&&/(^|\s)gl-[a-z]+-n(\s|$)/.test(c.className||''))segni.push(c);}
  el.innerHTML=C.i[v.k]||C.i.altro;
  var t=document.createElement('span');t.className='gl-uff-t';t.textContent=v.t;el.appendChild(t);
  for(var j=0;j<segni.length;j++)el.appendChild(segni[j]);
  if(C.p.indexOf(v.k)!==-1){var p=document.createElement('span');p.className='gl-uff-p';p.textContent='prova';p.title='Sezione in prova: la vedi solo tu';el.appendChild(p);}
  el.classList.add(v.r===2?'gl-uff-xl':'gl-uff-b');el.setAttribute('data-uff',v.k);
}
function metti(cont,el,pos){if(cont.children[pos]!==el)cont.insertBefore(el,cont.children[pos]||null);}
var lavoro=false;
function ordina(){
  lavoro=false;
  var b=scatola();if(!b)return;
  var righe=b.querySelectorAll('.gl-uff-r'),x=b.querySelector('.gl-uff-x'),n=[0,0,0];
  for(var i=0;i<C.v.length;i++){
    var v=C.v[i],el=document.querySelector(v.s);if(!el)continue;
    prepara(el,v);
    var cont=v.r===2?x:righe[v.r];metti(cont,el,n[v.r]);n[v.r]++;
  }
  var resti=document.querySelectorAll('.gl-azioni>a,.gl-azioni>button,main>[class$="-barra"]>a,main>[class$="-barra"]>button');
  for(var k=0;k<resti.length;k++){
    var r=resti[k];if(r.closest('.gl-uff'))continue;
    if(!r.closest('.gl-azioni')&&!/^gl-[a-z]+-barra$/.test(r.parentNode.className||''))continue;
    if(r.getAttribute('data-uff')!=='altro'){r.classList.add('gl-uff-b');r.setAttribute('data-uff','altro');
      if(!r.querySelector('svg'))r.insertAdjacentHTML('afterbegin',C.i.altro);}
    righe[0].appendChild(r);
  }
  var vuoti=document.querySelectorAll('.gl-azioni,main>[class$="-barra"]');
  for(var q=0;q<vuoti.length;q++){var w=vuoti[q];if(!w.children.length&&w.parentNode&&(w.classList.contains('gl-azioni')||/^gl-[a-z]+-barra$/.test(w.className)))w.parentNode.removeChild(w);}
  var gruppi=b.querySelectorAll('.gl-uff-g'),pieni=0;
  for(var g=0;g<gruppi.length;g++){var vuoto=!gruppi[g].querySelector('.gl-uff-r').children.length;gruppi[g].hidden=vuoto;if(!vuoto)pieni++;}
  b.hidden=!pieni&&!x.children.length;
  b.querySelector('.gl-uff-h').hidden=!pieni;
  var cap=b.querySelector('.gl-uff-cap');cap.hidden=!pieni||capito();
}
function presto(){if(lavoro)return;lavoro=true;setTimeout(ordina,0);}
ordina();
var oss=null;
if(window.MutationObserver){oss=new MutationObserver(function(m){for(var i=0;i<m.length;i++){var t=m[i].target;
  if(t&&t.nodeType===1&&(t===document.body||(t.parentNode&&t.parentNode.tagName==='MAIN')||t.tagName==='MAIN'||/gl-azioni|-barra/.test(t.className||''))){presto();return;}}});
  oss.observe(document.body,{childList:true,subtree:true});}
document.addEventListener('DOMContentLoaded',presto);
window.addEventListener('load',function(){presto();setTimeout(ordina,600);setTimeout(function(){ordina();if(oss)oss.disconnect();},3000);});
}catch(e){}})();` + "</script>";
}
