// ============================================================================
// MESSAGGI SU WA-RELAY — base (A0, 09/11/2026)
// Sposta da Make a wa-relay, un pezzo alla volta, il lavoro dei messaggi WhatsApp.
// Piano e manuale: cartella «Strumenti/whatsapp-wa-relay» del progetto TIX.
//
// REGOLE (valgono per ogni pezzo):
//  1. ogni pezzo COPIA un ramo dello scenario Make: stesse funzioni del database, stesso ordine, stesse frasi;
//     accanto a ogni passo si scrive il numero del modulo Make corrispondente;
//  2. le decisioni restano nel database: qui si chiama e si risponde, non si decide;
//  3. un file per pezzo in src/messaggi/, elencato in PEZZI qui sotto; index.js non si tocca piu'
//     (eccezione del 10/11/2026: in messaggiAiuti di index.js la trascrizione e il rientro per il pezzo «vocale»).
//
// INTERRUTTORI (tabella impostazioni, letti con relay_messaggi_config e tenuti in memoria 60 s):
//   relay_messaggi               no | si            generale: «no» = tutto a Make come prima
//   relay_messaggi_<pezzo>       make | prova | si  «prova» = solo i numeri di relay_messaggi_numeri_prova
//   relay_messaggi_numeri_prova  numeri separati da virgola (valgono per tutti i pezzi in «prova»)
//   relay_messaggi_numeri_<pezzo> facoltativo: se c'e', per quel pezzo vale questo elenco al posto di quello comune
//                                 (09/11/2026: per provare un pezzo su un solo numero mentre un altro e' gia' su un'impresa)
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
// A2a (09/11/2026): testi nel diario (src/messaggi/testi.js). L'ordine conta: prima i comandi, poi i testi.
import { pezzoTesti } from "./testi.js";
// A2b, A2c, A3 (10/11/2026): posizione, vocale di riserva, primo contatto (src/messaggi/posizione.js, vocale.js, primo.js).
import { pezzoPosizione } from "./posizione.js";
import { pezzoVocale } from "./vocale.js";
import { pezzoPrimo } from "./primo.js";
// B1 (10/11/2026): foto e documenti (src/messaggi/foto.js): mette il pacchetto nella coda CODA_MEDIA.
import { pezzoFoto } from "./foto.js";
// 10/11/2026: un pezzo che riconosce il messaggio ma lo lascia SENZA aver scritto niente (per esempio i testi
// di chi non e' ancora registrato) lo passa al pezzo successivo dell'elenco; dopo l'ultimo va a Make.
// Per questo «primo» sta in fondo: prende quello che gli altri lasciano.
const PEZZI = [pezzoComandi, pezzoTesti, pezzoPosizione, pezzoVocale, pezzoFoto, pezzoPrimo];

export const MESSAGGI_PEZZI_NOMI = ["comandi", "testi", "posizione", "vocale", "primo", "foto", "ddt", "eco"];

let _cache = { t: 0, cfg: null };

function configVuota() {
  return { attivo: false, numeri_prova: [], numeri_pezzi: {}, pezzi: {}, phone_number_id: "", letta: false };
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
        numeri_pezzi: numeriPerPezzo(r.numeri_pezzi),
        pezzi: (r.pezzi && typeof r.pezzi === "object" && !Array.isArray(r.pezzi)) ? r.pezzi : {},
        phone_number_id: String(r.phone_number_id || ""),
        letta: true
      };
    }
  } catch (e) {}
  _cache = { t: ora, cfg };
  return cfg;
}

// { pezzo: [numeri] } dal database; tutto il resto si scarta
function numeriPerPezzo(x) {
  const out = {};
  if (!x || typeof x !== "object" || Array.isArray(x)) return out;
  for (const k of Object.keys(x)) {
    if (Array.isArray(x[k])) out[k] = x[k].map((n) => String(n).replace(/[^0-9]/g, "")).filter(Boolean);
  }
  return out;
}

