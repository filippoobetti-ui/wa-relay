// ============================================================================
// AVVISO DEL MARGINE SU WHATSAPP (B4, 15/11/2026, «avvisi-margine-1»)
// L'avviso «margine sotto la soglia» lo prepara il database (B13: costi_avvisi_margine_giro scrive la riga in
// costi_margine_avvisi con wa_stato = 'da_fare', il telefono del titolare e il testo wa_testo, e manda l'email).
// Qui parte solo il WhatsApp, senza modelli Meta (scelta di Filippo del 10/11): un messaggio di testo e basta.
//   - al primo messaggio del titolare (la finestra delle 24 ore e' aperta per forza): margineAlMessaggio
//   - quando il giro del database crea righe nuove: POST /admin {azione: "avvisi_margine"} manda solo ai numeri
//     con la finestra aperta (agenda_finestra_aperta); gli altri restano in attesa del loro primo messaggio.
// Interruttore nel database: impostazioni.costi_avviso_wa = no / prova / si (relay_avvisi_margine).
// Interruttore del Worker: AVVISI_MARGINE = "off" spegne tutto. FAIL-SAFE: ogni errore lascia la riga 'da_fare'.
// ============================================================================

const ETICHETTA = "relay|avvisi_margine|text|";
const _ultimo = new Map();      // telefono -> ultimo controllo (ms), per non chiedere al database a ogni messaggio
const _inCorso = new Set();     // id delle righe in invio in questo momento (niente doppioni)

function cifre(t) { return String(t || "").replace(/[^0-9]/g, ""); }

function idMessaggio(testo) {
  try { const j = JSON.parse(testo); return (j && j.messages && j.messages[0] && j.messages[0].id) || null; } catch (e) { return null; }
}

async function manda(env, h, phoneId, riga) {
  const id = Number(riga.id) || 0;
  const tel = cifre(riga.telefono);
  const testo = String(riga.wa_testo || "").trim();
  if (!id || !tel || !testo || _inCorso.has(id)) return { id, inviato: false, dettaglio: "saltato" };
  _inCorso.add(id);
  try {
    let inv = null, errore = "";
    try {
      inv = await h.invia(phoneId, env.WHATSAPP_TOKEN, {
        messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "text",
        text: { body: testo.slice(0, 4000), preview_url: false }, biz_opaque_callback_data: ETICHETTA
      });
    } catch (e) { errore = String((e && e.message) || e); }
    const ok = !!(inv && inv.ok);
    if (!ok && !errore) errore = (inv ? inv.status + " " + String(inv.testo || "") : "nessuna risposta");
    try {
      await h.rpc(env, "costi_avviso_wa_esito", { p_id: id, p_ok: ok, p_message_id: ok ? idMessaggio(inv.testo) : null, p_errore: ok ? null : errore.slice(0, 250) }, 5000);
    } catch (e) {}
    await h.log(env, tel, null, ok ? "avviso_margine" : "avviso_margine_errore", "#" + id + (ok ? "" : " · " + errore.slice(0, 250)));
    return { id, inviato: ok, dettaglio: ok ? "inviato" : errore.slice(0, 250) };
  } finally {
    _inCorso.delete(id);
  }
}

// Al primo messaggio del titolare: manda i suoi avvisi in attesa. Non blocca mai il messaggio in arrivo.
export async function margineAlMessaggio(env, h, telefono) {
  const tel = cifre(telefono);
  if (!tel || env.AVVISI_MARGINE === "off" || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN) return null;
  const ora = Date.now();
  if (ora - (_ultimo.get(tel) || 0) < 30000) return null;
  _ultimo.set(tel, ora);
  if (_ultimo.size > 500) _ultimo.clear();
  const righe = await h.rpc(env, "relay_avvisi_margine", { p_telefono: tel }, 5000);
  if (!Array.isArray(righe) || !righe.length) return null;
  const cfg = await h.config(env);
  if (!cfg.phone_number_id) return null;
  const esiti = [];
  for (const r of righe) esiti.push(await manda(env, h, cfg.phone_number_id, r));
  return esiti;
}

// Chiamata dal giro del database (POST /admin {azione: "avvisi_margine"}): solo i numeri con la finestra aperta.
export async function margineAdmin(env, h) {
  const esito = { inviati: 0, in_attesa: 0, errori: 0, dettagli: [] };
  if (env.AVVISI_MARGINE === "off" || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN) { esito.dettagli.push("configurazione"); return esito; }
  const righe = await h.rpc(env, "relay_avvisi_margine", { p_telefono: null }, 8000);
  if (!Array.isArray(righe) || !righe.length) return esito;
  const cfg = await h.config(env);
  if (!cfg.phone_number_id) { esito.dettagli.push("phone_number_id"); return esito; }
  for (const r of righe) {
    if (!r.finestra_aperta) { esito.in_attesa++; continue; }
    const x = await manda(env, h, cfg.phone_number_id, r);
    if (x.inviato) esito.inviati++; else if (x.dettaglio !== "saltato") esito.errori++;
    esito.dettagli.push("#" + x.id + " " + x.dettaglio);
  }
  return esito;
}
