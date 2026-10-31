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
// Comando «AREA» (26/10/2026): chi può riceverlo (numeri dell'impresa autorizzati ai cantieri, referente,
// «Titolare impresa» attivo) riceve su WhatsApp il link della pagina dell'impresa. Decide il database
// (area_link_whatsapp, al massimo 3 richieste al giorno). Interruttore spento o database fermo → il messaggio
// prosegue verso Make come prima.
const AREA = /^\s*area\s*[.!]?\s*$/i;

export function areaComando(msg) {
  return !!(msg && msg.type === "text" && msg.text && AREA.test(String(msg.text.body || "")));
}

export async function areaGestisci(msg, value, env, h) {
  const tel = String(msg.from || "");
  const phoneId = (value.metadata && value.metadata.phone_number_id) || "";
  if (!areaComando(msg) || !tel || !phoneId || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN || env.PERSONE_CANTIERE === "off") return false;
  const r = await h.rpc(env, "area_link_whatsapp", { p_telefono: tel }, 8000);
  if (!r || !r.esito || r.esito === "spento" || r.esito === "errore") return false;
  let testo;
  if (r.esito === "ok" && Array.isArray(r.imprese) && r.imprese.length) {
    const piu = r.imprese.length > 1;
    testo = "Ecco il collegamento alla tua area riservata TIX" + (piu ? ":" : " (" + r.imprese[0].nome + "):") + "\n" +
      r.imprese.map((i) => (piu ? "*" + i.nome + "*: " : "") + i.link).join("\n") +
      "\n\nÈ personale: chi lo apre vede tutti i cantieri dell'impresa, giralo solo a chi in azienda deve consultarli." +
      "\nAprilo dal telefono e mettilo sulla schermata Home come un'app: su Android menu di Chrome → «Installa app», su iPhone Safari → Condividi → «Aggiungi alla schermata Home».";
  } else if (r.esito === "troppi") {
    testo = "Ti ho già mandato il collegamento più volte nelle ultime 24 ore. Riprova domani oppure scrivi a info@tixcantiere.it.";
  } else {
    testo = "Il collegamento all'area riservata lo ricevono solo i responsabili dell'impresa. Chiedilo al tuo referente oppure scrivi a info@tixcantiere.it.";
  }
  try {
    await h.invia(phoneId, env.WHATSAPP_TOKEN, {
      messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "text",
      context: { message_id: msg.id }, text: { body: testo.slice(0, 1500), preview_url: false }
    });
  } catch (e) {}
  try { await h.log(env, tel, msg.id, "area_link", r.esito); } catch (e) {}
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
    else if (az === "rubrica_salva") {
      const rub = {};
      for (const k of ["nome", "telefono", "email", "impresa", "partita_iva", "codice_fiscale", "ruolo", "tipo_rapporto"]) if (dati[k] !== undefined && dati[k] !== null) rub[k] = String(dati[k]).slice(0, 160);
      if (dati.note !== undefined && dati.note !== null) rub.note = String(dati.note).slice(0, 500);
      if (UUID.test(String(dati.azienda_id || "").toLowerCase())) rub.azienda_id = String(dati.azienda_id).toLowerCase();
      if (/^[0-9]{1,18}$/.test(String(dati.impresa_id || ""))) rub.impresa_id = String(dati.impresa_id);
      for (const k of ["nuova_impresa", "nuova_impresa_piva"]) if (dati[k] !== undefined && dati[k] !== null) rub[k] = String(dati[k]).slice(0, 160);
      if (Number.isInteger(id) && id > 0) rub.id = String(id);
      r = await h.rpc(env, "rubrica_salva", { p_token: tok, p_dati: rub }, 15000).catch(() => null);
    }
    else if (az === "rubrica_elimina" && Number.isInteger(id) && id > 0) r = await h.rpc(env, "rubrica_elimina", { p_token: tok, p_id: id }, 15000).catch(() => null);
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
    '<title>Persone del cantiere - TIX · Diario di cantiere</title>' + h.testa(base) + "<style>" + STILE + TEL_CSS + "</style></head><body>" +
    '<header class="testa"><div class="in"><a class="torna" href="' + h.esc(base + "/?t=" + tok + "&c=" + c) + '">&larr; Torna al cantiere</a>' +
    '<h1>Persone del cantiere</h1><p id="sotto"></p><div class="riass" id="riass"></div></div></header>' +
    '<main class="corpo"><div class="in"><div class="barra"><h2>Chi lavora qui</h2><button class="btn pr" id="apri-scelta" type="button">&#128211; Scegli contatto da rubrica oppure nuovo contatto</button></div>' +
    '<div id="gruppi"></div><p class="nota">Entra in TIX solo chi aggiungi qui. Ogni persona riceve un link personale: lo apre, invia il messaggio già scritto e il cantiere si attiva. Il link vale 14 giorni.</p></div></main>' +
    SCELTA_HTML + FORM + RUBRICA_HTML + INVITO_HTML + '<div class="toast" id="toast" hidden></div>' +
    "<script>" + QR_JS + "</script><script>(function(){var CFG=" + cfg + ";" + TEL_JS + PAGINA_JS + "})();</script></body></html>";
}

// Rubrica (26/10/2026, persone-cantiere-4): i contatti dell'impresa con i dati anagrafici (GET /rubrica?t=).
// Si aggiungono qui con «+ Nuovo contatto»; chi viene aggiunto a un cantiere entra in rubrica da solo (trigger nel database).
async function rubricaRoute(request, env, base, inUrl, h) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const d = await h.rpc(env, "persone_rubrica", { p_token: tok }, 15000).catch(() => null);
  if (!d) return h.risposta(h.foglio(base, "Rubrica", "Servizio non disponibile", "<p>Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>"), 503);
  if (d.esito !== "ok") return Response.redirect(inUrl.origin + base + "/", 303);
  const cfg = JSON.stringify({ t: tok, base: base, api: base + "/persone/api", dati: d }).replace(/</g, "\\u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028").replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
  const html = '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>Rubrica - TIX · Diario di cantiere</title>' +
    h.testa(base) + "<style>" + STILE + TEL_CSS + ".testa{background:linear-gradient(135deg,#C2540B,#F26A10)}.cerca{margin:4px 0 14px}" + IMPORTA_CSS + "</style></head><body>" +
    '<header class="testa"><div class="in"><a class="torna" href="' + h.esc(base + "/?t=" + tok) + '">&larr; Torna ai cantieri</a>' +
    '<h1>Rubrica</h1><p id="sotto"></p></div></header><main class="corpo"><div class="in">' +
    '<div class="barra"><h2>Contatti</h2><div class="az-rub"><button class="btn" id="importa" type="button">&#128229; Importa da file</button><button class="btn pr" id="nuovo" type="button">+ Nuovo contatto</button></div></div>' +
    '<input class="campo cerca" id="cerca" type="search" placeholder="Cerca per nome, impresa, ruolo o numero" aria-label="Cerca nella rubrica" style="margin-top:12px">' +
    '<div class="lista" id="lista"></div><p class="nota">Qui tieni operai, subappaltatori, fornitori, tecnici e committenti con i loro dati. Per mettere un contatto in un cantiere apri il cantiere, poi «Persone del cantiere» e «Scegli contatto da rubrica oppure nuovo contatto». Chi aggiungi a un cantiere entra in rubrica da solo. Eliminare un contatto dalla rubrica non lo toglie dai cantieri.</p></div></main>' +
    SCHEDA_HTML + IMPORTA_HTML + '<div class="toast" id="toast" hidden></div>' +
    "<script>(function(){var CFG=" + cfg + ";" + TEL_JS + RUBRICA_JS + IMPORTA_JS + "})();</script></body></html>";
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: h.headers() });
}

