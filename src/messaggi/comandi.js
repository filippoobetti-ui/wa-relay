// ============================================================================
// MESSAGGI SU WA-RELAY — pezzo A1 «comandi» (09/11/2026)
// COPIA dei rami dello scenario Make 7264624 «WhatsApp 1:1 → Giornale Lavori» per i comandi scritti e per le
// scelte dalle liste di Make. Stesse funzioni del database, stesso ordine, stesse frasi: accanto a ogni passo
// il numero del modulo Make. Interruttore: impostazioni.relay_messaggi_comandi (make / prova / si).
//
// Cosa prende (tutto il resto resta a Make):
//   testo  CHIUDI · SEZIONE / SEZIONI / ARGOMENTO · OGGI / IERI / SETTIMANA · CERCA … · CANTIERE
//   lista  CHIUDI_<id> · __ALTRI_CANTIERI__<n> · <id del cantiere> · SEZ_<sezione> (non SEZ_ECO) · __NUOVO_CANTIERE__
//   tipi che Make non lavora (filtro del modulo 9600): adesivi, reazioni, video, contatti, «unsupported»…
// Lascia a Make, senza scrivere niente: chi non e' REGISTRATO con un'azienda (router 120 → registrazione),
// correzione di un DDT aperta (si attiverebbe anche il ramo 14), messaggio gia' visto (ramo 9),
// SEZIONE senza cantiere (il ramo 7 lo tratterebbe come testo), «Altro», ECO_*, FIX_, SEZ_ECO.
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
const RIEPILOGO = { OGGI: [1, 0], IERI: [1, 1], SETTIMANA: [7, 0] };   // modulo 9400: p_giorni, p_offset_giorni
const SEZIONE_PAROLE = ["SEZIONE", "SEZIONI", "ARGOMENTO"];
const TIPI_MAKE = ["text", "interactive", "image", "location", "audio"]; // filtro «Real WhatsApp message» del 9600
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// upper(trim(testo)) e upper(first(split(trim(testo); " "))) come nei filtri di Make
function maiuscolo(msg) { return String((msg.text && msg.text.body) || "").trim().toUpperCase(); }
function primaParola(msg) { return String((msg.text && msg.text.body) || "").trim().split(" ")[0].toUpperCase(); }
function idLista(msg) {
  const i = msg.interactive;
  return i && i.type === "list_reply" && i.list_reply ? String(i.list_reply.id || "") : null;
}

function tipoComando(msg) {
  if (!msg || !msg.type) return null;
  if (msg.type === "text") {
    const t = maiuscolo(msg);
    if (t === "CHIUDI") return "chiudi";
    if (SEZIONE_PAROLE.indexOf(t) !== -1) return "sezione";
    if (RIEPILOGO[t]) return "riepilogo";
    if (primaParola(msg) === "CERCA") return "cerca";
    if (t === "CANTIERE") return "cantiere";
    return null;
  }
  if (msg.type === "interactive") {
    const id = idLista(msg);
    if (id === null) return null;
    if (id.startsWith("CHIUDI_")) return "lista_chiudi";
    if (id.startsWith("__ALTRI_CANTIERI__") && /^\d+$/.test(id.slice(18))) return "lista_altri";
    if (id === "__NUOVO_CANTIERE__") return "lista_nuovo";
    if (id.startsWith("SEZ_") && id !== "SEZ_ECO") return "lista_sezione";
    if (UUID.test(id)) return "lista_cantiere";
    return null;
  }
  // document e image vanno allo scenario delle foto; gli altri tipi Make li scarta al filtro del 9600
  if (TIPI_MAKE.indexOf(msg.type) === -1 && msg.type !== "document") return "scartato";
  return null;
}

function lista(corpo, pulsante, righe, titoloSezione, testata) {
  return { type: "interactive", interactive: {
    body: { text: corpo }, type: "list",
    action: { button: pulsante, sections: [{ rows: righe, title: titoloSezione }] },
    header: { text: testata, type: "text" } } };
}
function testo(t) { return { type: "text", text: { body: t, preview_url: false } }; }
function letto(msg) { return { status: "read", message_id: msg.id }; }
// «{{x.body.righe_menu}}» dentro "rows": [ … ] — il database da' le righe gia' scritte in JSON
function righe(frammento) { return JSON.parse("[" + String(frammento || "") + "]"); }
// «{{x.body.messaggio_json}}» — il database da' il testo gia' come stringa JSON
function daJson(s) { return JSON.parse(String(s)); }
function adesso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

