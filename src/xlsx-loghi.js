// ============================================================================
// EXCEL CON I LOGHI (11/11/2026, chat 02) — regola di Filippo del 10/11: in ogni file il logo dell'impresa in alto
// (o il suo nome) e il logo TIX vero a piè di pagina in basso a destra.
// Trasforma il testo per Excel (CSV) che il database prepara già (Registro delle economie, «Scarica in Excel»)
// in un vero file .xlsx: stessi dati, prima riga in grassetto e bloccata, testata e piè di pagina con i loghi
// (stesso metodo degli Excel del SAL in src/sal.js: immagini del disegno VML della testata, &L&G e &R&G).
// I loghi: quello dell'impresa con preparaLogo di src/sal.js (URL https://), quello TIX dal PNG incorporato qui sotto.
// Qualsiasi problema con un logo: il file esce lo stesso, con il nome dell'impresa in testata.
// ============================================================================
import { preparaLogo } from "./sal.js";
// logo TIX vero (stesso PNG di LOGO_TIX_PNG in src/sal.js, copiato qui per non toccare il file della chat SAL)
const LOGO_TIX_B64 = "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";
let LOGO_TIX_BYTE = null;
function logoTixPng() {
  if (!LOGO_TIX_BYTE) { const s = atob(LOGO_TIX_B64); LOGO_TIX_BYTE = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) LOGO_TIX_BYTE[i] = s.charCodeAt(i); }
  return LOGO_TIX_BYTE;
}

// logo TIX dal PNG incorporato (niente chiamate di rete): larghezza e altezza dall'intestazione IHDR
function logoTix() {
  try {
    const b = logoTixPng();
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20), ext: "png", file: b };
  } catch (e) { return null; }
}

const ENC = new TextEncoder();
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function zipStore(files) {
  const parti = [], centrali = []; let off = 0;
  for (const f of files) {
    const nome = ENC.encode(f.n), d = f.d, crc = crc32(d);
    const l = new Uint8Array(30 + nome.length), lv = new DataView(l.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x5C21, true); lv.setUint32(14, crc, true); lv.setUint32(18, d.length, true);
    lv.setUint32(22, d.length, true); lv.setUint16(26, nome.length, true); lv.setUint16(28, 0, true); l.set(nome, 30);
    const cd = new Uint8Array(46 + nome.length), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x5C21, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true); cv.setUint16(28, nome.length, true);
    cv.setUint32(42, off, true); cd.set(nome, 46);
    parti.push(l, d); centrali.push(cd); off += l.length + d.length;
  }
  let lc = 0; for (const x of centrali) lc += x.length;
  const fine = new Uint8Array(22), fv = new DataView(fine.buffer);
  fv.setUint32(0, 0x06054b50, true); fv.setUint16(8, files.length, true); fv.setUint16(10, files.length, true);
  fv.setUint32(12, lc, true); fv.setUint32(16, off, true);
  const tutto = [...parti, ...centrali, fine];
  let n = 0; for (const x of tutto) n += x.length;
  const out = new Uint8Array(n); let p = 0; for (const x of tutto) { out.set(x, p); p += x.length; }
  return out;
}

