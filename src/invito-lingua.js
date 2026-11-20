// ============================================================================
// INVITO NELLA LINGUA DELL'OPERAIO (B4, 20/11/2026, invito-lingua-1) — richiesta di Filippo del 20/11.
// Dopo il benvenuto dell'invito (in italiano, come prima) parte l'elenco «🌐 In che lingua vuoi i messaggi di TIX?».
// Il tocco su una lingua (id «TIX_INV_L_<codice>») lo gestisce il relay, non Make: il database
// (invito_lingua_benvenuto) imposta la lingua della persona e rimanda il benvenuto, con la privacy, in quella lingua.
// Interruttore nel database: invito_lingua_attiva (no / prova / si); «prova» = solo i numeri di invito_lingua_numeri_prova.
// FAIL-SAFE: interruttore spento o database fermo → nessun elenco; un tocco non riconosciuto prosegue come prima.
// ============================================================================

const LINGUE_1 = [["it", "Italiano", "Italiano"], ["ro", "Română", "Rumeno"], ["sq", "Shqip", "Albanese"], ["ar", "العربية", "Arabo"],
  ["uk", "Українська", "Ucraino"], ["ru", "Русский", "Russo"], ["pl", "Polski", "Polacco"], ["bn", "বাংলা", "Bengalese"], ["en", "English", "Inglese"]];
const LINGUE_2 = [["es", "Español", "Spagnolo"], ["fr", "Français", "Francese"], ["de", "Deutsch", "Tedesco"],
  ["hi", "हिन्दी", "Hindi"], ["ur", "اردو", "Urdu"], ["tr", "Türkçe", "Turco"]];
const ID = /^TIX_INV_L_([a-z]{2}|P1|P2)$/;
const CORPO = "🌐 In che lingua vuoi i messaggi di TIX?\nChoose your language · Alege limba · Zgjidh gjuhën · اختر لغتك · Выбери язык · भाषा चुनें";

export function invitoLinguaId(msg) {
  if (!msg || msg.type !== "interactive" || !msg.interactive) return "";
  const r = msg.interactive.list_reply || msg.interactive.button_reply;
  const m = r && String(r.id || "").match(ID);
  return m ? m[1] : "";
}

export function invitoLinguaLista(tel, pagina) {
  const righe = (pagina === 2 ? LINGUE_2 : LINGUE_1).map(([c, nome, it]) => ({ id: "TIX_INV_L_" + c, title: nome, description: it }));
  righe.push(pagina === 2
    ? { id: "TIX_INV_L_P1", title: "⬅️ Indietro · Back", description: "Italiano, Română, Shqip, العربية…" }
    : { id: "TIX_INV_L_P2", title: "➡️ Altre lingue · More", description: "Español, Français, Deutsch, हिन्दी, اردو, Türkçe" });
  return {
    messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "interactive",
    interactive: { type: "list", body: { text: CORPO }, action: { button: "🌐 Lingua · Language",
      sections: [{ title: "Lingue · Languages", rows: righe }] } }
  };
}

// Dopo un'attivazione riuscita: manda l'elenco solo se il database lo permette per questo numero.
export async function invitoLinguaDopoBenvenuto(tel, phoneId, env, h) {
  let ok = null;
  try { ok = await h.rpc(env, "invito_lingua_attiva_per", { p_telefono: tel }, 4000); } catch (e) { ok = null; }
  if (ok !== true) return false;
  await h.invia(phoneId, env.WHATSAPP_TOKEN, invitoLinguaLista(tel, 1));
  return true;
}

// true = tocco gestito qui (non va a Make); false = prosegue come prima
export async function invitoLinguaGestisci(msg, value, env, h) {
  const scelta = invitoLinguaId(msg);
  const tel = String(msg.from || "");
  const phoneId = (value.metadata && value.metadata.phone_number_id) || "";
  if (!scelta || !tel || !phoneId || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN) return false;
  if (scelta === "P1" || scelta === "P2") {
    let ok = null;
    try { ok = await h.rpc(env, "invito_lingua_attiva_per", { p_telefono: tel }, 4000); } catch (e) { ok = null; }
    if (ok !== true) return false;
    try { await h.invia(phoneId, env.WHATSAPP_TOKEN, invitoLinguaLista(tel, scelta === "P2" ? 2 : 1)); } catch (e) {}
    return true;
  }
  const r = await h.rpc(env, "invito_lingua_benvenuto", { p_telefono: tel, p_lingua: scelta }, 8000);
  if (!r || r.esito !== "ok" || !r.testo) return false;
  try {
    await h.invia(phoneId, env.WHATSAPP_TOKEN, { messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "text",
      text: { body: String(r.testo).slice(0, 4000), preview_url: false } });
  } catch (e) {}
  try { await h.log(env, tel, msg.id, "invito_lingua", scelta); } catch (e) {}
  return true;
}
