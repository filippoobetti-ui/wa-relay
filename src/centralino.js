// ============================================================================
// CENTRALINO v3 (11/10/2026, piano 2) — assistente vocale NOSTRO sul centralino Hetzner.
// Il server (gl-voce) riceve la chiamata da Kamailio, ascolta con OpenAI Realtime (risposte SOLO testo)
// e fa parlare la voce giusta per la lingua: Alexandra (ElevenLabs) per l'italiano e le altre lingue,
// Anila (Microsoft Azure) per l'albanese. Le chiavi dei fornitori restano qui nel relay:
//   POST /centralino/sessione  → chiave OpenAI temporanea (2 minuti per collegarsi) + istruzioni della chiamata
//   POST /centralino/tts       → audio PCM 16 bit 24 kHz della frase, dal fornitore giusto per la lingua
//   GET  /centralino/saluti    → testi dei saluti (il server li sintetizza in anticipo)
//   POST /centralino/evento    → registro (inizio, fine con trascrizione, errori) in chat_unica_eventi
//   POST /centralino/riepilogo → riepilogo di fine chiamata: WhatsApp a chi ha chiamato + avviso a Filippo (12/10/2026)
//   GET  /centralino/pacchetto → configurazione di Kamailio e rtpengine + programma gl_voce.py per il server
// Tutte le rotte richiedono l'intestazione X-GL-Centralino con il token del centralino (impostazioni).
// Modo (variabile CENTRALINO_MODO nel pannello, altrimenti MODO_PREDEFINITO):
//   v2      = come prima (albanesi → OpenAI, altri → agente ElevenLabs)
//   fase_a  = albanesi → assistente nostro, altri → agente ElevenLabs
//   fase_b  = tutti → assistente nostro (l'agente ElevenLabs resta configurato, di riserva) — IN USO dall'11/10/2026 23:40
// Numeri di prova (NUMERI_PROVA): vanno all'assistente nostro anche in fase_a, con la lingua indicata.
// ============================================================================
import GL_VOCE_PY from "../tools/centralino/v3/gl_voce.py";
import KAMAILIO_V3_TPL from "../tools/centralino/v3/kamailio-v3.cfg.tpl";
import RTPENGINE_V3 from "../tools/centralino/v3/rtpengine-v3.conf";

export const CENTRALINO_VERSIONE = "centralino-4.1";
// 11/10/2026 23:40: fase_b per tutti, decisa da Filippo dopo la prova delle 23:34 («Ha funzionato tutto correttamente»).
// Per tornare indietro: "fase_a" (o "v2") qui, oppure la variabile CENTRALINO_MODO nel pannello Cloudflare.
const MODO_PREDEFINITO = "fase_b";
const AZURE_REGIONE = "swedencentral";
const OPENAI_PROGETTO_SIP = "proj_YeRqukJfU9TY6JUNXI7Maf5B";
const ELEVEN_AGENTE = "agent_3101m4n1bmrdekg98454f8t5v9fx";
const ELEVEN_VOCE = "kdmDKE6EkgrWrrykO9Qt"; // «Alexandra - Conversational and Natural», scelta da Filippo
const ELEVEN_MODELLO = "eleven_v4_turbo";
const MODELLO_BASE = "gpt-realtime-2.1-mini";
// Assistente nostro: modello completo (11/10/2026), l'albanese del mini era scorretto (senza ë/ç, grammatica debole).
// Risponde solo per iscritto: circa 0,08 $ a chiamata. Si cambia con la variabile CENTRALINO_MODELLO del relay.
const BOT_MODELLO = "gpt-realtime-2.1";

// Voci Microsoft: l'albanese sempre (ElevenLabs non lo parla); l'italiano solo come riserva se ElevenLabs non risponde.
const AZURE_VOCI = {
  sq: ["sq-AL", "sq-AL-AnilaNeural"],
  it: ["it-IT", "it-IT-IsabellaNeural"]
};
// Lingue parlate da Eleven v4 / v4 Turbo (codici a due lettere).
const ELEVEN_LINGUE = new Set(("af am ar hy as az be bn bs bg my ca hr cs da nl en et tl fil fi fr ff gl ka de el gu ha he hi hu is id it ja jv kn kk ko ky lo lv " +
  "ln lt lg lb mk ms ml mt zh mi mr mn ne no nb oc or ps fa pl pt pa ro ru sr sn sd sk sl so ku es sw sv tg ta te th tr uk ur uz vi cy wo zu").split(" "));

// Saluti (12/10/2026, decisione di Filippo; 16/10/2026: nome precedente sostituito da Tix): l'assistente si chiama Tix (si scrive TIX, si pronuncia «Tix»), e dice subito
// di essere un'assistente virtuale (AI Act, art. 50: chi parla con un'intelligenza artificiale deve saperlo).
// Valgono questi, non il primo messaggio dell'agente ElevenLabs (rimasto solo di riserva).
const BOT_SALUTI = {
  it: "Ciao, sono Tix, l'assistente virtuale di Tix Diario di cantiere. Come posso aiutarti?",
  sq: "Përshëndetje, jam Tix, asistentja virtuale e Tix Diario di cantiere. Si mund t'ju ndihmoj?"
};

// Numeri di prova (11/10/2026, fase B): vanno all'assistente nostro anche in fase_a, con la lingua scelta qui.
// "it" = come un chiamante italiano (saluto e risposte con Alexandra), "sq" = come un chiamante albanese (Anila).
// Prevalgono sull'elenco dei numeri albanesi (impostazione centralino_numeri_albanesi).
const NUMERI_PROVA = { "393775371209": "it" }; // telefono di Filippo

// Copia del prompt dell'agente ElevenLabs (11/10/2026): si usa se il prompt dell'agente non è leggibile.
const BOT_PROMPT_BASE = [
  "Sei l'assistente telefonica di TIX Diario di cantiere, un servizio italiano per le imprese edili. Rispondi alle chiamate WhatsApp al posto di un operatore: non esistono operatori umani a cui passare la chiamata e non devi mai promettere richiamate da parte di persone.",
  "Come parli: in italiano, con tono caldo, cordiale e professionale. Frasi brevi e chiare, una domanda alla volta. È una telefonata: niente elenchi, simboli o abbreviazioni. Se chi chiama parla un'altra lingua, rispondi nella sua lingua.",
  "Cos'è TIX (prima si chiamava «Il Giornale Lavori»): chi lavora in cantiere scrive su WhatsApp a questo numero (testi, foto, vocali, documenti di trasporto) e il servizio prepara in automatico la bozza del diario di cantiere, giorno per giorno. Gli operai non devono installare nessuna app. L'impresa consulta i suoi cantieri da un'app web. I cantieri sono illimitati e si paga in base alle persone dell'impresa che scrivono; subappaltatori e fornitori scrivono senza costi per l'impresa. Con il mensile si paga ogni mese, dal primo, senza mesi compresi; con l'annuale si pagano 12 mensilità e il servizio dura 14 mesi. L'attivazione è automatica. Non parlare mai di prova gratuita.",
  "Prezzi: non dare cifre. Il listino completo si richiede dal sito www.tixcantiere.it, che è in arrivo; nel frattempo invita a scrivere in chat WhatsApp a questo stesso numero.",
  "Se chi chiama lavora già in cantiere: spiega che basta scrivere qui in chat come sempre, testi, foto, documenti o vocali; dopo ogni messaggio arriva la conferma con la spunta verde. Se la conferma non arriva, rimandare il messaggio dopo qualche minuto; se il problema continua, avvisare l'ufficio della propria impresa.",
  "Se non conosci la risposta, dillo con semplicità e invita a scrivere la domanda in chat WhatsApp a questo numero. Non inventare mai informazioni, nomi di clienti o cantieri.",
  "Tieni la chiamata breve: quando la persona ha avuto la risposta, saluta e chiudi la conversazione con cortesia.",
  "Cosa non puoi fare: durante la telefonata non puoi inviare email, messaggi WhatsApp, documenti o riepiloghi, e non puoi registrare dati. Non promettere mai invii, registrazioni o conferme scritte. Se chi chiama vuole lasciare dati (nome dell'impresa, cantiere, contatti) o ricevere informazioni per iscritto, invitalo a scriverli in chat WhatsApp a questo stesso numero."
].join("\n\n");

