// ============================================================================
// AGENDA DI CANTIERE — Area riservata + avvisi WhatsApp (14/10/2026)
// Richiesta di Filippo (14/10/2026, 14:07): un'icona nella pagina del cantiere per segnare appuntamenti
// (consegne, fornitori, sopralluoghi…) e un avviso su WhatsApp a chi lavora in quel cantiere. «vai» alle 14:15.
//   GET  /agenda?t=<gettone>&c=<cantiere>          → pagina: appuntamenti del cantiere, modulo «Nuovo appuntamento»
//   POST /agenda/crea   {t, c, dati}                → RPC agenda_crea, poi gli avvisi partono subito da qui
//   POST /agenda/azione {t, id, azione, dati}       → RPC agenda_modifica (sposta, annulla, avvenuto, riapri, cliente, aggiorna)
// Gli avvisi: il database decide chi riceve e il testo (agenda_avvisi_lista, nella lingua di ciascuno, una riga per
// persona e versione, mai doppi); qui si spedisce con il token WhatsApp e si segna l'esito (agenda_avviso_segna).
// La stessa funzione la chiama anche il database (trigger → pg_net → POST /admin {azione: agenda_avvisa}) per gli
// appuntamenti nati fuori dal portale (fase 2: lettura AI dai messaggi WhatsApp).
// Fuori dalla finestra gratuita di 24 ore Meta rifiuta i messaggi liberi: il database lo sa e segna «fuori finestra»;
// quelle persone ricevono l'appuntamento nel messaggio del mattino (fase 3) o con un modello approvato da Meta.
// Il relay non conserva nulla. Il nome dell'impresa non compare mai nei messaggi (solo il nome del cantiere).
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GETTONE = /^[0-9a-f]{64}$/;
const TIPI = { consegna: "Consegna", fornitore: "Fornitore", sopralluogo: "Sopralluogo", collaudo: "Collaudo", riunione: "Riunione", altro: "Altro" };

export const AGENDA_ICONA =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3.5" y="5" width="17" height="15.5" rx="2.4"/><path d="M8 3v4M16 3v4M3.5 10h17M12 13v5M9.5 15.5h5"/></svg>';

// ---------------------------------------------------------------------------- avvisi
// Spedisce gli avvisi WhatsApp di un appuntamento. Ritorna {inviati, errori, fuori_finestra, saltato}.
export async function agendaAvvisa(env, id, forza, h) {
  const esito = { id: Number(id) || 0, inviati: 0, errori: 0, saltato: "" };
  if (!esito.id) { esito.saltato = "id"; return esito; }
  if (!env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN || env.AGENDA === "off") { esito.saltato = "configurazione"; return esito; }
  const cfg = await h.config(env);
  if (!cfg.phone_number_id) { esito.saltato = "phone_number_id"; return esito; }
  let lista = [];
  try { lista = await h.rpc(env, "agenda_avvisi_lista", { p_id: esito.id, p_forza: forza === true }, 10000); }
  catch (e) { esito.saltato = "lista: " + String((e && e.message) || e); return esito; }
  for (const r of (Array.isArray(lista) ? lista : []).slice(0, 100)) {
    const tel = String(r.telefono || "").replace(/[^0-9]/g, "");
    if (!tel || !r.payload || typeof r.payload !== "object") continue;
    const payload = r.payload;
    payload.messaging_product = "whatsapp";
    payload.to = tel;
    let ok = false, dettaglio = "";
    try {
      const inv = await h.invia(cfg.phone_number_id, env.WHATSAPP_TOKEN, payload);
      ok = inv.ok; dettaglio = inv.status + " " + inv.testo;
    } catch (e) { dettaglio = String((e && e.message) || e); }
    if (ok) esito.inviati++; else esito.errori++;
    try {
      await h.rpc(env, "agenda_avviso_segna", { p_id: esito.id, p_telefono: tel, p_livello: String(r.livello || "subito"),
        p_versione: Number(r.versione) || 1, p_ok: ok, p_dettaglio: dettaglio.slice(0, 250) }, 5000);
    } catch (e) {}
    await h.log(env, tel, null, ok ? "agenda_avviso" : "agenda_avviso_errore", (r.livello || "") + " #" + esito.id + " · " + dettaglio.slice(0, 250));
  }
  return esito;
}

