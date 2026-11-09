// ============================================================================
// MESSAGGI SU WA-RELAY — base (A0, 09/11/2026)
// Sposta da Make a wa-relay, un pezzo alla volta, il lavoro dei messaggi WhatsApp.
// Piano e manuale: cartella «Strumenti/whatsapp-wa-relay» del progetto TIX.
//
// REGOLE (valgono per ogni pezzo):
//  1. ogni pezzo COPIA un ramo dello scenario Make: stesse funzioni del database, stesso ordine, stesse frasi;
//     accanto a ogni passo si scrive il numero del modulo Make corrispondente;
//  2. le decisioni restano nel database: qui si chiama e si risponde, non si decide;
//  3. un file per pezzo in src/messaggi/, elencato in PEZZI qui sotto; index.js non si tocca piu'.
//
// INTERRUTTORI (tabella impostazioni, letti con relay_messaggi_config e tenuti in memoria 60 s):
//   relay_messaggi               no | si            generale: «no» = tutto a Make come prima
//   relay_messaggi_<pezzo>       make | prova | si  «prova» = solo i numeri di relay_messaggi_numeri_prova
//   relay_messaggi_numeri_prova  numeri separati da virgola
// Emergenza dal Worker, senza database: variabile RELAY_MESSAGGI=off.
//
// RISERVA: il pacchetto arriva qui da inoltraAMake DOPO essere stato registrato in ingresso_make («in invio»).
// Se nessun pezzo lo riconosce, se l'interruttore e' su make, se il database non risponde o se il pezzo si
// ferma PRIMA di aver scritto o mandato qualcosa, il pacchetto prosegue verso Make come sempre.
// Se il pezzo l'ha lavorato, la riga di ingresso_make diventa «gestito» con il ramo relay_<pezzo>.
// Se si ferma DOPO aver scritto, non va a Make (sarebbe un doppione): ramo relay_<pezzo>_errore e una riga
// nel registro chat_unica_eventi (tipo relay_messaggi).
// ============================================================================

// Pezzi costruiti. Ogni pezzo e' un oggetto con:
//   nome       uno di MESSAGGI_PEZZI_NOMI (e' anche la fine della chiave relay_messaggi_<nome>)
//   riconosce  (msg, bundle, origine) -> true / false: veloce, senza database
//   esegui     async (c) -> true se il messaggio e' stato lavorato; c e' il contesto preparato da contesto()
// Per aggiungere un pezzo: import { pezzoX } from "./x.js"; e metterlo in questo elenco.
// A1 (09/11/2026): comandi e scelte dalle liste (src/messaggi/comandi.js).
import { pezzoComandi } from "./comandi.js";
const PEZZI = [pezzoComandi];

export const MESSAGGI_PEZZI_NOMI = ["comandi", "testi", "primo", "foto", "ddt", "eco"];

let _cache = { t: 0, cfg: null };

function configVuota() {
  return { attivo: false, numeri_prova: [], pezzi: {}, phone_number_id: "", letta: false };
}

// Interruttori dal database, in memoria 60 s. Database fermo = tutto spento (tutto a Make).
export async function messaggiConfig(env, aiuti, forza) {
  if (!env || !env.SUPABASE_SERVICE_KEY || !aiuti) return configVuota();
  const ora = Date.now();
  if (!forza && _cache.cfg && ora - _cache.t < 60000) return _cache.cfg;
  let cfg = configVuota();
  try {
    const r = await aiuti.rpc(env, "relay_messaggi_config", {}, 3000);
    if (r && typeof r === "object" && !Array.isArray(r)) {
      cfg = {
        attivo: r.attivo === true,
        numeri_prova: (Array.isArray(r.numeri_prova) ? r.numeri_prova : [])
          .map((x) => String(x).replace(/[^0-9]/g, "")).filter(Boolean),
        pezzi: (r.pezzi && typeof r.pezzi === "object" && !Array.isArray(r.pezzi)) ? r.pezzi : {},
        phone_number_id: String(r.phone_number_id || ""),
        letta: true
      };
    }
  } catch (e) {}
  _cache = { t: ora, cfg };
  return cfg;
}

// Posizione dell'interruttore di un pezzo per un numero: «make», «prova» o «si».
export function messaggiPosizione(cfg, nome, telefono) {
  if (!cfg || cfg.attivo !== true) return "make";
  const p = String((cfg.pezzi || {})[nome] || "make");
  if (p === "si") return "si";
  if (p === "prova") {
    const tel = String(telefono || "").replace(/[^0-9]/g, "");
    return tel && (cfg.numeri_prova || []).indexOf(tel) !== -1 ? "prova" : "make";
  }
  return "make";
}

// Etichetta degli invii, letta dal contatore wa_uscita: sorgente|modulo|motivo|commessa
export function messaggiEtichetta(nome, motivo, commessa) {
  const pulito = (s) => String(s || "").replace(/\|/g, "/").slice(0, 120);
  return ("relay|messaggi_" + pulito(nome) + "|" + pulito(motivo) + "|" + pulito(commessa) + "|").slice(0, 512);
}