// Mestieri del sito (sezione «Per chi è», nastro dei 50 mestieri del 10/10/2026). Aggiunto l'11/10 dopo la prova
// delle 23:34: alla domanda sul movimento terra l'assistente rispondeva «non lo so con certezza».
const BOT_PER_CHI = "PER CHI È: TIX è per chi lavora in cantiere, a qualsiasi titolo: imprese edili, imprese specialistiche e artigiani. " +
  "Per esempio muratori, cartongessisti, pittori, idraulici, termoidraulici, elettricisti, ferraioli, carpentieri, piastrellisti, serramentisti, lattonieri, " +
  "movimento terra, impermeabilizzazioni, intonacatori, cappottisti, ponteggiatori, pali e fondazioni, calcestruzzi e pompaggio, prefabbricati, demolizioni, " +
  "restauro, parquettisti, posatori di pavimenti, resinatori, marmisti, falegnami, fabbri, vetrai, controsoffittisti, isolamento termico e acustico, " +
  "frigoristi e climatizzazione, fotovoltaico, antincendio, ascensoristi, impianti speciali, coperture e tetti, asfaltisti, strade e fognature, segnaletica, " +
  "recinzioni, giardinieri e verde, noleggio mezzi e gru, bonifiche amianto, trasporto e smaltimento rifiuti, pulizie di cantiere, direttori lavori, " +
  "coordinatori della sicurezza, general contractor e manutenzione immobili. Se chiedono di un mestiere che lavora in cantiere, anche se non è in questo " +
  "elenco, la risposta è sì. Al telefono non elencare tutti i mestieri: citane al massimo due o tre.";

function botIstruzioni(promptBase, saluto) {
  return [
    promptBase || BOT_PROMPT_BASE,
    "IDENTITÀ: ti chiami Tix (si scrive TIX) e sei l'assistente virtuale di TIX Diario di cantiere, realizzata con intelligenza artificiale: non sei una persona. Se te lo chiedono, dillo con chiarezza; non fingere mai di essere una persona.",
    BOT_PER_CHI,
    "RIEPILOGO SU WHATSAPP: alla fine della telefonata chi chiama riceve in automatico, in questa stessa chat WhatsApp, un riepilogo scritto della chiamata, con un pulsante per confermarlo o correggerlo. Puoi dirlo, per esempio «a fine chiamata ti arriva un riepilogo qui su WhatsApp». Per il riepilogo questa regola sostituisce quanto detto in «Cosa non puoi fare»: i dati detti al telefono finiscono nel riepilogo e non serve riscriverli in chat. È l'unico invio che avviene: niente email, documenti, richiamate o altri messaggi. Se chi chiama ha una richiesta concreta (un'impresa interessata al servizio, un'attivazione, un problema da risolvere), chiedi con naturalezza, una cosa per volta, il nome, l'impresa e, se c'entra, il cantiere; poi ripeti i dati principali per conferma. Non chiedere dati che non servono.",
    "LINGUE: rispondi sempre nella lingua in cui ti parla la persona. In cantiere moltissimi operai parlano solo albanese: se la persona parla albanese (shqip), rispondi in albanese con frasi brevi, semplici e chiare, come si parla in cantiere. Se la persona cambia lingua a metà chiamata, cambia anche tu. Non tradurre il nome «TIX Diario di cantiere».",
    "ALBANESE CORRETTO: quando parli albanese usa l'albanese standard con ortografia e grammatica corrette, sempre con le lettere ë e ç dove servono (për, është, një, çfarë…); mai testo senza accenti o con parole italiane.",
    "ETICHETTA DELLA LINGUA (obbligatoria): inizia OGNI risposta con il codice della lingua in cui rispondi, tra parentesi quadre: [it] italiano, [sq] albanese, [ro] rumeno, [ar] arabo, [en] inglese, [fr] francese, [es] spagnolo, [uk] ucraino, [ru] russo, [bn] bengalese, [ur] urdu, [pa] punjabi, [hi] hindi, [tr] turco, [pl] polacco, [sr] serbo, [mk] macedone, [zh] cinese; per le altre lingue il codice ISO a due lettere. L'etichetta non viene letta ad alta voce: non ripeterla mai dentro la frase.",
    "STILE: è una telefonata. Scrivi solo frasi da pronunciare: niente elenchi, simboli, emoji, asterischi, link o abbreviazioni. Risposte brevi: di solito una o due frasi.",
    "INTERRUZIONI: se la persona ti interrompe o dice «fermati», «aspetta», «un attimo», «stop», «basta» o simili, vuol dire che vuole parlare lei: NON chiudere la chiamata. Smetti, rispondi con una frase brevissima (per esempio «Certo, dimmi pure.») e ascolta.",
    "CHIUSURA: chiudi la chiamata solo quando la persona ti saluta o dice chiaramente che non ha altre domande. In quella stessa risposta di' prima una breve frase di saluto e subito dopo chiama la funzione termina_chiamata. Se non sei sicuro che voglia chiudere, chiedi se puoi esserle utile in altro.",
    "La chiamata è già iniziata: hai già salutato dicendo «" + saluto + "». Non ripetere il saluto iniziale."
  ].join("\n\n");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" }
  });
}

