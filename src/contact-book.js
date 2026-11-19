// CONTACT BOOK E BSUID (B4, 19/11/2026, bsuid-1). Decisione di Filippo del 19/11 (punto 1 e cancellazione dalla
// rubrica di Meta chiesta dalla B12); privacy sentita con B6 e B12.
//
// 1) RICONOSCIMENTO: quando una persona usa il nome utente di WhatsApp, Meta puo' mandare il messaggio SENZA numero
//    (manca messages[].from e contacts[].wa_id) ma sempre con il codice della persona (from_user_id / user_id = BSUID).
//    Se il BSUID e' gia' salvato su una persona (persone.wa_user_id), si rimette il suo numero nel messaggio prima di
//    tutto il resto (registro d'ingresso, blocchi, chat unica, Make): per il resto di TIX il messaggio e' come prima.
//    Il BSUID non si copia in tabelle nuove. Sconosciuto → il messaggio resta com'e' (il ramo «Non ti riconosco»
//    e' il punto 4, non ancora deciso). FAIL-SAFE: database fermo o errore → il messaggio resta com'e'.
//    Costo: niente, se nel messaggio non c'e' un from_user_id senza from (oggi nessuno).
//
// 2) CANCELLAZIONE DALLA CONTACT BOOK DI META: azioni /admin
//      contact_book_controlla {bsuid} → GET  {phone_id}/contact_book  → {present}
//      contact_book_cancella  {bsuid} → DELETE {phone_id}/contact_book → {deleted}
//      contact_book_giro             → prende dal database le voci da cancellare (persona cancellata o tolta,
//                                      numero non collegato a fine durata) e le cancella, con l'esito nel database.
//    Il token resta in wa-relay: il database chiede solo il giro (pg_cron → chat_unica_admin).

const BSUID_OK = /^[A-Z]{2}\.[0-9A-Za-z]{4,80}$/;

// Ritorna il corpo (stringa) con i numeri rimessi, oppure lo stesso rawBody se non c'e' niente da fare.
export async function bsuidCompleta(rawBody, rpc) {
  if (typeof rawBody !== "string" || rawBody.indexOf("from_user_id") === -1) return rawBody;
  let p;
  try { p = JSON.parse(rawBody); } catch (e) { return rawBody; }
  const cerca = new Set();
  for (const en of p.entry || []) for (const ch of en.changes || []) {
    const v = ch.value || {};
    for (const m of v.messages || []) {
      if (m && !m.from && m.from_user_id && BSUID_OK.test(String(m.from_user_id))) cerca.add(String(m.from_user_id));
    }
  }
  if (!cerca.size) return rawBody;
  let mappa = null;
  try { mappa = await rpc("relay_bsuid_telefoni", { p_bsuid: Array.from(cerca).slice(0, 50) }, 2500); } catch (e) { mappa = null; }
  if (!mappa || typeof mappa !== "object" || Array.isArray(mappa)) return rawBody;
  let cambiati = 0;
  for (const en of p.entry || []) for (const ch of en.changes || []) {
    const v = ch.value || {};
    for (const m of v.messages || []) {
      const t = m && !m.from && m.from_user_id ? mappa[String(m.from_user_id)] : null;
      if (t && /^[0-9]{6,20}$/.test(String(t))) { m.from = String(t); cambiati++; }
    }
    for (const c of v.contacts || []) {
      const t = c && !c.wa_id && c.user_id ? mappa[String(c.user_id)] : null;
      if (t && /^[0-9]{6,20}$/.test(String(t))) c.wa_id = String(t);
    }
  }
  return cambiati ? JSON.stringify(p) : rawBody;
}

async function unaVoce(azione, bsuid, a) {
  if (!BSUID_OK.test(bsuid)) return { ok: false, status: 400, errore: "bsuid non valido" };
  if (!a.phoneId) return { ok: false, status: 503, errore: "phone_number_id mancante" };
  const percorso = a.phoneId + "/contact_book?messaging_product=whatsapp&bsuid=" + encodeURIComponent(bsuid);
  const r = await a.graphJson(a.graph, a.token, percorso, azione === "contact_book_cancella" ? "DELETE" : "GET");
  const d = r.dati || {};
  const out = { ok: !!r.ok, status: r.status };
  if (d.success !== undefined) out.success = d.success;
  if (d.deleted !== undefined) out.deleted = d.deleted;
  if (d.present !== undefined) out.present = d.present;
  if (d.error) out.errore = { code: d.error.code, message: String(d.error.message || "").slice(0, 200) };
  return out;
}

// a = { graphJson, graph, token, phoneId, rpc }
export async function contactBookAdmin(azione, corpo, a) {
  if (azione === "contact_book_controlla" || azione === "contact_book_cancella") {
    return unaVoce(azione, String((corpo && corpo.bsuid) || "").trim(), a);
  }
  // collaudo del riconoscimento: un messaggio finto SENZA numero col BSUID dato; risponde solo con le ultime 4 cifre
  // del numero trovato (niente elaborazione, niente Make)
  if (azione === "bsuid_prova") {
    const bsuid = String((corpo && corpo.bsuid) || "").trim();
    const finto = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ user_id: bsuid, profile: { name: "collaudo" } }],
      messages: [{ from_user_id: bsuid, id: "COLLAUDO_BSUID", type: "text", text: { body: "collaudo" } }] } }] }] });
    const fuori = await bsuidCompleta(finto, a.rpc);
    let da = "";
    try { da = String(JSON.parse(fuori).entry[0].changes[0].value.messages[0].from || ""); } catch (e) { da = ""; }
    return { ok: true, riconosciuto: !!da, finale: da ? da.slice(-4) : "" };
  }
  if (azione === "contact_book_giro") {
    let lista = [];
    try { lista = await a.rpc("contact_book_da_cancellare", {}, 5000); } catch (e) { return { ok: false, errore: "database" }; }
    if (!Array.isArray(lista)) return { ok: false, errore: "risposta strana" };
    const esiti = [];
    for (const x of lista.slice(0, 20)) {
      const bsuid = String((x && x.bsuid) || "");
      let e;
      try { e = await unaVoce("contact_book_cancella", bsuid, a); } catch (err) { e = { ok: false, status: 0, errore: String((err && err.message) || err).slice(0, 200) }; }
      try { await a.rpc("contact_book_esito", { p_bsuid: bsuid, p_esito: e }, 5000); } catch (err) {}
      esiti.push({ ok: e.ok, deleted: e.deleted, status: e.status });
    }
    return { ok: true, voci: esiti.length, esiti };
  }
  return null;
}
