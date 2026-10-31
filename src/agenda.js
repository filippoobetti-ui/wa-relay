// ============================================================================
// AGENDA DI CANTIERE — Area riservata + avvisi WhatsApp (14/10/2026)
// Richiesta di Filippo (14/10/2026, 14:07): un'icona nella pagina del cantiere per segnare appuntamenti
// (consegne, fornitori, sopralluoghi…) e un avviso su WhatsApp a chi lavora in quel cantiere. «vai» alle 14:15.
//   GET  /agenda?t=<gettone>&c=<cantiere>          → pagina: appuntamenti del cantiere, modulo «Nuovo appuntamento»
//   POST /agenda/crea   {t, c, dati}                → RPC agenda_crea, poi gli avvisi partono subito da qui
//   POST /agenda/azione {t, id, azione, dati}       → RPC agenda_modifica (sposta, annulla, avvenuto, riapri, cliente, aggiorna)
//                                                     azione «modifica» (29/10/2026) → RPC agenda_modifica_tutto: tutti i dati del modulo
// Gli avvisi: il database decide chi riceve e il testo (agenda_avvisi_lista, nella lingua di ciascuno, una riga per
// persona e versione, mai doppi); qui si spedisce con il token WhatsApp e si segna l'esito (agenda_avviso_segna).
// La stessa funzione la chiama anche il database (trigger → pg_net → POST /admin {azione: agenda_avvisa}) per gli
// appuntamenti nati fuori dal portale (fase 2: lettura AI dai messaggi WhatsApp).
// Fuori dalla finestra gratuita di 24 ore Meta rifiuta i messaggi liberi: il database lo sa e segna «fuori finestra»;
// quelle persone ricevono l'appuntamento nel messaggio del mattino (fase 3) o con un modello approvato da Meta.
// Il relay non conserva nulla. Il nome dell'impresa non compare mai nei messaggi (solo il nome del cantiere).
// ============================================================================

import { cestinoIniezione } from "./cestino.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GETTONE = /^[0-9a-f]{64}$/;
// «Lavorazioni» (22/10/2026, decisioni 1-3 di Filippo): con «Dove» e «Chi»; l'avviso WhatsApp va solo alle persone scelte.
const TIPI = { consegna: "Consegna", fornitore: "Fornitore", sopralluogo: "Sopralluogo", collaudo: "Collaudo", riunione: "Riunione", lavorazione: "Lavorazioni", altro: "Altro" };

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

// Inviti (30/10/2026): id dei contatti della Rubrica scelti nel modulo (al massimo 30); null = elenco non mandato
function invitatiDa(b) {
  return Array.isArray(b && b.invitati) ? b.invitati.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 30) : null;
}

function pulisciDati(d) {
  const o = {};
  if (!d || typeof d !== "object") return o;
  const s = (k, n) => { if (d[k] !== undefined && d[k] !== null) o[k] = String(d[k]).slice(0, n); };
  s("giorno", 10); s("ora", 5); s("ora_fine", 5); s("tipo", 20); s("titolo", 140); s("note", 600); s("motivo", 200);
  s("luogo", 120); s("chi", 200);
  for (const k of ["avvisa", "visibile_cliente", "avviso_sera_prima", "valore"]) if (typeof d[k] === "boolean") o[k] = d[k];
  if (Array.isArray(d.persone)) o.persone = d.persone.map((x) => String(x).toLowerCase()).filter((x) => UUID.test(x)).slice(0, 30);
  // Cronoprogramma (23/10/2026, pacchetto B): attività collegate e, dopo «Avvenuto», com'è andata
  if (Array.isArray(d.attivita)) o.attivita = d.attivita.map((x) => String(x).toLowerCase()).filter((x) => UUID.test(x)).slice(0, 10);
  if (Array.isArray(d.esiti)) {
    o.esiti = d.esiti.filter((x) => x && typeof x === "object" && UUID.test(String(x.attivita_id || "").toLowerCase())).slice(0, 10)
      .map((x) => ({ attivita_id: String(x.attivita_id).toLowerCase(), esito: String(x.esito || "").slice(0, 12), pct: String(x.pct == null ? "" : x.pct).slice(0, 3) }));
  }
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
  // Inviti (30/10/2026, agenda-invitati-1): /agenda/invito/<chiave>.ics — il calendario di un solo appuntamento per un invitato
  // dalla Rubrica (link nella sua email); chiave propria dell'invitato, mai il gettone del portale
  const mInv = /^\/agenda\/invito\/([0-9a-f]{32})\.ics$/.exec(sotto);
  if (mInv) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const ics = await h.rpc(env, "agenda_invito_ics", { p_chiave: mInv[1] }, 15000).catch(() => null);
    if (typeof ics !== "string" || !ics) return new Response("Not Found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : ics, { status: 200, headers: {
      "Content-Type": "text/calendar; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
      "Content-Disposition": 'attachment; filename="appuntamento.ics"' } });
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
      const inv = invitatiDa(b);
      let invRis = null;
      if (inv && inv.length) invRis = await h.rpc(env, "agenda_invitati_imposta", { p_token: tok, p_id: r.id, p_contatti: inv }, 15000).catch(() => null);
      return json({ esito: "ok", id: r.id, inviati: avvisi ? avvisi.inviati : null, errori: avvisi ? avvisi.errori : null, fuori_finestra: fuori == null ? null : Number(fuori),
        inviti: invRis && invRis.esito === "ok" ? invRis.email : null });
    }
    const id = Number(b.id);
    const az = String(b.azione || "");
    if (!Number.isInteger(id) || id <= 0 || ["sposta", "annulla", "avvenuto", "riapri", "cliente", "aggiorna", "crono_esito", "modifica"].indexOf(az) === -1) return json({ esito: "errore" }, 400);
    // «Modifica» (29/10/2026, Filippo): tutti i dati del modulo in un colpo solo. Gli avvisi si chiedono sempre: il database
    // li prepara solo per chi non ha ancora questa versione (giorno o ora cambiati = come «Sposta»; persone aggiunte in «Chi»)
    if (az === "modifica") {
      const r = await h.rpc(env, "agenda_modifica_tutto", { p_token: tok, p_id: id, p_dati: pulisciDati(b.dati) }, 15000).catch(() => null);
      if (!r) return json({ esito: "incerto" });
      // Inviti (30/10/2026): l'elenco degli invitati si salva anche quando il resto è uguale («gia»)
      const inv = invitatiDa(b);
      let invRis = null;
      if (inv && (r.esito === "ok" || r.esito === "gia")) invRis = await h.rpc(env, "agenda_invitati_imposta", { p_token: tok, p_id: id, p_contatti: inv }, 15000).catch(() => null);
      const inviti = invRis && invRis.esito === "ok" ? invRis.email : null;
      if (r.esito === "gia" && inviti) return json({ esito: "ok", id, spostato: false, inviati: null, inviti });
      if (r.esito !== "ok") return json({ esito: String(r.esito), messaggio: r.messaggio || "" });
      let avvisi = null;
      try { avvisi = await agendaAvvisa(env, id, false, h); } catch (e) {}
      return json({ esito: "ok", id, spostato: r.spostato === true, inviati: avvisi ? avvisi.inviati : null, inviti });
    }
    if (az === "crono_esito") {
      const r = await h.rpc(env, "agenda_crono_esito", { p_token: tok, p_id: id, p_dati: pulisciDati(b.dati) }, 15000).catch(() => null);
      return r ? json(r) : json({ esito: "incerto" });
    }
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
  // Inviti (30/10/2026): i contatti della Rubrica dell'impresa con email, per «Invita dalla Rubrica»
  try { const rb = await h.rpc(env, "agenda_inviti_rubrica", { p_token: tok, p_commessa: c }, 8000); if (rb && rb.esito === "ok") d.rubrica = rb.contatti; } catch (e) {}
  let pagina = metodo === "HEAD" ? null : paginaAgenda(base, tok, c, d, Object.assign({ origine: inUrl.origin }, h));
  // Cestino (17/10/2026): pulsante su ogni appuntamento e sezione «Cestino» (src/cestino.js)
  if (pagina && d.chiuso !== true && pagina.lastIndexOf("</body>") !== -1) {
    const i = pagina.lastIndexOf("</body>");
    pagina = pagina.slice(0, i) + cestinoIniezione(base, tok, c) + pagina.slice(i);
  }
  return new Response(pagina, { status: 200, headers: h.headers() });
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
  const note = (x.note ? '<div class="n">' + e(x.note) + "</div>" : "") +
    (x.luogo || x.chi ? '<div class="n">' + [x.luogo ? "📍 " + e(x.luogo) : "", x.chi ? "👷 " + e(x.chi) : ""].filter(Boolean).join(" &middot; ") + "</div>" : "") +
    (Array.isArray(x.attivita) && x.attivita.length ? '<div class="n">📊 ' + x.attivita.map((a) => e(a.nome)).join(", ") + "</div>" : "") +
    (Array.isArray(x.invitati) && x.invitati.length ? '<div class="n">✉️ Invitati: ' + x.invitati.map((i) => e(i.nome)).join(", ") + "</div>" : "");
  const att = Array.isArray(x.attivita) && x.attivita.length ? ' data-att="' + e(JSON.stringify(x.attivita.map((a) => ({ id: a.id, nome: a.nome })))) + '"' : "";
  const nAv = Number(x.avvisi_ok) || 0, nNo = Number(x.avvisi_no) || 0;
  let avv = "";
  if (x.avvisa === false) avv = "senza avviso";
  else if (nAv || nNo) avv = "avvisi: " + nAv + " inviat" + (nAv === 1 ? "o" : "i") + (nNo ? ", " + nNo + " da recapitare" : "");
  const k = [TIPI[x.tipo] || "Altro", x.origine === "whatsapp_ai" ? "da WhatsApp" : "", x.autore && x.autore !== "ufficio" ? e(x.autore) : "",
    x.visibile_cliente ? "visibile al cliente" : "", avv].filter(Boolean).join(" · ");
  const attivo = st !== "annullato" && st !== "avvenuto";
  const bott = '<div class="az">' +
    // «Modifica» (29/10/2026): riapre il modulo già compilato con tutti i dati dell'appuntamento
    (st !== "annullato" ? '<button type="button" data-az="modifica" data-id="' + x.id + '" data-app="' + e(JSON.stringify({ g: x.giorno, o: x.tutto_il_giorno ? "" : x.ora, f: x.ora_fine,
      tipo: TIPI[x.tipo] ? x.tipo : "altro", t: x.titolo, n: x.note, luogo: x.luogo, chi: x.chi_testo == null ? "" : x.chi_testo,
      pers: Array.isArray(x.persone) ? x.persone : [], att: Array.isArray(x.attivita) ? x.attivita.map((a) => a.id) : [],
      avv: x.avvisa !== false, cli: x.visibile_cliente === true, sera: x.avviso_sera_prima === true,
      inv: Array.isArray(x.invitati) ? x.invitati.map((i) => i.id).filter(Boolean) : [] })) + '">Modifica</button>' : "") +
    (st !== "annullato" ? '<button type="button" data-az="sposta" data-id="' + x.id + '" data-g="' + e(x.giorno) + '" data-o="' + e(x.ora) + '" data-f="' + e(x.ora_fine) + '">Sposta</button>' : "") +
    (attivo ? '<button type="button" data-az="avvenuto" data-id="' + x.id + '"' + att + '>Avvenuto</button>' : "") +
    (attivo ? '<button type="button" class="rosso" data-az="annulla" data-id="' + x.id + '">Annulla</button>' : "") +
    (!attivo ? '<button type="button" data-az="riapri" data-id="' + x.id + '">Riapri</button>' : "") +
    '<button type="button" data-az="cliente" data-id="' + x.id + '" data-v="' + (x.visibile_cliente ? "0" : "1") + '">' + (x.visibile_cliente ? "Nascondi al cliente" : "Mostra al cliente") + "</button>" +
    "</div>";
  return '<div class="ag' + (st === "annullato" ? " ann" : "") + (passato ? " pass" : "") + '" data-id="' + x.id + '" data-giorno="' + e(x.giorno) + '" data-titolo="' + e(x.titolo) + '">' +
    '<div class="o">' + ora + fine + '</div><div class="corpo"><div class="t">' + e(x.titolo) + pill + "</div>" + note +
    '<div class="k">' + k + "</div>" + bott + "</div></div>";
}