function uguali(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function xmlEsc(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function conTimeout(url, opzioni, ms) {
  // Il limite vale fino all'arrivo delle intestazioni: il corpo (audio) può poi scorrere senza limiti.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opzioni, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

export function centralinoModo(env) {
  const m = String(env.CENTRALINO_MODO || MODO_PREDEFINITO).trim().toLowerCase();
  return ["v2", "fase_a", "fase_b"].includes(m) ? m : MODO_PREDEFINITO;
}

let _token = { v: "", t: 0 };
async function tokenCentralino(aiuti) {
  if (_token.v && Date.now() - _token.t < 300000) return _token.v;
  try {
    const v = await aiuti.rpc("centralino_token", {}, 3000);
    if (v) _token = { v: String(v).trim(), t: Date.now() };
  } catch (e) {}
  return _token.v;
}

let _agente = { v: null, t: 0 };
async function elevenAgente(env) {
  // Prompt, primo messaggio e voce letti dall'agente ElevenLabs: si modificano dal pannello ElevenLabs.
  if (!env.ELEVENLABS_API_KEY) return null;
  // letto ogni 5 minuti; se la lettura non riesce si riprova dopo 1 minuto (nel frattempo valgono i dati di prima)
  if (Date.now() - _agente.t < (_agente.v ? 300000 : 60000)) return _agente.v;
  _agente.t = Date.now();
  try {
    const r = await conTimeout("https://api.elevenlabs.io/v1/convai/agents/" + ELEVEN_AGENTE,
      { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } }, 4000);
    if (r.ok) {
      const j = await r.json();
      const cc = j.conversation_config || {};
      const tts = cc.tts || {};
      const ag = cc.agent || {};
      _agente = {
        t: Date.now(),
        errore: "",
        v: {
          prompt: String((ag.prompt && ag.prompt.prompt) || "").trim(),
          primo: String(ag.first_message || "").trim(),
          voce: String(tts.voice_id || "").trim(),
          modello: String(tts.model_id || "").trim(),
          stabilita: tts.stability, somiglianza: tts.similarity_boost, velocita: tts.speed,
          // impostazioni di privacy dell'agente (conservazione delle conversazioni): solo per /stato e per il kit legale
          privacy: (j.platform_settings && j.platform_settings.privacy) || null
        }
      };
    } else {
      _agente.errore = "ElevenLabs risponde " + r.status;
    }
  } catch (e) {
    _agente.errore = "lettura non riuscita";
  }
  return _agente.v;
}

function voceEleven(ag) {
  return (ag && /^[A-Za-z0-9]{20}$/.test(ag.voce)) ? ag.voce : ELEVEN_VOCE;
}

// Voce che /centralino/tts userà per prima per la lingua: il server rifà i saluti quando cambia
// (chiave ElevenLabs aggiunta o tolta, voce o impostazioni della voce cambiate nell'agente).
function vocePrevista(env, l, ag) {
  if (l === "sq" || (!ELEVEN_LINGUE.has(l) && AZURE_VOCI[l])) return "azure " + AZURE_VOCI[l][1];
  if (!env.ELEVENLABS_API_KEY) return "azure " + (AZURE_VOCI[l] || AZURE_VOCI.it)[1];
  const imp = ag ? [ag.stabilita, ag.somiglianza, ag.velocita].map((x) => (typeof x === "number" ? x : "-")).join("/") : "-";
  return "elevenlabs " + voceEleven(ag) + " " + (env.ELEVEN_MODELLO || ELEVEN_MODELLO) + " " + imp;
}

async function ttsEleven(env, testo) {
  if (!env.ELEVENLABS_API_KEY) return { ok: false, fornitore: "elevenlabs", errore: "chiave assente" };
  const ag = await elevenAgente(env);
  const voce = voceEleven(ag);
  const corpo = { text: testo, model_id: env.ELEVEN_MODELLO || ELEVEN_MODELLO };
  const imp = {};
  if (ag && typeof ag.stabilita === "number") imp.stability = ag.stabilita;
  if (ag && typeof ag.somiglianza === "number") imp.similarity_boost = ag.somiglianza;
  if (ag && typeof ag.velocita === "number") imp.speed = ag.velocita;
  if (Object.keys(imp).length) corpo.voice_settings = imp;
  try {
    const r = await conTimeout("https://api.elevenlabs.io/v1/text-to-speech/" + voce + "/stream?output_format=pcm_24000", {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(corpo)
    }, 8000);
    if (!r.ok) return { ok: false, fornitore: "elevenlabs", errore: r.status + " " + (await r.text()).slice(0, 200) };
    return { ok: true, fornitore: "elevenlabs", body: r.body, storia: String(r.headers.get("history-item-id") || "").trim() };
  } catch (e) {
    return { ok: false, fornitore: "elevenlabs", errore: String((e && e.message) || e).slice(0, 200) };
  }
}

// PRIVACY (12/10/2026): ElevenLabs salva ogni sintesi fatta via API nella cronologia dell'account (testo e audio
// delle risposte di Tix), salvo la «conservazione zero», riservata ai clienti enterprise. Appena la voce è stata
// inviata al centralino la cancelliamo (DELETE /v1/history/{id}): il servizio non tiene copie delle risposte.
// L'id arriva nell'intestazione «history-item-id»; la voce compare in cronologia con qualche secondo di ritardo,
// quindi si aspetta 3 s e, se non riesce, si riprova una volta dopo altri 8 s. Errori nel registro al massimo 1 volta l'ora.
let _storiaErrore = 0;
const _storiaConta = { ok: 0, ko: 0 };
async function storiaElevenErrore(aiuti, testo) {
  _storiaConta.ko++;
  if (Date.now() - _storiaErrore < 3600000) return;
  _storiaErrore = Date.now();
  try { await aiuti.log("centralino", "voce_bot_errore", "cronologia ElevenLabs: " + testo); } catch (e) {}
}
async function cancellaStoriaEleven(env, aiuti, id, attese) {
  if (!/^[A-Za-z0-9]{8,64}$/.test(String(id || ""))) {
    await storiaElevenErrore(aiuti, "la sintesi non ha restituito l'intestazione history-item-id, voce non cancellata");
    return false;
  }
  let ultimo = "";
  for (const attesa of (attese || [3000, 8000])) {
    if (attesa) await new Promise((ok) => setTimeout(ok, attesa));
    try {
      const r = await conTimeout("https://api.elevenlabs.io/v1/history/" + id,
        { method: "DELETE", headers: { "xi-api-key": env.ELEVENLABS_API_KEY } }, 5000);
      if (r.ok) { _storiaConta.ok++; return true; }
      ultimo = r.status + " " + (await r.text()).slice(0, 160);
      if (r.status === 401 || r.status === 403) break; // permessi della chiave: inutile riprovare
    } catch (e) {
      ultimo = String((e && e.message) || e).slice(0, 160);
    }
  }
  await storiaElevenErrore(aiuti, "voce " + id + " non cancellata (" + ultimo + ")");
  return false;
}

// Rete di sicurezza (12/10/2026): ogni 10 minuti, su richiesta del server (/centralino/pacchetto), si cancellano dalla
// cronologia ElevenLabs le voci di Tix rimaste: voce dell'assistente, create dopo l'11/10/2026 alle 23:00 (quando il
// relay ha iniziato a sintetizzare: prima la cronologia non conteneva voci del servizio), più vecchie di 10 minuti.
// Massimo 25 per giro. Servono i permessi della chiave «speech_history_read» e «speech_history_write».
// Il turno si decide dall'orologio (minuti 0, 10, 20… UTC) e non da una variabile in memoria: il server chiama ogni
// minuto e ogni chiamata può finire su un'istanza diversa del Worker. Errori nel registro solo al minuto 0 (1 volta l'ora).
const STORIA_DAL = Date.parse("2026-10-11T21:00:00Z") / 1000;
let _storiaTurno = "";
async function pulisciStoriaEleven(env, aiuti) {
  if (!env.ELEVENLABS_API_KEY || env.CENTRALINO_STORIA_ELEVEN === "tieni") return 0;
  const ora = new Date();
  if (ora.getUTCMinutes() % 10 !== 0) return 0;
  const turno = ora.toISOString().slice(0, 16);
  if (_storiaTurno === turno) return 0; // già fatto in questo minuto da questa istanza
  _storiaTurno = turno;
  const registra = ora.getUTCMinutes() === 0;
  const voce = voceEleven(await elevenAgente(env));
  const chiave = { "xi-api-key": env.ELEVENLABS_API_KEY };
  let n = 0;
  try {
    const r = await conTimeout("https://api.elevenlabs.io/v1/history?page_size=100&voice_id=" + voce, { headers: chiave }, 8000);
    if (!r.ok) {
      const t = (await r.text()).slice(0, 160);
      if (registra) await aiuti.log("centralino", "voce_bot_errore", "cronologia ElevenLabs: elenco della cronologia non letto (" + r.status + " " + t + ")");
      return 0;
    }
    const j = await r.json();
    const limite = Date.now() / 1000 - 600;
    const voci = (j.history || []).filter((h) => h && h.voice_id === voce && /^[A-Za-z0-9]{8,64}$/.test(String(h.history_item_id || "")) &&
      Number(h.date_unix) >= STORIA_DAL && Number(h.date_unix) < limite).slice(0, 25);
    for (const h of voci) {
      const d = await conTimeout("https://api.elevenlabs.io/v1/history/" + h.history_item_id, { method: "DELETE", headers: chiave }, 5000);
      if (d.ok) { n++; _storiaConta.ok++; }
      else if (d.status === 401 || d.status === 403) {
        const t = (await d.text()).slice(0, 160);
        if (registra) await aiuti.log("centralino", "voce_bot_errore", "cronologia ElevenLabs: pulizia non riuscita (" + d.status + " " + t + ")");
        break;
      }
    }
    if (n) await aiuti.log("centralino", "voce_bot_pulizia", "cronologia ElevenLabs: cancellate " + n + " voci di Tix rimaste");
  } catch (e) {}
  return n;
}

async function ttsAzure(env, testo, voce) {
  if (!env.AZURE_SPEECH_KEY) return { ok: false, fornitore: "azure", errore: "chiave assente" };
  const [lingua, nome] = voce;
  const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + lingua + '">' +
    '<voice name="' + nome + '">' + xmlEsc(testo) + "</voice></speak>";
  try {
    const r = await conTimeout("https://" + AZURE_REGIONE + ".tts.speech.microsoft.com/cognitiveservices/v1", {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
        "User-Agent": "giornale-lavori-centralino"
      },
      body: ssml
    }, 8000);
    if (!r.ok) return { ok: false, fornitore: "azure", errore: r.status + " " + (await r.text()).slice(0, 200) };
    return { ok: true, fornitore: "azure " + nome, body: r.body };
  } catch (e) {
    return { ok: false, fornitore: "azure", errore: String((e && e.message) || e).slice(0, 200) };
  }
}

async function centralinoTts(request, env, aiuti) {
  let corpo = {};
  try { corpo = await request.json(); } catch (e) {}
  const testo = String(corpo.testo || "").trim().slice(0, 1500);
  let l = String(corpo.lingua || "it").trim().toLowerCase().slice(0, 2);
  if (l === "al") l = "sq";
  if (!testo) return json({ errore: "testo vuoto" }, 400);
  const tentativi = [];
  if (l === "sq" || (!ELEVEN_LINGUE.has(l) && AZURE_VOCI[l])) {
    tentativi.push(() => ttsAzure(env, testo, AZURE_VOCI[l]));
  } else {
    if (env.ELEVENLABS_API_KEY) tentativi.push(() => ttsEleven(env, testo));
    tentativi.push(() => ttsAzure(env, testo, AZURE_VOCI[l] || AZURE_VOCI.it)); // riserva: la chiamata non resta muta
  }
  let ultimo = "";
  for (const t of tentativi) {
    const r = await t();
    if (r.ok) {
      let body = r.body;
      if (r.fornitore === "elevenlabs" && env.CENTRALINO_STORIA_ELEVEN !== "tieni") {
        // la voce passa al centralino senza attese; quando lo stream finisce (o chi ascolta lo interrompe) si cancella
        const { readable, writable } = new TransformStream();
        aiuti.attendi(r.body.pipeTo(writable).catch(() => {})
          .then(() => cancellaStoriaEleven(env, aiuti, r.storia)).catch(() => {}));
        body = readable;
      }
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "audio/L16; rate=24000; channels=1", "X-GL-Fornitore": r.fornitore, "Cache-Control": "no-store" }
      });
    }
    ultimo = r.fornitore + " " + r.errore;
    aiuti.attendi(aiuti.log("centralino", "voce_bot_errore", "voce " + l + ": " + ultimo));
  }
  return json({ errore: ultimo }, 502);
}

