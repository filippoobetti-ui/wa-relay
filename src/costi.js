// ============================================================================
// COSTI E MARGINE DEL CANTIERE — area riservata (10/11/2026, costi-1, fase MG1). Scelte di Filippo del 10/11/2026 (piano
// Strumenti/restyling-tix/costi-margine/01-piano.md): quanto ha speso il cantiere, quanto ha maturato con l'ultimo SAL e quanto
// resta (margine «al SAL»), con i costi dopo il SAL a parte, il previsto a fine lavori, le spese generali in una riga a parte e la
// soglia del margine. Costi: manodopera (ore ENTRO/ESCO × costo orario per qualifica), mezzi propri (uso × costo interno),
// subappalti (contabilità dei sub della chat SAL) e costi scritti a mano. Tutti i conti li fa il database (costi_contesto).
// La vedono SOLO le persone dell'impresa con l'accesso all'app (gettoni di dashboard_accessi, mai l'Area professionisti, mai i
// link dei subappaltatori, mai WhatsApp), come le Offerte.
//   GET  /costi?t=<gettone>&c=<cantiere>   → pagina del cantiere (database: costi_contesto)
//   GET  /costi?t=<gettone>                → riepilogo di tutti i cantieri dell'impresa (database: costi_riepilogo)
//   POST /costi/azione   {t, c, azione: "costo_impresa" | "costo_mezzo" | "manuale_salva" | "manuale_togli"
//                        | "bolla_stima" | "bolla_togli" | "fattura_modifica" | "fattura_togli", dati}
// costi-2 (10/11/2026, fase MG2 — materiali da bolle e fatture):
//   POST /costi/carica-fattura  corpo = 8 cifre con la lunghezza del JSON + JSON {t, c, nome, byte, sha256, fornitore, partita_iva, numero,
//                        data, tipo, categoria, imponibile, iva, totale, importo_cantiere, competenza, note, autore, righe, ddt} + il file
//                        (XML della fattura elettronica, .xml.p7m oppure PDF). L'XML lo legge la pagina (gratis); qui si archivia.
//   POST /costi/leggi-fattura   stesso corpo con {t, c, nome, byte, sha256} + il PDF (o la foto): lettura con Claude (lettore comune
//                        src/lettore-offerte.js, leggiFatturaFornitore), con tetto e registro nel database (costi_lettura_*).
//   GET  /costi/file?t=…&c=…&id=…   → il file della fattura.
// Interruttori: impostazioni.costi_margine_attiva (no / prova = solo l'accesso «Tutte le aziende» / si) e COSTI = "off";
// lettura delle fatture PDF: impostazioni.costi_fatture_ia_attiva e COSTI_IA = "off".
// ============================================================================

import { leggiFatturaFornitore } from "./lettore-offerte.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AZIONI = ["costo_impresa", "costo_mezzo", "manuale_salva", "manuale_togli", "bolla_stima", "bolla_togli", "fattura_modifica", "fattura_togli"];
const VERIFICA_MAX = 5 * 1048576;   // il Worker ricalcola l'impronta solo fino a 5 MB
const JSON_MAX = 400000;            // dati della fattura nel corpo del caricamento (le righe possono essere tante)
const MIME_F = { xml: "application/xml", p7m: "application/pkcs7-mime", pdf: "application/pdf" };
const VOCI = [
  ["manodopera_operaio_comune", "Operaio comune", "€/ora"],
  ["manodopera_operaio_qualificato", "Operaio qualificato", "€/ora"],
  ["manodopera_operaio_specializzato", "Operaio specializzato", "€/ora"],
  ["manodopera_quarto_livello", "4° livello (capo squadra)", "€/ora"],
  ["spese_generali_pct", "Spese generali", "% dei costi"],
  ["soglia_margine_pct", "Soglia di avviso del margine", "%"]
];
const CATEGORIE = [
  ["materiali", "Materiali"], ["noli", "Noli e mezzi a noleggio"], ["manodopera_esterna", "Manodopera esterna (autonomi, agenzia)"],
  ["subappalti", "Subappalti fuori da TIX"], ["trasporti", "Trasporti"], ["smaltimenti", "Smaltimenti"], ["altro", "Altro"]
];
const UNITA = { ora: "ora", giorno: "giorno", mezza_giornata: "mezza giornata" };

function supabaseUrl(env) { return env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co"; }
function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: {
    "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
function lista(a) { return Array.isArray(a) ? a : []; }
function ogg(o) { return o && typeof o === "object" && !Array.isArray(o) ? o : {}; }
function testo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function parametri(inUrl) {
  const s = inUrl.searchParams;
  const m = String(s.get("t") || "").match(/[0-9a-fA-F]{64}/);
  const c = String(s.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  return { tok: m ? m[0].toLowerCase() : "", c };
}
function dataIso(x) { const s = String(x || "").trim(); return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) ? s : ""; }
function dataIt(iso) { return /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(String(iso || "")) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : ""; }
function n(x) { if (x === null || x === undefined || x === "") return null; const v = Number(x); return Number.isFinite(v) ? v : null; }
function cifre(v, dec) {
  const s = Math.abs(v).toFixed(dec);
  const [i, d] = s.split(".");
  return (v < 0 ? "−" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (d ? "," + d : "");
}
function euro(x) { const v = n(x); return v === null ? "—" : cifre(v, 2) + " €"; }
function euroTondo(x) { const v = n(x); return v === null ? "—" : cifre(Math.round(v), 0) + " €"; }
function pct(x) { const v = n(x); return v === null ? "—" : cifre(v, 1) + "%"; }
function ore(x) { const v = n(x); if (v === null) return "—"; return (Number.isInteger(v) ? cifre(v, 0) : cifre(v, 1)) + (v === 1 ? " ora" : " ore"); }
function valoreIt(x) { const v = n(x); if (v === null) return ""; return String(Math.round(v * 100) / 100).replace(".", ","); }
function puliscoDati(a, x) {
  const t = (k, m) => testo(x[k], m);
  if (a === "costo_impresa") return { voce: t("voce", 60), valore: t("valore", 20), valido_dal: dataIso(x.valido_dal), autore: t("autore", 120) };
  if (a === "costo_mezzo") return { mezzo_id: UUID.test(String(x.mezzo_id || "")) ? String(x.mezzo_id) : "", costo: t("costo", 20), valido_dal: dataIso(x.valido_dal), autore: t("autore", 120) };
  if (a === "manuale_salva") return { id: UUID.test(String(x.id || "")) ? String(x.id) : "", data: dataIso(x.data), categoria: t("categoria", 30),
    fornitore: t("fornitore", 120), descrizione: t("descrizione", 300), numero: t("numero", 60), importo: t("importo", 20), autore: t("autore", 120) };
  // costi-2: stima di una bolla (il prezzo NON si manda: lo prende il database dalla riga dell'offerta)
  if (a === "bolla_stima") return { ddt_id: /^[0-9]{1,12}$/.test(String(x.ddt_id || "")) ? String(x.ddt_id) : "",
    offerta_id: UUID.test(String(x.offerta_id || "")) ? String(x.offerta_id) : "", autore: t("autore", 120),
    righe: lista(x.righe).slice(0, 40).map((r) => ({ descrizione_ddt: testo(r && r.descrizione_ddt, 200), quantita: testo(r && r.quantita, 20),
      unita: testo(r && r.unita, 20), offerta_riga_id: /^[0-9]{1,12}$/.test(String(r && r.offerta_riga_id || "")) ? String(r.offerta_riga_id) : "" })) };
  if (a === "fattura_modifica") return { id: UUID.test(String(x.id || "")) ? String(x.id) : "", categoria: t("categoria", 30),
    importo_cantiere: t("importo_cantiere", 20), competenza: dataIso(x.competenza), note: t("note", 500), autore: t("autore", 120) };
  return { id: UUID.test(String(x.id || "")) ? String(x.id) : "", motivo: t("motivo", 300), autore: t("autore", 120) };
}
// costi-2: aiuti per file, unità e nomi delle ditte (gli stessi della pagina)
function casuale(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); }
function esadecimale(buf) { return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join(""); }
function percorsoStorage(p) { return String(p).split("/").map(encodeURIComponent).join("/"); }
function supabaseFile(env, percorso, init) {
  return fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(percorso),
    Object.assign({ headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }, init || {}));
}
// tipo dai byte: PDF, foto, XML (anche con BOM o spazi davanti), p7m binario (0x30) o in base64 («MI…»)
export function tipoFattura(b) {
  if (!b || b.length < 8) return "";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x30) return "p7m";
  const testa = String.fromCharCode.apply(null, Array.from(b.subarray(0, 1024)));
  if (testa.indexOf("%PDF-") !== -1) return "pdf";
  if (/^(﻿|ï»¿)?\s*</.test(testa)) return "xml";
  if (/^\s*(-----BEGIN[^\n]*\n)?\s*MI[A-Za-z0-9+/]/.test(testa)) return "p7m";
  return "";
}
export function nomeDitta(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\./g, "")
    .replace(/\b(srls?|spa|snc|sas|soc|societa|coop|cooperativa|unipersonale)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}
export function stessaDitta(a, b) {
  const x = nomeDitta(a), y = nomeDitta(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 5 && y.length >= 5 && (x.indexOf(y) !== -1 || y.indexOf(x) !== -1));
}
export function numeroBolla(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+/, ""); }
export function unitaNorm(u) {
  const s = String(u || "").toLowerCase().replace(/[\s.]/g, "");
  if (/^(m3|mc|m³|metricubi|metrocubo)$/.test(s)) return "m3";
  if (/^(m2|mq|m²|metriquadri|metroquadro)$/.test(s)) return "m2";
  if (/^(m|ml|metri|metro|mt)$/.test(s)) return "m";
  if (/^(kg|chili|kilogrammi)$/.test(s)) return "kg";
  if (/^(t|ton|tonnellate|tonnellata|q?t)$/.test(s)) return "t";
  if (/^(h|ora|ore|hh)$/.test(s)) return "ora";
  if (/^(n|nr|num|pz|pezzi|cad|cadauno|un|unita)$/.test(s)) return "cad";
  if (/^(viaggio|viaggi|vg)$/.test(s)) return "viaggio";
  return s;
}
function parole(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9/]+/).filter((w) => w.length >= 2);
}
// la riga dell'offerta più simile a una descrizione (parole in comune, almeno metà di quelle della riga dell'offerta)
export function rigaSimile(descr, righe) {
  const a = new Set(parole(descr));
  let meglio = null, punti = 0;
  lista(righe).forEach((r) => {
    const b = parole(r.descrizione);
    if (!b.length) return;
    const comuni = b.filter((w) => a.has(w)).length;
    const p = comuni / b.length;
    if (comuni && p > punti) { punti = p; meglio = r; }
  });
  return punti >= 0.5 ? meglio : null;
}
// il confronto di una fattura con le bolle del cantiere e con le offerte accettate dello stesso fornitore
export function confrontoFattura(f, bolle, offerte) {
  const out = [];
  const nostre = lista(bolle).filter((b) => stessaDitta(b.fornitore, f.fornitore));
  const citate = lista(f.ddt).map((d) => ({ numero: String(d.numero || ""), data: String(d.data || ""), n: numeroBolla(d.numero) })).filter((d) => d.n);
  if (!citate.length) out.push({ cls: "gi", t: "La fattura non cita bolle: non si può confrontare con le consegne del Diario." });
  citate.forEach((d) => {
    const b = nostre.find((x) => numeroBolla(x.numero) === d.n) || lista(bolle).find((x) => numeroBolla(x.numero) === d.n && !String(x.fornitore || "").trim());
    if (!b) { out.push({ cls: "gi", t: "La bolla n. " + d.numero + (d.data ? " del " + dataIt(d.data) : "") + " è in fattura ma non nel Diario del cantiere." }); return; }
    const altre = lista(b.fatture).filter((x) => x.id !== f.id);
    if (altre.length) out.push({ cls: "gi", t: "La bolla n. " + d.numero + " è citata anche dalla fattura n. " + altre.map((x) => x.numero).join(", ") + ": fatturata due volte?" });
    else out.push({ cls: "ok", t: "Bolla n. " + d.numero + (b.data ? " del " + dataIt(b.data) : "") + " trovata nel Diario" + (b.stima ? ": la stima di " + euro(b.stima.importo) + " lascia il posto alla fattura" : "") + "." });
    // quantità: se la bolla era stata stimata, si confrontano le quantità per unità di misura
    if (b.stima && citate.length === 1) {
      const qf = {}, qs = {};
      lista(f.righe).forEach((r) => { const u = unitaNorm(r.unita), q = n(r.quantita); if (u && q) qf[u] = (qf[u] || 0) + q; });
      lista(b.stima.righe).forEach((r) => { const u = unitaNorm(r.unita_offerta || r.unita), q = n(r.quantita); if (u && q) qs[u] = (qs[u] || 0) + q; });
      Object.keys(qs).forEach((u) => {
        if (qf[u] !== undefined && Math.abs(qf[u] - qs[u]) > Math.max(0.01, qs[u] * 0.01)) {
          out.push({ cls: "gi", t: "Quantità diversa: in fattura " + valoreIt(qf[u]) + " " + u + ", sulla bolla n. " + d.numero + " " + valoreIt(qs[u]) + " " + u + "." });
        }
      });
    }
  });
  // prezzi: righe della fattura contro le righe dell'offerta accettata dello stesso fornitore
  const off = lista(offerte).filter((o) => stessaDitta(o.fornitore, f.fornitore));
  if (off.length) {
    const righeOff = [].concat.apply([], off.map((o) => lista(o.righe)));
    let uguali = 0;
    lista(f.righe).forEach((r) => {
      const p = n(r.prezzo);
      if (p === null) return;
      const o = rigaSimile(r.descrizione, righeOff);
      if (!o || n(o.prezzo) === null) return;
      if (unitaNorm(r.unita) && unitaNorm(o.unita) && unitaNorm(r.unita) !== unitaNorm(o.unita)) return;
      if (p > n(o.prezzo) * 1.005 + 0.001) out.push({ cls: "gi", t: "Prezzo più alto dell'offerta: «" + testo(r.descrizione, 60) + "» " + euro(p) + " in fattura, " + euro(o.prezzo) + " nell'offerta." });
      else uguali++;
    });
    if (uguali) out.push({ cls: "ok", t: (uguali === 1 ? "Una riga ha" : uguali + " righe hanno") + " il prezzo dell'offerta accettata (o più basso)." });
  } else {
    out.push({ cls: "bl", t: "Nessuna offerta accettata di questo fornitore nel cantiere: i prezzi non si possono confrontare." });
  }
  // bolle dello stesso fornitore arrivate prima della fattura e non ancora fatturate
  const fd = String(f.data || "");
  const nonFatt = nostre.filter((b) => !lista(b.fatture).length && b.data && fd && b.data <= fd);
  if (nonFatt.length) out.push({ cls: "gi", t: "Bolle di questo fornitore arrivate prima della fattura e non ancora fatturate: " + nonFatt.slice(0, 8).map((b) => "n. " + b.numero + (b.data ? " del " + dataIt(b.data) : "")).join(", ") + (nonFatt.length > 8 ? "…" : "") + "." });
  return out;
}

