// ============================================================================
// MESSAGGI SU WA-RELAY — pezzo B1 «foto» (10/11/2026)
// COPIA dello scenario Make 7462665 «Giornale Lavori — Foto e DDT»: foto e documenti mandati su WhatsApp.
// Stesse funzioni del database, stesso ordine; accanto a ogni passo il numero del modulo Make.
// Interruttore: impostazioni.relay_messaggi_foto (make / prova / si), numeri in relay_messaggi_numeri_foto.
//
// Due tempi, perché una foto con lettura della bolla può superare i 30 secondi che un Worker ha dopo la risposta
// a Meta:
//   1. pezzoFoto (dentro messaggiRelay): mette il pacchetto nella CODA di Cloudflare (CODA_MEDIA) e basta.
//   2. fotoCoda (gestore «queue» del Worker, fino a 15 minuti): fa il lavoro vero, un messaggio alla volta:
//        2     contesto_media
//        router 3, nell'ordine di Make (tutte le strade che passano il filtro):
//        R1 10-11  operativo e cartella del giorno da trovare: cerca su Drive → cartella_giorno_registra
//        R2 20-22  operativo e cartella da trovare: cartella_giorno_prenota → se crea_n = 1 crea su Drive → registra
//        R3 30-38  operativo: media_prepara → scarica (link dell'archivio wa-media, o Meta di riserva 31-32)
//                  → carica su Drive (33, se c'è la cartella) → registra_messaggio (34) → conferma (35)
//                  → per bolle e formulari: lettura con l'IA (36, corpo preparato dal database)
//                  → documento_attesa_salva_ai (37) → riepilogo con i tasti (38)
//        R4 40     da_registrare / senza_cantiere con wa_payload: risposta di servizio
//
// Riserva verso Make (come per gli altri pezzi, ma dalla coda):
//   - errore PRIMA di registra_messaggio (34): si riprova fino a 3 volte; poi il messaggio torna a Make
//     (ingresso_make_relay_esito «restituisci»: il reinvio ogni minuto lo manda allo scenario 7462665);
//   - errore DOPO registra_messaggio: niente più Make (sarebbe un doppione), ramo relay_foto_errore e riga
//     in errori_scenario come faceva Make (registra_errore_media).
// Senza coda (CODA_MEDIA) o senza chiave Google (GOOGLE_SA_KEY) il pezzo non prende niente: tutto a Make.
// ============================================================================

import { driveCercaCartella, driveCreaCartella, driveCarica } from "../google.js";

// stessa etichetta del contatore di base.js (copiata qui per non avere un import circolare con base.js)
function messaggiEtichetta(nome, motivo, commessa) {
  const pulito = (s) => String(s || "").replace(/\|/g, "/").slice(0, 120);
  return ("relay|messaggi_" + pulito(nome) + "|" + pulito(motivo) + "|" + pulito(commessa) + "|").slice(0, 512);
}
const attendi = (ms) => new Promise((r) => setTimeout(r, ms));
// passi dopo la riga del diario con i «Break» di Make (3 tentativi): qui si riprova sul posto
async function conTentativi(f, volte, pausaMs) {
  let ultimo = null;
  for (let i = 0; i < volte; i++) {
    try { return await f(); } catch (e) { ultimo = e; if (i < volte - 1) await attendi(pausaMs * (i + 1)); }
  }
  throw ultimo;
}
let PAUSA_MS = 20000;

const LIMITE_BYTE = 25 * 1024 * 1024;          // sopra i 25 MB il file resta a Make
const TENTATIVI = 3;                            // come i «Break» di Make (3 tentativi)
const GRAPH = "https://graph.facebook.com/v21.0";

function eMio(msg) { return !!(msg && (msg.type === "image" || msg.type === "document") && msg[msg.type]); }