async function centralinoSessione(request, env, aiuti) {
  let corpo = {};
  try { corpo = await request.json(); } catch (e) {}
  if (!env.OPENAI_API_KEY) return json({ ok: false, errore: "OPENAI_API_KEY assente" }, 503);
  const lingua = String(corpo.lingua || "") === "sq" ? "sq" : "it";
  const ag = await elevenAgente(env);
  const saluto = lingua === "sq" ? BOT_SALUTI.sq : BOT_SALUTI.it;
  let modello = String(env.CENTRALINO_MODELLO || BOT_MODELLO).trim();
  if (!/^gpt-realtime[a-z0-9.\-]*$/.test(modello)) modello = BOT_MODELLO;
  const conia = async (m) => {
    const r = await conTimeout("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 120 }, session: { type: "realtime", model: m } })
    }, 8000);
    const t = await r.text();
    let j = {};
    try { j = JSON.parse(t); } catch (e) {}
    return { ok: r.ok, status: r.status, chiave: j.value || (j.client_secret && j.client_secret.value) || "", testo: t.slice(0, 300) };
  };
  let k = await conia(modello);
  if ((!k.ok || !k.chiave) && modello !== MODELLO_BASE) {
    modello = MODELLO_BASE;
    k = await conia(modello);
  }
  if (!k.ok || !k.chiave) {
    aiuti.attendi(aiuti.log(String(corpo.chiamante || "?").slice(0, 20), "voce_bot_errore", "chiave temporanea OpenAI: " + k.status + " " + k.testo));
    return json({ ok: false, errore: "chiave temporanea non ottenuta: " + k.status }, 502);
  }
  const sessione = {
    type: "realtime",
    output_modalities: ["text"],
    instructions: botIstruzioni(ag && ag.prompt, saluto),
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        noise_reduction: { type: "near_field" },
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true }
      }
    },
    tools: [{
      type: "function",
      name: "termina_chiamata",
      description: "Chiude la telefonata. Usala solo quando la persona ti ha salutato o ha detto che non ha altre domande, e sempre dopo una frase di saluto detta nella stessa risposta. Mai quando la persona ti interrompe o ti chiede di fermarti o di aspettare.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }],
    tool_choice: "auto",
    max_output_tokens: 600
  };
  return json({
    ok: true,
    modello,
    lingua,
    saluto,
    max_secondi: 900,
    openai: { url: "wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(modello), chiave: k.chiave, sessione },
    // riepilogo di fine chiamata: gl-voce lo chiede alla stessa sessione (risposta fuori conversazione)
    riepilogo: env.CENTRALINO_RIEPILOGO === "off" ? null : {
      istruzioni: riepilogoIstruzioni("audio"),
      strumento: { type: "function", name: "salva_riepilogo", description: "Salva il riepilogo della telefonata appena finita.", parameters: RIEPILOGO_SCHEMA }
    }
  });
}

async function centralinoEvento(request, aiuti) {
  let corpo = {};
  try { corpo = await request.json(); } catch (e) {}
  const tipo = String(corpo.tipo || "evento").toLowerCase().replace(/[^a-z_]/g, "").slice(0, 30) || "evento";
  const tel = String(corpo.chiamante || "?").replace(/[^0-9a-z?]/gi, "").slice(0, 20) || "?";
  const dettaglio = String(corpo.dettaglio || "");
  // Il registro tiene 1900 caratteri per riga: le trascrizioni lunghe vanno su più righe numerate.
  const pezzi = [];
  for (let i = 0; i < dettaglio.length && pezzi.length < 6; i += 1800) pezzi.push(dettaglio.slice(i, i + 1800));
  if (!pezzi.length) pezzi.push("");
  for (let i = 0; i < pezzi.length; i++) {
    await aiuti.log(tel, "voce_bot_" + tipo, (pezzi.length > 1 ? "(" + (i + 1) + "/" + pezzi.length + ") " : "") + pezzi[i]);
  }
  return json({ ok: true });
}

// Numeri albanesi: stessa regola della funzione SQL centralino_albanesi_regex (+355, persone e utenti della chat
// con lingua 'sq', impostazione centralino_numeri_albanesi). La funzione non è eseguibile con la chiave del relay
// (11/10/2026): se la chiamata non riesce, i numeri si leggono dalle tabelle.
async function centralinoAlbanesi(aiuti) {
  try {
    const v = String((await aiuti.rpc("centralino_albanesi_regex", {}, 3000)) || "").trim();
    if (v && /^[0-9|\[\]+\-]+$/.test(v)) return { regex: v, fonte: "funzione" };
  } catch (e) {}
  const numeri = new Set(["355[0-9]+"]);
  const cifre = (x) => String(x || "").replace(/\D/g, "");
  let fonte = "tabelle";
  try {
    const [p, u, imp] = await Promise.all([
      aiuti.leggi("persone?select=telefono&lingua=eq.sq&rimosso_il=is.null&telefono=not.is.null", 3000),
      aiuti.leggi("chat_unica_utenti?select=telefono&lingua=eq.sq&telefono=not.is.null", 3000),
      aiuti.leggi("impostazioni?select=valore&chiave=eq.centralino_numeri_albanesi", 3000)
    ]);
    for (const r of p || []) numeri.add(cifre(r.telefono));
    for (const r of u || []) numeri.add(cifre(r.telefono));
    for (const r of imp || []) for (const x of String(r.valore || "").split(",")) numeri.add(cifre(x));
  } catch (e) { fonte = "solo +355 (tabelle non lette)"; }
  const regex = [...numeri].filter((n) => /^[0-9\[\]+\-]{4,}$/.test(n)).sort().join("|");
  return { regex, fonte };
}

async function centralinoPacchetto(env, aiuti) {
  const modo = centralinoModo(env);
  const token = await tokenCentralino(aiuti);
  const alb = await centralinoAlbanesi(aiuti);
  // numeri di prova: "it" esce dall'elenco albanese (niente X-GL-Lingua: sq), "sq" ci entra; in fase_a vanno all'assistente
  const prova = Object.keys(NUMERI_PROVA);
  const provaIt = new Set(prova.filter((n) => NUMERI_PROVA[n] !== "sq"));
  const unici = (a) => [...new Set(a.filter(Boolean))].sort();
  const albanesi = unici(String(alb.regex || "355[0-9]+").split("|").filter((n) => !provaIt.has(n))
    .concat(prova.filter((n) => NUMERI_PROVA[n] === "sq"))).join("|") || "355[0-9]+";
  const bot = modo === "fase_b" ? "[0-9]+" : (modo === "fase_a" ? unici(albanesi.split("|").concat(prova)).join("|") : "NESSUNO");
  const cfg = KAMAILIO_V3_TPL.split("__BOT__").join(bot).split("__ALBANESI__").join(albanesi)
    .split("__TOKEN__").join(token).split("__PROJ__").join(OPENAI_PROGETTO_SIP);
  return json({
    versione: CENTRALINO_VERSIONE + " · numeri albanesi: " + (albanesi.split("|").length - 1) + " + prefisso 355 (" + alb.fonte + ")" +
      " · numeri di prova: " + prova.map((n) => "…" + n.slice(-3) + " " + NUMERI_PROVA[n]).join(", "),
    modo,
    kamailio_cfg: cfg,
    rtpengine_conf: RTPENGINE_V3,
    file: [{ nome: "gl_voce.py", contenuto: GL_VOCE_PY }]
  });
}

export async function centralinoGestisci(request, env, url, aiuti) {
  const atteso = await tokenCentralino(aiuti);
  if (!atteso || !uguali(request.headers.get("x-gl-centralino") || "", atteso)) {
    return json({ errore: "non autorizzato" }, 403);
  }
  const p = url.pathname;
  if (request.method === "POST" && p === "/centralino/tts") return centralinoTts(request, env, aiuti);
  if (request.method === "POST" && p === "/centralino/sessione") return centralinoSessione(request, env, aiuti);
  if (request.method === "POST" && p === "/centralino/evento") return centralinoEvento(request, aiuti);
  if (request.method === "GET" && p === "/centralino/saluti") {
    const ag = await elevenAgente(env);
    return json({
      saluti: { it: BOT_SALUTI.it, sq: BOT_SALUTI.sq },
      voci: { it: vocePrevista(env, "it", ag), sq: vocePrevista(env, "sq", ag) }
    });
  }
  if (request.method === "POST" && p === "/centralino/riepilogo") return centralinoRiepilogo(request, env, aiuti);
  if (request.method === "GET" && p === "/centralino/pacchetto") {
    // il server la chiama ogni minuto: si controlla (e se manca si crea) il modello Meta per gli avvisi a Filippo
    if (env.CENTRALINO_RIEPILOGO !== "off" && aiuti.graph) aiuti.attendi(modelloAvviso(env, aiuti, true).catch(() => {}));
    // e, al massimo ogni 10 minuti, si ripulisce la cronologia ElevenLabs dalle voci di Tix rimaste
    aiuti.attendi(pulisciStoriaEleven(env, aiuti).catch(() => {}));
    return centralinoPacchetto(env, aiuti);
  }
  return json({ errore: "rotta sconosciuta" }, 404);
}

// Riga per /stato: le chiavi non si mostrano mai; per Azure ed ElevenLabs si dice solo se il fornitore le accetta.
let _verifiche = { t: 0, testo: "" };
export async function centralinoStato(env, aiuti) {
  if (_verifiche.testo && Date.now() - _verifiche.t < 60000) return _verifiche.testo;
  let azure = "NO";
  if (env.AZURE_SPEECH_KEY) {
    try {
      const r = await conTimeout("https://" + AZURE_REGIONE + ".api.cognitive.microsoft.com/sts/v1.0/issueToken", {
        method: "POST", headers: { "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY, "Content-Length": "0" }
      }, 4000);
      azure = r.ok ? "sì, accettata da Microsoft" : "sì, ma Microsoft risponde " + r.status;
    } catch (e) { azure = "sì, verifica non riuscita"; }
  }
  let eleven = "NO";
  let agente = "";
  if (env.ELEVENLABS_API_KEY) {
    try {
      const r = await conTimeout("https://api.elevenlabs.io/v1/voices/" + ELEVEN_VOCE, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } }, 4000);
      eleven = r.ok ? "sì, accettata da ElevenLabs" : "sì, ma ElevenLabs risponde " + r.status;
    } catch (e) { eleven = "sì, verifica non riuscita"; }
    // agente ElevenLabs: da lì l'assistente prende istruzioni, saluto e impostazioni della voce (mai la chiave)
    const ag = await elevenAgente(env);
    agente = ag
      ? " · agente ElevenLabs letto: voce " + (ag.voce === ELEVEN_VOCE ? "Alexandra" : (ag.voce || "non indicata")) +
        ", modello dell'agente " + (ag.modello || "non indicato") + " (assistente: " + (env.ELEVEN_MODELLO || ELEVEN_MODELLO) + ")" +
        ", istruzioni " + (ag.prompt === BOT_PROMPT_BASE ? "uguali alla copia" : (ag.prompt ? "diverse dalla copia (" + ag.prompt.length + " caratteri)" : "vuote")) +
        ", primo messaggio dell'agente «" + (ag.primo || "-").slice(0, 100) + "» (non usato)" +
        ", privacy dell'agente " + (ag.privacy ? JSON.stringify(ag.privacy).slice(0, 300) : "non indicata")
      : " · agente ElevenLabs NON letto (" + (_agente.errore || "?") + ")";
    // cronologia delle sintesi: la chiave può cancellarla? (DELETE di un id inesistente: non cancella nulla)
    let permesso = "verifica non riuscita";
    try {
      const r = await conTimeout("https://api.elevenlabs.io/v1/history/GLVERIFICAPERMESSO0000",
        { method: "DELETE", headers: { "xi-api-key": env.ELEVENLABS_API_KEY } }, 4000);
      const t = (await r.text()).slice(0, 160);
      permesso = (r.status === 401 || r.status === 403)
        ? "NO, la chiave non ha il permesso di cancellare la cronologia (" + r.status + " " + t + ")"
        : "sì (prova su una voce inesistente: " + r.status + ")";
    } catch (e) {}
    agente += " · cronologia ElevenLabs: cancellazione dopo ogni sintesi " +
      (env.CENTRALINO_STORIA_ELEVEN === "tieni" ? "SPENTA (CENTRALINO_STORIA_ELEVEN=tieni)" : "accesa") +
      ", permesso della chiave: " + permesso + ", in questa istanza voci cancellate " + _storiaConta.ok + ", non cancellate " + _storiaConta.ko;
  }
  let riepilogo = env.CENTRALINO_RIEPILOGO === "off" ? "spento" : "acceso (avvisi a …" + numeroAvvisi(env).slice(-3) + ", conservazione " + CONSERVAZIONE_GIORNI + " giorni)";
  if (env.CENTRALINO_RIEPILOGO !== "off" && aiuti && aiuti.graph) {
    try { riepilogo += " · modello Meta " + MODELLO_AVVISO + ": " + (await modelloAvviso(env, aiuti, false)); } catch (e) {}
  }
  _verifiche = {
    t: Date.now(),
    testo: "CENTRALINO v3 (assistente nostro): " + CENTRALINO_VERSIONE + " · modo " + centralinoModo(env) +
      " · saluto «" + BOT_SALUTI.it + "»" +
      " · AZURE_SPEECH_KEY: " + azure + " · ELEVENLABS_API_KEY: " + eleven + agente + " · RIEPILOGO: " + riepilogo
  };
  return _verifiche.testo;
}

