// ============================================================================
// LETTORE COMUNE DELLE OFFERTE DEI FORNITORI (10/11/2026, offerte-2, fase O2a; chat «Analisi economica» d'accordo con la 02B).
// Legge con Claude (API Anthropic, chiave ANTHROPIC_API_KEY del Worker) il PDF o la foto di un'offerta o di un preventivo di un
// fornitore e restituisce una PROPOSTA dei campi, sempre da controllare: fornitore (scritto come in Rubrica se c'è), numero, data,
// validità, materiale, descrizione, righe con prezzo + IVA e note della voce, condizioni, dubbi e campi non trovati.
// Lo usano:
//   - src/offerte.js — sezione Offerte del cantiere (POST /offerte/leggi);
//   - le Richieste di offerta dei Preventivi (src/preventivi.js, aggancio della 02B): con «righeAttese» ogni riga letta porta
//     voce_id = l'id della voce della richiesta a cui corrisponde (oppure "" se non corrisponde a nessuna).
// Qui NON si tocca il database e NON si controllano accessi, interruttori, tetti o crediti: lo fa chi chiama, prima (controllo) e dopo
// (registro con token_in, token_out, ms, modello, esito). Niente si salva da solo.
//
//   leggiOffertaFornitore(env, {
//     bytes,            Uint8Array del file: PDF (fino a 20 MB) oppure foto JPG / PNG (fino a 5 MB); il tipo si riconosce dai byte
//     nome,             nome del file (solo come indicazione per il modello)
//     modello, effort,  dalle impostazioni di chi chiama (es. claude-opus-5-5, low)
//     fornitori,        nomi già nella Rubrica dell'impresa, per scriverli uguali
//     materiali,        materiali già usati (per il campo «materiale»)
//     righeAttese       facoltativo: [{ id, descrizione, unita, quantita }] voci della richiesta di offerta (al massimo 200)
//   }) → {
//     esito:     "ok" | "vuota" (il file non sembra un'offerta) | "rifiutata" | "errore" | "formato" (.p7m o file non leggibile)
//                | "grande" | "spento" (manca la chiave);  "formato", "grande" e "spento" NON chiamano l'API (niente da registrare)
//     messaggio: frase per l'utente quando esito ≠ "ok"
//     proposta:  { fornitore, fornitore_rubrica, materiale, descrizione, numero, data (AAAA-MM-GG), valida_fino (AAAA-MM-GG),
//                  iva ("esclusa" | "inclusa" | "non indicata"), note, righe: [{ descrizione, unita, prezzo ("98.5", punto, + IVA come
//                  scritto nel documento), note, voce_id }], dubbi: [...], mancano: [...] }   (con esito "ok" o "vuota")
//     token_in, token_out, ms, modello, errore
//   }
// Modello di riserva acceso (fallbacks "default"): se il modello rifiuta, la stessa richiesta la rifà un modello di riserva.
// ============================================================================

export const LETTORE_MAX_PDF = 20 * 1048576;   // il PDF va in base64 nella richiesta (limite dell'API 32 MB per richiesta)
export const LETTORE_MAX_FOTO = 5 * 1048576;   // limite dell'API per una singola immagine

function lista(a) { return Array.isArray(a) ? a : []; }
function testo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function testoLungo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function euro(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  const dec = Math.round(x * 10000) % 100 ? 4 : 2;
  const s = x.toFixed(dec).replace(/0{1,2}$/, (m) => (dec === 4 ? "" : m));
  const [i, d] = s.split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (d ? "," + d : "") + " €";
}
function tipoFile(b) {
  if (!b || b.length < 8) return "";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x30) return "p7m";
  const testa = String.fromCharCode.apply(null, Array.from(b.subarray(0, 1024)));
  return testa.indexOf("%PDF-") !== -1 ? "pdf" : "";
}
const MIME = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png" };