function xe(s) {
  return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function colonna(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// CSV del database (separatore «;» o «,», virgolette doppie, a capo dentro le virgolette)
export function leggiCsv(testo) {
  const t = String(testo || "").replace(/^\uFEFF/, "");
  const prima = t.split(/\r?\n/, 1)[0] || "";
  const sep = (prima.match(/;/g) || []).length >= (prima.match(/,/g) || []).length ? ";" : ",";
  const righe = []; let riga = [], campo = "", virg = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (virg) {
      if (ch === '"') { if (t[i + 1] === '"') { campo += '"'; i++; } else virg = false; }
      else campo += ch;
    } else if (ch === '"') virg = true;
    else if (ch === sep) { riga.push(campo); campo = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      riga.push(campo); righe.push(riga); riga = []; campo = "";
    } else campo += ch;
  }
  if (campo !== "" || riga.length) { riga.push(campo); righe.push(riga); }
  return righe.filter((r) => r.length > 1 || (r[0] || "").trim() !== "");
}

// numero all'italiana («8», «8,5», «1.234,56», «-3»); se non è un numero sicuro, resta testo
function numero(s) {
  const v = String(s == null ? "" : s).trim();
  if (!/^-?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/.test(v)) return null;
  if (/^0\d/.test(v.replace(/^-/, ""))) return null;   // codici con lo zero davanti (es. 0123) restano testo
  const n = Number(v.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const STILI = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.##"/></numFmts>' +
  '<fonts count="2"><font><sz val="10"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="10"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F3F2"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FFD3D3D3"/></left><right style="thin"><color rgb="FFD3D3D3"/></right>' +
  '<top style="thin"><color rgb="FFD3D3D3"/></top><bottom style="thin"><color rgb="FFD3D3D3"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function foglioXml(righe, hf) {
  let nc = 0; for (const r of righe) nc = Math.max(nc, r.length);
  const larg = new Array(nc).fill(8);
  let dati = "";
  righe.forEach((r, i) => {
    const n = i + 1; let x = "";
    r.forEach((v, j) => {
      const ref = colonna(j + 1) + n, s = String(v == null ? "" : v);
      larg[j] = Math.min(60, Math.max(larg[j], Math.min(60, s.length + 2)));
      if (i === 0) { x += '<c r="' + ref + '" s="1" t="inlineStr"><is><t xml:space="preserve">' + xe(s) + "</t></is></c>"; return; }
      const num = numero(s);
      if (num !== null) x += '<c r="' + ref + '" s="3"><v>' + num + "</v></c>";
      else if (s !== "") x += '<c r="' + ref + '" s="2" t="inlineStr"><is><t xml:space="preserve">' + xe(s) + "</t></is></c>";
      else x += '<c r="' + ref + '" s="2"/>';
    });
    dati += '<row r="' + n + '">' + x + "</row>";
  });
  const cols = larg.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join("");
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0" tabSelected="1">' +
    (righe.length > 1 ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : "") + "</sheetView></sheetViews>" +
    '<sheetFormatPr defaultRowHeight="14"/>' + (cols ? "<cols>" + cols + "</cols>" : "") + "<sheetData>" + dati + "</sheetData>" +
    '<pageMargins left="0.4" right="0.4" top="1" bottom="0.85" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    "<headerFooter>" + hf + '</headerFooter><legacyDrawingHF r:id="rId1"/></worksheet>';
}

// d: { csv, nomeFoglio, titolo, logoUrl, aziendaNome }  →  Uint8Array del file .xlsx
export async function xlsxDaCsv(d) {
  const righe = leggiCsv(d.csv);
  if (!righe.length) righe.push([""]);
  const li = d.logoUrl ? await preparaLogo(d.logoUrl) : null;
  const lt = logoTix();
  const nomeImp = String(d.aziendaNome || "").trim();
  let liW = 0, liH = 0;
  if (li) { liH = 36; liW = liH * li.w / li.h; if (liW > 180) { liW = 180; liH = liW * li.h / li.w; } }
  const tH = 18, tW = lt ? Math.round(tH * lt.w / lt.h * 100) / 100 : 0;
  const testa = li ? "&L&G" : nomeImp ? "&L&B&12" + nomeImp.replace(/&/g, "&&") : "";
  const piede = "&LPagina &P di &N" + (lt ? "&R&G" : "&RTIX · www.tixcantiere.it");
  const hf = (testa ? "<oddHeader>" + xe(testa) + "</oddHeader>" : "") + "<oddFooter>" + xe(piede) + "</oddFooter>";
  const forma = (id, sp, w, h, rid, tit) => '<v:shape id="' + id + '" o:spid="_x0000_s' + sp + '" type="#_x0000_t75" style="position:absolute;margin-left:0;margin-top:0;width:' +
    (Math.round(w * 100) / 100) + "pt;height:" + (Math.round(h * 100) / 100) + "pt;z-index:" + (id === "LH" ? 1 : 2) + '"><v:imagedata o:relid="' + rid + '" o:title="' + tit + '"/><o:lock v:ext="edit" rotation="t"/></v:shape>';
  const vml = '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
    '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>' +
    '<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f"><v:stroke joinstyle="miter"/><v:formulas>' +
    ["if lineDrawn pixelLineWidth 0", "sum @0 1 0", "sum 0 0 @1", "prod @2 1 2", "prod @3 21600 pixelWidth", "prod @3 21600 pixelHeight", "sum @0 0 1", "prod @6 1 2",
      "prod @7 21600 pixelWidth", "sum @8 21600 0", "prod @7 21600 pixelHeight", "sum @10 21600 0"].map((e) => '<v:f eqn="' + e + '"/>').join("") +
    '</v:formulas><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>' +
    (li ? forma("LH", 1025, liW, liH, "rId1", "Logo dell'impresa") : "") + (lt ? forma("RF", 1026, tW, tH, "rId2", "TIX") : "") + "</xml>";
  const nomeFoglio = String(d.nomeFoglio || "Foglio1").replace(/[\\\/?*\[\]:]/g, " ").slice(0, 31) || "Foglio1";
  const f = [];
  const add = (n, testo) => f.push({ n, d: ENC.encode(testo) });
  add("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>');
  add("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>');
  add("docProps/core.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + xe(d.titolo || nomeFoglio) + "</dc:title><dc:creator>TIX</dc:creator></cp:coreProperties>");
  add("docProps/app.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>TIX</Application></Properties>');
  add("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="' + xe(nomeFoglio) + '" sheetId="1" r:id="rId1"/></sheets></workbook>');
  add("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  add("xl/styles.xml", STILI);
  add("xl/worksheets/sheet1.xml", foglioXml(righe, hf));
  add("xl/worksheets/_rels/sheet1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/></Relationships>');
  add("xl/drawings/vmlDrawing1.vml", vml);
  add("xl/drawings/_rels/vmlDrawing1.vml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    (li ? '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo-impresa.' + li.ext + '"/>' : "") +
    (lt ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo-tix.' + lt.ext + '"/>' : "") + "</Relationships>");
  if (li) f.push({ n: "xl/media/logo-impresa." + li.ext, d: li.file });
  if (lt) f.push({ n: "xl/media/logo-tix." + lt.ext, d: lt.file });
  return zipStore(f);
}

// risposta HTTP con il file .xlsx (nome dal database, .csv → .xlsx)
export function rispostaXlsx(request, dati, nomeCsv) {
  const nome = String(nomeCsv || "TIX.csv").replace(/\.csv$/i, "") + ".xlsx";
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "TIX.xlsx";
  return new Response(request.method === "HEAD" ? null : dati, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
