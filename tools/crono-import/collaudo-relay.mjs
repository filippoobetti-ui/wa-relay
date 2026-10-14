import * as M from "../../src/crono-import.js";
let ok = 0, ko = 0; const v = (c, t) => { if (c) ok++; else { ko++; console.log("✗", t); } };
// 1) riconoscimento dei messaggi
const doc = (filename, caption) => ({ type: "document", from: "393313898967", id: "wamid.X", document: { filename, caption, mime_type: "application/pdf", id: "m1" } });
v(M.cronoImportCandidato(doc("Cronoprogramma_definitivo__AQua_Vera.pdf", "")), "nome file crono");
v(M.cronoImportCandidato(doc("x.pdf", "Ecco il cronoprogramma aggiornato")), "didascalia");
v(M.cronoImportCandidato(doc("progetto.xer", "")), "xer");
v(M.cronoImportCandidato(doc("AQua.mpp", "")), "mpp");
v(M.cronoImportCandidato(doc("Gantt lavori.xlsx", "")), "gantt");
v(!M.cronoImportCandidato(doc("DDT 123.pdf", "consegna calcestruzzo")), "DDT non è crono");
v(!M.cronoImportCandidato(doc("fattura.xml", "")), "fattura xml non è crono");
v(M.cronoImportCandidato({ type: "image", image: { caption: "programma lavori aggiornato" } }), "foto con didascalia");
v(!M.cronoImportCandidato({ type: "image", image: { caption: "getto solaio" } }), "foto normale");
v(!M.cronoImportCandidato({ type: "text", text: { body: "cronoprogramma?" } }), "testo non è file");
v(M.cronoImportIdPulsante({ type: "interactive", interactive: { button_reply: { id: "CRONO_IMP_12_OK" } } }) === "CRONO_IMP_12_OK", "pulsante OK");
v(M.cronoImportIdPulsante({ type: "interactive", interactive: { button_reply: { id: "CRONO_12_F" } } }) === "", "pulsante del venerdì non è mio");
v(!/^CRONO_[0-9]+_[FCSIN]$/.test("CRONO_IMP_12_OK"), "il venerdì non prende CRONO_IMP_");
// 2) gestione WhatsApp con aiuti finti
const inviati = [], registro = [], chiamate = [];
const h = {
  rpc: async (env, nome, corpo) => { chiamate.push([nome, corpo]);
    if (nome === "crono_import_da_whatsapp") return { esito: "ok", id: 7, cantiere: "Acqua Vera", testo: "📅 Ricevuto…" };
    if (nome === "crono_import_risposta") return { esito: "ok", testo: "✅ Cronoprogramma caricato" };
    if (nome === "crono_import_payload") return { telefono: "393313898967", payload: { recipient_type: "individual", type: "interactive", interactive: { type: "button", body: { text: "x" }, action: { buttons: [] } } } };
    if (nome === "crono_import_segna") return null;
    if (nome === "crono_import_contesto") return { esito: "ok", chiuso: false, attivo: true, cantiere: { nome: "Acqua Vera", ubicazione: "Rorai" }, azienda_nome: "Brenta Lavori", logo_impresa: "https://x/logo.png", logo_html: "<img class=logo>", programma: { versione: 1, tipo: "contrattuale", righe: 115, inizio: "2026-10-05", fine: "2027-10-19", file_nome: "AQua.pdf" }, importazioni: [{ id: 7, stato: "pronto", nome_file: "AQua.pdf", canale: "whatsapp", autore: "Filippo Obetti", creato_il: "2026-10-14T15:00:00Z" }] };
    if (nome === "crono_import_da_portale") return { esito: "ok", id: 8 };
    return null; },
  config: async () => ({ phone_number_id: "123" }),
  invia: async (pid, tok, p) => { inviati.push(p); return { ok: true, status: 200, testo: "{}" }; },
  log: async (e, tel, mid, tipo, d) => { registro.push([tipo, d]); },
  esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  testa: () => "", foglio: (b, t, s, c) => c, risposta: (x, s) => new Response(x, { status: s }), headers: () => ({ "Content-Type": "text/html" })
};
const env = { SUPABASE_SERVICE_KEY: "k", WHATSAPP_TOKEN: "w", SUPABASE_URL: "https://finto.supabase.co" };
const m1 = doc("Cronoprogramma AQua Vera.pdf", "cronoprogramma acqua vera"); m1._media = { storage_path: "document/2026/10/14/m1.pdf", mime: "application/pdf", bytes: 146090 };
v(await M.cronoImportGestisci(m1, { metadata: { phone_number_id: "123" } }, env, h) === true, "presa");
v(chiamate[0][1].p_storage_path === "document/2026/10/14/m1.pdf" && chiamate[0][1].p_didascalia === "cronoprogramma acqua vera" && chiamate[0][1].p_byte === 146090, "argomenti rpc");
v(inviati[0].to === "393313898967" && inviati[0].context.message_id === "wamid.X" && /Ricevuto/.test(inviati[0].text.body), "risposta «sto leggendo»");
v(await M.cronoImportRispostaGestisci({ type: "interactive", from: "393313898967", id: "w2", interactive: { button_reply: { id: "CRONO_IMP_7_OK" } } }, { metadata: { phone_number_id: "123" } }, env, h) === true, "pulsante gestito");
const a = await M.cronoImportAvvisa(env, 7, h);
v(a.inviato && inviati[inviati.length - 1].messaging_product === "whatsapp" && inviati[inviati.length - 1].to === "393313898967", "avviso inviato");
// 3) area riservata: pagina, caricamento, stato
const T = "a".repeat(64), C = "e4dbe85f-a505-4fe5-9b51-4a13143d6699";
const pg = await M.portaleCronoprogramma(new Request("https://www.ilgiornalelavori.it/cronoprogramma?t=" + T + "&c=" + C), env, "", new URL("https://www.ilgiornalelavori.it/cronoprogramma?t=" + T + "&c=" + C), h);
const html = await pg.text();
v(pg.status === 200 && /Carica un cronoprogramma aggiornato/.test(html) && /Versione 1/.test(html) && /logo\.png/.test(html) && /data-id="7"/.test(html), "pagina");
const scr = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
try { new Function(scr); v(true); } catch (e) { v(false, "script della pagina: " + e.message); }
const vero = globalThis.fetch;
let caricato = null;
globalThis.fetch = async (url, init) => { if (String(url).includes("/storage/v1/object/wa-media/crono/")) { caricato = { url: String(url), n: init.body.length, tipo: init.headers["Content-Type"] }; return new Response("{}", { status: 200 }); } return vero(url, init); };
const corpo = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
const rq = new Request("https://www.ilgiornalelavori.it/cronoprogramma/carica?t=" + T + "&c=" + C + "&nome=AQua%20Vera.pdf", { method: "POST", body: corpo, headers: { "Content-Type": "application/pdf" } });
const rc = await M.portaleCronoprogramma(rq, env, "", new URL(rq.url), h);
const jc = await rc.json();
v(jc.esito === "ok" && jc.id === 8 && caricato && /\/crono\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{24}\.pdf$/.test(caricato.url) && caricato.n === 7 && caricato.tipo === "application/pdf", "caricamento " + JSON.stringify([jc, caricato]));
const rq2 = new Request("https://x/cronoprogramma/carica?t=" + T + "&c=" + C + "&nome=AQua.mpp", { method: "POST", body: corpo });
v((await (await M.portaleCronoprogramma(rq2, env, "", new URL(rq2.url), h)).json()).esito === "mpp", "mpp rifiutato con spiegazione");
const rq3 = new Request("https://x/cronoprogramma/carica?t=zz&c=" + C, { method: "POST", body: corpo });
v((await M.portaleCronoprogramma(rq3, env, "", new URL(rq3.url), h)).status === 403, "gettone non valido");
globalThis.fetch = vero;
console.log(ok + " prove superate, " + ko + " fallite");