// Conferma a chi ha scritto (fase 2): «📅 Segno in agenda: … Giusto? [✅ Giusto] [✏️ Correggi]».
// Il testo e i pulsanti li prepara il database (agenda_conferma_payload); id della coda, non dell'appuntamento.
export async function agendaConferma(env, id, h) {
  const esito = { id: Number(id) || 0, inviato: false, dettaglio: "" };
  if (!esito.id) { esito.dettaglio = "id"; return esito; }
  if (!env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN || env.AGENDA === "off") { esito.dettaglio = "configurazione"; return esito; }
  const cfg = await h.config(env);
  if (!cfg.phone_number_id) { esito.dettaglio = "phone_number_id"; return esito; }
  let r = null;
  try { r = await h.rpc(env, "agenda_conferma_payload", { p_id: esito.id }, 8000); } catch (e) { esito.dettaglio = "payload: " + String((e && e.message) || e); return esito; }
  const tel = r && String(r.telefono || "").replace(/[^0-9]/g, "");
  if (!r || !tel || !r.payload || typeof r.payload !== "object") { esito.dettaglio = "niente da mandare"; return esito; }
  const payload = r.payload;
  payload.messaging_product = "whatsapp";
  payload.to = tel;
  try {
    const inv = await h.invia(cfg.phone_number_id, env.WHATSAPP_TOKEN, payload);
    esito.inviato = inv.ok; esito.dettaglio = inv.status + " " + inv.testo;
  } catch (e) { esito.dettaglio = String((e && e.message) || e); }
  try { await h.rpc(env, "agenda_conferma_segna", { p_id: esito.id, p_ok: esito.inviato, p_dettaglio: esito.dettaglio.slice(0, 250) }, 5000); } catch (e) {}
  await h.log(env, tel, null, esito.inviato ? "agenda_conferma" : "agenda_conferma_errore", "#" + esito.id + " · " + esito.dettaglio.slice(0, 250));
  return esito;
}

// Promemoria della sera prima al referente del cantiere (fase 3): lista e testi dal database (agenda_sera_prima_lista,
// solo all'ora impostata e una volta per appuntamento), invio da qui. Lo chiama il database via /admin (pg_cron orario).
export async function agendaSeraPrima(env, forza, h) {
  const esito = { inviati: 0, errori: 0, saltato: "" };
  if (!env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN || env.AGENDA === "off") { esito.saltato = "configurazione"; return esito; }
  const cfg = await h.config(env);
  if (!cfg.phone_number_id) { esito.saltato = "phone_number_id"; return esito; }
  let lista = [];
  try { lista = await h.rpc(env, "agenda_sera_prima_lista", { p_forza: forza === true }, 10000); }
  catch (e) { esito.saltato = "lista: " + String((e && e.message) || e); return esito; }
  for (const r of (Array.isArray(lista) ? lista : []).slice(0, 100)) {
    const tel = String(r.telefono || "").replace(/[^0-9]/g, "");
    if (!tel || !r.payload || typeof r.payload !== "object") continue;
    const payload = r.payload;
    payload.messaging_product = "whatsapp";
    payload.to = tel;
    let ok = false, dettaglio = "";
    try { const inv = await h.invia(cfg.phone_number_id, env.WHATSAPP_TOKEN, payload); ok = inv.ok; dettaglio = inv.status + " " + inv.testo; }
    catch (e) { dettaglio = String((e && e.message) || e); }
    if (ok) esito.inviati++; else esito.errori++;
    try { await h.rpc(env, "agenda_avviso_segna", { p_id: Number(r.id), p_telefono: tel, p_livello: "sera_prima", p_versione: Number(r.versione) || 1, p_ok: ok, p_dettaglio: dettaglio.slice(0, 250) }, 5000); } catch (e) {}
    await h.log(env, tel, null, ok ? "agenda_sera_prima" : "agenda_sera_prima_errore", "#" + r.id + " · " + dettaglio.slice(0, 250));
  }
  return esito;
}

// Risposta ai pulsanti [Giusto]/[Correggi] (id «AG_OK_<n>» / «AG_NO_<n>»): la registra il database (agenda_risposta),
// la risposta parte da qui, il pacchetto NON va a Make. Ritorna true se preso in carico.
export function agendaIdPulsante(msg) {
  if (!msg || msg.type !== "interactive" || !msg.interactive) return "";
  const it = msg.interactive;
  const id = String((it.button_reply && it.button_reply.id) || (it.list_reply && it.list_reply.id) || "");
  return /^AG_(OK|NO)_[0-9]+$/.test(id) ? id : "";
}

export async function agendaRispostaGestisci(msg, value, env, h) {
  const id = agendaIdPulsante(msg);
  const tel = String(msg.from || "");
  const phoneId = (value.metadata && value.metadata.phone_number_id) || "";
  if (!id || !tel || !phoneId || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN || env.AGENDA === "off") return false;
  const r = await h.rpc(env, "agenda_risposta", { p_telefono: tel, p_id_pulsante: id }, 6000);
  if (!r || r.esito === "non_mio" || r.esito === "errore") return false;
  if (r.testo) {
    try {
      await h.invia(phoneId, env.WHATSAPP_TOKEN, {
        messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "text",
        context: { message_id: msg.id }, text: { body: String(r.testo).slice(0, 1000), preview_url: false }
      });
    } catch (e) {}
  }
  await h.log(env, tel, msg.id, "agenda_risposta", id + " → " + String(r.esito));
  return true;
}

