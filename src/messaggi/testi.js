// ============================================================================
// MESSAGGI SU WA-RELAY — pezzo A2a «testi» (09/11/2026)
// COPIA del ramo 7 «New event only» dello scenario Make 7264624: il testo scritto (o il vocale gia' trascritto,
// id VOICE_…, o le parti _P1/_P2 della chat unica) che finisce nel diario. Stesse funzioni del database, stesso
// ordine, stesse frasi; accanto a ogni passo il numero del modulo Make. Interruttore: impostazioni.relay_messaggi_testi.
//
//   262  sessione (tabella sessioni_whatsapp: telefono + timestamp_selezione)
//   router 5:
//     route 2 «Nessun sito attivo»   9300 lista cantieri → 9830 parcheggia → 6 lista «Seleziona il cantiere…»
//     route 1 «Sezione mancante»     9840 parcheggia → 9841 lista «Messaggio ricevuto per … Scegli l'argomento…»
//     route 3 «Sezione nota»         9340 imposta sezione → router 106 route 1:
//                                    10010 registra_messaggio_completo → 138 risposta (di solito la spunta blu)
//                                    → 9460 correzione/traduzione con l'IA (Anthropic) → 10005 aggiorna_traduzione
//
// Lascia a Make, senza scrivere niente: chi non e' REGISTRATO con un'azienda, messaggio gia' visto, correzione di
// un DDT aperta (ramo 14), ore in economia pronte da registrare (router 106 route 2: foglio Google «Ore Economia»),
// e tutto se manca la chiave Anthropic del Worker (ANTHROPIC_API_KEY): senza, il passo 9460 non si potrebbe copiare.
// I comandi (OGGI, CERCA, CANTIERE…) sono del pezzo «comandi», qui non si prendono.
// ============================================================================

const TESTATA = "TIX · Assistente digitale di cantiere";
const RIGHE_SEZIONI = [
  { id: "SEZ_LAV", title: "Lavori", description: "" },
  { id: "SEZ_VISITA", title: "Sopralluogo", description: "" },
  { id: "SEZ_DDT", title: "Ddt", description: "" },
  { id: "SEZ_FIR", title: "Formulario", description: "" },
  { id: "SEZ_NOTE", title: "Note", description: "" },
  { id: "SEZ_SAL", title: "Sal", description: "" },
  { id: "SEZ_ECO", title: "Rapportino Ore Economie", description: "" }
];
// switch(upper(first(split(…; " "))); "LAV"; "LAV"; "LAVORAZIONI"; "LAV"; …) dei moduli 5, 9340 e 10010
const PAROLE_SEZIONE = { LAV: "LAV", LAVORAZIONI: "LAV", VISITA: "VISITA", DDT: "DDT", FIR: "FIR", FORMULARIO: "FIR", NOTE: "NOTE", SAL: "SAL" };
// testi che i rami 3-6 di Make trattano come comandi (esclusi dal ramo 7) e CANTIERE (pezzo «comandi»)
const COMANDI = ["OGGI", "IERI", "SETTIMANA", "SEZIONE", "SEZIONI", "ARGOMENTO", "CHIUDI", "CANTIERE"];
const MODELLO = "claude-sonnet-5";
const ISTRUZIONI = "Sei il correttore dei messaggi di un cantiere edile. Il testo delimitato da <<< >>> e' il messaggio di un operaio, scritto a mano oppure trascritto da un vocale. Se non e' in italiano, traducilo in italiano. Se e' in italiano, correggi solo refusi, punteggiatura, maiuscole e parole chiaramente trascritte male, senza riscrivere, riassumere o cambiare lo stile. Non cambiare MAI numeri, quantita', misure, importi, orari, date, nomi di persone, imprese e cantieri, sigle e termini di cantiere, e non aggiungere informazioni. Se non c'e' niente da correggere riportalo identico. Rispondi con UNA SOLA RIGA nel formato esatto: codice~~testo dove codice e' il codice ISO a due lettere della lingua di partenza (it, ro, sq, ar, en, ru, uk, fr, es) e testo e' la versione italiana corretta. Nessuna spiegazione, nessun a capo, nessun markdown. Se il testo e' vuoto rispondi soltanto it~~ ";

function corpo(msg) { return String((msg.text && msg.text.body) || ""); }
function sezioneDaParola(s) { return PAROLE_SEZIONE[s.split(" ")[0].toUpperCase()] || ""; }

function eMio(msg) {
  if (!msg || msg.type !== "text") return false;
  const t = corpo(msg).trim().toUpperCase();
  if (COMANDI.indexOf(t) !== -1) return false;
  if (t.split(" ")[0] === "CERCA") return false;
  return true;
}

function adesso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function quando(msg) {                                           // formatDate(addSeconds(1970-01-01; timestamp)) del 10010
  const s = Number(msg.timestamp);
  return isFinite(s) && s > 0 ? new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : adesso();
}
function lista(testo, righe) {
  return { type: "interactive", interactive: { body: { text: testo }, type: "list",
    action: { button: righe === RIGHE_SEZIONI ? "Sezione" : "Seleziona", sections: [{ rows: righe, title: righe === RIGHE_SEZIONI ? "Sezioni" : "Cantieri" }] },
    header: { text: TESTATA, type: "text" } } };
}
async function manda(c, payload, motivo, commessa) {
  const r = await c.invia(payload, motivo, commessa);
  if (!r || !r.ok) throw new Error("invio non riuscito (" + motivo + ")");
  return r;
}