const RAPPORTI_OPZ = '<option value="titolare">Titolare</option><option value="dipendente">Dipendente</option><option value="subappaltatore">Impresa subappaltatrice</option>' +
  '<option value="autonomo">Artigiano autonomo</option><option value="fornitore">Fornitore</option><option value="professionista">Professionista con partita IVA: PM, DL, CSE, consulente</option><option value="esterno">Esterno: DL, CSE, RUP, committente</option>';

const SCHEDA_HTML = '<div class="velo" id="velo-sch" hidden><form class="foglio" id="form-sch" novalidate aria-labelledby="t-sch">' +
  '<h2 id="t-sch">Nuovo contatto</h2><p class="sotto">Serve solo il nome; gli altri dati sono facoltativi.</p>' +
  '<div id="s-az-box" hidden><label class="c" for="s-az">Impresa</label><select class="campo" id="s-az"></select>' +
  '<p class="sotto" style="margin:4px 0 0;font-size:.82rem">Per un professionista con partita IVA scegli «+ Nuova impresa» e scrivi il suo studio o la sua ditta.</p>' +
  '<div id="s-nuova-box" hidden><div class="riga2"><div><label class="c" for="s-nuova">Ragione sociale della nuova impresa</label><input class="campo" id="s-nuova" maxlength="120"></div>' +
  '<div><label class="c" for="s-nuova-piva">Partita IVA dell\'impresa</label><input class="campo" id="s-nuova-piva" inputmode="numeric" maxlength="13" placeholder="facoltativa"></div></div>' +
  '<p class="sotto" style="margin:4px 0 0;font-size:.82rem">L\'impresa resta solo in rubrica: non diventa un cliente TIX.</p></div></div>' +
  '<label class="c" for="s-nome">Nome e cognome</label><input class="campo" id="s-nome" autocomplete="off" maxlength="120">' +
  '<div class="riga2"><div><label class="c" for="s-tel">Telefono</label><input class="campo" id="s-tel" type="tel" inputmode="tel" maxlength="20" placeholder="333 123 4567"></div>' +
  '<div><label class="c" for="s-mail">Email</label><input class="campo" id="s-mail" type="email" maxlength="120"></div></div>' +
  '<label class="c" for="s-imp">Impresa o ditta della persona</label><input class="campo" id="s-imp" maxlength="120" list="s-imp-lista"><datalist id="s-imp-lista"></datalist>' +
  '<p class="sotto" style="margin:4px 0 0;font-size:.82rem">Professionista con partita IVA (PM, DL, CSE, consulente)? Scrivi il suo studio o la sua ditta e scegli il rapporto «Professionista».</p>' +
  '<div class="riga2"><div><label class="c" for="s-piva">Partita IVA</label><input class="campo" id="s-piva" inputmode="numeric" maxlength="13"></div>' +
  '<div><label class="c" for="s-cf">Codice fiscale</label><input class="campo" id="s-cf" maxlength="16" style="text-transform:uppercase"></div></div>' +
  '<div class="riga2"><div><label class="c" for="s-ruolo">Ruolo abituale</label><select class="campo" id="s-ruolo"><option value="">—</option></select></div>' +
  '<div><label class="c" for="s-rapp">Rapporto con l\'impresa</label><select class="campo" id="s-rapp"><option value="">—</option>' + RAPPORTI_OPZ + '</select></div></div>' +
  '<label class="c" for="s-note">Note</label><textarea class="campo" id="s-note" rows="3" maxlength="500" placeholder="Per esempio: gruista, disponibile da marzo"></textarea>' +
  '<p class="sotto" style="margin:4px 0 0;font-size:.82rem">Non scrivere qui dati sulla salute, sui sindacati o su condanne.</p>' +
  '<p class="errore" id="s-err" hidden></p><div class="fine"><button class="btn rosso" type="button" id="s-elim" hidden>Elimina dalla rubrica</button>' +
  '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn pr" type="submit" id="s-ok">Salva</button></div></form></div>';

// 30/10/2026 (Filippo, rubrica-importa-1): «Importa da file» nella Rubrica. Il file (Excel, CSV, vCard del telefono, PDF)
// si legge nel browser, senza mandarlo a TIX; si mostra l'elenco con i contatti già in rubrica (o doppi nel file) tolti e
// segnalati; «Aggiungi» salva gli altri uno per uno con rubrica_salva, che rifiuta comunque i numeri già presenti.
const IMPORTA_CSS = ".az-rub{display:flex;gap:8px;flex-wrap:wrap}.carica-imp{display:flex;align-items:center;justify-content:center;gap:8px;min-height:64px;margin:12px 0 4px;" +
  "border:2px dashed var(--bordo);border-radius:12px;cursor:pointer;font-weight:700}.carica-imp:hover{border-color:#F26A10}.carica-imp input{position:absolute;opacity:0;width:1px;height:1px}" +
  "#velo-imp .foglio{overflow-x:hidden}.imp-r>span{flex:1;min-width:0}.imp-l{max-height:46vh;overflow-y:auto;overflow-x:hidden;border:1px solid var(--bordo);border-radius:10px;margin-top:8px}.imp-r{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-bottom:1px solid var(--bordo)}" +
  ".imp-r:last-child{border-bottom:0}.imp-r input{margin-top:4px;flex:0 0 auto}.imp-r b{display:block}.imp-r small{display:block;opacity:.75;overflow-wrap:anywhere}.imp-r.no{opacity:.6}" +
  ".imp-r .perche{color:#B4500A;font-weight:600;opacity:1}.imp-ries{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 0}.imp-ries span{padding:3px 9px;border-radius:999px;font-size:.8rem;font-weight:700;background:rgba(242,106,16,.12)}";

const IMPORTA_HTML = '<div class="velo" id="velo-imp" hidden><div class="foglio" role="dialog" aria-modal="true" aria-labelledby="t-imp">' +
  '<h2 id="t-imp">Importa contatti da file</h2>' +
  '<p class="sotto">Carica l\'elenco dei tuoi contatti: Excel (.xlsx, .xls), CSV, rubrica del telefono (.vcf) oppure PDF. TIX legge nomi, telefoni, email e imprese e prepara l\'elenco da controllare. ' +
  'I contatti già in rubrica vengono tolti da soli. Il file resta sul tuo dispositivo: a TIX arrivano solo i contatti che aggiungi.</p>' +
  '<div id="i-az-box" hidden><label class="c" for="i-az">Impresa a cui appartengono i contatti</label><select class="campo" id="i-az"></select></div>' +
  '<label class="carica-imp" for="i-file"><input type="file" id="i-file" accept=".xlsx,.xls,.ods,.csv,.txt,.vcf,.pdf">&#128196;&nbsp;<span id="i-file-t">Scegli il file</span></label>' +
  '<p class="sotto" id="i-stato" aria-live="polite"></p><div id="i-anteprima"></div><p class="errore" id="i-err" hidden></p>' +
  '<div class="fine"><button class="btn" type="button" data-chiudi>Chiudi</button><button class="btn pr" type="button" id="i-ok" hidden>Aggiungi</button></div></div></div>';

