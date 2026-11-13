// ---------------------------------------------------------------------------
// Condividi il diario (12/11/2026, diario-condividi-1, chat 02). Richiesta di Filippo; sue scelte del 12/11: collegamento che
// vale 30 giorni, chiunque usa l'app può condividere, nessun avviso ma la spia «Letto» nell'elenco.
// - Nella scheda Diario del cantiere: pulsante «Condividi il diario» → finestra con periodo (scorciatoie), destinatari da Persone
//   del cantiere e Rubrica o scritti a mano, caselle Foto / Ore / DDT, messaggio; sotto, le condivisioni fatte con «Letto» e «Ritira».
//   POST {base}/diario/condividi  { t, c, azione: "stato" | "contesto" | "condividi" | "ritira", dati }   → database diario_condividi
// - Chi riceve apre un collegamento personale che scade: GET {base}/diario/v/<gettone> → pagina in sola lettura (diario_esterni_html,
//   mai le economie del subappaltatore) con «Scarica il PDF» (stampa del browser: niente crediti PDF.co).
//   La spia «Letto» si accende solo quando la pagina si apre davvero nel browser (POST {base}/diario/v/<gettone>/letto), non con i
//   controlli automatici dei programmi di posta.
// Il relay non conserva niente. Interruttore nel database: impostazioni.diario_condividi_attivo (no / prova / si);
// DIARIO_CONDIVIDI = "off" toglie pulsante e pagine.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GETTONE = /^[0-9a-f]{48}$/;