// Azioni di amministrazione (POST /admin, chiave gia' verificata da chi chiama).
export async function agendaAdmin(azione, corpo, env, h) {
  if (azione === "agenda_avvisa") {
    const r = await agendaAvvisa(env, corpo.id, corpo.forza === true, h);
    return { ok: true, esito: r };
  }
  if (azione === "agenda_conferma") {
    const r = await agendaConferma(env, corpo.id, h);
    return { ok: true, esito: r };
  }
  if (azione === "agenda_sera_prima") {
    const r = await agendaSeraPrima(env, corpo.forza === true, h);
    return { ok: true, esito: r };
  }
  // Modelli Meta (per avvisare anche chi non ha scritto nelle ultime 24 ore): creazione e lettura.
  if (azione === "template_lista") {
    if (!corpo.waba_id) return { errore: "waba_id mancante", stato: 400 };
    return await h.graph(env.WHATSAPP_TOKEN, String(corpo.waba_id) + "/message_templates?fields=name,status,category,language,components,rejected_reason&limit=50");
  }
  if (azione === "template_crea") {
    if (!corpo.waba_id || !corpo.modello || typeof corpo.modello !== "object") return { errore: "waba_id e modello obbligatori", stato: 400 };
    return await h.graph(env.WHATSAPP_TOKEN, String(corpo.waba_id) + "/message_templates", "POST", corpo.modello);
  }
  return null;
}