const IMPORTA_JS = String.raw`
var IMP=[],IMP_FILE="";
var LIB={xlsx:"https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",pdf:"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",pdfw:"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"};
function libreria(u){return new Promise(function(ok,ko){if(document.querySelector('script[data-lib="'+u+'"]'))return ok();var s=document.createElement("script");s.src=u;s.setAttribute("data-lib",u);
  s.onload=function(){ok();};s.onerror=function(){ko(new Error("non riesco a caricare il lettore del file: controlla la connessione"));};document.head.appendChild(s);});}
function iStato(t){$("i-stato").textContent=t;}
function iErr(t){var e=$("i-err");e.textContent=t||"";e.hidden=!t;}
function pul(s){return String(s==null?"":s).replace(/\s+/g," ").trim();}
function normNome(s){return pul(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9 ]/g,"").split(" ").filter(Boolean).sort().join(" ");}
function normTel(t){var s=pul(t);if(!s)return "";var piu=/^(\+|00)/.test(s),d=s.replace(/[^0-9]/g,"");if(s.indexOf("00")===0)d=d.slice(2);
  if(!piu&&(/^3\d{8,9}$/.test(d)||/^0\d{5,10}$/.test(d)))d="39"+d;return d.length>=10&&d.length<=15?d:"";}
var RE_MAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,RE_TEL=/(\+|00)?\d[\d\s.\/()-]{7,}\d/,RE_CF=/\b[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z]\d{3}[A-Za-z]\b/,RE_PIVA=/p(?:artita)?\.?\s*iva[:\s.]*([0-9]{11})/i;
var ALIAS={cognome:["cognome"],nome:["nome e cognome","cognome e nome","nominativo","nome","contatto","referente","denominazione","ragione sociale"],
  telefono:["cellulare","cell","telefono","tel","mobile","numero","whatsapp","recapito"],email:["email","e-mail","mail","posta elettronica","pec"],
  impresa:["impresa","ditta","azienda","societa","organizzazione","company","studio"],partita_iva:["partita iva","p.iva","piva","p. iva","vat"],
  codice_fiscale:["codice fiscale","cod. fiscale","cod fiscale","c.f.","cf"],ruolo:["ruolo","mansione","qualifica","funzione","professione"]};
function campoDi(t){t=pul(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[:*]/g,"");if(!t||t.length>40)return "";
  for(var k in ALIAS)for(var i=0;i<ALIAS[k].length;i++){var a=ALIAS[k][i];if(t===a||(a.length>3&&t.indexOf(a)===0))return k;}return "";}
// righe (array di celle) → contatti, con o senza riga d'intestazione
function daTabella(righe){righe=righe.map(function(r){return (r||[]).map(pul);}).filter(function(r){return r.some(Boolean);});
  var mappa=null,inizio=0;
  for(var i=0;i<Math.min(righe.length,6)&&!mappa;i++){var m={},n=0;righe[i].forEach(function(c,j){var k=campoDi(c);if(k&&!(k in m)){m[k]=j;n++;}});if(n>=2||(n===1&&("nome" in m))){mappa=m;inizio=i+1;}}
  var out=[];
  righe.slice(inizio).forEach(function(r){var c={};
    if(mappa){for(var k in mappa)c[k]=r[mappa[k]]||"";if(c.cognome){c.nome=pul((c.nome||"")+" "+c.cognome);}delete c.cognome;
      if(c.telefono&&!normTel(c.telefono)&&RE_MAIL.test(c.telefono)){if(!c.email)c.email=c.telefono.match(RE_MAIL)[0];c.telefono="";}
      if(!c.email)r.forEach(function(x){var m=x.match(RE_MAIL);if(!c.email&&m)c.email=m[0];});
      if(!c.telefono){r.forEach(function(x,j){if(!c.telefono&&normTel(x)&&!(c.partita_iva&&x===c.partita_iva))c.telefono=x;});}}
    else c=daTesto(r.join(" | "));
    out.push(c);});
  return out;}
// una riga di testo libero (PDF, elenchi senza colonne) → contatto
function daTesto(t){var c={},s=" "+t+" ",m;
  if((m=s.match(RE_MAIL))){c.email=m[0];s=s.replace(m[0]," ");}
  if((m=s.match(RE_PIVA))){c.partita_iva=m[1];s=s.replace(m[0]," ");}
  if((m=s.match(RE_CF))){c.codice_fiscale=m[0];s=s.replace(m[0]," ");}
  if((m=s.match(RE_TEL))&&normTel(m[0])){c.telefono=m[0];s=s.replace(m[0]," ");}
  var parti=s.split(/\s*(?:\||;|\t|,|\s[-–—]\s)\s*/).map(pul).filter(function(x){return /[A-Za-zÀ-ÿ]{2}/.test(x)&&!/^(tel|cell|telefono|cellulare|email|e-mail|mail)\.?:?$/i.test(x);});
  c.nome=(parti[0]||"").replace(/^(tel|cell)\.?:?\s*/i,"");if(parti[1])c.impresa=parti[1];return c;}
function leggiCsv(testo){var r1=testo.split(/\r?\n/)[0]||"",sep=[";",",","\t"].sort(function(a,b){return r1.split(b).length-r1.split(a).length;})[0];
  var righe=[],riga=[],cella="",q=false;
  for(var i=0;i<testo.length;i++){var ch=testo[i];
    if(q){if(ch==='"'){if(testo[i+1]==='"'){cella+='"';i++;}else q=false;}else cella+=ch;}
    else if(ch==='"')q=true;else if(ch===sep){riga.push(cella);cella="";}else if(ch==="\n"){riga.push(cella.replace(/\r$/,""));righe.push(riga);riga=[];cella="";}else cella+=ch;}
  if(cella||riga.length){riga.push(cella);righe.push(riga);}return righe;}
function leggiVcf(testo){var out=[],c=null;testo.replace(/\r?\n[ \t]/g,"").split(/\r?\n/).forEach(function(l){var i=l.indexOf(":");if(i<0)return;
  var chiave=l.slice(0,i).toUpperCase(),v=l.slice(i+1).replace(/\\,/g,",").replace(/\\;/g,";");
  if(chiave==="BEGIN"&&/VCARD/i.test(v))c={};else if(chiave==="END"&&c){out.push(c);c=null;}else if(!c)return;
  else if(chiave==="FN"||chiave.indexOf("FN;")===0)c.nome=v;else if((chiave==="N"||chiave.indexOf("N;")===0)&&!c.nome)c.nome=pul(v.split(";").slice(0,2).reverse().join(" "));
  else if(chiave.indexOf("TEL")===0&&!c.telefono)c.telefono=v;else if(chiave.indexOf("EMAIL")===0&&!c.email)c.email=v;else if(chiave.indexOf("ORG")===0)c.impresa=v.split(";")[0];
  else if(chiave.indexOf("TITLE")===0)c.ruolo=v;});return out;}
function leggiPdf(buf){return libreria(LIB.pdf).then(function(){var lib=window.pdfjsLib;lib.GlobalWorkerOptions.workerSrc=LIB.pdfw;return lib.getDocument({data:buf}).promise;}).then(function(doc){
  var pagine=[];for(var p=1;p<=Math.min(doc.numPages,50);p++)pagine.push(p);
  return pagine.reduce(function(pr,n){return pr.then(function(righe){return doc.getPage(n).then(function(pg){return pg.getTextContent();}).then(function(tc){
    var linee={};tc.items.forEach(function(it){if(!pul(it.str))return;var y=Math.round(it.transform[5]/3);(linee[y]=linee[y]||[]).push(it);});
    Object.keys(linee).map(Number).sort(function(a,b){return b-a;}).forEach(function(y){var it=linee[y].sort(function(a,b){return a.transform[4]-b.transform[4];}),celle=[],cur="",fine=null;
      it.forEach(function(x){var x0=x.transform[4];if(fine!==null&&x0-fine>12){celle.push(cur);cur="";}cur+=(cur&&fine!==null&&x0-fine>1.5?" ":"")+x.str;fine=x0+(x.width||0);});celle.push(cur);righe.push(celle);});
    return righe;});});},Promise.resolve([]));});}
function leggiFile(f){var nome=f.name.toLowerCase(),ext=nome.slice(nome.lastIndexOf(".")+1);
  if(ext==="vcf")return f.text().then(leggiVcf);
  if(ext==="csv"||ext==="txt")return f.text().then(function(t){return daTabella(leggiCsv(t));});
  if(ext==="pdf")return f.arrayBuffer().then(leggiPdf).then(daTabella);
  if(ext==="xlsx"||ext==="xls"||ext==="ods")return Promise.all([libreria(LIB.xlsx),f.arrayBuffer()]).then(function(x){var wb=window.XLSX.read(x[1],{type:"array"}),righe=[];
    wb.SheetNames.forEach(function(n){righe=righe.concat(window.XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,raw:false,defval:""}));});return daTabella(righe);});
  return Promise.reject(new Error("questo tipo di file non si può leggere: salvalo come Excel, CSV o PDF"));}
function ruoloDi(t){t=pul(t).toLowerCase();if(!t)return "";for(var k in RUOLI)if((RUOLI[k].etichetta||"").toLowerCase()===t)return k;return "";}
function aziendaScelta(){var v=$("i-az").value||"";return D.filippo?v:"";}
function esistenti(){var z=aziendaScelta();return P.filter(function(p){if(!D.filippo)return true;if(z.indexOf("a:")===0)return p.azienda_id===z.slice(2);if(z.indexOf("r:")===0)return String(p.impresa_id)===z.slice(2);return false;});}
function controlla(){var es=esistenti(),tel={},mail={},nomi={};
  es.forEach(function(p){if(p.telefono)tel[String(p.telefono).replace(/[^0-9]/g,"")]=p;if(p.email)mail[String(p.email).toLowerCase()]=p;var n=normNome(p.nome);if(n)(nomi[n]=nomi[n]||[]).push(p);});
  var visti={};
  IMP.forEach(function(c){c.stato="nuovo";c.perche="";c.tel=normTel(c.telefono);c.mail=pul(c.email).toLowerCase();c.nn=normNome(c.nome);
    if(pul(c.nome).length<2){c.stato="salta";c.perche="Manca il nome: lo salto.";return;}
    var g=(c.tel&&tel[c.tel])||(c.mail&&mail[c.mail])||(c.nn&&nomi[c.nn]&&nomi[c.nn].filter(function(p){return !c.tel||!p.telefono;})[0]);
    if(g){c.stato="doppio";c.perche="Questo contatto esiste già in rubrica ("+pul(g.nome)+(g.telefono?", +"+g.telefono:"")+"): non lo aggiungo.";return;}
    var chiavi=[c.tel&&"t"+c.tel,c.mail&&"m"+c.mail,!c.tel&&!c.mail&&"n"+c.nn].filter(Boolean);
    for(var i=0;i<chiavi.length;i++)if(visti[chiavi[i]]){c.stato="doppio";c.perche="È ripetuto nel file: lo aggiungo una volta sola.";return;}
    chiavi.forEach(function(k){visti[k]=1;});
    if(pul(c.telefono)&&!c.tel)c.perche="Numero non riconosciuto: lo salvo senza telefono.";});
  disegnaImp();}
function disegnaImp(){var nuovi=IMP.filter(function(c){return c.stato==="nuovo";}),dop=IMP.filter(function(c){return c.stato==="doppio";}),sal=IMP.filter(function(c){return c.stato==="salta";});
  var h='<div class="imp-ries"><span>'+nuovi.length+' da aggiungere</span>'+(dop.length?'<span>'+dop.length+' già presenti o doppi, tolti</span>':'')+(sal.length?'<span>'+sal.length+' senza nome, saltati</span>':'')+'</div><div class="imp-l">';
  IMP.forEach(function(c,i){var no=c.stato!=="nuovo";
    h+='<label class="imp-r'+(no?' no':'')+'"><input type="checkbox" data-i="'+i+'"'+(no?' disabled':(c.scelto===false?'':' checked'))+'><span><b>'+esc(pul(c.nome)||"(senza nome)")+'</b>'+
      '<small>'+esc([c.tel?"+"+c.tel:pul(c.telefono),pul(c.email),pul(c.impresa),pul(c.ruolo)].filter(Boolean).join(" · "))+'</small>'+(c.perche?'<small class="perche">'+esc(c.perche)+'</small>':'')+'</span></label>';});
  $("i-anteprima").innerHTML=h+'</div>';var n=nuovi.filter(function(c){return c.scelto!==false;}).length;
  var ok=$("i-ok");ok.hidden=!nuovi.length;ok.disabled=!n;ok.textContent="Aggiungi "+n+(n===1?" contatto":" contatti");}
$("i-anteprima").addEventListener("change",function(e){var x=e.target;if(!x||x.type!=="checkbox")return;IMP[+x.getAttribute("data-i")].scelto=x.checked;disegnaImp();});
$("importa").addEventListener("click",function(){IMP=[];$("i-file").value="";$("i-file-t").textContent="Scegli il file";$("i-anteprima").innerHTML="";$("i-ok").hidden=true;iErr("");
  iStato("Il file si legge qui, sul tuo dispositivo.");var box=$("i-az-box");box.hidden=!D.filippo;
  if(D.filippo){$("i-az").innerHTML=Array.prototype.filter.call($("s-az").options,function(o){return o.value!=="nuova";}).map(function(o){return o.outerHTML;}).join("");
    var gr=$("s-az").querySelectorAll("optgroup");if(gr.length){$("i-az").innerHTML='<option value="">Scegli…</option>'+Array.prototype.map.call(gr,function(g){return g.outerHTML;}).join("");}}
  $("velo-imp").hidden=false;});
$("i-az").addEventListener("change",function(){if(IMP.length)controlla();});
$("i-file").addEventListener("change",function(){var f=this.files&&this.files[0];if(!f)return;iErr("");$("i-ok").hidden=true;$("i-anteprima").innerHTML="";
  if(f.size>20*1024*1024){iErr("Il file è troppo grande (più di 20 MB).");return;}
  IMP_FILE=f.name;$("i-file-t").textContent=f.name;iStato("Leggo il file…");
  leggiFile(f).then(function(lista){IMP=lista.filter(function(c){return c&&(pul(c.nome)||pul(c.telefono)||pul(c.email));}).slice(0,1000);
    if(!IMP.length){iStato("");iErr("Nel file non ho trovato contatti. Va bene un elenco con nome e telefono, una persona per riga.");return;}
    iStato("Ho trovato "+IMP.length+(IMP.length===1?" contatto":" contatti")+" in «"+f.name+"». Controlla l'elenco e tocca «Aggiungi».");controlla();})
  .catch(function(e){iStato("");iErr("Non sono riuscito a leggere il file: "+(e&&e.message?e.message:e)+".");});});
$("i-ok").addEventListener("click",function(){if(D.filippo&&!aziendaScelta()){iErr("Scegli prima l'impresa a cui appartengono i contatti.");$("i-az").focus();return;}
  var da=IMP.filter(function(c){return c.stato==="nuovo"&&c.scelto!==false;});if(!da.length)return;
  var ok=$("i-ok");ok.disabled=true;iErr("");var fatti=0,gia=[],errori=[],i=0,z=aziendaScelta();
  function prossimo(){if(i>=da.length)return Promise.resolve();var c=da[i++];iStato("Aggiungo "+i+" di "+da.length+"…");
    var dati={nome:pul(c.nome).slice(0,120),telefono:c.tel?"+"+c.tel:"",email:/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.mail)?c.mail:"",impresa:pul(c.impresa).slice(0,120),
      partita_iva:/^\d{11}$/.test(pul(c.partita_iva).replace(/\D/g,""))?pul(c.partita_iva).replace(/\D/g,""):"",codice_fiscale:RE_CF.test(pul(c.codice_fiscale))?pul(c.codice_fiscale).toUpperCase():"",
      ruolo:ruoloDi(c.ruolo),note:pul(c.ruolo)&&!ruoloDi(c.ruolo)?("Ruolo: "+pul(c.ruolo)).slice(0,500):""};
    if(!dati.impresa&&!D.filippo)dati.impresa=D.impresa||"";
    if(z.indexOf("a:")===0)dati.azienda_id=z.slice(2);else if(z.indexOf("r:")===0)dati.impresa_id=z.slice(2);
    return chiama("rubrica_salva",{dati:dati}).then(function(r){if(r&&r.esito==="ok")fatti++;else if(r&&r.campo==="telefono"&&/già/.test(r.messaggio||""))gia.push(dati.nome);else errori.push(dati.nome+(r&&r.messaggio?" ("+r.messaggio+")":""));})
      .catch(function(){errori.push(dati.nome+" (connessione)");}).then(prossimo);}
  prossimo().then(function(){ok.disabled=false;ok.hidden=true;
    var t="Aggiunti "+fatti+(fatti===1?" contatto":" contatti")+" alla rubrica.";
    var dop=IMP.filter(function(c){return c.stato==="doppio";}).length+gia.length;if(dop)t+=" "+dop+(dop===1?" era già presente e non l'ho aggiunto.":" erano già presenti o doppi e non li ho aggiunti.");
    iStato(t);if(errori.length)iErr("Non salvati: "+errori.slice(0,8).join("; ")+(errori.length>8?"…":""));$("i-anteprima").innerHTML="";toast(t);ricarica();});});
`;

