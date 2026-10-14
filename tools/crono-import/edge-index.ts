// crono-import — legge il file di un cronoprogramma e prepara le righe da confermare (14/10/2026, Claude per Filippo Obetti)
//
// Chi la chiama: il database (pg_net) appena arriva un file in crono_import — da WhatsApp (relay → crono_import_da_whatsapp)
//   o dall'area riservata (relay → crono_import_da_portale) — e la sveglia crono_import_sveglia ogni 2 minuti per i ritardatari.
//   Header x-crono-chiave = impostazioni.crono_chiave (verificata dal database in crono_import_prendi / crono_import_verifica).
// Cosa fa: prende il file dal bucket wa-media, riconosce il formato e lo legge:
//   • XML di MS Project, XML e XER di Primavera P6, Excel/CSV con intestazione → lettura diretta (leggi.js, costo zero)
//   • PDF, foto, Excel senza intestazione riconoscibile → Claude (documento/immagine/testo), poi la stessa normalizzazione
//   Poi accorcia i nomi lunghi per i pulsanti WhatsApp (≤ 24 caratteri) e scrive il risultato (crono_import_scrivi):
//   il database manda a chi ha scritto il riepilogo con «Conferma / Annulla». Nulla cambia nel giornale finché non si conferma.
// Prova senza database: POST {"prova": {"b64": "...", "nome_file": "x.pdf", "mime": "application/pdf"}} con la stessa chiave.
// Chiave Anthropic: ANTHROPIC_API_KEY_CRONO se presente, altrimenti ANTHROPIC_API_KEY_CHAT.

import { XMLParser } from "npm:fast-xml-parser@4.5.0";
import * as XLSX from "npm:xlsx@0.18.5";
import { creaLettore } from "./leggi.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY_CRONO") || Deno.env.get("ANTHROPIC_API_KEY_CHAT") || "";
const MAX_BYTE = 18 * 1024 * 1024;
const PREZZO_IN = 2 / 1e6, PREZZO_OUT = 10 / 1e6; // $/token, stima per il registro dei costi
const L = creaLettore({ XMLParser, XLSX });

function encodeBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
  return btoa(s);
}
function decodeBase64(t: string): Uint8Array {
  const s = atob(t.replace(/\s+/g, ""));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

type Json = Record<string, unknown>;

async function rpc(nome: string, argomenti: Json): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nome}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify(argomenti),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`rpc ${nome}: HTTP ${r.status} ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}

async function scarica(percorso: string): Promise<Uint8Array> {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/wa-media/${percorso.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`il file non si scarica dall'archivio (HTTP ${r.status})`);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length > MAX_BYTE) throw new Error("il file è troppo grande (oltre 18 MB)");
  return b;
}

// ---------------------------------------------------------------------------------------------- Claude
const uso = { tin: 0, tout: 0, chiamate: 0 };
async function chiedi(corpo: Json, tempoMs: number) {
  const inizio = Date.now();
  for (let tentativo = 1; tentativo <= 2; tentativo++) {
    const restante = tempoMs - (Date.now() - inizio);
    if (restante < 5000) break;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), restante);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(corpo), signal: ac.signal,
      });
      const t = await r.text();
      clearTimeout(timer);
      let dati: any = null;
      try { dati = JSON.parse(t); } catch (_e) { dati = null; }
      if (r.ok) {
        const u = dati?.usage ?? {};
        uso.tin += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        uso.tout += u.output_tokens ?? 0; uso.chiamate++;
        const testo = (Array.isArray(dati?.content) ? dati.content : []).filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n");
        return { ok: true, testo, troncato: dati?.stop_reason === "max_tokens" };
      }
      const dettaglio = `HTTP ${r.status} ${String(dati?.error?.message ?? t).slice(0, 120)}`.replace(/\s+/g, " ");
      if (tentativo === 1 && [429, 500, 502, 503, 504, 529].includes(r.status)) { await new Promise((ok) => setTimeout(ok, 2500)); continue; }
      return { ok: false, testo: "", dettaglio };
    } catch (e) {
      clearTimeout(timer);
      if (ac.signal.aborted) return { ok: false, testo: "", dettaglio: "tempo scaduto" };
      if (tentativo === 1) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
      return { ok: false, testo: "", dettaglio: `rete: ${String(e).slice(0, 100)}` };
    }
  }
  return { ok: false, testo: "", dettaglio: "tempo scaduto" };
}