// ---------------------------------------------------------------------------- pagina e azioni
function json(o, stato) {
  return new Response(JSON.stringify(o), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

async function leggiCorpo(request) {
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return { errore: 415 };
  try {
    const t = await request.text();
    if (t.length > 6000) return { errore: 413 };
    const b = JSON.parse(t);
    return b && typeof b === "object" ? b : { errore: 400 };
  } catch (e) { return { errore: 400 }; }
}

function pulisciDati(d) {
  const o = {};
  if (!d || typeof d !== "object") return o;
  const s = (k, n) => { if (d[k] !== undefined && d[k] !== null) o[k] = String(d[k]).slice(0, n); };
  s("giorno", 10); s("ora", 5); s("ora_fine", 5); s("tipo", 20); s("titolo", 140); s("note", 600); s("motivo", 200);
  for (const k of ["avvisa", "visibile_cliente", "avviso_sera_prima", "valore"]) if (typeof d[k] === "boolean") o[k] = d[k];
  return o;
}

export async function portaleAgenda(request, env, base, inUrl, h) {
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length);
  // Calendario del cantiere (fase 3): /agenda/ics/<chiave>.ics — chiave propria del cantiere (commesse.agenda_ics_chiave),
  // mai il gettone del portale. Si aggiunge a Google Calendar / Samsung Calendar come calendario da URL.
  const mIcs = /^\/agenda\/ics\/([0-9a-f]{32})\.ics$/.exec(sotto);
  if (mIcs) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const ics = await h.rpc(env, "agenda_ics", { p_chiave: mIcs[1] }, 15000).catch(() => null);
    if (typeof ics !== "string" || !ics) return new Response("Not Found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : ics, { status: 200, headers: {
      "Content-Type": "text/calendar; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
      "Content-Disposition": 'inline; filename="agenda-cantiere.ics"' } });
  }
  if (sotto === "/agenda/crea" || sotto === "/agenda/azione") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    const b = await leggiCorpo(request);
    if (b.errore) return json({ esito: "errore" }, b.errore);
    const tok = String(b.t || "").toLowerCase();
    if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
    if (sotto === "/agenda/crea") {
      const c = String(b.c || "").toLowerCase();
      if (!UUID.test(c)) return json({ esito: "errore" }, 400);
      const r = await h.rpc(env, "agenda_crea", { p_token: tok, p_commessa: c, p_dati: pulisciDati(b.dati) }, 15000).catch(() => null);
      if (!r) return json({ esito: "incerto" });
      if (r.esito !== "ok") return json({ esito: String(r.esito), messaggio: r.messaggio || "" });
      // gli avvisi partono subito da qui (il database li avrebbe comunque chiesti via /admin: non si duplicano)
      let avvisi = null;
      try { avvisi = await agendaAvvisa(env, r.id, false, h); } catch (e) { avvisi = null; }
      let riga = null;
      try { riga = await h.rpc(env, "agenda_contesto", { p_token: tok, p_commessa: c }, 10000); } catch (e) {}
      const fuori = riga && Array.isArray(riga.appuntamenti) ? (riga.appuntamenti.find((x) => Number(x.id) === Number(r.id)) || {}).avvisi_no : null;
      return json({ esito: "ok", id: r.id, inviati: avvisi ? avvisi.inviati : null, errori: avvisi ? avvisi.errori : null, fuori_finestra: fuori == null ? null : Number(fuori) });
    }
    const id = Number(b.id);
    const az = String(b.azione || "");
    if (!Number.isInteger(id) || id <= 0 || ["sposta", "annulla", "avvenuto", "riapri", "cliente", "aggiorna"].indexOf(az) === -1) return json({ esito: "errore" }, 400);
    const r = await h.rpc(env, "agenda_modifica", { p_token: tok, p_id: id, p_azione: az, p_dati: pulisciDati(b.dati) }, 15000).catch(() => null);
    if (!r) return json({ esito: "incerto" });
    if (r.esito !== "ok") return json({ esito: String(r.esito), messaggio: r.messaggio || "" });
    let avvisi = null;
    if (az === "sposta" || az === "annulla") { try { avvisi = await agendaAvvisa(env, id, false, h); } catch (e) {} }
    return json({ esito: "ok", id, inviati: avvisi ? avvisi.inviati : null });
  }
  if (sotto !== "/agenda") return new Response("Not Found", { status: 404 });
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  const torna = base + "/?t=" + tok;
  const indietro = '<p class="piede"><a href="' + torna + '">&larr; Torna ai cantieri</a></p>';
  if (!UUID.test(c)) return Response.redirect(inUrl.origin + torna, 303);
  const d = await h.rpc(env, "agenda_contesto", { p_token: tok, p_commessa: c }, 15000).catch(() => null);
  if (!d) {
    return h.risposta(h.foglio(base, "Agenda", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>' + indietro), 503);
  }
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return Response.redirect(inUrl.origin + torna, 303);
  return new Response(metodo === "HEAD" ? null : paginaAgenda(base, tok, c, d, Object.assign({ origine: inUrl.origin }, h)), { status: 200, headers: h.headers() });
}

// ---------------------------------------------------------------------------- pagina
function giornoIt(iso) {
  const p = String(iso || "").split("-");
  if (p.length !== 3) return "";
  const dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  const nomi = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
  return nomi[dt.getUTCDay()] + " " + p[2] + "/" + p[1] + "/" + p[0];
}

function rigaApp(x, e, oggi) {
  const st = String(x.stato || "");
  const passato = String(x.giorno || "") < oggi;
  const pill = st === "spostato" ? '<span class="pl mov">spostato</span>' : st === "annullato" ? '<span class="pl ann">annullato</span>' :
    st === "avvenuto" ? '<span class="pl ok">avvenuto</span>' : "";
  const ora = x.tutto_il_giorno ? "giorno" : e(x.ora || "");
  const fine = x.ora_fine ? '<small>fino ' + e(x.ora_fine) + "</small>" : "";
  const note = x.note ? '<div class="n">' + e(x.note) + "</div>" : "";
  const nAv = Number(x.avvisi_ok) || 0, nNo = Number(x.avvisi_no) || 0;
  let avv = "";
  if (x.avvisa === false) avv = "senza avviso";
  else if (nAv || nNo) avv = "avvisi: " + nAv + " inviat" + (nAv === 1 ? "o" : "i") + (nNo ? ", " + nNo + " da recapitare" : "");
  const k = [TIPI[x.tipo] || "Altro", x.origine === "whatsapp_ai" ? "da WhatsApp" : "", x.autore && x.autore !== "ufficio" ? e(x.autore) : "",
    x.visibile_cliente ? "visibile al cliente" : "", avv].filter(Boolean).join(" · ");
  const attivo = st !== "annullato" && st !== "avvenuto";
  const bott = '<div class="az">' +
    (st !== "annullato" ? '<button type="button" data-az="sposta" data-id="' + x.id + '" data-g="' + e(x.giorno) + '" data-o="' + e(x.ora) + '" data-f="' + e(x.ora_fine) + '">Sposta</button>' : "") +
    (attivo ? '<button type="button" data-az="avvenuto" data-id="' + x.id + '">Avvenuto</button>' : "") +
    (attivo ? '<button type="button" class="rosso" data-az="annulla" data-id="' + x.id + '">Annulla</button>' : "") +
    (!attivo ? '<button type="button" data-az="riapri" data-id="' + x.id + '">Riapri</button>' : "") +
    '<button type="button" data-az="cliente" data-id="' + x.id + '" data-v="' + (x.visibile_cliente ? "0" : "1") + '">' + (x.visibile_cliente ? "Nascondi al cliente" : "Mostra al cliente") + "</button>" +
    "</div>";
  return '<div class="ag' + (st === "annullato" ? " ann" : "") + (passato ? " pass" : "") + '" data-id="' + x.id + '" data-titolo="' + e(x.titolo) + '">' +
    '<div class="o">' + ora + fine + '</div><div class="corpo"><div class="t">' + e(x.titolo) + pill + "</div>" + note +
    '<div class="k">' + k + "</div>" + bott + "</div></div>";
}

function inUrlOrigin(h) { return h.origine || "https://app.ilgiornalelavori.it"; }

export function paginaAgenda(base, tok, c, d, h) {
  const e = h.esc;
  const oggi = String(d.oggi || "");
  const torna = base + "/?t=" + tok + "&c=" + c + "#a";
  const cant = d.cantiere || {};
  const app = Array.isArray(d.appuntamenti) ? d.appuntamenti : [];
  const logoImpresa = d.logo_impresa
    ? '<div class="dx"><div class="logo-impresa"><img src="' + e(d.logo_impresa) + '" alt="' + e(d.azienda_nome) + '"></div></div>'
    : '<div class="dx"></div>';
  let futuri = "", passati = "", g = null, nf = 0, np = 0;
  for (const x of app) {
    const giorno = String(x.giorno || "");
    if (giorno < oggi) { np++; passati += rigaApp(x, e, oggi); continue; }
    nf++;
    if (giorno !== g) {
      g = giorno;
      futuri += '<div class="tit">' + (giorno === oggi ? "Oggi" : e(giornoIt(giorno))) + "</div>";
    }
    futuri += rigaApp(x, e, oggi);
  }
  if (!nf) futuri = '<div class="vuoto">Nessun appuntamento in programma. Tocca «Nuovo appuntamento» per segnare una consegna, un fornitore, un sopralluogo o un collaudo: chi lavora in cantiere lo riceve su WhatsApp.</div>';
  const persone = Number(d.persone_n) || 0;
  const avvisoChi = persone ? persone + (persone === 1 ? " persona registrata" : " persone registrate") : "nessuna persona registrata";
  const dati = JSON.stringify({ base: base, t: tok, c: c, oggi: oggi, chiuso: d.chiuso === true }).replace(/</g, "\\u003c");
  const opzTipo = Object.keys(TIPI).map((k) => '<option value="' + k + '">' + TIPI[k] + "</option>").join("");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>Agenda - " + e(cant.nome || "") + "</title>" + h.testa(base) +
    "<style>" + STILE + "</style></head><body>" +
    "<header>" + (d.logo_html || '<div class="marchio">Il Giornale Lavori</div>') +
    '<div class="centro"><h1>Agenda</h1><p>' + e(cant.nome || "") + (cant.ubicazione ? " &middot; " + e(cant.ubicazione) : "") + "</p></div>" + logoImpresa + "</header>" +
    '<main><a class="indietro" href="' + torna + '">&larr; Torna al cantiere</a>' +
    (d.chiuso ? '<div class="avviso">Cantiere chiuso: l\'agenda resta consultabile, non si aggiungono appuntamenti.</div>' : "") +
    (d.chiuso ? "" : '<button type="button" class="ag-btn" id="ag-nuovo"><span class="ic">' + AGENDA_ICONA + "</span>Nuovo appuntamento</button>") +
    (d.avvisi_attivi === false ? '<p class="nota">Gli avvisi WhatsApp sono spenti in questo momento: gli appuntamenti restano in agenda.</p>' : "") +
    futuri +
    (np ? '<details class="pass-box"><summary>Appuntamenti passati (ultimi 30 giorni): ' + np + "</summary>" + passati + "</details>" : "") +
    (d.ics_chiave && /^[0-9a-f]{32}$/.test(String(d.ics_chiave)) ?
      '<details class="ics-box"><summary>&#128198; Aggiungi questa agenda al tuo calendario</summary>' +
      '<p>Questo indirizzo è un calendario che si aggiorna da solo (formato ICS). In Google Calendar: <b>Altri calendari → + → Da URL</b>; sul telefono Samsung o iPhone: <b>Aggiungi calendario da URL / Calendario con sottoscrizione</b>.</p>' +
      '<div class="ics-riga"><input type="text" readonly id="ics-url" value="' + e(inUrlOrigin(h) + base + "/agenda/ics/" + d.ics_chiave + ".ics") + '"><button type="button" id="ics-copia">Copia</button></div>' +
      '<p class="piccolo">Chi ha questo indirizzo vede gli appuntamenti del cantiere: condividilo solo con chi deve averli.</p></details>' : "") +
    '<p class="nota">Ogni appuntamento arriva su WhatsApp a chi lavora in questo cantiere (' + avvisoChi + '), nella sua lingua. ' +
    'Chi non ha scritto al Giornale Lavori nelle ultime 24 ore lo riceve con il messaggio del mattino del giorno stesso.</p>' +
    "<noscript><p class=\"nota\"><b>Per aggiungere o modificare gli appuntamenti serve JavaScript attivo nel browser.</b></p></noscript>" +
    "</main>" +
    // modulo nuovo / sposta
    '<dialog id="ag-dlg" aria-labelledby="ag-tit"><form method="dialog" id="ag-form">' +
    '<div class="dl-t"><h2 id="ag-tit">Nuovo appuntamento</h2><p id="ag-sub">' + e(cant.nome || "") + "</p></div>" +
    '<div class="dl-c">' +
    '<div class="riga2"><label>Giorno<input type="date" id="f-g" required min="' + e(oggi) + '"></label>' +
    '<label>Ora <small>(vuota = tutto il giorno)</small><input type="time" id="f-o" step="300"></label></div>' +
    '<div class="riga2"><label>Fine <small>(facoltativa)</small><input type="time" id="f-f" step="300"></label>' +
    '<label id="l-tipo">Tipo<select id="f-tipo">' + opzTipo + "</select></label></div>" +
    '<label id="l-titolo">Cosa succede<input type="text" id="f-t" maxlength="140" placeholder="es. Consegna solaio – autotrasportatore" required></label>' +
    '<label id="l-note">Note <small>(facoltative)</small><textarea id="f-n" maxlength="600" rows="2" placeholder="es. serve la gru, tenere libero il piazzale"></textarea></label>' +
    '<div id="l-opz" class="opz">' +
    '<label class="ck"><input type="checkbox" id="f-avv" checked> Avvisa su WhatsApp chi lavora in cantiere (' + e(avvisoChi) + ")</label>" +
    '<label class="ck"><input type="checkbox" id="f-cli"> Visibile anche al cliente</label>' +
    '<label class="ck"><input type="checkbox" id="f-sera"> Promemoria la sera prima al referente</label>' +
    "</div>" +
    '<p class="msg" id="ag-msg" aria-live="polite"></p></div>' +
    '<div class="dl-b"><button type="button" class="no" id="ag-no">Annulla</button><button type="submit" class="si" id="ag-si">Segna in agenda</button></div>' +
    "</form></dialog>" +
    "<script>var GL_AG=" + dati + ";" + SCRIPT + "</script></body></html>";
}

const STILE =
  ":root{--accento:#0A7D48;--bordo:#d5dcd8;--sfondo:#F4F6F5;--ar:#C27A12;--ar-s:#8A4A06;--ar-c:#FFF7EA;--ar-b:#F1D7AE}" +
  '*{box-sizing:border-box}body{margin:0;padding:0 0 40px;background:var(--sfondo);color:#111;line-height:1.45;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
  "header{background:#052A21;color:#fff;padding:16px 20px 18px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;column-gap:16px}" +
  "header .logo{display:block;height:44px;width:auto}header .marchio{font-weight:800;font-size:1.05rem}" +
  "header .centro{grid-column:2;grid-row:1;text-align:center}header .centro p{margin:4px 0 0;font-size:.88rem;opacity:.9}" +
  "@keyframes gl-argento{0%{background-position:0% 50%}100%{background-position:100% 50%}}" +
  "header h1{margin:0;font-size:clamp(1.4rem,3vw,1.9rem);letter-spacing:-.01em;background:linear-gradient(90deg,#9AA6AB 0%,#E9EEF0 22%,#FFFFFF 38%,#C9D3D6 55%,#F4F7F8 72%,#9AA6AB 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent}" +
  "@media (prefers-reduced-motion:no-preference){header h1{animation:gl-argento 3.5s ease-in-out infinite alternate}}" +
  "header .dx{grid-column:3;grid-row:1;justify-self:end}" +
  "header .logo-impresa{display:inline-block;background:#fff;border-radius:12px;padding:8px 14px;box-shadow:0 2px 10px rgba(0,0,0,.12)}" +
  "header .logo-impresa img{display:block;height:52px;width:auto;max-width:240px;object-fit:contain}" +
  "@media (max-width:640px){header{grid-template-columns:1fr auto}header .centro{grid-column:1/-1;grid-row:2;margin-top:12px}header .dx{grid-column:2}header .logo{height:36px}header .logo-impresa img{height:40px}}" +
  "main{max-width:620px;margin:0 auto;padding:16px 16px 0}" +
  "a.indietro{display:inline-flex;align-items:center;min-height:44px;padding:0 12px 0 0;margin:-8px 0 4px;font-size:.95rem;color:var(--accento);text-decoration:none}" +
  ".avviso{background:#fff;border-left:4px solid var(--ar);border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:.92rem}" +
  ".ag-btn{display:flex;width:100%;align-items:center;justify-content:center;gap:10px;min-height:54px;margin:0 0 16px;border:0;border-radius:12px;background:var(--ar);color:#fff;font:inherit;font-weight:700;font-size:1.02rem;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15)}" +
  ".ag-btn .ic{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center}.ag-btn svg{width:20px;height:20px}" +
  ".tit{font-size:.92rem;color:var(--ar-s);font-weight:700;margin:12px 0 8px;padding-bottom:4px;border-bottom:2px solid var(--ar)}" +
  ".ag{background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:10px 14px;margin-bottom:8px;display:grid;grid-template-columns:64px minmax(0,1fr);gap:10px;align-items:start}" +
  ".ag .o{font-weight:700;font-variant-numeric:tabular-nums;color:var(--ar);font-size:1.05rem}.ag .o small{display:block;font-weight:400;font-size:.72rem;color:#555}" +
  ".ag .t{font-weight:700;overflow-wrap:anywhere}.ag .n{font-size:.86rem;color:#444;white-space:pre-line;margin-top:2px}.ag .k{font-size:.74rem;color:#4A524E;margin-top:3px}" +
  ".ag.pass{opacity:.65}.ag.ann .t{text-decoration:line-through}" +
  ".pl{display:inline-block;border-radius:999px;padding:0 8px;font-size:.72rem;font-weight:700;margin-left:6px;vertical-align:middle}" +
  ".pl.ok{background:#E3F3EA;color:#0B5E37}.pl.ann{background:#fdeaea;color:#8c1d18}.pl.mov{background:#FFF4DC;color:#7A5300}" +
  ".az{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.az button{min-height:36px;padding:0 12px;border-radius:8px;border:1px solid var(--bordo);background:#fff;color:#23302A;font:inherit;font-size:.84rem;font-weight:600;cursor:pointer}" +
  ".az button.rosso{color:#8c1d18;border-color:#f0c9c6}.az button:disabled{opacity:.5}" +
  ".vuoto{background:#fff;border:1px dashed #B9C3BE;border-radius:12px;padding:16px;color:#4A524E;font-size:.92rem}" +
  "details.pass-box{margin-top:16px}details.pass-box summary{cursor:pointer;color:#4A524E;font-size:.9rem;margin-bottom:8px}" +
  ".nota{font-size:.82rem;color:#5b6560;margin:16px 2px 0;line-height:1.5}" +
  "details.ics-box{margin-top:18px;background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:10px 14px}details.ics-box summary{cursor:pointer;font-weight:700;color:var(--accento)}" +
  "details.ics-box p{font-size:.86rem;color:#444;margin:8px 0}.ics-riga{display:flex;gap:8px}.ics-riga input{flex:1;min-width:0;font:inherit;font-size:.82rem;padding:8px 10px;border:1px solid var(--bordo);border-radius:8px;background:#F4F6F5;color:#111}" +
  ".ics-riga button{min-height:38px;padding:0 14px;border-radius:8px;border:1px solid var(--accento);background:#fff;color:var(--accento);font:inherit;font-weight:700;cursor:pointer}.piccolo{font-size:.78rem!important;color:#5b6560!important}" +
  "dialog{border:0;border-radius:16px;padding:0;width:min(480px,calc(100vw - 24px));max-height:calc(100vh - 24px);box-shadow:0 18px 50px rgba(0,0,0,.28);color:#111}" +
  "dialog::backdrop{background:rgba(5,20,15,.55)}dialog form{margin:0}" +
  ".dl-t{background:var(--ar-c);border-bottom:1px solid var(--ar-b);padding:14px 18px 10px}" +
  ".dl-t h2{margin:0;font-size:1.1rem;color:var(--ar-s)}.dl-t p{margin:4px 0 0;font-size:.9rem;color:#4A524E;overflow-wrap:anywhere}" +
  ".dl-c{padding:12px 18px 2px}.dl-c label{display:block;font-weight:600;font-size:.9rem;margin:8px 0 0}.dl-c label small{font-weight:400;color:#666}" +
  ".dl-c input,.dl-c select,.dl-c textarea{display:block;width:100%;margin-top:4px;font:inherit;font-size:1rem;padding:10px;border:1px solid var(--bordo);border-radius:10px;background:#fff;color:#111}" +
  ".riga2{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media (max-width:420px){.riga2{grid-template-columns:1fr}}" +
  ".opz{margin-top:10px}.ck{display:flex;align-items:flex-start;gap:8px;font-weight:500;font-size:.9rem;margin:6px 0 0}.ck input{width:auto;margin:3px 0 0;display:inline-block}" +
  ".msg{font-size:.88rem;margin:10px 0 0;min-height:1.2em}.msg.ko{color:#8c1d18;font-weight:600}.msg.ok{color:#0B5E37;font-weight:600}.msg:empty{display:none}" +
  ".dl-b{display:flex;gap:10px;padding:14px 18px 18px}" +
  ".dl-b button{flex:1;min-height:46px;font:inherit;font-weight:700;font-size:1rem;border-radius:10px;cursor:pointer}" +
  ".dl-b .no{background:#fff;color:#333;border:1px solid #c9d1cc}.dl-b .si{background:var(--ar);color:#fff;border:1px solid var(--ar)}.dl-b .si:disabled{opacity:.5;cursor:wait}";

const SCRIPT = String.raw`(function(){try{
var D=GL_AG,dlg=document.getElementById('ag-dlg'),form=document.getElementById('ag-form');
if(!dlg||typeof dlg.showModal!=='function'){var nb=document.getElementById('ag-nuovo');if(nb)nb.disabled=true;
 var bs0=document.querySelectorAll('.az button');for(var i0=0;i0<bs0.length;i0++)bs0[i0].disabled=true;
 var nt=document.querySelector('.nota');if(nt)nt.insertAdjacentHTML('beforebegin','<p class="nota"><b>Questo browser non mostra il modulo: aggiornalo o usa un altro browser.</b></p>');return;}
var tit=document.getElementById('ag-tit'),sub=document.getElementById('ag-sub'),msg=document.getElementById('ag-msg'),no=document.getElementById('ag-no'),si=document.getElementById('ag-si');
var fg=document.getElementById('f-g'),fo=document.getElementById('f-o'),ff=document.getElementById('f-f'),ft=document.getElementById('f-t'),fn=document.getElementById('f-n'),ftipo=document.getElementById('f-tipo'),
 favv=document.getElementById('f-avv'),fcli=document.getElementById('f-cli'),fsera=document.getElementById('f-sera');
var modo='nuovo',cur=null,occupato=false,fatto=false;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function m(cl,t){msg.className='msg '+cl;msg.textContent=t;}
function mostra(id,v){var el=document.getElementById(id);if(el)el.style.display=v?'':'none';}
function post(p,corpo){return fetch(D.base+'/agenda/'+p,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(corpo)}).then(function(r){return r.json();});}
function apriNuovo(){modo='nuovo';cur=null;fatto=false;tit.textContent='Nuovo appuntamento';sub.textContent=document.querySelector('header .centro p').textContent;
 fg.value=D.oggi;fo.value='';ff.value='';ft.value='';fn.value='';ftipo.value='consegna';favv.checked=true;fcli.checked=false;fsera.checked=false;
 ['l-tipo','l-titolo','l-note','l-opz'].forEach(function(k){mostra(k,true);});ft.required=true;si.textContent='Segna in agenda';si.disabled=false;no.disabled=false;m('','');dlg.showModal();setTimeout(function(){try{fg.focus();}catch(x){}},50);}
function apriSposta(b){modo='sposta';cur=b.getAttribute('data-id');fatto=false;var r=b.closest('.ag');tit.textContent='Sposta l’appuntamento';sub.textContent=r?r.getAttribute('data-titolo'):'';
 fg.value=b.getAttribute('data-g')||D.oggi;fo.value=b.getAttribute('data-o')||'';ff.value=b.getAttribute('data-f')||'';
 ['l-tipo','l-titolo','l-note','l-opz'].forEach(function(k){mostra(k,false);});ft.required=false;si.textContent='Sposta e avvisa';si.disabled=false;no.disabled=false;m('','');dlg.showModal();}
form.addEventListener('submit',function(ev){ev.preventDefault();if(occupato)return;
 if(!fg.value){m('ko','Indica il giorno.');return;}
 if(modo==='nuovo'&&!ft.value.trim()){m('ko','Scrivi cosa succede.');return;}
 if(fo.value&&ff.value&&ff.value<=fo.value){m('ko','L’ora di fine deve venire dopo l’inizio.');return;}
 occupato=true;si.disabled=true;no.disabled=true;m('','Un momento…');
 var pr;
 if(modo==='nuovo'){pr=post('crea',{t:D.t,c:D.c,dati:{giorno:fg.value,ora:fo.value,ora_fine:ff.value,tipo:ftipo.value,titolo:ft.value.trim(),note:fn.value.trim(),avvisa:favv.checked,visibile_cliente:fcli.checked,avviso_sera_prima:fsera.checked}});}
 else{pr=post('azione',{t:D.t,id:Number(cur),azione:'sposta',dati:{giorno:fg.value,ora:fo.value,ora_fine:ff.value}});}
 pr.then(function(j){occupato=false;no.disabled=false;
  if(j.esito==='ok'){fatto=true;var t=modo==='nuovo'?'Segnato in agenda.':'Spostato.';
   if(typeof j.inviati==='number'){t+=' Avvisi WhatsApp inviati: '+j.inviati+(j.fuori_finestra?' · da recapitare al mattino: '+j.fuori_finestra:'')+'.';}
   m('ok',t);si.hidden=true;no.textContent='Chiudi';return;}
  if(j.esito==='gettone'){location.href=D.base+'/';return;}
  if(j.esito==='gia'){fatto=true;m('ok','Era già così.');si.hidden=true;no.textContent='Chiudi';return;}
  if(j.esito==='chiuso'){m('ko','Il cantiere è chiuso.');si.disabled=false;return;}
  if(j.esito==='incerto'){m('ko','Non ho avuto risposta: ricarica la pagina tra un minuto per vedere se è stato salvato.');si.disabled=false;return;}
  m('ko',j.messaggio||'Non sono riuscito a salvare: riprova tra poco.');si.disabled=false;
 }).catch(function(){occupato=false;no.disabled=false;si.disabled=false;m('ko','Il servizio non risponde: controlla la connessione e riprova.');});
});
no.addEventListener('click',function(){if(occupato)return;dlg.close();});
dlg.addEventListener('cancel',function(ev){if(occupato)ev.preventDefault();});
dlg.addEventListener('close',function(){var f=fatto;fatto=false;si.hidden=false;no.textContent='Annulla';if(f)location.reload();});
var nb=document.getElementById('ag-nuovo');if(nb)nb.addEventListener('click',apriNuovo);
function azione(b){var az=b.getAttribute('data-az'),id=Number(b.getAttribute('data-id')),r=b.closest('.ag'),titolo=r?r.getAttribute('data-titolo'):'';
 if(az==='sposta'){apriSposta(b);return;}
 var dati={};
 if(az==='annulla'){if(!confirm('Annullare «'+titolo+'»? Chi lavora in cantiere riceve l’avviso su WhatsApp.'))return;}
 if(az==='cliente'){dati.valore=b.getAttribute('data-v')==='1';}
 var bs=r?r.querySelectorAll('.az button'):[];for(var i=0;i<bs.length;i++)bs[i].disabled=true;
 post('azione',{t:D.t,id:id,azione:az,dati:dati}).then(function(j){
  if(j.esito==='ok'||j.esito==='gia'){location.reload();return;}
  if(j.esito==='gettone'){location.href=D.base+'/';return;}
  alert(j.messaggio||'Non sono riuscito a salvare: riprova tra poco.');for(var i=0;i<bs.length;i++)bs[i].disabled=false;
 }).catch(function(){alert('Il servizio non risponde: riprova tra poco.');for(var i=0;i<bs.length;i++)bs[i].disabled=false;});}
var tutti=document.querySelectorAll('.az button[data-az]');for(var k=0;k<tutti.length;k++)tutti[k].addEventListener('click',function(){azione(this);});
var ic=document.getElementById('ics-copia');if(ic)ic.addEventListener('click',function(){var u=document.getElementById('ics-url');try{u.select();}catch(x){}
 var fatto=function(){ic.textContent='Copiato';setTimeout(function(){ic.textContent='Copia';},1500);};
 if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u.value).then(fatto,function(){try{document.execCommand('copy');fatto();}catch(x){}});}else{try{document.execCommand('copy');fatto();}catch(x){}}});
window.addEventListener('pageshow',function(ev){if(ev.persisted)location.reload();});
}catch(x){}})();
`;