// --- tempo 1: in coda -------------------------------------------------------------------------------------
async function esegui(c) {
  const msg = c.msg, env = c.env;
  if (!eMio(msg)) return false;
  if (!env.CODA_MEDIA || !env.GOOGLE_SA_KEY) return false;            // senza coda o senza Google: resta a Make
  await env.CODA_MEDIA.send({ bundle: c.bundle, origine: c.origine, posizione: c.posizione, messo_il: Date.now() });
  c.segnaScritto();                                                    // da qui il messaggio è della coda
  return true;
}

export const pezzoFoto = {
  nome: "foto",
  riconosce: (msg) => eMio(msg),
  esegui
};

// --- tempo 2: il lavoro dalla coda ------------------------------------------------------------------------
function quando(msg) {                                                // formatDate(addSeconds(1970-01-01; timestamp)) del 34
  const s = Number(msg.timestamp);
  return (isFinite(s) && s > 0 ? new Date(s * 1000) : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function corpoInvio(w) {
  if (!w) return null;
  if (typeof w === "object") return w;
  try { return JSON.parse(String(w)); } catch (e) { return null; }
}

class Fermo extends Error {                                           // errore con il passo e se si era già scritto
  constructor(passo, causa, scritto) { super(passo + ": " + String((causa && causa.message) || causa).slice(0, 300)); this.passo = passo; this.scritto = scritto; }
}

// Un messaggio della coda. Ritorna { esito: "fatto" } oppure lancia Fermo.
export async function lavoraMedia(job, env, aiuti) {
  const bundle = job.bundle || {};
  const msg = (bundle.messages || [])[0] || {};
  const tel = String(msg.from || ""), mid = String(msg.id || "");
  const media = msg[msg.type] || {};
  const phoneId = String((bundle.metadata && bundle.metadata.phone_number_id) || "");
  let scritto = false, passo = "";
  const rpc = (nome, corpo, ms) => aiuti.rpc(env, nome, corpo, ms || 10000);
  const invia = async (w, motivo, commessa) => {                     // invio di un corpo preparato dal database
    const p = corpoInvio(w);
    if (!p) return null;
    if (!p.messaging_product) p.messaging_product = "whatsapp";
    if (!p.status && !p.to) p.to = tel;
    const et = p.status || p.biz_opaque_callback_data ? undefined : messaggiEtichetta("foto", motivo, commessa);
    return await aiuti.invia(phoneId || String(v && v.wa_phone_number_id || ""), env.WHATSAPP_TOKEN, p, et);
  };
  let v = null;
  try {
    passo = "2 contesto_media";
    v = await rpc("contesto_media", { p_telefono: tel, p_message_id: mid });
    if (!v || typeof v !== "object") throw new Error("senza risposta");
    const operativo = v.esito_media === "operativo";
    const daTrovare = operativo && String(v.cartella_giorno_id || "") === "";

    if (daTrovare) {                                                   // R1 «Cartella da trovare»
      passo = "10 cerca cartella del giorno";
      const f = await driveCercaCartella(env, String(v.cartella_nome), String(v.drive_folder_id));
      if (f && f.id && f.name) {                                       // 11 «Solo se trovata»
        passo = "11 registra cartella trovata";
        await rpc("cartella_giorno_registra", { p_commessa_id: v.commessa_id, p_cartella_id: f.id, p_data: v.cartella_nome });
      }
    }
    if (daTrovare) {                                                   // R2 «Cartella da trovare»
      passo = "20 prenota creazione cartella";
      const pr = await rpc("cartella_giorno_prenota", { p_commessa_id: v.commessa_id, p_data: v.cartella_nome, p_message_id: mid });
      if (Number(pr && pr.crea_n) === 1) {                             // 21 «Creazione prenotata»
        passo = "21 crea cartella del giorno";
        const n = await driveCreaCartella(env, String(v.cartella_nome), String(v.drive_folder_id));
        passo = "22 registra cartella creata";
        await rpc("cartella_giorno_registra", { p_commessa_id: v.commessa_id, p_cartella_id: n.id, p_data: v.cartella_nome });
      }
    }
    if (operativo) {                                                   // R3 «Operativo»
      passo = "30 prepara archiviazione";
      const link = String(media.link || "");
      const pr = await rpc("media_prepara", { p_telefono: tel, p_message_id: mid, p_tipo: msg.type,
        p_mime: String(media.mime_type || ""), p_caption: String(media.caption || ""),
        p_nome_originale: String(media.filename || ""), p_link: link, p_data: String(v.cartella_nome || "") }, 15000);
      if (!pr || typeof pr !== "object") throw new Error("media_prepara senza risposta");

      passo = "32 scarica media";
      const dati = await scarica(env, link, String(media.id || ""));
      let file = null;
      if (String(pr.cartella_id || "") !== "") {                       // 33 «Cartella valida»
        passo = "33 carica su Drive";
        file = await driveCarica(env, String(pr.nome_file), String(pr.mime || ""), dati, String(pr.cartella_id));
      }
      passo = "34 registra nel giornale";
      await rpc("registra_messaggio", { p_message_id: mid, p_telefono: tel, p_sezione: String(pr.sezione || ""),
        p_testo: String(media.caption || ""), p_link_file: String((file && file.webViewLink) || ""), p_timestamp_whatsapp: quando(msg) });
      scritto = true;

      if (String(pr.conferma_wa || "") !== "") {                       // 35 «Conferma da mandare» (errori: Prosegui)
        passo = "35 conferma all'operaio";
        let rc = null;
        try { rc = await invia(pr.conferma_wa, "35_conferma", v.commessa_id); } catch (e) { rc = null; }
        if (!rc || !rc.ok) await errore(aiuti, env, 35, "Conferma all'operaio", tel, mid);
      }
      if (Number(pr.documento_n) === 1) {                              // 36 «Documento da leggere»
        passo = "36 leggi documento (IA)";
        const risposta = await conTentativi(() => leggiDocumento(env, pr.ai_body), TENTATIVI, PAUSA_MS);
        passo = "37 documento in attesa";
        const d = await conTentativi(() => rpc("documento_attesa_salva_ai", { p_telefono: tel, p_tipo: String(pr.documento || ""),
          p_link_foto: String((file && file.webViewLink) || ""), p_risposta: risposta, p_message_id: mid }, 15000), TENTATIVI, PAUSA_MS);
        if (d && String(d.wa_payload || "") !== "") {                  // 38 «Messaggio pronto»
          passo = "38 riepilogo e tasti";
          const r = await invia(d.wa_payload, "38_riepilogo", v.commessa_id);
          if (!r || !r.ok) throw new Error("invio non riuscito " + String((r && r.status) || ""));
        }
      }
    }
    const servizio = (v.esito_media === "da_registrare" || v.esito_media === "senza_cantiere") && String(v.wa_payload || "") !== "";
    if (servizio) {                                                    // R4 40 «Serve una risposta» (Break senza tentativi)
      passo = "40 risposta di servizio";
      let r = null;
      try { r = await invia(v.wa_payload, "40_servizio", v.commessa_id); } catch (e) { r = null; }
      if (!r || !r.ok) await errore(aiuti, env, 40, "Risposta di servizio", tel, mid);
    }
    return { esito: "fatto", media: v.esito_media };
  } catch (e) {
    throw new Fermo(passo, e, scritto);
  }
}

// 31-32: il file dall'archivio wa-media (link firmato messo dal relay) o, di riserva, da Meta
async function scarica(env, link, mediaId) {
  let url = link, auth = null;
  if (!url) {
    if (!mediaId || !env.WHATSAPP_TOKEN) throw new Error("niente link e niente id del media");
    const r = await fetch(GRAPH + "/" + encodeURIComponent(mediaId), { headers: { Authorization: "Bearer " + env.WHATSAPP_TOKEN } });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.url) throw new Error("Meta non dà l'indirizzo del media (" + r.status + ")");
    url = d.url; auth = "Bearer " + env.WHATSAPP_TOKEN;
  }
  const r = await fetch(url, auth ? { headers: { Authorization: auth } } : {});
  if (!r.ok) throw new Error("download " + r.status);
  const lung = Number(r.headers.get("content-length") || 0);
  if (lung > LIMITE_BYTE) throw new Error("file troppo grande (" + lung + " byte)");
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length > LIMITE_BYTE) throw new Error("file troppo grande (" + b.length + " byte)");
  return b;
}

