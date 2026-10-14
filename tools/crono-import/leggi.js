// leggi.js — lettura dei file di cronoprogramma per il Giornale Lavori (14/10/2026, Claude per Filippo Obetti).
// Parte «pura» della funzione crono-import: nessuna rete, nessun database. Riceve i byte del file e restituisce
// le righe nel formato di crono_attivita. Le librerie arrivano da fuori (Deno: npm:..., prove: node_modules).
//
// Formati letti qui senza intelligenza artificiale (costo zero):
//   • XML di Microsoft Project (File → Salva con nome → XML)
//   • XML di Primavera P6 (APIBusinessObjects) e XER di Primavera P6
//   • Excel (.xlsx/.xls/.ods) e CSV con una riga di intestazione riconoscibile (Nome/Attività, Inizio, Fine, Durata…)
// PDF, foto ed Excel «disegnati» vanno all'intelligenza artificiale (index.ts) e tornano qui per la normalizzazione.

export function creaLettore({ XMLParser, XLSX }) {
  // ------------------------------------------------------------------ riconoscimento
  function riconosci(bytes, nome, mime) {
    const n = String(nome || "").toLowerCase();
    const m = String(mime || "").toLowerCase();
    const b = bytes;
    const inizia = (...x) => x.every((v, i) => b[i] === v);
    if (b.length >= 4 && inizia(0x25, 0x50, 0x44, 0x46)) return "pdf";
    if (b.length >= 3 && inizia(0xff, 0xd8, 0xff)) return "immagine";
    if (b.length >= 8 && inizia(0x89, 0x50, 0x4e, 0x47)) return "immagine";
    if (b.length >= 12 && inizia(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "immagine";
    if (b.length >= 4 && inizia(0x47, 0x49, 0x46, 0x38)) return "immagine";
    if (b.length >= 4 && inizia(0x50, 0x4b, 0x03, 0x04)) {
      if (/\.docx?$/.test(n) || /wordprocessing/.test(m)) return "docx";
      if (/\.mpp$/.test(n)) return "mpp";
      return "excel";
    }
    if (b.length >= 8 && inizia(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
      if (/\.mpp$/.test(n) || /ms-project|msproj/.test(m)) return "mpp";
      if (/\.docx?$/.test(n) || /msword/.test(m)) return "docx";
      return "excel";
    }
    if (/\.mpp$/.test(n)) return "mpp";
    const t = testoDa(bytes).replace(/^﻿/, "");
    const inizio = t.slice(0, 4000);
    if (/^\s*ERMHDR/.test(inizio)) return "xer";
    if (/<Project[\s>]/.test(inizio) && /schemas\.microsoft\.com\/project/i.test(inizio)) return "msproject_xml";
    if (/APIBusinessObjects/.test(inizio)) return "p6_xml";
    if (/^\s*</.test(inizio)) return "xml_altro";
    if (/\.(csv|txt|tsv)$/.test(n) || /text\/(csv|plain|tab)/.test(m) || /[;,\t]/.test(inizio)) return "csv";
    return "sconosciuto";
  }

  function testoDa(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (_e) { return new TextDecoder("windows-1252").decode(bytes); }
  }

  // ------------------------------------------------------------------ date e durate
  const MESI = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12,
    jan: 1, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, dec: 12, genn: 1, febb: 2, sett: 9 };
  function iso(a, m, g) {
    if (!(a >= 1990 && a <= 2100 && m >= 1 && m <= 12 && g >= 1 && g <= 31)) return null;
    const d = new Date(Date.UTC(a, m - 1, g));
    if (d.getUTCMonth() !== m - 1) return null;
    return d.toISOString().slice(0, 10);
  }
  function anno(x) { const n = Number(x); return n < 100 ? 2000 + n : n; }
  function data(v) {
    if (v === null || v === undefined || v === "") return null;
    if (v instanceof Date && !isNaN(v.getTime())) {
      // SheetJS: date senza ora come mezzanotte locale; si arrotonda al giorno più vicino
      const t = new Date(v.getTime() + 12 * 3600 * 1000 - v.getTimezoneOffset() * 60000);
      return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    if (typeof v === "number") {
      if (v > 20000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000); return d.toISOString().slice(0, 10); }
      return null;
    }
    const s = String(v).trim().toLowerCase().replace(/^[a-zà-ú]{2,9}\.?\s+(?=\d)/, ""); // «lun 05/10/26» → «05/10/26»
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/);
    if (m) return iso(anno(m[3]), +m[2], +m[1]);
    m = s.match(/^(\d{1,2})[\s\-\/.]+([a-zà-ú]{3,9})\.?[\s\-\/.]+(\d{2,4})\b/);
    if (m) { const k = MESI[m[2].slice(0, 4)] || MESI[m[2].slice(0, 3)]; if (k) return iso(anno(m[3]), k, +m[1]); }
    return null;
  }
  function durataGiorni(v, oreGiorno) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? Math.max(0, Math.round(v)) : null;
    const s = String(v).trim().toLowerCase().replace(",", ".").replace(/\?/g, "");
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([a-zà-ú]*)/);
    if (!m) return null;
    const n = Number(m[1]); const u = m[2];
    if (!isFinite(n)) return null;
    let g = n;
    if (/^(h|o|ore|hr|hrs|hour)/.test(u)) g = n / (oreGiorno || 8);
    else if (/^(s|w|sett|wk|week)/.test(u)) g = n * 5;
    else if (/^(me|ms|mo|mes|month)/.test(u)) g = n * 20;
    else if (/^(min|m$)/.test(u)) g = n / 60 / (oreGiorno || 8);
    return Math.max(0, Math.round(g));
  }
  function durataIso(v, minutiGiorno) { // MS Project: PT40H0M0S, P5DT0H0M0S
    const m = String(v || "").match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!m) return null;
    const minuti = (Number(m[1] || 0) * (minutiGiorno || 480)) + Number(m[2] || 0) * 60 + Number(m[3] || 0);
    return Math.round(minuti / (minutiGiorno || 480));
  }
  function giorniLavorativi(a, b) { // estremi compresi, lunedì-venerdì
    if (!a || !b) return null;
    let d = new Date(a + "T00:00:00Z"), f = new Date(b + "T00:00:00Z");
    if (f < d) [d, f] = [f, d];
    let n = 0;
    for (let x = new Date(d); x <= f && n < 5000; x.setUTCDate(x.getUTCDate() + 1)) { const w = x.getUTCDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }
  function aggiungiLavorativi(a, n) {
    if (!a || !(n > 0)) return a;
    const x = new Date(a + "T00:00:00Z"); let k = 1;
    while (k < n) { x.setUTCDate(x.getUTCDate() + 1); const w = x.getUTCDay(); if (w !== 0 && w !== 6) k++; }
    return x.toISOString().slice(0, 10);
  }
  function siNo(v) {
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    const s = String(v ?? "").trim().toLowerCase();
    if (/^(s[iì]|yes|y|true|vero|x|1)$/.test(s)) return true;
    if (/^(no|n|false|falso|0)$/.test(s)) return false;
    return null;
  }

  // ------------------------------------------------------------------ MS Project XML
  function leggiMsProject(testo) {
    const p = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true, isArray: (n) => n === "Task" });
    const j = p.parse(testo);
    const pr = j && j.Project;
    if (!pr) throw new Error("il file XML non è un progetto di Microsoft Project");
    const minGiorno = Number(pr.MinutesPerDay) || 480;
    const righe = [];
    for (const t of (pr.Tasks && pr.Tasks.Task) || []) {
      if (String(t.IsNull) === "1" || String(t.Active) === "0") continue;
      const liv = Number(t.OutlineLevel);
      if (liv === 0) continue; // riga di riepilogo dell'intero progetto
      const nome = String(t.Name ?? "").trim();
      if (!nome) continue;
      righe.push({
        id: Number(t.ID), livello: isFinite(liv) && liv > 0 ? liv : 1, nome,
        inizio: data(String(t.Start || "").slice(0, 10)), fine: data(String(t.Finish || "").slice(0, 10)),
        durata: durataIso(t.Duration, minGiorno),
        cardine: String(t.Milestone) === "1", riepilogo: String(t.Summary) === "1"
      });
    }
    const dd = data(String(pr.LastSaved || pr.CreationDate || "").slice(0, 10));
    return { righe, data_documento: dd, formato: "msproject_xml" };
  }

  // ------------------------------------------------------------------ Primavera (XML e XER): albero WBS + attività
  function alberoWbs(wbs, att) {
    const perId = new Map(wbs.map((w) => [String(w.id), w]));
    const figliW = new Map(), figliA = new Map();
    const radiceW = [], radiceA = [];
    for (const w of wbs) {
      const p = String(w.parent ?? "");
      if (perId.has(p) && p !== String(w.id)) { if (!figliW.has(p)) figliW.set(p, []); figliW.get(p).push(w); } else radiceW.push(w);
    }
    for (const a of att) {
      const p = String(a.wbs ?? "");
      if (perId.has(p)) { if (!figliA.has(p)) figliA.set(p, []); figliA.get(p).push(a); } else radiceA.push(a);
    }
    const perSeq = (x, y) => (Number(x.seq) || 0) - (Number(y.seq) || 0) || String(x.nome).localeCompare(String(y.nome));
    const perData = (x, y) => String(x.inizio || "9999").localeCompare(String(y.inizio || "9999")) || String(x.codice || "").localeCompare(String(y.codice || ""));
    const conta = new Map();
    const nAtt = (w) => {
      const k = String(w.id); if (conta.has(k)) return conta.get(k);
      conta.set(k, 0);
      const n = (figliA.get(k) || []).length + (figliW.get(k) || []).reduce((s, x) => s + nAtt(x), 0);
      conta.set(k, n); return n;
    };
    const righe = [];
    const giu = (w, liv) => {
      if (nAtt(w) === 0) return;
      righe.push({ id: null, livello: liv, nome: String(w.nome || "").trim() || "Gruppo", riepilogo: true, cardine: false });
      for (const a of (figliA.get(String(w.id)) || []).sort(perData)) righe.push(Object.assign({}, a, { livello: liv + 1 }));
      for (const x of (figliW.get(String(w.id)) || []).sort(perSeq)) giu(x, liv + 1);
    };
    for (const a of radiceA.sort(perData)) righe.push(Object.assign({}, a, { livello: 1 }));
    for (const w of radiceW.sort(perSeq)) giu(w, 1);
    return righe;
  }

  function leggiP6Xml(testo) {
    const p = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true,
      isArray: (n) => n === "Project" || n === "WBS" || n === "Activity" });
    const j = p.parse(testo);
    const root = j && j.APIBusinessObjects;
    const progetti = (root && root.Project) || [];
    if (!progetti.length) throw new Error("nel file XML di Primavera non c'è nessun progetto");
    const pr = progetti.slice().sort((a, b) => ((b.Activity || []).length - (a.Activity || []).length))[0];
    const wbs = (pr.WBS || []).map((w) => ({ id: w.ObjectId, parent: w.ParentObjectId, nome: w.Name, seq: w.SequenceNumber }));
    const att = (pr.Activity || []).map((a) => {
      const tipo = String(a.Type || "");
      return {
        id: null, codice: String(a.Id || ""), wbs: a.WBSObjectId, nome: String(a.Name || "").trim(),
        inizio: data(String(a.PlannedStartDate || a.StartDate || "").slice(0, 10)),
        fine: data(String(a.PlannedFinishDate || a.FinishDate || "").slice(0, 10)),
        durata: a.PlannedDuration !== undefined && a.PlannedDuration !== "" ? Math.round(Number(a.PlannedDuration) / 8) : null,
        cardine: /milestone/i.test(tipo), riepilogo: /wbs summary|level of effort/i.test(tipo) ? false : null
      };
    }).filter((a) => a.nome);
    const dd = data(String(pr.DataDate || pr.LastUpdateDate || "").slice(0, 10));
    return { righe: alberoWbs(wbs, att), data_documento: dd, formato: "p6_xml" };
  }

  function leggiXer(testo) {
    const tabelle = {};
    let cur = null, campi = null;
    for (const linea of testo.split(/\r?\n/)) {
      if (linea.startsWith("%T\t")) { cur = linea.slice(3).trim(); tabelle[cur] = []; campi = null; }
      else if (linea.startsWith("%F\t")) campi = linea.slice(3).split("\t");
      else if (linea.startsWith("%R\t") && cur && campi) {
        const v = linea.slice(3).split("\t"); const o = {};
        campi.forEach((c, i) => { o[c] = v[i]; }); tabelle[cur].push(o);
      }
    }
    const task = tabelle.TASK || [];
    if (!task.length) throw new Error("nel file XER non ci sono attività (tabella TASK)");
    const perProg = new Map();
    for (const t of task) perProg.set(t.proj_id, (perProg.get(t.proj_id) || 0) + 1);
    const prog = [...perProg.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const wbsTutte = (tabelle.PROJWBS || []).filter((w) => w.proj_id === prog);
    const nodoProgetto = new Set(wbsTutte.filter((w) => w.proj_node_flag === "Y").map((w) => w.wbs_id));
    const wbs = wbsTutte.filter((w) => !nodoProgetto.has(w.wbs_id))
      .map((w) => ({ id: w.wbs_id, parent: nodoProgetto.has(w.parent_wbs_id) ? "" : w.parent_wbs_id, nome: w.wbs_name, seq: w.seq_num }));
    const att = task.filter((t) => t.proj_id === prog && t.task_type !== "TT_WBS").map((t) => ({
      id: null, codice: t.task_code, wbs: nodoProgetto.has(t.wbs_id) ? "" : t.wbs_id, nome: String(t.task_name || "").trim(),
      inizio: data(String(t.target_start_date || t.early_start_date || t.act_start_date || "").slice(0, 10)),
      fine: data(String(t.target_end_date || t.early_end_date || t.act_end_date || "").slice(0, 10)),
      durata: t.target_drtn_hr_cnt !== undefined && t.target_drtn_hr_cnt !== "" ? durataGiorni(Number(t.target_drtn_hr_cnt) / 8, 8) : null,
      cardine: /TT_Mile|TT_FinMile/.test(t.task_type || ""), riepilogo: null
    })).filter((a) => a.nome);
    const projRow = (tabelle.PROJECT || []).find((p) => p.proj_id === prog) || {};
    return { righe: alberoWbs(wbs, att), data_documento: data(String(projRow.last_recalc_date || "").slice(0, 10)), formato: "xer" };
  }

  // ------------------------------------------------------------------ tabelle (Excel, CSV)
  function norm(s) {
    return String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  }
  const ESCLUDI_DATA = /(effettiv|actual|reale|baseline|linea di base|previsione 0|interim|late|tard|libero|totale|slack|margine)/;
  const NOME_ESATTO = /^(nome attivita|nome dell'attivita|nome|attivita|task name|name|descrizione|descrizione attivita|descrizione lavorazion[ei]|lavorazion[ei]|denominazione|voce|fase|descrizione lavori|activity name)$/;
  const COLONNE = [
    ["nome", (h) => /^(nome attivita|nome dell'attivita|nome|attivita|task name|name|descrizione( attivita| lavorazion[ei])?|lavorazion[ei]|denominazione|voce|fase|oggetto|lavori|descrizione lavori|activity name)$/.test(h)
      || (/(nome|attivita|lavorazion|descrizion|task|activity)/.test(h) && !/(risors|resource|\bid\b|codice|cod\.|n\.|predecess|success|note|tipo|wbs|modalit|mode|stato|status|percent|%|calendar)/.test(h))],
    ["inizio", (h) => /(^inizio|start|^dal$|^da$|data inizio|inizio lavori|^inizio previsto)/.test(h) && !ESCLUDI_DATA.test(h)],
    ["fine", (h) => /(^fine|finish|^al$|^a$|data fine|termine|^end|fine prevista|fine lavori)/.test(h) && !ESCLUDI_DATA.test(h)],
    ["durata", (h) => /(^durata|duration|^gg$|^giorni|^gg lav|^gg\.)/.test(h) && !/(effettiv|actual|rimanente|remaining|baseline)/.test(h)],
    ["livello", (h) => /(livello|outline level|^level$|^liv\.?$|livello struttura)/.test(h)],
    ["wbs", (h) => /^(wbs|edt|numero struttura|outline number|codice wbs|struttura|n\. struttura)$/.test(h)],
    ["id", (h) => /^(id|n|nr|n\.|n°|num|numero|#|pos\.?|codice|cod\.?|id attivita|activity id|task id)$/.test(h)],
    ["riepilogo", (h) => /(riepilogo|summary)/.test(h)],
    ["cardine", (h) => /(cardine|milestone|traguardo)/.test(h)]
  ];
  function trovaIntestazione(righe) {
    let migliore = null;
    for (let r = 0; r < Math.min(righe.length, 40); r++) {
      const h = (righe[r] || []).map(norm);
      const mappa = {}; const usate = new Set();
      const esatto = h.findIndex((x) => NOME_ESATTO.test(x));
      if (esatto !== -1) { mappa.nome = esatto; usate.add(esatto); }
      for (const [campo, prova] of COLONNE) {
        if (mappa[campo] !== undefined) continue;
        for (let c = 0; c < h.length; c++) { if (!usate.has(c) && h[c] && prova(h[c])) { mappa[campo] = c; usate.add(c); break; } }
      }
      if (mappa.nome === undefined || (mappa.inizio === undefined && mappa.fine === undefined)) continue;
      const punti = Object.keys(mappa).length;
      if (!migliore || punti > migliore.punti) migliore = { riga: r, mappa, punti };
    }
    return migliore;
  }
  function daTabella(righe, formato) {
    const int = trovaIntestazione(righe);
    if (!int) return null;
    const m = int.mappa; const out = [];
    const prendi = (r, k) => (m[k] === undefined ? null : r[m[k]]);
    for (let i = int.riga + 1; i < righe.length; i++) {
      const r = righe[i] || [];
      const nomeGrezzo = prendi(r, "nome");
      const nome = String(nomeGrezzo ?? "").replace(/\s+$/, "");
      if (!nome.trim()) continue;
      const rientro = (nome.match(/^\s*/) || [""])[0].replace(/\t/g, "    ").length;
      const wbs = String(prendi(r, "wbs") ?? "").trim();
      let liv = Number(prendi(r, "livello"));
      if (!(liv > 0) && /^\d+(\.\d+)*$/.test(wbs)) liv = wbs.split(".").length;
      const idv = prendi(r, "id");
      const durata = durataGiorni(prendi(r, "durata"), 8);
      out.push({
        id: idv !== null && /^\s*\d+\s*$/.test(String(idv)) ? Number(idv) : null,
        livello: liv > 0 ? liv : null, rientro, nome: nome.trim(),
        inizio: data(prendi(r, "inizio")), fine: data(prendi(r, "fine")), durata,
        cardine: siNo(prendi(r, "cardine")), riepilogo: siNo(prendi(r, "riepilogo"))
      });
    }
    if (!out.length) return null;
    // livelli dal rientro del nome, se non ci sono colonne di livello o WBS
    if (out.every((x) => x.livello === null)) {
      const larghe = [...new Set(out.map((x) => x.rientro))].sort((a, b) => a - b);
      if (larghe.length > 1) out.forEach((x) => { x.livello = larghe.indexOf(x.rientro) + 1; });
    }
    return { righe: out, data_documento: null, formato };
  }
  function righeExcel(bytes) {
    const wb = XLSX.read(bytes, { type: "array", cellDates: true, dense: false });
    const fogli = [];
    for (const nome of wb.SheetNames) {
      const ws = wb.Sheets[nome];
      const righe = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
      fogli.push({ nome, righe });
    }
    return fogli;
  }
  function righeCsv(testo) {
    const prime = testo.split(/\r?\n/).slice(0, 20).join("\n");
    const conta = (c) => (prime.match(new RegExp(c === "\t" ? "\t" : "\\" + c, "g")) || []).length;
    const sep = [";", "\t", ","].sort((a, b) => conta(b) - conta(a))[0];
    const righe = []; let riga = [], campo = "", virg = false;
    for (let i = 0; i < testo.length; i++) {
      const ch = testo[i];
      if (virg) { if (ch === '"') { if (testo[i + 1] === '"') { campo += '"'; i++; } else virg = false; } else campo += ch; continue; }
      if (ch === '"' && campo === "") { virg = true; continue; }
      if (ch === sep) { riga.push(campo); campo = ""; continue; }
      if (ch === "\n" || ch === "\r") { if (ch === "\r" && testo[i + 1] === "\n") i++; riga.push(campo); righe.push(riga); riga = []; campo = ""; continue; }
      campo += ch;
    }
    if (campo !== "" || riga.length) { riga.push(campo); righe.push(riga); }
    return righe.filter((r) => r.some((c) => String(c).trim() !== ""));
  }
  // testo «a tabella» per l'intelligenza artificiale quando l'intestazione non si riconosce
  function comeTesto(righe, max) {
    return righe.slice(0, max || 600).map((r) => (r || []).map((c) => {
      if (c instanceof Date) return data(c) || "";
      return String(c ?? "").replace(/[\r\n\t]+/g, " ").trim();
    }).join(" | ").replace(/( \| )+$/, "")).filter((l) => l.replace(/[\s|]/g, "") !== "").join("\n");
  }

  // ------------------------------------------------------------------ lettura senza AI
  // Restituisce {righe, data_documento, formato} oppure {perAi: {tipo:'testo', testo, formato}} oppure lancia un Error leggibile.
  function leggiStrutturato(bytes, formato) {
    if (formato === "msproject_xml") return leggiMsProject(testoDa(bytes));
    if (formato === "p6_xml") return leggiP6Xml(testoDa(bytes));
    if (formato === "xer") return leggiXer(testoDa(bytes));
    if (formato === "excel") {
      let fogli;
      try { fogli = righeExcel(bytes); } catch (_e) { throw new Error("il file Excel non si apre (forse è protetto da password o rovinato)"); }
      let migliore = null;
      for (const f of fogli) {
        const r = daTabella(f.righe, "excel");
        if (r && (!migliore || r.righe.length > migliore.righe.length)) migliore = r;
      }
      if (migliore) return migliore;
      const f = fogli.slice().sort((a, b) => b.righe.length - a.righe.length)[0];
      if (!f || !f.righe.length) throw new Error("il file Excel è vuoto");
      return { perAi: { tipo: "testo", testo: comeTesto(f.righe), formato: "excel" } };
    }
    if (formato === "csv") {
      const righe = righeCsv(testoDa(bytes).replace(/^﻿/, ""));
      const r = daTabella(righe, "csv");
      if (r) return r;
      if (!righe.length) throw new Error("il file è vuoto");
      return { perAi: { tipo: "testo", testo: comeTesto(righe), formato: "csv" } };
    }
    throw new Error("formato non previsto: " + formato);
  }

  // ------------------------------------------------------------------ normalizzazione comune
  function maiuscolo(n) { return n === n.toUpperCase() && /[A-Z]/.test(n) ? n.charAt(0) + n.slice(1).toLowerCase() : n; }
  function abbrevia(nome) {
    let s = maiuscolo(String(nome || "").trim()).replace(/\s+/g, " ");
    if (s.length <= 24) return s;
    const via = /^(realizzazione|esecuzione|fornitura e posa( in opera)?|fornitura|posa in opera|opere di|opere|lavori di|intervento di|di|del|della|dello|dei|degli|delle|e|ed|per|in|il|lo|la|le|gli|i|un|una|al|alla|ai|alle|sul|sulla|con|da|tra|fra|a)$/i;
    let parole = s.replace(/\([^)]*\)/g, " ").split(/\s+/).filter(Boolean);
    let tolte = parole.filter((p, i) => !(via.test(p) && (i > 0 || parole.length > 2)));
    if (tolte.length) parole = tolte;
    s = parole.join(" ");
    if (s.length > 24) s = parole.map((p) => (p.length > 8 ? p.slice(0, 6) + "." : p)).join(" ");
    if (s.length > 24) { s = s.slice(0, 24); const k = s.lastIndexOf(" "); if (k > 12) s = s.slice(0, k); }
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function normalizza(grezze, opz) {
    const avvisi = [];
    let righe = (grezze || []).map((r) => Object.assign({}, r, { nome: String(r.nome ?? "").replace(/\s+/g, " ").trim() }))
      .filter((r) => r.nome && !/^(nome attivit[aà]|task name|attivit[aà])$/i.test(r.nome));
    if (!righe.length) throw new Error("nel file non ho trovato le righe del cronoprogramma");
    if (righe.length > 3000) throw new Error("il cronoprogramma ha più di 3.000 righe: dividilo in parti");
    // livelli: dal più esterno = 1, senza salti
    const livs = righe.map((r) => (Number(r.livello) > 0 ? Math.round(Number(r.livello)) : null));
    const minL = Math.min(...livs.filter((x) => x !== null).concat([1]));
    let prec = 0;
    righe.forEach((r, i) => {
      let l = livs[i] === null ? 1 : livs[i] - minL + 1;
      if (l > prec + 1) l = prec + 1;
      r.livello = Math.max(1, l); prec = r.livello;
    });
    // codici: quelli del file se interi, positivi e tutti diversi; altrimenti 1..n
    const ids = righe.map((r) => Number(r.id));
    const idOk = ids.every((x) => Number.isInteger(x) && x > 0) && new Set(ids).size === ids.length;
    if (!idOk && righe.some((r) => r.id !== null && r.id !== undefined)) avvisi.push("numeri di riga ripetuti o mancanti: le righe sono state rinumerate");
    righe.forEach((r, i) => { r.codice = idOk ? ids[i] : i + 1; r.ordine = i + 1; });
    // padri
    const pila = [];
    righe.forEach((r) => { pila.length = r.livello - 1; r.parent_codice = pila.length ? pila[pila.length - 1] : null; pila.push(r.codice); });
    const conFigli = new Set(righe.map((r) => r.parent_codice).filter((x) => x !== null));
    // date fuori scala
    let ignorate = 0;
    for (const r of righe) {
      for (const k of ["inizio", "fine"]) {
        const v = r[k] ? data(r[k]) : null;
        if (r[k] && !v) ignorate++;
        r[k] = v;
      }
    }
    // tipo
    for (const r of righe) {
      if (conFigli.has(r.codice)) r.tipo = "riepilogo";
      else if (r.cardine === true || (r.cardine !== false && r.riepilogo !== true && r.durata === 0 && (!r.inizio || !r.fine || r.inizio === r.fine))) r.tipo = "cardine";
      else r.tipo = "attivita";
    }
    // gruppo di traguardi: una riga di un giorno (inizio = fine) in un gruppo dove tutte le altre sono traguardi è un traguardo
    for (const r of righe) {
      if (r.tipo !== "attivita" || r.cardine === false || !r.inizio || r.inizio !== r.fine) continue;
      const fratelli = righe.filter((x) => x !== r && x.parent_codice === r.parent_codice && x.parent_codice !== null);
      if (fratelli.length >= 2 && fratelli.every((x) => x.tipo === "cardine")) { r.tipo = "cardine"; }
    }
    // date mancanti e durate (righe di lavoro)
    let invertite = 0, senza = 0;
    for (const r of righe) {
      if (r.tipo === "riepilogo") continue;
      if (r.tipo === "cardine") { r.inizio = r.inizio || r.fine; r.fine = r.fine || r.inizio; r.durata = 0; }
      if (r.inizio && !r.fine && r.durata > 0) r.fine = aggiungiLavorativi(r.inizio, r.durata);
      if (!r.inizio && r.fine && r.durata > 0) { const x = new Date(r.fine + "T00:00:00Z"); let k = 1; while (k < r.durata) { x.setUTCDate(x.getUTCDate() - 1); const w = x.getUTCDay(); if (w !== 0 && w !== 6) k++; } r.inizio = x.toISOString().slice(0, 10); }
      if (r.inizio && !r.fine) r.fine = r.inizio;
      if (!r.inizio && r.fine) r.inizio = r.fine;
      if (r.inizio && r.fine && r.fine < r.inizio) { [r.inizio, r.fine] = [r.fine, r.inizio]; invertite++; }
      if (!r.inizio) senza++;
      if (r.durata === null || r.durata === undefined) r.durata = r.tipo === "cardine" ? 0 : giorniLavorativi(r.inizio, r.fine);
    }
    // gruppi: date da quelle che contengono (dal basso verso l'alto)
    for (let i = righe.length - 1; i >= 0; i--) {
      const r = righe[i];
      if (r.tipo !== "riepilogo") continue;
      const figli = righe.filter((x) => x.parent_codice === r.codice);
      const ini = figli.map((x) => x.inizio).filter(Boolean).sort();
      const fin = figli.map((x) => x.fine).filter(Boolean).sort();
      r.inizio = ini.length ? ini[0] : null;
      r.fine = fin.length ? fin[fin.length - 1] : null;
      if (r.durata === null || r.durata === undefined) r.durata = giorniLavorativi(r.inizio, r.fine);
    }
    const lavoro = righe.filter((r) => r.tipo !== "riepilogo").length;
    if (lavoro === 0) throw new Error("nel file ci sono solo titoli di gruppo, nessuna lavorazione");
    if (senza > lavoro / 2) throw new Error("in più della metà delle lavorazioni mancano le date di inizio e fine");
    if (senza) avvisi.push(senza + (senza === 1 ? " lavorazione senza date" : " lavorazioni senza date"));
    if (invertite) avvisi.push(invertite + (invertite === 1 ? " riga con fine prima dell'inizio (date scambiate)" : " righe con fine prima dell'inizio (date scambiate)"));
    if (ignorate) avvisi.push(ignorate + (ignorate === 1 ? " data illeggibile ignorata" : " date illeggibili ignorate"));
    const out = righe.map((r) => ({
      codice: r.codice, parent_codice: r.parent_codice, ordine: r.ordine, livello: r.livello, tipo: r.tipo,
      nome: r.nome.slice(0, 300), nome_breve: r.nome_breve && String(r.nome_breve).length <= 24 ? String(r.nome_breve) : abbrevia(r.nome),
      durata_gg: r.durata === null || r.durata === undefined ? null : Math.max(0, Math.round(r.durata)),
      inizio: r.inizio || null, fine: r.fine || null
    }));
    return { righe: out, avvisi: (opz && opz.avvisi ? opz.avvisi : []).concat(avvisi) };
  }

  return { riconosci, testoDa, leggiStrutturato, normalizza, abbrevia, data, giorniLavorativi, comeTesto };
}