// 9460 «Traduci in italiano»: errori ignorati come in Make (stopOnHttpError false, gestore «Resume»)
async function correggi(env, testo) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODELLO, max_tokens: 700, thinking: { type: "disabled" },
        messages: [{ role: "user", content: [{ type: "text", text: ISTRUZIONI + "<<<" + testo + ">>>" }] }] }),
      signal: ctrl.signal
    });
    const d = await r.json().catch(() => null);
    const blocco = d && Array.isArray(d.content) ? d.content.find((b) => b && b.type === "text") : null;
    return blocco ? String(blocco.text || "") : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function esegui(c) {
  const msg = c.msg, env = c.env, tel = c.telefono;
  if (!eMio(msg)) return false;
  if (!env.ANTHROPIC_API_KEY) return false;                       // senza chiave il 9460 non si copia: resta tutto a Make
  const testo = corpo(msg);

  const x = await c.rpc("contesto_messaggio", { p_telefono: tel, p_message_id: String(msg.id) }, 8000);   // 9600
  if (!x || typeof x !== "object") throw new Error("contesto_messaggio senza risposta");
  if (x.stato_registrazione !== "REGISTRATO" || !x.azienda_nome) return false;   // 120: registrazione, resta a Make
  if (Number(x.gia_visto_n) > 0) return false;                                    // ramo 9
  if (Number(x.attesa_correzione_n) !== 0) return false;                          // ramo 14 (correzione DDT)
  const ecoArmato = x.sezione_oggi === "ECO" && Number(x.eco_operai || 0) > 0 && Number(x.eco_ore || 0) > 0;
  if (ecoArmato) return false;                                                    // 106 route 2: foglio Google, resta a Make

  // 262 Supabase Sessione Upsert Testo
  await c.rest("sessioni_whatsapp?on_conflict=telefono", { telefono: tel, timestamp_selezione: adesso() }, "resolution=merge-duplicates");

  // router 5
  if (Number(x.riga_n) === 0 || String(x.nome_cantiere || "") === "") {          // route 2 «Nessun sito attivo»
    const r = await c.rpc("cantieri_per_whatsapp", { p_telefono: tel, p_pagina: 1 }, 8000);                         // 9300
    await c.rpc("sessione_salva_in_attesa", { p_telefono: tel, p_testo: testo }, 8000);                            // 9830
    c.segnaScritto();
    await manda(c, lista("Seleziona il cantiere su cui stai lavorando oggi:", JSON.parse("[" + String((r && r.righe_menu) || "") + "]")),
      "6_scelta_cantiere");                                                                                        // 6
    return true;
  }
  const sezioneNota = String(x.sezione_oggi || "") || sezioneDaParola(testo.trim());
  if (sezioneNota === "") {                                                       // route 1 «Sezione mancante»
    await c.rpc("sessione_salva_in_attesa", { p_telefono: tel, p_testo: testo }, 8000);                            // 9840
    c.segnaScritto();
    await manda(c, lista("Messaggio ricevuto per " + String(x.nome_cantiere || "") + ". Scegli l'argomento e lo registro subito:", RIGHE_SEZIONI),
      "9841_scelta_argomento", x.commessa_id);                                                                     // 9841
    return true;
  }
  // route 3 «Sito attivo presente, sezione nota»: 9340 e 10010 usano split senza trim, come in Make
  const sezione = sezioneDaParola(testo) || String(x.sezione_oggi || "") || "NOTE";
  await c.rpc("sessione_imposta_sezione", { p_telefono: tel, p_sezione: sezione }, 8000);                          // 9340
  const reg = await c.rpc("registra_messaggio_completo", { p_message_id: String(msg.id), p_timestamp_whatsapp: quando(msg),
    p_telefono: tel, p_sezione: sezione, p_testo: testo, p_imposta_sezione: false }, 10000);                       // 10010
  c.segnaScritto();
  if (reg && reg.wa_body) {                                                                                        // 138
    let p = null;
    try { p = typeof reg.wa_body === "string" ? JSON.parse(reg.wa_body) : reg.wa_body; } catch (e) { p = null; }
    if (p) await c.invia(p, "138_registrato", x.commessa_id);
  }
  const risposta = await correggi(env, testo);                                                                     // 9460
  if (risposta !== null && risposta !== "") {                                                                      // filtro del 10005
    const parti = risposta.split("~~");
    await c.rpc("aggiorna_traduzione_messaggio", { p_message_id: String(msg.id),
      p_testo_it: parti.slice(1).join("~~").trim(), p_lingua: parti[0].trim().toLowerCase() }, 8000).catch(() => null); // 10005
  }
  return true;
}

export const pezzoTesti = {
  nome: "testi",
  riconosce: (msg) => eMio(msg),
  esegui
};

// Solo per il banco di prova
export const _testiProva = { eMio, sezioneDaParola, quando, ISTRUZIONI };