// ---------------------------------------------------------------------------- pulsanti
async function chiama(env, nome, corpo) {
  if (!env || !env.SUPABASE_SERVICE_KEY || env.COSTI === "off") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(supabaseUrl(env) + "/rest/v1/rpc/" + nome, {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpo), signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === "object" && j.esito === "ok" && j.attiva === true ? { attiva: true, modo: String(j.modo || "") } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
// Chiamate fatte da index.js insieme a dashboard_html: qualsiasi errore o attesa oltre 8 secondi = nessun pulsante.
export function costiPulsante(env, token, commessa) { return chiama(env, "costi_pulsante", { p_token: token, p_commessa: commessa }); }
export function costiImpresaPulsante(env, token) { return chiama(env, "costi_impresa_pulsante", { p_token: token }); }

const ICONA = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/></svg>';

// Ultimo pulsante della riga del cantiere: subito dopo «Subappaltatori» (chat SAL), altrimenti dopo «Offerte» (o Costruttivi /
// Progetti). index.js mette questo script DOPO quelli di Subappaltatori e Offerte nella catena: a ogni giro si rimette dopo di loro.
// Da solo, se la riga non c'è, va in una barra sotto le schede. Con dieci pulsanti: classe gl-az10 (accordo con la chat SAL).
export function costiIniezione(base, token, commessa) {
  const u = base + "/costi?t=" + token + "&c=" + encodeURIComponent(commessa);
  const etichetta = ICONA + " Costi e margine";
  return "<style>.gl-cm-barra{max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right}" +
    ".gl-cm-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 16px;border:1.5px solid #0F766E;border-radius:10px;background:#E6F4F2;color:#0B4F4A;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none;box-shadow:0 0 0 3px rgba(15,118,110,.14)}" +
    ".gl-cm-b:hover,.gl-cm-b:focus-visible{background:#0F766E;color:#fff;outline:none}" +
    ".gl-sb-barra .gl-cm-b,.gl-of-barra .gl-cm-b,.gl-cs-barra .gl-cm-b,.gl-pg-barra .gl-cm-b,.gl-cm-barra .gl-of-b{margin-left:8px}" +
    // con nove pulsanti: 3 colonne sul computer (tre righe); con dieci: 5 colonne (due righe); 2 fino a 900 px, 1 sul telefono
    ".gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9{grid-template-columns:repeat(3,minmax(0,1fr))}" +
    ".gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9.gl-az10{grid-template-columns:repeat(5,minmax(0,1fr))}" +
    "@media (max-width:900px){.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9,.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9.gl-az10{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
    "@media (max-width:640px){.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9,.gl-azioni.gl-az5.gl-az6.gl-az7.gl-az8.gl-az9.gl-az10{grid-template-columns:minmax(0,1fr)}}" +
    "@media (prefers-color-scheme:dark){.gl-cm-b{background:#12302d;color:#cdeee9;border-color:#3FB3A6}}</style>" +
    "<script>(function(){try{var a=document.createElement('a');a.className='gl-cm-b';a.href=" + JSON.stringify(u) + ";a.innerHTML=" + JSON.stringify(etichetta) + ";" +
    "function metti(){var r=document.querySelector('.gl-azioni');" +
    "if(r){var prima=r.querySelector('.gl-sb-b')||r.querySelector('.gl-of-b')||r.querySelector('.gl-cs-b')||r.querySelector('.gl-pg-b');if(prima){if(prima.nextElementSibling!==a)r.insertBefore(a,prima.nextSibling);}else if(r.lastElementChild!==a)r.appendChild(a);" +
    "var v=document.querySelector('.gl-cm-barra');if(v&&!v.children.length&&v.parentNode)v.parentNode.removeChild(v);" +
    "var k=r.children.length;r.classList.toggle('gl-az4',k===4);r.classList.toggle('gl-az5',k>=5);r.classList.toggle('gl-az6',k>=6);r.classList.toggle('gl-az7',k>=7);r.classList.toggle('gl-az8',k>=8);r.classList.toggle('gl-az9',k>=9);r.classList.toggle('gl-az10',k>=10);return;}" +
    "var pb=document.querySelector('.gl-sb-barra')||document.querySelector('.gl-of-barra')||document.querySelector('.gl-cs-barra')||document.querySelector('.gl-pg-barra');if(pb){if(pb.lastElementChild!==a)pb.appendChild(a);return;}" +
    "if(a.parentNode)return;var b=document.createElement('div');b.className='gl-cm-barra';b.appendChild(a);var nav=document.querySelector('nav.schede');" +
    "if(nav&&nav.parentNode){nav.parentNode.insertBefore(b,nav.nextSibling);}else{document.body.insertBefore(b,document.body.firstChild);}}" +
    "metti();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',metti);setTimeout(metti,0);setTimeout(metti,60);setTimeout(metti,150);setTimeout(metti,400);" +
    "window.addEventListener('load',metti);}catch(e){}})();</script>";
}

// Nell'elenco dei cantieri: una barra con «Costi e margine di tutti i cantieri», subito sotto i servizi dell'impresa.
export function costiImpresaIniezione(base, token) {
  const u = base + "/costi?t=" + token;
  return "<style>.gl-cmi{max-width:960px;margin:10px auto 0;padding:0 12px;display:flex;justify-content:flex-end}" +
    ".gl-cmi a{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:0 16px;border:1.5px solid #0F766E;border-radius:10px;background:#E6F4F2;color:#0B4F4A;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none;box-shadow:0 0 0 3px rgba(15,118,110,.14)}" +
    ".gl-cmi a:hover,.gl-cmi a:focus-visible{background:#0F766E;color:#fff;outline:none}@media (max-width:640px){.gl-cmi a{flex:1 1 auto;justify-content:center}}" +
    "@media (prefers-color-scheme:dark){.gl-cmi a{background:#12302d;color:#cdeee9;border-color:#3FB3A6}}</style>" +
    "<script>(function(){try{function metti(){if(document.querySelector('.gl-cmi'))return;var nav=document.querySelector('nav.gl-azioni');if(!nav||!nav.parentNode)return;" +
    "var b=document.createElement('div');b.className='gl-cmi';b.innerHTML='<a href=\"'+" + JSON.stringify(u) + "+'\">'+" + JSON.stringify(ICONA + " Costi e margine di tutti i cantieri") + "+'</a>';" +
    "nav.parentNode.insertBefore(b,nav.nextSibling);}metti();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',metti);setTimeout(metti,0);setTimeout(metti,150);" +
    "window.addEventListener('load',metti);}catch(e){}})();</script>";
}

// ---------------------------------------------------------------------------- rotte
export async function portaleCosti(request, env, base, inUrl, h) {
  if (env.COSTI === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");
  if (sotto === "/costi/azione") return azione(request, env, h);
  if (sotto === "/costi/carica-fattura") return caricaFattura(request, env, h);
  if (sotto === "/costi/leggi-fattura") return leggiFattura(request, env, h);
  if (sotto === "/costi/file") return apriFattura(request, env, base, inUrl, h);
  if (sotto !== "/costi") return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const p = parametri(inUrl);
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const elenco = base + "/?t=" + p.tok;
  if (!p.c) {
    const indietro = '<p><a href="' + h.esc(elenco) + '">Torna ai cantieri</a></p>';
    const d = await h.rpc(env, "costi_riepilogo", { p_token: p.tok }, 25000).catch(() => null);
    if (!d || typeof d !== "object") return h.risposta(h.foglio(base, "Costi e margine", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
    if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
    if (d.esito !== "ok") return h.risposta(h.foglio(base, "Costi e margine", "Questa pagina non è disponibile.", indietro), 404);
    return h.risposta(riepilogo(base, h, p, d, elenco));
  }
  if (!UUID.test(p.c)) return Response.redirect(inUrl.origin + elenco, 303);
  const torna = elenco + "&c=" + p.c;
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>';
  const d = await h.rpc(env, "costi_contesto", { p_token: p.tok, p_commessa: p.c }, 25000).catch(() => null);
  if (!d || typeof d !== "object") return h.risposta(h.foglio(base, "Costi e margine", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Costi e margine", "Questa pagina non è disponibile per questo cantiere.", indietro), 404);
  return h.risposta(pagina(base, h, p, d, torna, elenco));
}

async function azione(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  if (Number(request.headers.get("Content-Length") || 0) > 20000) return json({ esito: "richiesta_non_valida" }, 413);
  let d = null;
  try { d = await request.json(); } catch (e) { d = null; }
  if (!d || typeof d !== "object") return json({ esito: "richiesta_non_valida" }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  const a = String(d.azione || "");
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c) || AZIONI.indexOf(a) === -1) return json({ esito: "richiesta_non_valida" }, 400);
  const dati = puliscoDati(a, ogg(d.dati));
  const r = await h.rpc(env, "costi_azione", { p_token: tok, p_commessa: c, p_azione: a, p_dati: dati }, 15000).catch(() => null);
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 503);
  return json(r, r.esito === "gettone" ? 403 : 200);
}

// ---------------------------------------------------------------------------- costi-2: fatture dei fornitori
// corpo: 8 cifre con la lunghezza del JSON + JSON + i byte del file
async function corpoConFile(request, max) {
  const tutto = new Uint8Array(await request.arrayBuffer());
  if (tutto.length < 10) return null;
  const lunTesto = String.fromCharCode.apply(null, Array.from(tutto.subarray(0, 8)));
  if (!/^[0-9]{8}$/.test(lunTesto)) return null;
  const lun = Number(lunTesto);
  if (!lun || lun > max || 8 + lun >= tutto.length) return null;
  let d = null;
  try { d = JSON.parse(new TextDecoder().decode(tutto.subarray(8, 8 + lun))); } catch (e) { d = null; }
  if (!d || typeof d !== "object") return null;
  return { d, bytes: tutto.subarray(8 + lun) };
}
function datiFattura(d) {
  const num = (k) => testo(d[k], 20);
  return {
    fornitore: testo(d.fornitore, 160), partita_iva: testo(d.partita_iva, 30), numero: testo(d.numero, 60), data: dataIso(d.data),
    tipo: d.tipo === "nota_credito" ? "nota_credito" : "fattura", categoria: testo(d.categoria, 30),
    imponibile: num("imponibile"), iva: num("iva"), totale: num("totale"), importo_cantiere: num("importo_cantiere"), competenza: dataIso(d.competenza),
    note: testo(d.note, 500), autore: testo(d.autore, 120),
    righe: lista(d.righe).slice(0, 300).map((r) => { const x = ogg(r); return { descrizione: testo(x.descrizione, 300), quantita: testo(x.quantita, 20),
      unita: testo(x.unita, 20), prezzo: testo(x.prezzo, 20), importo: testo(x.importo, 20), ddt: testo(x.ddt, 60) }; }).filter((r) => r.descrizione),
    ddt: lista(d.ddt).slice(0, 100).map((x) => ({ numero: testo(ogg(x).numero, 60), data: testo(ogg(x).data, 20) })).filter((x) => x.numero)
  };
}

async function caricaFattura(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  const dichiarati = Number(request.headers.get("Content-Length") || 0);
  if (dichiarati && dichiarati > 60 * 1048576) return json({ esito: "grande", messaggio: "Il file è troppo grande." }, 413);
  const cf = await corpoConFile(request, JSON_MAX);
  if (!cf) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const d = cf.d, bytes = cf.bytes;
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c)) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const nome = testo(d.nome, 200).replace(/[\\/]+/g, " ");
  const byte = Number(d.byte);
  const sha = String(d.sha256 || "").toLowerCase();
  if (!Number.isFinite(byte) || byte <= 0 || !bytes.length) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length !== byte) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  const ctl = await h.rpc(env, "costi_fattura_controlla", { p_token: tok, p_commessa: c, p_dati: { nome, byte } }, 10000).catch(() => null);
  if (!ctl || typeof ctl !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 502);
  if (ctl.esito !== "ok") return json(ctl, ctl.esito === "gettone" ? 403 : 200);
  const cartella = "documenti/" + c + "/fatture/";
  const est = MIME_F[ctl.est] ? ctl.est : "";
  const max = Number(ctl.max_byte) || 0;
  if (ctl.cartella !== cartella || !est || !max) return json({ esito: "errore", messaggio: "Richiesta non valida: ricarica la pagina." }, 502);
  if (bytes.length > max) return json({ esito: "grande", messaggio: "Il file è troppo grande: in TIX una fattura arriva fino a " + Math.round(max / 1048576) + " MB." }, 413);
  if (!/^[0-9a-f]{64}$/.test(sha)) return json({ esito: "errore", messaggio: "Manca l'impronta del file: ricarica la pagina e riprova." }, 400);
  const vero = tipoFattura(bytes);
  if (vero !== est) {
    const atteso = { xml: "una fattura elettronica XML", p7m: "una fattura elettronica firmata (.p7m)", pdf: "un PDF" }[est];
    return json({ esito: "formato", messaggio: "Il file non sembra " + atteso + ": controlla di aver scelto quello giusto." }, 415);
  }
  if (bytes.length <= VERIFICA_MAX && esadecimale(await crypto.subtle.digest("SHA-256", bytes)) !== sha) {
    return json({ esito: "impronta", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  }
  const ora = new Date();
  const giorno = ora.getUTCFullYear() + String(ora.getUTCMonth() + 1).padStart(2, "0") + String(ora.getUTCDate()).padStart(2, "0");
  const percorso = cartella + giorno + "-" + casuale(6) + "." + est;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const up = await supabaseFile(env, percorso, { method: "POST", signal: ctrl.signal, body: bytes,
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY, "Content-Type": MIME_F[est], "x-upsert": "false" } });
    if (!up.ok) return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } catch (e) {
    await togliFile(env, percorso, c);
    return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } finally {
    clearTimeout(timer);
  }
  const r = await h.rpc(env, "costi_fattura_registra", { p_token: tok, p_commessa: c,
    p_dati: Object.assign(datiFattura(d), { nome, byte: bytes.length, sha256: sha, percorso }) }, 15000).catch(() => null);
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Non so se la fattura è stata registrata: ricarica la pagina prima di riprovare." }, 502);
  if (r.esito !== "ok") {
    await togliFile(env, percorso, c);
    return json(r, r.esito === "gettone" ? 403 : 200);
  }
  return json({ esito: "ok", id: r.id, competenza: r.competenza });
}

// Toglie dall'archivio una copia di questo cantiere appena caricata (mai altro).
async function togliFile(env, percorso, c) {
  const p = String(percorso || "");
  if (!UUID.test(c) || !new RegExp("^documenti/" + c + "/fatture/[0-9]{8}-[0-9a-f]{12}\\.(xml|p7m|pdf)$").test(p)) return false;
  try { const r = await supabaseFile(env, p, { method: "DELETE" }); return r.ok; } catch (e) { return false; }
}

// Lettura automatica del PDF di una fattura (le fatture XML le legge la pagina, gratis)
async function leggiFattura(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  if (env.COSTI_IA === "off" || !env.ANTHROPIC_API_KEY) return json({ esito: "spento" });
  const cf = await corpoConFile(request, 20000);
  if (!cf) return json({ esito: "richiesta_non_valida" }, 400);
  const d = cf.d, bytes = cf.bytes;
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c)) return json({ esito: "richiesta_non_valida" }, 400);
  if (bytes.length !== Number(d.byte)) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  const ctl = await h.rpc(env, "costi_lettura_controlla", { p_token: tok, p_commessa: c }, 10000).catch(() => null);
  if (!ctl || typeof ctl !== "object") return json({ esito: "incerto", messaggio: "La lettura automatica non risponde: compila i campi a mano." }, 502);
  if (ctl.esito !== "ok") return json(ctl, ctl.esito === "gettone" ? 403 : 200);
  const r = await leggiFatturaFornitore(env, { bytes, nome: testo(d.nome, 200), modello: ctl.modello, effort: ctl.effort, fornitori: ctl.fornitori });
  if (r.esito === "formato" || r.esito === "grande" || r.esito === "spento") return json({ esito: r.esito, messaggio: r.messaggio });
  let sha = String(d.sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) sha = esadecimale(await crypto.subtle.digest("SHA-256", bytes));
  const reg = await h.rpc(env, "costi_lettura_registra", { p_token: tok, p_commessa: c, p_dati: {
    esito: r.esito, sha256: sha, modello: r.modello, token_in: r.token_in, token_out: r.token_out, ms: String(r.ms || 0), errore: r.errore || "" } }, 10000).catch(() => null);
  const usate = reg && reg.esito === "ok" ? Number(reg.usate) || 0 : (Number(ctl.usate) || 0) + 1;
  if (r.esito === "ok") return json({ esito: "ok", proposta: r.proposta, usate, limite: ctl.limite });
  if (r.esito === "vuota") return json({ esito: "vuota", messaggio: r.messaggio, usate, limite: ctl.limite });
  return json({ esito: "errore", messaggio: r.messaggio || "Non sono riuscito a leggere la fattura: compila i campi a mano.", usate, limite: ctl.limite });
}

