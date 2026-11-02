// ============================================================================
// CONFERMA DELLA CORREZIONE IA NEI CASI DUBBI (02/11/2026, proposta approvata da Filippo: «Sì, 0A e il resto»)
// Quando la correzione automatica di un testo o di un vocale è dubbia, il database (correzione_conferme) prepara
// la domanda e la fa partire da qui: pg_cron → correzione_conferma_sveglia → POST /admin {azione: correzione_conferma}.
//   «✏️ Ho capito così: «…» · Non ero sicuro di: … · Va bene?»  [✅ Sì] [✏️ Correggi]   (id «CC_OK_<n>» / «CC_NO_<n>»)
// Le risposte le prende questo relay e NON vanno a Make (nessun credito):
//   - «Sì» → il database la segna, a chi ha scritto solo la spunta di lettura;
//   - «Correggi» → «Scrivi o detta qui la frase giusta»: il primo testo o vocale entro i minuti del database
//     (correzione_conferma_correggi_min) sostituisce la voce del Diario, con la storia (correzione_conferma_testo).
// Chi riceve la domanda, quando e con che testo lo decide il database (interruttore correzione_conferma_attiva).
// FAIL-SAFE: database o Meta che non rispondono → il messaggio prosegue come prima.
// Spegnimento dal Worker: variabile CONFERMA_CORREZIONE=off.
// ============================================================================

export function ccIdPulsante(msg) {
  if (!msg || msg.type !== "interactive" || !msg.interactive) return "";
  const it = msg.interactive;
  const id = String((it.button_reply && it.button_reply.id) || (it.list_reply && it.list_reply.id) || "");
  return /^CC_(OK|NO)_[0-9]{1,18}$/.test(id) ? id : "";
}

async function rispondiTesto(h, phoneId, token, tel, msgId, testo) {
  try {
    const inv = await h.invia(phoneId, token, {
      messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "text",
      context: { message_id: msgId }, text: { body: String(testo).slice(0, 1000), preview_url: false },
      biz_opaque_callback_data: "relay|correzione_conferma|risposta|"
    });
    return inv;
  } catch (e) { return { ok: false, status: 0, testo: String((e && e.message) || e) }; }
}

async function spuntaLettura(h, phoneId, token, msgId) {
  try { await h.invia(phoneId, token, { messaging_product: "whatsapp", status: "read", message_id: msgId }); } catch (e) {}
}

// Pulsanti «✅ Sì» / «✏️ Correggi». Ritorna true se preso in carico (il pacchetto NON va a Make).
export async function ccRispostaGestisci(msg, value, env, h) {
  const id = ccIdPulsante(msg);
  const tel = String(msg.from || "");
  const phoneId = (value.metadata && value.metadata.phone_number_id) || "";
  if (!id || !tel || !phoneId || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN || env.CONFERMA_CORREZIONE === "off") return false;
  const r = await h.rpc(env, "correzione_conferma_risposta", { p_telefono: tel, p_id_pulsante: id }, 6000);
  if (!r || r.esito === "non_mio" || r.esito === "errore") return false;
  await spuntaLettura(h, phoneId, env.WHATSAPP_TOKEN, msg.id);
  if (r.esito === "correggi") _attese.locali.set(tel, Date.now());
  if (r.testo) await rispondiTesto(h, phoneId, env.WHATSAPP_TOKEN, tel, msg.id, r.testo);
  await h.log(env, tel, msg.id, "correzione_conferma_risposta", id + " → " + String(r.esito));
  return true;
}

// Numeri da cui si aspetta la frase giusta: letti dal database al massimo ogni 10 s; più quelli che hanno appena
// toccato «Correggi» su questo stesso relay (20 s di margine, finché il database non li restituisce).
let _attese = { t: 0, telefoni: new Set(), locali: new Map() };

