// ============================================================================
// LETTORE DEI VERBALI DI PRELIEVO E DEI DDT (14/11/2026, prove-5, chat B3).
// Legge con Claude (API Anthropic, chiave ANTHROPIC_API_KEY del Worker) il PDF o la foto di un verbale di prelievo di campioni,
// anche quello fatto e mandato dalla centrale di betonaggio, oppure di un DDT del calcestruzzo o dell'acciaio, e propone i dati
// della scheda del prelievo (Prove sui materiali). Niente si salva da solo: l'utente controlla e salva.
// Stesso schema di chiamata di src/lettore-offerte.js (comune con la chat Analisi), che qui NON è toccato.
//   leggiVerbalePrelievo(env, { bytes, nome, modello, effort, catalogo:[{codice, materiale, nome}] })
//   → { esito: ok | vuota | rifiutata | errore | spento | formato | grande, proposta, messaggio, token_in, token_out, ms, modello }
// ============================================================================

export const PROVE_MAX_PDF = 20 * 1048576;
export const PROVE_MAX_FOTO = 5 * 1048576;

function lista(a) { return Array.isArray(a) ? a : []; }
function testo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function tipoFile(b) {
  if (!b || b.length < 8) return "";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  const testa = String.fromCharCode.apply(null, Array.from(b.subarray(0, 1024)));
  return testa.indexOf("%PDF-") !== -1 ? "pdf" : "";
}
const MIME = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png" };
function b64DaByte(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function dataIa(x) {
  const s = String(x || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? s : "";
}
function numeroIa(x) {
  let s = String(x == null ? "" : x).trim().replace(/\s/g, "");
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^\d{1,7}(\.\d+)?$/.test(s)) return "";
  const n = Math.round(Number(s) * 1000) / 1000;
  return Number.isFinite(n) ? String(n).replace(".", ",") : "";
}

const MATERIALI = ["calcestruzzo", "acciaio", "terre", "murature", "bitumi", "altro"];
const CAMPI = ["tipo_documento", "data", "materiale", "prova_codice", "opera", "quantita", "unita", "classe", "ddt", "fornitore", "provini", "sigle",
  "dl_nome", "tecnico_nome", "note"];
const SCHEMA = {
  type: "object",
  properties: Object.assign(Object.fromEntries(CAMPI.map((k) => [k, { type: "string" }])), {
    tipo_documento: { type: "string", enum: ["verbale_prelievo", "ddt", "certificato", "altro"] },
    materiale: { type: "string", enum: MATERIALI.concat([""]) },
    dubbi: { type: "array", items: { type: "string" } }
  }),
  required: CAMPI.concat(["dubbi"]),
  additionalProperties: false
};
const SISTEMA =
  "Leggi documenti di cantiere italiani e ricopi i dati nella scheda di un prelievo di campioni per le prove di laboratorio. " +
  "Il documento può essere: un verbale di prelievo (cubetti di calcestruzzo, spezzoni di acciaio, campioni di terra o altro), " +
  "anche fatto dalla centrale di betonaggio e mandato all'impresa; oppure un DDT del calcestruzzo o dell'acciaio. " +
  "Chi usa la scheda controlla tutto prima di salvare: conta più non inventare che riempire. Se un dato non c'è o non si legge con sicurezza, " +
  "lascia la stringa vuota e scrivilo in «dubbi».\n" +
  "Regole dei campi:\n" +
  "- tipo_documento: verbale_prelievo, ddt, certificato (se è un certificato di prova del laboratorio) oppure altro.\n" +
  "- data: data del prelievo (o del getto); per un DDT la data del DDT. Formato AAAA-MM-GG.\n" +
  "- materiale: calcestruzzo, acciaio, terre, murature, bitumi o altro.\n" +
  "- prova_codice: il codice della prova da fare, scelto SOLO dall'elenco nel messaggio (per i cubetti di calcestruzzo di solito CLS-CUB, " +
  "per le barre di acciaio ACC-B450C); se non è chiaro, vuoto.\n" +
  "- opera: l'elemento o la posizione del getto o del prelievo (per esempio «platea», «pilastri piano terra», «solaio primo piano»).\n" +
  "- quantita e unita: m³ di calcestruzzo del getto o del carico rappresentato dal prelievo, oppure t di acciaio; il numero con la virgola per i decimali.\n" +
  "- classe: per il calcestruzzo classe di resistenza, esposizione e consistenza (per esempio «C25/30 XC2 S4»); per l'acciaio tipo e diametro («B450C Ø16»).\n" +
  "- ddt: numero del DDT (con la data se utile). fornitore: centrale di betonaggio, ferriera o produttore.\n" +
  "- provini: quanti cubetti, provini, spezzoni o campioni (solo il numero). sigle: le sigle o i numeri scritti sui provini.\n" +
  "- dl_nome: il Direttore dei Lavori o chi era presente per la DL, se indicato. tecnico_nome: chi ha fatto il prelievo.\n" +
  "- note: altre informazioni utili in una riga (slump misurato, temperatura, ora del getto, autobetoniera…).\n" +
  "- dubbi: frasi brevi in italiano sui dati incerti o mancanti (al massimo 6).";

export function pulisciPropostaPrelievo(p, catalogo) {
  const o = p && typeof p === "object" ? p : {};
  const cat = lista(catalogo);
  const codici = cat.map((k) => String(k && k.codice || ""));
  let mat = MATERIALI.indexOf(o.materiale) >= 0 ? o.materiale : "";
  let cod = codici.indexOf(String(o.prova_codice || "")) >= 0 ? String(o.prova_codice) : "";
  if (cod && !mat) { const k = cat.find((x) => x.codice === cod); mat = k ? k.materiale : ""; }
  if (cod && mat && !cat.some((x) => x.codice === cod && x.materiale === mat)) cod = "";
  const prov = String(o.provini || "").match(/\d{1,3}/);
  const dubbi = lista(o.dubbi).map((d) => testo(d, 200)).filter(Boolean).slice(0, 6);
  if (o.tipo_documento === "certificato") dubbi.unshift("Sembra un certificato del laboratorio: caricalo con «Carica certificato» sul prelievo giusto.");
  if (o.tipo_documento === "altro") dubbi.unshift("Il documento non sembra un verbale di prelievo né un DDT: controlla di aver scelto il file giusto.");
  return {
    tipo_documento: testo(o.tipo_documento, 20), data: dataIa(o.data), materiale: mat, prova_codice: cod, opera: testo(o.opera, 300),
    quantita: numeroIa(o.quantita), unita: testo(o.unita, 20), classe: testo(o.classe, 120), ddt: testo(o.ddt, 200), fornitore: testo(o.fornitore, 200),
    provini: prov ? prov[0] : "", sigle: testo(o.sigle, 500), dl_nome: testo(o.dl_nome, 200), tecnico_nome: testo(o.tecnico_nome, 200),
    note: testo(o.note, 2000), dubbi
  };
}

export async function leggiVerbalePrelievo(env, o) {
  const opz = o && typeof o === "object" ? o : {};
  const modello = testo(opz.modello, 60) || "claude-opus-5-5";
  const vuoto = { token_in: 0, token_out: 0, ms: 0, modello };
  if (!env || !env.ANTHROPIC_API_KEY) return Object.assign(vuoto, { esito: "spento", messaggio: "La lettura automatica non è disponibile: compila i campi a mano." });
  const bytes = opz.bytes instanceof Uint8Array ? opz.bytes : null;
  const tipo = tipoFile(bytes);
  if (!MIME[tipo]) return Object.assign(vuoto, { esito: "formato", messaggio: "Questo file non si legge in automatico: compila i campi a mano." });
  if (tipo === "pdf" ? bytes.length > PROVE_MAX_PDF : bytes.length > PROVE_MAX_FOTO) {
    return Object.assign(vuoto, { esito: "grande", messaggio: "Il file è troppo grande per la lettura automatica: compila i campi a mano." });
  }
  const doc = tipo === "pdf"
    ? { type: "document", source: { type: "base64", media_type: MIME[tipo], data: b64DaByte(bytes) } }
    : { type: "image", source: { type: "base64", media_type: MIME[tipo], data: b64DaByte(bytes) } };
  const contesto = "File: " + testo(opz.nome, 120) + "\n" +
    "Elenco delle prove (codice · materiale · nome): " + lista(opz.catalogo).slice(0, 80).map((k) => testo(k && k.codice, 12) + " · " + testo(k && k.materiale, 20) + " · " + testo(k && k.nome, 90)).join(" | ") + "\n" +
    "Ricopia i dati nella scheda del prelievo.";
  const effort = ["low", "medium", "high"].indexOf(opz.effort) !== -1 ? opz.effort : "low";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 110000);
  const inizio = Date.now();
  let r = null, j = null;
  const no = "Non sono riuscito a leggere il file: il file resta allegato, compila i campi a mano.";
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2026-10-21", "anthropic-beta": "server-side-fallback-2026-07-01",
        "content-type": "application/json" },
      body: JSON.stringify({
        model: modello, max_tokens: 4000, system: SISTEMA, fallbacks: "default",
        output_config: { effort, format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: [doc, { type: "text", text: contesto }] }]
      })
    });
    j = await r.json().catch(() => null);
  } catch (e) {
    clearTimeout(timer);
    return Object.assign(vuoto, { ms: Date.now() - inizio, esito: "errore", errore: e && e.name === "AbortError" ? "tempo scaduto" : "rete", messaggio: no });
  }
  clearTimeout(timer);
  const uso = (j && j.usage) || {};
  const base = {
    ms: Date.now() - inizio,
    token_in: (Number(uso.input_tokens) || 0) + (Number(uso.cache_creation_input_tokens) || 0) + (Number(uso.cache_read_input_tokens) || 0),
    token_out: Number(uso.output_tokens) || 0,
    modello: testo((j && j.model) || modello, 60)
  };
  if (!r.ok || !j) return Object.assign(base, { esito: "errore", errore: "api " + r.status, messaggio: no });
  if (j.stop_reason === "refusal") return Object.assign(base, { esito: "rifiutata", messaggio: no });
  if (j.stop_reason === "max_tokens") return Object.assign(base, { esito: "errore", errore: "max_tokens", messaggio: no });
  const blocco = lista(j.content).find((b) => b && b.type === "text" && typeof b.text === "string");
  let p = null;
  try { p = blocco ? JSON.parse(blocco.text) : null; } catch (e) { p = null; }
  if (!p || typeof p !== "object") return Object.assign(base, { esito: "errore", errore: "risposta non in JSON", messaggio: no });
  const proposta = pulisciPropostaPrelievo(p, opz.catalogo);
  if (!proposta.data && !proposta.materiale && !proposta.classe && !proposta.ddt) {
    return Object.assign(base, { esito: "vuota", proposta, messaggio: "Nel file non ho trovato i dati di un prelievo: il file resta allegato, compila i campi a mano." });
  }
  return Object.assign(base, { esito: "ok", proposta });
}