// Elenco dei numeri in prova per un pezzo: il suo, se c'e', altrimenti quello comune.
function numeriDelPezzo(cfg, nome) {
  const proprio = cfg && cfg.numeri_pezzi ? cfg.numeri_pezzi[nome] : null;
  return Array.isArray(proprio) ? proprio : ((cfg && cfg.numeri_prova) || []);
}

// Posizione dell'interruttore di un pezzo per un numero: «make», «prova» o «si».
export function messaggiPosizione(cfg, nome, telefono) {
  if (!cfg || cfg.attivo !== true) return "make";
  const p = String((cfg.pezzi || {})[nome] || "make");
  if (p === "si") return "si";
  if (p === "prova") {
    const tel = String(telefono || "").replace(/[^0-9]/g, "");
    return tel && numeriDelPezzo(cfg, nome).indexOf(tel) !== -1 ? "prova" : "make";
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
  // Trascrizione del vocale con lo strumento della chat unica (Whisper di Workers AI) e rientro di un pacchetto
  // nuovo da inoltraAMake (registro ingresso_make, pezzi accesi, altrimenti Make). Usati dal pezzo «vocale».
  c.trascrivi = aiuti.trascrivi ? () => aiuti.trascrivi(msg) : null;
  c.rientra = aiuti.rientra ? (pacchetto) => aiuti.rientra(pacchetto) : null;
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
  let cfg = null;
  for (const pezzo of PEZZI) {
    let si = false;
    try { si = !!pezzo.riconosce(msg, bundle, origine); } catch (e) { si = false; }
    if (!si) continue;
    if (!cfg) cfg = await messaggiConfig(env, aiuti);
    const pos = messaggiPosizione(cfg, pezzo.nome, msg.from);
    if (pos === "make") continue;                                  // spento per questo numero: si prova il pezzo dopo
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
        continue;                                                  // niente scritto: lo puo' prendere il pezzo dopo
      }
      await registro(aiuti, env, c, "fermato dopo aver scritto (non va a Make)", inizio, null);
      return { ramo: "relay_" + pezzo.nome + "_errore" };
    } catch (e) {
      const err = (e && e.message) || e;
      if (!c.scritto) {
        await registro(aiuti, env, c, "errore prima di scrivere: a Make", inizio, err);
        return null;                                               // con un errore non si prova altro: va a Make
      }
      await registro(aiuti, env, c, "errore dopo aver scritto (non va a Make)", inizio, err);
      return { ramo: "relay_" + pezzo.nome + "_errore" };
    }
  }
  return null;
}

// Riga per /stato: interruttori letti adesso dal database (mai valori segreti).
export async function messaggiStato(env, aiuti) {
  if (env && env.RELAY_MESSAGGI === "off") return "RELAY_MESSAGGI (messaggi su wa-relay): spento dal Worker";
  const cfg = await messaggiConfig(env, aiuti, true);
  const nomi = PEZZI.map((p) => p.nome);
  const pezzi = MESSAGGI_PEZZI_NOMI.map((n) => {
    const pos = String((cfg.pezzi || {})[n] || "make");
    const proprio = cfg.numeri_pezzi && Array.isArray(cfg.numeri_pezzi[n]);
    return n + " " + pos + (pos === "prova" && proprio ? " (" + cfg.numeri_pezzi[n].length + " numeri propri)" : "");
  }).join(", ");
  return "RELAY_MESSAGGI (messaggi su wa-relay, piano A/B): "
    + (cfg.letta ? "generale " + (cfg.attivo ? "si" : "no") : "interruttori non letti (tutto a Make)")
    + " · pezzi nel codice: " + (nomi.length ? nomi.join(", ") : "nessuno")
    + " · posizioni: " + pezzi
    + " · numeri in prova: " + (cfg.numeri_prova || []).length;
}