// ============================================================================
// RIEPILOGO DI FINE CHIAMATA (12/10/2026) — decisioni di Filippo del 12/10:
//   - a chi ha chiamato arriva su WhatsApp il riepilogo della telefonata, nella sua lingua, con i pulsanti
//     «Tutto giusto» / «Correggi» (la correzione si scrive o si detta nel messaggio successivo, entro 15 minuti);
//   - Filippo riceve un avviso solo per le richieste concrete: testo libero se ha scritto o chiamato il numero
//     nelle ultime 24 ore, altrimenti il modello Meta «avviso_telefonata»; se nemmeno quello è disponibile,
//     l'avviso resta in attesa e gli arriva al suo primo messaggio;
//   - trascrizioni e riepiloghi si conservano 90 giorni, poi si cancellano da soli (centralinoPulizia).
// Il riepilogo lo scrive l'AI che ha ascoltato la chiamata (gl-voce, risposta fuori conversazione con la funzione
// salva_riepilogo). Se non c'è, il relay lo ricava dalla trascrizione con un modello di testo.
// Interruttore: variabile CENTRALINO_RIEPILOGO=off (niente riepilogo, niente avvisi).
// ============================================================================
const AVVISI_NUMERO = "393313898967";        // numero principale di Filippo (variabile CENTRALINO_AVVISI per cambiarlo)
const WABA_ID = "1350916186813112";          // account WhatsApp Business del numero 393783107501
const MODELLO_AVVISO = "avviso_telefonata";
const MODELLO_TESTO = "📞 Nuova richiesta dal centralino del Giornale Lavori.\n\nDa: {{1}}\nRichiesta: {{2}}\n\nRiepilogo completo nel registro delle telefonate.";
const MODELLO_ESEMPIO = ["+39 333 123 4567 (Mario Rossi, Rossi Costruzioni)", "vuole attivare il servizio per 3 cantieri e chiede il listino"];
const CONSERVAZIONE_GIORNI = 90;
const CORREZIONE_MINUTI = 15;
const RIEPILOGO_TIPI = ["informazioni", "potenziale_cliente", "operaio_cantiere", "problema", "altro"];

const RIEPILOGO_CAMPI = {
  contenuto: { type: "boolean", description: "true se nella chiamata c'è almeno una domanda o una richiesta vera; false se la persona non ha detto niente di utile (ha riattaccato subito, ha solo salutato, prova senza contenuto, numero sbagliato)" },
  richiesta_concreta: { type: "boolean", description: "true solo se il titolare di TIX deve sapere o fare qualcosa: impresa interessata al servizio o che vuole attivarlo, richiesta di listino o di contatto, problema non risolto, segnalazione dal cantiere che chiede un intervento" },
  tipo: { type: "string", enum: RIEPILOGO_TIPI, description: "tipo di chiamata" },
  lingua: { type: "string", description: "codice ISO a due lettere della lingua di chi ha chiamato (it, sq, ro, en…)" },
  nome: { type: "string", description: "nome e cognome di chi ha chiamato, solo se detti; altrimenti vuoto" },
  impresa: { type: "string", description: "impresa di chi ha chiamato, solo se detta; altrimenti vuoto" },
  cantiere: { type: "string", description: "cantiere o indirizzo, solo se detto; altrimenti vuoto" },
  richiesta: { type: "string", description: "in italiano, una o due frasi: cosa ha chiesto" },
  risposta: { type: "string", description: "in italiano, una o due frasi: cosa ha risposto l'assistente" },
  da_fare: { type: "string", description: "in italiano: cosa resta da fare e da parte di chi; vuoto se non resta niente" },
  messaggio: { type: "string", description: "il messaggio WhatsApp per chi ha chiamato, nella sua lingua, al massimo 600 caratteri (vedi istruzioni)" },
  riga_pulsanti: { type: "string", description: "nella lingua di chi ha chiamato: una riga che invita a toccare un pulsante qui sotto per confermare il riepilogo o correggerlo" },
  pulsante_ok: { type: "string", description: "testo del pulsante di conferma, nella lingua di chi ha chiamato, al massimo 20 caratteri" },
  pulsante_correggi: { type: "string", description: "testo del pulsante per correggere, nella lingua di chi ha chiamato, al massimo 20 caratteri" },
  testo_ok: { type: "string", description: "nella lingua di chi ha chiamato: risposta breve e cordiale a chi conferma il riepilogo" },
  testo_correggi: { type: "string", description: "nella lingua di chi ha chiamato: invito a scrivere in un solo messaggio, anche vocale, cosa correggere o aggiungere" },
  testo_grazie: { type: "string", description: "nella lingua di chi ha chiamato: conferma breve che la correzione è stata aggiunta al riepilogo" },
  avviso: { type: "string", description: "solo se richiesta_concreta è true: in italiano, 2-4 righe per il titolare con chi ha chiamato, cosa vuole e cosa c'è da fare; altrimenti vuoto" }
};
const RIEPILOGO_SCHEMA = { type: "object", additionalProperties: false, properties: RIEPILOGO_CAMPI, required: Object.keys(RIEPILOGO_CAMPI) };