function inUrlOrigin(h) { return h.origine || "https://app.tixcantiere.it"; }

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
      futuri += '<div class="tit" data-g="' + e(giorno) + '" role="button" tabindex="0" title="Apri la giornata"><span>' + (giorno === oggi ? "Oggi" : e(giornoIt(giorno))) +
        '</span><span class="tit-apri">Apri la giornata ›</span></div>';
    }
    futuri += rigaApp(x, e, oggi);
  }
  if (!nf) futuri = '<div class="vuoto">Nessun appuntamento in programma. Tocca «Nuovo appuntamento» per segnare una consegna, un fornitore, un sopralluogo, un collaudo o le lavorazioni da fare: chi lavora in cantiere lo riceve su WhatsApp.</div>';
  const persone = Number(d.persone_n) || 0;
  const avvisoChi = persone ? persone + (persone === 1 ? " persona registrata" : " persone registrate") : "nessuna persona registrata";
  const crono = Array.isArray(d.crono) ? d.crono : [];
  // Calendario del mese (28/10/2026, Filippo): gli appuntamenti che la pagina già riceve, ridotti a quello che serve alla griglia
  const mese = app.map((x) => ({ id: Number(x.id) || 0, g: String(x.giorno || ""), o: x.tutto_il_giorno ? "" : String(x.ora || ""), f: String(x.ora_fine || ""),
    tipo: TIPI[x.tipo] ? x.tipo : (x.tipo === "lavorazioni" ? "lavorazione" : "altro"), t: String(x.titolo || ""), st: String(x.stato || "") })).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.g));
  const rubrica = (Array.isArray(d.rubrica) ? d.rubrica : []).map((k) => ({ id: Number(k.id) || 0, n: String(k.nome || ""), e: String(k.email || ""), i: String(k.impresa || "") })).filter((k) => k.id);
  const dati = JSON.stringify({ base: base, t: tok, c: c, oggi: oggi, chiuso: d.chiuso === true, crono: crono, mese: mese, tipi: TIPI, rubrica: rubrica }).replace(/</g, "\\u003c");
  // Collega al calendario (30/10/2026, Filippo): pulsanti diretti per Google Calendar, iPhone/Mac e Outlook in cima all'agenda;
  // per gli altri calendari l'indirizzo resta da copiare. Il calendario va in una sola direzione: dall'agenda TIX al telefono.
  const icsUrl = d.ics_chiave && /^[0-9a-f]{32}$/.test(String(d.ics_chiave)) ? inUrlOrigin(h) + base + "/agenda/ics/" + d.ics_chiave + ".ics" : "";
  const webcal = icsUrl.replace(/^https?:\/\//, "webcal://");
  const collega = icsUrl ? '<section class="collega" aria-label="Collega l’agenda al tuo calendario"><div class="collega-t">&#128198; Collega questa agenda al tuo calendario <small>si aggiorna da sola</small></div>' +
    '<div class="collega-b"><a class="cb" href="' + e("https://calendar.google.com/calendar/render?cid=" + encodeURIComponent(webcal)) + '" target="_blank" rel="noopener">Google Calendar</a>' +
    '<a class="cb" href="' + e(webcal) + '">iPhone / Mac</a>' +
    '<a class="cb" href="' + e("https://outlook.live.com/calendar/0/addfromweb?url=" + encodeURIComponent(icsUrl) + "&name=" + encodeURIComponent("Agenda " + (cant.nome || "cantiere"))) + '" target="_blank" rel="noopener">Outlook</a></div>' +
    '<details class="collega-altro"><summary>Altro calendario (Samsung, Outlook aziendale…): copia l’indirizzo</summary>' +
    '<div class="ics-riga"><input type="text" readonly id="ics-url" value="' + e(icsUrl) + '"><button type="button" id="ics-copia">Copia</button></div>' +
    '<p class="piccolo">Incollalo in «Aggiungi calendario da URL» o «Iscriviti a un calendario». Il collegamento va in una sola direzione, dall’agenda TIX al tuo calendario; Google lo aggiorna ogni qualche ora. ' +
    'Chi ha questo indirizzo vede gli appuntamenti del cantiere: condividilo solo con chi deve averli.</p></details></section>' : "";
  // «Lavorazioni» prima voce del Tipo e scelta di partenza del nuovo appuntamento (29/10/2026, Filippo);
  // la legenda del calendario resta nell'ordine di TIPI
  const opzTipo = ["lavorazione"].concat(Object.keys(TIPI).filter((k) => k !== "lavorazione")).map((k) => '<option value="' + k + '">' + TIPI[k] + "</option>").join("");
  const pers = Array.isArray(d.persone) ? d.persone : [];
  const sceltaChi = pers.length
    ? pers.map((p) => '<label class="pc"><input type="checkbox" class="f-pers" value="' + e(p.id) + '"> ' + e(p.nome) + "</label>").join("")
    : '<p class="piccolo">Nessuna persona registrata: scrivi qui sotto la squadra o l’impresa.</p>';
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>Agenda - " + e(cant.nome || "") + "</title>" + h.testa(base) +
    "<style>" + STILE + "</style></head><body>" +
    "<header>" + (d.logo_html || '<div class="marchio">TIX · Diario di cantiere</div>') +
    '<div class="centro"><h1>Agenda</h1><p>' + e(cant.nome || "") + (cant.ubicazione ? " &middot; " + e(cant.ubicazione) : "") + "</p></div>" + logoImpresa + "</header>" +
    '<main><a class="indietro" href="' + torna + '">&larr; Torna al cantiere</a>' +
    (d.chiuso ? '<div class="avviso">Cantiere chiuso: l\'agenda resta consultabile, non si aggiungono appuntamenti.</div>' : "") +
    // Calendario del mese: lo disegna lo script (CALENDARIO); senza JavaScript resta l'elenco qui sotto
    '<section class="cal" id="cal" aria-label="Calendario del mese" hidden></section>' +
    (d.chiuso ? "" : '<button type="button" class="ag-btn" id="ag-nuovo"><span class="ic">' + AGENDA_ICONA + "</span>Nuovo appuntamento</button>") +
    collega +
    (d.avvisi_attivi === false ? '<p class="nota">Gli avvisi WhatsApp sono spenti in questo momento: gli appuntamenti restano in agenda.</p>' : "") +
    futuri +
    (np ? '<details class="pass-box"><summary>Appuntamenti passati (ultimi 30 giorni): ' + np + "</summary>" + passati + "</details>" : "") +
    '<p class="nota">Ogni appuntamento arriva su WhatsApp a chi lavora in questo cantiere (' + avvisoChi + '), nella sua lingua. ' +
    'Chi non ha scritto a TIX nelle ultime 24 ore lo riceve con il messaggio del mattino del giorno stesso. ' +
    'Le «Lavorazioni» arrivano solo alle persone scelte in «Chi».</p>' +
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
    '<label id="l-titolo"><span id="t-titolo">Cosa succede</span><input type="text" id="f-t" maxlength="140" placeholder="es. Consegna solaio – autotrasportatore" required></label>' +
    '<div id="l-lav" style="display:none">' +
    (crono.length ? '<div class="chi-t">Attività del cronoprogramma <small>(facoltativo)</small></div>' +
      '<input type="search" id="f-cr-q" placeholder="Cerca un’attività" autocomplete="off"><div class="cr-l" id="f-cr"></div><p class="cr-avv" id="f-cr-avv"></p>' : "") +
    '<label>Dove <small>(facoltativo)</small><input type="text" id="f-luogo" maxlength="120" placeholder="es. Piano 1, blocco B"></label>' +
    '<div class="chi-t">Chi <small>(le persone scelte ricevono l’avviso)</small></div><div class="chi-l">' + sceltaChi + "</div>" +
    '<label>Altre squadre o imprese <small>(facoltativo)</small><input type="text" id="f-chi" maxlength="200" placeholder="es. Impresa Bianchi, betonpompa"></label>' +
    "</div>" +
    '<label id="l-note">Note <small>(facoltative)</small><textarea id="f-n" maxlength="600" rows="2" placeholder="es. serve la gru, tenere libero il piazzale"></textarea></label>' +
    // Inviti (30/10/2026, Filippo): contatti della Rubrica invitati all'appuntamento, con email e invito al calendario
    '<div id="l-inv"><div class="chi-t">Invita dalla Rubrica <small>(ricevono un’email con l’invito da aggiungere al calendario)</small></div>' +
    (rubrica.length ? '<input type="search" id="f-inv-q" placeholder="Cerca per nome, impresa o email" autocomplete="off"><div class="cr-l" id="f-inv"></div><p class="cr-avv" id="f-inv-sel"></p>'
      : '<p class="piccolo">In Rubrica non ci sono contatti con l’email: aggiungila nella Rubrica per poterli invitare.</p>') + "</div>" +
    '<div id="l-opz" class="opz">' +
    '<label class="ck"><input type="checkbox" id="f-avv" checked> <span id="t-avv" data-tutti="' + e("Avvisa su WhatsApp chi lavora in cantiere (" + avvisoChi + ")") + '">Avvisa su WhatsApp chi lavora in cantiere (' + e(avvisoChi) + ")</span></label>" +
    '<label class="ck"><input type="checkbox" id="f-cli"> Visibile anche al cliente</label>' +
    '<label class="ck"><input type="checkbox" id="f-sera"> Promemoria la sera prima al referente</label>' +
    "</div>" +
    '<p class="msg" id="ag-msg" aria-live="polite"></p></div>' +
    '<div class="dl-b"><button type="button" class="no" id="ag-no">Annulla</button><button type="submit" class="si" id="ag-si">Segna in agenda</button></div>' +
    "</form></dialog>" +
    // «Com'è andata?» dopo «Avvenuto» per le lavorazioni collegate al cronoprogramma (pacchetto B)
    '<dialog id="ag-es" aria-labelledby="es-tit"><form method="dialog" id="es-form">' +
    '<div class="dl-t"><h2 id="es-tit">Com’è andata?</h2><p id="es-sub"></p></div>' +
    '<div class="dl-c"><p class="piccolo">Per ogni attività scegli com’è andata: il cronoprogramma aggiorna le date reali e la percentuale (le date previste non cambiano).</p>' +
    '<div id="es-l"></div><p class="msg" id="es-msg" aria-live="polite"></p></div>' +
    '<div class="dl-b"><button type="button" class="no" id="es-no">Annulla</button><button type="submit" class="si" id="es-si">Segna avvenuto</button></div>' +
    "</form></dialog>" +
    // «Giornata» (30/10/2026): la pagina di un giorno, aperta dal calendario; la riempie lo script con gli appuntamenti dell'elenco
    '<dialog id="ag-gio" aria-labelledby="gio-tit"><div class="dl-t"><h2 id="gio-tit">Giornata</h2><p>' + e(cant.nome || "") + '<span class="gio-n" id="gio-n"></span></p></div>' +
    '<div class="dl-c" id="gio-l"></div>' +
    '<div class="dl-b"><button type="button" class="no" id="gio-no">Chiudi</button>' +
    (d.chiuso ? "" : '<button type="button" class="si" id="gio-nuovo">+ Nuovo appuntamento</button>') + "</div></dialog>" +
    "<script>var GL_AG=" + dati + ";" + CALENDARIO + SCRIPT + "</script></body></html>";
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
  "a.indietro{display:inline-flex;align-items:center;min-height:44px;padding:0 12px 0 0;margin:-8px 0 4px;font-size:.95rem;font-weight:800;color:#0A7D48;text-decoration:none}" +
  ".avviso{background:#fff;border-left:4px solid var(--ar);border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:.92rem}" +
  ".ag-btn{display:flex;width:100%;align-items:center;justify-content:center;gap:10px;min-height:54px;margin:0 0 16px;border:0;border-radius:12px;background:var(--ar);color:#fff;font:inherit;font-weight:700;font-size:1.02rem;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15)}" +
  ".ag-btn .ic{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center}.ag-btn svg{width:20px;height:20px}" +
  ".tit{font-size:.92rem;color:var(--ar-s);font-weight:700;margin:12px 0 8px;padding-bottom:4px;border-bottom:2px solid var(--ar)}" +
  ".tit[data-g]{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer}.tit[data-g]:hover .tit-apri,.tit[data-g]:focus-visible .tit-apri{text-decoration:underline}" +
  ".tit[data-g]:focus-visible{outline:2px solid var(--ar);outline-offset:3px;border-radius:4px}.tit-apri{font-size:.78rem;font-weight:700;color:var(--ar);white-space:nowrap}" +
  ".ag{background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:10px 14px;margin-bottom:8px;display:grid;grid-template-columns:64px minmax(0,1fr);gap:10px;align-items:start}" +
  '@media print{main .ag::before{display:none!important}main .ag{border:1.5px solid #1B2F4A!important}}' +
  '@media print{html body main .ag{border:2px solid transparent!important;background:linear-gradient(#fff,#fff) padding-box,linear-gradient(135deg,#1B2F4A,#F26A10) border-box!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;box-shadow:none!important}}' +
  '@media print{html body main .ag{box-decoration-break:clone;-webkit-box-decoration-break:clone}}' +
  // 30/10/2026 (Filippo, opzione 4): ogni appuntamento contornato da una linea sfumata blu TIX → arancione
  'main .ag{position:relative;border-color:transparent!important}main .ag::before{content:"";position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#F26A10);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}@media (prefers-color-scheme:dark){main .ag::before{background:linear-gradient(135deg,#6F8FBF,#F26A10)}}' +
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
  ".dl-b .no{background:#fff;color:#333;border:1px solid #c9d1cc}.dl-b .si{background:var(--ar);color:#fff;border:1px solid var(--ar)}.dl-b .si:disabled{opacity:.5;cursor:wait}" +
  ".chi-t{font-weight:600;font-size:.9rem;margin:8px 0 0}.chi-t small{font-weight:400;color:#666}.chi-l{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}" +
  ".dl-c .chi-l label.pc{display:inline-flex;align-items:center;gap:6px;margin:0;padding:6px 10px;border:1px solid var(--bordo);border-radius:999px;font-weight:500;font-size:.88rem;background:#fff;cursor:pointer}" +
  ".dl-c .chi-l label.pc input{display:inline-block;width:auto;margin:0}.dl-c .chi-l .piccolo{margin:0}" +
  ".cr-l{max-height:230px;overflow:auto;border:1px solid var(--bordo);border-radius:10px;margin-top:6px;background:#fff}" +
  ".dl-c label.cr-i{display:flex;align-items:flex-start;gap:8px;margin:0;padding:7px 10px;border-bottom:1px solid #EEF0EF;font-weight:500;font-size:.88rem;cursor:pointer}" +
  ".dl-c label.cr-i input{display:inline-block;width:auto;margin:3px 0 0;flex:none}.cr-i small{display:block;color:#5b6560;font-weight:400;font-size:.76rem}.cr-i.sel{background:#FFF7EA}" +
  ".cr-vuoto{padding:8px 10px;font-size:.84rem;color:#5b6560}.cr-avv{font-size:.84rem;color:#7A5300;margin:6px 0 0}.cr-avv:empty{display:none}" +
  "#f-inv{overflow-x:hidden}#f-inv .cr-i span{min-width:0;overflow-wrap:anywhere}" +
  ".es-r{border:1px solid var(--bordo);border-radius:10px;padding:8px 10px;margin:8px 0 0}.es-r b{display:block;font-size:.9rem;overflow-wrap:anywhere}" +
  ".es-r .es-c{display:flex;gap:8px;margin-top:6px}.dl-c .es-r select{flex:1;margin-top:0}.dl-c .es-r input{width:90px;flex:none;margin-top:0}" +
  // ---- calendario del mese (28/10/2026): griglia come Google Calendar, con un colore per tipo di appuntamento
  ".t-consegna{--tc:#F59E0B}.t-fornitore{--tc:#8B5CF6}.t-sopralluogo{--tc:#0EA5E9}.t-collaudo{--tc:#10B981}.t-riunione{--tc:#EC4899}.t-lavorazione{--tc:#F97316}.t-altro{--tc:#64748B}" +
  "@media (min-width:760px){main{max-width:1060px}main>.ag,main>.tit,main>.vuoto,main>details,main>.nota,main>.ag-btn,main>.avviso,main>.collega{max-width:720px;margin-left:auto;margin-right:auto}}" +
  // 31/10/2026 (Filippo): sul computer la pagina è larga fino a 1000 px, come le schede del cantiere
  "@media screen and (min-width:760px){main{max-width:min(1000px,calc(100vw - 48px))}}@media screen and (min-width:900px){main{max-width:min(1000px,calc(100vw - 200px))}}@media screen and (min-width:760px){main>.ag,main>.tit,main>.vuoto,main>details,main>.nota,main>.ag-btn,main>.avviso,main>.collega{max-width:none}}" +
  ".collega{background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:12px 14px;margin:0 0 16px}.collega-t{font-weight:800;color:#23302A;margin:0 0 8px}" +
  ".collega-t small{font-weight:500;color:#5b6560;margin-left:4px}.collega-b{display:flex;flex-wrap:wrap;gap:8px}" +
  ".cb{flex:1 1 150px;display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 14px;border-radius:10px;border:1px solid var(--bordo);background:#fff;color:#23302A;font-weight:700;text-decoration:none}" +
  ".cb:hover,.cb:focus-visible{border-color:var(--ar);color:var(--ar-s)}.collega-altro{margin-top:10px}.collega-altro summary{cursor:pointer;font-size:.86rem;font-weight:700;color:var(--accento)}" +
  ".collega-altro .ics-riga{margin-top:8px}.collega-altro p{font-size:.84rem;color:#444;margin:8px 0 0}" +
  ".cal{position:relative;margin:4px 0 18px;padding:18px 18px 14px;border-radius:24px;background:linear-gradient(180deg,#FFFFFF,#F7F9FB);" +
  "border:1px solid rgba(15,23,42,.08);box-shadow:0 1px 2px rgba(15,23,42,.05),0 24px 48px -28px rgba(15,23,42,.35);overflow:hidden}" +
  ".cal:before{content:'';position:absolute;inset:-40% -10% auto auto;width:60%;height:120%;background:radial-gradient(closest-side,rgba(194,122,18,.10),transparent);pointer-events:none}" +
  ".cal-t{position:relative;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}" +
  ".cal-m{font-size:clamp(1.35rem,3.2vw,1.9rem);font-weight:800;letter-spacing:-.03em;margin:0 auto 0 4px;color:#0F172A}" +
  ".cal-m small{font-weight:600;color:#94A3B8;margin-left:6px}" +
  ".cal-n{display:flex;gap:6px}.cal-n button,.cal-oggi,.cal-piu{min-height:40px;border-radius:12px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#0F172A;font:inherit;font-weight:700;cursor:pointer;transition:transform .15s,box-shadow .15s,background .15s}" +
  ".cal-n button{width:40px;font-size:1.15rem}.cal-oggi{padding:0 14px}.cal-n button:hover,.cal-oggi:hover{box-shadow:0 6px 16px -8px rgba(15,23,42,.4);transform:translateY(-1px)}" +
  ".cal-piu{padding:0 16px;border:0;color:#fff;background:linear-gradient(180deg,#D98A1C,var(--ar));box-shadow:0 10px 22px -10px rgba(194,122,18,.8)}" +
  ".cal-g{position:relative;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}" +
  ".cal-w{font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#94A3B8;text-align:center;padding:2px 0 4px}" +
  ".cal-d{position:relative;min-height:104px;padding:8px 7px 6px;border-radius:16px;background:#fff;border:1px solid rgba(15,23,42,.07);text-align:left;font:inherit;color:inherit;cursor:pointer;" +
  "display:flex;flex-direction:column;gap:3px;transition:transform .18s,box-shadow .18s,border-color .18s;overflow:hidden}" +
  ".cal-d:hover{transform:translateY(-2px);box-shadow:0 14px 28px -18px rgba(15,23,42,.45);border-color:rgba(194,122,18,.35)}" +
  ".cal-d.fuori{background:transparent;border-color:transparent;opacity:.42}.cal-d.fuori:hover{opacity:.7}" +
  ".cal-d.fest{background:#FBFAF7}" +
  ".cal-d.pieno{background:linear-gradient(180deg,#fff,#FFFBF3);border-color:rgba(194,122,18,.22)}" +
  ".cal-d.sel{box-shadow:0 0 0 2px var(--ar),0 16px 30px -18px rgba(194,122,18,.7)}" +
  ".cal-num{display:flex;align-items:center;justify-content:space-between;font-weight:800;font-size:.95rem;color:#334155;font-variant-numeric:tabular-nums}" +
  ".cal-num span{display:inline-grid;place-items:center;min-width:28px;height:28px;border-radius:50%}" +
  ".cal-d.oggi .cal-num span{color:#fff;background:linear-gradient(160deg,#E39A2E,#B86A0B);box-shadow:0 6px 14px -6px rgba(194,122,18,.9)}" +
  ".cal-c{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 7px;border-radius:999px;font-size:.72rem;font-weight:800;color:#fff;" +
  "background:linear-gradient(180deg,#334155,#0F172A);box-shadow:0 4px 10px -4px rgba(15,23,42,.6)}" +
  ".cal-e{display:flex;align-items:center;gap:5px;min-width:0;padding:3px 6px 3px 5px;border-radius:8px;font-size:.72rem;line-height:1.2;font-weight:600;color:#0F172A;" +
  "background:color-mix(in srgb,var(--tc) 14%,#fff);border-left:3px solid var(--tc)}" +
  ".cal-e b{font-weight:800;color:color-mix(in srgb,var(--tc) 70%,#0F172A);flex:none;font-variant-numeric:tabular-nums}" +
  ".cal-e i{font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}" +
  ".cal-e.ann{opacity:.55;text-decoration:line-through}.cal-e.ok{opacity:.7}" +
  ".cal-altri{font-size:.7rem;font-weight:800;color:#64748B;padding-left:4px}" +
  ".cal-pt{display:none;gap:4px;flex-wrap:wrap;margin-top:auto}.cal-pt i{width:8px;height:8px;border-radius:50%;background:var(--tc);box-shadow:0 0 0 2px #fff,0 0 8px var(--tc)}" +
  ".cal-leg{position:relative;display:flex;flex-wrap:wrap;gap:6px 14px;margin:12px 4px 0;font-size:.76rem;color:#475569}" +
  ".cal-leg span{display:inline-flex;align-items:center;gap:6px}.cal-leg span:before{content:'';width:10px;height:10px;border-radius:3px;background:var(--tc)}" +
  ".cal-gi{position:relative;margin-top:14px;padding:14px 16px;border-radius:18px;background:#0F172A;color:#E2E8F0}" +
  ".cal-gi h3{margin:0 0 8px;font-size:1rem;color:#fff;display:flex;align-items:center;justify-content:space-between;gap:10px}" +
  ".cal-gi h3 button{white-space:nowrap;flex:none;min-height:36px;padding:0 14px;border-radius:10px;border:0;font:inherit;font-weight:700;font-size:.85rem;color:#fff;background:linear-gradient(180deg,#D98A1C,var(--ar));cursor:pointer}" +
  ".cal-gi ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}" +
  ".cal-gi li{display:grid;grid-template-columns:62px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.06);border-left:3px solid var(--tc)}" +
  ".cal-gi li b{font-variant-numeric:tabular-nums;color:#fff}.cal-gi li span{overflow-wrap:anywhere}.cal-gi li small{color:#94A3B8;font-size:.74rem}" +
  ".cal-gi li a{color:#FBD38D;font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap}" +
  ".cal-gi .vuoto-g{color:#94A3B8;font-size:.88rem}" +
  // giornata a tutto schermo (30/10/2026, Filippo: «si apre in grande»): data grande in testa, appuntamenti al centro, pulsanti fissi in fondo
  "#ag-gio{width:100vw;max-width:100vw;height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;margin:0;border-radius:0;overflow:hidden}#ag-gio[open]{display:flex;flex-direction:column}" +
  "#ag-gio .dl-t{padding:18px max(16px,calc((100vw - 820px)/2)) 14px}#ag-gio .dl-t h2{font-size:clamp(1.6rem,5.5vw,2.5rem);line-height:1.15;letter-spacing:-.02em}#ag-gio .dl-t p{font-size:1rem;margin-top:6px}" +
  "#ag-gio .dl-c{flex:1;overflow-y:auto;overflow-x:hidden;padding:16px max(16px,calc((100vw - 820px)/2)) 8px}#ag-gio .ag{margin-bottom:10px;font-size:1.04rem}#ag-gio .ag .o{font-size:1.25rem}#ag-gio .ag .t{font-size:1.1rem}" +
  "#ag-gio .dl-b{padding:12px max(16px,calc((100vw - 820px)/2)) 16px;border-top:1px solid var(--bordo);background:#fff}" +
  ".gio-n{display:inline-block;margin-left:8px;padding:1px 10px;border-radius:999px;background:var(--ar);color:#fff;font-size:.82rem;font-weight:700;vertical-align:middle}.gio-n:empty{display:none}" +
  ".gio-v{background:#fff;border:1px dashed #B9C3BE;border-radius:12px;padding:16px;color:#4A524E;font-size:.92rem;margin:4px 0 8px}" +
  ".ag.lampo{animation:cal-lampo 1.6s ease}@keyframes cal-lampo{0%,40%{box-shadow:0 0 0 3px var(--ar)}100%{box-shadow:none}}" +
  "@media (max-width:759px){.cal{padding:14px 10px 12px;border-radius:20px}.cal-m{flex:1 1 100%;margin:0 0 2px 4px}.cal-t{gap:6px}.cal-oggi{margin-right:auto}.cal-n button,.cal-oggi,.cal-piu{min-height:38px}.cal-g{gap:4px}.cal-d{min-height:60px;padding:6px 4px;border-radius:12px;align-items:center}" +
  ".cal-num{justify-content:center}.cal-num .cal-c{display:none}.cal-e,.cal-altri{display:none}.cal-pt{display:flex;justify-content:center}.cal-w{font-size:.62rem;letter-spacing:.06em}" +
  ".cal-gi li{grid-template-columns:52px minmax(0,1fr)}.cal-gi li a{grid-column:2}}" +
  "@media (prefers-reduced-motion:reduce){.cal-d,.cal-n button,.cal-oggi{transition:none}.ag.lampo{animation:none}}" +
  "@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .cal{background:linear-gradient(180deg,#141A24,#0F141D);border-color:rgba(255,255,255,.08)}" +
  ":root:not([data-theme=light]) .cal-m{color:#F1F5F9}:root:not([data-theme=light]) .cal-d{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.07)}" +
  ":root:not([data-theme=light]) .cal-d.fest{background:rgba(255,255,255,.025)}:root:not([data-theme=light]) .cal-d.pieno{background:rgba(217,138,28,.08);border-color:rgba(217,138,28,.3)}" +
  ":root:not([data-theme=light]) .cal-num{color:#CBD5E1}:root:not([data-theme=light]) .cal-e{color:#F1F5F9;background:color-mix(in srgb,var(--tc) 22%,#141A24)}" +
  ":root:not([data-theme=light]) .cal-e b{color:color-mix(in srgb,var(--tc) 60%,#fff)}:root:not([data-theme=light]) .cal-n button,:root:not([data-theme=light]) .cal-oggi{background:rgba(255,255,255,.06);color:#F1F5F9;border-color:rgba(255,255,255,.12)}" +
  ":root:not([data-theme=light]) .cal-leg{color:#94A3B8}:root:not([data-theme=light]) .cal-pt i{box-shadow:0 0 0 2px #141A24,0 0 8px var(--tc)}}";

// Calendario del mese (28/10/2026): richiesta di Filippo, «l'agenda si apre con tutto il mese; in ogni giorno un segno
// se ci sono impegni; come Google Calendar ma più bello». Sul computer ogni giorno mostra fino a 3 impegni (ora e titolo,
// colore del tipo) e il numero totale; sul telefono pallini colorati. Tocca un giorno: sotto compare l'elenco di quel
// giorno, con «Nuovo appuntamento» già su quella data. I dati sono quelli che la pagina già riceve (futuri e ultimi 30 giorni).
// «Giornata» (30/10/2026, Filippo): il tocco su un giorno apre anche la pagina di quel giorno (finestra #ag-gio, SCRIPT).
const CALENDARIO = String.raw`(function(){try{
var D=GL_AG,box=document.getElementById('cal');if(!box)return;
var MESI=['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
var GS=['Lun','Mar','Mer','Gio','Ven','Sab','Dom'],GL=['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato'];
var T=D.tipi||{},per={};
(D.mese||[]).forEach(function(x){(per[x.g]=per[x.g]||[]).push(x);});
Object.keys(per).forEach(function(k){per[k].sort(function(a,b){return (a.o||'00:00')<(b.o||'00:00')?-1:1;});});
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function cap(s){return s.charAt(0).toUpperCase()+s.slice(1);}
function iso(y,m,d){return y+'-'+(m<9?'0':'')+(m+1)+'-'+(d<10?'0':'')+d;}
var o=String(D.oggi||'').split('-'),Y=+o[0]||new Date().getFullYear(),M=(+o[1]||1)-1,sel=D.oggi;
function disegna(){
 var primo=new Date(Date.UTC(Y,M,1)),off=(primo.getUTCDay()+6)%7,inizio=new Date(Date.UTC(Y,M,1-off)),h='',tot=0;
 for(var k in per)if(k.slice(0,7)===iso(Y,M,1).slice(0,7))tot+=per[k].length;
 h+='<div class="cal-t"><h2 class="cal-m">'+cap(MESI[M])+' '+Y+(tot?'<small>'+tot+(tot===1?' impegno':' impegni')+'</small>':'')+'</h2>'+
  '<button type="button" class="cal-oggi" data-v="oggi">Oggi</button><div class="cal-n"><button type="button" data-v="-1" aria-label="Mese precedente">‹</button>'+
  '<button type="button" data-v="1" aria-label="Mese successivo">›</button></div>'+(D.chiuso?'':'<button type="button" class="cal-piu" data-v="nuovo">+ Nuovo</button>')+'</div>';
 h+='<div class="cal-g" role="grid">';for(var w=0;w<7;w++)h+='<div class="cal-w" role="columnheader">'+GS[w]+'</div>';
 for(var i=0;i<42;i++){var dt=new Date(inizio.getTime()+i*864e5),g=iso(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate()),l=per[g]||[];
  if(i===35&&dt.getUTCMonth()!==M)break;
  var cl='cal-d'+(dt.getUTCMonth()!==M?' fuori':'')+(g===D.oggi?' oggi':'')+(g===sel?' sel':'')+(l.length?' pieno':'')+(dt.getUTCDay()===0||dt.getUTCDay()===6?' fest':'');
  var lab=dt.getUTCDate()+' '+MESI[dt.getUTCMonth()]+(l.length?', '+l.length+(l.length===1?' impegno':' impegni'):', nessun impegno');
  h+='<button type="button" class="'+cl+'" data-g="'+g+'" aria-label="'+esc(lab)+'"><span class="cal-num"><span>'+dt.getUTCDate()+'</span>'+(l.length?'<em class="cal-c">'+l.length+'</em>':'')+'</span>';
  for(var j=0;j<l.length&&j<3;j++){var x=l[j];h+='<span class="cal-e t-'+esc(x.tipo)+(x.st==='annullato'?' ann':x.st==='avvenuto'?' ok':'')+'">'+(x.o?'<b>'+esc(x.o)+'</b>':'')+'<i>'+esc(x.t)+'</i></span>';}
  if(l.length>3)h+='<span class="cal-altri">+'+(l.length-3)+' altri</span>';
  if(l.length){h+='<span class="cal-pt">';for(var p=0;p<l.length&&p<4;p++)h+='<i class="t-'+esc(l[p].tipo)+'"></i>';h+='</span>';}
  h+='</button>';}
 h+='</div><div class="cal-leg">'+Object.keys(T).map(function(k){return '<span class="t-'+esc(k)+'">'+esc(T[k])+'</span>';}).join('')+'</div>'+giorno(sel);
 box.innerHTML=h;}
function giorno(g){var p=g.split('-'),dt=new Date(Date.UTC(+p[0],+p[1]-1,+p[2])),l=per[g]||[],h='<div class="cal-gi" aria-live="polite"><h3>'+cap(GL[dt.getUTCDay()])+' '+(+p[2])+' '+MESI[+p[1]-1]+
 (!D.chiuso&&g>=D.oggi?'<button type="button" data-v="nuovo" data-g="'+g+'">+ Nuovo</button>':'')+'</h3>';
 if(!l.length)h+='<p class="vuoto-g">Nessun impegno in questo giorno.</p>';
 else{h+='<ul>';l.forEach(function(x){h+='<li class="t-'+esc(x.tipo)+'"><b>'+(x.o?esc(x.o)+(x.f?'<small> – '+esc(x.f)+'</small>':''):'<small>giornata</small>')+'</b><span>'+esc(x.t)+
  '<br><small>'+esc(T[x.tipo]||'Altro')+(x.st?' · '+esc(x.st):'')+'</small></span><a href="#ag-'+x.id+'" data-v="vai" data-id="'+x.id+'">Dettagli ›</a></li>';});h+='</ul>';}
 return h+'</div>';}
box.addEventListener('click',function(ev){var b=ev.target.closest('[data-v],[data-g]');if(!b||!box.contains(b))return;var v=b.getAttribute('data-v');
 if(v==='-1'||v==='1'){M+=+v;if(M<0){M=11;Y--;}if(M>11){M=0;Y++;}disegna();return;}
 if(v==='oggi'){Y=+o[0];M=+o[1]-1;sel=D.oggi;disegna();return;}
 if(v==='nuovo'){if(window.glAgNuovo)window.glAgNuovo(b.getAttribute('data-g')||sel);return;}
 if(v==='vai'){ev.preventDefault();var r=document.querySelector('.ag[data-id="'+b.getAttribute('data-id')+'"]');if(r){var dt=r.closest('details');if(dt)dt.open=true;r.scrollIntoView({behavior:'smooth',block:'center'});r.classList.remove('lampo');void r.offsetWidth;r.classList.add('lampo');}return;}
 var g=b.getAttribute('data-g');if(g){sel=g;var p=g.split('-');if(+p[1]-1!==M||+p[0]!==Y){Y=+p[0];M=+p[1]-1;}disegna();if(window.glAgGiorno)window.glAgGiorno(g);}});
box.hidden=false;disegna();
}catch(x){}})();
`;

const SCRIPT = String.raw`(function(){try{
var D=GL_AG,dlg=document.getElementById('ag-dlg'),form=document.getElementById('ag-form');
if(!dlg||typeof dlg.showModal!=='function'){var nb=document.getElementById('ag-nuovo');if(nb)nb.disabled=true;
 var bs0=document.querySelectorAll('.az button');for(var i0=0;i0<bs0.length;i0++)bs0[i0].disabled=true;
 var nt=document.querySelector('.nota');if(nt)nt.insertAdjacentHTML('beforebegin','<p class="nota"><b>Questo browser non mostra il modulo: aggiornalo o usa un altro browser.</b></p>');return;}
var tit=document.getElementById('ag-tit'),sub=document.getElementById('ag-sub'),msg=document.getElementById('ag-msg'),no=document.getElementById('ag-no'),si=document.getElementById('ag-si');
var fg=document.getElementById('f-g'),fo=document.getElementById('f-o'),ff=document.getElementById('f-f'),ft=document.getElementById('f-t'),fn=document.getElementById('f-n'),ftipo=document.getElementById('f-tipo'),
 favv=document.getElementById('f-avv'),fcli=document.getElementById('f-cli'),fsera=document.getElementById('f-sera');
var fluogo=document.getElementById('f-luogo'),fchi=document.getElementById('f-chi'),ttit=document.getElementById('t-titolo'),tavv=document.getElementById('t-avv'),fpers=document.querySelectorAll('.f-pers');
var modo='nuovo',cur=null,occupato=false,fatto=false;
function lav(){return ftipo.value==='lavorazione';}
function scelte(){var a=[];for(var i=0;i<fpers.length;i++)if(fpers[i].checked)a.push(fpers[i].value);return a;}
function aggiornaTipo(){var l=lav();mostra('l-lav',l&&modo!=='sposta');
 ttit.textContent=l?'Quali lavorazioni':'Cosa succede';ft.placeholder=l?'es. Getto del solaio del piano 1':'es. Consegna solaio – autotrasportatore';
 tavv.textContent=l?'Avvisa su WhatsApp le persone scelte in «Chi»':tavv.getAttribute('data-tutti');
 if(l&&!fpers.length)favv.checked=false;}
ftipo.addEventListener('change',aggiornaTipo);
/* cronoprogramma (pacchetto B): elenco con ricerca, avviso se il giorno è fuori dalle date previste */
var CR=D.crono||[],crSel={},crL=document.getElementById('f-cr'),crQ=document.getElementById('f-cr-q'),crAvv=document.getElementById('f-cr-avv');
function dIt(s){var p=String(s||'').split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:'';}
function crTrova(id){for(var i=0;i<CR.length;i++)if(CR[i].id===id)return CR[i];return null;}
function crRender(){if(!crL)return;var q=(crQ.value||'').toLowerCase().trim(),h='',n=0;
 for(var i=0;i<CR.length;i++){var a=CR[i],sel=!!crSel[a.id];
  if(!sel&&q&&(a.nome+' '+a.fase).toLowerCase().indexOf(q)===-1)continue;
  if(!sel&&n>=80)continue;n++;
  h+='<label class="cr-i'+(sel?' sel':'')+'"><input type="checkbox" value="'+esc(a.id)+'"'+(sel?' checked':'')+'><span>'+esc(a.nome)+'<small>'+
   [a.fase,(a.ip?'prevista '+dIt(a.ip)+(a.fp&&a.fp!==a.ip?' – '+dIt(a.fp):''):''),(a.pct!=null?Math.round(a.pct)+'% fatto':'')].filter(Boolean).map(esc).join(' · ')+'</small></span></label>';}
 crL.innerHTML=h||'<div class="cr-vuoto">Nessuna attività con queste parole.</div>';crAvvisa();}
function crAvvisa(){if(!crAvv)return;var t=[],g=fg.value;
 for(var id in crSel){var a=crTrova(id);if(a&&g&&a.ip&&a.fp&&(g<a.ip||g>a.fp))t.push('«'+a.nome+'» nel cronoprogramma è prevista '+(a.ip===a.fp?'il '+dIt(a.ip):'dal '+dIt(a.ip)+' al '+dIt(a.fp))+'.');}
 crAvv.textContent=t.join(' ');}
if(crL){crQ.addEventListener('input',crRender);fg.addEventListener('change',crAvvisa);
 crL.addEventListener('change',function(ev){var c=ev.target;if(!c||c.type!=='checkbox')return;
  if(c.checked){if(Object.keys(crSel).length>=10){c.checked=false;return;}crSel[c.value]=1;var a=crTrova(c.value);if(a&&!ft.value.trim())ft.value=a.nome.slice(0,140);}
  else delete crSel[c.value];crRender();});}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function m(cl,t){msg.className='msg '+cl;msg.textContent=t;}
function mostra(id,v){var el=document.getElementById(id);if(el)el.style.display=v?'':'none';}
function post(p,corpo){return fetch(D.base+'/agenda/'+p,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(corpo)}).then(function(r){return r.json();});}
/* Inviti (30/10/2026): contatti della Rubrica con email; i scelti restano sempre in cima all'elenco */
var RUB=D.rubrica||[],invSel={},invL=document.getElementById('f-inv'),invQ=document.getElementById('f-inv-q'),invS=document.getElementById('f-inv-sel');
function invRender(){if(!invL)return;var q=(invQ.value||'').toLowerCase().trim(),h='',n=0,lista=RUB.slice().sort(function(a,b){return (invSel[b.id]?1:0)-(invSel[a.id]?1:0);});
 for(var i=0;i<lista.length;i++){var k=lista[i],sel=!!invSel[k.id];if(!sel&&q&&(k.n+' '+k.i+' '+k.e).toLowerCase().indexOf(q)===-1)continue;if(!sel&&n>=80)continue;n++;
  h+='<label class="cr-i'+(sel?' sel':'')+'"><input type="checkbox" value="'+k.id+'"'+(sel?' checked':'')+'><span>'+esc(k.n)+'<small>'+[k.i,k.e].filter(Boolean).map(esc).join(' · ')+'</small></span></label>';}
 invL.innerHTML=h||'<div class="cr-vuoto">Nessun contatto con queste parole.</div>';var c=Object.keys(invSel).length;
 invS.textContent=c?(c===1?'1 invitato: riceve l’email':c+' invitati: ricevono l’email')+' quando salvi.':'';}
if(invL){invQ.addEventListener('input',invRender);invL.addEventListener('change',function(ev){var c=ev.target;if(!c||c.type!=='checkbox')return;
 if(c.checked){if(Object.keys(invSel).length>=30){c.checked=false;return;}invSel[c.value]=1;}else delete invSel[c.value];invRender();});}
function invitati(){return Object.keys(invSel).map(Number);}
function apriNuovo(){modo='nuovo';cur=null;fatto=false;fg.min=D.oggi;invSel={};if(invQ)invQ.value='';invRender();mostra('l-inv',true);tit.textContent='Nuovo appuntamento';sub.textContent=document.querySelector('header .centro p').textContent;
 fg.value=D.oggi;fo.value='';ff.value='';ft.value='';fn.value='';ftipo.value='lavorazione';favv.checked=true;fcli.checked=false;fsera.checked=false;
 fluogo.value='';fchi.value='';for(var i=0;i<fpers.length;i++)fpers[i].checked=false;
 crSel={};if(crQ)crQ.value='';crRender();
 ['l-tipo','l-titolo','l-note','l-opz'].forEach(function(k){mostra(k,true);});aggiornaTipo();ft.required=true;si.textContent='Segna in agenda';si.disabled=false;no.disabled=false;m('','');dlg.showModal();setTimeout(function(){try{fg.focus();}catch(x){}},50);}
function apriSposta(b){modo='sposta';cur=b.getAttribute('data-id');fatto=false;fg.min=D.oggi;mostra('l-inv',false);var r=b.closest('.ag');tit.textContent='Sposta l’appuntamento';sub.textContent=r?r.getAttribute('data-titolo'):'';
 fg.value=b.getAttribute('data-g')||D.oggi;fo.value=b.getAttribute('data-o')||'';ff.value=b.getAttribute('data-f')||'';
 ['l-tipo','l-titolo','l-note','l-opz','l-lav'].forEach(function(k){mostra(k,false);});ft.required=false;si.textContent='Sposta e avvisa';si.disabled=false;no.disabled=false;m('','');dlg.showModal();}
/* «Modifica» (29/10/2026): lo stesso modulo del nuovo appuntamento, già compilato; un giorno passato resta sceglibile */
function apriModifica(b){var x={};try{x=JSON.parse(b.getAttribute('data-app'))||{};}catch(e){x={};}
 modo='modifica';cur=b.getAttribute('data-id');fatto=false;tit.textContent='Modifica l’appuntamento';sub.textContent=x.t||'';
 fg.min=x.g&&x.g<D.oggi?x.g:D.oggi;fg.value=x.g||D.oggi;fo.value=x.o||'';ff.value=x.f||'';ft.value=x.t||'';fn.value=x.n||'';ftipo.value=x.tipo||'altro';
 favv.checked=x.avv!==false;fcli.checked=!!x.cli;fsera.checked=!!x.sera;fluogo.value=x.luogo||'';fchi.value=x.chi||'';
 var ps=x.pers||[];for(var i=0;i<fpers.length;i++)fpers[i].checked=ps.indexOf(fpers[i].value)!==-1;
 crSel={};(x.att||[]).forEach(function(id){crSel[id]=1;});if(crQ)crQ.value='';crRender();
 invSel={};(x.inv||[]).forEach(function(id){invSel[id]=1;});if(invQ)invQ.value='';invRender();mostra('l-inv',true);
 ['l-tipo','l-titolo','l-note','l-opz'].forEach(function(k){mostra(k,true);});aggiornaTipo();ft.required=true;si.textContent='Salva le modifiche';si.disabled=false;no.disabled=false;m('','');dlg.showModal();}
form.addEventListener('submit',function(ev){ev.preventDefault();if(occupato)return;
 if(!fg.value){m('ko','Indica il giorno.');return;}
 if(modo!=='sposta'&&!ft.value.trim()){m('ko','Scrivi cosa succede.');return;}
 if(fo.value&&ff.value&&ff.value<=fo.value){m('ko','L’ora di fine deve venire dopo l’inizio.');return;}
 if(modo!=='sposta'&&lav()&&favv.checked&&!scelte().length){m('ko','Scegli in «Chi» le persone da avvisare, oppure togli la spunta dell’avviso WhatsApp.');return;}
 occupato=true;si.disabled=true;no.disabled=true;m('','Un momento…');
 var pr;
 if(modo!=='sposta'){var dati={giorno:fg.value,ora:fo.value,ora_fine:ff.value,tipo:ftipo.value,titolo:ft.value.trim(),note:fn.value.trim(),avvisa:favv.checked,visibile_cliente:fcli.checked,avviso_sera_prima:fsera.checked};
  if(lav()){dati.luogo=fluogo.value.trim();dati.chi=fchi.value.trim();dati.persone=scelte();dati.attivita=Object.keys(crSel).slice(0,10);}
  pr=modo==='nuovo'?post('crea',{t:D.t,c:D.c,dati:dati,invitati:invitati()}):post('azione',{t:D.t,id:Number(cur),azione:'modifica',dati:dati,invitati:invitati()});}
 else{pr=post('azione',{t:D.t,id:Number(cur),azione:'sposta',dati:{giorno:fg.value,ora:fo.value,ora_fine:ff.value}});}
 pr.then(function(j){occupato=false;no.disabled=false;
  if(j.esito==='ok'){fatto=true;var t=modo==='nuovo'?'Segnato in agenda.':modo==='modifica'?(j.spostato?'Modifiche salvate: giorno o ora cambiati, come «Sposta».':'Modifiche salvate.'):'Spostato.';
   if(typeof j.inviati==='number'&&(modo!=='modifica'||j.spostato||j.inviati>0)){t+=' Avvisi WhatsApp inviati: '+j.inviati+(j.fuori_finestra?' · da recapitare al mattino: '+j.fuori_finestra:'')+'.';}
   if(j.inviti>0){t+=' Email agli invitati: '+j.inviti+'.';}
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
/* dal calendario del mese: «+» su un giorno apre il modulo con quel giorno già scelto */
window.glAgNuovo=function(g){if(D.chiuso)return;apriNuovo();if(g&&g>=D.oggi){fg.value=g;crAvvisa();}};
/* «Com'è andata?» dopo «Avvenuto» (pacchetto B) */
var es=document.getElementById('ag-es'),esL=document.getElementById('es-l'),esMsg=document.getElementById('es-msg'),esSi=document.getElementById('es-si'),esNo=document.getElementById('es-no'),esId=0,esOcc=false;
function apriEsito(b){var att=[];try{att=JSON.parse(b.getAttribute('data-att'))||[];}catch(x){att=[];}
 var r=b.closest('.ag');esId=Number(b.getAttribute('data-id'));document.getElementById('es-sub').textContent=r?r.getAttribute('data-titolo'):'';
 var h='';for(var i=0;i<att.length;i++){h+='<div class="es-r" data-att="'+esc(att[i].id)+'"><b>'+esc(att[i].nome)+'</b><div class="es-c">'+
  '<select class="es-e"><option value="in_corso">In corso</option><option value="iniziata">Iniziata</option><option value="finita">Finita</option><option value="non_fatta">Non fatta</option></select>'+
  '<input type="number" class="es-p" min="0" max="100" step="5" inputmode="numeric" placeholder="%"></div></div>';}
 esL.innerHTML=h;esMsg.className='msg';esMsg.textContent='';esSi.disabled=false;esNo.disabled=false;
 esL.querySelectorAll('.es-e').forEach(function(s){s.addEventListener('change',function(){var p=s.parentNode.querySelector('.es-p');p.style.display=(s.value==='finita'||s.value==='non_fatta')?'none':'';});});
 es.showModal();}
document.getElementById('es-form').addEventListener('submit',function(ev){ev.preventDefault();if(esOcc)return;var esiti=[];
 esL.querySelectorAll('.es-r').forEach(function(r){var e=r.querySelector('.es-e').value,p=r.querySelector('.es-p').value;
  if(e!=='non_fatta')esiti.push({attivita_id:r.getAttribute('data-att'),esito:e,pct:(e==='finita'?'':p)});});
 for(var i=0;i<esiti.length;i++){var pv=esiti[i].pct;if(pv!==''&&(isNaN(Number(pv))||Number(pv)<0||Number(pv)>100)){esMsg.className='msg ko';esMsg.textContent='La percentuale va da 0 a 100.';return;}}
 esOcc=true;esSi.disabled=true;esNo.disabled=true;esMsg.className='msg';esMsg.textContent='Un momento…';
 post('azione',{t:D.t,id:esId,azione:'crono_esito',dati:{esiti:esiti}}).then(function(j){esOcc=false;
  if(j.esito==='ok'){location.reload();return;}if(j.esito==='gettone'){location.href=D.base+'/';return;}
  esSi.disabled=false;esNo.disabled=false;esMsg.className='msg ko';esMsg.textContent=j.messaggio||(j.esito==='incerto'?'Non ho avuto risposta: ricarica la pagina tra un minuto.':'Non sono riuscito a salvare: riprova tra poco.');
 }).catch(function(){esOcc=false;esSi.disabled=false;esNo.disabled=false;esMsg.className='msg ko';esMsg.textContent='Il servizio non risponde: riprova tra poco.';});});
esNo.addEventListener('click',function(){if(!esOcc)es.close();});
es.addEventListener('cancel',function(ev){if(esOcc)ev.preventDefault();});
function azione(b){var az=b.getAttribute('data-az'),id=Number(b.getAttribute('data-id')),r=b.closest('.ag'),titolo=r?r.getAttribute('data-titolo'):'';
 if(az==='sposta'){apriSposta(b);return;}
 if(az==='modifica'){apriModifica(b);return;}
 if(az==='avvenuto'&&b.getAttribute('data-att')){apriEsito(b);return;}
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
/* «Giornata» (30/10/2026, Filippo): tocca un giorno del calendario e si apre la pagina di quel giorno, con gli appuntamenti
   come nell'elenco della pagina e gli stessi pulsanti (Modifica, Sposta, Avvenuto…); l'elenco resta com'è */
var gio=document.getElementById('ag-gio'),gioL=document.getElementById('gio-l'),gioT=document.getElementById('gio-tit'),gioN=document.getElementById('gio-nuovo'),gioG='';
var GMESI=['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'],GGIO=['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];
window.glAgGiorno=function(g){if(!gio||!/^\d{4}-\d{2}-\d{2}$/.test(g))return;gioG=g;var p=g.split('-'),dt=new Date(Date.UTC(+p[0],+p[1]-1,+p[2]));
 gioT.textContent=(g===D.oggi?'Oggi · ':'')+GGIO[dt.getUTCDay()]+' '+(+p[2])+' '+GMESI[+p[1]-1]+' '+p[0];
 gioL.innerHTML='';var rs=document.querySelectorAll('main .ag[data-giorno="'+g+'"]');
 for(var i=0;i<rs.length;i++)gioL.appendChild(rs[i].cloneNode(true));
 if(!rs.length)gioL.innerHTML='<p class="gio-v">Nessun appuntamento in questo giorno'+(g<D.oggi?' (l’agenda mostra gli ultimi 30 giorni).':D.chiuso?'.':': tocca «+ Nuovo appuntamento» per fissarne uno.')+'</p>';
 var bg=gioL.querySelectorAll('.az button[data-az]');for(var j=0;j<bg.length;j++){bg[j].disabled=false;bg[j].addEventListener('click',function(){azione(this);});}
 /* il cestino (cestino.js) lega ogni pulsante 🗑 a parte: nella giornata si chiude la finestra e si usa quello dell'elenco */
 var bc=gioL.querySelectorAll('.gl-ct-b');for(var q=0;q<bc.length;q++)bc[q].addEventListener('click',function(){var r=this.closest('.ag'),o=r&&document.querySelector('main .ag[data-id="'+r.getAttribute('data-id')+'"] > .gl-ct-b');if(o){gio.close();o.click();}});
 if(gioN)gioN.hidden=g<D.oggi;
 var gn=document.getElementById('gio-n');if(gn)gn.textContent=rs.length?(rs.length===1?'1 appuntamento':rs.length+' appuntamenti'):'';
 if(!gio.open)gio.showModal();gioL.scrollTop=0;};
if(gio){document.getElementById('gio-no').addEventListener('click',function(){gio.close();});
 if(gioN)gioN.addEventListener('click',function(){gio.close();window.glAgNuovo(gioG);});}
/* (30/10 sera, Filippo) anche i titoli dei giorni dell'elenco aprono la giornata */
Array.prototype.forEach.call(document.querySelectorAll('main .tit[data-g]'),function(t){function apri(){if(window.glAgGiorno)window.glAgGiorno(t.getAttribute('data-g'));}
 t.addEventListener('click',apri);t.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();apri();}});});
var ic=document.getElementById('ics-copia');if(ic)ic.addEventListener('click',function(){var u=document.getElementById('ics-url');try{u.select();}catch(x){}
 var fatto=function(){ic.textContent='Copiato';setTimeout(function(){ic.textContent='Copia';},1500);};
 if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u.value).then(fatto,function(){try{document.execCommand('copy');fatto();}catch(x){}});}else{try{document.execCommand('copy');fatto();}catch(x){}}});
window.addEventListener('pageshow',function(ev){if(ev.persisted)location.reload();});
}catch(x){}})();
`;
