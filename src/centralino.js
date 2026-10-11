// ============================================================================
// CENTRALINO v3 (11/10/2026, piano 2) — assistente vocale NOSTRO sul centralino Hetzner.
// Il server (gl-voce) riceve la chiamata da Kamailio, ascolta con OpenAI Realtime (risposte SOLO testo)
// e fa parlare la voce giusta per la lingua: Alexandra (ElevenLabs) per l'italiano e le altre lingue,
// Anila (Microsoft Azure) per l'albanese. Le chiavi dei fornitori restano qui nel relay:
//   POST /centralino/sessione  → chiave OpenAI temporanea (2 minuti per collegarsi) + istruzioni della chiamata
//   POST /centralino/tts       → audio PCM 16 bit 24 kHz della frase, dal fornitore giusto per la lingua
//   GET  /centralino/saluti    → testi dei saluti (il server li sintetizza in anticipo)
//   POST /centralino/evento    → registro (inizio, fine con trascrizione, errori) in chat_unica_eventi
//   GET  /centralino/pacchetto → configurazione di Kamailio e rtpengine + programma gl_voce.py per il server
// Tutte le rotte richiedono l'intestazione X-GL-Centralino con il token del centralino (impostazioni).
// Modo (variabile CENTRALINO_MODO nel pannello, altrimenti MODO_PREDEFINITO):
//   v2      = come prima (albanesi → OpenAI, altri → agente ElevenLabs)
//   fase_a  = albanesi → assistente nostro, altri → agente ElevenLabs
//   fase_b  = tutti → assistente nostro (l'agente ElevenLabs resta configurato, di riserva)
// ============================================================================
import GL_VOCE_PY from "../tools/centralino/v3/gl_voce.py";
import KAMAILIO_V3_TPL from "../tools/centralino/v3/kamailio-v3.cfg.tpl";
import RTPENGINE_V3 from "../tools/centralino/v3/rtpengine-v3.conf";

export const CENTRALINO_VERSIONE = "centralino-3";
const MODO_PREDEFINITO = "fase_a";
const AZURE_REGIONE = "swedencentral";
const OPENAI_PROGETTO_SIP = "proj_YeRqukJfU9TY6JUNXI7Maf5B";
const ELEVEN_AGENTE = "agent_3101m4n1bmrdekg98454f8t5v9fx";
const ELEVEN_VOCE = "kdmDKE6EkgrWrrykO9Qt"; // «Alexandra - Conversational and Natural», scelta da Filippo
const ELEVEN_MODELLO = "eleven_v4_turbo";
const MODELLO_BASE = "gpt-realtime-2.1-mini";

// Voci Microsoft: l'albanese sempre (ElevenLabs non lo parla); l'italiano solo come riserva se ElevenLabs non risponde.
const AZURE_VOCI = {
  sq: ["sq-AL", "sq-AL-AnilaNeural"],
  it: ["it-IT", "it-IT-IsabellaNeural"]
};
// Lingue parlate da Eleven v4 / v4 Turbo (codici a due lettere).
const ELEVEN_LINGUE = new Set(("af am ar hy as az be bn bs bg my ca hr cs da nl en et tl fil fi fr ff gl ka de el gu ha he hi hu is id it ja jv kn kk ko ky lo lv " +
  "ln lt lg lb mk ms ml mt zh mi mr mn ne no nb oc or ps fa pl pt pa ro ru sr sn sd sk sl so ku es sw sv tg ta te th tr uk ur uz vi cy wo zu").split(" "));

const BOT_SALUTI = {
  it: "Ciao, sono l'assistente del Giornale Lavori. Come posso aiutarti?",
  sq: "Përshëndetje, jam asistentja e Giornale Lavori. Si mund t'ju ndihmoj?"
};

// Copia del prompt dell'agente ElevenLabs (11/10/2026): si usa se il prompt dell'agente non è leggibile.
const BOT_PROMPT_BASE = [
  "Sei l'assistente telefonica del Giornale Lavori, un servizio italiano per le imprese edili. Rispondi alle chiamate WhatsApp al posto di un operatore: non esistono operatori umani a cui passare la chiamata e non devi mai promettere richiamate da parte di persone.",
  "Come parli: in italiano, con tono caldo, cordiale e professionale. Frasi brevi e chiare, una domanda alla volta. È una telefonata: niente elenchi, simboli o abbreviazioni. Se chi chiama parla un'altra lingua, rispondi nella sua lingua.",
  "Cos'è il Giornale Lavori: chi lavora in cantiere scrive su WhatsApp a questo numero (testi, foto, vocali, documenti di trasporto) e il servizio compila in automatico il giornale dei lavori del cantiere, giorno per giorno. Gli operai non devono installare nessuna app. L'impresa consulta i suoi cantieri da un'app web. Le persone che scrivono sono illimitate. L'attivazione è automatica.",
  "Prezzi: non dare cifre. Il listino completo si richiede dal sito www.ilgiornalelavori.it, che è in arrivo; nel frattempo invita a scrivere in chat WhatsApp a questo stesso numero.",
  "Se chi chiama lavora già in cantiere: spiega che basta scrivere qui in chat come sempre, testi, foto, documenti o vocali; dopo ogni messaggio arriva la conferma con la spunta verde. Se la conferma non arriva, rimandare il messaggio dopo qualche minuto; se il problema continua, avvisare l'ufficio della propria impresa.",
  "Se non conosci la risposta, dillo con semplicità e invita a scrivere la domanda in chat WhatsApp a questo numero. Non inventare mai informazioni, nomi di clienti o cantieri.",
  "Tieni la chiamata breve: quando la persona ha avuto la risposta, saluta e chiudi la conversazione con cortesia.",
  "Cosa non puoi fare: durante la telefonata non puoi inviare email, messaggi WhatsApp, documenti o riepiloghi, e non puoi registrare dati. Non promettere mai invii, registrazioni o conferme scritte. Se chi chiama vuole lasciare dati (nome dell'impresa, cantiere, contatti) o ricevere informazioni per iscritto, invitalo a scriverli in chat WhatsApp a questo stesso numero."
].join("\n\n");