function riepilogoIstruzioni(fonte) {
  return [
    "RIEPILOGO DI FINE CHIAMATA. La telefonata è finita: compila la funzione salva_riepilogo con quello che è stato detto davvero nella chiamata.",
    fonte === "audio"
      ? "Basati su quello che ha detto la persona (ascolta l'audio) e su quello che hai risposto tu."
      : "Basati sulla trascrizione: le righe «Persona» sono trascritte in automatico e possono contenere errori, correggili solo se il senso è evidente.",
    "Non inventare niente: nomi, imprese, cantieri, indirizzi, numeri e date solo se sono stati detti; altrimenti lascia il campo vuoto.",
    "contenuto: false se la persona non ha fatto nessuna domanda o richiesta (ha riattaccato subito, ha solo salutato, prova senza contenuto, numero sbagliato).",
    "richiesta_concreta: true solo se il titolare di TIX deve sapere o fare qualcosa (impresa interessata o che vuole attivare il servizio, richiesta di listino o di contatto, problema non risolto, segnalazione dal cantiere che chiede un intervento); false se la persona ha solo chiesto informazioni e ha avuto la risposta.",
    "richiesta, risposta, da_fare e avviso: in italiano, brevi e concreti.",
    "messaggio: il messaggio WhatsApp per chi ha chiamato, nella lingua in cui ha parlato (in albanese: albanese standard corretto, con ë e ç). Al massimo 600 caratteri. Prima riga: «📞 Riepilogo della telefonata con TIX» nella sua lingua. Poi una riga per ogni dato detto, che inizia con «• »: chi ha chiamato, impresa, cantiere, cosa ha chiesto, cosa è stato risposto. Scrivi solo cose vere: non promettere richiamate, tempi, persone, email o documenti. L'unico sito che puoi citare è www.tixcantiere.it. Niente link inventati, niente firma.",
    "riga_pulsanti, pulsante_ok, pulsante_correggi, testo_ok, testo_correggi, testo_grazie: nella lingua di chi ha chiamato. I pulsanti al massimo 20 caratteri (in italiano «Tutto giusto» e «Correggi»).",
    "avviso: solo se richiesta_concreta è true, 2-4 righe in italiano per il titolare; altrimenti vuoto."
  ].join("\n");
}

function testo(x, n) {
  return String(x == null ? "" : x).replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);
}

function riepilogoPulito(r) {
  const titolo = (t, def) => { t = String(t || "").replace(/\s+/g, " ").trim(); return t && [...t].length <= 20 ? t : def; };
  const lingua = String(r.lingua || "").trim().toLowerCase().slice(0, 2);
  const p = {
    contenuto: r.contenuto === true,
    richiesta_concreta: r.richiesta_concreta === true,
    tipo: RIEPILOGO_TIPI.indexOf(r.tipo) !== -1 ? r.tipo : "altro",
    lingua: /^[a-z]{2}$/.test(lingua) ? lingua : "it",
    nome: testo(r.nome, 80), impresa: testo(r.impresa, 120), cantiere: testo(r.cantiere, 160),
    richiesta: testo(r.richiesta, 400), risposta: testo(r.risposta, 400), da_fare: testo(r.da_fare, 300),
    messaggio: testo(r.messaggio, 900),
    riga_pulsanti: testo(r.riga_pulsanti, 200) || "Tocca un pulsante qui sotto per confermare il riepilogo o correggerlo.",
    pulsante_ok: titolo(r.pulsante_ok, "Tutto giusto"),
    pulsante_correggi: titolo(r.pulsante_correggi, "Correggi"),
    testo_ok: testo(r.testo_ok, 200) || "👍 Grazie!",
    testo_correggi: testo(r.testo_correggi, 300) || "✏️ Scrivi qui in un solo messaggio, anche vocale, cosa correggere o aggiungere.",
    testo_grazie: testo(r.testo_grazie, 200) || "✅ Grazie, ho aggiunto la correzione al riepilogo.",
    avviso: testo(r.avviso, 600)
  };
  if (p.pulsante_ok === p.pulsante_correggi) { p.pulsante_ok = "Tutto giusto"; p.pulsante_correggi = "Correggi"; }
  return p;
}

// Riserva: riepilogo dalla trascrizione (quando l'AI della chiamata non l'ha dato), con un modello di testo.
async function riepilogoDaTrascrizione(env, trascrizione) {
  if (!env.OPENAI_API_KEY) return null;
  const modelli = [String(env.CENTRALINO_MODELLO_RIEPILOGO || "gpt-4.1-mini"), "gpt-4o-mini"];
  for (const m of modelli) {
    try {
      const r = await conTimeout("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: m, temperature: 0.2,
          response_format: { type: "json_schema", json_schema: { name: "riepilogo", strict: true, schema: RIEPILOGO_SCHEMA } },
          messages: [
            { role: "system", content: riepilogoIstruzioni("trascrizione") + "\nRispondi con l'oggetto JSON richiesto." },
            { role: "user", content: "Trascrizione della telefonata a TIX:\n\n" + trascrizione }
          ]
        })
      }, 25000);
      if (!r.ok) continue;
      const j = await r.json();
      const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (c) return JSON.parse(c);
    } catch (e) {}
  }
  return null;
}

function rifNuovo() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

function numeroAvvisi(env) {
  return String(env.CENTRALINO_AVVISI || AVVISI_NUMERO).replace(/\D/g, "");
}

function oraItaliana() {
  try {
    return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());
  } catch (e) { return new Date().toISOString().slice(0, 16).replace("T", " "); }
}

function messaggioTesto(tel, corpo) {
  return { messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "text", text: { body: String(corpo).slice(0, 4000), preview_url: false } };
}

async function centralinoRiepilogo(request, env, aiuti) {
  let corpo = {};
  try { corpo = await request.json(); } catch (e) {}
  const tel = String(corpo.chiamante || "").replace(/\D/g, "").slice(0, 20);
  const logTel = tel || "?";
  const trascrizione = String(corpo.trascrizione || "").slice(0, 12000);
  if (env.CENTRALINO_RIEPILOGO === "off") return json({ ok: true, inviato: false, motivo: "spento" });

  let fonte = "assistente";
  let r = corpo.riepilogo && typeof corpo.riepilogo === "object" ? corpo.riepilogo : null;
  if (!r && /(^|\n)Persona: \S/.test(trascrizione)) {
    fonte = "trascrizione";
    r = await riepilogoDaTrascrizione(env, trascrizione);
  }
  if (!r) {
    await aiuti.log(logTel, "voce_bot_riepilogo", "nessun riepilogo (" + (testo(corpo.errore, 200) || "chiamata senza contenuto") + ")");
    return json({ ok: true, inviato: false });
  }
  const rp = riepilogoPulito(r);
  const rif = rifNuovo();
  if (!rp.contenuto || !rp.messaggio) {
    await aiuti.log(logTel, "voce_bot_riepilogo", "rif " + rif + " · chiamata senza richieste: nessun messaggio (fonte " + fonte + ")");
    return json({ ok: true, rif, inviato: false });
  }

  // 1) messaggio a chi ha chiamato (la telefonata ha aperto la finestra di 24 ore: messaggio libero, gratuito).
  // Ai numeri rimossi dai Tesserini niente pulsanti: le loro risposte vengono fermate prima di arrivare qui.
  let rimosso = false;
  try { rimosso = (await aiuti.rimossi()).indexOf(tel) !== -1; } catch (e) {}
  let invio = "numero non disponibile";
  if (tel) {
    let payload;
    if (!rimosso) {
      const coda = "\n\n" + rp.riga_pulsanti;
      const corpoMsg = rp.messaggio.slice(0, Math.max(200, 1024 - coda.length)) + coda;
      payload = { messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "interactive",
        interactive: { type: "button", body: { text: corpoMsg.slice(0, 1024) }, action: { buttons: [
          { type: "reply", reply: { id: "RIEPILOGO_OK:" + rif, title: rp.pulsante_ok } },
          { type: "reply", reply: { id: "RIEPILOGO_CORREGGI:" + rif, title: rp.pulsante_correggi } }
        ] } } };
    } else {
      payload = messaggioTesto(tel, rp.messaggio);
    }
    try {
      const x = await aiuti.invia(payload);
      invio = x.ok ? (rimosso ? "inviato senza pulsanti (numero rimosso)" : "inviato") : "NON inviato " + x.status + " " + String(x.testo || "").slice(0, 160);
    } catch (e) {
      invio = "NON inviato " + String((e && e.message) || e).slice(0, 160);
    }
  }

  // 2) avviso a Filippo, solo per le richieste concrete
  const chi = [rp.nome, rp.impresa].filter(Boolean).join(", ");
  let avviso = "non serve";
  if (rp.richiesta_concreta) {
    const righe = ["📞 *Richiesta dal centralino* — " + oraItaliana(),
      "Da: +" + (tel || "?") + (chi ? " · " + chi : "") + (rp.cantiere ? " · cantiere " + rp.cantiere : ""),
      "", rp.avviso || rp.richiesta];
    if (rp.da_fare) righe.push("", "Da fare: " + rp.da_fare);
    righe.push("", "Riepilogo a chi ha chiamato: " + (invio.indexOf("inviato") === 0 ? "inviato ✅" : invio));
    avviso = await avvisaFilippo(env, aiuti, {
      chiave: rif, testo: righe.join("\n"),
      p1: "+" + (tel || "?") + (chi ? " (" + chi + ")" : ""),
      p2: rp.avviso || rp.richiesta
    });
  }

  // 3) registro (90 giorni): dati, messaggio inviato, testi per pulsanti e correzione
  const dati = { fonte, tipo: rp.tipo, concreta: rp.richiesta_concreta, lingua: rp.lingua, nome: rp.nome, impresa: rp.impresa,
    cantiere: rp.cantiere, richiesta: rp.richiesta, risposta: rp.risposta, da_fare: rp.da_fare, invio, avviso, durata: corpo.durata || null };
  await aiuti.log(logTel, "voce_bot_riepilogo", "rif " + rif + " · " + JSON.stringify(dati).slice(0, 1850));
  await aiuti.log(logTel, "voce_bot_riepilogo_messaggio", "rif " + rif + " · " + rp.messaggio.slice(0, 1850));
  await aiuti.log(logTel, "voce_bot_riepilogo_testi", "rif " + rif + " · " + JSON.stringify({ lingua: rp.lingua, concreta: rp.richiesta_concreta,
    ok: rp.testo_ok, correggi: rp.testo_correggi, grazie: rp.testo_grazie, chi, cantiere: rp.cantiere, avviso: rp.avviso || rp.richiesta }).slice(0, 1850));
  return json({ ok: true, rif, fonte, inviato: invio, avviso });
}

