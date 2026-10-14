// Collaudo offline dei lettori: da Acqua Vera v1 (115 righe) si generano i file nei formati di Project, Primavera,
// Excel e CSV come li esporterebbe un'impresa, poi si rileggono con leggi.js e si confrontano con v1.
import fs from "node:fs";
import { XMLParser } from "fast-xml-parser";
import * as XLSX from "xlsx";
import { creaLettore } from "./leggi.js";

const L = creaLettore({ XMLParser, XLSX });
const v1 = JSON.parse(fs.readFileSync(new URL("./v1.json", import.meta.url))).map(([codice, parent, livello, t, nome, durata, inizio, fine]) =>
  ({ codice, parent, livello, tipo: { r: "riepilogo", a: "attivita", c: "cardine" }[t], nome, durata, inizio, fine }));
const GG = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
const it = (d) => { if (!d) return ""; const x = new Date(d + "T00:00:00Z"); return GG[x.getUTCDay()] + " " + d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(2, 4); };
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wbsNum = (() => { const m = new Map(); const cont = new Map(); for (const r of v1) { const p = r.parent ?? 0; const n = (cont.get(p) || 0) + 1; cont.set(p, n); m.set(r.codice, (r.parent ? m.get(r.parent) + "." : "") + n); } return m; })();