function contesto(env, bundle, msg, origine, aiuti, cfg, nome, posizione) {
  const c = {
    env, bundle, msg, origine, aiuti, cfg,
    pezzo: nome, posizione,
    telefono: String(msg.from || ""),
    phoneId: String((bundle.metadata && bundle.metadata.phone_number_id) || cfg.phone_number_id || ""),
    scritto: false
  };
  // Da chiamare appena il pezzo scrive qualcosa nel database: da quel momento il pacchetto non va piu' a Make.
  c.segnaScritto = () => { c.scritto = true; };
  c.rpc = (nomeRpc, corpo, ms) => aiuti.rpc(env, nomeRpc, corpo, ms);
  // Scrittura diretta in una tabella (come i moduli «Supabase … Upsert» di Make): POST /rest/v1/<percorso>.
  c.rest = (percorso, corpo, prefer, ms) => messaggiRest(env, percorso, corpo, prefer, ms);
  // Invio a chi ha scritto. Un messaggio vero mandato conta come «scritto» (a Make sarebbe una risposta doppia);
  // la spunta di lettura ({status:"read"}) no.
  c.invia = async (payload, motivo, commessa) => {
    const p = Object.assign({ messaging_product: "whatsapp" }, payload || {});
    if (!p.status && !p.to) p.to = c.telefono;
    const et = p.status ? undefined : messaggiEtichetta(nome, motivo || p.type, commessa);
    const r = await aiuti.invia(c.phoneId, env.WHATSAPP_TOKEN, p, et);
    if (!p.status && r && r.ok) c.scritto = true;
    return r;
  };
  return c;
}

// POST su una tabella di Supabase con la chiave di servizio (stessa forma delle chiamate «makeAnApiCall» di Make).
async function messaggiRest(env, percorso, corpo, prefer, ms) {
  const url = (env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co") + "/rest/v1/" + percorso;
  const svc = env.SUPABASE_SERVICE_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const h = { Authorization: "Bearer " + svc, apikey: svc, "Content-Type": "application/json" };
    if (prefer) h.Prefer = prefer;
    const r = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(corpo), signal: ctrl.signal });
    if (!r.ok) throw new Error(percorso.split("?")[0] + " " + r.status);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// Riga nel registro chat_unica_eventi. Non deve MAI fermare il giro: un registro che non risponde non cambia
// l'esito (altrimenti un messaggio gia' lavorato finirebbe anche a Make).
async function registro(aiuti, env, c, esito, inizio, errore) {
  try {
    const dett = "pezzo " + c.pezzo + " · " + c.posizione + " · " + esito + " · " + (Date.now() - inizio) + " ms"
      + " · origine " + c.origine + (errore ? " · " + String(errore).slice(0, 300) : "");
    await aiuti.log(env, c.telefono, String(c.msg.id || ""), "relay_messaggi", dett);
  } catch (e) {}
}

// Punto unico chiamato da inoltraAMake. Ritorna null (il pacchetto va a Make come sempre) oppure
// { ramo } (lavorato qui: la riga di ingresso_make diventa «gestito» con quel ramo).
export async function messaggiRelay(env, bundle, origine, aiuti) {
  if (!env || env.RELAY_MESSAGGI === "off" || !PEZZI.length || !aiuti) return null;
  const msg = bundle && Array.isArray(bundle.messages) ? bundle.messages[0] : null;
  if (!msg || !msg.id || !msg.from) return null;
  let pezzo = null;
  for (const p of PEZZI) {
    let si = false;
    try { si = !!p.riconosce(msg, bundle, origine); } catch (e) { si = false; }
    if (si) { pezzo = p; break; }
  }
  if (!pezzo) return null;
  const cfg = await messaggiConfig(env, aiuti);
  const pos = messaggiPosizione(cfg, pezzo.nome, msg.from);
  if (pos === "make") return null;
  const c = contesto(env, bundle, msg, origine || "relay", aiuti, cfg, pezzo.nome, pos);
  const inizio = Date.now();
  try {
    const fatto = await pezzo.esegui(c);
    if (fatto) {
      await registro(aiuti, env, c, "fatto", inizio, null);
      return { ramo: "relay_" + pezzo.nome };
    }
    if (!c.scritto) {
      await registro(aiuti, env, c, "lasciato a Make", inizio, null);
      return null;
    }
    await registro(aiuti, env, c, "fermato dopo aver scritto (non va a Make)", inizio, null);
    return { ramo: "relay_" + pezzo.nome + "_errore" };
  } catch (e) {
    const err = (e && e.message) || e;
    if (!c.scritto) {
      await registro(aiuti, env, c, "errore prima di scrivere: a Make", inizio, err);
      return null;
    }
    await registro(aiuti, env, c, "errore dopo aver scritto (non va a Make)", inizio, err);
    return { ramo: "relay_" + pezzo.nome + "_errore" };
  }
}

// Riga per /stato: interruttori letti adesso dal database (mai valori segreti).
export async function messaggiStato(env, aiuti) {
  if (env && env.RELAY_MESSAGGI === "off") return "RELAY_MESSAGGI (messaggi su wa-relay): spento dal Worker";
  const cfg = await messaggiConfig(env, aiuti, true);
  const nomi = PEZZI.map((p) => p.nome);
  const pezzi = MESSAGGI_PEZZI_NOMI.map((n) => n + " " + String((cfg.pezzi || {})[n] || "make")).join(", ");
  return "RELAY_MESSAGGI (messaggi su wa-relay, piano A/B): "
    + (cfg.letta ? "generale " + (cfg.attivo ? "si" : "no") : "interruttori non letti (tutto a Make)")
    + " · pezzi nel codice: " + (nomi.length ? nomi.join(", ") : "nessuno")
    + " · posizioni: " + pezzi
    + " · numeri in prova: " + (cfg.numeri_prova || []).length;
}