function estraiJson(testo: string): any | null {
  const t = testo.replace(/```(?:json)?/gi, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_e) { return null; }
}

const ISTRUZIONI = `Sei il lettore di cronoprogrammi del «Giornale Lavori», il registro digitale dei cantieri edili italiani.
Ricevi un cronoprogramma dei lavori (diagramma di Gantt o tabella stampata da MS Project, Primavera, Excel, oppure una foto) e ne trascrivi la tabella delle attività.

Rispondi SOLO con un oggetto JSON, senza testo prima o dopo:
{"data_documento": "AAAA-MM-GG" oppure null, "righe": [[id, livello, tipo, "nome", durata, "inizio", "fine"], ...]}

Regole:
- Una riga per ogni riga della tabella delle attività, nello stesso ordine del documento, compresi i titoli dei gruppi e i traguardi.
- Salta: righe vuote (numero senza nome), intestazioni di colonna, legende, note a piè di pagina, scale dei tempi del Gantt, e la riga che riassume l'intero progetto con il nome del progetto o del file (quella sopra a tutti i gruppi, se c'è).
- id: il numero della colonna ID / N. / Nr. se esiste, altrimenti null.
- livello: 1 = il più esterno. Ricavalo dal rientro del nome, dalla numerazione WBS (1 / 1.2 / 1.2.3) o dal grassetto dei titoli di gruppo. Un'attività sotto un gruppo ha livello maggiore del gruppo.
- tipo: "R" = gruppo/riepilogo (ha attività sotto di sé, di solito in grassetto o con barra nera), "C" = traguardo/cardine/milestone (rombo nel Gantt, durata 0), "A" = lavorazione normale.
- nome: esattamente come scritto, senza correggere. Se il nome va a capo su più righe, uniscile in un solo nome.
- durata: numero di giorni (lavorativi) come scritto («40 g» → 40, «0g» → 0); null se manca. Settimane «2 sett» → 10.
- inizio, fine: date in formato AAAA-MM-GG. Le date italiane sono giorno/mese/anno; anno a due cifre → 20aa («lun 05/10/26» → 2026-10-05). Trascrivi le date come sono scritte, anche se sembrano strane. null se mancano.
- data_documento: la data del cronoprogramma se è scritta (titolo, intestazione, nome del file, «aggiornato al»), altrimenti null.
- Se il documento NON è un cronoprogramma (o la tabella non si legge), rispondi {"errore": "spiegazione breve in italiano"}.`;

async function estraiConAi(contenuto: any[], modello: string, nota: string): Promise<{ righe: any[]; data_documento: string | null }> {
  if (!ANTHROPIC_KEY) throw new Error("manca la chiave per la lettura automatica");
  const es = await chiedi({
    model: modello, max_tokens: 24000, thinking: { type: "disabled" },
    system: [{ type: "text", text: ISTRUZIONI, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [...contenuto, { type: "text", text: nota }] }],
  }, 140000);
  if (!es.ok) throw new Error(`la lettura automatica non ha risposto (${es.dettaglio})`);
  const v = estraiJson(es.testo);
  if (!v) throw new Error(es.troncato ? "il cronoprogramma è troppo lungo per una sola lettura: mandalo come XML di Project o Excel" : "la lettura automatica non ha dato un risultato valido");
  if (v.errore) throw new Error(String(v.errore).slice(0, 300));
  const righe = (Array.isArray(v.righe) ? v.righe : []).filter((r: any) => Array.isArray(r) && r.length >= 4).map((r: any[]) => ({
    id: r[0] === null || r[0] === undefined || r[0] === "" ? null : Number(r[0]),
    livello: Number(r[1]) || 1,
    nome: String(r[3] ?? ""),
    durata: r[4] === null || r[4] === undefined || r[4] === "" ? null : Math.max(0, Math.round(Number(r[4]))),
    inizio: r[5] ? String(r[5]) : null, fine: r[6] ? String(r[6]) : null,
    riepilogo: String(r[2]).toUpperCase() === "R" ? true : null,
    cardine: String(r[2]).toUpperCase() === "C" ? true : (String(r[2]).toUpperCase() === "A" ? false : null),
  }));
  return { righe, data_documento: typeof v.data_documento === "string" ? v.data_documento : null };
}

// Testo del PDF con le posizioni (unpdf = pdf.js per ambienti senza browser), pagina per pagina
async function testoPdf(bytes: Uint8Array) {
  const { getDocumentProxy } = await import("npm:unpdf@0.12.1");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pagine: any[] = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 60); n++) {
    const tc = await (await pdf.getPage(n)).getTextContent();
    pagine.push(tc.items.map((i: any) => ({ s: i.str, a: i.transform[4], b: i.transform[5], f: i.fontName })));
  }
  return L.leggiPdfTesto(pagine);
}

// PDF lunghi: parti da 3 pagine lette in parallelo (al massimo 3 per volta), poi riunite nell'ordine
async function leggiPdf(bytes: Uint8Array, modello: string, nota: string) {
  let pagine = 0;
  let PDFDocument: any = null;
  try {
    ({ PDFDocument } = await import("npm:pdf-lib@1.17.1"));
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    pagine = doc.getPageCount();
  } catch (_e) { pagine = 0; }
  if (pagine <= 4 || !PDFDocument) {
    return await estraiConAi([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: encodeBase64(bytes) } }], modello, nota);
  }
  if (pagine > 60) throw new Error("il PDF ha più di 60 pagine: mandami solo le pagine del cronoprogramma");
  const sorgente = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const parti: Uint8Array[] = [];
  for (let p = 0; p < pagine; p += 3) {
    const nuovo = await PDFDocument.create();
    const idx = [p, p + 1, p + 2].filter((x) => x < pagine);
    (await nuovo.copyPages(sorgente, idx)).forEach((pg: any) => nuovo.addPage(pg));
    parti.push(await nuovo.save());
  }
  const risultati: any[] = new Array(parti.length);
  let prossimo = 0;
  const lavoratore = async () => {
    while (prossimo < parti.length) {
      const k = prossimo++;
      risultati[k] = await estraiConAi([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: encodeBase64(parti[k]) } }], modello,
        `${nota}\nQuesta è la parte ${k + 1} di ${parti.length} del documento (pagine ${k * 3 + 1}–${Math.min(pagine, k * 3 + 3)} di ${pagine}): trascrivi solo le righe che compaiono in queste pagine; se non ci sono righe della tabella rispondi {"righe": []}.`)
        .catch((e) => ({ righe: [], data_documento: null, errore: String(e?.message ?? e) }));
    }
  };
  await Promise.all([lavoratore(), lavoratore(), lavoratore()]);
  const righe = risultati.flatMap((r) => r.righe);
  if (!righe.length) throw new Error(risultati.find((r) => r.errore)?.errore ?? "nel PDF non ho trovato le righe del cronoprogramma");
  // righe ripetute tra una parte e l'altra (stesso numero e nome) contano una volta
  const viste = new Set<string>();
  const uniche = righe.filter((r) => { if (r.id === null) return true; const k = r.id + "|" + r.nome; if (viste.has(k)) return false; viste.add(k); return true; });
  return { righe: uniche, data_documento: risultati.find((r) => r.data_documento)?.data_documento ?? null };
}

// Nomi brevi (≤ 24 caratteri) per le liste WhatsApp: Claude per i nomi lunghi, abbreviazione automatica se non risponde
const ISTRUZIONI_BREVI = "Accorci i nomi delle lavorazioni di un cronoprogramma di cantiere per una lista WhatsApp. " +
  "Ogni nome breve deve avere AL MASSIMO 22 caratteri spazi compresi (conta i caratteri: oltre 24 la risposta viene scartata), in italiano, comprensibile a chi lavora in cantiere. " +
  "Tieni sempre la parola che distingue la lavorazione dalle altre dello stesso gruppo (zona 1 / zona 2, piano terra / primo, linea 1 / 2, magazzini / uffici). " +
  "Abbreviazioni ammesse: impianto → imp., fondazione → fondaz., pavimentazione → pavim., prefabbricato → prefabbr., realizzazione → (togli), completamento → fine, installazione → inst., zona 1 → Z1. " +
  "Esempi: «Completamento opere di fondazione zona magazzini - zona 1» → «Fondaz. magazz. Z1»; «Realizzazione apparato fondale in cemento armato per prefabbricato (plinti di fondazione)» → «Plinti di fondazione». " +
  "Rispondi SOLO con JSON {\"codice\": \"nome breve\", ...}.";

async function nomiBrevi(righe: any[], modello: string) {
  const perCod = new Map(righe.map((r) => [r.codice, r]));
  let mancano = righe.filter((r) => r.nome.length > 24);
  for (let giro = 0; giro < 2 && mancano.length && ANTHROPIC_KEY; giro++) {
    for (let i = 0; i < mancano.length; i += 120) {
      const blocco = mancano.slice(i, i + 120);
      const elenco = blocco.map((r) => `${r.codice}\t${r.nome}${r.parent_codice != null && perCod.get(r.parent_codice) ? `\t(gruppo: ${perCod.get(r.parent_codice).nome})` : ""}`).join("\n");
      const es = await chiedi({
        model: modello, max_tokens: 6000, thinking: { type: "disabled" },
        system: ISTRUZIONI_BREVI + (giro ? " ATTENZIONE: i nomi proposti prima erano troppo lunghi, accorciali di più." : ""),
        messages: [{ role: "user", content: elenco }],
      }, 60000);
      if (!es.ok) { giro = 2; break; }
      const v = estraiJson(es.testo);
      if (!v) continue;
      for (const r of blocco) {
        const b = String(v[String(r.codice)] ?? "").replace(/\s+/g, " ").trim();
        if (b && b.length <= 24) { r.nome_breve = b; r._breveAi = true; }
      }
    }
    mancano = mancano.filter((r) => !r._breveAi);
  }
  // nello stesso gruppo due nomi brevi uguali non si distinguerebbero nella lista: si aggiunge la parola che li distingue
  const perGruppo = new Map<string, any[]>();
  for (const r of righe) { const k = String(r.parent_codice) + "|" + r.nome_breve; if (!perGruppo.has(k)) perGruppo.set(k, []); perGruppo.get(k)!.push(r); }
  for (const doppi of perGruppo.values()) {
    if (doppi.length < 2) continue;
    doppi.forEach((r, i) => {
      const parole = r.nome.replace(/[()\-–,.]/g, " ").split(/\s+/).filter(Boolean);
      let coda = parole[parole.length - 1] || String(i + 1);
      if (/^\d+$/.test(coda) && parole.length > 1) coda = parole[parole.length - 2].slice(0, 1).toUpperCase() + coda;
      coda = " " + coda.slice(0, 8);
      r.nome_breve = (r.nome_breve.slice(0, 24 - coda.length).trim() + coda).slice(0, 24);
    });
  }
  for (const r of righe) delete r._breveAi;
}

// ---------------------------------------------------------------------------------------------- lettura di un file
async function leggiFile(bytes: Uint8Array, nomeFile: string, mime: string, modello: string, didascalia: string, cantiere: string) {
  const t0 = Date.now();
  uso.tin = 0; uso.tout = 0; uso.chiamate = 0;
  const formato = L.riconosci(bytes, nomeFile, mime);
  const nota = `File: ${nomeFile || "(senza nome)"}${cantiere ? ` — cantiere «${cantiere}»` : ""}${didascalia ? ` — messaggio: «${didascalia.slice(0, 200)}»` : ""}`;
  let grezze: any[] = []; let dataDoc: string | null = null; let formatoFinale = formato;
  const avvisi: string[] = [];
  if (formato === "mpp") throw new Error("è un file .mpp di Microsoft Project, che fuori da Project non si apre: da Project fai File → Salva con nome → XML (oppure stampa in PDF) e rimandalo");
  if (formato === "docx") throw new Error("è un documento Word: salvalo in PDF e rimandalo");
  if (formato === "xml_altro") throw new Error("è un file XML che non viene da MS Project né da Primavera");
  if (formato === "sconosciuto") throw new Error("non riconosco il tipo di file: mandalo in PDF, Excel o XML di Project");
  if (formato === "pdf") {
    // 1) PDF con il testo (stampa di Project e simili): righe, date e rientri letti come sono stampati, senza AI
    let t: any = null;
    try { t = await testoPdf(bytes); } catch (e) { console.log(JSON.stringify({ testo_pdf: String(e).slice(0, 150) })); t = null; }
    if (t && t.righe.length >= 5 && t.copertura >= 0.8) {
      grezze = t.righe; formatoFinale = "pdf";
      const m = /(20\d\d)[-_. ](\d\d)[-_. ](\d\d)/.exec(nomeFile) || null;
      dataDoc = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    } else {
      // 2) PDF scansionato o impaginato in modo diverso: lettura con Claude
      const r = await leggiPdf(bytes, modello, nota); grezze = r.righe; dataDoc = r.data_documento;
    }
  } else if (formato === "immagine") {
    if (bytes.length > 4.5 * 1024 * 1024) throw new Error("la foto è troppo grande: mandala compressa (come foto, non come documento)");
    const tipo = bytes[0] === 0x89 ? "image/png" : bytes[0] === 0x52 ? "image/webp" : bytes[0] === 0x47 ? "image/gif" : "image/jpeg";
    const r = await estraiConAi([{ type: "image", source: { type: "base64", media_type: tipo, data: encodeBase64(bytes) } }], modello,
      nota + "\nÈ una foto: leggi solo le righe che si vedono con certezza.");
    grezze = r.righe; dataDoc = r.data_documento;
    avvisi.push("letto da una foto: controlla nomi e date prima di confermare");
  } else {
    const s: any = L.leggiStrutturato(bytes, formato);
    if (s.perAi) {
      const r = await estraiConAi([{ type: "text", text: `Tabella estratta dal file (celle separate da « | »):\n${s.perAi.testo.slice(0, 120000)}` }], modello, nota);
      grezze = r.righe; dataDoc = r.data_documento; formatoFinale = s.perAi.formato;
    } else { grezze = s.righe; dataDoc = s.data_documento; formatoFinale = s.formato; }
  }
  const n = L.normalizza(grezze, { avvisi });
  await nomiBrevi(n.righe, modello);
  return {
    esito: "pronto", formato: formatoFinale, righe: n.righe, avvisi: n.avvisi, data_documento: dataDoc && /^\d{4}-\d{2}-\d{2}$/.test(dataDoc) ? dataDoc : null,
    costo_usd: Math.round((uso.tin * PREZZO_IN + uso.tout * PREZZO_OUT) * 10000) / 10000, modello: uso.chiamate ? modello : "lettura diretta",
    durata_ms: Date.now() - t0, token_in: uso.tin, token_out: uso.tout,
  };
}

async function lavora(chiave: string, massimo: number) {
  let fatti = 0;
  for (let k = 0; k < massimo; k++) {
    let presa: any;
    try { presa = await rpc("crono_import_prendi", { p_chiave: chiave, p_id: null }); }
    catch (e) { console.error(JSON.stringify({ errore: "prendi", dettaglio: String(e).slice(0, 200) })); return fatti; }
    if (presa?.esito !== "ok" || !presa.riga) return fatti;
    const r = presa.riga;
    let ris: Json;
    try {
      const bytes = await scarica(r.storage_path);
      ris = await leggiFile(bytes, r.nome_file ?? "", r.mime ?? "", presa.modello, r.didascalia ?? "", r.cantiere ?? "");
    } catch (e) {
      ris = { esito: "errore", errore: String((e as Error)?.message ?? e).slice(0, 380),
              costo_usd: Math.round((uso.tin * PREZZO_IN + uso.tout * PREZZO_OUT) * 10000) / 10000 };
    }
    try { await rpc("crono_import_scrivi", { p_chiave: chiave, p_id: r.id, p_ris: ris }); }
    catch (e) { console.error(JSON.stringify({ errore: "scrivi", id: r.id, dettaglio: String(e).slice(0, 200) })); }
    console.log(JSON.stringify({ id: r.id, esito: ris.esito, formato: ris.formato, righe: Array.isArray(ris.righe) ? ris.righe.length : 0, errore: ris.errore, costo: ris.costo_usd, ms: ris.durata_ms }));
    fatti++;
  }
  return fatti;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("metodo non ammesso", { status: 405 });
  const chiave = req.headers.get("x-crono-chiave") ?? "";
  if (!chiave) return new Response("chiave mancante", { status: 401 });
  let corpo: any = {};
  try { corpo = await req.json(); } catch (_e) { corpo = {}; }
  let valida = false;
  try { valida = await rpc("crono_import_verifica", { p_chiave: chiave }) === true; } catch (_e) { valida = false; }
  if (!valida) return new Response(JSON.stringify({ esito: "chiave_errata" }), { status: 403 });

  if (corpo?.prova?.b64) {
    try {
      const bytes = decodeBase64(String(corpo.prova.b64));
      const ris = await leggiFile(bytes, String(corpo.prova.nome_file ?? ""), String(corpo.prova.mime ?? ""),
        String(corpo.prova.modello ?? "claude-sonnet-5"), String(corpo.prova.didascalia ?? ""), String(corpo.prova.cantiere ?? ""));
      return new Response(JSON.stringify(ris), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ esito: "errore", errore: String((e as Error)?.message ?? e) }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }

  const lavoro = lavora(chiave, 3).catch((e) => console.error(JSON.stringify({ errore: "lavora", dettaglio: String(e).slice(0, 200) })));
  // @ts-ignore EdgeRuntime esiste nelle funzioni di Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) { EdgeRuntime.waitUntil(lavoro); }
  else { await lavoro; }
  return new Response(JSON.stringify({ esito: "avviata" }), { status: 202, headers: { "Content-Type": "application/json" } });
});