// ---------------------------------------------------------------------------- avvisi a Filippo
let _modello = { stato: "", t: 0 };
export async function modelloAvviso(env, aiuti, crea) {
  const ora = Date.now();
  const ttl = _modello.stato.indexOf("APPROVED") === 0 ? 3600000 : (_modello.stato.indexOf("ERRORE") === 0 ? 6 * 3600000 : 600000);
  if (_modello.stato && ora - _modello.t < ttl && !(crea && _modello.stato === "ASSENTE")) return _modello.stato;
  const waba = String(env.WABA_ID || WABA_ID);
  const r = await aiuti.graph(waba + "/message_templates?name=" + MODELLO_AVVISO + "&fields=name,status,category,language,rejected_reason");
  if (!r.ok) {
    _modello = { stato: "ERRORE lettura " + r.status, t: ora };
    return _modello.stato;
  }
  const trovato = ((r.dati && r.dati.data) || []).find((x) => x && x.name === MODELLO_AVVISO && String(x.language || "").indexOf("it") === 0);
  if (trovato) {
    _modello = { stato: String(trovato.status || "?") + (trovato.category && trovato.category !== "UTILITY" ? " (" + trovato.category + ")" : "") +
      (trovato.rejected_reason && trovato.rejected_reason !== "NONE" ? " motivo " + trovato.rejected_reason : ""), t: ora };
    return _modello.stato;
  }
  if (!crea) {
    _modello = { stato: "ASSENTE", t: ora };
    return _modello.stato;
  }
  const c = await aiuti.graph(waba + "/message_templates", "POST", {
    name: MODELLO_AVVISO, language: "it", category: "UTILITY",
    components: [{ type: "BODY", text: MODELLO_TESTO, example: { body_text: [MODELLO_ESEMPIO] } }]
  });
  await aiuti.log("centralino", "voce_bot_modello", "creazione del modello " + MODELLO_AVVISO + " (Meta): " + c.status + " " + JSON.stringify(c.dati || {}).slice(0, 500));
  _modello = { stato: c.ok ? String((c.dati && c.dati.status) || "PENDING") : "ERRORE creazione " + c.status, t: ora };
  return _modello.stato;
}

async function finestraAperta(aiuti, tel) {
  // la finestra di 24 ore si apre quando quel numero scrive o chiama: si guarda il registro (margine di un'ora)
  const da = new Date(Date.now() - 23 * 3600 * 1000).toISOString();
  const righe = await aiuti.leggi("chat_unica_eventi?select=id&telefono=eq." + tel +
    "&tipo=in.(presa,voce_bot_inizio,chiamata_evento,trascrizione,funzione_errore)&creato_il=gte." + encodeURIComponent(da) + "&limit=1", 3000);
  return Array.isArray(righe) && righe.length > 0;
}

// a.senzaModello (ingresso Make, 21/10/2026): avvisi che non sono telefonate. Niente modello «avviso_telefonata»:
// testo se la finestra di 24 ore e' aperta, altrimenti l'avviso aspetta il primo messaggio di Filippo.
export async function avvisaFilippo(env, aiuti, a) {
  const dest = numeroAvvisi(env);
  const note = [];
  try {
    if (await finestraAperta(aiuti, dest)) {
      const x = await aiuti.invia(messaggioTesto(dest, a.testo));
      if (x.ok) return "inviato a Filippo";
      note.push("testo NON inviato " + x.status);
    } else {
      note.push("finestra di 24 ore chiusa");
    }
  } catch (e) { note.push("finestra non verificata"); }
  let stato = "";
  if (a.senzaModello) {
    stato = "non usato per questo avviso";
  } else {
    try { stato = await modelloAvviso(env, aiuti, false); } catch (e) { stato = "non verificato"; }
  }
  if (stato.indexOf("APPROVED") === 0) {
    const pulisci = (t, n) => String(t || "").replace(/[\r\n\t]+/g, " · ").replace(/ {4,}/g, " ").trim().slice(0, n) || "-";
    try {
      const x = await aiuti.invia({ messaging_product: "whatsapp", to: dest, type: "template",
        template: { name: MODELLO_AVVISO, language: { code: "it" }, components: [{ type: "body", parameters: [
          { type: "text", text: pulisci(a.p1, 200) }, { type: "text", text: pulisci(a.p2, 700) }] }] } });
      if (x.ok) return "inviato a Filippo con il modello";
      note.push("modello NON inviato " + x.status + " " + String(x.testo || "").slice(0, 120));
    } catch (e) { note.push("modello NON inviato"); }
  } else {
    note.push("modello " + (stato || "non disponibile"));
  }
  await aiuti.log(dest, "voce_bot_avviso_attesa", "rif " + a.chiave + " · " + String(a.testo).slice(0, 1800));
  return "in attesa del primo messaggio di Filippo (" + note.join(", ") + ")";
}

let _avvisi = { vuoto: 0, inCorso: false };
async function consegnaAvvisiInAttesa(env, aiuti) {
  if (_avvisi.inCorso || Date.now() - _avvisi.vuoto < 60000) return;
  _avvisi.inCorso = true;
  try {
    const dest = numeroAvvisi(env);
    const da = new Date(Date.now() - 7 * 86400000).toISOString();
    const righe = await aiuti.leggi("chat_unica_eventi?select=tipo,dettaglio&telefono=eq." + dest +
      "&tipo=in.(voce_bot_avviso_attesa,voce_bot_avviso_consegnato)&creato_il=gte." + encodeURIComponent(da) + "&order=creato_il.asc", 3000);
    const attesa = new Map();
    for (const r of righe || []) {
      const m = /^rif ([a-z0-9]+)(?: · ([\s\S]*))?$/.exec(String(r.dettaglio || ""));
      if (!m) continue;
      if (r.tipo === "voce_bot_avviso_attesa") attesa.set(m[1], m[2] || "");
      else attesa.delete(m[1]);
    }
    if (!attesa.size) { _avvisi.vuoto = Date.now(); return; }
    for (const [chiave, t] of attesa) {
      const x = await aiuti.invia(messaggioTesto(dest, "⏰ Avviso rimasto in attesa:\n\n" + t));
      if (x.ok) await aiuti.log(dest, "voce_bot_avviso_consegnato", "rif " + chiave);
    }
  } finally {
    _avvisi.inCorso = false;
  }
}

// ---------------------------------------------------------------------------- messaggi in arrivo
// Chiamata dal relay per ogni messaggio WhatsApp, prima della chat unica e di Make. Ritorna true se il messaggio
// è stato preso qui (pulsanti del riepilogo, correzione attesa); FAIL-SAFE: un errore lo lascia proseguire.
let _correzioni = { t: 0, mappa: new Map() };

