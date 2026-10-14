import { getDocumentProxy } from "npm:unpdf@0.12.1";
import { XMLParser } from "npm:fast-xml-parser@4.5.0";
import * as XLSX from "npm:xlsx@0.18.5";
import { creaLettore } from "./leggi.js";
const L = creaLettore({ XMLParser, XLSX });
const pdf = await getDocumentProxy(new Uint8Array(await Deno.readFile(Deno.args[0])));
const pagine = [];
for (let n = 1; n <= pdf.numPages; n++) {
  const tc = await (await pdf.getPage(n)).getTextContent();
  pagine.push(tc.items.map((i: any) => ({ s: i.str, a: i.transform[4], b: i.transform[5], f: i.fontName })));
}
const t = L.leggiPdfTesto(pagine); console.log(JSON.stringify(t.righe.filter((r:any)=>r.id>=110).map((r:any)=>[r.id,r.livello,r.nome.slice(0,25),r.carattere])));
console.log("righe", t?.righe.length, "copertura", t?.copertura);
const n = L.normalizza(t.righe);
const v1 = JSON.parse(await Deno.readTextFile(new URL("./v1.json", import.meta.url)));
const per = new Map(n.righe.map((r: any) => [r.codice, r]));
let ok = 0; const diff: string[] = [];
const T = { r: "riepilogo", a: "attivita", c: "cardine" } as any;
for (const [c, p, l, t1, nome, d, i, f] of v1) {
  const r: any = per.get(c); if (!r) { diff.push(c + " manca " + nome); continue; }
  const e = [];
  if (r.livello !== l) e.push("liv " + l + "→" + r.livello);
  if (r.parent_codice !== p) e.push("padre " + p + "→" + r.parent_codice);
  if (r.tipo !== T[t1]) e.push("tipo " + T[t1] + "→" + r.tipo);
  if (T[t1] !== "riepilogo" && (r.inizio !== i || r.fine !== f)) e.push("date");
  if (T[t1] === "attivita" && r.durata_gg !== d) e.push("durata " + d + "→" + r.durata_gg);
  if (e.length) diff.push(c + " " + nome.slice(0, 30) + ": " + e.join(", ")); else ok++;
  per.delete(c);
}
for (const [c, r] of per) diff.push(c + " in più: " + (r as any).nome);
console.log("giuste", ok, "/", v1.length); console.log(diff.join("\n"));