function jsonRisposta(oggetto, stato) {
  return new Response(JSON.stringify(oggetto), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

// Il pulsante si chiede al database insieme alla pagina del cantiere (come Sicurezza e Preventivi): errore = niente pulsante.
export async function diarioCondividiPulsante(env, h, token, commessa) {
  try {
    const r = await h.rpc(env, "diario_condividi", { p_token: token, p_commessa: commessa, p_azione: "stato", p_dati: {} }, 6000);
    return r && r.esito === "ok" && r.attiva === true ? r : null;
  } catch (e) { return null; }
}

export async function portaleDiarioCondividi(request, env, h, base, inUrl) {
  const sotto = inUrl.pathname.slice(String(base || "").length);
  if (env.DIARIO_CONDIVIDI === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) return new Response("Servizio non configurato.", { status: 503 });
  if (sotto.startsWith("/diario/v/")) return paginaEsterni(request, env, h, base, sotto.slice("/diario/v/".length));
  if (sotto !== "/diario/condividi") return new Response("Not Found", { status: 404 });
  if (request.method !== "POST") return jsonRisposta({ esito: "metodo_non_consentito" }, 405);
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return jsonRisposta({ esito: "errore" }, 415);
  let b;
  try { const t = await request.text(); if (t.length > 12000) return jsonRisposta({ esito: "errore" }, 413); b = JSON.parse(t); } catch (e) { b = null; }
  if (!b || typeof b !== "object") return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  const t = String(b.t || "").toLowerCase();
  const c = String(b.c || "").toLowerCase();
  const azione = String(b.azione || "");
  if (!/^[0-9a-f]{64}$/.test(t)) return jsonRisposta({ esito: "gettone" }, 403);
  if (!UUID.test(c) || ["contesto", "condividi", "ritira"].indexOf(azione) === -1) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  const d = b.dati && typeof b.dati === "object" ? b.dati : {};
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  let dati = {};
  if (azione === "ritira") dati = { id: s(d.id, 15) };
  if (azione === "condividi") {
    const dest = Array.isArray(d.destinatari) ? d.destinatari.slice(0, 10).map((x) => ({ nome: s(x && x.nome, 120), email: s(x && x.email, 200) })) : [];
    dati = { dal: s(d.dal, 10), al: s(d.al, 10), foto: d.foto !== false, ore: d.ore !== false, ddt: d.ddt !== false,
             messaggio: s(d.messaggio, 1500), autore: s(d.autore, 120), destinatari: dest };
  }
  const r = await h.rpc(env, "diario_condividi", { p_token: t, p_commessa: c, p_azione: azione, p_dati: dati }, 20000).catch(() => null);
  if (r === null || typeof r !== "object") return jsonRisposta({ esito: "incerto" }, 502);
  return jsonRisposta(r, r.esito === "gettone" ? 403 : 200);
}

async function paginaEsterni(request, env, h, base, resto) {
  const metodo = request.method;
  const parti = String(resto || "").split("/");
  const tok = String(parti[0] || "").toLowerCase();
  if (!GETTONE.test(tok)) return new Response("Not Found", { status: 404 });
  if (parti[1] === "letto") {
    if (metodo !== "POST") return jsonRisposta({ esito: "metodo_non_consentito" }, 405);
    const r = await h.rpc(env, "diario_condivisione_apri", { p_gettone: tok, p_azione: "letto" }, 8000).catch(() => null);
    return jsonRisposta({ esito: r && r.esito ? r.esito : "incerto" });
  }
  if (parti.length > 1) return new Response("Not Found", { status: 404 });
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const e = h.esc;
  const r = await h.rpc(env, "diario_condivisione_apri", { p_gettone: tok, p_azione: "apri" }, 25000).catch(() => null);
  const avviso = (titolo, testo, stato) => h.risposta(h.foglio(base, titolo, "", '<p>' + testo + '</p>'), stato);
  if (!r) return avviso("Diario di cantiere", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", 503);
  if (r.esito === "scaduto") return avviso("Collegamento scaduto", "Il collegamento al diario di " + e(r.impresa || "cantiere") + " è scaduto. Se ti serve ancora, chiedi all’impresa di mandartelo di nuovo.", 410);
  if (r.esito === "ritirato") return avviso("Collegamento ritirato", "L’impresa " + e(r.impresa || "") + " ha ritirato questo collegamento al diario di cantiere.", 410);
  if (r.esito !== "ok" || typeof r.html !== "string") return avviso("Diario di cantiere", "Collegamento non valido.", 404);
  const nome = String(r.nome_file || "Diario-di-cantiere").replace(/[^A-Za-z0-9._-]+/g, "-");
  const pagina = '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>" + e(nome) + "</title><style>" +
    "html,body{background:#fff!important}body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1B2F4A;max-width:900px;margin:0 auto!important;padding:14px 14px 32px!important}" +
    ".dv-barra{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:space-between;background:#FFF7EA;border:1px solid #F1D7AE;border-radius:12px;padding:10px 12px;margin:0 0 14px;font-size:.9rem}" +
    ".dv-barra button{font:inherit;font-weight:700;border:0;background:#F26A10;color:#1B2F4A;border-radius:999px;padding:9px 18px;cursor:pointer}" +
    ".dv-barra span{color:#5A3D00}@media print{.dv-barra{display:none}body{max-width:none;padding:0!important}@page{margin:12mm}}" +
    "</style></head><body>" +
    '<div class="dv-barra"><span>Diario di <b>' + e(r.impresa) + "</b> &middot; dal " + e(r.dal) + " al " + e(r.al) +
    " &middot; collegamento valido fino al " + e(r.scade_il) + "</span>" +
    '<button type="button" onclick="window.print()" title="Nella finestra di stampa scegli «Salva come PDF»">Scarica il PDF</button></div>' +
    r.html +
    "<script>(function(){try{fetch(location.pathname.replace(/\\/$/,'')+'/letto',{method:'POST',keepalive:true,credentials:'omit'}).catch(function(){});}catch(e){}})();</script>" +
    "</body></html>";
  return new Response(metodo === "HEAD" ? null : pagina, { status: 200, headers: h.headers() });
}

// Stile e script iniettati nella pagina del cantiere (area riservata), solo se la funzione è accesa per questo accesso.
export function diarioCondividiIniezione(base, token, commessa, prova) {
  const cfg = JSON.stringify({ u: base + "/diario/condividi", t: token, c: commessa, prova: prova === true });
  const stile = "<style>" +
    ".gl-dc-b{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;min-height:46px;margin:0 0 12px;border:1px solid #1B2F4A;border-radius:12px;background:#fff;color:#1B2F4A;font:inherit;font-weight:700;font-size:1rem;cursor:pointer;letter-spacing:normal;text-transform:none;box-shadow:none}" +
    ".gl-dc-b:hover,.gl-dc-b:focus-visible{background:#1B2F4A;color:#fff;outline:none}" +
    ".gl-dc-ov{position:fixed;inset:0;z-index:9999;background:rgba(10,18,28,.55);display:flex;align-items:center;justify-content:center;padding:12px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".gl-dc-bx{background:#fff;color:#1b1f1d;border-radius:14px;max-width:560px;width:100%;max-height:92vh;overflow:auto;padding:18px 18px 14px;box-shadow:0 10px 40px rgba(0,0,0,.35)}" +
    ".gl-dc-bx h3{margin:0 0 6px;font-size:1.15rem;color:#1B2F4A}.gl-dc-bx h4{margin:16px 0 6px;font-size:.95rem;color:#1B2F4A}" +
    ".gl-dc-bx label.t{display:block;font-size:.85rem;font-weight:600;margin:10px 0 4px}" +
    ".gl-dc-bx input[type=date],.gl-dc-bx input[type=email],.gl-dc-bx input[type=text],.gl-dc-bx textarea{display:block;width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #c9d1cd;border-radius:8px;font:inherit;font-size:1rem;background:#fff;color:#1b1f1d}" +
    ".gl-dc-due{display:flex;gap:10px}.gl-dc-due>div{flex:1;min-width:0}" +
    ".gl-dc-sc{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}.gl-dc-sc button{width:auto;min-height:32px;padding:0 12px;border:1px solid #c9d1cd;border-radius:999px;background:#F3F6FA;color:#1B2F4A;font:inherit;font-size:.85rem;font-weight:600;cursor:pointer;box-shadow:none}" +
    ".gl-dc-el{max-height:190px;overflow:auto;border:1px solid #D9DEE5;border-radius:10px;padding:4px 8px}" +
    ".gl-dc-el label,.gl-dc-ca label{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:.92rem;margin:0}.gl-dc-el label small{color:#5b6560}" +
    ".gl-dc-el input,.gl-dc-ca input{width:auto;margin:0;flex:none}.gl-dc-ca{display:flex;flex-wrap:wrap;gap:4px 18px}" +
    ".gl-dc-man{display:flex;gap:6px;margin-top:8px}.gl-dc-man input{flex:1;min-width:0}.gl-dc-man button{width:auto;flex:none;padding:0 12px;border:1px solid #c9d1cd;border-radius:8px;background:#fff;font:inherit;font-weight:700;cursor:pointer}" +
    ".gl-dc-ch{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.gl-dc-ch span{display:inline-flex;align-items:center;gap:6px;background:#EEF3F9;border-radius:999px;padding:3px 4px 3px 10px;font-size:.85rem}" +
    ".gl-dc-ch button{width:24px;height:24px;min-height:0;padding:0;border:0;border-radius:50%;background:#fff;cursor:pointer;font-size:.9rem;line-height:1;box-shadow:none}" +
    ".gl-dc-nota{font-size:.84rem;color:#5b6560;margin:8px 0 0}.gl-dc-prova{background:#FFF4E0;border:1px solid #E8B04A;border-radius:8px;padding:8px 10px;font-size:.85rem;margin:0 0 8px}" +
    ".gl-dc-err{color:#a11;font-size:.9rem;margin:10px 0 0}.gl-dc-ok{background:#E3F3EA;border-left:4px solid #0A7D48;border-radius:8px;padding:8px 10px;font-size:.9rem;margin:10px 0 0}" +
    ".gl-dc-az{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px}" +
    ".gl-dc-az button{width:auto;padding:10px 16px;border-radius:10px;border:1px solid #c9d1cd;background:#fff;color:#1b1f1d;font:inherit;font-weight:700;cursor:pointer;box-shadow:none}" +
    ".gl-dc-az button.pr{background:#F26A10;border-color:#F26A10;color:#1B2F4A}.gl-dc-az button[disabled]{opacity:.55;cursor:wait}" +
    ".gl-dc-st{border:1px solid #D9DEE5;border-radius:10px;padding:8px 10px;margin:0 0 8px;font-size:.88rem}.gl-dc-st.via{opacity:.6}" +
    ".gl-dc-st .r{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap}.gl-dc-st .d{margin:4px 0 0;display:flex;flex-wrap:wrap;gap:6px}" +
    ".gl-dc-st .d span{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;background:#F3F6FA;font-size:.8rem}" +
    ".gl-dc-st .d span.l{background:#E3F3EA;color:#0A7D48;font-weight:700}.gl-dc-st .d span i{font-style:normal}" +
    ".gl-dc-st button{width:auto;min-height:30px;padding:0 10px;border:1px solid #c62828;border-radius:8px;background:#fdecec;color:#c62828;font:inherit;font-size:.82rem;font-weight:700;cursor:pointer;box-shadow:none}" +
    "@media (prefers-color-scheme:dark){.gl-dc-b{background:#1a201d;color:#eef2f0;border-color:#5b6b80}.gl-dc-bx{background:#1a201d;color:#eef2f0}.gl-dc-bx h3,.gl-dc-bx h4{color:#cfe0ff}" +
    ".gl-dc-bx input[type=date],.gl-dc-bx input[type=email],.gl-dc-bx input[type=text],.gl-dc-bx textarea{background:#111513;color:#eef2f0;border-color:#3a4540}" +
    ".gl-dc-az button,.gl-dc-man button{background:#232b27;color:#eef2f0;border-color:#3a4540}.gl-dc-ch span,.gl-dc-st .d span,.gl-dc-sc button{background:#232b27;color:#eef2f0}}" +
    "</style>";
  const script = "<script>(function(){try{\nvar CFG=" + cfg + ";\n" +
    "function el(t,c,h){var e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;}\n" +
    "function esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});}\n" +
    "function iso(d){return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);}\n" +
    "function dIt(s){var p=String(s||'').split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:s;}\n" +
    "function post(azione,dati){return fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:azione,dati:dati||{}})}).then(function(r){return r.json();});}\n" +
    "var P=document.getElementById('p-g');if(!P||P.querySelector('.gl-dc-b'))return;\n" +
    "var B=el('button','gl-dc-b','&#128228; Condividi il diario');B.type='button';P.insertBefore(B,P.firstChild);\n" +
    "B.addEventListener('click',apri);\n" +
    "function apri(){var ov=el('div','gl-dc-ov'),bx=el('div','gl-dc-bx','<h3>Condividi il diario</h3><p class=\"gl-dc-nota\">Carico&hellip;</p>');ov.appendChild(bx);document.body.appendChild(ov);\n" +
    " function chiudi(){if(ov.parentNode)ov.parentNode.removeChild(ov);document.removeEventListener('keydown',tasto);}\n" +
    " function tasto(e){if(e.key==='Escape')chiudi();}document.addEventListener('keydown',tasto);\n" +
    " ov.addEventListener('click',function(e){if(e.target===ov)chiudi();});\n" +
    " post('contesto').then(function(r){if(!r||r.esito!=='ok'){bx.innerHTML='<h3>Condividi il diario</h3><p class=\"gl-dc-err\">'+(r&&r.esito==='spento'?'La funzione non è attiva.':'Non riesco a caricare i dati: riprova tra un minuto.')+'</p><div class=\"gl-dc-az\"><button type=\"button\">Chiudi</button></div>';bx.querySelector('button').onclick=chiudi;return;}disegna(r);}).catch(function(){bx.innerHTML='<h3>Condividi il diario</h3><p class=\"gl-dc-err\">Connessione assente: riprova.</p>';});\n" +
    " function disegna(K){var oggi=new Date(K.oggi+'T12:00:00'),scelti=[];\n" +
    "  var lun=new Date(oggi);lun.setDate(oggi.getDate()-((oggi.getDay()+6)%7));var mese=new Date(oggi.getFullYear(),oggi.getMonth(),1);\n" +
    "  var h=(K.prova?'<div class=\"gl-dc-prova\"><b>In prova:</b> le email partono solo verso l’indirizzo di TIX, non ai destinatari.</div>':'')+\n" +
    "   '<h3>Condividi il diario</h3><p class=\"gl-dc-nota\" style=\"margin-top:0\">Chi riceve apre il diario con un collegamento personale che vale '+K.giorni+' giorni, in sola lettura, e può scaricare il PDF. Le economie del subappaltatore non si vedono mai.</p>'+\n" +
    "   '<h4>Periodo</h4><div class=\"gl-dc-due\"><div><label class=\"t\" for=\"gl-dc-dal\">Dal</label><input type=\"date\" id=\"gl-dc-dal\" max=\"'+K.oggi+'\"></div><div><label class=\"t\" for=\"gl-dc-al\">Al</label><input type=\"date\" id=\"gl-dc-al\" max=\"'+K.oggi+'\"></div></div>'+\n" +
    "   '<div class=\"gl-dc-sc\"><button type=\"button\" data-p=\"s\">Questa settimana</button><button type=\"button\" data-p=\"m\">Questo mese</button><button type=\"button\" data-p=\"i\">Da inizio lavori</button></div>'+\n" +
    "   '<h4>A chi</h4>'+(K.contatti.length?'<div class=\"gl-dc-el\">'+K.contatti.map(function(x,i){return '<label><input type=\"checkbox\" data-i=\"'+i+'\"> <span>'+esc(x.nome||x.email)+' <small>'+esc(x.email)+(x.ruolo?' &middot; '+esc(x.ruolo):'')+' &middot; '+(x.da==='cantiere'?'Persone del cantiere':'Rubrica')+'</small></span></label>';}).join('')+'</div>':'<p class=\"gl-dc-nota\">In Persone del cantiere e in Rubrica non ci sono contatti con l’email: scrivila qui sotto.</p>')+\n" +
    "   '<div class=\"gl-dc-man\"><input type=\"email\" id=\"gl-dc-em\" placeholder=\"Oppure scrivi un’email\" autocomplete=\"off\"><button type=\"button\" id=\"gl-dc-piu\">Aggiungi</button></div><div class=\"gl-dc-ch\" id=\"gl-dc-ch\"></div>'+\n" +
    "   '<h4>Cosa includere</h4><div class=\"gl-dc-ca\"><label><input type=\"checkbox\" id=\"gl-dc-f\" checked> Foto</label><label><input type=\"checkbox\" id=\"gl-dc-o\" checked> Ore</label><label><input type=\"checkbox\" id=\"gl-dc-d\" checked> DDT</label></div>'+\n" +
    "   '<label class=\"t\" for=\"gl-dc-msg\">Messaggio (facoltativo)</label><textarea id=\"gl-dc-msg\" rows=\"3\" maxlength=\"1500\"></textarea>'+\n" +
    "   '<div id=\"gl-dc-es\"></div><div class=\"gl-dc-az\"><button type=\"button\" id=\"gl-dc-no\">Chiudi</button><button type=\"button\" class=\"pr\" id=\"gl-dc-si\">Condividi</button></div>'+\n" +
    "   '<h4>Condivisioni fatte</h4><div id=\"gl-dc-el2\"></div>';\n" +
    "  bx.innerHTML=h;var q=function(s){return bx.querySelector(s);};\n" +
    "  function periodo(p){var a=oggi,d=p==='s'?lun:p==='m'?mese:new Date(K.inizio+'T12:00:00');q('#gl-dc-dal').value=iso(d);q('#gl-dc-al').value=iso(a);}\n" +
    "  periodo('s');bx.querySelectorAll('.gl-dc-sc button').forEach(function(b){b.onclick=function(){periodo(b.getAttribute('data-p'));};});\n" +
    "  function chips(){var c=q('#gl-dc-ch');c.innerHTML='';scelti.forEach(function(x,i){var s=el('span','',esc(x.email));var b=el('button','','&times;');b.type='button';b.title='Togli';b.onclick=function(){scelti.splice(i,1);chips();};s.appendChild(b);c.appendChild(s);});}\n" +
    "  q('#gl-dc-piu').onclick=function(){var v=q('#gl-dc-em').value.trim();if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v)){q('#gl-dc-es').innerHTML='<p class=\"gl-dc-err\">Questa email non sembra giusta.</p>';return;}q('#gl-dc-es').innerHTML='';if(!scelti.some(function(x){return x.email.toLowerCase()===v.toLowerCase();}))scelti.push({nome:'',email:v});q('#gl-dc-em').value='';chips();};\n" +
    "  q('#gl-dc-em').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();q('#gl-dc-piu').click();}});\n" +
    "  q('#gl-dc-no').onclick=chiudi;\n" +
    "  q('#gl-dc-si').onclick=function(){var dest=scelti.slice();bx.querySelectorAll('.gl-dc-el input:checked').forEach(function(i){var x=K.contatti[+i.getAttribute('data-i')];if(x&&!dest.some(function(y){return y.email.toLowerCase()===x.email.toLowerCase();}))dest.push({nome:x.nome||'',email:x.email});});\n" +
    "   var v=q('#gl-dc-em').value.trim();if(v&&/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v)&&!dest.some(function(y){return y.email.toLowerCase()===v.toLowerCase();}))dest.push({nome:'',email:v});\n" +
    "   var es=q('#gl-dc-es');if(!dest.length){es.innerHTML='<p class=\"gl-dc-err\">Scegli almeno un destinatario.</p>';return;}\n" +
    "   var bt=this;bt.disabled=true;bt.textContent='Invio…';\n" +
    "   post('condividi',{dal:q('#gl-dc-dal').value,al:q('#gl-dc-al').value,foto:q('#gl-dc-f').checked,ore:q('#gl-dc-o').checked,ddt:q('#gl-dc-d').checked,messaggio:q('#gl-dc-msg').value,destinatari:dest}).then(function(r){bt.disabled=false;bt.textContent='Condividi';\n" +
    "    if(r&&r.esito==='ok'){es.innerHTML='<div class=\"gl-dc-ok\">Fatto: '+r.inviate+(r.inviate===1?' email partita':' email partite')+(r.prova?' (in prova, all’indirizzo di TIX)':'')+'.</div>';scelti=[];chips();bx.querySelectorAll('.gl-dc-el input:checked').forEach(function(i){i.checked=false;});q('#gl-dc-msg').value='';elenco();}\n" +
    "    else es.innerHTML='<p class=\"gl-dc-err\">'+esc(r&&r.messaggio?r.messaggio:'Non è partito niente: riprova tra un minuto.')+'</p>';}).catch(function(){bt.disabled=false;bt.textContent='Condividi';es.innerHTML='<p class=\"gl-dc-err\">Connessione assente: riprova.</p>';});};\n" +
    "  function elenco(){post('contesto').then(function(r){if(r&&r.esito==='ok'){K.condivisioni=r.condivisioni;lista();}});}\n" +
    "  function lista(){var c=q('#gl-dc-el2');if(!K.condivisioni.length){c.innerHTML='<p class=\"gl-dc-nota\">Nessuna condivisione per ora.</p>';return;}\n" +
    "   c.innerHTML=K.condivisioni.map(function(s){var via=s.ritirata||s.scaduta;var cosa=[s.foto?'foto':'',s.ore?'ore':'',s.ddt?'DDT':''].filter(Boolean).join(', ');\n" +
    "    return '<div class=\"gl-dc-st'+(via?' via':'')+'\"><div class=\"r\"><span><b>'+dIt(s.dal)+' &ndash; '+dIt(s.al)+'</b>'+(cosa?' &middot; con '+cosa:'')+'<br><small>'+esc(s.creato_il)+(s.autore?' &middot; '+esc(s.autore):'')+' &middot; '+(s.ritirata?'ritirato':s.scaduta?'scaduto':'vale fino al '+esc(s.scade_il))+(s.prova?' &middot; prova':'')+'</small></span>'+(via?'':'<button type=\"button\" data-r=\"'+s.id+'\">Ritira</button>')+'</div>'+\n" +
    "     '<div class=\"d\">'+(s.dest||[]).map(function(d){return d.letto_il?'<span class=\"l\" title=\"Aperto '+d.aperture+(d.aperture===1?' volta':' volte')+', l’ultima il '+esc(d.ultimo_il)+'\"><i>&#9679;</i> Letto &middot; '+esc(d.nome||d.email)+' &middot; '+esc(d.letto_il)+'</span>':'<span><i>&#9675;</i> '+esc(d.nome||d.email)+' &middot; non ancora aperto</span>';}).join('')+'</div></div>';}).join('');\n" +
    "   c.querySelectorAll('button[data-r]').forEach(function(b){b.onclick=function(){if(!confirm('Ritiro il collegamento? Chi l’ha ricevuto non potrà più aprire il diario.'))return;b.disabled=true;post('ritira',{id:b.getAttribute('data-r')}).then(function(){elenco();});};});}\n" +
    "  lista();}\n" +
    "}\n" +
    "}catch(e){}})();</script>";
  return stile + script;
}