// 30/10/2026 (Filippo): telefono con bandierina e prefisso del paese, Italia di base
const TEL_CSS = ".tel-box{position:relative;display:flex;gap:6px}.tel-box .campo{flex:1;min-width:0}" +
  ".tel-paese{flex:0 0 auto;display:flex;align-items:center;gap:6px;min-height:44px;padding:0 10px;border:1px solid var(--bordo);border-radius:10px;background:var(--bg);color:var(--testo);font:inherit;font-weight:600;cursor:pointer}" +
  ".tel-paese svg,.tel-op svg{width:24px;height:16px;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.18);flex:0 0 auto}" +
  ".tel-paese:focus-visible,.tel-op:focus-visible{outline:2px solid #2563eb;outline-offset:1px}" +
  ".tel-lista{position:absolute;left:0;top:calc(100% + 4px);z-index:30;width:min(300px,86vw);max-height:280px;overflow:auto;padding:6px;border:1px solid var(--bordo);border-radius:12px;background:var(--bg);color:var(--testo);box-shadow:0 12px 32px rgba(0,0,0,.18)}" +
  ".tel-lista input{width:100%;box-sizing:border-box;margin:0 0 6px;padding:8px 10px;border:1px solid var(--bordo);border-radius:8px;font:inherit;background:var(--bg);color:var(--testo)}" +
  ".tel-op{display:flex;align-items:center;gap:10px;width:100%;padding:8px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}" +
  ".tel-op:hover,.tel-op[aria-selected=true]{background:rgba(37,99,235,.1)}.tel-op b{margin-left:auto;font-weight:600;opacity:.75}";

