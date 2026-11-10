// ============================================================================
// MESSAGGI SU WA-RELAY — pezzo A2b «posizione» (10/11/2026)
// COPIA del ramo 2 del router 13 dello scenario Make 7264624: la posizione mandata dal telefono.
// Stesse funzioni del database, stesso ordine; accanto a ogni passo il numero del modulo Make.
// Interruttore: impostazioni.relay_messaggi_posizione (make / prova / si).
//
//   9600  contesto_messaggio   (router 120 route 1: REGISTRATO con un'azienda; filtro: messaggio non gia' visto)
//   9385  registra_posizione_v2(telefono, lat, lng, indirizzo, nome, message_id)
//   9386  invio di wa_body (la spunta blu oppure il testo di conferma preparato dal database)
//
// Lascia a Make, senza scrivere niente: chi non e' REGISTRATO con un'azienda (registrazione: pezzo «primo»)
// e il messaggio gia' visto.
// ============================================================================

function eMio(msg) { return !!(msg && msg.type === "location" && msg.location); }

// «{{9385.body.wa_body}}» e' il corpo intero dell'invio, scritto dal database (testo o spunta di lettura)
function corpoInvio(w) {
  if (!w) return null;
  if (typeof w === "object") return w;
  try { return JSON.parse(String(w)); } catch (e) { return null; }
}

async function esegui(c) {
  const msg = c.msg, tel = c.telefono;
  if (!eMio(msg)) return false;

  const x = await c.rpc("contesto_messaggio", { p_telefono: tel, p_message_id: String(msg.id) }, 8000);   // 9600
  if (!x || typeof x !== "object") throw new Error("contesto_messaggio senza risposta");
  if (x.stato_registrazione !== "REGISTRATO" || !x.azienda_nome) return false;   // 120: registrazione, non qui
  if (Number(x.gia_visto_n) > 0) return false;                                    // filtro «Posizione ricevuta»

  const l = msg.location;
  const r = await c.rpc("registra_posizione_v2", {                                                        // 9385
    p_telefono: tel, p_lat: l.latitude, p_lng: l.longitude,
    p_indirizzo: String(l.address || ""), p_nome: String(l.name || ""), p_message_id: String(msg.id)
  }, 8000);
  c.segnaScritto();
  const p = corpoInvio(r && r.wa_body);                                                                   // 9386
  if (!p) throw new Error("registra_posizione_v2 senza wa_body");
  const inv = await c.invia(p, "9386_posizione", x.commessa_id);
  if (!p.status && (!inv || !inv.ok)) {
    throw new Error("invio non riuscito (9386_posizione): " + String((inv && (inv.status + " " + inv.testo)) || "").slice(0, 160));
  }
  return true;
}

export const pezzoPosizione = {
  nome: "posizione",
  riconosce: (msg) => eMio(msg),
  esegui
};