// 1) XML di MS Project con righe vuote (ID mancanti) e riga di progetto
function msXml() {
  let t = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Project xmlns="http://schemas.microsoft.com/project">\n<Name>AQua Vera_2026-09-28.xml</Name><LastSaved>2026-09-28T18:40:00</LastSaved><MinutesPerDay>480</MinutesPerDay>\n<Tasks>\n';
  t += "<Task><UID>0</UID><ID>0</ID><Name>AQua Vera</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>\n";
  const per = new Map(v1.map((r) => [r.codice, r]));
  for (let id = 1; id <= 130; id++) {
    const r = per.get(id);
    if (!r) { t += `<Task><UID>${id}</UID><ID>${id}</ID><IsNull>1</IsNull></Task>\n`; continue; }
    const ini = r.inizio || "2022-05-01", fin = r.fine || "2022-05-01";
    t += `<Task><UID>${id}</UID><ID>${id}</ID><Name>${xmlEsc(r.nome)}</Name><OutlineNumber>${wbsNum.get(id)}</OutlineNumber><OutlineLevel>${r.livello}</OutlineLevel>` +
      `<Start>${ini}T08:00:00</Start><Finish>${fin}T17:00:00</Finish><Duration>PT${r.durata * 8}H0M0S</Duration>` +
      `<Milestone>${r.tipo === "cardine" ? 1 : 0}</Milestone><Summary>${r.tipo === "riepilogo" ? 1 : 0}</Summary><Active>1</Active></Task>\n`;
  }
  return Buffer.from(t + "</Tasks>\n</Project>\n", "utf8");
}
// 2) Excel come «Esporta in Excel» di Project in italiano (date testo, durate «40 g», livello struttura)
function excelProject() {
  const righe = [["Elenco attività — AQua Vera"], [], ["Id", "Modalità attività", "Nome attività", "Durata", "Inizio", "Fine", "Livello struttura", "Predecessori"]];
  for (const r of v1) righe.push([r.codice, "Pianificata automaticamente", r.nome, r.durata + " g", it(r.inizio || "2022-05-01"), it(r.fine || "2022-05-01"), r.livello, ""]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(righe), "Tabella_Attività");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
// 3) Excel «fatto a mano»: WBS 1.2.3, date vere, durata in numero, nessun ID, foglio di copertina prima
function excelMano() {
  const righe = [["WBS", "Descrizione lavorazione", "Data inizio", "Data fine", "Giorni"]];
  for (const r of v1) righe.push([wbsNum.get(r.codice), r.nome, r.inizio ? new Date(r.inizio + "T00:00:00") : null, r.fine ? new Date(r.fine + "T00:00:00") : null, r.durata]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Impresa Brenta Lavori"], ["Cronoprogramma lavori"]]), "Copertina");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(righe, { cellDates: true }), "Crono");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true });
}
// 4) CSV con punto e virgola, BOM e rientro con spazi nel nome (nessuna colonna livello)
function csvRientro() {
  let t = "﻿Nome attività;Durata;Inizio;Fine\n";
  for (const r of v1) t += '"' + "   ".repeat(r.livello - 1) + r.nome.replace(/"/g, '""') + '";' + r.durata + " g;" + (r.inizio ? r.inizio.split("-").reverse().join("/") : "") + ";" + (r.fine ? r.fine.split("-").reverse().join("/") : "") + "\n";
  return Buffer.from(t, "utf8");
}
// 5) XER e 6) XML di Primavera: gruppi = WBS, lavorazioni = TASK
function xer() {
  const out = ["ERMHDR\t19.12\t2026-09-28\tProject\tadmin\tAdmin\tdbxDatabaseNoName\tProject Management\tEUR"];
  out.push("%T\tPROJECT", "%F\tproj_id\tproj_short_name\tlast_recalc_date", "%R\t100\tAQUAVERA\t2026-09-28 18:00");
  out.push("%T\tPROJWBS", "%F\twbs_id\tproj_id\tproj_node_flag\tseq_num\twbs_short_name\twbs_name\tparent_wbs_id", "%R\t1\t100\tY\t0\tAQV\tAQua Vera\t");
  let seq = 0;
  for (const r of v1) if (r.tipo === "riepilogo") out.push(["%R", 1000 + r.codice, 100, "N", ++seq, "W" + r.codice, r.nome, r.parent ? 1000 + r.parent : 1].join("\t"));
  out.push("%T\tTASK", "%F\ttask_id\tproj_id\twbs_id\ttask_code\ttask_type\ttask_name\ttarget_drtn_hr_cnt\ttarget_start_date\ttarget_end_date");
  for (const r of v1) if (r.tipo !== "riepilogo") out.push(["%R", 5000 + r.codice, 100, r.parent ? 1000 + r.parent : 1, "A" + r.codice * 10, r.tipo === "cardine" ? "TT_FinMile" : "TT_Task", r.nome, r.durata * 8, r.inizio + " 08:00", r.fine + " 17:00"].join("\t"));
  out.push("%E");
  return Buffer.from(out.join("\r\n"), "latin1");
}
function p6xml() {
  let t = '<?xml version="1.0" encoding="UTF-8"?>\n<APIBusinessObjects xmlns="http://xmlns.oracle.com/Primavera/P6/V19.12/API/BusinessObjects"><Project><ObjectId>100</ObjectId><Name>AQua Vera</Name><DataDate>2026-09-28T08:00:00</DataDate>\n';
  let seq = 0;
  for (const r of v1) if (r.tipo === "riepilogo") t += `<WBS><ObjectId>${1000 + r.codice}</ObjectId><ParentObjectId>${r.parent ? 1000 + r.parent : 100}</ParentObjectId><Name>${xmlEsc(r.nome)}</Name><SequenceNumber>${++seq}</SequenceNumber></WBS>\n`;
  for (const r of v1) if (r.tipo !== "riepilogo") t += `<Activity><ObjectId>${5000 + r.codice}</ObjectId><Id>A${r.codice * 10}</Id><Name>${xmlEsc(r.nome)}</Name><WBSObjectId>${1000 + r.parent}</WBSObjectId><Type>${r.tipo === "cardine" ? "Finish Milestone" : "Task Dependent"}</Type><PlannedDuration>${r.durata * 8}</PlannedDuration><PlannedStartDate>${r.inizio}T08:00:00</PlannedStartDate><PlannedFinishDate>${r.fine}T17:00:00</PlannedFinishDate></Activity>\n`;
  return Buffer.from(t + "</Project></APIBusinessObjects>", "utf8");
}

// confronto: per percorso (gruppo/nome) — vale anche quando l'ordine o i codici cambiano (Primavera)
function confronta(nomeProva, ris, stessiCodici) {
  const chiave = (righe, r, perCod) => { const g = r.parent_codice != null ? perCod.get(r.parent_codice) : null; return (g ? g.nome : "") + " / " + r.nome; };
  const perCod = new Map(ris.righe.map((r) => [r.codice, r]));
  const atteso = new Map(); const perCodV = new Map(v1.map((r) => [r.codice, r]));
  for (const r of v1) atteso.set((r.parent ? perCodV.get(r.parent).nome : "") + " / " + r.nome, r);
  const errori = []; let ok = 0;
  for (const r of ris.righe) {
    const k = chiave(ris.righe, r, perCod); const a = atteso.get(k);
    if (!a) { errori.push("in più: " + k); continue; }
    const diff = [];
    if (a.tipo !== r.tipo) diff.push(`tipo ${r.tipo}≠${a.tipo}`);
    if (a.livello !== r.livello) diff.push(`livello ${r.livello}≠${a.livello}`);
    if (stessiCodici && a.codice !== r.codice) diff.push(`codice ${r.codice}≠${a.codice}`);
    if (a.tipo !== "riepilogo" && (a.inizio !== r.inizio || a.fine !== r.fine)) diff.push(`date ${r.inizio}→${r.fine} ≠ ${a.inizio}→${a.fine}`);
    if (a.tipo === "attivita" && a.durata !== r.durata_gg) diff.push(`durata ${r.durata_gg}≠${a.durata}`);
    if (!r.nome_breve || r.nome_breve.length > 24) diff.push("nome breve " + r.nome_breve);
    if (diff.length) errori.push(k + ": " + diff.join(", ")); else ok++;
  }
  const mancano = v1.length - ris.righe.length;
  console.log(`${nomeProva.padEnd(22)} righe ${ris.righe.length}/${v1.length}  giuste ${ok}  avvisi ${JSON.stringify(ris.avvisi)}`);
  for (const e of errori.slice(0, 6)) console.log("   ✗ " + e);
  if (errori.length > 6) console.log("   … altri " + (errori.length - 6));
  return errori.length === 0 && mancano === 0;
}

const prove = [
  ["MS Project XML", msXml(), "AQua Vera.xml", "application/xml", true],
  ["Excel da Project", excelProject(), "AQua Vera.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", true],
  ["Excel fatto a mano", excelMano(), "crono.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false],
  ["CSV con rientri", csvRientro(), "crono.csv", "text/csv", false],
  ["Primavera XER", xer(), "aquavera.xer", "application/octet-stream", false],
  ["Primavera XML", p6xml(), "aquavera_p6.xml", "text/xml", false]
];
let tutti = true;
for (const [nome, buf, file, mime, stessi] of prove) {
  const bytes = new Uint8Array(buf);
  const formato = L.riconosci(bytes, file, mime);
  try {
    const s = L.leggiStrutturato(bytes, formato);
    if (s.perAi) { console.log(nome, "→ AI", formato); tutti = false; continue; }
    const n = L.normalizza(s.righe);
    const ok = confronta(nome + " [" + formato + "]", n, stessi);
    tutti = tutti && ok;
  } catch (e) { console.log(nome, "ERRORE", e.message); tutti = false; }
}
// riconoscimento dei formati che non si leggono qui
console.log("pdf →", L.riconosci(new Uint8Array(fs.readFileSync(process.argv[2] || "/dev/null")), "x.pdf", "application/pdf"));
console.log("mpp →", L.riconosci(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), "AQua.mpp", "application/octet-stream"));
console.log("jpg →", L.riconosci(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "foto.jpg", "image/jpeg"));
console.log("abbreviati:", ["Realizzazione apparato fondale in cemento armato per prefabbricato (plinti di fondazione)", "ESECUZIONE DEI LAVORI", "Installazione vano pompe e tubazioni di alimentazione stabilimento"].map(L.abbrevia));
console.log(tutti ? "\nTUTTE LE PROVE SUPERATE" : "\nCI SONO DIFFERENZE");