const TEL_JS = String.raw`
var TEL_PAESI=[
["it","Italia","39","v:#009246,#fff,#ce2b37"],
["al","Albania","355","s:#e41e20",'<path d="M15 4l3.5 4-1.5 1 2 3-4 4-4-4 2-3-1.5-1z" fill="#000"/>'],
["dz","Algeria","213","v:#006233,#fff",'<circle cx="15" cy="10" r="4.5" fill="#d21034"/><circle cx="16.4" cy="10" r="3.7" fill="#fff"/>'],
["at","Austria","43","h:#ed2939,#fff,#ed2939"],
["bd","Bangladesh","880","s:#006a4e",'<circle cx="13" cy="10" r="6" fill="#f42a41"/>'],
["be","Belgio","32","v:#000,#fdda24,#ef3340"],
["ba","Bosnia ed Erzegovina","387","s:#002395",'<path d="M9 0h12v20z" fill="#fecb00"/>'],
["br","Brasile","55","s:#009c3b",'<path d="M15 2l13 8-13 8L2 10z" fill="#ffdf00"/><circle cx="15" cy="10" r="4.5" fill="#002776"/>'],
["bg","Bulgaria","359","h:#fff,#00966e,#d62612"],
["cn","Cina","86","s:#de2910","*6,6,3.5,#ffde00"],
["ci","Costa d'Avorio","225","v:#f77f00,#fff,#009e60"],
["hr","Croazia","385","h:#ff0000,#fff,#171796"],
["ec","Ecuador","593","h:#ffdd00,#ffdd00,#034ea2,#ed1c24"],
["eg","Egitto","20","h:#ce1126,#fff,#000"],
["ph","Filippine","63","h:#0038a8,#ce1126",'<path d="M0 0l17.3 10L0 20z" fill="#fff"/><circle cx="5.5" cy="10" r="2" fill="#fcd116"/>'],
["fr","Francia","33","v:#0055a4,#fff,#ef4135"],
["gm","Gambia","220","h:#ce1126,#0c1c8c,#3a7728",'<rect y="6.2" width="30" height="1" fill="#fff"/><rect y="12.8" width="30" height="1" fill="#fff"/>'],
["ge","Georgia","995","s:#fff",'<rect x="13" width="4" height="20" fill="#f00"/><rect y="8" width="30" height="4" fill="#f00"/>'],
["de","Germania","49","h:#000,#dd0000,#ffce00"],
["gh","Ghana","233","h:#ce1126,#fcd116,#006b3f","*15,10,3.2,#000"],
["in","India","91","h:#ff9933,#fff,#138808",'<circle cx="15" cy="10" r="2.5" fill="none" stroke="#000080" stroke-width=".8"/>'],
["xk","Kosovo","383","s:#244aa5",'<path d="M11 8h8l-1 6h-6z" fill="#d0a650"/>'],
["mk","Macedonia del Nord","389","s:#d20000",'<circle cx="15" cy="10" r="3.5" fill="#ffe600"/>'],
["ml","Mali","223","v:#14b53a,#fcd116,#ce1126"],
["ma","Marocco","212","s:#c1272d","o15,10,4,#006233"],
["md","Moldavia","373","v:#0046ae,#ffd200,#cc092f"],
["ng","Nigeria","234","v:#008751,#fff,#008751"],
["nl","Paesi Bassi","31","h:#ae1c28,#fff,#21468b"],
["pk","Pakistan","92","s:#01411c",'<rect width="7.5" height="20" fill="#fff"/><circle cx="18" cy="10" r="5" fill="#fff"/><circle cx="19.6" cy="8.8" r="4.3" fill="#01411c"/>'],
["pe","Perù","51","v:#d91023,#fff,#d91023"],
["pl","Polonia","48","h:#fff,#dc143c"],
["pt","Portogallo","351","s:#f00",'<rect width="12" height="20" fill="#060"/><circle cx="12" cy="10" r="3.5" fill="#fc0"/>'],
["gb","Regno Unito","44","s:#012169",'<path d="M0 0l30 20M30 0L0 20" stroke="#fff" stroke-width="4"/><path d="M0 0l30 20M30 0L0 20" stroke="#c8102e" stroke-width="1.4"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#c8102e" stroke-width="3.4"/>'],
["ro","Romania","40","v:#002b7f,#fcd116,#ce1126"],
["ru","Russia","7","h:#fff,#0039a6,#d52b1e"],
["sm","San Marino","378","h:#fff,#5eb6e4"],
["sn","Senegal","221","v:#00853f,#fdef42,#e31b23","*15,10,3,#00853f"],
["rs","Serbia","381","h:#c6363c,#0c4076,#fff"],
["es","Spagna","34","h:#aa151b,#f1bf00,#f1bf00,#aa151b"],
["lk","Sri Lanka","94","s:#ffb700",'<rect x="11" y="1.5" width="17.5" height="17" fill="#8d153a"/><rect x="1.5" y="1.5" width="4" height="17" fill="#00534e"/><rect x="6" y="1.5" width="4" height="17" fill="#eb7400"/>'],
["ch","Svizzera","41","s:#da291c",'<path d="M13 4h4v4h4v4h-4v4h-4v-4H9V8h4z" fill="#fff"/>'],
["tn","Tunisia","216","s:#e70013",'<circle cx="15" cy="10" r="5" fill="#fff"/><circle cx="15.6" cy="10" r="3.6" fill="#e70013"/><circle cx="16.7" cy="10" r="2.9" fill="#fff"/>'],
["tr","Turchia","90","s:#e30a17",'<circle cx="12" cy="10" r="5" fill="#fff"/><circle cx="13.3" cy="10" r="4" fill="#e30a17"/>',"*18.6,10,2,#fff"],
["ua","Ucraina","380","h:#0057b7,#ffd700"],
["hu","Ungheria","36","h:#ce2939,#fff,#477050"],
["xx","Altro paese (scrivi il numero con +)","","s:#e5e7eb",'<circle cx="15" cy="10" r="6" fill="none" stroke="#6b7280" stroke-width="1.2"/><path d="M9 10h12M15 4c-3 3-3 9 0 12M15 4c3 3 3 9 0 12" fill="none" stroke="#6b7280" stroke-width="1"/>']
];
function telStella(cx,cy,r,col,vuota){var p=[];for(var i=0;i<10;i++){var a=Math.PI/5*i-Math.PI/2,rr=i%2?r*.4:r;p.push((cx+rr*Math.cos(a)).toFixed(2)+","+(cy+rr*Math.sin(a)).toFixed(2));}
  return '<polygon points="'+p.join(" ")+'" '+(vuota?'fill="none" stroke="'+col+'" stroke-width=".9"':'fill="'+col+'"')+'/>';}
function telBandiera(pa){var s='<svg viewBox="0 0 30 20" aria-hidden="true" focusable="false">',spec=pa[3],t=spec.charAt(0),c=spec.slice(2).split(",");
  if(t==="s")s+='<rect width="30" height="20" fill="'+c[0]+'"/>';
  else c.forEach(function(col,i){var n=c.length;s+=t==="v"?'<rect x="'+(30/n*i)+'" width="'+(30/n+.05)+'" height="20" fill="'+col+'"/>':'<rect y="'+(20/n*i)+'" width="30" height="'+(20/n+.05)+'" fill="'+col+'"/>';});
  pa.slice(4).forEach(function(x){if(x.charAt(0)==="*"||x.charAt(0)==="o"){var q=x.slice(1).split(",");s+=telStella(+q[0],+q[1],+q[2],q[3],x.charAt(0)==="o");}else s+=x;});
  return s+'</svg>';}
function telPaese(cod){for(var i=0;i<TEL_PAESI.length;i++)if(TEL_PAESI[i][0]===cod)return TEL_PAESI[i];return TEL_PAESI[0];}
function telScegli(inp,cod){var pa=telPaese(cod);inp.dataset.paese=pa[0];var b=inp.parentNode.querySelector(".tel-paese");
  b.innerHTML=telBandiera(pa)+'<span>'+(pa[2]?"+"+pa[2]:"+")+'</span>';b.setAttribute("aria-label","Paese del numero: "+pa[1]+(pa[2]?", prefisso +"+pa[2]:"")+". Tocca per cambiarlo");
  inp.placeholder=pa[2]==="39"?"333 123 4567":(pa[2]?"numero senza prefisso":"+ prefisso e numero");}
function telImposta(id,num){var inp=document.getElementById(id);if(!inp)return;num=String(num||"").replace(/[^0-9]/g,"");var cod="it",resto=num;
  if(num){var m=null;TEL_PAESI.forEach(function(pa){if(pa[2]&&num.indexOf(pa[2])===0&&num.length>pa[2].length+5&&(!m||pa[2].length>m[2].length))m=pa;});
    if(m){cod=m[0];resto=num.slice(m[2].length);}else{cod="xx";resto="+"+num;}}
  telScegli(inp,cod);inp.value=resto;}
function telValore(id){var inp=document.getElementById(id);if(!inp)return "";var v=inp.value.trim();if(!v)return "";
  if(v.charAt(0)==="+"||v.indexOf("00")===0)return v;var pa=telPaese(inp.dataset.paese||"it");if(!pa[2])return v;
  var n=v.replace(/[^0-9]/g,"");if(pa[2]!=="39")n=n.replace(/^0+/,"");return "+"+pa[2]+n;}
function telMonta(id){var inp=document.getElementById(id);if(!inp||inp.parentNode.classList.contains("tel-box"))return;
  var box=document.createElement("div");box.className="tel-box";inp.parentNode.insertBefore(box,inp);
  var b=document.createElement("button");b.type="button";b.className="tel-paese";b.setAttribute("aria-haspopup","listbox");b.setAttribute("aria-expanded","false");
  box.appendChild(b);box.appendChild(inp);var lista=null;
  function chiudi(){if(lista){lista.remove();lista=null;b.setAttribute("aria-expanded","false");document.removeEventListener("mousedown",fuori,true);}}
  function fuori(e){if(!box.contains(e.target))chiudi();}
  function disegna(q){var h="";q=(q||"").toLowerCase();TEL_PAESI.forEach(function(pa){if(q&&(pa[1].toLowerCase().indexOf(q)<0&&("+"+pa[2]).indexOf(q)<0))return;
    h+='<button type="button" class="tel-op" role="option" data-c="'+pa[0]+'" aria-selected="'+(pa[0]===inp.dataset.paese)+'">'+telBandiera(pa)+'<span>'+pa[1]+'</span><b>'+(pa[2]?"+"+pa[2]:"")+'</b></button>';});
    lista.querySelector(".tel-ops").innerHTML=h||'<p style="margin:6px;opacity:.7">Nessun paese trovato</p>';}
  b.addEventListener("click",function(){if(lista){chiudi();return;}
    lista=document.createElement("div");lista.className="tel-lista";lista.setAttribute("role","listbox");lista.setAttribute("aria-label","Paese del numero");
    lista.innerHTML='<input type="search" placeholder="Cerca il paese" aria-label="Cerca il paese"><div class="tel-ops"></div>';box.appendChild(lista);disegna("");
    b.setAttribute("aria-expanded","true");var c=lista.querySelector("input");c.addEventListener("input",function(){disegna(c.value);});
    lista.addEventListener("click",function(e){var o=e.target.closest(".tel-op");if(!o)return;var vecchio=inp.value;telScegli(inp,o.getAttribute("data-c"));
      if(o.getAttribute("data-c")==="xx"&&vecchio&&vecchio.charAt(0)!=="+")inp.value="+"+vecchio;chiudi();inp.focus();});
    lista.addEventListener("keydown",function(e){if(e.key==="Escape"){e.stopPropagation();chiudi();b.focus();}});
    document.addEventListener("mousedown",fuori,true);var sel=lista.querySelector('[aria-selected="true"]');if(sel)sel.scrollIntoView({block:"nearest"});c.focus();});
  telScegli(inp,"it");}
["s-tel","f-tel"].forEach(telMonta);
`;