function botIstruzioni(promptBase, saluto) {
  return [
    promptBase || BOT_PROMPT_BASE,
    "LINGUE: rispondi sempre nella lingua in cui ti parla la persona. In cantiere moltissimi operai parlano solo albanese: se la persona parla albanese (shqip), rispondi in albanese con frasi brevi, semplici e chiare, come si parla in cantiere. Se la persona cambia lingua a metà chiamata, cambia anche tu. Non tradurre il nome «Giornale Lavori».",
    "ETICHETTA DELLA LINGUA (obbligatoria): inizia OGNI risposta con il codice della lingua in cui rispondi, tra parentesi quadre: [it] italiano, [sq] albanese, [ro] rumeno, [ar] arabo, [en] inglese, [fr] francese, [es] spagnolo, [uk] ucraino, [ru] russo, [bn] bengalese, [ur] urdu, [pa] punjabi, [hi] hindi, [tr] turco, [pl] polacco, [sr] serbo, [mk] macedone, [zh] cinese; per le altre lingue il codice ISO a due lettere. L'etichetta non viene letta ad alta voce: non ripeterla mai dentro la frase.",
    "STILE: è una telefonata. Scrivi solo frasi da pronunciare: niente elenchi, simboli, emoji, asterischi, link o abbreviazioni. Risposte brevi: di solito una o due frasi.",
    "CHIUSURA: quando la persona ha avuto la risposta e vi siete salutati, chiama la funzione termina_chiamata subito dopo la frase di saluto.",
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
  if (_agente.v && Date.now() - _agente.t < 300000) return _agente.v;
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
        v: {
          prompt: String((ag.prompt && ag.prompt.prompt) || "").trim(),
          primo: String(ag.first_message || "").trim(),
          voce: String(tts.voice_id || "").trim(),
          stabilita: tts.stability, somiglianza: tts.similarity_boost, velocita: tts.speed
        }
      };
    } else {
      _agente.t = Date.now();
    }
  } catch (e) {}
  return _agente.v;
}

async function ttsEleven(env, testo) {
  if (!env.ELEVENLABS_API_KEY) return { ok: false, fornitore: "elevenlabs", errore: "chiave assente" };
  const ag = await elevenAgente(env);
  const voce = (ag && /^[A-Za-z0-9]{20}$/.test(ag.voce)) ? ag.voce : ELEVEN_VOCE;
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
    return { ok: true, fornitore: "elevenlabs", body: r.body };
  } catch (e) {
    return { ok: false, fornitore: "elevenlabs", errore: String((e && e.message) || e).slice(0, 200) };
  }
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
      return new Response(r.body, {
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
  const saluto = lingua === "sq" ? BOT_SALUTI.sq : ((ag && ag.primo) || BOT_SALUTI.it);
  let modello = MODELLO_BASE;
  try { modello = (await aiuti.modello()) || MODELLO_BASE; } catch (e) {}
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
      description: "Chiude la telefonata. Usala solo dopo aver salutato, quando la persona non ha altre domande.",
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
    openai: { url: "wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(modello), chiave: k.chiave, sessione }
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
  const albanesi = alb.regex || "355[0-9]+";
  const bot = modo === "fase_b" ? "[0-9]+" : (modo === "fase_a" ? albanesi : "NESSUNO");
  const cfg = KAMAILIO_V3_TPL.split("__BOT__").join(bot).split("__ALBANESI__").join(albanesi)
    .split("__TOKEN__").join(token).split("__PROJ__").join(OPENAI_PROGETTO_SIP);
  return json({
    versione: CENTRALINO_VERSIONE + " · numeri albanesi: " + (albanesi.split("|").length - 1) + " + prefisso 355 (" + alb.fonte + ")",
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
    return json({ saluti: { it: (ag && ag.primo) || BOT_SALUTI.it, sq: BOT_SALUTI.sq } });
  }
  if (request.method === "GET" && p === "/centralino/pacchetto") return centralinoPacchetto(env, aiuti);
  return json({ errore: "rotta sconosciuta" }, 404);
}

// Riga per /stato: le chiavi non si mostrano mai; per Azure ed ElevenLabs si dice solo se il fornitore le accetta.
let _verifiche = { t: 0, testo: "" };
export async function centralinoStato(env) {
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
  if (env.ELEVENLABS_API_KEY) {
    try {
      const r = await conTimeout("https://api.elevenlabs.io/v1/voices/" + ELEVEN_VOCE, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } }, 4000);
      eleven = r.ok ? "sì, accettata da ElevenLabs" : "sì, ma ElevenLabs risponde " + r.status;
    } catch (e) { eleven = "sì, verifica non riuscita"; }
  }
  _verifiche = {
    t: Date.now(),
    testo: "CENTRALINO v3 (assistente nostro): " + CENTRALINO_VERSIONE + " · modo " + centralinoModo(env) +
      " · AZURE_SPEECH_KEY: " + azure + " · ELEVENLABS_API_KEY: " + eleven
  };
  return _verifiche.testo;
}
