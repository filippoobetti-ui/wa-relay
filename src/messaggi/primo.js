// ============================================================================
// MESSAGGI SU WA-RELAY — pezzo A3 «primo contatto» (10/11/2026)
// COPIA del router 122 «Primo passo» (router 120 route 2) dello scenario Make 7264624: chi scrive e non e'
// ancora REGISTRATO con un'azienda. Stesse funzioni del database, stesso ordine, stesse frasi; accanto a ogni
// passo il numero del modulo Make. Interruttore: impostazioni.relay_messaggi_primo (make / prova / si).
//
//   route 1   numero nuovo, testo senza «informazioni»  241 aggiorna_persona ATTESA_SCELTA → 162 benvenuto
//   route 12  numero nuovo, testo con «informazioni»    10003 messaggio_informazioni_whatsapp → 10004
//   route 2   ATTESA_SCELTA + pulsante CHAT_NORMALE     242 aggiorna_persona NON_INTERESSATO (nessun invio)
//   route 3   ATTESA_SCELTA + pulsante GIORNALE_LAVORI  243 aggiorna_persona ATTESA_SCELTA → 165 «serve l'invito»
//   route 4   ATTESA_SCELTA, qualunque altra cosa        166 «Come posso aiutarti?»
//   route 5   NON_INTERESSATO                            stop: nessuna risposta
//   route 11  REGISTRATO senza azienda                   197 trova_azienda_da_testo → 249 + 201, oppure 200
//
// Lascia a Make: i passi vecchi della registrazione (ATTESA_NOME_COMPLETO, ATTESA_IMPRESA, ATTESA_EMAIL,
// ATTESA_RUOLO, ATTESA_AZIENDA: dal 09/11 nessuno ci si trova), ogni altro stato, chi e' REGISTRATO con
// un'azienda (non e' un primo contatto) e i tipi che Make scarta al filtro del 9600.
// Le foto e i documenti di chi non e' registrato vanno allo scenario delle foto: qui non arrivano.
// ============================================================================

const TIPI_MAKE = ["text", "interactive", "image", "location", "audio"];   // filtro «Real WhatsApp message» del 9600

function eMio(msg) { return !!(msg && TIPI_MAKE.indexOf(msg.type) !== -1 && msg.type !== "image"); }
function corpo(msg) { return String((msg.text && msg.text.body) || ""); }
function pulsante(msg) {
  const i = msg.interactive;
  return String((i && i.button_reply && i.button_reply.id) || "");   // {{264.messages[1].interactive.button_reply.id}}
}
function testo(t) { return { type: "text", text: { body: t, preview_url: false } }; }
function bottone(corpoTesto, id, titolo) {
  return { type: "interactive", interactive: { body: { text: corpoTesto }, type: "button",
    action: { buttons: [{ type: "reply", reply: { id, title: titolo } }] } } };
}

async function manda(c, payload, motivo) {
  const r = await c.invia(payload, motivo);
  if (!r || !r.ok) throw new Error("invio non riuscito (" + motivo + "): " + String((r && (r.status + " " + r.testo)) || "").slice(0, 160));
  return r;
}

const BENVENUTO = "Ciao, sono TIX, l'assistente digitale di cantiere (IA). Scrivi, fotografa o manda un vocale: lo registro nel diario di cantiere della tua impresa.\n\nCome posso aiutarti?";
const SOLO_INVITO = "Questo numero non è ancora collegato a un'impresa. Per usare TIX serve l'invito della tua impresa: chiedi al tuo referente di aggiungerti in «Persone del cantiere». Riceverai su WhatsApp un messaggio con il codice per attivarti.";
const CHIEDE_AZIENDA = "Il tuo numero non è registrato. Scrivi il nome dell’azienda principale che stai cercando (come risulta in Camera di Commercio, in MAIUSCOLO — esempio: MARIO ROSSI SRL):";