async function ccInAttesa(env, h, tel) {
  const ora = Date.now();
  if (ora - _attese.t > 10000) {
    _attese.t = ora;
    try {
      const r = await h.rpc(env, "correzione_conferma_attese", {}, 2000);
      _attese.telefoni = new Set(Array.isArray(r && r.telefoni) ? r.telefoni.map((x) => String(x)) : []);
    } catch (e) {}
    for (const [t, quando] of _attese.locali) if (ora - quando > 20000) _attese.locali.delete(t);
  }
  return _attese.telefoni.has(tel) || _attese.locali.has(tel);
}

// La frase giusta dopo «Correggi» (testo o vocale). Ritorna true se presa: il messaggio NON va a Make.
export async function ccTestoGestisci(msg, value, env, h) {
  if (!msg || (msg.type !== "text" && msg.type !== "audio") || env.CONFERMA_CORREZIONE === "off") return false;
  const tel = String(msg.from || "");
  const phoneId = (value.metadata && value.metadata.phone_number_id) || "";
  if (!tel || !phoneId || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN) return false;
  if (!(await ccInAttesa(env, h, tel))) return false;
  let testo = msg.type === "text" ? String((msg.text && msg.text.body) || "").trim() : "";
  if (msg.type === "audio") {
    try { testo = String((await h.trascrivi(msg)) || "").trim(); } catch (e) { testo = ""; }
  }
  const r = await h.rpc(env, "correzione_conferma_testo", { p_telefono: tel, p_testo: testo, p_message_id: String(msg.id || "") }, 8000);
  if (!r || r.esito === "nessuna") { _attese.locali.delete(tel); return false; } // nessuna attesa: il messaggio prosegue come sempre
  if (r.esito !== "vuoto") _attese.locali.delete(tel);
  await spuntaLettura(h, phoneId, env.WHATSAPP_TOKEN, msg.id);
  if (r.testo) await rispondiTesto(h, phoneId, env.WHATSAPP_TOKEN, tel, msg.id, r.testo);
  await h.log(env, tel, msg.id, "correzione_conferma_frase", String(r.esito) + " · " + msg.type + " · " + testo.length + " caratteri");
  return true;
}

// La domanda (POST /admin {azione: correzione_conferma, id}): testo e pulsanti li prepara il database.
export async function ccConferma(env, id, h) {
  const esito = { id: Number(id) || 0, inviato: false, dettaglio: "" };
  if (!esito.id) { esito.dettaglio = "id"; return esito; }
  if (!env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN || env.CONFERMA_CORREZIONE === "off") { esito.dettaglio = "configurazione"; return esito; }
  const cfg = await h.config(env);
  if (!cfg.phone_number_id) { esito.dettaglio = "phone_number_id"; return esito; }
  let r = null;
  try { r = await h.rpc(env, "correzione_conferma_payload", { p_id: esito.id }, 8000); }
  catch (e) { esito.dettaglio = "payload: " + String((e && e.message) || e); return esito; }
  const tel = r && String(r.telefono || "").replace(/[^0-9]/g, "");
  if (!r || !tel || !r.payload || typeof r.payload !== "object") { esito.dettaglio = "niente da mandare"; return esito; }
  const payload = r.payload;
  payload.messaging_product = "whatsapp";
  payload.to = tel;
  try {
    let inv = await h.invia(cfg.phone_number_id, env.WHATSAPP_TOKEN, payload);
    // se Meta non accetta la risposta collegata al messaggio (messaggio troppo vecchio o cancellato), si manda senza
    if (!inv.ok && inv.status === 400 && payload.context) {
      delete payload.context;
      inv = await h.invia(cfg.phone_number_id, env.WHATSAPP_TOKEN, payload);
    }
    esito.inviato = inv.ok; esito.dettaglio = inv.status + " " + inv.testo;
  } catch (e) { esito.dettaglio = String((e && e.message) || e); }
  try { await h.rpc(env, "correzione_conferma_segna", { p_id: esito.id, p_ok: esito.inviato, p_dettaglio: esito.dettaglio.slice(0, 250) }, 5000); } catch (e) {}
  await h.log(env, tel, null, esito.inviato ? "correzione_conferma" : "correzione_conferma_errore", "#" + esito.id + " · " + esito.dettaglio.slice(0, 250));
  return esito;
}