function schema(conVoci) {
  const riga = { descrizione: { type: "string" }, unita: { type: "string" }, prezzo: { type: "string" }, quantita: { type: "string" }, note: { type: "string" } };
  const obbl = ["descrizione", "unita", "prezzo", "quantita", "note"];
  if (conVoci) { riga.voce = { type: "string" }; obbl.push("voce"); }
  return {
    type: "object",
    properties: {
      fornitore: { type: "string" }, numero: { type: "string" }, data: { type: "string" }, valida_fino: { type: "string" },
      validita_giorni: { type: "string" }, materiale: { type: "string" }, descrizione: { type: "string" }, cantiere: { type: "string" },
      righe: { type: "array", items: { type: "object", properties: riga, required: obbl, additionalProperties: false } },
      condizioni: { type: "string" }, totale: { type: "string" }, iva: { type: "string", enum: ["esclusa", "inclusa", "non indicata"] },
      dubbi: { type: "array", items: { type: "string" } }
    },
    required: ["fornitore", "numero", "data", "valida_fino", "validita_giorni", "materiale", "descrizione", "cantiere", "righe", "condizioni", "totale", "iva", "dubbi"],
    additionalProperties: false
  };
}
const SISTEMA =
  "Leggi offerte e preventivi che i fornitori di materiale mandano a un'impresa edile italiana (calcestruzzo, ferro, laterizi, inerti, noli, trasporti…) " +
  "e ne ricopi i dati in un modulo. Chi usa il modulo controlla tutto prima di salvare, quindi conta più non inventare che riempire: " +
  "se un dato non c'è o non si legge con sicurezza, lascia la stringa vuota e scrivilo in «dubbi». Mai calcolare o stimare prezzi che il documento non riporta.\n" +
  "Regole dei campi:\n" +
  "- fornitore: la ditta che fa l'offerta (non l'impresa destinataria), con la ragione sociale scritta nel documento.\n" +
  "- data e valida_fino: formato AAAA-MM-GG. Se la validità è scritta come durata («30 giorni»), lascia valida_fino vuota e metti il numero in validita_giorni.\n" +
  "- materiale: due o tre parole per il tipo di fornitura, scelte se possibile tra quelle già usate dall'impresa (elenco nel messaggio).\n" +
  "- descrizione: una riga su cosa riguarda l'offerta (per esempio la classe del calcestruzzo o l'opera).\n" +
  "- cantiere: il cantiere o l'indirizzo dei lavori citato nell'offerta, se c'è.\n" +
  "- righe: una per ogni voce con il suo prezzo unitario. prezzo = solo il numero, punto per i decimali, senza migliaia, senza simbolo dell'euro, " +
  "come scritto nel documento (di solito IVA esclusa); unita = l'unità di misura (m³, kg, t, ora, viaggio…); quantita = quantità o minimi indicati; " +
  "note = sconti, sovrapprezzi o condizioni della singola voce. Voci senza prezzo: prezzo vuoto.\n" +
  "- condizioni: trasporto, pompaggio, sovrapprezzi, attese, pagamento, tempi di consegna, in poche righe.\n" +
  "- totale: solo se il documento riporta un totale, come numero.\n" +
  "- iva: «esclusa» se i prezzi sono indicati IVA esclusa, «inclusa» se comprendono l'IVA, altrimenti «non indicata».\n" +
  "- dubbi: frasi brevi in italiano sui dati incerti o mancanti (al massimo 6).";
const SISTEMA_VOCI =
  "\n- voce: quando il messaggio elenca le voci della richiesta di offerta, metti in «voce» il codice della voce richiesta a cui la riga " +
  "corrisponde con sicurezza (stesso materiale, stessa classe o misura); se non corrisponde con sicurezza a nessuna, lascia vuoto. " +
  "Non mettere lo stesso codice su due righe e non cambiare il prezzo per farlo tornare con la voce richiesta.";

