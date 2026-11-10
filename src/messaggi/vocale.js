// ============================================================================
// MESSAGGI SU WA-RELAY — pezzo A2c «vocale di riserva» (10/11/2026)
// COPIA del ramo 1 del router 13 dello scenario Make 7264624: il vocale che arriva a Make senza essere stato
// trascritto dalla chat unica (di solito non succede: tutti i vocali li trascrive la chat unica dentro wa-relay;
// questo ramo serve quando la chat unica non lo prende). Interruttore: impostazioni.relay_messaggi_vocale.
//
//   9600  contesto_messaggio   (router 120 route 1: REGISTRATO con un'azienda; filtro: messaggio non gia' visto)
//   9900  indirizzo del file presso Meta  ┐ qui: il link dell'archivio wa-media che wa-relay mette gia' nel
//   9903  scarica l'audio                 ┘ pacchetto (lo stesso che usa Make: ifempty(audio.link; …))
//   9906  trascrizione: qui con la STESSA trascrizione della chat unica (Whisper di Workers AI, con il glossario
//         dei vocali), al posto di OpenAI whisper-1 di Make. E' l'unica differenza voluta: cosi' tutti i vocali
//         passano dallo stesso strumento, e sul Worker non serve una chiave OpenAI.
//   9909  prepara_vocale(telefono, message_id, testo)   (testo nel campo p_c1, quello che Make riempie davvero)
//   9912  spunta di lettura sul vocale
//   9915  se rimanda_n = 1: il testo rientra come messaggio di testo con id VOICE_<id>, come se fosse arrivato
//         adesso (in Make: POST allo stesso webhook). Qui rientra da inoltraAMake: viene registrato in
//         ingresso_make e lo lavora il pezzo «testi» se e' acceso per quel numero, altrimenti va a Make.
//
// Lascia a Make, senza scrivere niente: chi non e' REGISTRATO con un'azienda (pezzo «primo»), il messaggio
// gia' visto, il vocale senza link dell'archivio, il Worker senza Workers AI, e la trascrizione che si ferma
// per un errore (Make riprova con il suo Whisper).
// ============================================================================

function eMio(msg) { return !!(msg && msg.type === "audio" && msg.audio); }

async function esegui(c) {
  const msg = c.msg, tel = c.telefono, env = c.env;
  if (!eMio(msg)) return false;
  if (!msg.audio.link || !env.AI || !c.trascrivi || !c.rientra) return false;    // senza questi resta a Make

  const x = await c.rpc("contesto_messaggio", { p_telefono: tel, p_message_id: String(msg.id) }, 8000);   // 9600
  if (!x || typeof x !== "object") throw new Error("contesto_messaggio senza risposta");
  if (x.stato_registrazione !== "REGISTRATO" || !x.azienda_nome) return false;   // 120: registrazione, non qui
  if (Number(x.gia_visto_n) > 0) return false;                                    // filtro «Vocale ricevuto»

  const testo = String((await c.trascrivi()) || "");                              // 9900 · 9903 · 9906
  const v = await c.rpc("prepara_vocale", { p_telefono: tel, p_message_id: String(msg.id),
    p_testo: null, p_c1: testo }, 8000);                                          // 9909
  if (!v || typeof v !== "object") throw new Error("prepara_vocale senza risposta");

  await c.invia({ status: "read", message_id: String(msg.id) }, "9912_letto");    // 9912 (non conta come scritto)

  if (Number(v.rimanda_n) !== 1) return true;                                     // filtro «Trascrizione riuscita»

  const nuovo = { from: String(msg.from), id: String(v.message_id_nuovo), type: "text",
    timestamp: String(msg.timestamp || ""), text: { body: String(v.testo || ""), preview_url: false } };   // 9915
  const pacchetto = Object.assign({}, c.bundle, { messages: [nuovo] });
  delete pacchetto.statuses;
  c.segnaScritto();                                     // da qui il testo e' in viaggio: il vocale non va piu' a Make
  const ok = await c.rientra(pacchetto);
  if (!ok) throw new Error("rientro del testo " + nuovo.id + " non riuscito");
  return true;
}

export const pezzoVocale = {
  nome: "vocale",
  riconosce: (msg) => eMio(msg),
  esegui
};