async function apriFattura(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const p = parametri(inUrl);
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const torna = base + "/costi?t=" + p.tok + "&c=" + p.c;
  const indietro = '<a class="btn" href="' + h.esc(torna) + '">Torna a Costi e margine</a>';
  if (!UUID.test(p.c) || !UUID.test(id)) return h.risposta(h.foglio(base, "Fattura non trovata", "", indietro), 404);
  const info = await h.rpc(env, "costi_fattura_file_info", { p_token: p.tok, p_id: id }, 10000).catch(() => null);
  if (!info || typeof info !== "object") return h.risposta(h.foglio(base, "Fattura", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (info.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (info.esito === "tolta") return h.risposta(h.foglio(base, "Questa fattura è stata tolta", "Non è più tra le fatture del cantiere.", indietro), 410);
  if (info.esito !== "ok" || String(info.commessa_id || "") !== p.c) return h.risposta(h.foglio(base, "Fattura non trovata", "", indietro), 404);
  const ps = String(info.percorso || "");
  if (!new RegExp("^documenti/" + p.c + "/fatture/[0-9]{8}-[0-9a-f]{12}\\.(xml|p7m|pdf)$").test(ps)) {
    return h.risposta(h.foglio(base, "Fattura", "Il file di questa fattura non è disponibile in questo momento.", indietro), 404);
  }
  const f = await supabaseFile(env, ps).catch(() => null);
  if (!f || !f.ok) return h.risposta(h.foglio(base, "Fattura", "Il file non si legge dall'archivio in questo momento: riprova tra un minuto.", indietro), 502);
  const mime = Object.values(MIME_F).indexOf(info.mime) !== -1 ? info.mime : "application/pdf";
  const nomeF = String(info.nome || "fattura");
  const ascii = nomeF.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "fattura";
  const hd = { "Content-Type": mime, "Content-Disposition": (mime === "application/pdf" ? "inline" : "attachment") + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nomeF),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" };
  const lun = f.headers.get("Content-Length");
  if (lun && /^[0-9]+$/.test(lun)) hd["Content-Length"] = lun;
  return new Response(metodo === "HEAD" ? null : f.body, { status: 200, headers: hd });
}

// ---------------------------------------------------------------------------- pagina del cantiere
function testaHtml(h, base, titolo, moderna) {
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>" + titolo + " - TIX · Diario di cantiere</title>" + h.testa(base) + "<style>" + STILE + (moderna ? STILE_MODERNO : "") + "</style></head><body" + (moderna ? ' class="cm-moderna"' : "") + "><main>";
}
// costi-3 (MG3): pagina del cantiere nello stile scelto da Filippo il 10/11 (lo stesso del riepilogo «versione moderna»)
const svI = (d) => '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
const ICK = {
  ric: svI('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  cos: svI('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M16 15h2"/>'),
  mar: svI('<path d="m4 16 5-5 4 4 7-8"/><path d="M15 7h5v5"/>'),
  pre: svI('<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>')
};
function riquadro(cls, etichetta, valore, sotto, extra) {
  const k = String(cls).split(" ")[0];
  return '<div class="cm-r ' + cls + '"><span class="cm-r-t">' + (ICK[k] ? '<span class="cm-r-i" aria-hidden="true">' + ICK[k] + '</span>' : "") + etichetta + '</span><b>' + valore + '</b>' + (extra || "") + (sotto ? '<small>' + sotto + '</small>' : "") + '</div>';
}
function barraMargine(m, soglia) {
  const v = n(m); if (v === null) return "";
  const max = Math.max(30, Math.ceil(Math.max(v, soglia) / 10) * 10), w = Math.max(0, Math.min(100, (v / max) * 100));
  return '<span class="cm-bar" aria-hidden="true"><i style="width:' + w.toFixed(1) + '%"></i><u style="left:calc(' + ((soglia / max) * 100).toFixed(1) + '% - 1px)" title="Soglia ' + soglia + '%"></u></span>';
}
function avviso(cls, html) { return '<div class="cm-av ' + cls + '">' + html + '</div>'; }

function pagina(base, h, p, d, torna, elenco) {
  const e = h.esc;
  const q = ogg(d.quadro);
  const ult = q.ultimo && typeof q.ultimo === "object" ? q.ultimo : null;
  const cal = ogg(ult ? q.costi_al : q.costi_ora);
  const cora = ogg(q.costi_ora);
  const dopo = ogg(q.dopo);
  const man = ogg(cal.manodopera), mez = ogg(cal.mezzi), mano = ogg(cal.manuali), sub = ogg(cal.subappalti);
  const fat = ogg(cal.fatture), bol = ogg(cal.bolle);   // costi-2
  const manOra = ogg(cora.manodopera);
  const soglia = n(q.soglia) ?? 10;
  const sotto = q.stato === "sotto";
  const voci = ogg(d.voci);
  const linkSal = base + "/sal?t=" + p.tok + "&c=" + p.c;
  const oggi = dataIso(d.oggi) || new Date().toISOString().slice(0, 10);

  // 1. il quadro
  let quadro = "";
  if (!q.ricavi_disponibili) quadro += avviso("gi", "<b>Il collegamento con i ricavi della sezione SAL non è attivo:</b> il margine non si può calcolare.");
  if (ult) {
    const avz = n(q.avanzamento);
    quadro += '<div class="cm-quadro">' +
      riquadro("ric", "Ricavo al SAL n. " + e(String(ult.numero ?? "")), euroTondo(q.ricavo), "lavori fino al " + e(dataIt(q.al)) + (avz !== null ? " · lavori al " + pct(avz) : "")) +
      riquadro("cos", "Costi fino al " + e(dataIt(q.al)), euroTondo(q.costi), "manodopera, mezzi, subappalti, costi a mano") +
      riquadro("mar " + (sotto ? "no" : "ok"), "Margine al SAL n. " + e(String(ult.numero ?? "")), pct(q.margine_pct), euroTondo(q.margine) + (sotto ? " · sotto la soglia del " + pct(soglia) : " · soglia " + pct(soglia)), barraMargine(q.margine_pct, soglia)) +
      riquadro("pre" + (n(q.previsto_pct) !== null && n(q.previsto_pct) < soglia ? " no" : ""), "Previsto a fine lavori",
        n(q.previsto_pct) !== null ? pct(q.previsto_pct) : "—",
        n(q.previsto_pct) !== null ? "circa " + euroTondo(q.previsto) + " su " + euroTondo(q.contratto) + " di contratto" : "si vede quando i lavori superano il " + pct(q.previsto_da)) +
      '</div>';
    if (n(q.spese_generali_pct) !== null) {
      quadro += '<p class="cm-sg">Dopo le spese generali (' + pct(q.spese_generali_pct) + ' dei costi): <b>' + euroTondo(q.margine_dopo_sg) + '</b>' +
        (n(q.ricavo) > 0 ? " (" + pct(n(q.margine_dopo_sg) / n(q.ricavo) * 100) + ")" : "") + '</p>';
    }
    const dt = n(dopo.totale) || 0, eco = n(q.economia_ore_dopo) || 0;
    quadro += '<div class="cm-dopo"><b>In attesa del prossimo SAL</b> (dal ' + e(dataIt(addGiorno(q.al))) + '): spesi ' + euroTondo(dt) +
      (dt ? ' — manodopera ' + euroTondo(dopo.manodopera) + ', mezzi ' + euroTondo(dopo.mezzi) + ', costi a mano ' + euroTondo(dopo.manuali) + ', subappalti ' + euroTondo(dopo.subappalti) : "") +
      '. Non si tolgono dal margine: entreranno con il prossimo SAL.' +
      (eco ? ' Ore in economia per il committente da mettere a SAL: <b>' + ore(eco) + '</b> (gli euro sono nel Registro delle economie).' : "") + '</div>';
  } else {
    quadro += '<div class="cm-quadro">' +
      riquadro("ric", "Contratto", n(q.contratto) !== null ? euroTondo(q.contratto) : "—", n(q.contratto) !== null ? "dal computo della sezione SAL, varianti comprese" : "si legge dal computo della sezione SAL") +
      riquadro("cos", "Speso finora", euroTondo(cora.totale), n(q.speso_pct_contratto) !== null ? pct(q.speso_pct_contratto) + " del contratto" : "manodopera, mezzi, subappalti, costi a mano") +
      riquadro("mar", "Margine", "dal primo SAL", "il margine si calcola sul ricavo del SAL") +
      '</div>' +
      avviso("bl", "<b>Il margine compare con il primo SAL.</b> TIX confronta il ricavo del SAL con i costi fino alla sua data; i costi dopo restano a parte, così il margine non scende per finta tra un SAL e l'altro. " +
        '<a href="' + e(linkSal) + '">Vai al SAL del cantiere</a>');
  }

  // 2. dove vanno i soldi
  const col = ult ? "Fino al " + e(dataIt(q.al)) : "Finora";
  const totT = n(cal.totale) || 0;
  const rigaT = (et, a, b) => { const qa = totT > 0 && n(a) > 0 ? (n(a) / totT) * 100 : 0;
    return '<tr><th scope="row">' + et + (qa ? '<span class="cm-quota" aria-hidden="true"><i style="width:' + qa.toFixed(1) + '%"></i></span><small>' + Math.round(qa) + '% dei costi</small>' : "") + '</th><td class="n">' + euroTondo(a) + '</td>' + (ult ? '<td class="n">' + euroTondo(b) + '</td>' : "") + '</tr>'; };
  const tabella = '<section class="cm-costi"><h2 class="cm-sez">Dove vanno i costi</h2><div class="cm-tabw"><table class="cm-tab"><thead><tr><th>Costi</th><th class="n">' + col + '</th>' + (ult ? '<th class="n">Dopo il SAL</th>' : "") + '</tr></thead><tbody>' +
    rigaT("Manodopera", man.euro, dopo.manodopera) + rigaT("Mezzi propri", mez.euro, dopo.mezzi) +
    rigaT("Fatture dei fornitori", fat.euro, dopo.fatture) + rigaT("Bolle stimate con l'offerta (da controllare)", bol.euro, dopo.bolle) +
    rigaT("Costi a mano", mano.euro, dopo.manuali) + rigaT("Subappalti", sub.euro, dopo.subappalti) +
    '</tbody><tfoot><tr><th scope="row">Totale</th><td class="n">' + euroTondo(cal.totale) + '</td>' + (ult ? '<td class="n">' + euroTondo(dopo.totale) + '</td>' : "") + '</tr></tfoot></table></div></section>';

  // 3. avvisi
  let avvisi = "";
  const sq = lista(d.senza_qualifica).map((x) => testo(x, 80)).filter(Boolean);
  const oreNoQ = n(manOra.ore_senza_qualifica) || 0, oreNoC = n(manOra.ore_senza_costo) || 0, parz = Number(manOra.giorni_parziali) || 0;
  if (oreNoQ > 0) avvisi += avviso("gi", "<b>Costo parziale: " + ore(oreNoQ) + " senza qualifica.</b> Sono contate ma senza costo, perché TIX non sa se sono di un operaio comune, qualificato o specializzato." +
    (sq.length ? " Dipendenti senza qualifica: " + sq.map(e).join(", ") + "." : "") +
    (d.link_tesserini ? ' La qualifica si scrive nella <a href="' + e(d.link_tesserini) + '">scheda del tesserino</a> della persona.' : " La qualifica si scrive nella scheda del tesserino della persona."));
  else if (sq.length) avvisi += avviso("gi", "<b>Dipendenti del cantiere senza qualifica:</b> " + sq.map(e).join(", ") + ". Quando faranno ENTRO/ESCO, le loro ore non avranno costo finché non scrivi la qualifica" +
    (d.link_tesserini ? ' nella <a href="' + e(d.link_tesserini) + '">scheda del tesserino</a>.' : " nella scheda del tesserino."));
  if (oreNoC > 0) avvisi += avviso("gi", "<b>Costo parziale: " + ore(oreNoC) + " di una qualifica senza costo orario.</b> Scrivilo qui sotto, in «Costi della tua impresa».");
  if (parz > 0) avvisi += avviso("gi", "<b>Costo parziale: in " + parz + (parz === 1 ? " giorno" : " giorni") + " mancano le presenze.</b> Ci sono solo le ore in economia, non l'intera giornata, quindi il costo è più basso del vero. Le ore vere arrivano con ENTRO ed ESCO (cartello con il QR del cantiere).");
  if ((n(manOra.ore) || 0) === 0) avvisi += avviso("bl", "<b>Nessuna ora registrata finora.</b> Le ore degli operai arrivano da ENTRO ed ESCO: l'operaio inquadra il QR code del cartello del cantiere e manda il messaggio. Se qualcuno dimentica, l'ufficio aggiunge l'entrata o l'uscita dalla pagina delle timbrature.");
  const mezSenza = lista(ogg(cora.mezzi).senza_costo).map((x) => testo(x, 80)).filter(Boolean);
  if (mezSenza.length) avvisi += avviso("gi", "<b>Mezzi senza costo interno:</b> " + mezSenza.map(e).join(", ") + ". Scrivilo qui sotto, in «Costi della tua impresa».");
  if (ogg(cora.mezzi).fonte === "economia") avvisi += avviso("bl", "<b>Mezzi propri:</b> TIX conta i giorni in cui il mezzo è segnato nelle economie. I mezzi a noleggio si pagano con la fattura del noleggiatore: scrivila nei costi a mano.");
  if (!ogg(cora.subappalti).disponibile) avvisi += avviso("bl", "<b>Subappalti:</b> il collegamento con la contabilità dei subappaltatori della sezione SAL non è attivo.");
  // costi-2: bolle da prezzare e bolle senza offerta
  const bolle = lista(d.bolle), offerte = lista(d.offerte);
  const conOfferta = (b) => offerte.some((o) => stessaDitta(o.fornitore, b.fornitore));
  const daPrezzare = bolle.filter((b) => !b.stima && !lista(b.fatture).length && conOfferta(b));
  const senzaPrezzo = bolle.filter((b) => !b.stima && !lista(b.fatture).length && !conOfferta(b));
  if (daPrezzare.length) avvisi += avviso("gi", "<b>" + (daPrezzare.length === 1 ? "Una bolla si può" : daPrezzare.length + " bolle si possono") +
    " prezzare con l'offerta accettata del fornitore.</b> Aprile in «Bolle e fatture dei fornitori» e premi «Prezza con l'offerta»: la stima resta gialla finché non arriva la fattura.");
  if (senzaPrezzo.length) avvisi += avviso("bl", "<b>" + (senzaPrezzo.length === 1 ? "Una bolla è una consegna" : senzaPrezzo.length + " bolle sono consegne") +
    " senza prezzo</b>: il fornitore non ha un'offerta accettata in questo cantiere. Il costo entra con la fattura.");

  // 4. dettagli
  const nomeVoce = (v) => (VOCI.find((x) => x[0] === v) || [v, "Senza qualifica"])[1];
  const righeMan = lista(manOra.righe);
  const manDett = '<details class="cm-det" id="manodopera"><summary>Manodopera <span>' + euroTondo(manOra.euro) + ' · ' + ore(manOra.ore) + '</span></summary><div class="cm-det-c">' +
    (lista(manOra.voci).length ? '<div class="cm-tabw"><table class="cm-tab"><thead><tr><th>Qualifica</th><th class="n">Ore</th><th class="n">Costo</th></tr></thead><tbody>' +
      lista(manOra.voci).map((x) => '<tr><td>' + e(nomeVoce(x.voce)) + (x.mancano ? ' <em class="cm-man">costo mancante</em>' : "") + '</td><td class="n">' + ore(x.ore) + '</td><td class="n">' + euroTondo(x.euro) + '</td></tr>').join("") +
      '</tbody></table></div>' : '<p class="cm-vuoto">Nessuna ora registrata.</p>') +
    (righeMan.length ? '<details class="cm-sotto"><summary>Giorno per giorno (' + righeMan.length + ')</summary><div class="cm-tabw"><table class="cm-tab cm-pic"><thead><tr><th>Giorno</th><th>Chi</th><th>Qualifica</th><th class="n">Ore</th><th class="n">€/ora</th><th class="n">Costo</th><th>Da dove</th></tr></thead><tbody>' +
      righeMan.slice(0, 400).map((x) => '<tr' + (x.parziale ? ' class="pz"' : "") + '><td>' + e(dataIt(x.giorno)) + '</td><td>' + e(testo(x.chi, 80)) + '</td><td>' + e(nomeVoce(x.voce)) + '</td><td class="n">' + ore(x.ore) +
        '</td><td class="n">' + (n(x.costo_ora) !== null ? euro(x.costo_ora) : "—") + '</td><td class="n">' + (n(x.euro) !== null ? euro(x.euro) : "—") + '</td><td>' +
        (x.fonte === "presenze" ? "ENTRO/ESCO" : x.fonte === "rapportino" ? "rapportino (solo economia)" : "WhatsApp (solo economia)") + '</td></tr>').join("") +
      '</tbody></table></div></details>' : "") + '</div></details>';

  const mezOra = ogg(cora.mezzi);
  const mezDett = '<details class="cm-det" id="mezzi"><summary>Mezzi propri <span>' + euroTondo(mezOra.euro) + '</span></summary><div class="cm-det-c">' +
    (lista(mezOra.mezzi).length ? '<div class="cm-tabw"><table class="cm-tab"><thead><tr><th>Mezzo</th><th class="n">Uso</th><th class="n">Giorni</th><th class="n">Costo</th></tr></thead><tbody>' +
      lista(mezOra.mezzi).map((x) => '<tr><td>' + e(testo(x.nome, 80)) + (x.senza_costo ? ' <em class="cm-man">costo mancante</em>' : "") + '</td><td class="n">' + e(valoreIt(x.quantita)) + " " + e(UNITA[x.unita] || x.unita || "") +
        '</td><td class="n">' + (Number(x.giorni) || 0) + '</td><td class="n">' + euroTondo(x.euro) + '</td></tr>').join("") +
      '</tbody></table></div>' : '<p class="cm-vuoto">Nessun uso di mezzi propri registrato.</p>') + '</div></details>';

  const manuali = lista(d.manuali);
  const nomeCat = (k) => (CATEGORIE.find((x) => x[0] === k) || [k, k])[1];
  const opzCat = CATEGORIE.map((x) => '<option value="' + x[0] + '">' + e(x[1]) + '</option>').join("");
  const manoDett = '<details class="cm-det" id="manuali"' + (manuali.length ? "" : " open") + '><summary>Costi scritti a mano <span>' + euroTondo(ogg(cora.manuali).euro) + '</span></summary><div class="cm-det-c">' +
    '<p class="cm-nota">Qui i costi senza una fattura da caricare: piccoli acquisti, scontrini, autonomi. Le fatture dei fornitori si caricano in «Bolle e fatture dei fornitori», così si confrontano con le bolle e con l\'offerta. Un subappaltatore con la sua contabilità in TIX non va scritto qui, altrimenti si conta due volte.</p>' +
    (manuali.length ? '<div class="cm-tabw"><table class="cm-tab"><thead><tr><th>Data</th><th>Tipo</th><th>Che cosa</th><th class="n">Importo</th><th></th></tr></thead><tbody>' +
      manuali.map((x) => '<tr><td>' + e(dataIt(x.data)) + '</td><td>' + e(nomeCat(x.categoria)) + '</td><td>' + e(testo(x.descrizione, 300)) +
        (x.fornitore || x.numero ? '<small>' + e([testo(x.fornitore, 120), x.numero ? "n. " + testo(x.numero, 60) : ""].filter(Boolean).join(" · ")) + '</small>' : "") +
        '<small>scritto da ' + e(testo(x.autore, 120)) + (x.modificato_da ? ", modificato da " + e(testo(x.modificato_da, 120)) : "") + '</small></td><td class="n">' + euro(x.importo) +
        '</td><td class="cm-az"><button type="button" class="btn sm tenue" data-mod="' + e(x.id) + '">Modifica</button> <button type="button" class="btn sm togli" data-tog="' + e(x.id) + '">Togli</button></td></tr>').join("") +
      '</tbody></table></div>' : '<p class="cm-vuoto">Nessun costo scritto a mano.</p>') +
    '<form class="cm-form" id="cm-f" autocomplete="off"><h3 id="cm-f-tit">Aggiungi un costo</h3><input type="hidden" id="cm-f-id">' +
    '<div class="cm-campi"><label><span>Data</span><input type="date" id="cm-f-data" value="' + e(oggi) + '"></label>' +
    '<label><span>Tipo</span><select id="cm-f-cat">' + opzCat + '</select></label>' +
    '<label><span>Importo + IVA (€)</span><input id="cm-f-imp" inputmode="decimal" placeholder="1.234,50"></label>' +
    '<label class="l2"><span>Che cosa è</span><input id="cm-f-descr" maxlength="300" placeholder="Per esempio: fattura del ferro di ottobre"></label>' +
    '<label><span>Fornitore (facoltativo)</span><input id="cm-f-forn" maxlength="120"></label>' +
    '<label><span>Numero del documento (facoltativo)</span><input id="cm-f-num" maxlength="60"></label></div>' +
    '<div class="cm-chi"><label for="cm-f-chi">Il tuo nome</label><input id="cm-f-chi" maxlength="120" autocomplete="name"></div>' +
    '<p class="cm-msg" id="cm-f-msg" role="status"></p><div class="cm-form-az"><button type="button" class="btn tenue" id="cm-f-annulla" hidden>Annulla la modifica</button><button type="button" class="btn pr" id="cm-f-salva">Salva il costo</button></div></form>' +
    '</div></details>';

  // costi-2: bolle e fatture dei fornitori
  const fatture = lista(d.fatture);
  const ia = ogg(d.fatture_ia);
  const maxMb = Math.max(1, Math.min(50, Number(d.max_mb) || 25));
  const linkFile = (id) => base + "/costi/file?t=" + p.tok + "&c=" + p.c + "&id=" + encodeURIComponent(String(id || ""));
  const schedaFattura = (f) => {
    const conf = confrontoFattura(f, bolle, offerte);
    const nc = f.tipo === "nota_credito";
    const righeF = lista(f.righe);
    return '<div class="cm-fa' + (conf.some((x) => x.cls === "gi") ? " gi" : "") + '"><div class="cm-fa-t"><h3>' + e(testo(f.fornitore, 160)) + '</h3>' +
      '<span class="cm-st ' + (nc ? "no" : "ok") + '">' + (nc ? "nota di credito" : "fattura") + ' · ' + (f.fonte === "xml" ? "XML" : "PDF") + '</span></div>' +
      '<p class="cm-fa-m">n. <b>' + e(testo(f.numero, 60)) + '</b> del ' + e(dataIt(f.data)) + (f.partita_iva ? ' · P. IVA ' + e(testo(f.partita_iva, 30)) : "") + '</p>' +
      '<p class="cm-fa-m">Imponibile <b>' + euro(f.imponibile) + '</b>' + (n(f.iva) !== null ? ' · IVA ' + euro(f.iva) : "") +
      ' · <b>per questo cantiere ' + (nc ? "−" : "") + euro(f.importo_cantiere) + '</b>' + (n(f.importo_cantiere) !== n(f.imponibile) ? ' (quota)' : "") +
      ' · conta dal ' + e(dataIt(f.competenza)) + ' · ' + e((CATEGORIE.find((x) => x[0] === f.categoria) || [0, f.categoria])[1]) + '</p>' +
      '<ul class="cm-conf">' + conf.map((x) => '<li class="' + x.cls + '">' + e(x.t) + '</li>').join("") + '</ul>' +
      (righeF.length ? '<details class="cm-sotto"><summary>Righe della fattura (' + righeF.length + ')</summary><div class="cm-tabw"><table class="cm-tab cm-pic"><thead><tr><th>Descrizione</th><th class="n">Quantità</th><th class="n">Prezzo</th><th class="n">Importo</th><th>Bolla</th></tr></thead><tbody>' +
        righeF.slice(0, 300).map((r) => '<tr><td>' + e(testo(r.descrizione, 300)) + '</td><td class="n">' + (n(r.quantita) !== null ? e(valoreIt(r.quantita)) + " " + e(testo(r.unita, 20)) : "—") +
          '</td><td class="n">' + (n(r.prezzo) !== null ? euro(r.prezzo) : "—") + '</td><td class="n">' + (n(r.importo) !== null ? euro(r.importo) : "—") + '</td><td>' + e(testo(r.ddt, 60)) + '</td></tr>').join("") +
        '</tbody></table></div></details>' : "") +
      (f.note ? '<p class="cm-fa-m">' + e(testo(f.note, 500)) + '</p>' : "") +
      '<p class="cm-fa-m cm-tenue">caricata da ' + e(testo(f.autore, 120)) + (f.modificato_da ? ", modificata da " + e(testo(f.modificato_da, 120)) : "") + '</p>' +
      '<div class="cm-az-r">' + (f.file ? '<a class="btn sm tenue" href="' + e(linkFile(f.id)) + '" target="_blank" rel="noopener">Apri il file</a>' : "") +
      '<button type="button" class="btn sm tenue" data-fmod="' + e(f.id) + '">Modifica</button><button type="button" class="btn sm togli" data-ftog="' + e(f.id) + '">Togli</button></div></div>';
  };
  const schedaBolla = (b) => {
    const fattB = lista(b.fatture);
    let stato;
    if (fattB.length) stato = '<span class="cm-st ok">fatturata</span><small>fattura n. ' + fattB.map((x) => e(testo(x.numero, 60))).join(", ") + '</small>';
    else if (b.stima) stato = '<span class="cm-st gi">stimata ' + euro(b.stima.importo) + '</span><small>con l\'offerta, da controllare (' + e(testo(b.stima.autore, 60)) + ')</small>';
    else if (conOfferta(b)) stato = '<span class="cm-st gi">da prezzare</span>';
    else stato = '<span class="cm-st gr">senza prezzo</span><small>entra con la fattura</small>';
    return '<tr><td data-l="Data">' + e(dataIt(b.data)) + (b.data_scritta ? "" : '<small>data di arrivo</small>') + '</td><td><b>' + e(testo(b.fornitore, 120) || "—") + '</b><small>n. ' + e(testo(b.numero, 60) || "—") + '</small></td>' +
      '<td data-l="Materiale">' + e(testo(b.materiale, 200)) + (b.quantita ? '<small>' + e(testo(b.quantita, 120)) + '</small>' : "") + '</td><td data-l="Stato">' + stato + '</td><td class="cm-az">' +
      (!fattB.length && conOfferta(b) ? '<button type="button" class="btn sm sec" data-bprezza="' + e(b.ddt_id) + '">' + (b.stima ? "Rifai la stima" : "Prezza con l'offerta") + '</button> ' : "") +
      (b.stima && !fattB.length ? '<button type="button" class="btn sm togli" data-btog="' + e(b.stima.id) + '">Togli la stima</button> ' : "") +
      (b.foto && /^https:\/\/drive\.google\.com\//.test(String(b.foto)) ? '<a class="btn sm tenue" href="' + e(b.foto) + '" target="_blank" rel="noopener">Foto</a>' : "") + '</td></tr>';
  };
  const opzCatF = CATEGORIE.filter((x) => x[0] !== "subappalti").map((x) => '<option value="' + x[0] + '">' + e(x[1]) + '</option>').join("");
  const fornDett = '<details class="cm-det" id="fornitori"' + (fatture.length || bolle.length ? " open" : "") + '><summary>Bolle e fatture dei fornitori <span>' +
    euroTondo((n(ogg(cora.fatture).euro) || 0) + (n(ogg(cora.bolle).euro) || 0)) + '</span></summary><div class="cm-det-c">' +
    '<p class="cm-nota">Le <b>bolle</b> arrivano dal Diario (foto del DDT su WhatsApp). Se il fornitore ha un\'<b>offerta accettata</b> nel cantiere, la bolla si prezza con l\'offerta: è una stima gialla. ' +
    'A fine mese carichi la <b>fattura</b>: quella elettronica (.xml, anche .xml.p7m) si legge da sola e gratis' + (ia.attiva ? ', il PDF lo legge TIX con l\'IA' : ', il PDF lo compili tu') +
    '. La fattura prende il posto delle stime delle bolle che cita e TIX la confronta con bolle e offerta. Importi + IVA.</p>' +
    // carica una fattura
    '<form class="cm-form" id="cm-x" autocomplete="off"><h3>Carica una fattura</h3>' +
    '<label class="cm-drop" id="cm-x-drop"><input type="file" id="cm-x-file" accept=".xml,.p7m,.pdf,application/pdf,text/xml,application/xml"><span id="cm-x-scegli">Scegli la fattura: XML, .xml.p7m oppure PDF (fino a ' + maxMb + ' MB)</span></label>' +
    '<div class="cm-ia" id="cm-x-ia" role="status" hidden></div>' +
    '<div id="cm-x-resto" hidden><div class="cm-campi"><label class="l2"><span>Fornitore</span><input id="cm-x-forn" maxlength="160"></label><label><span>Partita IVA</span><input id="cm-x-piva" maxlength="30"></label>' +
    '<label><span>Numero</span><input id="cm-x-num" maxlength="60"></label><label><span>Data</span><input type="date" id="cm-x-data"></label>' +
    '<label><span>Tipo</span><select id="cm-x-tipo"><option value="fattura">Fattura</option><option value="nota_credito">Nota di credito</option></select></label>' +
    '<label><span>Imponibile (€)</span><input id="cm-x-imp" inputmode="decimal" placeholder="1.234,50"></label><label><span>IVA (€)</span><input id="cm-x-iva" inputmode="decimal"></label>' +
    '<label><span>Totale (€)</span><input id="cm-x-tot" inputmode="decimal"></label>' +
    '<label><span>Per questo cantiere (€)</span><input id="cm-x-quota" inputmode="decimal" placeholder="tutto l\'imponibile"></label>' +
    '<label><span>Conta dal</span><input type="date" id="cm-x-comp"></label><label><span>Tipo di costo</span><select id="cm-x-cat">' + opzCatF + '</select></label>' +
    '<label class="l2"><span>Bolle citate</span><input id="cm-x-ddt" maxlength="2000" placeholder="457 del 05/10/2026; 458 del 06/10/2026"></label>' +
    '<label><span>Note (facoltative)</span><input id="cm-x-note" maxlength="500"></label></div>' +
    '<div class="cm-righe-x" id="cm-x-righe" hidden></div>' +
    '<p class="cm-nota">«Per questo cantiere» serve quando una fattura vale per più cantieri. «Conta dal» è la data in cui il costo entra nel conto: di base la data dell\'ultima bolla citata.</p>' +
    '<div class="cm-chi"><label for="cm-x-chi">Il tuo nome</label><input id="cm-x-chi" maxlength="120" autocomplete="name"></div>' +
    '<p class="cm-msg" id="cm-x-msg" role="status"></p><div class="cm-form-az"><button type="button" class="btn pr" id="cm-x-salva">Salva la fattura</button></div></div></form>' +
    // fatture
    '<h3 class="cm-h3">Fatture (' + fatture.length + ')</h3>' +
    (fatture.length ? '<div class="cm-griglia">' + fatture.map(schedaFattura).join("") + '</div>' : '<p class="cm-vuoto">Nessuna fattura caricata.</p>') +
    // bolle
    '<h3 class="cm-h3">Bolle del Diario (' + bolle.length + ')</h3>' +
    (bolle.length ? '<div class="cm-tabw"><table class="cm-tab cm-bolle"><thead><tr><th>Data</th><th>Fornitore</th><th>Materiale</th><th>Stato</th><th></th></tr></thead><tbody>' +
      bolle.map(schedaBolla).join("") + '</tbody></table></div>' : '<p class="cm-vuoto">Nessuna bolla nel Diario di questo cantiere.</p>') +
    '</div></details>';

  const subOra = ogg(cora.subappalti);
  const subDett = '<details class="cm-det" id="subappalti"><summary>Subappalti <span>' + euroTondo(subOra.euro) + '</span></summary><div class="cm-det-c">' +
    (lista(subOra.contratti).length ? '<div class="cm-tabw"><table class="cm-tab"><thead><tr><th>Subappaltatore</th><th class="n">Contratto</th><th class="n">Lavori contabilizzati</th><th class="n">Economie</th></tr></thead><tbody>' +
      lista(subOra.contratti).map((x) => '<tr><td>' + e(testo(x.impresa_nome, 120)) + '</td><td class="n">' + euroTondo(x.importo_contratto) + '</td><td class="n">' + euroTondo(x.lavori_ora ?? x.lavori_al) + '</td><td class="n">' + euroTondo(x.economie_ora ?? x.economie_al ?? 0) + '</td></tr>').join("") +
      '</tbody></table></div>' : '<p class="cm-vuoto">Nessun subappaltatore con la contabilità in TIX.</p>') +
    '<p class="cm-nota">Conta l\'ultimo SAL approvato di ogni subappaltatore, ritenuta compresa, più le sue ore in economia segnate nel Diario al prezzo del contratto. Il margine voce per voce è nella scheda Subappalti della ' +
    '<a href="' + e(linkSal) + '">pagina SAL</a>.</p></div></details>';

  // 5. costi della tua impresa
  const campoVoce = (v) => {
    const x = ogg(voci[v[0]]);
    const st = lista(x.storico);
    return '<label><span>' + e(v[1]) + ' <i>' + e(v[2]) + '</i></span><input id="cm-v-' + v[0] + '" data-voce="' + v[0] + '" inputmode="decimal" value="' + e(valoreIt(x.valore)) + '" data-prima="' + e(valoreIt(x.valore)) + '"' +
      (v[0] === "soglia_margine_pct" && n(x.valore) === null ? ' placeholder="' + e(valoreIt(soglia)) + '"' : v[0] === "spese_generali_pct" ? ' placeholder="non scritte"' : ' placeholder="da scrivere"') + '>' +
      (st.length ? '<small>' + st.slice(0, 2).map((s) => (n(s.valore) !== null ? valoreIt(s.valore) : "tolto") + " dal " + dataIt(s.dal) + " (" + testo(s.autore, 60) + ")").map(e).join(" · ") + '</small>' : "") + '</label>';
  };
  const mezziProp = lista(d.mezzi).filter((m) => m.proprieta === "proprieta");
  const mezziNol = lista(d.mezzi).filter((m) => m.proprieta !== "proprieta");
  const impresa = '<section class="cm-imp" id="impresa"><h2>Costi della tua impresa</h2>' +
    '<p class="cm-nota">Valgono per tutti i cantieri della tua impresa. Scrivi il <b>costo</b> per l\'impresa (paga, contributi, ferie, assicurazione), non il prezzo che fai pagare al committente. Mai lo stipendio della singola persona: solo per qualifica. Ogni cambio resta registrato con la data e il nome, e vale dalla data che scrivi.</p>' +
    '<div class="cm-campi cm-voci">' + VOCI.map(campoVoce).join("") + '</div>' +
    (mezziProp.length ? '<h3>Costo interno dei mezzi propri</h3><div class="cm-campi cm-voci">' + mezziProp.map((m) => {
      const k = ogg(m.costo);
      return '<label><span>' + e(testo(m.nome, 80)) + (m.targa ? ' <i>' + e(testo(m.targa, 30)) + '</i>' : "") + ' <i>€ per ' + e(UNITA[m.unita] || m.unita) + '</i></span>' +
        '<input data-mezzo="' + e(m.id) + '" inputmode="decimal" value="' + e(valoreIt(k.costo)) + '" data-prima="' + e(valoreIt(k.costo)) + '" placeholder="da scrivere">' +
        (k.dal ? '<small>dal ' + e(dataIt(k.dal)) + ' (' + e(testo(k.autore, 60)) + ')</small>' : "") + '</label>';
    }).join("") + '</div>' : '<p class="cm-nota">Nessun mezzo proprio nella sezione Mezzi e attrezzature' + (d.mezzi_attiva !== "no" ? ': aggiungili dall\'elenco dei cantieri, pulsante «Mezzi e attrezzature».' : '.') + '</p>') +
    (mezziNol.length ? '<p class="cm-nota">Mezzi a noleggio (' + mezziNol.map((m) => e(testo(m.nome, 60))).join(", ") + '): si pagano con la fattura del noleggiatore, da scrivere nei costi a mano. Così non si pagano due volte.</p>' : "") +
    '<div class="cm-campi"><label><span>Valido dal</span><input type="date" id="cm-v-dal" value="' + e(oggi) + '"></label>' +
    '<label class="l2"><span>Il tuo nome</span><input id="cm-v-chi" maxlength="120" autocomplete="name"></label></div>' +
    '<p class="cm-msg" id="cm-v-msg" role="status"></p><div class="cm-form-az"><button type="button" class="btn pr" id="cm-v-salva">Salva i costi</button></div></section>';

  const fonti = '<p class="cm-fonti"><b>Da dove vengono i numeri.</b> Ricavo: l\'ultimo SAL valido (emesso, firmato dall\'impresa o vistato dal DL) della sezione SAL. ' +
    'Manodopera: le ore di ENTRO/ESCO dei dipendenti × il costo orario della loro qualifica; nei giorni senza ENTRO/ESCO contano le ore in economia del rapportino firmato o di WhatsApp (costo parziale). ' +
    'Le ore dei subappaltatori non entrano qui: entra il loro SAL. Mezzi propri: uso × costo interno. Spese generali: in una riga a parte, solo se le scrivi. ' +
    '<b>Questa pagina la vedono solo le persone della tua impresa</b> con l\'accesso all\'app: mai il DL, il committente, i professionisti, i subappaltatori o gli operai su WhatsApp. Tutti gli importi sono + IVA.</p>';

  const cfg = JSON.stringify({ u: base + "/costi/azione", t: p.tok, c: p.c, manuali: manuali.map((x) => ({ id: x.id, data: x.data, categoria: x.categoria,
    fornitore: x.fornitore || "", descrizione: x.descrizione || "", numero: x.numero || "", importo: x.importo })),
    // costi-2
    uc: base + "/costi/carica-fattura", ul: base + "/costi/leggi-fattura", ia: ia.attiva === true, max: maxMb * 1048576, maxMb,
    fatture: fatture.map((f) => ({ id: f.id, numero: f.numero, fornitore: f.fornitore, categoria: f.categoria, importo_cantiere: f.importo_cantiere,
      imponibile: f.imponibile, competenza: f.competenza, note: f.note || "" })),
    bolle: bolle.map((b) => ({ ddt_id: b.ddt_id, fornitore: b.fornitore || "", numero: b.numero || "", materiale: b.materiale || "", quantita: b.quantita || "",
      stima: b.stima ? { offerta_id: b.stima.offerta_id, righe: lista(b.stima.righe) } : null })),
    offerte: offerte.map((o) => ({ id: o.id, fornitore: o.fornitore, materiale: o.materiale || "", numero: o.numero || "", righe: lista(o.righe) })) }).replace(/</g, "\\u003c");

  return testaHtml(h, base, "Costi e margine", true) +
    '<nav class="cm-nav"><a class="cm-torna" href="' + e(torna) + '">‹ Torna al cantiere</a><a class="cm-torna" href="' + e(base + "/costi?t=" + p.tok) + '">Tutti i cantieri</a></nav>' +
    '<div class="cm-card' + (sotto ? " cm-rosso" : "") + '"><header class="cm-band"><div><h1><span class="cm-ic" aria-hidden="true">' + ICONA + '</span>Costi e margine</h1>' +
    (d.cantiere ? '<p class="cm-cant">' + e(d.cantiere) + '</p>' : "") + '</div>' +
    (d.modo === "prova" ? '<span class="cm-prova">In prova · la vede solo «Tutte le aziende»</span>' : "") + '</header>' +
    quadro + tabella + avvisi + manDett + mezDett + fornDett + manoDett + subDett + impresa + fonti + '</div></main>' +
    // costi-2: finestre per la stima di una bolla, la modifica di una fattura, togli fattura o stima
    '<dialog class="cm-dlg cm-dlg-l" id="cm-b-dlg"><form method="dialog"><h3 id="cm-b-tit">Prezza la bolla con l\'offerta</h3>' +
    '<p id="cm-b-txt"></p><label for="cm-b-off">Offerta accettata</label><select id="cm-b-off"></select>' +
    '<div id="cm-b-righe"></div><p><button type="button" class="btn sm tenue" id="cm-b-piu">+ Aggiungi una riga</button></p>' +
    '<p class="cm-b-tot">Stima: <b id="cm-b-tot">—</b> + IVA <small>(il prezzo lo prende TIX dall\'offerta)</small></p>' +
    '<label for="cm-b-chi">Il tuo nome</label><input id="cm-b-chi" maxlength="120" autocomplete="name">' +
    '<p class="cm-msg" id="cm-b-msg" role="status"></p><div class="cm-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn pr" id="cm-b-si">Salva la stima</button></div></form></dialog>' +
    '<dialog class="cm-dlg" id="cm-fm-dlg"><form method="dialog"><h3>Modifica la fattura</h3><p id="cm-fm-txt"></p>' +
    '<label for="cm-fm-quota">Per questo cantiere (€)</label><input id="cm-fm-quota" inputmode="decimal">' +
    '<label for="cm-fm-comp">Conta dal</label><input type="date" id="cm-fm-comp">' +
    '<label for="cm-fm-cat">Tipo di costo</label><select id="cm-fm-cat">' + opzCatF + '</select>' +
    '<label for="cm-fm-note">Note</label><input id="cm-fm-note" maxlength="500">' +
    '<label for="cm-fm-chi">Il tuo nome</label><input id="cm-fm-chi" maxlength="120" autocomplete="name">' +
    '<p class="cm-msg" id="cm-fm-msg" role="status"></p><div class="cm-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn pr" id="cm-fm-si">Salva</button></div></form></dialog>' +
    '<dialog class="cm-dlg" id="cm-t2-dlg"><form method="dialog"><h3 id="cm-t2-tit">Togli</h3><p id="cm-t2-txt"></p>' +
    '<label for="cm-t2-chi">Il tuo nome</label><input id="cm-t2-chi" maxlength="120" autocomplete="name">' +
    '<label for="cm-t2-mot">Perché (facoltativo)</label><input id="cm-t2-mot" maxlength="300">' +
    '<p class="cm-msg" id="cm-t2-msg" role="status"></p><div class="cm-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn rosso" id="cm-t2-si">Togli</button></div></form></dialog>' +
    '<dialog class="cm-dlg" id="cm-t-dlg"><form method="dialog"><h3>Togli il costo</h3><p id="cm-t-txt"></p>' +
    '<label for="cm-t-chi">Il tuo nome</label><input id="cm-t-chi" maxlength="120" autocomplete="name">' +
    '<label for="cm-t-mot">Perché (facoltativo)</label><input id="cm-t-mot" maxlength="300" placeholder="Per esempio: scritto due volte">' +
    '<p class="cm-msg" id="cm-t-msg" role="status"></p><div class="cm-form-az"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn rosso" id="cm-t-si">Togli</button></div></form></dialog>' +
    "<script>var CFG=" + cfg + ";" + SCRIPT + "</script></body></html>";
}
function addGiorno(iso) {
  const t = Date.parse(String(iso || "") + "T00:00:00Z");
  return Number.isFinite(t) ? new Date(t + 86400000).toISOString().slice(0, 10) : "";
}

// ---------------------------------------------------------------------------- riepilogo di tutti i cantieri
// costi-3 (MG3): riepilogo nello stile scelto da Filippo il 10/11 (versione moderna 2, parte alta «A · fascia»): fascia, 4 riquadri con icona,
// ricerca, filtri per stato e colonne ordinabili, iniziali e riga colorata per stato, quota dei costi sul ricavo, barretta del margine con la soglia.
const svR = (d, w) => '<svg viewBox="0 0 24 24" width="' + (w || 20) + '" height="' + (w || 20) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
const ICR = {
  sezione: svR('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>', 22),
  cantieri: svR('<path d="M3 21h18"/><path d="M5 21V8l7-4 7 4v13"/><path d="M9 21v-6h6v6"/>'),
  ricavo: svR('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  costi: svR('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M16 15h2"/>'),
  margine: svR('<path d="m4 16 5-5 4 4 7-8"/><path d="M15 7h5v5"/>'),
  cerca: svR('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.6-3.6"/>', 18),
  info: svR('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>', 18),
  freccia: svR('<path d="m9 6 6 6-6 6"/>', 16),
  ord: svR('<path d="m8 9 4-4 4 4"/><path d="m16 15-4 4-4-4"/>', 13)
};
const iniziali = (s) => { const p = String(s || "").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter((x) => !/^(di|del|della|via|e|il|la|lo|le|i|gli|s)$/i.test(x)); return ((p[0] || "?")[0] + ((p[1] || "")[0] || "")).toUpperCase(); };
function riepilogo(base, h, p, d, elenco) {
  const e = h.esc;
  const cc = lista(d.cantieri);
  const conSal = cc.filter((x) => x.sal);
  const nSotto = cc.filter((x) => x.stato === "sotto").length, nOk = cc.filter((x) => x.stato === "ok").length, nSenza = cc.length - nSotto - nOk;
  const ricavo = conSal.reduce((s, x) => s + (n(x.ricavo) || 0), 0), costi = conSal.reduce((s, x) => s + (n(x.costi) || 0), 0);
  const mTot = ricavo ? ((ricavo - costi) / ricavo) * 100 : null, soglia = n((cc[0] || {}).soglia) ?? 10, mNo = mTot !== null && mTot < soglia;
  const max = Math.max(30, Math.ceil(Math.max.apply(null, [0, soglia, mTot || 0].concat(conSal.map((x) => n(x.margine_pct) || 0))) / 10) * 10);
  const barra = (v) => { const w = n(v) === null ? 0 : Math.max(0, Math.min(100, (n(v) / max) * 100));
    return '<span class="rp-bar" aria-hidden="true"><i style="width:' + w.toFixed(1) + '%"></i><u style="left:calc(' + ((soglia / max) * 100).toFixed(1) + '% - 1px)" title="Soglia ' + soglia + '%"></u></span>'; };
  const ordine = { sotto: 0, ok: 1 };
  const righe = cc.slice().sort((a, b) => (ordine[a.stato] ?? 2) - (ordine[b.stato] ?? 2) || String(a.nome || "").localeCompare(String(b.nome || ""), "it")).map((x) => {
    const u = base + "/costi?t=" + p.tok + "&c=" + encodeURIComponent(String(x.id || ""));
    const cl = x.stato === "sotto" ? "no" : x.stato === "ok" ? "ok" : "vuoto";
    const st = x.stato === "sotto" ? '<span class="rp-st no">Sotto la soglia</span>' : x.stato === "ok" ? '<span class="rp-st ok">In linea</span>' : '<span class="rp-st gr">Senza SAL</span>';
    const quota = x.sal && n(x.ricavo) ? Math.round(((n(x.costi) || 0) / n(x.ricavo)) * 100) : null;
    const mg = x.sal ? '<div class="rp-mg ' + (x.stato === "sotto" ? "no" : "ok") + '">' + barra(x.margine_pct) + '<b>' + pct(x.margine_pct) + '</b></div><small class="rp-dx">' + euroTondo(x.margine) + '</small>' : '<span class="rp-tenue">—</span>';
    const k = (v) => (n(v) === null ? "" : String(n(v)));
    const nome = testo(x.nome, 120);
    return '<tr class="' + cl + '" data-href="' + e(u) + '" data-stato="' + cl + '" data-nome="' + e(nome.toLowerCase()) + '" data-ricavo="' + k(x.sal ? x.ricavo : null) + '" data-costi="' + k(x.sal ? x.costi : x.speso) +
      '" data-margine="' + k(x.sal ? x.margine_pct : null) + '" data-previsto="' + k(x.previsto_pct) + '" data-sal="' + k(x.sal) + '">' +
      '<td class="rp-tdn"><div class="rp-nome"><span class="rp-av" aria-hidden="true">' + e(iniziali(nome)) + '</span><div><a href="' + e(u) + '">' + e(nome) + '</a> <span class="rp-vai">' + ICR.freccia + '</span>' +
      (d.filippo && x.impresa ? '<small>' + e(testo(x.impresa, 80)) + '</small>' : "") +
      (x.parziale ? '<span class="rp-tag gi">Costo parziale</span>' : "") + (x.chiuso ? '<span class="rp-tag gr">Chiuso</span>' : "") + '</div></div></td>' +
      '<td class="n" data-l="Ultimo SAL">' + (x.sal ? "n. " + e(String(x.sal)) + "<small>al " + e(dataIt(x.al)) + "</small>" : "—") + '</td>' +
      '<td class="n" data-l="Ricavo">' + (x.sal && n(x.ricavo) !== null ? euroTondo(x.ricavo) : "—") + '</td>' +
      '<td class="n" data-l="' + (x.sal ? "Costi al SAL" : "Speso finora") + '">' + euroTondo(x.sal ? x.costi : x.speso) + (quota !== null ? '<small>' + quota + '% del ricavo</small>' : "") + '</td>' +
      '<td class="n rp-tdm" data-l="Margine">' + mg + '</td>' +
      '<td class="n" data-l="Previsto a fine lavori">' + (n(x.previsto_pct) !== null ? pct(x.previsto_pct) + '<small>a fine lavori</small>' : "—") + '</td>' +
      '<td class="rp-tds" data-l="Stato">' + st + '</td></tr>';
  }).join("");
  const th = (t, chiave, num) => '<th' + (num ? ' class="n"' : "") + '><button type="button" data-ord="' + chiave + '">' + (num ? ICR.ord + t : t + ICR.ord) + '</button></th>';
  const filtro = (f, t, quanti, extra) => '<button type="button" data-fil="' + f + '" aria-pressed="' + (f === "tutti") + '"' + (extra ? ' class="' + extra + '"' : "") + '>' + t + ' <i>' + quanti + '</i></button>';
  const kr = (ic, l, b, s, cl, ex) => '<div class="rp-k' + (cl ? " " + cl : "") + '"><span class="rp-k-t"><span class="rp-k-i">' + ic + '</span>' + l + '</span><b>' + b + '</b>' + (ex || "") + '<small>' + s + '</small></div>';
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>Costi e margine - TIX · Diario di cantiere</title>" + h.testa(base) + "<style>" + STILE_RIEPILOGO + "</style></head><body class=\"rp-pagina\"><main>" +
    '<nav class="rp-nav"><a href="' + e(elenco) + '">‹ Torna ai cantieri</a></nav>' +
    '<header class="rp-band"><div class="rp-band-r"><div><h1><span class="rp-ic" aria-hidden="true">' + ICR.sezione + '</span>Costi e margine di tutti i cantieri</h1>' +
    '<p class="rp-sub">Margine all\'ultimo SAL di ogni cantiere · soglia ' + pct(soglia) + ' · importi + IVA</p></div>' +
    (d.modo === "prova" ? '<span class="rp-prova">In prova · la vede solo «Tutte le aziende»</span>' : "") + '</div></header>' +
    '<section class="rp-kpi" aria-label="Riepilogo">' +
    kr(ICR.cantieri, "Cantieri", String(cc.length), nSenza ? nSenza + " ancora senza SAL" : "tutti con almeno un SAL") +
    kr(ICR.ricavo, "Ricavo maturato", euroTondo(ricavo), "somma degli ultimi SAL") +
    kr(ICR.costi, "Costi al SAL", euroTondo(costi), ricavo ? Math.round((costi / ricavo) * 100) + "% del ricavo maturato" : "fino alla data di ogni SAL") +
    kr(ICR.margine, "Margine complessivo", mTot !== null ? pct(mTot) : "—", (mTot !== null ? euroTondo(ricavo - costi) + " · " : "") + (nSotto ? nSotto + (nSotto === 1 ? " cantiere" : " cantieri") + " sotto la soglia" : "nessuno sotto la soglia"),
      "mg" + (mNo ? " no" : ""), mTot !== null ? barra(mTot) : "") + '</section>' +
    (nSotto ? '<div class="rp-avv" role="status"><span class="rp-avv-i">!</span><div><b>' + (nSotto === 1 ? "Un cantiere è" : nSotto + " cantieri sono") + ' sotto la soglia del ' + pct(soglia) + '.</b> È in cima all\'elenco: aprilo per vedere dove vanno i costi.</div></div>' : "") +
    (cc.length ? '<section class="rp-card"><div class="rp-tool"><h2>Cantieri<span>' + cc.length + '</span></h2><div class="rp-tool-r">' +
      '<label class="rp-cerca">' + ICR.cerca + '<input type="search" id="rp-q" placeholder="Cerca un cantiere" aria-label="Cerca un cantiere"></label>' +
      '<div class="rp-fil" role="group" aria-label="Filtra per stato">' + filtro("tutti", "Tutti", cc.length) + filtro("no", "Sotto soglia", nSotto, "no") + filtro("ok", "In linea", nOk) + filtro("vuoto", "Senza SAL", nSenza) + '</div></div></div>' +
      '<div class="rp-tw"><table class="rp-tab"><thead><tr>' + th("Cantiere", "nome") + th("Ultimo SAL", "sal", 1) + th("Ricavo", "ricavo", 1) + th("Costi", "costi", 1) + th("Margine", "margine", 1) + th("Previsto", "previsto", 1) +
      '<th><span>Stato</span></th></tr></thead><tbody>' + righe + '</tbody></table></div><div class="rp-nessuno" id="rp-vuoto" hidden>Nessun cantiere con questi filtri.</div></section>' : '<p class="rp-nessuno">Nessun cantiere.</p>') +
    '<p class="rp-fonti">' + ICR.info + '<span>Il margine di ogni cantiere si calcola all\'ultimo SAL: ricavo del SAL meno i costi fino alla sua data. Senza SAL, «Costi» è quanto si è speso finora. ' +
    'La barretta mostra il margine; il segno scuro è la soglia. Lo vedono solo le persone della tua impresa con l\'accesso all\'app.</span></p></main>' +
    '<script>' + SCRIPT_RIEPILOGO + '</script></body></html>';
}
const SCRIPT_RIEPILOGO = '(function(){var D=document,tb=D.querySelector(".rp-tab tbody");if(!tb)return;var q=D.getElementById("rp-q"),fil="tutti",vuoto=D.getElementById("rp-vuoto");' +
  'function filtra(){var t=(q.value||"").trim().toLowerCase(),c=0;Array.prototype.forEach.call(tb.rows,function(r){var ok=(fil==="tutti"||r.dataset.stato===fil)&&(!t||r.dataset.nome.indexOf(t)!==-1);r.hidden=!ok;if(ok)c++;});vuoto.hidden=c>0;}' +
  'q.addEventListener("input",filtra);D.querySelectorAll("[data-fil]").forEach(function(b){b.addEventListener("click",function(){fil=b.dataset.fil;D.querySelectorAll("[data-fil]").forEach(function(x){x.setAttribute("aria-pressed",x===b);});filtra();});});' +
  'var ultimo=null,su=true;D.querySelectorAll("[data-ord]").forEach(function(b){b.addEventListener("click",function(){var k=b.dataset.ord;su=ultimo===k?!su:(k==="nome");ultimo=k;' +
  'D.querySelectorAll(".rp-tab th").forEach(function(h){h.removeAttribute("aria-sort");});b.parentNode.setAttribute("aria-sort",su?"ascending":"descending");' +
  'var rr=Array.prototype.slice.call(tb.rows);rr.sort(function(a,c){var x=a.dataset[k],y=c.dataset[k];if(k==="nome")return su?x.localeCompare(y,"it"):y.localeCompare(x,"it");' +
  'var nx=x===""?null:Number(x),ny=y===""?null:Number(y);if(nx===null&&ny===null)return 0;if(nx===null)return 1;if(ny===null)return -1;return su?nx-ny:ny-nx;});rr.forEach(function(r){tb.appendChild(r);});});});' +
  'Array.prototype.forEach.call(tb.rows,function(r){r.addEventListener("click",function(e){if(e.target.closest("a"))return;location.href=r.dataset.href;});});})();';

// ---------------------------------------------------------------------------- stile e script della pagina
const STILE =
  ":root{--navy:#1B2F4A;--cm:#0F766E;--cm-2:#14958A;--cm-s:#0B4F4A;--cm-f:#E6F4F2;--cm-b:#A7D8D1;" +
  "--t:#17212E;--s:#5B6672;--c:#FFFFFF;--z:#F5F7FA;--l:rgba(16,27,43,.11);--ro-f:#FDECEA;--ro:#B3261E;--ro-b:#F2B8B5;" +
  "--ok-f:#E9F6EF;--ok:#146C43;--ok-b:#A8D8BD;--gi-f:#FFF9E6;--gi:#5C4500;--gi-b:#E8D48A;--bl-f:#EEF4FA;--bl-b:#C9D8E8;" +
  "--ombra:0 1px 2px rgba(16,27,43,.05),0 8px 20px -14px rgba(16,27,43,.20),0 0 0 1px rgba(16,27,43,.03)}" +
  "*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-font-smoothing:antialiased}" +
  "body{margin:0;color:var(--t);font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,system-ui,sans-serif;letter-spacing:-.006em;" +
  "background:radial-gradient(1100px 600px at 100% -10%,rgba(15,118,110,.06),transparent 60%),radial-gradient(900px 600px at -10% 0%,rgba(27,47,74,.06),transparent 60%),#F8FAFC}" +
  "main{max-width:960px;margin:0 auto;padding:16px 16px 48px}" +
  "@media screen and (min-width:760px){main{max-width:min(1600px,calc(100vw - 48px));padding:20px 12px 56px}}" +
  "@media screen and (min-width:900px){main{max-width:min(1600px,calc(100vw - 96px))}}" +
  "svg{display:block}a{color:var(--cm-s);font-weight:600}" +
  ".cm-nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}" +
  ".cm-torna{display:inline-block;padding:6px 14px;border-radius:999px;border:1px solid var(--l);background:var(--c);color:var(--navy);font-weight:600;text-decoration:none}" +
  ".cm-card{position:relative;background:var(--c);border-radius:16px;padding:18px 18px 16px;box-shadow:var(--ombra)}" +
  ".cm-card::before{content:\"\";position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#0F766E);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}" +
  ".cm-card.cm-rosso::before{background:linear-gradient(135deg,#1B2F4A,#B3261E)}" +
  ".cm-testa{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:0 0 14px}" +
  ".cm-cant{margin:0;font-size:.88rem;color:var(--s)}" +
  "h1{display:flex;align-items:center;gap:10px;margin:4px 0 0;font-size:1.5rem;letter-spacing:-.02em;color:var(--navy)}" +
  ".cm-ic{flex:none;width:38px;height:38px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#3FB3A6,#14958A 45%,#0B4F4A);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 6px 14px -6px rgba(11,79,74,.65)}" +
  ".cm-ic svg{width:21px;height:21px}" +
  ".cm-prova{display:inline-block;margin:8px 0 0;padding:3px 10px;border:1px dashed var(--cm-b);border-radius:999px;background:var(--cm-f);color:var(--cm-s);font-size:.8rem;font-weight:600}" +
  ".cm-quadro{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 10px}" +
  ".cm-r{position:relative;border:1px solid var(--l);border-radius:14px;padding:12px 14px 12px 16px;background:var(--c);overflow:hidden;display:flex;flex-direction:column;gap:2px}" +
  ".cm-r::before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--navy)}" +
  ".cm-r span{font-size:.82rem;font-weight:700;color:var(--s)}.cm-r b{font-size:1.5rem;line-height:1.25;color:var(--navy);font-variant-numeric:tabular-nums}" +
  ".cm-r small{font-size:.8rem;color:var(--s);line-height:1.4}" +
  ".cm-r.ric::before{background:#7C5CD6}.cm-r.cos::before{background:#D08A1C}.cm-r.mar::before,.cm-r.pre::before{background:var(--cm)}" +
  ".cm-r.mar.ok{background:var(--ok-f);border-color:var(--ok-b)}.cm-r.mar.ok b{color:var(--ok)}" +
  ".cm-r.no{background:var(--ro-f);border-color:var(--ro-b)}.cm-r.no::before{background:var(--ro)}.cm-r.no b{color:var(--ro)}" +
  ".cm-sg{margin:4px 0 8px;font-size:.92rem;color:var(--t)}" +
  ".cm-dopo{margin:0 0 14px;padding:10px 14px;border-radius:12px;border:1px solid var(--bl-b);background:var(--bl-f);font-size:.9rem;line-height:1.5}" +
  ".cm-av{margin:0 0 8px;padding:10px 14px;border-radius:12px;font-size:.88rem;line-height:1.5}" +
  ".cm-av.gi{border:1px solid var(--gi-b);background:var(--gi-f);color:var(--gi)}.cm-av.bl{border:1px solid var(--bl-b);background:var(--bl-f);color:var(--t)}" +
  ".cm-av.ro{border:1px solid var(--ro-b);background:var(--ro-f);color:#7a1c16}" +
  ".cm-tabw{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 12px}" +
  ".cm-tab{width:100%;border-collapse:collapse;font-size:.9rem}.cm-tab th,.cm-tab td{padding:8px 8px;border-bottom:1px solid #E9EDF1;text-align:left;vertical-align:top}" +
  ".cm-tab thead th{font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;color:var(--s);font-weight:700}.cm-tab .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}" +
  ".cm-tab tfoot th,.cm-tab tfoot td{font-weight:800;border-top:2px solid var(--cm-b);border-bottom:0}.cm-tab small{display:block;color:var(--s);font-size:.78rem}" +
  ".cm-tab tr.pz td{background:#FFFBEA}.cm-tab tr.no td{background:var(--ro-f)}.cm-pic{font-size:.84rem}" +
  ".cm-man{font-style:normal;font-size:.72rem;font-weight:800;color:#8A4B00;text-transform:uppercase;letter-spacing:.03em}" +
  ".cm-st{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.78rem;font-weight:700;white-space:nowrap}" +
  ".cm-st.ok{background:var(--ok-f);color:var(--ok);border:1px solid var(--ok-b)}.cm-st.no{background:var(--ro-f);color:var(--ro);border:1px solid var(--ro-b)}.cm-st.gr{background:#F2F4F7;color:#4A5563;border:1px solid #CBD2DA}" +
  ".cm-det{margin:12px 0 0;border:1px solid var(--cm-b);border-radius:14px;background:#fff}" +
  ".cm-det>summary{cursor:pointer;display:flex;justify-content:space-between;gap:10px;padding:12px 14px;font-weight:800;color:var(--navy)}" +
  ".cm-det>summary span{font-weight:700;color:var(--cm-s);font-variant-numeric:tabular-nums}.cm-det[open]>summary{border-bottom:1px solid var(--cm-b)}" +
  ".cm-det-c{padding:10px 14px}.cm-sotto summary{cursor:pointer;font-weight:700;color:var(--cm-s);margin:6px 0}" +
  ".cm-vuoto{margin:4px 0 10px;color:var(--s);font-size:.9rem}.cm-nota{margin:0 0 10px;font-size:.86rem;line-height:1.5;color:var(--s)}" +
  ".cm-az{white-space:nowrap;text-align:right}" +
  ".btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:42px;padding:0 16px;border-radius:12px;border:1px solid var(--navy);background:var(--c);color:var(--navy);font:inherit;font-weight:700;font-size:.92rem;text-decoration:none;white-space:nowrap;cursor:pointer}" +
  ".btn.pr{border-color:var(--cm);color:#fff;background:linear-gradient(180deg,#14958A,#0F766E);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 22px -12px rgba(11,79,74,.8)}" +
  ".btn.pr:disabled{opacity:.6;cursor:wait}.btn.sm{min-height:32px;padding:0 10px;font-size:.82rem;border-radius:10px}.btn.tenue{border-color:rgba(16,27,43,.16);color:var(--t)}" +
  ".btn.togli{border-color:var(--ro-b);color:var(--ro)}.btn.rosso{border-color:var(--ro);color:#fff;background:var(--ro)}" +
  ".btn:hover,.btn:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(15,118,110,.24)}" +
  ".cm-form{margin:14px 0 4px;padding:14px;border:1px solid var(--cm-b);border-radius:14px;background:linear-gradient(180deg,#F2FAF8,#FFFFFF 60%)}" +
  ".cm-form h3,.cm-imp h3{margin:0 0 8px;font-size:1.02rem;color:var(--navy)}" +
  ".cm-imp{margin:22px 0 0;padding:16px;border:1px solid var(--cm-b);border-radius:16px;background:linear-gradient(180deg,#F2FAF8,#FFFFFF 50%)}" +
  ".cm-imp h2{margin:0 0 6px;font-size:1.15rem;color:var(--navy)}.cm-imp h3{margin-top:14px}" +
  ".cm-campi{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 12px;margin:0 0 6px}.cm-campi .l2{grid-column:span 2}" +
  ".cm-campi label,.cm-chi{display:flex;flex-direction:column;gap:4px}.cm-campi span,.cm-chi label,.cm-dlg label{font-size:.84rem;font-weight:700;color:var(--navy)}" +
  ".cm-campi span i{font-style:normal;font-weight:600;color:var(--s)}.cm-campi small{font-size:.76rem;color:var(--s)}" +
  ".cm-campi input,.cm-campi select,.cm-chi input,.cm-dlg input{width:100%;min-height:40px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;background:var(--c);font:inherit;font-size:.92rem;color:var(--t)}" +
  ".cm-campi input.manca,.cm-chi input.manca,.cm-dlg input.manca{border:2px solid var(--ro);background:var(--ro-f)}" +
  ".cm-chi{max-width:420px;margin:8px 0 0}.cm-msg{margin:10px 0 0;font-size:.9rem;font-weight:600;color:var(--ro);min-height:1px}.cm-msg.ok{color:var(--ok)}" +
  ".cm-form-az{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:12px}" +
  ".cm-fonti{margin:20px 0 0;font-size:.82rem;line-height:1.55;color:var(--s)}" +
  ".cm-riep td a{font-weight:700}" +
  // costi-2: bolle e fatture
  ".cm-st.gi{background:var(--gi-f);color:var(--gi);border:1px solid var(--gi-b)}.btn.sec{border-color:var(--cm);color:var(--cm-s);background:var(--cm-f)}" +
  ".cm-h3{margin:18px 0 8px;font-size:1rem;color:var(--navy)}.cm-tenue{color:#8A96A3!important}" +
  ".cm-griglia{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;align-items:start}" +
  ".cm-fa{display:flex;flex-direction:column;gap:4px;padding:12px 14px;border:1px solid var(--l);border-left:4px solid var(--ok);border-radius:14px;background:var(--c)}" +
  ".cm-fa.gi{border-left-color:#D08A1C}.cm-fa-t{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.cm-fa-t h3{margin:0;font-size:1rem;color:var(--navy);overflow-wrap:anywhere}" +
  ".cm-fa-m{margin:0;font-size:.86rem;line-height:1.5;color:var(--s)}.cm-fa-m b{color:var(--t)}" +
  ".cm-conf{margin:4px 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}" +
  ".cm-conf li{padding:5px 9px;border-radius:9px;font-size:.84rem;line-height:1.4}.cm-conf li.ok{background:var(--ok-f);color:var(--ok)}" +
  ".cm-conf li.gi{background:var(--gi-f);color:var(--gi)}.cm-conf li.bl{background:var(--bl-f);color:var(--t)}" +
  ".cm-az-r{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}.cm-bolle td small{display:block}" +
  ".cm-drop{display:flex;align-items:center;gap:10px;padding:14px;margin:0 0 10px;border:2px dashed var(--cm-b);border-radius:14px;background:var(--cm-f);color:var(--cm-s);font-weight:600;cursor:pointer;overflow-wrap:anywhere}" +
  ".cm-drop{flex-wrap:wrap}.cm-drop input{max-width:100%;min-width:0}.cm-drop span{flex:1 1 200px;min-width:0;overflow-wrap:break-word}.cm-drop.ok{border-style:solid;border-color:var(--cm)}" +
  ".cm-ia{margin:0 0 10px;padding:10px 12px;border-radius:12px;border:1px solid var(--gi-b);background:var(--gi-f);font-size:.88rem;line-height:1.5;color:var(--gi)}" +
  ".cm-ia.no{border-color:var(--ro-b);background:var(--ro-f);color:#7a1c16}.cm-ia.at{border-color:var(--cm-b);background:var(--cm-f);color:var(--cm-s)}.cm-ia ul{margin:6px 0 0;padding-left:18px}" +
  ".cm-campi input.ia,.cm-campi select.ia{background:#FFF4C2;border-color:#D9B23C}" +
  ".cm-righe-x{margin:6px 0;font-size:.84rem;color:var(--s)}" +
  ".cm-dlg.cm-dlg-l{max-width:820px}.cm-dlg select{width:100%;min-height:40px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;background:var(--c);font:inherit;font-size:.92rem}" +
  ".cm-b-r{display:grid;grid-template-columns:minmax(0,1.2fr) 110px minmax(0,1.6fr) 110px 36px;gap:8px;align-items:center;margin:8px 0 0}" +
  ".cm-b-r input,.cm-b-r select{width:100%;min-height:38px;padding:0 8px;border:1px solid rgba(16,27,43,.18);border-radius:10px;font:inherit;font-size:.88rem}" +
  ".cm-b-r .imp{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}.cm-b-r .avv{grid-column:1/-1;font-size:.8rem;color:var(--gi)}" +
  ".cm-b-x{min-height:38px;border:1px solid var(--ro-b);border-radius:10px;background:#fff;color:var(--ro);font:inherit;font-weight:800;cursor:pointer}" +
  ".cm-b-tot{margin:12px 0 4px!important;color:var(--t)!important;font-size:.95rem!important}" +
  "@media (max-width:680px){.cm-griglia{grid-template-columns:minmax(0,1fr)}.cm-b-r{grid-template-columns:minmax(0,1fr) minmax(0,1fr);padding:8px;border:1px solid var(--l);border-radius:10px}.cm-b-r .lr{grid-column:1/-1}}" +
  ".cm-dlg{max-width:460px;width:calc(100vw - 32px);border:0;border-radius:16px;padding:18px;box-shadow:0 24px 60px -20px rgba(16,27,43,.45)}" +
  ".cm-dlg::backdrop{background:rgba(16,27,43,.45)}.cm-dlg h3{margin:0 0 8px;color:var(--navy)}.cm-dlg p{margin:0 0 12px;font-size:.9rem;line-height:1.45;color:var(--s)}.cm-dlg form{display:flex;flex-direction:column;gap:6px}" +
  "@media (max-width:900px){.cm-quadro{grid-template-columns:repeat(2,minmax(0,1fr))}.cm-campi{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
  "@media (max-width:640px){main{padding:14px 16px 40px}.cm-card{padding:16px 14px 14px}h1{font-size:1.3rem}.cm-quadro{grid-template-columns:minmax(0,1fr)}" +
  ".cm-campi{grid-template-columns:minmax(0,1fr)}.cm-campi .l2{grid-column:auto}.cm-form-az .btn{flex:1 1 auto}.cm-r b{font-size:1.35rem}" +
  // riepilogo sul telefono: un riquadro per cantiere invece della tabella larga
  ".cm-riep thead{display:none}.cm-riep,.cm-riep tbody,.cm-riep tr{display:block}" +
  ".cm-riep tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;padding:10px 12px;margin:0 0 10px;border:1px solid var(--l);border-radius:12px}" +
  ".cm-riep td{display:block;padding:0;border:0;text-align:left!important;white-space:normal}.cm-riep td:first-child{grid-column:1/-1;font-size:1rem}" +
  ".cm-riep tr.no{background:var(--ro-f);border-color:var(--ro-b)}.cm-riep tr.no td{background:transparent}" +
  ".cm-riep td[data-l]::before,.cm-bolle td[data-l]::before{content:attr(data-l);display:block;font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--s)}" +
  // bolle sul telefono: un riquadro per bolla, fornitore in alto e pulsanti sotto
  ".cm-bolle thead{display:none}.cm-bolle,.cm-bolle tbody{display:block}" +
  ".cm-bolle tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;padding:10px 12px;margin:0 0 10px;border:1px solid var(--l);border-radius:12px}" +
  ".cm-bolle td{display:block;padding:0;border:0;white-space:normal}.cm-bolle td:nth-child(2){grid-column:1/-1;order:-1;font-size:1rem}.cm-bolle td.cm-az{grid-column:1/-1}.cm-bolle td.cm-az:empty{display:none}}";

// costi-3 (MG3): stile del riepilogo di tutti i cantieri (versione moderna 2, scelta da Filippo il 10/11)
const STILE_RIEPILOGO =
  ":root{--navy:#14263D;--cm:#0F766E;--cm-2:#14958A;--cm-s:#0B4F4A;--cm-f:#E8F5F3;--cm-b:#BFE3DD;--t:#101828;--s:#475467;--m:#98A2B3;--l:#EAECF0;--l2:#F2F4F7;--z:#F9FAFB;" +
  "--ro:#D92D20;--ro-t:#B42318;--ro-f:#FEF3F2;--ro-b:#FECDCA;--ok:#067647;--ok-f:#ECFDF3;--ok-b:#ABEFC6;--gr-f:#F2F4F7;--gi:#B54708;--gi-f:#FFFAEB;--gi-b:#FEDF89;" +
  "--om:0 1px 2px rgba(16,24,40,.05);--om2:0 1px 3px rgba(16,24,40,.06),0 18px 36px -24px rgba(16,24,40,.28)}" +
  "*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-font-smoothing:antialiased}body{margin:0;color:var(--t);font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;" +
  "background:#F5F7F9;font-variant-numeric:tabular-nums;letter-spacing:-.005em}" +
  "main{width:min(1280px,calc(100vw - 48px));margin:0 auto;padding:18px 0 56px}" +
  ".rp-nav a{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:10px;color:var(--s);font-size:.88rem;font-weight:600;text-decoration:none}.rp-nav a:hover{background:#fff;color:var(--t)}" +
  // intestazione su fascia
  ".rp-band{position:relative;overflow:hidden;margin:10px 0 18px;padding:22px 24px;border-radius:20px;color:#fff;" +
  "background:radial-gradient(600px 220px at 85% -40%,rgba(255,255,255,.18),transparent 60%),linear-gradient(135deg,#0F766E 0%,#0C5F59 55%,#14263D 100%);box-shadow:0 18px 40px -26px rgba(12,95,89,.75)}" +
  ".rp-band::after{content:'';position:absolute;right:-60px;bottom:-80px;width:260px;height:260px;border-radius:50%;border:1px solid rgba(255,255,255,.12);box-shadow:0 0 0 40px rgba(255,255,255,.03),0 0 0 80px rgba(255,255,255,.02)}" +
  ".rp-band-r{position:relative;z-index:1;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px}" +
  ".rp-band h1{display:flex;align-items:center;gap:14px;margin:0;font-size:1.55rem;font-weight:700;letter-spacing:-.02em}" +
  ".rp-ic{display:inline-flex;align-items:center;justify-content:center;width:46px;height:46px;border-radius:14px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);backdrop-filter:blur(4px)}" +
  ".rp-sub{margin:8px 0 0 60px;color:rgba(255,255,255,.78);font-size:.92rem}.rp-prova{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.25);font-size:.8rem;font-weight:600}" +
  ".rp-prova::before{content:'';width:7px;height:7px;border-radius:50%;background:#5EEAD4;box-shadow:0 0 0 3px rgba(94,234,212,.25)}" +
  // numeri in alto
  ".rp-kpi{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:0 0 16px}" +
  ".rp-k{position:relative;display:flex;flex-direction:column;padding:16px 18px;border-radius:16px;background:#fff;border:1px solid var(--l);box-shadow:var(--om)}" +
  ".rp-k-t{display:flex;align-items:center;gap:10px;font-size:.8rem;font-weight:600;color:var(--s)}" +
  ".rp-k-i{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:var(--cm-f);color:var(--cm);border:1px solid var(--cm-b)}" +
  ".rp-k b{display:block;margin:12px 0 4px;font-size:1.6rem;font-weight:700;letter-spacing:-.025em;color:var(--t)}.rp-k small{display:block;font-size:.8rem;color:var(--m)}" +
  ".rp-k.mg{background:linear-gradient(180deg,#F3FBF9,#fff 70%);border-color:var(--cm-b)}.rp-k.mg b{color:var(--cm)}" +
  ".rp-k.mg.no{background:linear-gradient(180deg,#FFF6F5,#fff 70%);border-color:var(--ro-b)}.rp-k.mg.no b{color:var(--ro-t)}.rp-k.mg.no .rp-k-i{background:var(--ro-f);color:var(--ro-t);border-color:var(--ro-b)}" +
  ".rp-k .rp-bar{width:100%;margin:10px 0 6px}" +
  // avviso
  ".rp-avv{display:flex;align-items:center;gap:12px;margin:0 0 16px;padding:12px 16px;border-radius:14px;background:#fff;border:1px solid var(--ro-b);box-shadow:inset 4px 0 0 var(--ro);color:var(--t);font-size:.92rem}" +
  ".rp-avv-i{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--ro-f);color:var(--ro-t);font-weight:800}.rp-avv b{color:var(--ro-t)}" +
  // tabella
  ".rp-card{border-radius:18px;background:#fff;border:1px solid var(--l);box-shadow:var(--om2);overflow:hidden}" +
  ".rp-tool{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid var(--l)}" +
  ".rp-tool h2{margin:0;font-size:1rem;font-weight:700}.rp-tool h2 span{margin-left:6px;padding:2px 8px;border-radius:999px;background:var(--l2);color:var(--s);font-size:.78rem;font-weight:600}" +
  ".rp-tool-r{display:flex;flex-wrap:wrap;align-items:center;gap:10px}" +
  ".rp-cerca{position:relative;display:flex;align-items:center}.rp-cerca svg{position:absolute;left:10px;color:var(--m);pointer-events:none}" +
  ".rp-cerca input{width:220px;height:36px;padding:0 12px 0 34px;border:1px solid var(--l);border-radius:10px;background:var(--z);font:inherit;font-size:.88rem;color:var(--t)}" +
  ".rp-cerca input:focus{outline:none;border-color:var(--cm-2);background:#fff;box-shadow:0 0 0 3px rgba(20,149,138,.15)}" +
  ".rp-fil{display:inline-flex;padding:3px;border-radius:11px;background:var(--l2);gap:2px}" +
  ".rp-fil button{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border:0;border-radius:8px;background:transparent;font:inherit;font-size:.82rem;font-weight:600;color:var(--s);cursor:pointer}" +
  ".rp-fil button i{font-style:normal;padding:0 6px;border-radius:999px;background:rgba(16,24,40,.06);font-size:.74rem}" +
  ".rp-fil button[aria-pressed=true]{background:#fff;color:var(--t);box-shadow:0 1px 2px rgba(16,24,40,.08),0 0 0 1px rgba(16,24,40,.04)}" +
  ".rp-fil button.no[aria-pressed=true]{color:var(--ro-t)}" +
  ".rp-tab{width:100%;border-collapse:collapse}.rp-tab th{padding:0;background:var(--z);border-bottom:1px solid var(--l);text-align:left;white-space:nowrap}" +
  ".rp-tab th button,.rp-tab th span{display:inline-flex;align-items:center;gap:5px;width:100%;padding:11px 16px;border:0;background:none;font:inherit;font-size:.74rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--s);cursor:pointer}" +
  ".rp-tab th.n button{justify-content:flex-end}.rp-tab th button svg{opacity:.35}.rp-tab th[aria-sort] button{color:var(--t)}.rp-tab th[aria-sort] button svg{opacity:1;color:var(--cm)}" +
  ".rp-tab td{padding:14px 16px;border-bottom:1px solid var(--l2);vertical-align:middle;font-size:.93rem}.rp-tab tr:last-child td{border-bottom:0}" +
  ".rp-tab .n{text-align:right;white-space:nowrap}.rp-tab small{display:block;margin:3px 0 0;font-size:.78rem;color:var(--m)}" +
  ".rp-tab tbody tr{cursor:pointer;transition:background .12s}.rp-tab tbody tr:hover{background:#FAFCFC}" +
  ".rp-tab td:first-child{box-shadow:inset 3px 0 0 transparent}.rp-tab tr.no td:first-child{box-shadow:inset 3px 0 0 var(--ro)}.rp-tab tr.ok td:first-child{box-shadow:inset 3px 0 0 var(--cm-2)}.rp-tab tr.vuoto td:first-child{box-shadow:inset 3px 0 0 #D0D5DD}" +
  ".rp-nome{display:flex;align-items:center;gap:12px;min-width:220px}" +
  ".rp-av{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:11px;background:var(--cm-f);color:var(--cm-s);border:1px solid var(--cm-b);font-size:.82rem;font-weight:700;letter-spacing:.02em}" +
  ".rp-tab tr.no .rp-av{background:var(--ro-f);color:var(--ro-t);border-color:var(--ro-b)}.rp-tab tr.vuoto .rp-av{background:var(--l2);color:var(--s);border-color:var(--l)}" +
  ".rp-nome a{color:var(--t);font-weight:650;text-decoration:none}.rp-tab tr:hover .rp-nome a{color:var(--cm)}" +
  ".rp-vai{color:var(--m);transition:transform .15s,color .15s}.rp-tab tr:hover .rp-vai{color:var(--cm);transform:translateX(2px)}" +
  ".rp-tag{display:inline-block;margin:5px 6px 0 0;padding:2px 8px;border-radius:999px;font-size:.72rem;font-weight:600}.rp-tag.gi{background:var(--gi-f);color:var(--gi);border:1px solid var(--gi-b)}.rp-tag.gr{background:var(--gr-f);color:var(--s)}" +
  ".rp-tab tr.vuoto td{color:var(--m)}.rp-tab tr.vuoto .rp-nome a{color:var(--s)}" +
  // margine con barretta
  ".rp-mg{display:flex;align-items:center;justify-content:flex-end;gap:12px}.rp-mg b{min-width:56px;text-align:right;font-weight:700;font-size:1rem}.rp-mg.no b{color:var(--ro-t)}.rp-mg.ok b{color:var(--cm)}" +
  ".rp-bar{position:relative;display:block;width:120px;height:10px;border-radius:999px;background:var(--l2);box-shadow:inset 0 1px 1px rgba(16,24,40,.06)}" +
  ".rp-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#14958A,#0F766E)}.rp-mg.no .rp-bar i,.rp-k.no .rp-bar i{background:linear-gradient(90deg,#F97066,#D92D20)}" +
  ".rp-bar u{position:absolute;top:-4px;bottom:-4px;width:2px;border-radius:1px;background:var(--navy);opacity:.6}" +
  // stato
  ".rp-st{display:inline-flex;align-items:center;gap:7px;padding:4px 10px;border-radius:999px;font-size:.8rem;font-weight:600;white-space:nowrap;border:1px solid transparent}" +
  ".rp-st::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}.rp-st.ok{background:var(--ok-f);color:var(--ok);border-color:var(--ok-b)}.rp-st.no{background:var(--ro-f);color:var(--ro-t);border-color:var(--ro-b)}.rp-st.gr{background:var(--gr-f);color:var(--s);border-color:var(--l)}" +
  ".rp-nessuno{padding:26px 16px;text-align:center;color:var(--m);font-size:.92rem}" +
  ".rp-fonti{display:flex;align-items:flex-start;gap:10px;margin:14px 0 0;padding:12px 14px;border-radius:14px;background:#fff;border:1px solid var(--l);color:var(--s);font-size:.84rem;line-height:1.5}.rp-fonti svg{flex:0 0 auto;margin-top:1px;color:var(--cm)}" +
  // tablet e telefono
  ".rp-tw{overflow-x:auto}" +
  "@media (max-width:1060px){.rp-kpi{grid-template-columns:repeat(2,minmax(0,1fr))}.rp-cerca input{width:180px}.rp-tab td,.rp-tab th button,.rp-tab th span{padding-left:12px;padding-right:12px}" +
  ".rp-mg .rp-bar{width:72px}.rp-nome{min-width:190px}.rp-av{width:34px;height:34px}}" +
  "@media (max-width:760px){main{width:auto;padding:12px 14px 40px}.rp-band{padding:18px 16px;border-radius:18px}.rp-band h1{font-size:1.2rem;gap:10px}.rp-ic{width:38px;height:38px}.rp-sub{margin-left:0}" +
  ".rp-k{padding:13px 14px}.rp-k b{font-size:1.2rem;margin-top:10px}.rp-k-i{width:30px;height:30px}" +
  ".rp-tool{padding:12px}.rp-tool-r{width:100%}.rp-cerca{flex:1 1 100%}.rp-cerca input{width:100%}.rp-fil{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));width:100%}.rp-fil button{justify-content:center}" +
  ".rp-card{border-radius:16px}.rp-tab thead{display:none}.rp-tab,.rp-tab tbody{display:block}" +
  ".rp-tab tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px;padding:14px;border-bottom:1px solid var(--l2)}.rp-tab tr:last-child{border-bottom:0}" +
  ".rp-tab td{display:block;padding:0;border:0;text-align:left!important}.rp-tab td:first-child{box-shadow:none!important}" +
  ".rp-tab tr.no{box-shadow:inset 3px 0 0 var(--ro)}.rp-tab tr.ok{box-shadow:inset 3px 0 0 var(--cm-2)}.rp-tab tr.vuoto{box-shadow:inset 3px 0 0 #D0D5DD}" +
  ".rp-tab td.rp-tdn,.rp-tab td.rp-tdm,.rp-tab td.rp-tds{grid-column:1/-1}.rp-nome{min-width:0}" +
  ".rp-tab td[data-l]::before{content:attr(data-l);display:block;margin:0 0 2px;font-size:.72rem;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--m)}" +
  ".rp-tab td:nth-child(6){order:4}.rp-tab td:nth-child(6) small{display:none}.rp-tab td.rp-tdm{order:5}.rp-tab td.rp-tds{order:6}.rp-tab td.rp-tdm small{text-align:left!important}" +
  ".rp-mg{justify-content:flex-start}.rp-mg b{min-width:0;text-align:left}.rp-mg .rp-bar{flex:1 1 auto;width:auto}}" +
  ".rp-dx{text-align:right}.rp-tenue{color:var(--m)}";

// costi-3 (MG3): stile della pagina del cantiere, come il riepilogo «versione moderna» scelto da Filippo il 10/11.
// Vale solo con <body class="cm-moderna">: le altre pagine restano come sono.
const CM = ".cm-moderna ";
const STILE_MODERNO =
  ":root{--m:#98A2B3;--l2:#F2F4F7;--ro-t:#B42318;--om:0 1px 2px rgba(16,24,40,.05);--om2:0 1px 3px rgba(16,24,40,.06),0 18px 36px -24px rgba(16,24,40,.28)}" +
  "body.cm-moderna{background:#F5F7F9;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;letter-spacing:-.005em}" +
  CM + "main{width:min(1280px,calc(100vw - 48px));max-width:none;margin:0 auto;padding:18px 0 56px}" +
  CM + ".cm-nav{gap:4px;margin:0 0 4px}" + CM + ".cm-torna{padding:7px 12px;border:0;border-radius:10px;background:transparent;color:#475467;font-size:.88rem}" + CM + ".cm-torna:hover{background:#fff;color:var(--t)}" +
  CM + ".cm-card{padding:0;background:none;box-shadow:none;border-radius:0}" + CM + ".cm-card::before{display:none}" +
  // fascia in alto
  CM + ".cm-band{position:relative;overflow:hidden;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;margin:10px 0 18px;padding:22px 24px;border-radius:20px;color:#fff;" +
  "background:radial-gradient(600px 220px at 85% -40%,rgba(255,255,255,.18),transparent 60%),linear-gradient(135deg,#0F766E 0%,#0C5F59 55%,#14263D 100%);box-shadow:0 18px 40px -26px rgba(12,95,89,.75)}" +
  CM + ".cm-band::after{content:'';position:absolute;right:-60px;bottom:-80px;width:260px;height:260px;border-radius:50%;border:1px solid rgba(255,255,255,.12);box-shadow:0 0 0 40px rgba(255,255,255,.03),0 0 0 80px rgba(255,255,255,.02);pointer-events:none}" +
  CM + ".cm-band>*{position:relative;z-index:1}" + CM + ".cm-band h1{margin:0;gap:14px;font-size:1.55rem;font-weight:700;color:#fff}" +
  CM + ".cm-band .cm-ic{width:46px;height:46px;border-radius:14px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);box-shadow:none}" +
  CM + ".cm-band .cm-cant{margin:8px 0 0 60px;color:rgba(255,255,255,.82);font-size:.98rem;font-weight:600}" +
  CM + ".cm-band .cm-prova{display:inline-flex;align-items:center;gap:7px;margin:0;padding:6px 12px;border:1px solid rgba(255,255,255,.25);border-radius:999px;background:rgba(255,255,255,.14);color:#fff;font-size:.8rem;font-weight:600}" +
  CM + ".cm-band .cm-prova::before{content:'';width:7px;height:7px;border-radius:50%;background:#5EEAD4;box-shadow:0 0 0 3px rgba(94,234,212,.25)}" +
  // quattro riquadri
  CM + ".cm-quadro{gap:14px;margin:0 0 14px}" +
  CM + ".cm-r{gap:0;padding:16px 18px;border:1px solid #EAECF0;border-radius:16px;background:#fff;box-shadow:var(--om)}" + CM + ".cm-r::before{display:none}" +
  CM + ".cm-r .cm-r-t{display:flex;align-items:center;gap:10px;font-size:.8rem;font-weight:600;color:#475467}" +
  CM + ".cm-r .cm-r-i{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:var(--cm-f);color:var(--cm);border:1px solid var(--cm-b)}" +
  CM + ".cm-r b{margin:12px 0 4px;font-size:1.6rem;font-weight:700;letter-spacing:-.025em;line-height:1.2;color:var(--t)}" + CM + ".cm-r small{color:var(--m)}" +
  CM + ".cm-r.mar.ok{background:linear-gradient(180deg,#F3FBF9,#fff 70%);border-color:var(--cm-b)}" + CM + ".cm-r.mar.ok b{color:var(--cm)}" +
  CM + ".cm-r.no{background:linear-gradient(180deg,#FFF6F5,#fff 70%);border-color:#FECDCA}" + CM + ".cm-r.no b{color:var(--ro-t)}" + CM + ".cm-r.no .cm-r-i{background:#FEF3F2;color:var(--ro-t);border-color:#FECDCA}" +
  ".cm-bar{position:relative;display:block;height:10px;border-radius:999px;background:var(--l2);box-shadow:inset 0 1px 1px rgba(16,24,40,.06)}" +
  ".cm-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#14958A,#0F766E)}.cm-r.no .cm-bar i{background:linear-gradient(90deg,#F97066,#D92D20)}" +
  ".cm-bar u{position:absolute;top:-4px;bottom:-4px;width:2px;border-radius:1px;background:#14263D;opacity:.6}" + CM + ".cm-r .cm-bar{width:100%;margin:8px 0 6px}" +
  // spese generali e «in attesa del prossimo SAL»
  CM + ".cm-sg{margin:0 0 12px;padding:12px 16px;border:1px solid #EAECF0;border-radius:14px;background:#fff;box-shadow:var(--om)}" +
  CM + ".cm-dopo{position:relative;margin:0 0 14px;padding:14px 16px 14px 54px;border:1px solid #EAECF0;border-radius:14px;background:#fff;box-shadow:inset 4px 0 0 #2E90FA,var(--om);line-height:1.55}" +
  CM + ".cm-dopo::before{content:'';position:absolute;left:16px;top:14px;width:26px;height:26px;border-radius:50%;background:#EFF8FF url(\"data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%23175CD3%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%3E%3Ccircle%20cx=%2712%27%20cy=%2712%27%20r=%279%27/%3E%3Cpath%20d=%27M12%207v5l3%202%27/%3E%3C/svg%3E\") center/16px no-repeat}" +
  CM + ".cm-dopo b{color:#175CD3}" +
  // dove vanno i costi
  CM + ".cm-costi{margin:0 0 14px;border:1px solid #EAECF0;border-radius:18px;background:#fff;box-shadow:var(--om2);overflow:hidden}" +
  CM + ".cm-sez{margin:0;padding:14px 16px;border-bottom:1px solid #EAECF0;font-size:1rem;font-weight:700;color:var(--t)}" + CM + ".cm-costi .cm-tabw{margin:0}" +
  CM + ".cm-tab th," + CM + ".cm-tab td{padding:12px 16px;border-bottom:1px solid var(--l2);vertical-align:middle}" +
  CM + ".cm-tab thead th{background:#F9FAFB;font-weight:600;color:#475467;border-bottom:1px solid #EAECF0}" + CM + ".cm-tab tbody th{font-weight:600}" +
  CM + ".cm-tab tfoot th," + CM + ".cm-tab tfoot td{border-top:1px solid #EAECF0;background:#FCFCFD;font-weight:700}" +
  ".cm-quota{display:block;width:140px;max-width:100%;height:6px;margin:7px 0 3px;border-radius:999px;background:var(--l2);overflow:hidden}.cm-quota i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#14958A,#0F766E)}" +
  CM + ".cm-costi .cm-tab small{color:var(--m);font-weight:500}" +
  // avvisi
  CM + ".cm-av{position:relative;margin:0 0 10px;padding:12px 16px 12px 50px;border:1px solid #EAECF0;border-radius:14px;background:#fff;color:var(--t);box-shadow:var(--om)}" +
  CM + ".cm-av::before{position:absolute;left:14px;top:11px;width:24px;height:24px;border-radius:50%;font:800 13px/24px system-ui;text-align:center}" +
  CM + ".cm-av.gi{box-shadow:inset 4px 0 0 #F79009,var(--om)}" + CM + ".cm-av.gi::before{content:'!';background:#FFFAEB;color:#B54708}" + CM + ".cm-av.gi b{color:#B54708}" +
  CM + ".cm-av.bl{box-shadow:inset 4px 0 0 #2E90FA,var(--om)}" + CM + ".cm-av.bl::before{content:'i';background:#EFF8FF;color:#175CD3}" + CM + ".cm-av.bl b{color:#175CD3}" +
  CM + ".cm-av.ro{border-color:#FECDCA;box-shadow:inset 4px 0 0 #D92D20,var(--om)}" + CM + ".cm-av.ro::before{content:'!';background:#FEF3F2;color:var(--ro-t)}" + CM + ".cm-av.ro b{color:var(--ro-t)}" +
  // sezioni che si aprono
  CM + ".cm-det{margin:14px 0 0;border:1px solid #EAECF0;border-radius:16px;background:#fff;box-shadow:var(--om);overflow:hidden}" +
  CM + ".cm-det>summary{list-style:none;justify-content:flex-start;align-items:center;gap:12px;padding:15px 18px;font-weight:700;color:var(--t)}" + CM + ".cm-det>summary::-webkit-details-marker{display:none}" +
  CM + ".cm-det>summary::before{content:'';flex:0 0 auto;width:8px;height:8px;margin:0 4px 0 2px;border-right:2px solid var(--m);border-bottom:2px solid var(--m);transform:rotate(-45deg);transition:transform .15s}" +
  CM + ".cm-det[open]>summary::before{transform:rotate(45deg)}" + CM + ".cm-det>summary span{margin-left:auto;color:var(--cm-s)}" +
  CM + ".cm-det>summary:hover{background:#FAFCFC}" + CM + ".cm-det[open]>summary{border-bottom:1px solid #EAECF0;background:#FCFCFD}" + CM + ".cm-det-c{padding:14px 18px}" +
  // costi della tua impresa, moduli, fonti
  CM + ".cm-imp{margin:22px 0 0;padding:20px;border:1px solid #EAECF0;border-radius:18px;background:#fff;box-shadow:var(--om2)}" +
  CM + ".cm-form{border:1px solid #EAECF0;border-radius:14px;background:#F9FAFB}" +
  CM + ".cm-campi input," + CM + ".cm-campi select," + CM + ".cm-chi input{border-color:#D0D5DD;border-radius:10px}" + CM + ".cm-campi input:focus," + CM + ".cm-campi select:focus," + CM + ".cm-chi input:focus{outline:none;border-color:var(--cm-2);box-shadow:0 0 0 3px rgba(20,149,138,.15)}" +
  CM + ".btn{border-radius:10px}" + CM + ".cm-fonti{padding:12px 14px;border:1px solid #EAECF0;border-radius:14px;background:#fff;color:#475467}" +
  "@media (max-width:760px){" + CM + "main{width:auto;padding:12px 14px 40px}" + CM + ".cm-band{padding:18px 16px;border-radius:18px}" + CM + ".cm-band h1{font-size:1.2rem;gap:10px}" +
  CM + ".cm-band .cm-ic{width:38px;height:38px}" + CM + ".cm-band .cm-cant{margin-left:0}" + CM + ".cm-quadro{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px}" +
  CM + ".cm-r{padding:13px 14px}" + CM + ".cm-r b{font-size:1.2rem!important;margin-top:10px}" + CM + ".cm-r .cm-r-i{width:30px;height:30px}" + CM + ".cm-r .cm-r-t{font-size:.74rem;gap:8px}" +
  CM + ".cm-tab th," + CM + ".cm-tab td{padding:10px 12px}" +
  CM + ".cm-costi .cm-tab{font-size:.84rem}" + CM + ".cm-costi .cm-tab th," + CM + ".cm-costi .cm-tab td{padding:10px 8px}" + CM + ".cm-costi .cm-tab th:first-child{padding-left:12px}" +
  CM + ".cm-costi .cm-tab thead th{white-space:normal;font-size:.66rem;letter-spacing:.02em}" + CM + ".cm-costi .cm-tab .n:last-child{padding-right:12px}" + CM + ".cm-costi .cm-quota{width:84px}" +
  CM + ".cm-dopo{padding-left:48px}" + CM + ".cm-dopo::before{left:12px}" + CM + ".cm-det>summary{padding:13px 14px}" + CM + ".cm-imp{padding:16px 14px}}";

const SCRIPT = String.raw`(function(){try{
var D=document;function $(i){return D.getElementById(i);}
function leggiChi(){try{return localStorage.getItem('tix_pg_chi')||'';}catch(e){return '';}}
function scriviChi(v){try{if(v)localStorage.setItem('tix_pg_chi',v);}catch(e){}}
function numero(s){s=String(s==null?'':s).replace(/\s| |€/g,'');if(!s)return '';if(s.indexOf(',')!==-1)s=s.replace(/\./g,'').replace(',','.');else if(/^-?\d{1,3}(\.\d{3})+$/.test(s))s=s.replace(/\./g,'');return /^-?\d{1,9}(\.\d{1,4})?$/.test(s)?s:null;}
function invia(az,dati){return fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:az,dati:dati})}).then(function(r){return r.json();});}
function chiDi(id,msg){var el=$(id);var v=(el.value||'').trim();el.classList.toggle('manca',!v);if(!v){msg.className='cm-msg';msg.textContent='Scrivi il tuo nome: resta registrato chi ha fatto la modifica.';return '';}scriviChi(v);return v;}
['cm-f-chi','cm-v-chi','cm-t-chi'].forEach(function(i){var el=$(i);if(el&&!el.value)el.value=leggiChi();});
// costi della tua impresa: una richiesta per ogni voce cambiata
var vs=$('cm-v-salva');if(vs)vs.addEventListener('click',function(){var msg=$('cm-v-msg');var chi=chiDi('cm-v-chi',msg);if(!chi)return;
var dal=$('cm-v-dal').value||'';var lav=[],bad=false;
Array.prototype.forEach.call(D.querySelectorAll('[data-voce]'),function(i){var v=i.value.trim();if(v===(i.getAttribute('data-prima')||''))return;var x=numero(v);i.classList.toggle('manca',x===null);if(x===null){bad=true;return;}lav.push(['costo_impresa',{voce:i.getAttribute('data-voce'),valore:x,valido_dal:dal,autore:chi}]);});
Array.prototype.forEach.call(D.querySelectorAll('[data-mezzo]'),function(i){var v=i.value.trim();if(v===(i.getAttribute('data-prima')||''))return;var x=numero(v);i.classList.toggle('manca',x===null);if(x===null){bad=true;return;}lav.push(['costo_mezzo',{mezzo_id:i.getAttribute('data-mezzo'),costo:x,valido_dal:dal,autore:chi}]);});
if(bad){msg.className='cm-msg';msg.textContent='Scrivi i numeri così: 32,50 (euro) oppure 12 (percentuale).';return;}
if(!lav.length){msg.className='cm-msg';msg.textContent='Non hai cambiato niente.';return;}
vs.disabled=true;msg.className='cm-msg ok';msg.textContent='Salvo…';
(function prossimo(k){if(k>=lav.length){msg.textContent='Salvato.';location.reload();return;}invia(lav[k][0],lav[k][1]).then(function(r){if(r&&r.esito==='ok')return prossimo(k+1);vs.disabled=false;msg.className='cm-msg';msg.textContent=(r&&r.messaggio)||'Non sono riuscito a salvare: riprova.';}).catch(function(){vs.disabled=false;msg.className='cm-msg';msg.textContent='Il servizio non risponde: riprova tra un minuto.';});})(0);});
// costi a mano: aggiungi, modifica, togli
var fs=$('cm-f-salva');
function svuota(){$('cm-f-id').value='';$('cm-f-tit').textContent='Aggiungi un costo';$('cm-f-annulla').hidden=true;fs.textContent='Salva il costo';['cm-f-imp','cm-f-descr','cm-f-forn','cm-f-num'].forEach(function(i){$(i).value='';});}
if(fs)fs.addEventListener('click',function(){var msg=$('cm-f-msg');var chi=chiDi('cm-f-chi',msg);if(!chi)return;
var imp=numero($('cm-f-imp').value),descr=$('cm-f-descr').value.trim(),dt=$('cm-f-data').value;
$('cm-f-imp').classList.toggle('manca',!imp);$('cm-f-descr').classList.toggle('manca',!descr);$('cm-f-data').classList.toggle('manca',!dt);
if(!imp||!descr||!dt){msg.className='cm-msg';msg.textContent='Servono la data, che cosa è e l’importo + IVA (per esempio 1.234,50).';return;}
fs.disabled=true;msg.className='cm-msg ok';msg.textContent='Salvo…';
invia('manuale_salva',{id:$('cm-f-id').value,data:dt,categoria:$('cm-f-cat').value,fornitore:$('cm-f-forn').value.trim(),descrizione:descr,numero:$('cm-f-num').value.trim(),importo:imp,autore:chi}).then(function(r){
if(r&&r.esito==='ok'){msg.textContent='Salvato.';location.hash='manuali';location.reload();return;}fs.disabled=false;msg.className='cm-msg';msg.textContent=(r&&r.messaggio)||'Non sono riuscito a salvare: riprova.';}).catch(function(){fs.disabled=false;msg.className='cm-msg';msg.textContent='Il servizio non risponde: riprova tra un minuto.';});});
var an=$('cm-f-annulla');if(an)an.addEventListener('click',svuota);
function voceM(id){for(var i=0;i<CFG.manuali.length;i++){if(CFG.manuali[i].id===id)return CFG.manuali[i];}return null;}
Array.prototype.forEach.call(D.querySelectorAll('[data-mod]'),function(b){b.addEventListener('click',function(){var x=voceM(b.getAttribute('data-mod'));if(!x)return;
$('cm-f-id').value=x.id;$('cm-f-data').value=x.data||'';$('cm-f-cat').value=x.categoria;$('cm-f-forn').value=x.fornitore||'';$('cm-f-descr').value=x.descrizione||'';$('cm-f-num').value=x.numero||'';
$('cm-f-imp').value=String(x.importo==null?'':x.importo).replace('.',',');$('cm-f-tit').textContent='Modifica il costo';$('cm-f-annulla').hidden=false;fs.textContent='Salva la modifica';$('cm-f').scrollIntoView({behavior:'smooth',block:'center'});});});
var dlg=$('cm-t-dlg'),daTogliere='';
Array.prototype.forEach.call(D.querySelectorAll('[data-tog]'),function(b){b.addEventListener('click',function(){var x=voceM(b.getAttribute('data-tog'));if(!x)return;daTogliere=x.id;
$('cm-t-txt').textContent='«'+x.descrizione+'»: resta registrato come tolto, con il tuo nome.';$('cm-t-msg').textContent='';if(dlg.showModal)dlg.showModal();else dlg.setAttribute('open','');});});
var ts=$('cm-t-si');if(ts)ts.addEventListener('click',function(){var msg=$('cm-t-msg');var chi=chiDi('cm-t-chi',msg);if(!chi)return;ts.disabled=true;
invia('manuale_togli',{id:daTogliere,motivo:$('cm-t-mot').value.trim(),autore:chi}).then(function(r){if(r&&r.esito==='ok'){location.hash='manuali';location.reload();return;}ts.disabled=false;msg.className='cm-msg';msg.textContent=(r&&r.messaggio)||'Non sono riuscito a toglierlo: riprova.';}).catch(function(){ts.disabled=false;msg.className='cm-msg';msg.textContent='Il servizio non risponde: riprova tra un minuto.';});});
// ---------------------------------------------------------------- costi-2: fatture dei fornitori e bolle
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function esa(buf){return Array.prototype.map.call(new Uint8Array(buf),function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
function nIt(v){if(v===null||v===undefined||v==='')return '';var x=Number(v);if(!isFinite(x))return '';return String(Math.round(x*10000)/10000).replace('.',',');}
function eur(v){var x=Number(v);if(!isFinite(x))return '—';var s=Math.abs(x).toFixed(2).split('.');return (x<0?'−':'')+s[0].replace(/\B(?=(\d{3})+(?!\d))/g,'.')+','+s[1]+' €';}
function dIt(iso){return /^\d{4}-\d{2}-\d{2}/.test(iso||'')?iso.slice(8,10)+'/'+iso.slice(5,7)+'/'+iso.slice(0,4):'';}
function dIso(s){s=String(s||'').trim();if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);var m=s.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);if(!m)return '';var a=Number(m[3]);if(a<100)a+=2000;return a+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[1]).slice(-2);}
function mbx(n){n=Number(n)||0;return n>=1048576?(Math.round(n/104857.6)/10).toString().replace('.',',')+' MB':Math.max(1,Math.round(n/1024))+' KB';}
function nomeD(s){return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\./g,'').replace(/\b(srls?|spa|snc|sas|soc|societa|coop|cooperativa|unipersonale)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim();}
function stessa(a,b){var x=nomeD(a),y=nomeD(b);if(!x||!y)return false;return x===y||(x.length>=5&&y.length>=5&&(x.indexOf(y)!==-1||y.indexOf(x)!==-1));}
function parole(s){return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().split(/[^a-z0-9\/]+/).filter(function(w){return w.length>=2;});}
function simile(descr,righe){var a={};parole(descr).forEach(function(w){a[w]=1;});var m=null,pt=0;(righe||[]).forEach(function(r){var b=parole(r.descrizione);if(!b.length)return;var c=b.filter(function(w){return a[w];}).length;var p=c/b.length;if(c&&p>pt){pt=p;m=r;}});return pt>=0.5?m:null;}
function unitaN(u){var s=String(u||'').toLowerCase().replace(/[\s.]/g,'');if(/^(m3|mc|m³)$/.test(s))return 'm3';if(/^(m2|mq|m²)$/.test(s))return 'm2';if(/^(kg)$/.test(s))return 'kg';if(/^(t|ton|tonnellate?)$/.test(s))return 't';if(/^(h|ora|ore)$/.test(s))return 'ora';if(/^(n|nr|pz|pezzi|cad)$/.test(s))return 'cad';return s;}
['cm-x-chi','cm-b-chi','cm-fm-chi','cm-t2-chi'].forEach(function(i){var el=$(i);if(el&&!el.value)el.value=leggiChi();});
var DOC=null,FAT={righe:[],ddt:[]},LETTURA=0;
function boxX(cls,html){var b=$('cm-x-ia');if(!b)return;b.hidden=!html;b.className='cm-ia'+(cls?' '+cls:'');b.innerHTML=html||'';}
function metti(id,v){var el=$(id);if(!el||v===undefined||v===null||String(v)==='')return;el.value=v;el.classList.add('ia');}
['cm-x-forn','cm-x-piva','cm-x-num','cm-x-data','cm-x-tipo','cm-x-imp','cm-x-iva','cm-x-tot','cm-x-quota','cm-x-comp','cm-x-ddt'].forEach(function(i){var el=$(i);if(el){el.addEventListener('input',function(){el.classList.remove('ia');});el.addEventListener('change',function(){el.classList.remove('ia');});}});
// testo dell'XML con la codifica dichiarata (UTF-8 o ISO-8859-1)
function testoDaByte(u8){var t=String.fromCharCode.apply(null,Array.prototype.slice.call(u8.subarray(0,300)));var m=t.match(/encoding=["']([A-Za-z0-9_-]+)["']/);var enc=m?m[1].toLowerCase():'utf-8';try{return new TextDecoder(enc).decode(u8);}catch(e){return new TextDecoder('utf-8').decode(u8);}}
// .xml.p7m: busta CMS (binaria o in base64); il contenuto è un OCTET STRING, anche spezzato in pezzi (codifica BER)
function daP7m(u8){
  if(u8[0]!==0x30){try{var s=new TextDecoder('latin1').decode(u8).replace(/-----[^-]*-----/g,'').replace(/[^A-Za-z0-9+\/=]/g,'');var bin=atob(s);var x=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)x[i]=bin.charCodeAt(i);u8=x;}catch(e){return null;}}
  var cand=[];
  function lun(p){var l=u8[p];if(l<0x80)return [l,p+1];if(l===0x80)return [-1,p+1];var nb=l&0x7f,v=0;for(var k=0;k<nb;k++)v=v*256+u8[p+1+k];return [v,p+1+nb];}
  function giro(pos,fine,acc,prof){
    while(pos<fine){
      if(prof>40)return fine;
      var tag=u8[pos];
      if(tag===0&&u8[pos+1]===0)return pos+2;
      var p=pos+1;if((tag&0x1f)===0x1f){while(p<fine&&(u8[p]&0x80))p++;p++;}
      var ll=lun(p),len=ll[0];p=ll[1];
      if(tag&0x20){
        var mio=tag===0x24?[]:null;var fineC=len<0?fine:Math.min(fine,p+len);
        var dopo=giro(p,fineC,mio||acc,prof+1);
        if(mio){var tot=0;mio.forEach(function(a){tot+=a.length;});var buf=new Uint8Array(tot),o=0;mio.forEach(function(a){buf.set(a,o);o+=a.length;});if(acc)acc.push(buf);else cand.push(buf);}
        pos=len<0?dopo:p+len;
      }else{
        if(len<0||p+len>u8.length)return fine;
        var dati=u8.subarray(p,p+len);if(tag===0x04){if(acc)acc.push(dati);else cand.push(dati);}
        pos=p+len;
      }
    }
    return pos;
  }
  try{giro(0,u8.length,null,0);}catch(e){return null;}
  var meglio=null;
  cand.forEach(function(c){if(c.length<50)return;if(/FatturaElettronica/.test(testoDaByte(c))&&(!meglio||c.length>meglio.length))meglio=c;});
  return meglio;
}
// fattura elettronica (tracciato FatturaPA) → campi del modulo
function leggiXml(txt){
  var doc;try{doc=new DOMParser().parseFromString(txt,'application/xml');}catch(e){return null;}
  if(!doc||doc.getElementsByTagName('parsererror').length)return null;
  function tutti(el,n){return el?Array.prototype.slice.call(el.getElementsByTagNameNS('*',n)):[];}
  function uno(el,n){var a=tutti(el,n);return a.length?a[0]:null;}
  function t(el,n){var x=uno(el,n);return x?String(x.textContent||'').trim():'';}
  if(!uno(doc,'FatturaElettronicaBody'))return null;
  var ced=uno(doc,'CedentePrestatore'),an=uno(ced,'Anagrafica');
  var forn=t(an,'Denominazione')||(t(an,'Nome')+' '+t(an,'Cognome')).trim();
  var piva=t(uno(ced,'IdFiscaleIVA'),'IdCodice')||t(uno(ced,'DatiAnagrafici'),'CodiceFiscale');
  var corpi=tutti(doc,'FatturaElettronicaBody'),b=corpi[0],dg=uno(b,'DatiGeneraliDocumento');
  var righe=tutti(b,'DettaglioLinee').map(function(l){return{n:t(l,'NumeroLinea'),descrizione:t(l,'Descrizione'),quantita:t(l,'Quantita'),unita:t(l,'UnitaMisura'),prezzo:t(l,'PrezzoUnitario'),importo:t(l,'PrezzoTotale'),ddt:''};});
  var imp=0,iva=0,haR=false;tutti(b,'DatiRiepilogo').forEach(function(r){var a=Number(t(r,'ImponibileImporto')),c=Number(t(r,'Imposta'));if(isFinite(a)){imp+=a;haR=true;}if(isFinite(c))iva+=c;});
  if(!haR)righe.forEach(function(r){var x=Number(r.importo);if(isFinite(x))imp+=x;});
  var ddt=tutti(b,'DatiDDT').map(function(x){var num=t(x,'NumeroDDT'),dat=t(x,'DataDDT');tutti(x,'RiferimentoNumeroLinea').forEach(function(rl){var k=String(rl.textContent||'').trim();righe.forEach(function(r){if(r.n===k)r.ddt=num;});});return{numero:num,data:dIso(dat)};}).filter(function(x){return x.numero;});
  var tot=Number(t(dg,'ImportoTotaleDocumento'));
  return{fornitore:forn,partita_iva:piva,numero:t(dg,'Numero'),data:dIso(t(dg,'Data')),tipo:t(dg,'TipoDocumento')==='TD04'?'nota_credito':'fattura',
    imponibile:String(Math.round(Math.abs(imp)*100)/100),iva:String(Math.round(Math.abs(iva)*100)/100),totale:String(Math.round(Math.abs(isFinite(tot)&&tot?tot:imp+iva)*100)/100),
    righe:righe.map(function(r){return{descrizione:r.descrizione,quantita:r.quantita,unita:r.unita,prezzo:r.prezzo,importo:r.importo,ddt:r.ddt};}),ddt:ddt,corpi:corpi.length,dubbi:[],mancano:[]};
}
function ddtTesto(l){return (l||[]).map(function(x){return x.numero+(x.data?' del '+dIt(x.data):'');}).join('; ');}
function ddtDaTesto(s){return String(s||'').split(/[;\n]+/).map(function(x){x=x.trim();if(!x)return null;var num=x.split(/\s+del\s+|\s+/)[0];return{numero:num,data:dIso(x.slice(num.length))};}).filter(function(x){return x&&x.numero;});}
function riempi(p){
  Array.prototype.forEach.call(D.querySelectorAll('#cm-x .ia'),function(el){el.classList.remove('ia');});
  metti('cm-x-forn',p.fornitore);metti('cm-x-piva',p.partita_iva);metti('cm-x-num',p.numero);metti('cm-x-data',p.data);
  var tp=$('cm-x-tipo');if(p.tipo){tp.value=p.tipo;tp.classList.add('ia');}
  metti('cm-x-imp',nIt(p.imponibile));metti('cm-x-iva',nIt(p.iva));metti('cm-x-tot',nIt(p.totale));$('cm-x-quota').value='';
  FAT.righe=p.righe||[];FAT.ddt=p.ddt||[];metti('cm-x-ddt',ddtTesto(FAT.ddt));
  var ult='';FAT.ddt.forEach(function(x){if(x.data&&x.data>ult)ult=x.data;});metti('cm-x-comp',ult||p.data);
  var rr=$('cm-x-righe');rr.hidden=!FAT.righe.length;rr.textContent=FAT.righe.length?'Righe lette: '+FAT.righe.length+'. Si vedono nella scheda della fattura dopo il salvataggio, con il confronto.':'';
}
function unisci(js,u8){var l=new TextEncoder().encode(String(js.length).padStart(8,'0'));var b=new Uint8Array(8+js.length+u8.length);b.set(l,0);b.set(js,8);b.set(u8,8+js.length);return b;}
function scegliFattura(f){
  var msg=$('cm-x-msg');msg.textContent='';boxX('','');DOC=null;FAT={righe:[],ddt:[]};
  if(f.size>CFG.max){boxX('no','Il file è troppo grande: in TIX una fattura arriva fino a '+CFG.maxMb+' MB.');return;}
  var est=((f.name.match(/\.([A-Za-z0-9]{1,5})$/)||[])[1]||'').toLowerCase();
  if(['xml','p7m','pdf'].indexOf(est)===-1){boxX('no','Carica la fattura elettronica (.xml o .xml.p7m) oppure il PDF.');return;}
  var mio=++LETTURA;
  f.arrayBuffer().then(function(ab){return crypto.subtle.digest('SHA-256',ab).then(function(h){return{u8:new Uint8Array(ab),sha:esa(h)};});}).then(function(x){
    if(mio!==LETTURA)return;
    DOC={nome:f.name,byte:x.u8.length,sha:x.sha,bytes:x.u8};
    $('cm-x-scegli').textContent=f.name+' ('+mbx(f.size)+')';$('cm-x-drop').classList.add('ok');$('cm-x-resto').hidden=false;
    if(est==='xml'||est==='p7m'){
      var src=est==='p7m'?daP7m(x.u8):x.u8;var p=src?leggiXml(testoDaByte(src)):null;
      if(!p){boxX('no','Non riesco a leggere questa fattura elettronica: controlla il file, oppure compila i campi a mano.');return;}
      riempi(p);var av=[];if(p.corpi>1)av.push('Il file contiene '+p.corpi+' fatture: TIX ha letto la prima. Le altre caricale a parte.');if(!p.ddt.length)av.push('La fattura non cita bolle: «Conta dal» è la data della fattura.');
      boxX('','<b>Fattura elettronica letta: controlla i campi in giallo e salva.</b>'+(av.length?'<ul><li>'+av.map(esc).join('</li><li>')+'</li></ul>':''));
    }else{
      if(!CFG.ia){boxX('at','Compila i campi guardando il PDF, oppure carica l’XML della fattura elettronica: si legge da solo, gratis.');return;}
      boxX('at','TIX sta leggendo la fattura (10–30 secondi)…');
      var js=new TextEncoder().encode(JSON.stringify({t:CFG.t,c:CFG.c,nome:f.name,byte:x.u8.length,sha256:x.sha}));
      fetch(CFG.ul,{method:'POST',body:unisci(js,x.u8)}).then(function(r){return r.json();}).then(function(j){
        if(mio!==LETTURA)return;
        if(j&&j.esito==='ok'&&j.proposta){var pp=j.proposta;riempi(pp);var l=(pp.dubbi||[]).slice();if((pp.mancano||[]).length)l.unshift('Non trovati nel documento: '+pp.mancano.join(', ')+'.');
          boxX('','<b>TIX ha letto la fattura: controlla i campi in giallo e salva.</b>'+(l.length?'<ul><li>'+l.map(esc).join('</li><li>')+'</li></ul>':''));}
        else boxX('no',esc((j&&j.messaggio)||'Non sono riuscito a leggere la fattura: compila i campi a mano.'));
      }).catch(function(){if(mio===LETTURA)boxX('no','La lettura automatica non risponde: compila i campi a mano.');});
    }
  });
}
var fx=$('cm-x-file');if(fx)fx.addEventListener('change',function(){var f=fx.files&&fx.files[0];if(f)scegliFattura(f);});
var xs=$('cm-x-salva');if(xs)xs.addEventListener('click',function(){
  var msg=$('cm-x-msg');if(!DOC){msg.className='cm-msg';msg.textContent='Scegli prima il file della fattura.';return;}
  var chi=chiDi('cm-x-chi',msg);if(!chi)return;
  var imp=numero($('cm-x-imp').value),iva=numero($('cm-x-iva').value),tot=numero($('cm-x-tot').value),quota=numero($('cm-x-quota').value);
  var obb=[['cm-x-forn',$('cm-x-forn').value.trim()],['cm-x-num',$('cm-x-num').value.trim()],['cm-x-data',$('cm-x-data').value],['cm-x-imp',imp]];
  var bad=false;obb.forEach(function(k){var ok=!!k[1];$(k[0]).classList.toggle('manca',!ok);if(!ok)bad=true;});
  if(bad||iva===null||tot===null||quota===null){msg.className='cm-msg';msg.textContent='Servono fornitore, numero, data e imponibile; i numeri si scrivono così: 1.234,50.';return;}
  xs.disabled=true;msg.className='cm-msg ok';msg.textContent='Salvo…';
  var dati={t:CFG.t,c:CFG.c,nome:DOC.nome,byte:DOC.byte,sha256:DOC.sha,fornitore:$('cm-x-forn').value.trim(),partita_iva:$('cm-x-piva').value.trim(),numero:$('cm-x-num').value.trim(),
    data:$('cm-x-data').value,tipo:$('cm-x-tipo').value,categoria:$('cm-x-cat').value,imponibile:imp,iva:iva||'',totale:tot||'',importo_cantiere:quota||'',competenza:$('cm-x-comp').value,
    note:$('cm-x-note').value.trim(),autore:chi,righe:FAT.righe,ddt:ddtDaTesto($('cm-x-ddt').value)};
  fetch(CFG.uc,{method:'POST',body:unisci(new TextEncoder().encode(JSON.stringify(dati)),DOC.bytes)}).then(function(r){return r.json();}).then(function(j){
    if(j&&j.esito==='ok'){msg.textContent='Salvata.';location.hash='fornitori';location.reload();return;}
    xs.disabled=false;msg.className='cm-msg';msg.textContent=(j&&j.messaggio)||'Non sono riuscito a salvare la fattura: riprova.';
  }).catch(function(){xs.disabled=false;msg.className='cm-msg';msg.textContent='Il servizio non risponde: riprova tra un minuto.';});
});
// stima di una bolla con l'offerta accettata
var BOL=null,bdlg=$('cm-b-dlg');
function bolla(id){for(var i=0;i<CFG.bolle.length;i++){if(String(CFG.bolle[i].ddt_id)===String(id))return CFG.bolle[i];}return null;}
function offerta(id){for(var i=0;i<CFG.offerte.length;i++){if(CFG.offerte[i].id===id)return CFG.offerte[i];}return null;}
function righeDaBolla(b){var m=String(b.materiale||'').split(';'),q=String(b.quantita||'').split(';'),k=Math.max(m.length,q.length),out=[];for(var i=0;i<k;i++){var qq=(q[i]||'').trim(),mm=qq.match(/(\d[\d.]*(?:,\d+)?)\s*([A-Za-z²³\/]+)?/);out.push({descrizione_ddt:(m[i]||'').trim(),quantita:mm?mm[1]:'',unita:mm&&mm[2]?mm[2]:''});}return out;}
function rigaB(r,off){
  var d=D.createElement('div');d.className='cm-b-r';
  var sel='<select class="lr" aria-label="Voce dell’offerta">'+'<option value="">— voce dell’offerta —</option>'+(off?off.righe:[]).map(function(x){return '<option value="'+x.id+'">'+esc(x.descrizione)+' · '+esc(eur(x.prezzo))+(x.unita?'/'+esc(x.unita):'')+'</option>';}).join('')+'</select>';
  d.innerHTML='<input class="lr" placeholder="Materiale della bolla" aria-label="Materiale della bolla" maxlength="200"><input placeholder="Quantità" aria-label="Quantità" inputmode="decimal"><span class="lr">'+sel+'</span><span class="imp">—</span><button type="button" class="cm-b-x" title="Togli la riga" aria-label="Togli la riga">×</button><span class="avv"></span>';
  var i=d.querySelectorAll('input'),s=d.querySelector('select');i[0].value=r.descrizione_ddt||'';i[1].value=r.quantita?nIt(numero(r.quantita)):'';d.dataset.unita=r.unita||'';
  if(r.unita){i[1].placeholder='Quantità ('+r.unita+')';i[1].setAttribute('aria-label','Quantità in '+r.unita);}
  var scelta=r.offerta_riga_id?String(r.offerta_riga_id):'';if(!scelta&&off){var sm=simile(r.descrizione_ddt,off.righe);if(sm)scelta=String(sm.id);}s.value=scelta;
  function conto(){var q=numero(i[1].value),rr=null;(off?off.righe:[]).forEach(function(x){if(String(x.id)===s.value)rr=x;});var im=d.querySelector('.imp'),av=d.querySelector('.avv');
    im.textContent=q&&rr?eur(Number(q)*Number(rr.prezzo)):'—';av.textContent=rr&&d.dataset.unita&&unitaN(d.dataset.unita)!==unitaN(rr.unita)?'Unità diverse: bolla in '+d.dataset.unita+', offerta in '+(rr.unita||'?')+'. Controlla la quantità.':'';totaleB();}
  i[1].addEventListener('input',conto);s.addEventListener('change',conto);d.querySelector('.cm-b-x').addEventListener('click',function(){d.parentNode.removeChild(d);totaleB();});
  $('cm-b-righe').appendChild(d);conto();
}
function totaleB(){var t=0,ok=false;Array.prototype.forEach.call(D.querySelectorAll('#cm-b-righe .cm-b-r'),function(d){var q=numero(d.querySelectorAll('input')[1].value),s=d.querySelector('select').value,off=offerta($('cm-b-off').value);if(!q||!s||!off)return;off.righe.forEach(function(x){if(String(x.id)===s){t+=Number(q)*Number(x.prezzo);ok=true;}});});$('cm-b-tot').textContent=ok?eur(t):'—';}
function apriBolla(b){
  BOL=b;$('cm-b-msg').textContent='';$('cm-b-txt').textContent='Bolla n. '+(b.numero||'—')+' di '+(b.fornitore||'—')+(b.materiale?': '+b.materiale:'')+(b.quantita?' ('+b.quantita+')':'');
  var opz=CFG.offerte.filter(function(o){return stessa(o.fornitore,b.fornitore);});if(!opz.length)opz=CFG.offerte;
  var so=$('cm-b-off');so.innerHTML=opz.map(function(o){return '<option value="'+o.id+'">'+esc(o.fornitore)+' · '+esc(o.materiale)+(o.numero?' n. '+esc(o.numero):'')+'</option>';}).join('');
  if(b.stima&&b.stima.offerta_id&&offerta(b.stima.offerta_id))so.value=b.stima.offerta_id;
  function disegna(){$('cm-b-righe').innerHTML='';var off=offerta(so.value);var rr=b.stima&&b.stima.offerta_id===so.value&&b.stima.righe.length?b.stima.righe.map(function(x){return{descrizione_ddt:x.descrizione_ddt,quantita:String(x.quantita),unita:x.unita,offerta_riga_id:x.offerta_riga_id};}):righeDaBolla(b);rr.forEach(function(r){rigaB(r,off);});totaleB();}
  so.onchange=disegna;disegna();if(bdlg.showModal)bdlg.showModal();else bdlg.setAttribute('open','');
}
Array.prototype.forEach.call(D.querySelectorAll('[data-bprezza]'),function(x){x.addEventListener('click',function(){var b=bolla(x.getAttribute('data-bprezza'));if(b)apriBolla(b);});});
var bpiu=$('cm-b-piu');if(bpiu)bpiu.addEventListener('click',function(){rigaB({descrizione_ddt:'',quantita:'',unita:''},offerta($('cm-b-off').value));});
var bsi=$('cm-b-si');if(bsi)bsi.addEventListener('click',function(){var msg=$('cm-b-msg');var chi=chiDi('cm-b-chi',msg);if(!chi||!BOL)return;var righe=[],bad=false;
  Array.prototype.forEach.call(D.querySelectorAll('#cm-b-righe .cm-b-r'),function(d){var i=d.querySelectorAll('input'),q=numero(i[1].value),s=d.querySelector('select').value;if(!q&&!s)return;if(!q||!s){bad=true;return;}righe.push({descrizione_ddt:i[0].value.trim(),quantita:q,unita:d.dataset.unita||'',offerta_riga_id:s});});
  if(bad||!righe.length){msg.className='cm-msg';msg.textContent='Per ogni riga servono la quantità e la voce dell’offerta.';return;}
  bsi.disabled=true;invia('bolla_stima',{ddt_id:String(BOL.ddt_id),offerta_id:$('cm-b-off').value,righe:righe,autore:chi}).then(function(r){if(r&&r.esito==='ok'){location.hash='fornitori';location.reload();return;}bsi.disabled=false;msg.className='cm-msg';msg.textContent=(r&&r.messaggio)||'Non sono riuscito a salvare: riprova.';}).catch(function(){bsi.disabled=false;msg.className='cm-msg';msg.textContent='Il servizio non risponde: riprova tra un minuto.';});});
// modifica e togli di fatture e stime
var fdlg=$('cm-fm-dlg'),FMOD=null;
function fattura(id){for(var i=0;i<CFG.fatture.length;i++){if(CFG.fatture[i].id===id)return CFG.fatture[i];}return null;}
Array.prototype.forEach.call(D.querySelectorAll('[data-fmod]'),function(x){x.addEventListener('click',function(){var f=fattura(x.getAttribute('data-fmod'));if(!f)return;FMOD=f;
  $('cm-fm-txt').textContent=f.fornitore+', fattura n. '+f.numero+': imponibile '+eur(f.imponibile)+'.';$('cm-fm-quota').value=nIt(f.importo_cantiere);$('cm-fm-comp').value=f.competenza||'';$('cm-fm-cat').value=f.categoria;$('cm-fm-note').value=f.note||'';$('cm-fm-msg').textContent='';
  if(fdlg.showModal)fdlg.showModal();else fdlg.setAttribute('open','');});});
var fsi=$('cm-fm-si');if(fsi)fsi.addEventListener('click',function(){var msg=$('cm-fm-msg');var chi=chiDi('cm-fm-chi',msg);if(!chi||!FMOD)return;var q=numero($('cm-fm-quota').value);if(!q){msg.className='cm-msg';msg.textContent='Scrivi la quota del cantiere, per esempio 1.234,50.';return;}
  fsi.disabled=true;invia('fattura_modifica',{id:FMOD.id,importo_cantiere:q,competenza:$('cm-fm-comp').value,categoria:$('cm-fm-cat').value,note:$('cm-fm-note').value.trim(),autore:chi}).then(function(r){if(r&&r.esito==='ok'){location.hash='fornitori';location.reload();return;}fsi.disabled=false;msg.className='cm-msg';msg.textContent=(r&&r.messaggio)||'Non sono riuscito a salvare: riprova.';}).catch(function(){fsi.disabled=false;msg.className='cm-msg';msg.textContent='Il servizio non risponde: riprova tra un minuto.';});});
var t2=$('cm-t2-dlg'),T2=null;
function apriT2(az,id,tit,txt){T2={az:az,id:id};$('cm-t2-tit').textContent=tit;$('cm-t2-txt').textContent=txt;$('cm-t2-msg').textContent='';if(t2.showModal)t2.showModal();else t2.setAttribute('open','');}
Array.prototype.forEach.call(D.querySelectorAll('[data-ftog]'),function(x){x.addEventListener('click',function(){var f=fattura(x.getAttribute('data-ftog'));if(f)apriT2('fattura_togli',f.id,'Togli la fattura','Fattura n. '+f.numero+' di '+f.fornitore+': resta registrata come tolta, con il tuo nome. Le bolle che cita tornano «stimate» o «senza prezzo».');});});
Array.prototype.forEach.call(D.querySelectorAll('[data-btog]'),function(x){x.addEventListener('click',function(){apriT2('bolla_togli',x.getAttribute('data-btog'),'Togli la stima','La stima della bolla non conta più; resta registrata come tolta, con il tuo nome.');});});
var t2si=$('cm-t2-si');if(t2si)t2si.addEventListener('click',function(){var msg=$('cm-t2-msg');var chi=chiDi('cm-t2-chi',msg);if(!chi||!T2)return;t2si.disabled=true;
  invia(T2.az,{id:T2.id,motivo:$('cm-t2-mot').value.trim(),autore:chi}).then(function(r){if(r&&r.esito==='ok'){location.hash='fornitori';location.reload();return;}t2si.disabled=false;msg.className='cm-msg';msg.textContent=(r&&r.messaggio)||'Non sono riuscito: riprova.';}).catch(function(){t2si.disabled=false;msg.className='cm-msg';msg.textContent='Il servizio non risponde: riprova tra un minuto.';});});
if(location.hash){var t=D.querySelector(location.hash);if(t&&t.tagName==='DETAILS')t.open=true;}
}catch(e){}})();`;

// ---------------------------------------------------------------------------- per il banco di prova
export function costiPaginaProva(base, h, p, d) { return pagina(base, h, p, d, base + "/?t=" + p.tok + "&c=" + p.c, base + "/?t=" + p.tok); }
export function costiRiepilogoProva(base, h, p, d) { return riepilogo(base, h, p, d, base + "/?t=" + p.tok); }