// Invio che deve riuscire: se Meta lo rifiuta e non si e' scritto niente, il messaggio torna a Make.
async function manda(c, payload, motivo, commessa) {
  const r = await c.invia(payload, motivo, commessa);
  if (!r || !r.ok) throw new Error("invio non riuscito (" + motivo + "): " + String((r && (r.status + " " + r.testo)) || "").slice(0, 160));
  return r;
}

async function esegui(c) {
  const msg = c.msg;
  const tipo = tipoComando(msg);
  if (!tipo) return false;
  if (tipo === "scartato") return true;                          // 9600: filtro non superato, Make non fa niente

  // 9600 Contesto messaggio (RPC)
  const x = await c.rpc("contesto_messaggio", { p_telefono: c.telefono, p_message_id: String(msg.id) }, 8000);
  if (!x || typeof x !== "object") throw new Error("contesto_messaggio senza risposta");
  // 120 route 1 «Registrato»: altrimenti c'e' la registrazione (router 122), che resta a Make
  if (x.stato_registrazione !== "REGISTRATO" || !x.azienda_nome) return false;
  if (Number(x.gia_visto_n) > 0) return false;                    // ramo 9 «Stop duplicate»: lo lascio a Make
  if (msg.type === "text" && Number(x.attesa_correzione_n) === 1) return false; // si accenderebbe anche il ramo 14
  const tel = c.telefono;

  if (tipo === "chiudi") {                                        // ramo 3
    const r = await c.rpc("cantieri_da_chiudere_whatsapp", { p_telefono: tel }, 8000);   // 9360
    if (Number(r && r.autorizzato_n) === 1 && Number(r && r.righe_n) > 0) {               // 9363 route 1 → 9361
      await manda(c, lista("Quale cantiere vuoi chiudere? Sparirà dagli elenchi di tutti; il giornale resta consultabile.",
        "Scegli", righe(r.righe_menu), "Cantieri attivi", "Chiudi cantiere"), "9361_chiusura_lista");
    } else {                                                                                // 9363 route 2 → 9362
      await manda(c, testo(daJson(r && r.messaggio_json)), "9362_chiusura_negata");
    }
    return true;
  }

  if (tipo === "sezione") {                                       // ramo 4 (solo con il cantiere)
    if (Number(x.ha_cantiere_n) <= 0) return false;
    await manda(c, lista("Cantiere: " + String(x.nome_cantiere || "") + " - scegli l’argomento dei tuoi messaggi:",
      "Sezione", RIGHE_SEZIONI, "Sezioni", TESTATA), "9700_scelta_argomento_comando", x.commessa_id);   // 9700
    return true;
  }

  if (tipo === "riepilogo") {                                     // ramo 5
    const g = RIEPILOGO[maiuscolo(msg)];
    const r = await c.rpc("comando_riepilogo", { p_telefono: tel, p_giorni: g[0], p_offset_giorni: g[1] }, 15000); // 9400
    await manda(c, testo(daJson(r && r.testo_json)), "9401_riepilogo_comando", x.commessa_id);                    // 9401
    return true;
  }

  if (tipo === "cerca") {                                         // ramo 6
    const resto = String(msg.text.body || "").trim().split(" ").slice(1).join(" ").trim();
    const r = await c.rpc("comando_cerca", { p_telefono: tel, p_testo: resto }, 15000);                           // 9410
    await manda(c, testo(daJson(r && r.testo_json)), "9411_cerca", x.commessa_id);                                 // 9411
    return true;
  }

  if (tipo === "cantiere") {                                      // ramo 7 → 262 → router 5 route 2
    // 262 Supabase Sessione Upsert Testo (rifarlo non cambia niente: non conta come «scritto»)
    await c.rest("sessioni_whatsapp?on_conflict=telefono", { telefono: tel, timestamp_selezione: adesso() }, "resolution=merge-duplicates");
    const r = await c.rpc("cantieri_per_whatsapp", { p_telefono: tel, p_pagina: 1 }, 8000);                       // 9300
    await c.rpc("sessione_salva_in_attesa", { p_telefono: tel, p_testo: String(msg.text.body || "") }, 8000);    // 9830 (per CANTIERE non parcheggia)
    await manda(c, lista("Seleziona il cantiere su cui stai lavorando oggi:", "Seleziona", righe(r && r.righe_menu),
      "Cantieri", TESTATA), "6_scelta_cantiere");                                                                 // 6
    return true;
  }

  // ---- ramo 8: scelta da una lista (router 33)
  const id = idLista(msg);

  if (tipo === "lista_chiudi") {                                  // route 1
    const r = await c.rpc("chiudi_cantiere_whatsapp", { p_telefono: tel, p_commessa_id: id.slice(7) }, 10000);    // 9370
    c.segnaScritto();
    await c.invia(testo(daJson(r && r.messaggio_json)), "9371_chiusura_ok", id.slice(7));                          // 9371
    return true;
  }

  if (tipo === "lista_altri") {                                   // route 2
    const r = await c.rpc("cantieri_per_whatsapp", { p_telefono: tel, p_pagina: Number(id.slice(18)) }, 8000);    // 9350
    await manda(c, lista("Seleziona il cantiere su cui stai lavorando oggi:", "Seleziona", righe(r && r.righe_menu),
      "Cantieri", TESTATA), "9351_cantieri_pagina");                                                              // 9351
    return true;
  }

  if (tipo === "lista_cantiere") {                                // route 5 (riga c'e') / route 6 (riga nuova)
    const nuova = Number(x.riga_n) === 0;
    const r = await c.rpc("sessione_imposta_cantiere", { p_telefono: tel, p_commessa_id: id }, 8000);             // 9310 / 9320
    c.segnaScritto();
    await c.rest("sessioni_whatsapp?on_conflict=telefono", { telefono: tel, timestamp_selezione: adesso() }, "resolution=merge-duplicates"); // 209 / 210
    if (!nuova) {
      await c.invia(letto(msg));                                                                                  // 102 → 35
    } else {
      await c.invia(lista("✅ Cantiere salvato: " + String((r && r.nome_cantiere) || "") + " — Scegli l'argomento dei tuoi messaggi:",
        "Sezione", RIGHE_SEZIONI, "Sezioni", TESTATA), "37_cantiere_salvato", id);                                // 103 → 37
    }
    return true;
  }

  if (tipo === "lista_sezione") {                                 // route 7 (non ECO)
    const sez = id.slice(4);
    await c.rpc("sessione_imposta_sezione", { p_telefono: tel, p_sezione: sez }, 8000);                           // 9330
    c.segnaScritto();
    await c.invia(letto(msg));                                                                                    // 98 route 1 → 91
    if (String(x.messaggio_in_attesa || "") !== "") {                                                             // 98 route 2 → 275, 276, 208
      await c.rpc("registra_messaggio", { p_message_id: "PENDING_" + String(msg.id), p_timestamp_whatsapp: adesso(),
        p_telefono: tel, p_sezione: sez, p_testo: String(x.messaggio_in_attesa) }, 10000);
    }
    return true;
  }

  if (tipo === "lista_nuovo") {                                   // route 8
    const r = await c.rpc("richiedi_nuovo_cantiere_whatsapp", { p_telefono: tel }, 10000);                        // 9001
    c.segnaScritto();
    if (String(r && r.esito) !== "errore") {
      await c.invia(testo(daJson(r && r.messaggio_json)), "9003_nuovo_cantiere");                                 // 9002 route 1 → 9003
    } else {
      await c.invia(testo("⚠️ " + String((r && r.messaggio) || "")), "9004_nuovo_cantiere_errore");               // 9002 route 2 → 9004
    }
    return true;
  }

  return false;
}

export const pezzoComandi = {
  nome: "comandi",
  riconosce: (msg) => tipoComando(msg) !== null,
  esegui
};

// Solo per il banco di prova
export const _comandiProva = { tipoComando, righe, daJson };
