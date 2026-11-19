// ============================================================================
// MESSAGGI SU WA-RELAY — visitatori con l'IA (B4, 19/11/2026, visitatori-ia-1)
// Decisione di Filippo (19/11, chat B8 e B4): chi scrive al numero TIX senza essere registrato in un'impresa
// riceve la risposta dell'IA su tutto (funzioni, prezzi, qualsiasi domanda), con la stessa guida e lo stesso
// registro della chat del sito (Edge chat-sito della B8, pagina «whatsapp»): Filippo vede le conversazioni nel
// pannello. Resta il pulsante per gli operai gia' invitati («Sono un operaio» → messaggio dell'invito).
// Privacy: ATTENZIONE fatta, testi della B12. Interruttore nel database: visitatori_ia (no / prova / si),
// letto con visitatori_ia_config(); «prova» = solo i numeri di visitatori_ia_numeri_prova.
// FAIL-SAFE: interruttore spento o database fermo → il pezzo «primo» fa come prima.
// ============================================================================

const CHAT_SITO_URL = "https://rvigugiufrjmzedjstuz.supabase.co/functions/v1/chat-sito";
const RISERVA = "In questo momento non riesco a rispondere. Scrivi a info@tixcantiere.it: ti risponde una persona, per iscritto.";

let _cfg = { t: 0, v: null };

export async function visitatoriConfig(c) {
  const ora = Date.now();
  if (_cfg.v && ora - _cfg.t < 60000) return _cfg.v;
  let v = { attivo: "no", numeri_prova: [], privacy: "", pulsante: "", solo_testo: "" };
  try {
    const r = await c.rpc("visitatori_ia_config", {}, 3000);
    if (r && typeof r === "object") {
      v = {
        attivo: String(r.attivo || "no"),
        numeri_prova: (Array.isArray(r.numeri_prova) ? r.numeri_prova : []).map((x) => String(x).replace(/[^0-9]/g, "")),
        privacy: String(r.privacy || ""),
        pulsante: String(r.pulsante || ""),
        solo_testo: String(r.solo_testo || "")
      };
    }
  } catch (e) {}
  _cfg = { t: ora, v };
  return v;
}

export function visitatoriAcceso(cfg, telefono) {
  if (!cfg) return false;
  if (cfg.attivo === "si") return true;
  if (cfg.attivo === "prova") return cfg.numeri_prova.indexOf(String(telefono || "").replace(/[^0-9]/g, "")) !== -1;
  return false;
}

// La sessione della chat del sito e' un UUID CASUALE salvato sulla persona (persone.visitatore_sessione, B12):
// non si ricava dal numero e sparisce con lui. visitatori_ia_sessione da' anche la riga privacy nella sua lingua.
async function chiediAllaChat(c, sessione, testo) {
  const segreto = c.env && c.env.RELAY_SEGRETO;
  if (!segreto || !sessione) return RISERVA;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 28000);
  try {
    const r = await fetch(CHAT_SITO_URL, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-tix-relay": segreto },
      body: JSON.stringify({ sessione, pagina: "whatsapp", testo: String(testo).slice(0, 1000) })
    });
    const j = await r.json().catch(() => null);
    const risposta = j && typeof j.risposta === "string" ? j.risposta.trim() : "";
    return risposta || RISERVA;
  } catch (e) {
    return RISERVA;
  } finally {
    clearTimeout(timer);
  }
}

// Collaudo (POST /admin {azione:"visitatori_prova", telefono, testo, primo}): fa rispondere l'IA come a un visitatore,
// solo ai numeri di visitatori_ia_numeri_prova (i numeri di Filippo sono registrati: dal WhatsApp vero non
// passerebbero di qui). a = { rpc, invia(payload, motivo) }, env.
export async function visitatoriAdmin(azione, corpo, a, env) {
  if (azione !== "visitatori_prova") return null;
  const tel = String((corpo && corpo.telefono) || "").replace(/[^0-9]/g, "");
  const cfg = await visitatoriConfig({ rpc: a.rpc });
  if (!tel || cfg.numeri_prova.indexOf(tel) === -1) return { ok: false, status: 400, errore: "numero non in visitatori_ia_numeri_prova" };
  const c = { env, telefono: tel, rpc: a.rpc,
    invia: (payload, motivo) => a.invia(Object.assign({ messaging_product: "whatsapp", to: tel }, payload), motivo) };
  _cfg = { t: 0, v: null };
  await visitatoreRispondi(c, cfg, String((corpo && corpo.testo) || ""), corpo && corpo.primo === true);
  return { ok: true };
}

// Risponde al visitatore. primo = primo contatto: PRIMA della risposta dell'IA la riga privacy (AI Act art. 50,
// condizione della B12), DOPO il pulsante per gli operai gia' invitati.
export async function visitatoreRispondi(c, cfg, testo, primo) {
  let s = null;
  try { s = await c.rpc("visitatori_ia_sessione", { p_telefono: c.telefono }, 4000); } catch (e) { s = null; }
  const sessione = s && s.sessione ? String(s.sessione) : "";
  const privacy = (s && s.privacy) ? String(s.privacy) : cfg.privacy;
  if (primo && privacy) {
    const p = await c.invia({ type: "text", text: { body: privacy.slice(0, 4000), preview_url: false } }, "visitatore_privacy");
    if (!p || !p.ok) throw new Error("invio della riga privacy non riuscito: " + String((p && (p.status + " " + p.testo)) || "").slice(0, 160));
  }
  let corpo;
  if (!String(testo || "").trim()) {
    corpo = cfg.solo_testo || "Scrivimi la tua domanda per iscritto e ti rispondo subito.";
  } else {
    corpo = await chiediAllaChat(c, sessione, testo);
  }
  const r = await c.invia({ type: "text", text: { body: corpo.slice(0, 4000), preview_url: false } }, "visitatore_ia");
  if (!r || !r.ok) throw new Error("invio della risposta non riuscito: " + String((r && (r.status + " " + r.testo)) || "").slice(0, 160));
  if (primo && cfg.pulsante) {
    await c.invia({ type: "interactive", interactive: { type: "button", body: { text: cfg.pulsante.slice(0, 1020) },
      action: { buttons: [{ type: "reply", reply: { id: "GIORNALE_LAVORI", title: "Sono un operaio" } }] } } }, "visitatore_pulsante");
  }
  return true;
}