// 36: lettura della bolla con l'IA, corpo preparato dal database (ai_body); risposta = content[1].text di Make
async function leggiDocumento(env, aiBody) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY mancante");
  const corpo = typeof aiBody === "string" ? aiBody : JSON.stringify(aiBody || {});
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: corpo, signal: ctrl.signal
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error("IA " + r.status + " " + String((d && d.error && d.error.message) || "").slice(0, 160));
    const blocco = d && Array.isArray(d.content) ? d.content.find((x) => x && x.type === "text") : null;
    return blocco ? String(blocco.text || "") : "";
  } finally {
    clearTimeout(t);
  }
}

// Riga d'errore come i gestori «Log errore» di Make (registra_errore_media)
async function errore(aiuti, env, moduloId, moduloNome, tel, mid) {
  try {
    await aiuti.rpc(env, "registra_errore_media", { p_modulo_id: moduloId, p_modulo_nome: moduloNome, p_telefono: tel, p_message_id: mid }, 8000);
  } catch (e) {}
}

// Gestore «queue» del Worker: un messaggio alla volta, riprova, riserva verso Make, registro.
export async function fotoCoda(batch, env, aiuti) {
  for (const m of batch.messages) {
    const job = m.body || {};
    const msg = ((job.bundle || {}).messages || [])[0] || {};
    const tel = String(msg.from || ""), mid = String(msg.id || "");
    const inizio = Date.now();
    const tentativo = Number(m.attempts || 1);
    const log = async (esito, extra) => {
      try {
        await aiuti.log(env, tel, mid, "relay_messaggi", "pezzo foto · coda · " + esito + " · " + (Date.now() - inizio) + " ms · tentativo " + tentativo
          + " · origine " + String(job.origine || "") + (extra ? " · " + String(extra).slice(0, 300) : ""));
      } catch (e) {}
    };
    try {
      const r = await lavoraMedia(job, env, aiuti);
      await log("fatto", r.media);
      m.ack();
    } catch (e) {
      const passo = String((e && e.passo) || "");
      const numero = parseInt(passo, 10) || 0;
      if (e && e.scritto) {                                            // dopo la riga del diario: niente Make
        await errore(aiuti, env, numero, passo, tel, mid);
        try { await aiuti.rpc(env, "ingresso_make_relay_esito", { p_message_id: mid, p_esito: "errore", p_dettaglio: e.message }, 8000); } catch (x) {}
        await log("errore dopo aver scritto (non va a Make)", e.message);
        m.ack();
      } else if (tentativo < TENTATIVI) {
        await log("errore prima di scrivere: riprovo", e && e.message);
        m.retry({ delaySeconds: 10 * tentativo });
      } else {                                                         // tentativi finiti: torna a Make
        let ok = false;
        try { ok = await aiuti.rpc(env, "ingresso_make_relay_esito", { p_message_id: mid, p_esito: "restituisci", p_dettaglio: e && e.message }, 8000); } catch (x) { ok = false; }
        await errore(aiuti, env, numero, passo, tel, mid);
        await log(ok === true ? "restituito a Make" : "restituzione a Make NON riuscita", e && e.message);
        m.ack();
      }
    }
  }
}

// Solo per il banco di prova
export const _fotoProva = { eMio, quando, LIMITE_BYTE, TENTATIVI, pausa: (ms) => { PAUSA_MS = ms; } };