async function esegui(c) {
  const msg = c.msg, tel = c.telefono;
  if (!eMio(msg)) return false;

  const x = await c.rpc("contesto_messaggio", { p_telefono: tel, p_message_id: String(msg.id) }, 8000);   // 9600
  if (!x || typeof x !== "object") throw new Error("contesto_messaggio senza risposta");
  const stato = String(x.stato_registrazione || "");
  if (stato === "REGISTRATO" && x.azienda_nome) return false;      // 120 route 1: non e' un primo contatto

  const nuovo = String(x.persona_id || "") === "";
  const informazioni = corpo(msg).toLowerCase().indexOf("informazioni") !== -1;   // lower(…) text:contain

  if (nuovo && !informazioni) {                                                    // route 1
    await c.rpc("aggiorna_persona", { p_telefono: tel, p_stato: "ATTESA_SCELTA" }, 8000);                // 241
    c.segnaScritto();
    await manda(c, bottone(BENVENUTO, "GIORNALE_LAVORI", "Diario di cantiere"), "162_benvenuto");       // 162
    return true;
  }
  if (nuovo && informazioni) {                                                     // route 12 (errori ignorati: 10006/10007 Ignore)
    let r = null;
    try { r = await c.rpc("messaggio_informazioni_whatsapp", {}, 8000); } catch (e) { r = null; }         // 10003
    if (!r || !r.messaggio_json) return true;
    let t = null;
    try { t = JSON.parse(String(r.messaggio_json)); } catch (e) { t = null; }
    if (t === null) return true;
    await c.invia({ type: "interactive", interactive: { type: "button", body: { text: t },
      action: { buttons: [{ type: "reply", reply: { id: "GIORNALE_LAVORI", title: "Come attivarmi" } }] } } },
      "10004_informazioni");                                                                              // 10004
    return true;
  }
  if (stato === "ATTESA_SCELTA") {
    const id = pulsante(msg);
    if (id === "CHAT_NORMALE") {                                                   // route 2
      await c.rpc("aggiorna_persona", { p_telefono: tel, p_stato: "NON_INTERESSATO" }, 8000);           // 242
      c.segnaScritto();
      return true;
    }
    if (id === "GIORNALE_LAVORI") {                                                // route 3
      await c.rpc("aggiorna_persona", { p_telefono: tel, p_stato: "ATTESA_SCELTA" }, 8000);             // 243
      c.segnaScritto();
      await manda(c, testo(SOLO_INVITO), "165_solo_invito");                                            // 165
      return true;
    }
    await manda(c, bottone("Come posso aiutarti?", "GIORNALE_LAVORI", "Diario di cantiere"), "166_reg_scelta_non_valida"); // route 4 · 166
    return true;
  }
  if (stato === "NON_INTERESSATO") return true;                                    // route 5: stop, come Make
  if (stato === "REGISTRATO") {                                                    // route 11 (azienda vuota)
    const a = await c.rpc("trova_azienda_da_testo", { testo_input: corpo(msg) }, 8000);                  // 197
    const prima = Array.isArray(a) && a.length ? a[0] : null;
    if (prima && prima.id) {                                                       // 198 route 1
      await c.rpc("aggiorna_persona", { p_telefono: tel, p_azienda_id: prima.id }, 8000);                // 249
      c.segnaScritto();
      await manda(c, testo("Azienda cliente impostata: " + String(prima.nome_breve || "") + "."), "201_reg_azienda_impostata"); // 269 · 201
      return true;
    }
    await manda(c, testo(CHIEDE_AZIENDA), "200_reg_chiede_azienda");                // 198 route 2 · 200
    return true;
  }
  return false;                                                                    // passi vecchi e altri stati: Make
}

export const pezzoPrimo = {
  nome: "primo",
  riconosce: (msg) => eMio(msg),
  esegui
};

// Solo per il banco di prova
export const _primoProva = { BENVENUTO, SOLO_INVITO, CHIEDE_AZIENDA };