const RUBRICA_JS = String.raw`
var D=CFG.dati,P=D.persone||[],RUOLI=D.ruoli||{},corr=null;
function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
var toastT;function toast(t){var el=$("toast");el.textContent=t;el.hidden=false;clearTimeout(toastT);toastT=setTimeout(function(){el.hidden=true;},2800);}
function chiama(az,extra){var b={t:CFG.t,azione:az};for(var k in extra)b[k]=extra[k];
  return fetch(CFG.api,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json();});}
var RAPP={titolare:"Titolare",dipendente:"Dipendente",subappaltatore:"Subappaltatore",autonomo:"Artigiano autonomo",fornitore:"Fornitore",professionista:"Professionista",esterno:"Esterno"};
function sotto(){$("sotto").textContent=(D.impresa||"")+" · "+P.length+(P.length===1?" contatto":" contatti");}
function disegna(q){q=(q||"").toLowerCase().trim();var h="";sotto();
  P.filter(function(p){return !q||[p.nome,p.impresa,p.ruolo_etichetta,p.telefono,p.email,p.azienda,p.partita_iva,p.codice_fiscale].join(" ").toLowerCase().indexOf(q)>=0;}).forEach(function(p){
    h+='<article class="p"><div class="p-top"><div><div class="p-nome">'+esc(p.nome)+'</div><div class="p-sub">'+esc([p.impresa,RAPP[p.tipo_rapporto]].filter(Boolean).join(" · "))+(D.filippo&&p.azienda?' · cliente '+esc(p.azienda):'')+'</div></div>'+
      '<button class="btn sm" type="button" data-mod="'+p.id+'">Modifica</button></div>'+
      '<div class="chips">'+(p.ruolo_etichetta?'<span class="chip">'+esc(p.ruolo_etichetta)+'</span>':'')+(p.telefono?'<span class="chip">+'+esc(p.telefono)+'</span>':'')+(p.email?'<span class="chip">'+esc(p.email)+'</span>':'')+
      (p.partita_iva?'<span class="chip">P.IVA '+esc(p.partita_iva)+'</span>':'')+(p.codice_fiscale?'<span class="chip">CF '+esc(p.codice_fiscale)+'</span>':'')+'</div>'+
      (p.note?'<p class="p-sub" style="margin:6px 0 0">'+esc(p.note)+'</p>':'')+
      (p.cantieri&&p.cantieri.length?'<div class="azioni">'+p.cantieri.map(function(c){return '<a class="btn sm" href="'+esc(CFG.base+"/persone?t="+CFG.t+"&c="+c.id)+'">'+esc(c.nome)+'</a>';}).join("")+'</div>':'<p class="p-sub" style="margin:8px 0 0">Non è in nessun cantiere in corso.</p>')+'</article>';});
  $("lista").innerHTML=h||'<p class="nota">'+(P.length?'Nessun contatto trovato.':'La rubrica è vuota: tocca «+ Nuovo contatto».')+'</p>';}
var sr=$("s-ruolo");
Object.keys(RUOLI).sort(function(a,b){return (RUOLI[a].ordine||99)-(RUOLI[b].ordine||99);}).forEach(function(k){var o=document.createElement("option");o.value=k;o.textContent=RUOLI[k].etichetta;sr.appendChild(o);});
sr.addEventListener("change",function(){if(sr.value&&RUOLI[sr.value]&&!$("s-rapp").value)$("s-rapp").value=RUOLI[sr.value].rapporto;});
var sa=$("s-az");
function riempiAz(){if(!D.filippo)return;
  sa.innerHTML='<option value="">Scegli…</option><optgroup label="Clienti TIX">'+(D.aziende||[]).map(function(a){return '<option value="a:'+esc(a.id)+'">'+esc(a.nome)+'</option>';}).join("")+'</optgroup>'+
    ((D.imprese||[]).length?'<optgroup label="Altre imprese della rubrica">'+D.imprese.map(function(a){return '<option value="r:'+esc(a.id)+'">'+esc(a.nome)+'</option>';}).join("")+'</optgroup>':'')+
    '<option value="nuova">+ Nuova impresa…</option>';}
function riempiImp(){var v={};P.forEach(function(p){if(p.impresa)v[p.impresa]=1;});(D.imprese||[]).forEach(function(a){v[a.nome]=1;});
  $("s-imp-lista").innerHTML=Object.keys(v).sort().map(function(n){return '<option value="'+esc(n)+'">';}).join("");}
riempiAz();riempiImp();
sa.addEventListener("change",function(){var n=sa.value==="nuova";$("s-nuova-box").hidden=!n;if(n)$("s-nuova").focus();});
$("s-rapp").addEventListener("change",function(){if(this.value==="professionista"&&D.impresa&&$("s-imp").value===D.impresa){$("s-imp").value="";$("s-imp").focus();}});
function apri(p){corr=p||null;$("t-sch").textContent=p?"Modifica contatto":"Nuovo contatto";$("s-err").hidden=true;
  $("s-az-box").hidden=!(D.filippo&&!p);if(D.filippo&&!p){sa.value="";$("s-nuova-box").hidden=true;$("s-nuova").value="";$("s-nuova-piva").value="";}
  $("s-nome").value=p?p.nome||"":"";telImposta("s-tel",p&&p.telefono?p.telefono:"");$("s-mail").value=p?p.email||"":"";$("s-imp").value=p?p.impresa||"":(D.filippo?"":D.impresa||"");
  $("s-piva").value=p?p.partita_iva||"":"";$("s-cf").value=p?p.codice_fiscale||"":"";sr.value=p&&p.ruolo&&RUOLI[p.ruolo]?p.ruolo:"";$("s-rapp").value=p?p.tipo_rapporto||"":"";$("s-note").value=p?p.note||"":"";
  var el=$("s-elim");el.hidden=!p;el.textContent="Elimina dalla rubrica";delete el.dataset.conferma;el.disabled=false;
  $("velo-sch").hidden=false;$("s-nome").focus();}
function ricarica(){return chiama("rubrica",{}).then(function(r){if(r&&r.esito==="ok"){D=r;P=r.persone||[];riempiAz();riempiImp();}disegna($("cerca").value);});}
$("nuovo").addEventListener("click",function(){apri(null);});
$("lista").addEventListener("click",function(e){var b=e.target.closest("button[data-mod]");if(!b)return;for(var i=0;i<P.length;i++)if(String(P[i].id)===b.dataset.mod)apri(P[i]);});
$("cerca").addEventListener("input",function(e){disegna(e.target.value);});
document.querySelectorAll("[data-chiudi]").forEach(function(b){b.addEventListener("click",function(){b.closest(".velo").hidden=true;});});
document.querySelectorAll(".velo").forEach(function(v){v.addEventListener("click",function(e){if(e.target===v)v.hidden=true;});});
$("form-sch").addEventListener("submit",function(e){e.preventDefault();var ok=$("s-ok");ok.disabled=true;$("s-err").hidden=true;
  var dati={nome:$("s-nome").value,telefono:telValore("s-tel"),email:$("s-mail").value,impresa:$("s-imp").value,partita_iva:$("s-piva").value,codice_fiscale:$("s-cf").value,ruolo:sr.value,tipo_rapporto:$("s-rapp").value,note:$("s-note").value};
  if(D.filippo&&!corr){var z=sa.value;if(z==="nuova"){dati.nuova_impresa=$("s-nuova").value;dati.nuova_impresa_piva=$("s-nuova-piva").value;}
    else if(z.indexOf("r:")===0)dati.impresa_id=z.slice(2);else if(z.indexOf("a:")===0)dati.azienda_id=z.slice(2);}
  chiama("rubrica_salva",corr?{id:corr.id,dati:dati}:{dati:dati}).then(function(r){ok.disabled=false;
    if(r.esito==="ok"){$("velo-sch").hidden=true;toast(corr?"Contatto aggiornato":"Contatto aggiunto alla rubrica");ricarica();}
    else{$("s-err").textContent=r.messaggio||"Non salvato: riprova.";$("s-err").hidden=false;var f=r.campo&&$({nome:"s-nome",telefono:"s-tel",email:"s-mail",partita_iva:"s-piva",codice_fiscale:"s-cf",azienda:"s-az",nuova_impresa:"s-nuova",nuova_impresa_piva:"s-nuova-piva"}[r.campo]);if(f)f.focus();}})
  .catch(function(){ok.disabled=false;$("s-err").textContent="Connessione assente: riprova.";$("s-err").hidden=false;});});
$("s-elim").addEventListener("click",function(){var b=$("s-elim");if(!corr)return;
  if(!b.dataset.conferma){b.dataset.conferma="1";b.textContent="Tocca di nuovo per eliminare";return;}
  b.disabled=true;chiama("rubrica_elimina",{id:corr.id}).then(function(r){b.disabled=false;if(r.esito==="ok"){$("velo-sch").hidden=true;toast("Contatto eliminato dalla rubrica");ricarica();}else toast("Non riuscito: riprova");})
  .catch(function(){b.disabled=false;toast("Connessione assente: riprova");});});
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
  ".testa{background:var(--navy);color:#fff;padding:16px max(16px,env(safe-area-inset-left)) 20px}.in{max-width:720px;margin:0 auto}@media screen and (min-width:760px){.in{max-width:min(1000px,calc(100vw - 48px))}}@media screen and (min-width:900px){.in{max-width:min(1000px,calc(100vw - 200px))}}" +
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
  '<h2 id="t-agg">Nuovo contatto nel cantiere</h2><p class="sotto">Le scelte si possono cambiare dopo, con un tocco. Il contatto entra anche in Rubrica, dove puoi completare i dati anagrafici.</p>' +
  '<label class="c" for="f-nome">Nome e cognome</label><input class="campo" id="f-nome" autocomplete="off" maxlength="120">' +
  '<label class="c" for="f-ruolo">Ruolo nel cantiere</label><select class="campo" id="f-ruolo"></select>' +
  '<div class="riga2"><div><label class="c" for="f-tel">Telefono</label><input class="campo" id="f-tel" type="tel" inputmode="tel" maxlength="20" placeholder="333 123 4567"></div>' +
  '<div><label class="c" for="f-mail">Email</label><input class="campo" id="f-mail" type="email" maxlength="120" placeholder="facoltativa"></div></div>' +
  '<label class="c" for="f-imp">Impresa della persona</label><input class="campo" id="f-imp" maxlength="120">' +
  '<label class="c" for="f-rapp">Rapporto con l\'impresa</label><select class="campo" id="f-rapp">' +
  '<option value="titolare">Titolare (si conta nel canone)</option><option value="dipendente">Dipendente (si conta nel canone)</option><option value="subappaltatore">Impresa subappaltatrice (senza costi)</option>' +
  '<option value="autonomo">Artigiano autonomo incaricato (senza costi, solo WhatsApp)</option><option value="fornitore">Fornitore (senza costi)</option>' +
  '<option value="professionista">Professionista con partita IVA: PM, DL, CSE, consulente (senza costi)</option><option value="esterno">Esterno: DL, CSE, RUP, committente (non scrive)</option></select>' +
  '<label class="spunta"><input type="checkbox" id="f-consenso"> <span>Ho il consenso della persona a ricevere da TIX un promemoria su WhatsApp, se non attiva entro 48 ore.</span></label>' +
  '<p class="errore" id="f-err" hidden></p><div class="fine"><button class="btn" type="button" data-chiudi>Annulla</button><button class="btn pr" type="submit" id="f-ok">Aggiungi e crea l\'invito</button></div></form></div>';

const SCELTA_HTML = '<div class="velo" id="velo-scelta" hidden><div class="foglio" role="dialog" aria-modal="true" aria-labelledby="t-scelta">' +
  '<h2 id="t-scelta">Scegli contatto da rubrica oppure nuovo contatto</h2><p class="sotto">Chi aggiungi riceve un invito personale per questo cantiere.</p>' +
  '<div class="lista"><button class="btn" type="button" id="apri-rubrica" style="justify-content:flex-start;min-height:56px">&#128211;&nbsp; Scegli contatto da rubrica</button>' +
  '<button class="btn" type="button" id="apri-aggiungi" style="justify-content:flex-start;min-height:56px">&#10133;&nbsp; Nuovo contatto</button></div>' +
  '<div class="fine"><button class="btn" type="button" data-chiudi>Annulla</button></div></div></div>';

const RUBRICA_HTML = '<div class="velo" id="velo-rub" hidden><div class="foglio" role="dialog" aria-modal="true" aria-labelledby="t-rub">' +
  '<h2 id="t-rub">Scegli contatto da rubrica</h2><p class="sotto">Tocca un nome per riempire il modulo, poi controlla ruolo e permessi.</p>' +
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
  if(!persone.length){h='<p class="nota">Ancora nessuna persona. Tocca «Scegli contatto da rubrica oppure nuovo contatto»: per ognuna crei un invito da mandare su WhatsApp, per email o con il QR.</p>';}
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
  $("rub-lista").innerHTML=h||'<p class="nota">'+(RUB&&RUB.length?'Nessun contatto trovato.':'La rubrica è vuota: scegli «Nuovo contatto», oppure aggiungi i contatti dall\'icona «Rubrica» nella pagina dei cantieri.')+'</p>';}
function apriModulo(){$("form-agg").reset();telImposta("f-tel","");$("f-imp").value=D.impresa||"";$("f-err").hidden=true;$("f-rapp").value=RUOLI[sel.value].rapporto;$("velo-agg").hidden=false;}
$("apri-scelta").addEventListener("click",function(){$("velo-scelta").hidden=false;});
$("apri-rubrica").addEventListener("click",function(){$("velo-scelta").hidden=true;$("velo-rub").hidden=false;$("rub-cerca").value="";
  if(RUB){disegnaRub("");return;}$("rub-lista").innerHTML='<p class="nota">Carico la rubrica…</p>';
  chiama("rubrica",{}).then(function(r){RUB=(r&&r.esito==="ok")?r.persone:[];disegnaRub("");}).catch(function(){$("rub-lista").innerHTML='<p class="nota">Connessione assente: riprova.</p>';});});
$("rub-cerca").addEventListener("input",function(e){disegnaRub(e.target.value);});
$("rub-lista").addEventListener("click",function(e){var b=e.target.closest("button[data-r]");if(!b||b.disabled)return;var p=RUB[+b.dataset.r];
  apriModulo();$("f-nome").value=p.nome||"";telImposta("f-tel",p.telefono||"");$("f-mail").value=p.email||"";$("f-imp").value=p.impresa||D.impresa||"";
  if(p.ruolo&&RUOLI[p.ruolo]){sel.value=p.ruolo;$("f-rapp").value=RUOLI[p.ruolo].rapporto;}
  if(p.tipo_rapporto){$("f-rapp").value=p.tipo_rapporto;}
  $("velo-rub").hidden=true;toast("Dati presi dalla rubrica: controlla il ruolo e aggiungi");});
$("apri-aggiungi").addEventListener("click",function(){$("velo-scelta").hidden=true;apriModulo();$("f-nome").focus();});
document.querySelectorAll("[data-chiudi]").forEach(function(b){b.addEventListener("click",function(){b.closest(".velo").hidden=true;});});
document.querySelectorAll(".velo").forEach(function(v){v.addEventListener("click",function(e){if(e.target===v)v.hidden=true;});});
$("form-agg").addEventListener("submit",function(e){
  e.preventDefault();var ok=$("f-ok");ok.disabled=true;$("f-err").hidden=true;
  chiama("aggiungi",{dati:{nome:$("f-nome").value,ruolo:sel.value,telefono:telValore("f-tel"),email:$("f-mail").value,impresa:$("f-imp").value,tipo_rapporto:$("f-rapp").value,consenso_promemoria:$("f-consenso").checked}})
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