async function correzioneInAttesa(aiuti, tel) {
  const ora = Date.now();
  if (ora - _correzioni.t > 10000) {
    _correzioni.t = ora;   // al massimo una lettura ogni 10 s, anche se il database non risponde
    const da = new Date(ora - CORREZIONE_MINUTI * 60000).toISOString();
    let righe;
    try {
      righe = await aiuti.leggi("chat_unica_eventi?select=telefono,tipo,dettaglio,creato_il&tipo=in.(voce_bot_correzione_attesa,voce_bot_correzione)" +
        "&creato_il=gte." + encodeURIComponent(da) + "&order=creato_il.asc", 2000);
    } catch (e) {
      const x = _correzioni.mappa.get(tel);
      return x && x.scade > ora ? x : null;
    }
    const mappa = new Map();
    for (const r of righe || []) {
      const t = String(r.telefono || "");
      const rif = (/^rif ([a-z0-9]+)/.exec(String(r.dettaglio || "")) || [])[1];
      if (r.tipo === "voce_bot_correzione_attesa" && rif) mappa.set(t, { rif, scade: Date.parse(r.creato_il) + CORREZIONE_MINUTI * 60000 });
      else mappa.delete(t);
    }
    // richiesta appena registrata da questo stesso relay e non ancora letta dal registro (20 s di margine)
    for (const [t, v] of _correzioni.mappa) if (v.creata && ora - v.creata < 20000 && !mappa.has(t)) mappa.set(t, v);
    _correzioni = { t: ora, mappa };
  }
  const x = _correzioni.mappa.get(tel);
  return x && x.scade > ora ? x : null;
}

async function testiRiepilogo(aiuti, tel, rif) {
  const righe = await aiuti.leggi("chat_unica_eventi?select=dettaglio&telefono=eq." + tel + "&tipo=eq.voce_bot_riepilogo_testi&dettaglio=like." +
    encodeURIComponent("rif " + rif + " ") + "*&order=creato_il.desc&limit=1", 3000);
  try {
    const d = String((righe && righe[0] && righe[0].dettaglio) || "");
    return JSON.parse(d.slice(d.indexOf("{")));
  } catch (e) { return {}; }
}

// PRIVACY (12/10/2026): il vocale con cui si detta una correzione è già stato salvato dalla cattura dei media del
// relay (bucket wa-media, registro media_ricevuti). Letto, non serve più: si cancellano file e riga in ogni caso,
// così resta solo il testo della correzione (voce_bot_correzione, 90 giorni).
async function cancellaVocaleCorrezione(aiuti, tel, msg) {
  const p = String((msg && msg.audio && msg.audio.storage_path) || "");
  let file = !p, righe = 0, errore = ""; // senza percorso la cattura non ha salvato il file: niente da cancellare
  try {
    if (p && aiuti.cancellaFile && /^audio\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._\-]+$/.test(p)) file = await aiuti.cancellaFile("wa-media", p);
    else if (p) errore = "percorso non riconosciuto: " + p.slice(0, 80);
  } catch (e) { errore = String((e && e.message) || e).slice(0, 120); }
  try {
    if (msg && msg.id) righe = await aiuti.elimina("media_ricevuti?message_id=eq." + encodeURIComponent(String(msg.id)));
  } catch (e) { errore = (errore ? errore + "; " : "") + String((e && e.message) || e).slice(0, 120); }
  if (!file) {
    try { await aiuti.log(tel, "voce_bot_errore", "vocale della correzione non cancellato (" + (errore || "file non trovato") + ") · righe del registro dei media eliminate: " + righe); } catch (e) {}
  }
  return { file, righe };
}

function idPulsante(msg) {
  if (!msg || msg.type !== "interactive" || !msg.interactive) return "";
  const it = msg.interactive;
  return String((it.button_reply && it.button_reply.id) || (it.list_reply && it.list_reply.id) || "");
}

export async function centralinoMessaggio(msg, env, aiuti) {
  if (env.CENTRALINO_RIEPILOGO === "off") return false;
  const tel = String((msg && msg.from) || "").replace(/\D/g, "");
  if (!tel) return false;

  // 1) pulsanti del riepilogo
  const m = /^RIEPILOGO_(OK|CORREGGI):([a-z0-9]{4,16})$/.exec(idPulsante(msg));
  if (m) {
    const t = await testiRiepilogo(aiuti, tel, m[2]);
    if (m[1] === "OK") {
      await aiuti.log(tel, "voce_bot_riepilogo_ok", "rif " + m[2]);
      await aiuti.invia(messaggioTesto(tel, t.ok || "👍 Grazie!"));
    } else {
      await aiuti.log(tel, "voce_bot_correzione_attesa", "rif " + m[2]);
      _correzioni.mappa.set(tel, { rif: m[2], scade: Date.now() + CORREZIONE_MINUTI * 60000, creata: Date.now() });
      await aiuti.invia(messaggioTesto(tel, t.correggi || "✏️ Scrivi qui in un solo messaggio, anche vocale, cosa correggere o aggiungere."));
    }
    return true;
  }

  // 2) correzione attesa: il primo testo o vocale dopo «Correggi» (entro 15 minuti) si aggiunge al riepilogo
  if (msg.type === "text" || msg.type === "audio") {
    const attesa = await correzioneInAttesa(aiuti, tel);
    if (attesa) {
      _correzioni.mappa.delete(tel);
      let corr = msg.type === "text" ? String((msg.text && msg.text.body) || "").trim() : "";
      if (msg.type === "audio") {
        try { corr = String((await aiuti.trascrivi(msg)) || "").trim(); } catch (e) { corr = ""; }
        await cancellaVocaleCorrezione(aiuti, tel, msg); // il file audio non si tiene, trascritto o no
        if (!corr) {
          // vocale non capito: si richiede la correzione; la richiesta resta aperta fino alla sua scadenza
          _correzioni.mappa.set(tel, { rif: attesa.rif, scade: attesa.scade, creata: Date.now() });
          await aiuti.log(tel, "voce_bot_errore", "rif " + attesa.rif + " · vocale della correzione non trascritto: correzione richiesta di nuovo");
          const t0 = await testiRiepilogo(aiuti, tel, attesa.rif);
          await aiuti.invia(messaggioTesto(tel, t0.correggi || "✏️ Scrivi qui in un solo messaggio, anche vocale, cosa correggere o aggiungere."));
          return true;
        }
      }
      await aiuti.log(tel, "voce_bot_correzione", "rif " + attesa.rif + " · " + corr.slice(0, 1700));
      const t = await testiRiepilogo(aiuti, tel, attesa.rif);
      await aiuti.invia(messaggioTesto(tel, t.grazie || "✅ Grazie, ho aggiunto la correzione al riepilogo."));
      if (t.concreta) {
        const chi = [t.chi, t.cantiere ? "cantiere " + t.cantiere : ""].filter(Boolean).join(" · ");
        await avvisaFilippo(env, aiuti, {
          chiave: attesa.rif + "c",
          testo: "✏️ *Correzione al riepilogo della telefonata* — " + oraItaliana() + "\nDa: +" + tel + (chi ? " · " + chi : "") +
            "\n\nRichiesta: " + (t.avviso || "-") + "\n\nCorrezione: " + corr,
          p1: "+" + tel + (t.chi ? " (" + t.chi + ")" : ""),
          p2: "correzione: " + corr
        });
      }
      return true;
    }
  }

  // 3) Filippo scrive: gli arrivano gli avvisi rimasti in attesa (il suo messaggio prosegue normalmente)
  if (tel === numeroAvvisi(env)) aiuti.attendi(consegnaAvvisiInAttesa(env, aiuti).catch(() => {}));
  return false;
}

// ---------------------------------------------------------------------------- conservazione (90 giorni)
// Cancella dal registro le righe delle telefonate più vecchie di 90 giorni: trascrizioni, riepiloghi, correzioni,
// avvisi (voce_*), registro tecnico del centralino e eventi di chiamata di Meta. La lancia il cron giornaliero.
// chiamata_fine: tipo delle prime prove del 10/10 (il codice attuale non lo scrive più), compreso perché quelle righe scadano.
export async function centralinoPulizia(env, aiuti) {
  const limite = new Date(Date.now() - CONSERVAZIONE_GIORNI * 86400000).toISOString();
  const n = await aiuti.elimina("chat_unica_eventi?creato_il=lt." + encodeURIComponent(limite) +
    "&or=(tipo.like.voce_*,tipo.in.(centralino,chiamata_evento,chiamata,chiamata_fine,chiamata_scelta))");
  if (n > 0) await aiuti.log("centralino", "voce_bot_pulizia", "eliminate " + n + " righe di telefonate più vecchie di " + CONSERVAZIONE_GIORNI + " giorni");
  return n;
}
