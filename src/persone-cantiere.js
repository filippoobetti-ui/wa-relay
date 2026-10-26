// ============================================================================
// PERSONE DEL CANTIERE (26/10/2026, fase 4 — «vai» di Filippo).
// 1. WhatsApp: «Attivo TIX, codice XXXXXX» è l'invito personale creato dall'impresa nell'area riservata.
//    Lo riconosce il relay PRIMA dell'inoltro a Make: il database (persone_cantiere_attiva) attiva la persona sul
//    cantiere giusto e da qui partono il benvenuto e il biglietto da visita «TIX Cantiere». A prova di guasto:
//    database o Meta che non rispondono → il messaggio prosegue verso Make come prima.
// 2. Area riservata: pagina «Persone del cantiere» (GET /persone?t=&c=) con elenco, aggiunta, interruttori,
//    invito (link, QR, «Condividi su WhatsApp», email preparata dal telefono del referente) e «Togli dal cantiere».
//    Le azioni passano da POST /persone/api {t, c, azione, ...}. Il database decide tutto.
// Interruttore: variabile del Worker PERSONE_CANTIERE = "off" (niente riconoscimento, niente pagina, niente pulsante).
// ============================================================================

const NUMERO_TIX = "393783107501";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GETTONE = /^[0-9a-f]{64}$/;
const INVITO = /^\s*attivo\s+tix\b[\s,.;:!-]*codice\s*[:#-]?\s*([A-Za-z0-9]{6})\s*[.!]?\s*$/i;

export function invitoCodice(msg) {
  if (!msg || msg.type !== "text" || !msg.text) return "";
  const m = String(msg.text.body || "").match(INVITO);
  return m ? m[1].toUpperCase() : "";
}

function testoRisposta(r) {
  const nome = String(r.nome || "").trim().split(/\s+/)[0] || "";
  const imp = r.impresa ? String(r.impresa) : "l'impresa che ti ha invitato";
  if (r.esito === "ok") {
    return "Benvenuto in TIX" + (nome ? ", " + nome : "") + ". Sei nel cantiere *" + r.cantiere + "* di " + imp + "." +
      (r.scrive
        ? " Da ora puoi mandare qui vocali, foto e messaggi: finiscono nel diario di cantiere. Per scegliere un altro cantiere scrivi *Cantiere*."
        : (r.riceve_diario ? " Ogni sera riceverai per email il diario di cantiere." : "")) +
      " Salva il contatto qui sotto, così ritrovi TIX subito.";
  }
  if (r.esito === "gia_attivo") return "Sei già attivo nel cantiere *" + r.cantiere + "*" + (r.scrive ? ": puoi scrivere qui come sempre." : ".");
  if (r.esito === "troppi") return "Troppi tentativi con codici non validi. Riprova tra un'ora, oppure chiedi a " + imp + " un nuovo link d'invito.";
  if (r.esito === "scaduto") return "Il codice d'invito è scaduto. Chiedi a " + imp + " di mandarti un nuovo link: basta un tocco dall'area riservata.";
  if (r.esito === "rimosso_altra") return "Il tuo numero risulta tolto da un'altra impresa che usa TIX, quindi non posso attivarlo qui. Scrivi a info@tixcantiere.it e lo sistemiamo.";
  if (r.esito === "codice_usato") return "Questo codice d'invito è già stato usato da un altro numero. Chiedi a " + imp + " un link d'invito tutto tuo.";
  return "Non trovo questo codice d'invito. Controlla di aver inviato il messaggio così com'era, oppure chiedi a " + imp + " un nuovo link d'invito.";
}

function bigliettoTix(tel) {
  return {
    messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "contacts",
    contacts: [{
      name: { formatted_name: "TIX Cantiere", first_name: "TIX", last_name: "Cantiere" },
      org: { company: "TIX · Diario di cantiere" },
      phones: [{ phone: "+39 378 310 7501", type: "WORK", wa_id: NUMERO_TIX }],
      urls: [{ url: "https://www.tixcantiere.it", type: "WORK" }]
    }]
  };
}

// true = messaggio gestito qui (non va a Make); false = prosegue come prima
export async function invitoGestisci(msg, value, env, h) {
  const codice = invitoCodice(msg);
  const tel = String(msg.from || "");
  const phoneId = (value.metadata && value.metadata.phone_number_id) || "";
  if (!codice || !tel || !phoneId || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN || env.PERSONE_CANTIERE === "off") return false;
  const nomeWa = (value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name) || "";
  const r = await h.rpc(env, "persone_cantiere_attiva", { p_telefono: tel, p_codice: codice, p_nome_wa: String(nomeWa).slice(0, 80) }, 8000);
  if (!r || !r.esito || r.esito === "errore") return false;
  try {
    await h.invia(phoneId, env.WHATSAPP_TOKEN, {
      messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "text",
      context: { message_id: msg.id }, text: { body: testoRisposta(r).slice(0, 1000), preview_url: false }
    });
    if (r.esito === "ok") await h.invia(phoneId, env.WHATSAPP_TOKEN, bigliettoTix(tel));
  } catch (e) {}
  try { await h.log(env, tel, msg.id, "persone_cantiere_invito", codice.slice(0, 2) + "**** → " + r.esito); } catch (e) {}
  return true;
}

// ---------------------------------------------------------------------------
// Area riservata
function json(o, stato) {
  return new Response(JSON.stringify(o), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

export async function portalePersone(request, env, base, inUrl, h) {
  if (env.PERSONE_CANTIERE === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  const sotto = inUrl.pathname.slice(base.length);
  if (sotto === "/persone/api") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return json({ esito: "errore" }, 415);
    let b;
    try { const t = await request.text(); if (t.length > 8000) return json({ esito: "errore" }, 413); b = JSON.parse(t); } catch (e) { return json({ esito: "errore" }, 400); }
    const tok = String((b && b.t) || "").toLowerCase();
    if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
    const c = String(b.c || "").toLowerCase();
    const az = String(b.azione || "");
    const id = Number(b.id);
    const dati = b.dati && typeof b.dati === "object" ? b.dati : {};
    const pulito = {};
    for (const k of ["nome", "ruolo", "telefono", "email", "impresa", "tipo_rapporto"]) if (dati[k] !== undefined && dati[k] !== null) pulito[k] = String(dati[k]).slice(0, 160);
    for (const k of ["scrive", "riceve_diario", "vede_area", "consenso_promemoria", "invito_inviato", "nuovo_codice"]) if (typeof dati[k] === "boolean") pulito[k] = dati[k];
    let r = null;
    if (az === "elenco" && UUID.test(c)) r = await h.rpc(env, "persone_cantiere_elenco", { p_token: tok, p_commessa: c }, 15000).catch(() => null);
    else if (az === "rubrica") r = await h.rpc(env, "persone_rubrica", { p_token: tok }, 15000).catch(() => null);
    else if (az === "aggiungi" && UUID.test(c)) r = await h.rpc(env, "persone_cantiere_aggiungi", { p_token: tok, p_commessa: c, p_dati: pulito }, 15000).catch(() => null);
    else if (az === "modifica" && Number.isInteger(id) && id > 0) r = await h.rpc(env, "persone_cantiere_modifica", { p_token: tok, p_id: id, p_dati: pulito }, 15000).catch(() => null);
    else if (az === "togli" && Number.isInteger(id) && id > 0) r = await h.rpc(env, "persone_cantiere_togli", { p_token: tok, p_id: id, p_motivo: String(b.motivo || "").slice(0, 300) }, 15000).catch(() => null);
    else return json({ esito: "errore" }, 400);
    return r ? json(r) : json({ esito: "incerto" });
  }
  if (sotto === "/rubrica") return rubricaRoute(request, env, base, inUrl, h);
  if (sotto !== "/persone") return new Response("Not Found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  if (!UUID.test(c)) return Response.redirect(inUrl.origin + base + "/?t=" + tok, 303);
  const d = await h.rpc(env, "persone_cantiere_elenco", { p_token: tok, p_commessa: c }, 15000).catch(() => null);
  if (!d) return h.risposta(h.foglio(base, "Persone del cantiere", "Servizio non disponibile", "<p>Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>"), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Persone del cantiere", "Cantiere non trovato", '<p>Questo cantiere non è tra quelli che puoi vedere.</p><p><a href="' + h.esc(base + "/?t=" + tok) + '">Torna ai cantieri</a></p>'), 404);
  return new Response(request.method === "HEAD" ? null : pagina(base, tok, c, d, h), { status: 200, headers: h.headers() });
}

function pagina(base, tok, c, d, h) {
  const cfg = JSON.stringify({ api: base + "/persone/api", t: tok, c: c, torna: base + "/?t=" + tok + "&c=" + c, numero: NUMERO_TIX, dati: d })
    .replace(/</g, "\\u003c").replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028").replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    '<title>Persone del cantiere - TIX · Diario di cantiere</title>' + h.testa(base) + "<style>" + STILE + "</style></head><body>" +
    '<header class="testa"><div class="in"><a class="torna" href="' + h.esc(base + "/?t=" + tok + "&c=" + c) + '">&larr; Torna al cantiere</a>' +
    '<h1>Persone del cantiere</h1><p id="sotto"></p><div class="riass" id="riass"></div></div></header>' +
    '<main class="corpo"><div class="in"><div class="barra"><h2>Chi lavora qui</h2><button class="btn pr" id="apri-aggiungi" type="button">+ Aggiungi persona</button></div>' +
    '<div id="gruppi"></div><p class="nota">Entra in TIX solo chi aggiungi qui. Ogni persona riceve un link personale: lo apre, invia il messaggio già scritto e il cantiere si attiva. Il link vale 14 giorni.</p></div></main>' +
    FORM + RUBRICA_HTML + INVITO_HTML + '<div class="toast" id="toast" hidden></div>' +
    "<script>" + QR_JS + "</script><script>(function(){var CFG=" + cfg + ";" + PAGINA_JS + "})();</script></body></html>";
}

// Rubrica (26/10/2026): le persone già inserite nei cantieri dell'impresa, una volta sola (GET /rubrica?t=).
async function rubricaRoute(request, env, base, inUrl, h) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const d = await h.rpc(env, "persone_rubrica", { p_token: tok }, 15000).catch(() => null);
  if (!d) return h.risposta(h.foglio(base, "Rubrica", "Servizio non disponibile", "<p>Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>"), 503);
  if (d.esito !== "ok") return Response.redirect(inUrl.origin + base + "/", 303);
  const cfg = JSON.stringify({ t: tok, base: base, dati: d }).replace(/</g, "\\u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028").replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
  const html = '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>Rubrica - TIX · Diario di cantiere</title>' +
    h.testa(base) + "<style>" + STILE + ".testa{background:linear-gradient(135deg,#C2540B,#F26A10)}.cerca{margin:4px 0 14px}</style></head><body>" +
    '<header class="testa"><div class="in"><a class="torna" href="' + h.esc(base + "/?t=" + tok) + '">&larr; Torna ai cantieri</a>' +
    '<h1>Rubrica</h1><p id="sotto"></p></div></header><main class="corpo"><div class="in">' +
    '<input class="campo cerca" id="cerca" type="search" placeholder="Cerca per nome, impresa, ruolo o numero" aria-label="Cerca nella rubrica">' +
    '<div class="lista" id="lista"></div><p class="nota">Qui trovi una volta sola tutte le persone che hai già inserito nei tuoi cantieri. Per aggiungerne una a un altro cantiere apri il cantiere, poi «Persone del cantiere» e «+ Aggiungi persona», e scegli «Scegli dalla rubrica».</p></div></main>' +
    "<script>(function(){var CFG=" + cfg + ";" + RUBRICA_JS + "})();</script></body></html>";
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: h.headers() });
}

const RUBRICA_JS = String.raw`
var D=CFG.dati,P=D.persone||[];
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
document.getElementById("sotto").textContent=(D.impresa||"")+" · "+P.length+(P.length===1?" persona":" persone");
function disegna(q){q=(q||"").toLowerCase().trim();var h="";
  P.filter(function(p){return !q||[p.nome,p.impresa,p.ruolo_etichetta,p.telefono,p.email,p.azienda].join(" ").toLowerCase().indexOf(q)>=0;}).forEach(function(p){
    h+='<article class="p"><div class="p-nome">'+esc(p.nome)+'</div><div class="p-sub">'+esc(p.impresa||"")+(D.filippo&&p.azienda?' · cliente '+esc(p.azienda):'')+'</div>'+
      '<div class="chips">'+(p.ruolo_etichetta?'<span class="chip">'+esc(p.ruolo_etichetta)+'</span>':'')+(p.telefono?'<span class="chip">+'+esc(p.telefono)+'</span>':'')+(p.email?'<span class="chip">'+esc(p.email)+'</span>':'')+'</div>'+
      (p.cantieri&&p.cantieri.length?'<div class="azioni">'+p.cantieri.map(function(c){return '<a class="btn sm" href="'+esc(CFG.base+"/persone?t="+CFG.t+"&c="+c.id)+'">'+esc(c.nome)+'</a>';}).join("")+'</div>':'<p class="p-sub" style="margin:8px 0 0">Non è attiva in nessun cantiere in corso.</p>')+'</article>';});
  document.getElementById("lista").innerHTML=h||'<p class="nota">Nessuna persona trovata.</p>';}
document.getElementById("cerca").addEventListener("input",function(e){disegna(e.target.value);});
disegna("");`;

// Pulsante «Persone del cantiere» nella pagina del cantiere (dopo le schede)
export function personeIniezione(base, token, commessa) {
  const url = JSON.stringify(base + "/persone?t=" + token + "&c=" + commessa);
  return "<style>.gl-pc-barra{max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right}" +
    ".gl-pc-b{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:0 16px;border:1px solid #1B2F4A;border-radius:10px;background:#EAF0F6;color:#1B2F4A;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none}" +
    ".gl-pc-b:hover,.gl-pc-b:focus-visible{background:#1B2F4A;color:#fff;outline:none}" +
    "@media (prefers-color-scheme:dark){.gl-pc-b{background:#203047;color:#dbe6f3;border-color:#5b7395}}</style>" +
    "<script>(function(){try{var a=document.createElement('a');a.className='gl-pc-b';a.href=" + url + ";a.innerHTML='&#128101; Persone del cantiere';" +
    "var b=document.createElement('div');b.className='gl-pc-barra';b.appendChild(a);var nav=document.querySelector('nav.schede');" +
    "if(nav&&nav.parentNode){nav.parentNode.insertBefore(b,nav.nextSibling);}else{document.body.insertBefore(b,document.body.firstChild);}}catch(e){}})();</script>";
}

const STILE = "[hidden]{display:none!important}:root{--navy:#1B2F4A;--navy-2:#24405f;--arancio:#F26A10;--verde:#0A7D48;--ambra:#B86E0B;--rosso:#B3261E;--bg:#F3F5F7;--carta:#fff;--testo:#17212E;--tenue:#5B6672;--bordo:#D9DFE6;--chip:#EAF0F6;--verde-f:#E3F3EA;--ambra-f:#FCF1DE}" +
  "@media (prefers-color-scheme:dark){:root{--bg:#0F1722;--carta:#172231;--testo:#E8EDF3;--tenue:#9AA8B8;--bordo:#2A3A4E;--chip:#203047;--verde-f:#123A28;--ambra-f:#3A2A10;--verde:#3FBF7F;--ambra:#E2A44A;--rosso:#F07A6E;color-scheme:dark}}" +
  "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--testo);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.45}" +
  ".testa{background:var(--navy);color:#fff;padding:16px max(16px,env(safe-area-inset-left)) 20px}.in{max-width:720px;margin:0 auto}" +
  ".torna{color:#C9D6E5;font-size:.9rem;text-decoration:none}.testa h1{font-size:1.7rem;margin:8px 0 2px}.testa p{margin:0;color:#C9D6E5;font-size:.95rem}" +
  ".riass{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.riass span{background:var(--navy-2);border-radius:10px;padding:6px 10px;font-size:.85rem}" +
  ".corpo{padding:16px max(16px,env(safe-area-inset-left)) 110px}.barra{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.barra h2{font-size:1.25rem;margin:0}" +
  ".btn{font:inherit;font-weight:700;border-radius:12px;border:1px solid var(--bordo);background:var(--carta);color:var(--testo);padding:10px 14px;cursor:pointer;min-height:44px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}" +
  ".btn.pr{background:var(--arancio);border-color:var(--arancio);color:#fff}.btn.wa{background:#1F8F4E;border-color:#1F8F4E;color:#fff}.btn.sm{min-height:36px;padding:6px 12px;font-size:.88rem}.btn.rosso{color:var(--rosso);border-color:var(--rosso)}" +
  ".btn:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--arancio);outline-offset:2px}" +
  ".gruppo{margin-top:18px}.gruppo h3{font-size:.78rem;text-transform:uppercase;letter-spacing:.07em;color:var(--tenue);margin:0 0 8px}.lista{display:grid;gap:10px}" +
  ".p{background:var(--carta);border:1px solid var(--bordo);border-radius:14px;padding:12px 14px}.p-top{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}.p-nome{font-weight:700;font-size:1.05rem}.p-sub{color:var(--tenue);font-size:.88rem}" +
  ".stato{flex:none;font-size:.78rem;font-weight:700;border-radius:999px;padding:3px 9px;white-space:nowrap}.s-ok{background:var(--verde-f);color:var(--verde)}.s-att{background:var(--ambra-f);color:var(--ambra)}" +
  ".chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 2px}.chip{background:var(--chip);border-radius:8px;padding:2px 8px;font-size:.8rem}" +
  ".tgs{display:grid;gap:6px;margin-top:10px;border-top:1px solid var(--bordo);padding-top:10px}.tg{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:.93rem;cursor:pointer;text-transform:none;letter-spacing:normal;color:inherit;font-weight:400;margin:0}" +
  ".tg input{position:absolute;opacity:0;width:1px;height:1px}.tg i{flex:none;width:44px;height:26px;border-radius:999px;background:var(--bordo);position:relative;transition:background .2s}" +
  ".tg i::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .2s}.tg input:checked+i{background:var(--verde)}.tg input:checked+i::after{transform:translateX(18px)}.tg input:focus-visible+i{outline:3px solid var(--arancio)}" +
  ".azioni{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.nota{border:1px dashed var(--bordo);border-radius:12px;padding:10px 12px;color:var(--tenue);font-size:.88rem;margin-top:18px}" +
  ".velo{position:fixed;inset:0;background:rgba(10,18,28,.55);z-index:20;display:flex;align-items:flex-end;justify-content:center}.foglio{background:var(--carta);color:var(--testo);width:100%;max-width:560px;max-height:92vh;overflow:auto;border-radius:18px 18px 0 0;padding:16px max(16px,env(safe-area-inset-left)) calc(18px + env(safe-area-inset-bottom))}" +
  ".foglio h2{font-size:1.3rem;margin:0 0 4px}.foglio .sotto{color:var(--tenue);font-size:.9rem;margin:0 0 12px}label.c{display:block;font-weight:600;font-size:.9rem;margin:12px 0 4px;text-transform:none;letter-spacing:normal;color:inherit}" +
  ".campo{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--bordo);border-radius:10px;background:var(--bg);color:var(--testo);min-height:44px}.riga2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.riga2>div{min-width:0}@media (max-width:460px){.riga2{grid-template-columns:1fr}}" +
  ".spunta{display:flex;gap:10px;align-items:flex-start;font-size:.9rem;margin-top:12px;text-transform:none;letter-spacing:normal;color:inherit;font-weight:400}.spunta input{margin-top:3px;width:18px;height:18px;flex:none}" +
  ".fine{display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}.errore{color:var(--rosso);font-weight:600;margin:10px 0 0}" +
  ".inv{display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:center;background:var(--bg);border-radius:14px;padding:12px}@media (max-width:460px){.inv{grid-template-columns:1fr;justify-items:center;text-align:center}}" +
  ".qr{background:#fff;padding:8px;border-radius:10px;width:160px;height:160px}.qr svg{width:100%;height:100%;display:block}.codice{font-size:1.9rem;font-weight:800;letter-spacing:.18em}.link{font-size:.82rem;word-break:break-all;color:var(--tenue)}" +
  ".toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(20px + env(safe-area-inset-bottom));background:var(--navy);color:#fff;border-radius:12px;padding:10px 16px;z-index:30;font-weight:600}" +
  "@media print{body *{visibility:hidden}#stampa,#stampa *{visibility:visible}#stampa{position:absolute;left:0;top:0;width:100%;text-align:center}#stampa .qr{width:9cm;height:9cm;margin:0 auto}}" +
  "@media (prefers-reduced-motion:reduce){*{transition:none!important}}";

const FORM = '<div class="velo" id="velo-agg" hidden><form class="foglio" id="form-agg" novalidate aria-labelledby="t-agg">' +
  '<h2 id="t-agg">Aggiungi persona</h2><p class="sotto">Le scelte si possono cambiare dopo, con un tocco.</p>' +
  '<button class="btn" type="button" id="apri-rubrica" style="width:100%">&#128211; Scegli dalla rubrica</button>' +
  '<label class="c" for="f-nome">Nome e cognome</label><input class="campo" id="f-nome" autocomplete="off" maxlength="120">' +
  '<label class="c" for="f-ruolo">Ruolo nel cantiere</label><select class="campo" id="f-ruolo"></select>' +
  '<div class="riga2"><div><label class="c" for="f-tel">Cellulare</label><input class="campo" id="f-tel" inputmode="tel" maxlength="20" placeholder="+39 333 123 4567"></div>' +
  '<div><label class="c" for="f-mail">Email</label><input class="campo" id="f-mail" type="email" maxlength="120" placeholder="facoltativa"></div></div>' +
  '<label class="c" for="f-imp">Impresa della persona</label><input class="campo" id="f-imp" maxlength="120">' +
  '<label class="c" for="f-rapp">Rapporto con l\'impresa</label><select class="campo" id="f-rapp">' +
  '<option value="dipendente">Titolare o dipendente (si conta nel canone)</option><option value="subappaltatore">Impresa subappaltatrice (senza costi)</option>' +
  '<option value="autonomo">Artigiano autonomo incaricato (senza costi, solo WhatsApp)</option><option value="fornitore">Fornitore (senza costi)</option>' +
  '<option value="esterno">Esterno: DL, CSE, RUP, committente (non scrive)</option></select>' +
  '<label class="spunta"><input type="checkbox" id="f-consenso"> <span>Ho il consenso della persona a ricevere da TIX un promemoria su WhatsApp, se non attiva entro 48 ore.</span></label>' +
  '<p class="errore" id="f-err" hidden></p><div class="fine"><button class="btn" type="button" data-chiudi>Annulla</button><button class="btn pr" type="submit" id="f-ok">Aggiungi e crea l\'invito</button></div></form></div>';

const RUBRICA_HTML = '<div class="velo" id="velo-rub" hidden><div class="foglio" role="dialog" aria-modal="true" aria-labelledby="t-rub">' +
  '<h2 id="t-rub">Scegli dalla rubrica</h2><p class="sotto">Le persone che hai già inserito negli altri cantieri. Tocca un nome per riempire il modulo.</p>' +
  '<input class="campo" id="rub-cerca" type="search" placeholder="Cerca per nome, impresa o numero" aria-label="Cerca nella rubrica">' +
  '<div class="lista" id="rub-lista" style="margin-top:10px"></div><div class="fine"><button class="btn" type="button" data-chiudi>Chiudi</button></div></div></div>';

const INVITO_HTML = '<div class="velo" id="velo-inv" hidden><div class="foglio" role="dialog" aria-modal="true" aria-labelledby="t-inv">' +
  '<h2 id="t-inv">Invito per <span id="i-nome"></span></h2><p class="sotto" id="i-scade"></p>' +
  '<div id="stampa"><div class="inv"><div class="qr" id="i-qr" role="img" aria-label="Codice QR dell\'invito"></div><div style="min-width:0"><div class="p-sub">Codice personale</div><div class="codice" id="i-cod"></div><div class="link" id="i-link"></div></div></div></div>' +
  '<div class="azioni"><a class="btn wa" id="i-cond" target="_blank" rel="noopener">Condividi su WhatsApp</a><button class="btn" type="button" id="i-copia">Copia il link</button>' +
  '<a class="btn" id="i-mail">Prepara l\'email</a><button class="btn" type="button" id="i-stampa">Stampa il QR</button><button class="btn" type="button" id="i-nuovo">Nuovo codice</button></div>' +
  '<p class="sotto" style="margin-top:12px">«Prepara l\'email» apre la tua posta con il testo pronto: l\'email parte dal tuo indirizzo, quando la invii tu.</p>' +
  '<div class="fine"><button class="btn pr" type="button" data-chiudi>Fatto</button></div></div></div>';

const PAGINA_JS = String.raw`
var D=CFG.dati, RUOLI=D.ruoli, persone=D.persone||[];
var GRUPPI=[["squadra","Squadra"],["imprese","Imprese e fornitori"],["direzione","Direzione lavori e sicurezza"],["committenza","Committenza"]];
function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function chiama(az,extra){var b={t:CFG.t,c:CFG.c,azione:az};for(var k in extra)b[k]=extra[k];
  return fetch(CFG.api,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json();});}
var toastT;function toast(t){var el=$("toast");el.textContent=t;el.hidden=false;clearTimeout(toastT);toastT=setTimeout(function(){el.hidden=true;},2800);}
function statoHtml(p){return p.stato==="attivato"?'<span class="stato s-ok">Attivo</span>':p.stato==="promemoria_inviato"?'<span class="stato s-att">Promemoria inviato</span>':p.codice_scaduto?'<span class="stato s-att">Invito scaduto</span>':'<span class="stato s-att">In attesa</span>';}
function quando(p){return p.stato==="attivato"?"attivo dal "+p.attivato_il:p.stato==="inviato"?"invito mandato":"invito creato il "+p.creato_il;}
function tg(p,campo,testo){return '<label class="tg"><span>'+testo+'</span><input type="checkbox" data-id="'+p.id+'" data-c="'+campo+'"'+(p[campo]?' checked':'')+'><i></i></label>';}
function disegna(){
  $("sotto").textContent=(D.impresa||"")+" · "+D.cantiere.nome+(D.cantiere.ubicazione?", "+D.cantiere.ubicazione:"");
  var att=persone.filter(function(p){return p.stato==="attivato";}).length;
  $("riass").innerHTML='<span><b>'+persone.length+'</b> persone</span><span><b>'+att+'</b> attive</span><span><b>'+persone.filter(function(p){return p.scrive;}).length+'</b> scrivono su WhatsApp</span><span><b>'+persone.filter(function(p){return p.riceve_diario;}).length+'</b> ricevono il diario</span>';
  var h="";
  if(!persone.length){h='<p class="nota">Ancora nessuna persona. Tocca «+ Aggiungi persona»: per ognuna crei un invito da mandare su WhatsApp, per email o con il QR.</p>';}
  GRUPPI.forEach(function(g){
    var dentro=persone.filter(function(p){return p.gruppo===g[0];}); if(!dentro.length)return;
    h+='<section class="gruppo"><h3>'+g[1]+'</h3><div class="lista">';
    dentro.forEach(function(p){
      var area=(p.ruolo==="sub")?"Vede l'area riservata (solo i propri dati)":"Vede l'area riservata (sola lettura)";
      h+='<article class="p"><div class="p-top"><div><div class="p-nome">'+esc(p.nome)+'</div><div class="p-sub">'+esc(p.impresa||"")+' · '+esc(quando(p))+'</div></div>'+statoHtml(p)+'</div>'+
        '<div class="chips"><span class="chip">'+esc(p.ruolo_etichetta)+'</span>'+(p.telefono?'<span class="chip">+'+esc(p.telefono)+'</span>':'')+(p.email?'<span class="chip">'+esc(p.email)+'</span>':'')+'</div>'+
        '<div class="tgs">'+tg(p,"scrive","Scrive su WhatsApp")+(p.tipo_rapporto==="autonomo"?'<p class="p-sub" style="margin:0">Artigiano autonomo incaricato: scrive solo su WhatsApp, senza costi per l\'impresa. Per avere l\'area riservata e il diario serve un abbonamento TIX suo.</p>':tg(p,"riceve_diario","Riceve il diario ogni sera")+tg(p,"vede_area",area))+'</div>'+
        '<div class="azioni">'+(p.stato!=="attivato"?'<button class="btn sm" type="button" data-inv="'+p.id+'">Invito</button>':'')+'<button class="btn sm rosso" type="button" data-togli="'+p.id+'">Togli dal cantiere</button></div></article>';
    });
    h+='</div></section>';
  });
  $("gruppi").innerHTML=h;
}
function trova(id){for(var i=0;i<persone.length;i++)if(String(persone[i].id)===String(id))return i;return -1;}
function sostituisci(p){var i=trova(p.id);if(i>=0)persone[i]=p;else persone.push(p);disegna();}
$("gruppi").addEventListener("change",function(e){
  var t=e.target;if(!t.dataset.c)return;var dati={};dati[t.dataset.c]=t.checked;t.disabled=true;
  chiama("modifica",{id:+t.dataset.id,dati:dati}).then(function(r){if(r.esito==="ok"){sostituisci(r.persona);toast("Salvato");}else{t.checked=!t.checked;t.disabled=false;toast("Non salvato: riprova");}})
  .catch(function(){t.checked=!t.checked;t.disabled=false;toast("Non salvato: controlla la connessione");});
});
$("gruppi").addEventListener("click",function(e){
  var b=e.target.closest("button");if(!b)return;
  if(b.dataset.inv){var i=trova(b.dataset.inv);if(i>=0)mostraInvito(persone[i]);}
  if(b.dataset.togli){
    if(!b.dataset.conferma){b.dataset.conferma="1";b.textContent="Tocca di nuovo per confermare";return;}
    b.disabled=true;chiama("togli",{id:+b.dataset.togli}).then(function(r){if(r.esito==="ok"){persone.splice(trova(b.dataset.togli),1);disegna();toast(r.nome+" non fa più parte del cantiere");}else{b.disabled=false;toast("Non riuscito: riprova");}});
  }
});
var sel=$("f-ruolo");
Object.keys(RUOLI).sort(function(a,b){return (RUOLI[a].ordine||99)-(RUOLI[b].ordine||99);}).forEach(function(k){var o=document.createElement("option");o.value=k;o.textContent=RUOLI[k].etichetta;sel.appendChild(o);});
sel.addEventListener("change",function(){$("f-rapp").value=RUOLI[sel.value].rapporto;});
var RUB=null;
function disegnaRub(q){q=(q||"").toLowerCase().trim();var gia={};persone.forEach(function(p){if(p.telefono)gia[p.telefono]=1;});var h="";
  (RUB||[]).filter(function(p){return !q||[p.nome,p.impresa,p.ruolo_etichetta,p.telefono,p.email].join(" ").toLowerCase().indexOf(q)>=0;}).forEach(function(p,i){
    var dentro=p.telefono&&gia[p.telefono];
    h+='<button type="button" class="p" style="text-align:left;font:inherit;color:inherit;cursor:'+(dentro?'default':'pointer')+';opacity:'+(dentro?'.55':'1')+'" data-r="'+RUB.indexOf(p)+'"'+(dentro?' disabled':'')+'>'+
      '<div class="p-nome">'+esc(p.nome)+'</div><div class="p-sub">'+esc([p.ruolo_etichetta,p.impresa,p.telefono?'+'+p.telefono:'',p.email].filter(Boolean).join(' · '))+(dentro?' · già in questo cantiere':'')+'</div></button>';});
  $("rub-lista").innerHTML=h||'<p class="nota">'+(RUB&&RUB.length?'Nessuna persona trovata.':'La rubrica è vuota: si riempie con le persone che aggiungi ai cantieri.')+'</p>';}
$("apri-rubrica").addEventListener("click",function(){$("velo-rub").hidden=false;$("rub-cerca").value="";
  if(RUB){disegnaRub("");return;}$("rub-lista").innerHTML='<p class="nota">Carico la rubrica…</p>';
  chiama("rubrica",{}).then(function(r){RUB=(r&&r.esito==="ok")?r.persone:[];disegnaRub("");}).catch(function(){$("rub-lista").innerHTML='<p class="nota">Connessione assente: riprova.</p>';});});
$("rub-cerca").addEventListener("input",function(e){disegnaRub(e.target.value);});
$("rub-lista").addEventListener("click",function(e){var b=e.target.closest("button[data-r]");if(!b||b.disabled)return;var p=RUB[+b.dataset.r];
  $("f-nome").value=p.nome||"";$("f-tel").value=p.telefono?"+"+p.telefono:"";$("f-mail").value=p.email||"";$("f-imp").value=p.impresa||D.impresa||"";
  if(p.ruolo&&RUOLI[p.ruolo]){sel.value=p.ruolo;$("f-rapp").value=RUOLI[p.ruolo].rapporto;}
  if(p.tipo_rapporto){$("f-rapp").value=p.tipo_rapporto;}
  $("velo-rub").hidden=true;toast("Dati presi dalla rubrica: controlla il ruolo e aggiungi");});
$("apri-aggiungi").addEventListener("click",function(){$("f-imp").value=D.impresa||"";$("f-err").hidden=true;$("velo-agg").hidden=false;$("f-nome").focus();});
document.querySelectorAll("[data-chiudi]").forEach(function(b){b.addEventListener("click",function(){b.closest(".velo").hidden=true;});});
document.querySelectorAll(".velo").forEach(function(v){v.addEventListener("click",function(e){if(e.target===v)v.hidden=true;});});
$("form-agg").addEventListener("submit",function(e){
  e.preventDefault();var ok=$("f-ok");ok.disabled=true;$("f-err").hidden=true;
  chiama("aggiungi",{dati:{nome:$("f-nome").value,ruolo:sel.value,telefono:$("f-tel").value,email:$("f-mail").value,impresa:$("f-imp").value,tipo_rapporto:$("f-rapp").value,consenso_promemoria:$("f-consenso").checked}})
  .then(function(r){ok.disabled=false;
    if(r.esito==="ok"){$("form-agg").reset();$("velo-agg").hidden=true;sostituisci(r.persona);mostraInvito(r.persona);}
    else{$("f-err").textContent=r.messaggio||"Non riuscito: riprova.";$("f-err").hidden=false;var f=r.campo&&$({nome:"f-nome",ruolo:"f-ruolo",telefono:"f-tel",email:"f-mail"}[r.campo]);if(f)f.focus();}})
  .catch(function(){ok.disabled=false;$("f-err").textContent="Connessione assente: riprova.";$("f-err").hidden=false;});
});
var corrente=null;
function segnaInviato(){if(corrente&&corrente.stato==="creato"){chiama("modifica",{id:corrente.id,dati:{invito_inviato:true}}).then(function(r){if(r.esito==="ok"){corrente=r.persona;sostituisci(r.persona);}});}}
function mostraInvito(p){
  corrente=p;var inv=p.invito;if(!inv){toast("Questa persona è già attiva");return;}
  $("i-nome").textContent=p.nome;$("i-cod").textContent=inv.codice;$("i-link").textContent=inv.link;
  $("i-scade").textContent=p.codice_scaduto?"Il codice è scaduto: tocca «Nuovo codice» e manda il nuovo invito.":"Vale fino al "+inv.scade_il+", solo per questo cantiere. Mandalo in uno di questi modi.";
  $("i-qr").innerHTML=QR.svg(inv.link);
  var nome=String(p.nome).split(" ")[0];
  var testo="Ciao "+nome+", "+(D.impresa||"")+" ti ha aggiunto al cantiere "+D.cantiere.nome+" su TIX, il diario di cantiere su WhatsApp. Tocca il link e invia il messaggio già scritto: "+inv.link;
  $("i-cond").href="https://wa.me/"+(p.telefono||"")+"?text="+encodeURIComponent(testo);
  var corpo="Buongiorno "+p.nome+",\n\n"+(D.impresa||"")+" usa TIX · Diario di cantiere per il cantiere "+D.cantiere.nome+"."+(p.riceve_diario?" Ogni sera riceverà per email il diario di cantiere della giornata.":"")+
    "\n\nPer attivare l'accesso apra questo collegamento dal telefono e invii il messaggio già scritto:\n"+inv.link+
    "\n\nI suoi dati li ha inseriti "+(D.impresa||"l'impresa")+", che ne è titolare; TIX li usa per suo conto. Informativa: www.tixcantiere.it/privacy-policy\nIl diario di cantiere non sostituisce il giornale dei lavori della Direzione Lavori.";
  $("i-mail").href="mailto:"+encodeURIComponent(p.email||"")+"?subject="+encodeURIComponent((D.impresa||"")+" ti ha aggiunto al cantiere "+D.cantiere.nome+" su TIX")+"&body="+encodeURIComponent(corpo);
  $("velo-inv").hidden=false;
}
$("i-cond").addEventListener("click",segnaInviato);$("i-mail").addEventListener("click",segnaInviato);
$("i-copia").addEventListener("click",function(){var l=$("i-link").textContent;
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(l).then(function(){toast("Link copiato");segnaInviato();},function(){toast("Tieni premuto il link per copiarlo");});}else toast("Tieni premuto il link per copiarlo");});
$("i-stampa").addEventListener("click",function(){segnaInviato();window.print();});
$("i-nuovo").addEventListener("click",function(){if(!corrente)return;chiama("modifica",{id:corrente.id,dati:{nuovo_codice:true}}).then(function(r){if(r.esito==="ok"){sostituisci(r.persona);mostraInvito(r.persona);toast("Nuovo codice creato: il vecchio non vale più");}});});
disegna();`;

// Generatore di codici QR (byte, correzione M, versioni 1–9), senza servizi esterni.
// Segue l'algoritmo dello standard ISO/IEC 18004 come nella libreria di riferimento di Project Nayuki (MIT).
const QR_JS = String.raw`var QR=(function(){
var ECC=[-1,10,16,26,18,24,16,18,22,22],BLK=[-1,1,1,1,2,2,4,4,4,5];
function raw(v){var r=(16*v+128)*v+64;if(v>=2){var n=Math.floor(v/7)+2;r-=(25*n-10)*n-55;if(v>=7)r-=36;}return r;}
function dataCw(v){return Math.floor(raw(v)/8)-ECC[v]*BLK[v];}
function mul(x,y){var z=0;for(var i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11D);z^=((y>>>i)&1)*x;}return z&255;}
function divisor(d){var r=[];for(var i=0;i<d;i++)r.push(0);r[d-1]=1;var root=1;for(i=0;i<d;i++){for(var j=0;j<r.length;j++){r[j]=mul(r[j],root);if(j+1<r.length)r[j]^=r[j+1];}root=mul(root,2);}return r;}
function rem(data,dv){var r=dv.map(function(){return 0;});data.forEach(function(b){var f=b^r.shift();r.push(0);dv.forEach(function(c,i){r[i]^=mul(c,f);});});return r;}
function bytes(s){return Array.prototype.slice.call(new TextEncoder().encode(s));}
function make(text){
  var d=bytes(text),v=1;while(v<=9&&4+8+8*d.length>dataCw(v)*8)v++;if(v>9)throw new Error("testo troppo lungo");
  var bits=[];function put(val,n){for(var i=n-1;i>=0;i--)bits.push((val>>>i)&1);}
  put(4,4);put(d.length,8);d.forEach(function(b){put(b,8);});
  var cap=dataCw(v)*8;put(0,Math.min(4,cap-bits.length));put(0,(8-bits.length%8)%8);
  var cw=[];for(var i=0;i<bits.length;i+=8){var b=0;for(var j=0;j<8;j++)b=(b<<1)|bits[i+j];cw.push(b);}
  for(var p=0xEC;cw.length<dataCw(v);p^=0xEC^0x11)cw.push(p);
  var nb=BLK[v],el=ECC[v],rc=Math.floor(raw(v)/8),ns=nb-rc%nb,sl=Math.floor(rc/nb),dv=divisor(el),blocks=[],k;
  for(i=0,k=0;i<nb;i++){var dat=cw.slice(k,k+sl-el+(i<ns?0:1));k+=dat.length;var e=rem(dat,dv);if(i<ns)dat.push(0);blocks.push(dat.concat(e));}
  var all=[];for(i=0;i<blocks[0].length;i++)blocks.forEach(function(bl,j){if(i!=sl-el||j>=ns)all.push(bl[i]);});
  var n=v*4+17,m=[],f=[];for(i=0;i<n;i++){m.push(new Array(n).fill(false));f.push(new Array(n).fill(false));}
  function set(x,y,dk){m[y][x]=dk;f[y][x]=true;}
  for(i=0;i<n;i++){set(6,i,i%2==0);set(i,6,i%2==0);}
  function finder(x,y){for(var dy=-4;dy<=4;dy++)for(var dx=-4;dx<=4;dx++){var dist=Math.max(Math.abs(dx),Math.abs(dy)),xx=x+dx,yy=y+dy;if(xx>=0&&xx<n&&yy>=0&&yy<n)set(xx,yy,dist!=2&&dist!=4);}}
  finder(3,3);finder(n-4,3);finder(3,n-4);
  var al=[];if(v>1){var na=Math.floor(v/7)+2,st=Math.ceil((v*4+4)/(na*2-2))*2;al=[6];for(var pos=n-7;al.length<na;pos-=st)al.splice(1,0,pos);}
  for(i=0;i<al.length;i++)for(j=0;j<al.length;j++){if((i==0&&j==0)||(i==0&&j==al.length-1)||(i==al.length-1&&j==0))continue;for(var dy=-2;dy<=2;dy++)for(var dx=-2;dx<=2;dx++)set(al[i]+dx,al[j]+dy,Math.max(Math.abs(dx),Math.abs(dy))!=1);}
  function fmt(mask){var dt=(0<<3)|mask,r=dt;for(var q=0;q<10;q++)r=(r<<1)^((r>>>9)*0x537);var b=((dt<<10)|r)^0x5412;function g(q){return((b>>>q)&1)!=0;}
    for(q=0;q<=5;q++)set(8,q,g(q));set(8,7,g(6));set(8,8,g(7));set(7,8,g(8));for(q=9;q<15;q++)set(14-q,8,g(q));
    for(q=0;q<8;q++)set(n-1-q,8,g(q));for(q=8;q<15;q++)set(8,n-15+q,g(q));set(8,n-8,true);}
  fmt(0);
  if(v>=7){var r7=v;for(i=0;i<12;i++)r7=(r7<<1)^((r7>>>11)*0x1F25);var vb=(v<<12)|r7;for(i=0;i<18;i++){var c=((vb>>>i)&1)!=0,a=n-11+i%3,bb=Math.floor(i/3);set(a,bb,c);set(bb,a,c);}}
  var idx=0;for(var right=n-1;right>=1;right-=2){if(right==6)right=5;for(var vert=0;vert<n;vert++)for(j=0;j<2;j++){var x=right-j,up=((right+1)&2)==0,y=up?n-1-vert:vert;
    if(!f[y][x]&&idx<all.length*8){m[y][x]=((all[idx>>>3]>>>(7-(idx&7)))&1)!=0;idx++;}}}
  function inv(mask,x,y){switch(mask){case 0:return(x+y)%2==0;case 1:return y%2==0;case 2:return x%3==0;case 3:return(x+y)%3==0;case 4:return(Math.floor(x/3)+Math.floor(y/2))%2==0;case 5:return x*y%2+x*y%3==0;case 6:return(x*y%2+x*y%3)%2==0;default:return((x+y)%2+x*y%3)%2==0;}}
  function applica(mask){for(var y=0;y<n;y++)for(var x=0;x<n;x++)if(!f[y][x]&&inv(mask,x,y))m[y][x]=!m[y][x];}
  function penalita(){var p=0,x,y,run,k;for(y=0;y<n;y++){run=1;for(x=1;x<n;x++){if(m[y][x]==m[y][x-1]){run++;if(run==5)p+=3;else if(run>5)p++;}else run=1;}}
    for(x=0;x<n;x++){run=1;for(y=1;y<n;y++){if(m[y][x]==m[y-1][x]){run++;if(run==5)p+=3;else if(run>5)p++;}else run=1;}}
    for(y=0;y<n-1;y++)for(x=0;x<n-1;x++){k=m[y][x];if(k==m[y][x+1]&&k==m[y+1][x]&&k==m[y+1][x+1])p+=3;}
    var dk=0;for(y=0;y<n;y++)for(x=0;x<n;x++)if(m[y][x])dk++;p+=Math.floor(Math.abs(dk*20-n*n*10)/(n*n))*10;return p;}
  var best=0,bp=1e9;for(var mk=0;mk<8;mk++){applica(mk);fmt(mk);var pp=penalita();if(pp<bp){bp=pp;best=mk;}applica(mk);}
  applica(best);fmt(best);return m;}
function svg(text){var m=make(text),n=m.length,q=4,s=n+q*2,p="";for(var y=0;y<n;y++)for(var x=0;x<n;x++)if(m[y][x])p+="M"+(x+q)+","+(y+q)+"h1v1h-1z";
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+s+' '+s+'" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="'+p+'" fill="#1B2F4A"/></svg>';}
return {make:make,svg:svg};})();`;