function b64DaByte(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function nomeDitta(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\b(s\.?\s?r\.?\s?l\.?s?|s\.?\s?p\.?\s?a\.?|s\.?\s?n\.?\s?c\.?|s\.?\s?a\.?\s?s\.?|soc(ieta)?\.?\s+coop(erativa)?\.?|unipersonale|srls)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
// il fornitore letto, scritto come nella Rubrica se c'è già
function fornitoreRubrica(letto, elenco) {
  const n = nomeDitta(letto);
  if (!n) return { nome: "", rubrica: false };
  const l = lista(elenco);
  let trovato = l.find((x) => nomeDitta(x) === n);
  if (!trovato && n.length >= 5) trovato = l.find((x) => { const m = nomeDitta(x); return m.length >= 5 && (m.indexOf(n) !== -1 || n.indexOf(m) !== -1); });
  return trovato ? { nome: testo(trovato, 120), rubrica: true } : { nome: testo(letto, 120), rubrica: false };
}
function numeroIa(x) {
  let s = String(x == null ? "" : x).trim().replace(/[€\s]/g, "");
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");   // 1.234,50 scritto all'italiana
  else if (/^\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^\d{1,7}(\.\d+)?$/.test(s)) return "";
  const n = Math.round(Number(s) * 10000) / 10000;
  return Number.isFinite(n) ? String(n) : "";
}
function dataIa(x) {
  const s = String(x || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? s : "";
}
function vociAttese(a) {
  return lista(a).slice(0, 200).map((v) => ({ id: testo(v && v.id, 64), descrizione: testo(v && v.descrizione, 300), unita: testo(v && v.unita, 20),
    quantita: testo(v && v.quantita, 40) })).filter((v) => v.id && v.descrizione);
}

export function pulisciPropostaOfferta(p, fornitori, materiali, righeAttese) {
  const o = p && typeof p === "object" ? p : {};
  const forn = fornitoreRubrica(o.fornitore, fornitori);
  const data = dataIa(o.data);
  let valida = dataIa(o.valida_fino);
  const gg = Number(String(o.validita_giorni || "").replace(/[^\d]/g, ""));
  if (!valida && data && gg >= 1 && gg <= 730) valida = new Date(Date.parse(data + "T00:00:00Z") + gg * 86400000).toISOString().slice(0, 10);
  if (valida && data && valida < data) valida = "";
  let mat = testo(o.materiale, 80);
  const usato = lista(materiali).find((m) => String(m).toLowerCase() === mat.toLowerCase());
  if (usato) mat = testo(usato, 80);
  const ids = new Set(vociAttese(righeAttese).map((v) => v.id));
  const presi = new Set();
  const righe = lista(o.righe).slice(0, 60).map((r) => {
    const x = r && typeof r === "object" ? r : {};
    const note = [testo(x.quantita, 120) ? "quantità: " + testo(x.quantita, 120) : "", testo(x.note, 200)].filter(Boolean).join("; ");
    let voce = testo(x.voce, 64);
    if (!ids.has(voce) || presi.has(voce)) voce = "";
    if (voce) presi.add(voce);
    return { descrizione: testo(x.descrizione, 300), unita: testo(x.unita, 20), prezzo: numeroIa(x.prezzo), note: testo(note, 300), voce_id: voce };
  }).filter((r) => r.descrizione);
  const iva = ["esclusa", "inclusa", "non indicata"].indexOf(o.iva) !== -1 ? o.iva : "non indicata";
  const totale = numeroIa(o.totale);
  const pezzi = [testoLungo(o.condizioni, 800)];
  if (totale) pezzi.push("Totale indicato nell'offerta: " + euro(Number(totale)) + (iva === "inclusa" ? " IVA compresa" : " + IVA"));
  if (testo(o.cantiere, 200)) pezzi.push("Cantiere indicato nell'offerta: " + testo(o.cantiere, 200));
  const dubbi = lista(o.dubbi).map((d) => testo(d, 200)).filter(Boolean).slice(0, 6);
  if (iva === "inclusa") dubbi.unshift("Nel documento i prezzi sembrano IVA compresa: in TIX vanno scritti + IVA, controllali.");
  if (forn.nome && !forn.rubrica) dubbi.push("Il fornitore «" + forn.nome + "» non è nella Rubrica dell'impresa: controlla come è scritto.");
  const mancano = [];
  if (!forn.nome) mancano.push("fornitore");
  if (!o.numero || !testo(o.numero, 60)) mancano.push("numero");
  if (!data) mancano.push("data");
  if (!valida) mancano.push("validità");
  if (!righe.some((r) => r.prezzo)) mancano.push("prezzi");
  return {
    fornitore: forn.nome, fornitore_rubrica: forn.rubrica, materiale: mat, descrizione: testo(o.descrizione, 300), numero: testo(o.numero, 60),
    data, valida_fino: valida, iva, note: testoLungo(pezzi.filter(Boolean).join("\n"), 1000), righe, dubbi: dubbi.slice(0, 8), mancano
  };
}

export async function leggiOffertaFornitore(env, o) {
  const opz = o && typeof o === "object" ? o : {};
  const modello = testo(opz.modello, 60) || "claude-opus-5-5";
  const vuoto = { token_in: 0, token_out: 0, ms: 0, modello };
  if (!env || !env.ANTHROPIC_API_KEY) return Object.assign(vuoto, { esito: "spento", messaggio: "La lettura automatica non è disponibile: compila i campi a mano." });
  const bytes = opz.bytes instanceof Uint8Array ? opz.bytes : null;
  const tipo = tipoFile(bytes);
  if (tipo === "p7m") return Object.assign(vuoto, { esito: "formato", messaggio: "Il PDF firmato (.p7m) non si legge in automatico: compila i campi a mano." });
  if (!MIME[tipo]) return Object.assign(vuoto, { esito: "formato", messaggio: "Questo file non si legge in automatico: compila i campi a mano." });
  if (tipo === "pdf" ? bytes.length > LETTORE_MAX_PDF : bytes.length > LETTORE_MAX_FOTO) {
    return Object.assign(vuoto, { esito: "grande", messaggio: "Il file è troppo grande per la lettura automatica: compila i campi a mano." });
  }
  const mime = MIME[tipo];
  const voci = vociAttese(opz.righeAttese);
  const doc = tipo === "pdf"
    ? { type: "document", source: { type: "base64", media_type: mime, data: b64DaByte(bytes) } }
    : { type: "image", source: { type: "base64", media_type: mime, data: b64DaByte(bytes) } };
  let contesto = "File: " + testo(opz.nome, 120) + "\n" +
    "Fornitori già nella Rubrica dell'impresa (se è uno di questi, scrivilo uguale): " + lista(opz.fornitori).slice(0, 400).map((x) => testo(x, 120)).join(" · ") + "\n" +
    "Materiali già usati dall'impresa: " + lista(opz.materiali).slice(0, 120).map((x) => testo(x, 80)).join(" · ") + "\n";
  if (voci.length) {
    contesto += "Voci della richiesta di offerta (codice | descrizione | unità | quantità):\n" +
      voci.map((v) => v.id + " | " + v.descrizione + " | " + (v.unita || "-") + " | " + (v.quantita || "-")).join("\n") + "\n";
  }
  contesto += "Ricopia i dati dell'offerta nel modulo.";
  const effort = ["low", "medium", "high"].indexOf(opz.effort) !== -1 ? opz.effort : "low";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 110000);
  const inizio = Date.now();
  let r = null, j = null;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2026-10-21", "anthropic-beta": "server-side-fallback-2026-07-01",
        "content-type": "application/json" },
      body: JSON.stringify({
        model: modello, max_tokens: 16000, system: SISTEMA + (voci.length ? SISTEMA_VOCI : ""), fallbacks: "default",
        output_config: { effort, format: { type: "json_schema", schema: schema(voci.length > 0) } },
        messages: [{ role: "user", content: [doc, { type: "text", text: contesto }] }]
      })
    });
    j = await r.json().catch(() => null);
  } catch (e) {
    clearTimeout(timer);
    return Object.assign(vuoto, { ms: Date.now() - inizio, esito: "errore", errore: e && e.name === "AbortError" ? "tempo scaduto" : "rete",
      messaggio: "Non sono riuscito a leggere l'offerta: compila i campi a mano." });
  }
  clearTimeout(timer);
  const uso = (j && j.usage) || {};
  const base = {
    ms: Date.now() - inizio,
    token_in: (Number(uso.input_tokens) || 0) + (Number(uso.cache_creation_input_tokens) || 0) + (Number(uso.cache_read_input_tokens) || 0),
    token_out: Number(uso.output_tokens) || 0,
    modello: testo((j && j.model) || modello, 60)
  };
  const no = "Non sono riuscito a leggere l'offerta: compila i campi a mano.";
  if (!r.ok || !j) return Object.assign(base, { esito: "errore", errore: "api " + r.status + " " + testo(j && j.error && j.error.type, 60), messaggio: no });
  if (j.stop_reason === "refusal") return Object.assign(base, { esito: "rifiutata", errore: "refusal " + testo(j.stop_details && j.stop_details.category, 40), messaggio: no });
  if (j.stop_reason === "max_tokens") return Object.assign(base, { esito: "errore", errore: "max_tokens", messaggio: no });
  const blocco = lista(j.content).find((b) => b && b.type === "text" && typeof b.text === "string");
  let p = null;
  try { p = blocco ? JSON.parse(blocco.text) : null; } catch (e) { p = null; }
  if (!p || typeof p !== "object") return Object.assign(base, { esito: "errore", errore: "risposta non in JSON", messaggio: no });
  const proposta = pulisciPropostaOfferta(p, opz.fornitori, opz.materiali, voci);
  if (!proposta.fornitore && !proposta.righe.length && !proposta.numero) {
    return Object.assign(base, { esito: "vuota", proposta,
      messaggio: "Nel file non ho trovato i dati di un'offerta: controlla di aver scelto il file giusto, oppure compila a mano." });
  }
  return Object.assign(base, { esito: "ok", proposta });
}
