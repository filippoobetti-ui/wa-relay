// ============================================================================
// PREVENTIVI — area riservata (03/11/2026, preventivi-1, chat 02B). Pulsante «Preventivi» nell'elenco dei cantieri
// (portale_azioni_html) e nella riga dei pulsanti del cantiere. Preventivi per i lavori extra di un cantiere e per i lavori
// nuovi senza cantiere. Le voci si prendono dall'elenco prezzi del contratto (computo della sezione SAL), dal prezzario
// regionale (Veneto 2026, caricato da TIX) o si scrivono a mano; il ribasso del contratto vale anche per le voci del
// prezzario e si può togliere nel singolo preventivo. Un preventivo mandato non si riscrive: ogni modifica è una revisione
// nuova, con la sua fotografia e l'impronta SHA-256 nel database. Decisioni di Filippo del 03/11/2026; colore oliva-ottone.
//   GET  /preventivi?t=<gettone>[&a=<impresa>][&c=<cantiere>][&id=<preventivo>]   → pagina (elenco, oppure il preventivo)
//   POST /preventivi/api  {t, a, c, azione, dati}   → lista | dati | cerca | estesa | nuovo | intestazione | voce | togli_voce |
//                                                      sposta_voce | manda | revisione | accettato | rifiutato | annulla_esito | elimina
//   GET  /preventivi/stampa?t&id[&rev]              → foglio da stampare o salvare in PDF
//   GET  /preventivi/excel?t&id[&rev][&formato=csv] → file Excel .xlsx con la grafica B (preventivi-excel-1); formato=csv → il CSV di prima
//   POST /preventivi/firmato?t&id&nome              → copia firmata (corpo = il file, .pdf o .p7m)
//   GET  /preventivi/firmato?t&id                   → scarica la copia firmata
// «Prepara con TIX» (03/11/2026, preventivi-ia-1; nome e logo TIX da preventivi-tix-1): nella bozza si allegano file o link
// (computo in Excel o, dal 06/11/2026, in PDF stampato da PriMus; tavole e relazioni in PDF); la funzione preventivo-ia li legge e TIX, con l'intelligenza artificiale,
// compila le voci, segnate verde / giallo / rosso, da controllare. Dal 03/11 sera (preventivi-pdf-1) relazioni e tavole le legge
// Claude in PDF: la funzione non li apre più (ogni sua chiamata ha ~2 secondi di calcolo). Dal 04/11 (preventivi-appr-1) si
// sceglie anche la lettura «Normale» o «Approfondita» (voce per voce: prezzo adeguato con il calcolo, analisi del prezzo,
// confronto con i prezzi dell'impresa, controllo finale), ognuna con il suo costo.
//   POST /preventivi/api  azione ia_dati | ia_nuova | ia_lavoro | ia_link | ia_tipo_file | ia_togli_file | ia_controlla |
//                         ia_parti | ia_annulla | ia_conferma | ia_scegli | ia_conferma_verdi | ia_togli_ia
//   POST /preventivi/ia/file?t&id&nome              → un file per la lettura (corpo = il file, Excel o PDF, fino a 18 MB)
// Dal 04/11/2026 (preventivi-computo-1, errori E1–E7 di Filippo sul computo di Studio 54): voci con super-categoria e categoria
// del computo e i loro totali, stato (NP / da quotare / da verificare), capitolo «Extra computo» fuori dal totale, controlli
// prima di mandare (preventivo_dati.controlli), scelta «Sostituisci / Integra» quando ci sono voci di una lettura di prima.
// Interruttori: impostazioni.preventivi_attiva (no / prova = solo Filippo / si) e PREVENTIVI = "off" nel Worker;
// per «Prepara con TIX» anche impostazioni.preventivi_ia_attiva (no / prova / si).
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FILE = 18 * 1024 * 1024;
const AZIONI = new Set(["nuovo", "intestazione", "voce", "togli_voce", "sposta_voce", "manda", "revisione", "accettato", "rifiutato",
  "annulla_esito", "elimina"]);
const AZIONI_IA = new Set(["nuova", "lavoro", "link", "tipo_file", "togli_file", "controlla", "parti", "annulla", "conferma", "scegli",
  "conferma_verdi", "togli_ia", "ricontrolla"]);
// file per «Prepara con TIX»: estensione → tipo del contenuto e prime cifre del file
const FILE_IA = {
  pdf: ["application/pdf", [0x25, 0x50, 0x44, 0x46]],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", [0x50, 0x4b]],
  xlsm: ["application/vnd.ms-excel.sheet.macroEnabled.12", [0x50, 0x4b]],
  ods: ["application/vnd.oasis.opendocument.spreadsheet", [0x50, 0x4b]],
  xls: ["application/vnd.ms-excel", [0xd0, 0xcf]],
  csv: ["text/csv", []],
};

function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: {
    "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
function testo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function gettone(x) { const m = String(x || "").match(/[0-9a-fA-F]{64}/); return m ? m[0].toLowerCase() : ""; }
function uuid(x) { const a = String(x || "").toLowerCase().trim(); return UUID.test(a) ? a : ""; }
function supabaseUrl(env) { return env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co"; }
function casuale() { return Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => x.toString(16).padStart(2, "0")).join(""); }

// 08/11/2026 (preventivi-offerte-1): campi delle richieste di offerta e dell'email al DL
function pulisciOf(d) {
  const x = d && typeof d === "object" ? d : {};
  const o = {};
  const testi = { id: 36, rdo_id: 36, ch_id: 36, riga_id: 20, contatto_id: 20, destinatario: 200, tipo: 20, email_a: 2200, email_cc: 2200,
    email_impresa: 1200, oggetto: 200, testo: 30000, note: 2000, data: 10, n: 6, posta_id: 36 };
  for (const k of Object.keys(testi)) if (k in x) o[k] = testo(x[k], testi[k]);
  if (Array.isArray(x.voci)) o.voci = x.voci.slice(0, 200).map((v) => testo(v, 20));
  if (Array.isArray(x.prezzi)) o.prezzi = x.prezzi.slice(0, 200).map((p) => ({ voce_id: testo(p && p.voce_id, 20), prezzo: testo(p && p.prezzo, 20), note: testo(p && p.note, 500) }));
  return o;
}

// solo i campi che il database conosce, già accorciati
function pulisci(d) {
  const x = d && typeof d === "object" ? d : {};
  const o = {};
  const testi = { id: 36, commessa_id: 36, voce_id: 20, titolo: 200, cliente_nome: 200, cliente_indirizzo: 300, cliente_piva: 40,
    cliente_email: 200, indirizzo_lavoro: 300, note: 2000, validita_giorni: 6, oneri_sicurezza: 20, sconto: 20, prezzario_id: 6,
    fonte: 12, rif: 60, codice: 60, descrizione: 6000, unita: 20, prezzo: 20, quantita: 20, verso: 4, data: 10, chi: 200, nota: 500,
    lavoro: 1000, link: 600, tipo: 12, modalita: 8, profondita: 12, scrittura: 12, file_id: 20, alt: 3 };
  for (const k of Object.keys(testi)) if (k in x) o[k] = testo(x[k], testi[k]);
  if ("ribasso_applicato" in x) o.ribasso_applicato = x.ribasso_applicato === true || x.ribasso_applicato === "true";
  if ("leggi" in x) o.leggi = x.leggi === true || x.leggi === "true";
  if ("conferma_tetto" in x) o.conferma_tetto = x.conferma_tetto === true || x.conferma_tetto === "true";
  // 09/11/2026 (crediti-1, chat 02B): conferma in crediti di «Prepara con TIX»
  if ("conferma_crediti" in x) o.conferma_crediti = x.conferma_crediti === true || x.conferma_crediti === "true";
  // 05/11/2026 (preventivi-rilettura-1): «Rifai con gli stessi file»
  if ("riprendi" in x) o.riprendi = x.riprendi === true || x.riprendi === "true";
  // 05/11/2026 (preventivi-ricontrollo-1): «Ricontrolla le voci» parte solo con conferma = true (prima la stima del costo)
  if ("conferma" in x) o.conferma = x.conferma === true || x.conferma === "true";
  // 06/11/2026 (preventivi-computo-2): fino a 200 righe, «dove» fino a 300 caratteri e la quantità scritta (q) delle righe senza
  // parti e dimensioni, come «Vedi voce n. …» nei computi di PriMus
  if (Array.isArray(x.misure)) {
    o.misure = x.misure.slice(0, 200).map((r) => ({ dove: testo(r && r.dove, 300), parti: testo(r && r.parti, 14), lun: testo(r && r.lun, 14),
      lar: testo(r && r.lar, 14), alt: testo(r && r.alt, 14), q: testo(r && r.q, 20) }));
  }
  return o;
}

// ---------------------------------------------------------------------------- pulsante nel cantiere
export async function preventiviPulsante(env, token, commessa) {
  if (!env || !env.SUPABASE_SERVICE_KEY || env.PREVENTIVI === "off") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(supabaseUrl(env) + "/rest/v1/rpc/preventivi_pulsante", {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_token: token, p_commessa: commessa }), signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === "object" && j.esito === "ok" && j.attiva === true ? { attiva: true } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Quinto pulsante della riga dei pulsanti del cantiere (la riga la compone economie.js, riga()); da solo, se la riga non c'è,
// va sotto le schede come «Sicurezza».
export function preventiviIniezione(base, token, commessa) {
  const u = base + "/preventivi?t=" + token + "&c=" + encodeURIComponent(commessa);
  const icona = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 2.8H7a2.2 2.2 0 0 0-2.2 2.2v14a2.2 2.2 0 0 0 2.2 2.2h10a2.2 2.2 0 0 0 2.2-2.2V8z"/><path d="M14 2.8V8h5.2"/>' +
    '<path d="M14.6 12.3a2.9 2.9 0 1 0 0 4.4"/><path d="M8.6 13.7h4.2M8.6 15.4h4.2"/></svg>';
  return "<style>.gl-pv-barra{max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right}" +
    ".gl-pv-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 16px;border:1.5px solid #66741C;border-radius:10px;background:#F3F5E6;color:#4A5512;font:inherit;font-size:.92rem;font-weight:700;text-decoration:none;box-shadow:0 0 0 3px rgba(102,116,28,.14)}" +
    ".gl-pv-b:hover,.gl-pv-b:focus-visible{background:#66741C;color:#fff;outline:none}" +
    "@media (prefers-color-scheme:dark){.gl-pv-b{background:#262b10;color:#e3e8bf;border-color:#8C9B33}}</style>" +
    "<script>(function(){try{var a=document.createElement('a');a.className='gl-pv-b';a.href=" + JSON.stringify(u) + ";a.innerHTML=" + JSON.stringify(icona + " Preventivi") + ";" +
    "var r=document.querySelector('.gl-azioni');if(r){r.appendChild(a);var n=r.children.length;r.classList.toggle('gl-az4',n===4);r.classList.toggle('gl-az5',n>=5);return;}" +
    "var b=document.createElement('div');b.className='gl-pv-barra';b.appendChild(a);var nav=document.querySelector('nav.schede');" +
    "if(nav&&nav.parentNode){nav.parentNode.insertBefore(b,nav.nextSibling);}else{document.body.insertBefore(b,document.body.firstChild);}}catch(e){}})();</script>";
}

// ---------------------------------------------------------------------------- rotte
export async function portalePreventivi(request, env, base, inUrl, h) {
  if (env.PREVENTIVI === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");
  if (sotto === "/preventivi/api") return api(request, env, h);
  if (sotto === "/preventivi/stampa") return stampa(request, env, base, inUrl, h);
  if (sotto === "/preventivi/excel") return excel(request, env, base, inUrl, h);
  if (sotto === "/preventivi/firmato") return request.method === "POST" ? caricaFirmato(request, env, inUrl, h) : scaricaFirmato(request, env, base, inUrl, h);
  if (sotto === "/preventivi/ia/file") return caricaFileIa(request, env, inUrl, h);
  if (sotto === "/preventivi/posta/file") return scaricaPosta(request, env, base, inUrl, h); // 08/11/2026 (preventivi-posta-1)
  if (sotto !== "/preventivi") return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const tok = gettone(inUrl.searchParams.get("t"));
  if (!tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const a = uuid(inUrl.searchParams.get("a"));
  const c = uuid(inUrl.searchParams.get("c"));
  const id = uuid(inUrl.searchParams.get("id"));
  const torna = base + "/?t=" + tok + (c ? "&c=" + c : "");
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna ai cantieri</a></p>';
  const d = id
    ? await h.rpc(env, "preventivo_dati", { p_token: tok, p_id: id, p_revisione: 0 }, 15000).catch(() => null)
    : await h.rpc(env, "preventivi_portale", { p_token: tok, p_azienda: a, p_commessa: c }, 15000).catch(() => null);
  if (!d) return h.risposta(h.foglio(base, "Preventivi", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito === "non_trovato") return h.risposta(h.foglio(base, "Preventivi", "Preventivo non trovato.", indietro), 404);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Preventivi", "Questa pagina non è ancora disponibile.", indietro), 404);
  return h.risposta(pagina(base, h, tok, a, c, id, d, torna));
}

async function api(request, env, h) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  if (Number(request.headers.get("Content-Length") || 0) > 300000) return json({ esito: "errore", messaggio: "Richiesta troppo grande." }, 413);
  let b = null;
  try { b = await request.json(); } catch (e) { b = null; }
  const tok = gettone(b && b.t), a = uuid(b && b.a), c = uuid(b && b.c), az = String(b && b.azione || "");
  if (!tok) return json({ esito: "gettone" }, 400);
  const dati = pulisci(b && b.dati);
  let r = null;
  if (az === "lista") r = await h.rpc(env, "preventivi_portale", { p_token: tok, p_azienda: a, p_commessa: c }, 15000).catch(() => null);
  else if (az === "dati" && UUID.test(dati.id || "")) {
    const rev = Math.max(0, Math.min(999, parseInt(String(b.dati && b.dati.rev || 0), 10) || 0));
    r = await h.rpc(env, "preventivo_dati", { p_token: tok, p_id: dati.id, p_revisione: rev }, 15000).catch(() => null);
  } else if (az === "cerca" && UUID.test(dati.id || "")) {
    const fonte = ["", "contratto", "prezzario", "elementari"].indexOf(String(b.dati && b.dati.fonte || "")) >= 0 ? String(b.dati.fonte || "") : "";
    r = await h.rpc(env, "preventivo_cerca", { p_token: tok, p_id: dati.id, p_testo: testo(b.dati && b.dati.testo, 120), p_fonte: fonte }, 15000).catch(() => null);
  } else if (az === "estesa" && UUID.test(dati.id || "")) {
    r = await h.rpc(env, "preventivo_estesa", { p_token: tok, p_id: dati.id, p_rif: dati.rif || "" }, 10000).catch(() => null);
  } else if ((az.startsWith("of_") || az.startsWith("ch_") || az.startsWith("cp_") || az.startsWith("po_")) && UUID.test(String(b && b.dati && b.dati.id || ""))) {
    // 08/11/2026 (preventivi-offerte-1): richieste di offerta ed email al Direttore dei Lavori
    const dof = pulisciOf(b.dati);
    // 08/11/2026 (preventivi-risposta-1): cp_* = proposte lette dalla risposta del DL
    // 08/11/2026 (preventivi-posta-1): po_* = email ricevute su posta.tixcantiere.it
    r = await h.rpc(env, az.startsWith("of_") ? "preventivo_offerte" : az.startsWith("cp_") ? "preventivo_risposta" : az.startsWith("po_") ? "preventivo_posta" : "preventivo_chiarimenti",
      { p_token: tok, p_id: dof.id, p_azione: az.slice(3), p_dati: dof }, 15000).catch(() => null);
  } else if ((az === "pc_stato" || az === "pc_apri" || az === "pc_collega") && UUID.test(dati.id || "")) {
    // 09/11/2026 (cantiere-da-preventivo-1, chat 02B): preventivo accettato → apri o collega il cantiere, «Cosa manca»
    r = await h.rpc(env, "preventivo_cantiere", { p_token: tok, p_id: dati.id, p_azione: az.slice(3),
      p_dati: { commessa_id: UUID.test(dati.commessa_id || "") ? dati.commessa_id : "" } }, 15000).catch(() => null);
  } else if (az === "cr_saldo" || az === "cr_compra" || az === "cr_bonifico") {
    // 09/11/2026 (crediti-1, chat 02B): Crediti TIX (saldo e movimenti, compra con carta, richiesta con bonifico)
    const pac = String(b && b.dati && b.dati.pacchetto || "");
    r = await h.rpc(env, "crediti_azione", { p_token: tok, p_azienda: a, p_azione: az.slice(3),
      p_dati: { pacchetto: ["5", "20", "50"].indexOf(pac) >= 0 ? pac : "" } }, 15000).catch(() => null);
  } else if (AZIONI.has(az)) {
    r = await h.rpc(env, "preventivo_azione", { p_token: tok, p_azienda: a, p_azione: az, p_dati: dati }, 15000).catch(() => null);
  } else if (az === "ia_dati" && UUID.test(dati.id || "")) {
    r = await h.rpc(env, "preventivo_ia_dati", { p_token: tok, p_id: dati.id }, 15000).catch(() => null);
  } else if (az.startsWith("ia_") && AZIONI_IA.has(az.slice(3)) && UUID.test(dati.id || "")) {
    r = await h.rpc(env, "preventivo_ia_azione", { p_token: tok, p_id: dati.id, p_azione: az.slice(3), p_dati: dati }, 15000).catch(() => null);
    // un file tolto dalla lettura non serve più nell'archivio (solo se è davvero un file temporaneo di «Prepara con TIX»)
    if (r && r.esito === "ok" && az === "ia_togli_file" && /^preventivi\/[0-9a-f-]{36}\/ia\/[0-9a-f-]{36}\/[^/]+$/.test(String(r.percorso || ""))) {
      await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + String(r.percorso).split("/").map(encodeURIComponent).join("/"), {
        method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
    }
  } else return json({ esito: "errore" }, 400);
  return json(r || { esito: "errore" }, r ? 200 : 503);
}

// ---------------------------------------------------------------------------- pagina
function pagina(base, h, tok, a, c, id, d, torna) {
  const e = h.esc;
  const cfg = JSON.stringify({ u: base + "/preventivi/api", pagina: base + "/preventivi", stampa: base + "/preventivi/stampa",
    excel: base + "/preventivi/excel", firmato: base + "/preventivi/firmato", ia: base + "/preventivi/ia/file", t: tok, a: a, c: c, id: id, d: d, torna: torna })
    .replace(/</g, "\\u003c");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>Preventivi - TIX · Diario di cantiere</title>" + h.testa(base) +
    "<style>" + STILE + STILE_IA + STILE_OF + "</style></head><body><main id=\"pv-main\">" +
    (id
      ? '<a class="pv-torna" href="' + e(base + "/preventivi?t=" + tok + (a ? "&a=" + a : "") + (c ? "&c=" + c : "")) + '">‹ Tutti i preventivi</a>'
      : '<a class="pv-torna" href="' + e(torna) + '">‹ ' + (c ? "Torna al cantiere" : "Torna ai cantieri") + "</a>") +
    '<div id="pv-app"><p class="pv-carica">Un momento…</p></div>' +
    "</main>" + MODALI +
    "<script>" + SCRIPT.replace("__CFG__", cfg) + "</script><script>" +
    SCRIPT_OF.replace("__CFG__", JSON.stringify({ u: base + "/preventivi/api", pf: base + "/preventivi/posta/file", t: tok, a: a, c: c, id: id }).replace(/</g, "\\u003c")) + "</script></body></html>";
}

const ICONA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M14 2.8H7a2.2 2.2 0 0 0-2.2 2.2v14a2.2 2.2 0 0 0 2.2 2.2h10a2.2 2.2 0 0 0 2.2-2.2V8z"/><path d="M14 2.8V8h5.2"/>' +
  '<path d="M14.6 12.3a2.9 2.9 0 1 0 0 4.4"/><path d="M8.6 13.7h4.2M8.6 15.4h4.2"/></svg>';

const MODALI =
  // nuovo preventivo
  '<div class="pv-velo" id="pv-v-nuovo" hidden><div class="pv-mod" role="dialog" aria-modal="true" aria-labelledby="pv-n-t">' +
  '<h2 id="pv-n-t">Nuovo preventivo</h2>' +
  '<div class="pv-campi">' +
  '<label class="pv-c tutta"><span class="pv-et">Per quale cantiere</span><select id="pv-n-cant"></select></label>' +
  '<label class="pv-c tutta"><span class="pv-et">Che lavoro è</span><input id="pv-n-titolo" maxlength="200" placeholder="es. Nuovo vano porta e massetto al piano terra"></label>' +
  '<label class="pv-c"><span class="pv-et">Cliente <small>dalla Rubrica o scritto qui</small></span><input id="pv-n-cliente" maxlength="200" list="pv-rubrica" autocomplete="off"></label>' +
  '<label class="pv-c"><span class="pv-et">Dove si fa il lavoro</span><input id="pv-n-dove" maxlength="300"></label>' +
  '<label class="pv-c"><span class="pv-et">Email del cliente <small>facoltativo</small></span><input id="pv-n-email" maxlength="200" inputmode="email"></label>' +
  '<label class="pv-c"><span class="pv-et">Partita IVA o codice fiscale <small>facoltativo</small></span><input id="pv-n-piva" maxlength="40"></label>' +
  "</div>" +
  '<p class="pv-msg" id="pv-n-msg" aria-live="polite"></p>' +
  '<div class="pv-az"><button type="button" class="pv-b pv-pr" id="pv-n-crea">Crea il preventivo</button><button type="button" class="pv-b" data-chiudi>Annulla</button></div>' +
  '</div></div><datalist id="pv-rubrica"></datalist>' +
  // voce
  '<div class="pv-velo" id="pv-v-voce" hidden><div class="pv-mod largo" role="dialog" aria-modal="true" aria-labelledby="pv-vo-t">' +
  '<h2 id="pv-vo-t">Voce</h2><p class="pv-vo-fonte" id="pv-vo-fonte"></p>' +
  '<div class="pv-campi">' +
  '<label class="pv-c" id="pv-vo-c-cod"><span class="pv-et">Codice <small>facoltativo</small></span><input id="pv-vo-cod" maxlength="60"></label>' +
  '<label class="pv-c" id="pv-vo-c-um"><span class="pv-et">Unità di misura</span><input id="pv-vo-um" maxlength="20" placeholder="m², m, cad, a corpo…"></label>' +
  '<label class="pv-c tutta"><span class="pv-et">Descrizione <small>la vede il cliente nel preventivo</small></span><textarea id="pv-vo-descr" rows="5" maxlength="6000"></textarea></label>' +
  '<label class="pv-c"><span class="pv-et">Prezzo + IVA <small id="pv-vo-orig"></small></span><span class="pv-euro"><input id="pv-vo-prezzo" inputmode="decimal" maxlength="16"><b>€</b></span></label>' +
  '<label class="pv-c" id="pv-vo-c-q"><span class="pv-et">Quantità <small id="pv-vo-um2"></small></span><input id="pv-vo-q" inputmode="decimal" maxlength="16"></label>' +
  "</div>" +
  '<div class="pv-mis"><div class="pv-mis-t"><b>Righe di misura</b> <small>facoltative: la quantità diventa la somma delle righe (parti × lunghezza × larghezza × altezza o peso)</small></div>' +
  '<div class="pv-mis-tab" id="pv-vo-mis"></div><button type="button" class="pv-b sm" id="pv-vo-riga">+ Riga di misura</button></div>' +
  '<p class="pv-vo-imp" id="pv-vo-imp"></p>' +
  '<p class="pv-msg" id="pv-vo-msg" aria-live="polite"></p>' +
  '<div class="pv-az"><button type="button" class="pv-b pv-pr" id="pv-vo-salva">Salva la voce</button><button type="button" class="pv-b" data-chiudi>Annulla</button>' +
  '<button type="button" class="pv-b pv-togli" id="pv-vo-togli" hidden>Togli la voce</button></div>' +
  "</div></div>" +
  // esito (accettato / rifiutato)
  '<div class="pv-velo" id="pv-v-esito" hidden><div class="pv-mod" role="dialog" aria-modal="true" aria-labelledby="pv-es-t">' +
  '<h2 id="pv-es-t">Esito</h2>' +
  '<div class="pv-campi">' +
  '<label class="pv-c"><span class="pv-et">Quando</span><input id="pv-es-data" type="date"></label>' +
  '<label class="pv-c" id="pv-es-c-chi"><span class="pv-et">Chi l\'ha accettato</span><input id="pv-es-chi" maxlength="200"></label>' +
  '<label class="pv-c tutta"><span class="pv-et">Nota <small>facoltativa</small></span><input id="pv-es-nota" maxlength="500"></label>' +
  "</div>" +
  '<p class="pv-msg" id="pv-es-msg" aria-live="polite"></p>' +
  '<div class="pv-az"><button type="button" class="pv-b pv-pr" id="pv-es-ok">Salva</button><button type="button" class="pv-b" data-chiudi>Annulla</button></div>' +
  "</div></div>" +
  // «Prepara con TIX»: le voci simili al posto di quella proposta
  '<div class="pv-velo" id="pv-v-alt" hidden><div class="pv-mod largo" role="dialog" aria-modal="true" aria-labelledby="pv-alt-t">' +
  '<h2 id="pv-alt-t">Scegli un\'altra voce</h2><p class="pv-vo-fonte" id="pv-alt-voce"></p>' +
  '<div class="pv-ris" id="pv-alt-lista"></div>' +
  '<p class="pv-msg" id="pv-alt-msg" aria-live="polite"></p>' +
  '<div class="pv-az"><button type="button" class="pv-b" data-chiudi>Chiudi</button></div>' +
  "</div></div>" +
  '<input type="file" id="pv-file" accept=".pdf,.p7m,application/pdf" hidden>';

// «Prepara con TIX» (preventivi-ia-1): riquadro nella bozza e segni sulle voci (verde / giallo / rosso)
const STILE_IA =
  ".pv-ia{margin:18px 0 0;padding:14px;border-radius:14px;border:1.5px solid var(--pv);background:linear-gradient(180deg,#fff,var(--pv-f));box-shadow:0 0 0 4px rgba(102,116,28,.10)}" +
  ".pv-ia.chiuso{border-style:dashed;box-shadow:none}" +
  ".pv-ia-t{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.pv-ia-t>div{flex:1;min-width:220px}.pv-ia-t h3{display:flex;align-items:center;flex-wrap:wrap;gap:.3em;margin:0;font-size:1.05rem;color:var(--pv-s)}" +
  ".pv-ia-t p{margin:3px 0 0;font-size:.86rem;color:var(--s);line-height:1.45}" +
  ".pv-ia-ic{flex:none;width:36px;height:36px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:#fff;box-shadow:0 0 0 2px #1B2F4A,0 6px 14px -6px rgba(27,47,74,.5)}.pv-ia-ic svg{width:24px;height:24px;margin:2px 0 0 1px}" +
  ".pv-tix-defs{position:absolute;width:0;height:0;overflow:hidden}.pv-tix{display:inline-block;vertical-align:middle;flex:none;height:.95em;width:2.45em;margin:0 .05em}" +
  ".pv-tix-et{display:inline-flex;align-items:center;padding:2px 7px;border-radius:7px;background:#fff}.pv-tix-et .pv-tix{margin:0}" +
  ".pv-arg,.pv-ia-x,.pv-mis-r button,button.pv-ia-ic{border:1px solid #8E9AA6!important;background:linear-gradient(90deg,#8E9AA6 0%,#E9EEF1 25%,#B4BEC6 50%,#F4F7F8 75%,#8E9AA6 100%) 0 0/200% 100%!important;animation:pv-arg 3.2s linear infinite;box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:pointer}" +
  ".pv-arg{color:#1B2F4A!important;font-weight:800}.pv-ia-x,.pv-mis-r button{color:#8a2b2b!important;border-radius:50%!important}" +
  ".pv-mis-r button{width:30px;height:30px;display:flex;align-items:center;justify-content:center;padding:0;font-size:1rem;line-height:1;justify-self:center}" +
  "button.pv-ia-ic{padding:0;font:inherit;box-shadow:0 0 0 2px #1B2F4A,0 6px 14px -6px rgba(27,47,74,.5)}button.pv-ia-ic:focus-visible{outline:2px solid #F26A10;outline-offset:3px}" +
  "@keyframes pv-arg{to{background-position:-200% 0}}@media (prefers-reduced-motion:reduce){.pv-arg,.pv-ia-x,.pv-mis-r button,button.pv-ia-ic{animation:none}}" +
  ".pv-ia .pv-c{margin-top:12px}" +
  ".pv-ia-cari{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-top:12px}" +
  ".pv-ia-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:110px;padding:14px;border-radius:14px;border:2px dashed var(--pv-b);background:#fff;text-align:center;color:var(--pv-s);cursor:pointer;min-width:0}" +
  ".pv-ia-drop.su{border-color:var(--pv);background:var(--pv-f)}.pv-ia-drop svg{width:26px;height:26px}.pv-ia-drop small{color:var(--s);font-size:.8rem;line-height:1.4}" +
  ".pv-ia-link{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:14px;border:1px solid var(--l);background:#fff;min-width:0}.pv-ia-link small{font-size:.78rem;color:var(--s);line-height:1.4}" +
  ".pv-ia-lb{display:flex;gap:6px;min-width:0}.pv-ia-lb input{flex:1;min-width:0;min-height:40px;padding:0 10px;border:1.5px solid var(--pv);border-radius:10px;font:inherit}" +
  ".pv-ia-lb select{min-height:40px;border:1px solid rgba(16,27,43,.2);border-radius:10px;font:inherit;padding:0 6px;max-width:150px}" +
  ".pv-ia-file{display:flex;flex-direction:column;gap:8px;margin-top:12px}" +
  // preventivi-rilettura-1: «Rifai con gli stessi file» e link salvati
  ".pv-ia-rip{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:12px;padding:10px 12px;border:1px dashed var(--pv-b);border-radius:12px;background:#FBFCF4}.pv-ia-rip0{margin-top:10px}" +
  // preventivi-ricontrollo-1: esito del ricontrollo delle voci
  ".pv-ia-segn{display:flex;flex-direction:column;gap:6px;margin-top:10px}.pv-ia-segn>div{padding:8px 10px;border-radius:10px;font-size:.88rem;line-height:1.4}" +
  ".pv-ia-segn .err{background:#FDECEA;border:1px solid #F3B8AE}.pv-ia-segn .att{background:#FFF7E6;border:1px solid #F1D49A}.pv-ia-segn b{margin-right:4px}" +
  ".pv-ia-segn .err b{color:#B3261E}.pv-ia-segn .att b{color:#8A5A00}" +
  ".pv-ia-links{margin-top:12px;border:1px solid var(--l);border-radius:12px;background:#fff;padding:8px 12px}.pv-ia-links summary{cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:700;color:var(--pv-s)}" +
  ".pv-ia-links summary small{background:var(--pv-f);border:1px solid var(--pv-b);border-radius:999px;padding:0 8px;font-size:.78rem}" +
  ".pv-ia-lic{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#1B2F4A}.pv-ia-lic svg{width:16px;height:16px}" +
  ".pv-ia-lr{display:flex;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--l)}.pv-ia-lr>div{flex:1;min-width:0}.pv-ia-lr small{color:var(--s)}" +
  ".pv-ia-lr code{display:block;font-size:.78rem;color:var(--s);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
  ".pv-ia-f{display:grid;grid-template-columns:46px minmax(0,1fr) 190px 80px 34px;gap:10px;align-items:center;padding:9px 12px;border-radius:12px;background:#fff;border:1px solid var(--l)}" +
  ".pv-ia-f.no{border-color:var(--ko-b);background:var(--ko-f)}.pv-ia-f.pronto{border-color:var(--ok-b)}" +
  ".pv-ia-f p{margin:0;font-size:.88rem;font-weight:700;overflow-wrap:anywhere}.pv-ia-f small{display:block;font-weight:500;color:var(--s);font-size:.78rem;margin-top:2px;overflow-wrap:anywhere}" +
  ".pv-ia-f small.m{color:var(--ko)}.pv-ia-f.pronto small.m{color:var(--dv)}" +
  ".pv-ia-f .tipo{display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:10px;font-size:.68rem;font-weight:800;border:1px solid}" +
  ".pv-ia-f .tipo.xlsx{background:#E8F4EC;border-color:#A9D3B8;color:#1D6F42}.pv-ia-f .tipo.pdf{background:var(--ko-f);border-color:var(--ko-b);color:var(--ko)}.pv-ia-f .tipo.link{background:#EEF2F8;border-color:#C5D0E0;color:var(--navy)}" +
  ".pv-ia-f select{min-height:36px;border:1px solid rgba(16,27,43,.2);border-radius:9px;font:inherit;font-size:.84rem;padding:0 6px;min-width:0}" +
  ".pv-ia-sp{display:flex;align-items:center;gap:6px;font-size:.84rem;font-weight:600}.pv-ia-sp input{width:18px;height:18px;accent-color:#66741C}" +
  ".pv-ia-x{width:32px;height:32px;border-radius:9px;border:1px solid var(--l);background:#fff;color:var(--s);font-size:1.1rem;cursor:pointer}" +
  ".pv-ia-st{font-size:.8rem;color:var(--s);grid-column:3/-1}" +
  ".pv-ia-nota{font-size:.8rem;color:var(--s);line-height:1.4;max-width:620px;align-self:center}" +
  ".pv-ia-stima{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:12px}.pv-ia-stima div{padding:10px 12px;border-radius:12px;background:#fff;border:1px solid var(--l)}" +
  ".pv-ia-stima span{display:block;font-size:.76rem;color:var(--s);font-weight:600}.pv-ia-stima b{display:block;margin-top:2px;font-size:1.1rem;color:var(--navy)}" +
  ".pv-ia-stima small{display:block;font-size:.74rem;color:var(--s);margin-top:2px;line-height:1.35}.pv-ia-stima .soldi{border-color:var(--pv-b);background:var(--pv-f)}.pv-ia-stima .soldi b{color:var(--pv-s)}" +
  ".pv-ia-appr{margin-top:6px;max-width:760px}.pv-ia-vel{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}.pv-ia-vel .et{font-size:.82rem;font-weight:700;color:var(--s)}.pv-ia-vel em{font-style:normal;font-weight:600;opacity:.85;font-size:.8rem}" +
  ".pv-ia-att{display:flex;gap:12px;align-items:center;margin-top:12px;padding:12px 14px;border-radius:12px;background:#fff;border:1px solid var(--l)}.pv-ia-att b{color:var(--pv-s)}" +
  ".pv-ia-att small{display:block;color:var(--s);font-size:.82rem;margin-top:3px;line-height:1.4}" +
  ".pv-ia-gira{flex:none;width:26px;height:26px;border-radius:50%;border:3px solid var(--pv-b);border-top-color:var(--pv);animation:pv-gira 1s linear infinite}@keyframes pv-gira{to{transform:rotate(360deg)}}" +
  "@media (prefers-reduced-motion:reduce){.pv-ia-gira{animation:none}}" +
  ".pv-ia-esito{margin-top:10px}.pv-ia-rie{font-size:.84rem;color:var(--s);line-height:1.45}" +
  ".pv-ia-chiarire{margin-top:10px;padding:12px 14px;border-radius:12px;border:1px solid var(--dv-b);background:var(--dv-f)}.pv-ia-chiarire b{color:var(--dv)}.pv-ia-chiarire ol{margin:6px 0 0;padding-left:20px;font-size:.86rem;line-height:1.5}" +
  ".pv-ia-letti{margin-top:10px;font-size:.82rem;color:var(--s)}.pv-ia-letti summary{cursor:pointer;font-weight:700;color:var(--navy)}.pv-ia-letti div{padding:3px 0;overflow-wrap:anywhere}" +
  ".pv-ia-barra{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 8px;padding:10px 12px;border-radius:12px;border:1px solid var(--pv-b);background:var(--pv-f);font-size:.86rem;color:var(--pv-s);font-weight:700}" +
  ".pv-vt.ia-verde{box-shadow:inset 4px 0 0 var(--ok)}.pv-vt.ia-giallo{box-shadow:inset 4px 0 0 #E0A800;background:#FFFCF2}.pv-vt.ia-rosso{box-shadow:inset 4px 0 0 var(--ko);background:#FFF9F8}" +
  ".pv-vt.ia-ok{background:none;box-shadow:inset 4px 0 0 var(--gr-b)}" +
  ".pv-ia-tag{display:inline-flex;align-items:center;gap:5px;margin:0 0 4px;padding:1px 8px;border-radius:999px;font-size:.72rem;font-weight:800;border:1px solid}.pv-ia-tag::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}" +
  ".pv-ia-tag.verde{background:var(--ok-f);border-color:var(--ok-b);color:var(--ok)}.pv-ia-tag.giallo{background:#FFF8E1;border-color:#F2D88A;color:#8A6100}" +
  ".pv-ia-tag.rosso{background:var(--ko-f);border-color:var(--ko-b);color:var(--ko)}.pv-ia-tag.ok{background:#fff;border-color:var(--gr-b);color:var(--gr)}" +
  "@media (max-width:900px){.pv-ia-cari{grid-template-columns:minmax(0,1fr)}.pv-ia-stima{grid-template-columns:1fr 1fr}" +
  ".pv-ia-f{grid-template-columns:42px minmax(0,1fr) 34px}.pv-ia-f select,.pv-ia-f .pv-ia-sp,.pv-ia-f .pv-ia-st{grid-column:2}.pv-ia-f .pv-ia-x{grid-row:1;grid-column:3}}" +
  "@media (max-width:640px){.pv-ia-lb{flex-wrap:wrap}.pv-ia-lb input{flex:1 1 100%}.pv-ia-lb select{flex:1;max-width:none}}";

const STILE =
  ":root{--t:#17212E;--s:#5B6672;--c:#fff;--l:rgba(16,27,43,.11);--navy:#1B2F4A;--pv:#66741C;--pv-2:#7D8C27;--pv-s:#4A5512;--pv-f:#F3F5E6;--pv-b:#CDD49D;" +
  "--dv:#9A4308;--dv-f:#FFF3E8;--dv-b:#F7B98A;--ok:#146C43;--ok-f:#E9F6EF;--ok-b:#A8D8BD;--ko:#B3261E;--ko-f:#FDEEEC;--ko-b:#F2B8B3;--gr:#5B6672;--gr-f:#EEF1F4;--gr-b:#D9DFE6}" +
  "*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;color:var(--t);font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,system-ui,sans-serif;background:#F8FAFC}" +
  "main{max-width:960px;margin:0 auto;padding:16px 12px 48px}" +
  "@media screen and (min-width:760px){main{max-width:min(1600px,calc(100vw - 48px));padding:20px 12px 56px}}" +
  "@media screen and (min-width:900px){main{max-width:min(1600px,calc(100vw - 96px))}}" +
  ".pv-torna{display:inline-block;margin:0 0 12px;color:var(--navy);font-weight:600;text-decoration:none}" +
  ".pv-carica{color:var(--s)}" +
  ".pv-card{position:relative;background:var(--c);border:1px solid transparent;border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(16,27,43,.05),0 8px 20px -14px rgba(16,27,43,.2);margin-bottom:16px}" +
  ".pv-card::before{content:'';position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#F26A10);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}" +
  "@media print{.pv-card::before{display:none}}" +
  ".pv-testa{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}" +
  ".pv-chi{margin:0;font-size:.88rem;color:var(--s)}h1{display:flex;align-items:center;gap:10px;margin:4px 0 0;font-size:1.5rem;color:var(--navy);letter-spacing:-.02em}h2{color:var(--navy);letter-spacing:-.02em}" +
  ".pv-ic{flex:none;width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#A7B54A,#66741C 55%,#4A5512);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 6px 14px -6px rgba(74,85,18,.6)}.pv-ic svg{width:22px;height:22px}" +
  ".pv-spiega{margin:12px 0 0;font-size:.92rem;line-height:1.55;color:var(--s);max-width:960px}.pv-spiega b{color:var(--t)}" +
  // 09/11/2026 (crediti-1): riquadro «Crediti TIX» nell'elenco, colore oliva dei Preventivi
  ".pv-cr{margin:14px 0 0;padding:12px 14px;border:1px solid rgba(102,116,28,.35);border-radius:12px;background:rgba(102,116,28,.06)}" + ".pv-cr-t{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline}.pv-cr-t b{font-size:1.02rem;color:#66741C}.pv-cr-t span{font-size:.85rem;color:var(--s)}" + ".pv-cr-s{margin:6px 0 8px;font-size:.82rem;line-height:1.45;color:var(--s)}.pv-cr-p{display:flex;flex-wrap:wrap;gap:8px}" + ".pv-cr-k{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 10px;border:1px solid rgba(102,116,28,.3);border-radius:10px;font-size:.86rem}" + ".pv-cr-m{margin-top:8px;font-size:.84rem}.pv-cr-m summary{cursor:pointer;color:var(--s)}.pv-cr-m table{border-collapse:collapse;margin-top:6px}" + ".pv-cr-m td{padding:3px 12px 3px 0;vertical-align:top}.pv-cr-m td.n{text-align:right;font-weight:600;white-space:nowrap}" +
  // 09/11/2026 (cantiere-da-preventivo-1): riquadro «Cantiere» del preventivo accettato
  ".pv-cant{margin:16px 0 0;padding:14px 16px;border:1px solid rgba(102,116,28,.35);border-radius:12px;background:rgba(102,116,28,.05)}" + ".pv-cant h3{margin:0 0 6px}.pv-cant h4{margin:12px 0 6px;font-size:.92rem}.pv-cant-s{margin:6px 0;font-size:.9rem;line-height:1.5;color:var(--s)}" + ".pv-cant-l{list-style:none;margin:0;padding:0;display:grid;gap:4px}.pv-cant-l li{display:flex;gap:8px;font-size:.9rem;line-height:1.45}" + ".pv-cant-l li span{width:16px;flex:none;text-align:center;font-weight:800}.pv-cant-l li.ok span{color:#66741C}.pv-cant-l li.no span{color:#9A6B00}.pv-cant-l li.opz{color:var(--s)}" + ".pv-cant-p{display:flex;flex-wrap:wrap;gap:8px}.pv-cant-k{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 10px;border:1px solid rgba(102,116,28,.25);border-radius:10px;font-size:.86rem}" + ".pv-cant-k.su{border-color:#66741C;background:rgba(102,116,28,.08)}" +
  ".pv-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;padding:0 16px;border-radius:12px;border:1px solid var(--navy);background:#fff;color:var(--navy);font:inherit;font-weight:700;font-size:.92rem;cursor:pointer;text-decoration:none;white-space:nowrap}" +
  ".pv-b:disabled{opacity:.55;cursor:default}.pv-b.sm{min-height:34px;padding:0 12px;font-size:.84rem;border-radius:10px;border-color:rgba(16,27,43,.18);color:var(--t)}" +
  ".pv-pr{border-color:var(--pv);color:#fff;background:linear-gradient(180deg,rgba(255,255,255,.2),rgba(255,255,255,0) 52%),linear-gradient(180deg,#7D8C27,#66741C);box-shadow:0 10px 22px -12px rgba(74,85,18,.8)}" +
  ".pv-b.sm.pv-pr{color:#fff;border-color:var(--pv)}" +
  ".pv-xl{border-color:#1D6F42;color:#1D6F42;background:#E8F4EC}.pv-togli{border-color:var(--ko);color:var(--ko)}.pv-ok{border-color:var(--ok);color:var(--ok);background:var(--ok-f)}" +
  ".pv-az-t{display:flex;gap:8px;flex-wrap:wrap;align-items:center}" +
  ".pv-scegli{margin:12px 0 0}.pv-scegli select{min-height:40px;margin-left:6px;padding:0 10px;border-radius:10px;border:1px solid rgba(16,27,43,.2);font:inherit}" +
  ".pv-filtri{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:18px 0 8px}.pv-filtri .et{font-size:.8rem;font-weight:700;color:var(--s)}" +
  ".pv-chip{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:999px;border:1.5px solid var(--pv-b);background:#fff;font:inherit;font-weight:700;color:var(--pv-s);font-size:.88rem;cursor:pointer}" +
  ".pv-chip.on{background:linear-gradient(180deg,#7D8C27,#66741C);color:#fff;border-color:var(--pv)}" +
  ".pv-chip small{display:inline-flex;min-width:20px;height:20px;padding:0 6px;align-items:center;justify-content:center;border-radius:999px;background:var(--pv-f);font-size:.72rem;color:var(--pv-s)}.pv-chip.on small{background:rgba(255,255,255,.25);color:#fff}" +
  ".pv-chip.st{border-color:var(--gr-b);color:var(--t)}.pv-sep{width:1px;height:26px;background:var(--l);margin:0 4px}" +
  ".pv-elenco{display:flex;flex-direction:column;gap:10px;margin-top:10px}" +
  ".pv-r{position:relative;display:grid;grid-template-columns:150px minmax(0,1fr) 180px 150px 190px;gap:14px;align-items:center;padding:14px 16px 14px 20px;border:1px solid var(--l);border-radius:14px;background:#fff;text-decoration:none;color:inherit}" +
  ".pv-r:hover{border-color:var(--pv-b);box-shadow:0 8px 18px -14px rgba(74,85,18,.6)}" +
  ".pv-r::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:4px;border-radius:0 4px 4px 0;background:var(--pv)}" +
  ".pv-num{font-weight:800;color:var(--pv-s);font-size:.95rem}.pv-num small{display:block;font-weight:600;color:var(--s);font-size:.78rem;margin-top:2px}" +
  ".pv-r h3{margin:0;font-size:1.02rem;color:var(--t)}.pv-dove{margin:3px 0 0;font-size:.84rem;color:var(--s)}" +
  ".pv-imp{text-align:right}.pv-imp b{display:block;font-size:1.15rem;color:var(--navy)}.pv-imp span{font-size:.78rem;color:var(--s)}" +
  ".pv-r .pv-azr{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}" +
  // preventivi-elimina-1: «Elimina» con il cestino, rosso pieno al passaggio
  ".pv-elim{display:inline-flex;align-items:center;gap:6px;font-weight:800;background:#FFF5F3}.pv-elim svg{flex:none}" +
  ".pv-elim:hover,.pv-elim:focus-visible{background:var(--ko);color:#fff;border-color:var(--ko)}" +
  ".pv-stato{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:.78rem;font-weight:700;border:1px solid}" +
  ".pv-stato::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}" +
  ".pv-stato.bozza{border-color:var(--gr-b);background:var(--gr-f);color:var(--gr)}.pv-stato.mandato{border-color:var(--pv-b);background:var(--pv-f);color:var(--pv-s)}" +
  ".pv-stato.accettato{border-color:var(--ok-b);background:var(--ok-f);color:var(--ok)}.pv-stato.rifiutato{border-color:var(--ko-b);background:var(--ko-f);color:var(--ko)}" +
  ".pv-st-info{display:block;margin-top:5px;font-size:.76rem;color:var(--s);line-height:1.35}" +
  ".pv-cant{display:inline-flex;padding:1px 8px;border-radius:6px;background:#EEF2F8;color:var(--navy);font-weight:700;font-size:.78rem}.pv-cant.no{background:#FFF4EC;color:#B4500A}" +
  ".pv-vuoto{margin:10px 0 0;padding:16px;border-radius:12px;background:#F5F7FA;color:var(--s);font-size:.92rem}" +
  ".pv-due{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;align-items:start}" +
  "@media (max-width:1180px){.pv-due{grid-template-columns:minmax(0,1fr)}}" +
  ".pv-campi{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}.pv-c{display:flex;flex-direction:column;gap:5px}.pv-c.tutta{grid-column:1/-1}.pv-c.l2{grid-column:span 2}.pv-c[hidden]{display:none}" +
  ".pv-mod .pv-campi{grid-template-columns:repeat(2,minmax(0,1fr))}" +
  ".pv-et{font-size:.82rem;font-weight:700}.pv-et small{font-weight:500;color:var(--s)}" +
  ".pv-c input,.pv-c select,.pv-c textarea{min-height:42px;padding:9px 12px;border:1px solid rgba(16,27,43,.2);border-radius:10px;font:inherit;background:#fff;color:var(--t)}" +
  ".pv-c textarea{resize:vertical;line-height:1.45}.pv-c input:disabled,.pv-c select:disabled,.pv-c textarea:disabled{background:#F5F7FA;color:var(--s)}" +
  ".pv-fisso{min-height:42px;padding:10px 12px;border-radius:10px;background:#F5F7FA;color:var(--s);border:1px solid rgba(16,27,43,.08)}" +
  ".pv-interr{display:flex;align-items:center;gap:10px;min-height:42px;padding:8px 12px;border:1px solid var(--pv-b);border-radius:10px;background:var(--pv-f);color:var(--pv-s);font-weight:700;cursor:pointer}" +
  ".pv-interr input{width:20px;height:20px;accent-color:#66741C}" +
  ".pv-euro{display:flex;align-items:center;gap:6px}.pv-euro input{flex:1;min-width:0}" +
  ".pv-cerca{margin:18px 0 0;padding:14px;border-radius:14px;border:1.5px solid var(--pv-b);background:linear-gradient(180deg,#fff,var(--pv-f))}" +
  ".pv-cerca h3{margin:0 0 10px;font-size:1rem;color:var(--navy)}" +
  ".pv-barra{display:flex;align-items:center;gap:10px;min-height:46px;padding:0 14px;border:1.5px solid var(--pv);border-radius:12px;background:#fff}" +
  ".pv-barra svg{width:20px;height:20px;color:var(--pv-s);flex:none}.pv-barra input{flex:1;min-width:0;border:0;outline:0;font:inherit;font-size:1rem;background:transparent}.pv-barra span{color:var(--s);font-size:.82rem;white-space:nowrap}" +
  ".pv-fonti{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}" +
  ".pv-ris{display:flex;flex-direction:column;gap:6px;max-height:520px;overflow:auto}" +
  ".pv-ri{display:grid;grid-template-columns:200px minmax(0,1fr) 60px 150px 100px;gap:12px;align-items:center;padding:9px 12px;border-radius:10px;background:#fff;border:1px solid var(--l)}" +
  ".pv-ri p{margin:0;font-size:.88rem;line-height:1.4}.pv-ri p small{display:block;color:var(--s);font-size:.78rem;margin-top:2px}" +
  ".pv-ri .pr{text-align:right;font-size:.88rem}.pv-ri .pr b{display:block;font-size:1rem;color:var(--navy)}.pv-ri .pr small{color:var(--s);font-size:.74rem}.pv-ri .um{font-size:.84rem;color:var(--s);text-align:center}" +
  ".pv-fonte{display:inline-flex;flex-direction:column;gap:1px;padding:4px 9px;border-radius:8px;font-size:.74rem;font-weight:700;border:1px solid;line-height:1.25;justify-self:start;overflow-wrap:anywhere}" +
  ".pv-fonte em{font-style:normal;font-weight:600;opacity:.85}" +
  ".pv-fonte.contratto{background:#EEF2F8;border-color:#C5D0E0;color:var(--navy)}.pv-fonte.prezzario{background:var(--pv-f);border-color:var(--pv-b);color:var(--pv-s)}" +
  ".pv-fonte.libera{background:var(--gr-f);border-color:var(--gr-b);color:var(--gr)}.pv-fonte.elem{background:var(--dv-f);border-color:var(--dv-b);color:var(--dv)}" +
  ".pv-altre{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}" +
  ".pv-voci{margin-top:18px}.pv-voci h3{margin:0 0 8px;font-size:1rem;color:var(--navy)}" +
  ".pv-vt{display:grid;grid-template-columns:30px 170px minmax(0,1fr) 60px 90px 96px 110px;gap:10px;align-items:start;padding:10px 6px;border-bottom:1px solid var(--l);font-size:.88rem}" +
  // preventivi-computo-1: super-categoria, categoria e totale nell'elenco delle voci; stato della voce; controlli
  ".pv-cap{margin:14px 0 0;padding:7px 10px;border-left:4px solid #A8843A;background:#F4F1E6;color:#3F4810;font-weight:800;font-size:.84rem;letter-spacing:.03em;text-transform:uppercase}" +
  ".pv-cap.sez{margin-top:20px;border-left-color:#3F4810;background:#3F4810;color:#F1E3BC}.pv-cap.ex{margin-top:22px;border-left-color:#B5532C;background:#FBF0E6;color:#8E3F1F}.pv-cap small{font-weight:600;text-transform:none;letter-spacing:0;margin-left:6px}" +
  ".pv-capt{display:flex;justify-content:space-between;gap:10px;padding:7px 10px;background:#FAF8F0;border-bottom:1px solid var(--l);font-weight:700;font-size:.86rem;color:#3F4810}.pv-capt b{white-space:nowrap}.pv-capt.ex{color:#8E3F1F;background:#FDF6EF}.pv-capt.sez{background:#E9ECD3;color:#2C330A;border-bottom:2px solid #3F4810;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px}" +
  ".pv-vt.fuori .im{color:#8a8a8a;text-decoration:line-through}.pv-sv{display:inline-block;margin:0 6px 4px 0;padding:2px 8px;border-radius:999px;font-size:.74rem;font-weight:800}" +
  ".pv-sv.np{background:#FBE3DE;color:#8A2E1E}.pv-sv.da_quotare{background:#FBF0D9;color:#7A5410}.pv-sv.da_verificare{background:#FFF6CC;color:#6B5600}.pv-sv.esclusa{background:#EDEDED;color:#555}" +
  ".pv-rr.fuori{font-size:.84rem;color:#6b6b6b}.pv-ctl{margin:12px 0 4px;padding:10px 12px;border-radius:10px;border:1px solid #E3DCC5;background:#FBFAF4;font-size:.84rem;line-height:1.45}" +
  ".pv-ctl b{display:block;margin-bottom:4px}.pv-ctl p{margin:4px 0}.pv-ctl small{color:#6b6b6b}.pv-ctl.ok{border-color:#CFE3C3;background:#F5FBF1}.pv-ctl.ko{border-color:#E8B4A8;background:#FDF3F0}.pv-ctl .bl{color:#8A2E1E;font-weight:700}" +
  ".pv-vt.th{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--s);font-weight:700;border-bottom:2px solid var(--navy);padding-top:4px}" +
  ".pv-vt .n{text-align:right;white-space:nowrap}.pv-vt .nr{font-weight:800;color:var(--s)}" +
  ".pv-ds{margin:0;line-height:1.4;overflow-wrap:anywhere}.pv-ds.corta{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}" +
  ".pv-agg{display:block;font-size:.76rem;color:var(--s);margin-top:3px}" +
  ".pv-vbt{grid-column:3/-1;display:flex;gap:6px;flex-wrap:wrap}" +
  ".pv-misv{grid-column:3/-1;margin:2px 0 0;padding:8px 10px;border-radius:10px;background:#F7F9FB;border:1px dashed var(--gr-b);font-size:.8rem;color:var(--s)}" +
  ".pv-misv div{display:grid;grid-template-columns:minmax(0,1fr) 46px 60px 60px 60px 72px;gap:8px}.pv-misv div.h{font-weight:700;color:var(--t)}.pv-misv span{text-align:right}.pv-misv span:first-child{text-align:left}" +
  ".pv-riep{position:sticky;top:12px}.pv-riep h2{margin:0 0 10px;font-size:1.15rem}" +
  ".pv-rr{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--l);font-size:.9rem}.pv-rr span{color:var(--s)}.pv-rr b{color:var(--t);white-space:nowrap}.pv-rr.rib b{color:var(--pv-s)}" +
  ".pv-rr.tot{border:0;margin-top:8px;padding:12px 14px;border-radius:12px;background:linear-gradient(180deg,#24406A,#1B2F4A);color:#fff;font-size:1.05rem}.pv-rr.tot span{color:rgba(255,255,255,.85)}.pv-rr.tot b{color:#fff;font-size:1.3rem}" +
  ".pv-rr.tot small{display:block;text-align:right;font-size:.74rem;color:rgba(255,255,255,.75);font-weight:600}" +
  ".pv-riep .pv-bott{display:flex;flex-direction:column;gap:8px;margin-top:14px}.pv-riep .pv-bott .riga{display:grid;grid-template-columns:1fr 1fr;gap:8px}" +
  ".pv-avviso{margin:12px 0 0;padding:10px 12px;border-radius:10px;border:1px solid var(--dv-b);background:var(--dv-f);color:var(--dv);font-size:.84rem;line-height:1.45}" +
  ".pv-info{margin:12px 0 0;padding:10px 12px;border-radius:10px;border:1px solid var(--gr-b);background:var(--gr-f);color:var(--s);font-size:.84rem;line-height:1.45}" +
  ".pv-esito{display:flex;align-items:center;gap:10px;margin:10px 0 0;padding:10px 12px;border-radius:10px;background:var(--ok-f);border:1px solid var(--ok-b);color:var(--ok);font-size:.86rem;font-weight:600}" +
  ".pv-esito.ko{background:var(--ko-f);border-color:var(--ko-b);color:var(--ko)}" +
  ".pv-revs{margin:12px 0 0;padding:0;list-style:none;font-size:.84rem;color:var(--s)}.pv-revs li{padding:8px 0;border-top:1px solid var(--l)}.pv-revs b{color:var(--t)}.pv-revs a{color:var(--pv-s);font-weight:700}" +
  ".pv-msg{min-height:1.2em;margin:8px 0 0;font-size:.88rem;color:var(--s)}.pv-msg.ko{color:var(--ko)}.pv-msg.ok{color:var(--ok)}" +
  ".pv-velo{position:fixed;inset:0;z-index:50;background:rgba(16,27,43,.45);display:flex;align-items:flex-start;justify-content:center;padding:24px 12px;overflow:auto}.pv-velo[hidden]{display:none}" +
  ".pv-mod{width:min(720px,100%);background:#fff;border-radius:16px;padding:18px;box-shadow:0 20px 50px -20px rgba(16,27,43,.6)}.pv-mod.largo{width:min(900px,100%)}.pv-mod h2{margin:0 0 6px}" +
  ".pv-vo-fonte{margin:0;font-size:.86rem;color:var(--s)}.pv-vo-imp{margin:10px 0 0;font-weight:700;color:var(--navy)}" +
  ".pv-mis{margin-top:12px;padding:10px 12px;border-radius:12px;border:1px dashed var(--gr-b);background:#FBFCFD}.pv-mis-t{font-size:.86rem;margin-bottom:8px}.pv-mis-t small{color:var(--s)}" +
  ".pv-mis-r{display:grid;grid-template-columns:minmax(0,1fr) 70px 80px 80px 80px 84px 34px;gap:6px;margin-bottom:6px;align-items:center}" +
  ".pv-mis-r input{min-height:36px;padding:0 8px;border:1px solid rgba(16,27,43,.2);border-radius:8px;font:inherit;font-size:.86rem;min-width:0}.pv-mis-r .q{text-align:right;font-weight:700;font-size:.86rem}" +
  ".pv-mis-r input.q:disabled{background:transparent;border-color:transparent;color:inherit;opacity:1;-webkit-text-fill-color:currentColor}" +
  ".pv-mis-r.h{font-size:.72rem;font-weight:700;color:var(--s);text-transform:uppercase;letter-spacing:.04em}.pv-mis-r button{border:0;background:none;color:var(--ko);font-size:1.1rem;cursor:pointer}" +
  ".pv-az{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.pv-az .pv-togli{margin-left:auto}" +
  "@media (max-width:1100px){.pv-r{grid-template-columns:130px minmax(0,1fr) 150px}.pv-r .pv-imp{grid-column:3}.pv-r .pv-azr{display:none}" +
  ".pv-r .pv-azr.del{display:flex;grid-column:1/-1;justify-content:flex-end}.pv-r .pv-azr.del .apri{display:none}}" +
  "@media (max-width:900px){.pv-ri{grid-template-columns:minmax(0,1fr) 120px}.pv-ri .um{display:none}.pv-ri .pv-fonte{grid-column:1/-1;flex-direction:row;gap:6px}.pv-ri .pv-b{grid-column:2}.pv-campi{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
  "@media (max-width:640px){main{padding:12px 10px 40px}.pv-card{padding:14px}h1{font-size:1.3rem}.pv-sep{display:none}" +
  ".pv-r{grid-template-columns:minmax(0,1fr) auto;gap:8px 10px;padding:12px 12px 12px 16px}.pv-r .pv-num{grid-column:1}.pv-r .pv-stc{grid-column:2;grid-row:1;justify-self:end;text-align:right}" +
  ".pv-r .pv-tit{grid-column:1/-1}.pv-r .pv-imp{grid-column:1/-1;text-align:left}.pv-r .pv-imp b{display:inline;margin-right:6px}.pv-r .pv-azr.del{justify-content:flex-start}" +
  ".pv-campi,.pv-mod .pv-campi{grid-template-columns:minmax(0,1fr)}.pv-c.l2{grid-column:auto}" +
  ".pv-ri{grid-template-columns:minmax(0,1fr) auto}.pv-ri .pr{text-align:left}" +
  ".pv-vt.th{display:none}.pv-vt{grid-template-columns:28px auto auto auto minmax(0,1fr);grid-template-areas:'nr fo fo fo fo' '. ds ds ds ds' '. q um pu im' '. bt bt bt bt';gap:4px 6px}" +
  ".pv-vt .nr{grid-area:nr}.pv-vt .fo{grid-area:fo}.pv-vt .ds{grid-area:ds}.pv-vt .q{grid-area:q;text-align:left}.pv-vt .um{grid-area:um;color:var(--s)}" +
  ".pv-vt .pu{grid-area:pu;text-align:left;color:var(--s)}.pv-vt .pu::before{content:'× '}.pv-vt .im{grid-area:im;font-weight:800}.pv-vbt{grid-area:bt}.pv-misv{grid-column:1/-1}" +
  ".pv-misv div{grid-template-columns:minmax(0,1.6fr) repeat(4,minmax(0,1fr)) minmax(0,1.2fr);gap:4px;font-size:.72rem}.pv-misv span{overflow-wrap:anywhere}" +
  ".pv-mis-r{grid-template-columns:minmax(0,1fr) 54px 54px 54px 30px;}.pv-mis-r .alt,.pv-mis-r .h .alt{display:none}.pv-mis-r .parti{display:none}.pv-az .pv-togli{margin-left:0}}";

// script della pagina (nel browser)
const SCRIPT = String.raw`
(function(){
var CFG=__CFG__;
var D=CFG.d||{};
var $=function(i){return document.getElementById(i);};
function es(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function num(v){var n=Number(v);return isFinite(n)?n:0;}
function cifra(n,dec){var neg=n<0,s=Math.abs(n).toFixed(dec).split('.');var i=s[0].replace(/\B(?=(\d{3})+(?!\d))/g,'.');return (neg?'−':'')+i+(dec?','+s[1]:'');}
function euro(v){return cifra(num(v),2)+' €';}
function qta(v){return cifra(num(v),2);}
function txt2(v){return (Math.round(num(v)*100)/100).toFixed(2).replace('.',',');}
function dt(d){var m=String(d||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'/'+m[2]+'/'+m[1]:'';}
function oggiIso(){var d=new Date();try{return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Rome'}).format(d);}catch(e){return d.toISOString().slice(0,10);}}
function inNum(s){var t=String(s==null?'':s).replace(/[€\s]/g,'');if(!t)return null;if(/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t))t=t.replace(/\./g,'').replace(',','.');else t=t.replace(',','.');var n=Number(t);return isFinite(n)?n:NaN;}
function api(azione,dati){return fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,a:CFG.a,c:CFG.c,azione:azione,dati:dati||{}})})
 .then(function(r){return r.json().catch(function(){return {esito:'errore'};});}).catch(function(){return {esito:'rete'};});}
function msgErr(r){if(!r)return 'Il servizio non risponde: riprova tra un minuto.';if(r.messaggio)return r.messaggio;
 return ({gettone:'Accesso scaduto: rientra dall\'elenco dei cantieri.',spento:'La sezione Preventivi non è accesa per questo accesso.',non_trovato:'Preventivo non trovato.',cantiere:'Cantiere non trovato.',rete:'Connessione assente: riprova.',mandato:'Questo preventivo è già stato mandato: per cambiarlo fai una revisione nuova.'})[r.esito]||'Non è andato: riprova.';}
function link(q){return CFG.pagina+'?t='+encodeURIComponent(CFG.t)+(CFG.a?'&a='+encodeURIComponent(CFG.a):'')+(CFG.c?'&c='+encodeURIComponent(CFG.c):'')+(q||'');}
function apri(id){location.href=link('&id='+encodeURIComponent(id));}
function msg(el,t,cl){el.textContent=t||'';el.className='pv-msg'+(cl?' '+cl:'');}
function velo(id,si){$(id).hidden=!si;if(si){var f=$(id).querySelector('input:not([type=file]):not([disabled]),textarea,select');if(f)setTimeout(function(){f.focus();},30);}}
document.addEventListener('click',function(e){var x=e.target.closest&&e.target.closest('[data-chiudi]');if(x){var v=x.closest('.pv-velo');if(v)v.hidden=true;}});
document.addEventListener('keydown',function(e){if(e.key==='Escape')Array.prototype.forEach.call(document.querySelectorAll('.pv-velo'),function(v){v.hidden=true;});});
var STATI={bozza:'Bozza',mandato:'Mandato',accettato:'Accettato',rifiutato:'Rifiutato'};
var ICONA=${JSON.stringify(ICONA)};
// 04/11/2026 (preventivi-elimina-1): cestino del pulsante «Elimina» (bozza e elenco), più visibile
var CESTINO='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';
function statoHtml(s){return '<span class="pv-stato '+es(s)+'">'+es(STATI[s]||s)+'</span>';}
function fonteHtml(f,cod,elem){var n=f==='contratto'?'Contratto':f==='prezzario'?(elem?'Prezzario · elementare':'Prezzario'):'Voce libera';
 return '<span class="pv-fonte '+(elem?'elem':es(f))+'">'+n+(cod?'<em>'+es(cod)+'</em>':'')+'</span>';}

// ---------------------------------------------------------------- elenco
var FIL={cant:CFG.c||'',stato:''};
function elenco(){
 var app=$('pv-app');
 if(!D.azienda){
  app.innerHTML='<section class="pv-card"><p class="pv-chi">Tutte le aziende</p><h1><span class="pv-ic">'+ICONA+'</span>Preventivi</h1>'+scegliImpresa()+
   '<p class="pv-spiega">Scegli l\'impresa per vedere e fare i suoi preventivi.</p></section>';return;}
 var P=D.preventivi||[],C=D.cantieri||[];
 var nC={},nS={bozza:0,mandato:0,accettato:0,rifiutato:0},senza=0;
 P.forEach(function(p){if(p.commessa_id)nC[p.commessa_id]=(nC[p.commessa_id]||0)+1;else senza++;nS[p.stato]=(nS[p.stato]||0)+1;});
 var vis=P.filter(function(p){return (!FIL.cant||(FIL.cant==='senza'?!p.commessa_id:p.commessa_id===FIL.cant))&&(!FIL.stato||p.stato===FIL.stato);});
 var h='<section class="pv-card"><div class="pv-testa"><div><p class="pv-chi">'+es(D.azienda.nome)+'</p><h1><span class="pv-ic">'+ICONA+'</span>Preventivi</h1></div>'+
  '<div class="pv-az-t"><button type="button" class="pv-b pv-pr" id="pv-nuovo">+ Nuovo preventivo</button></div></div>'+scegliImpresa()+
  '<p class="pv-spiega">Preventivi per i lavori extra di un cantiere e per i lavori nuovi. Le voci si prendono dall\'<b>elenco prezzi del contratto</b> (il computo della sezione SAL), dal <b>prezzario regionale</b> o si scrivono a mano. Un preventivo mandato non si riscrive più: ogni modifica diventa una revisione nuova. I prezzi li vede e li scrive solo l\'ufficio.</p><div id="pv-crediti"></div>'+
  '<div class="pv-filtri"><span class="et">Cantiere</span>'+chip('cant','',  'Tutti',P.length)+C.filter(function(c){return nC[c.id]||c.id===FIL.cant;}).map(function(c){return chip('cant',c.id,c.nome,nC[c.id]||0);}).join('')+
  (senza||FIL.cant==='senza'?chip('cant','senza','Senza cantiere',senza):'')+'<span class="pv-sep"></span><span class="et">Stato</span>'+
  ['bozza','mandato','accettato','rifiutato'].map(function(s){return chip('stato',s,STATI[s],nS[s]);}).join('')+'</div><div class="pv-elenco">';
 if(!vis.length)h+='<p class="pv-vuoto">'+(P.length?'Nessun preventivo con questi filtri.':'Non c\'è ancora nessun preventivo. Comincia da «+ Nuovo preventivo».')+'</p>';
 vis.forEach(function(p){
  var info=p.stato==='mandato'&&p.valido_fino?'mandato il '+dt(p.mandato_il)+' · valido fino al '+dt(p.valido_fino):p.stato==='accettato'?'il '+dt(p.esito_il)+(p.firmato?' · copia firmata':''):p.stato==='rifiutato'?'il '+dt(p.esito_il):'';
  h+='<a class="pv-r" href="'+es(link('&id='+p.id))+'"><div class="pv-num">'+es(p.codice)+'<small>Rev. '+p.revisione+' · '+dt(p.data)+'</small></div>'+
   '<div class="pv-tit"><h3>'+es(p.titolo)+'</h3><p class="pv-dove">'+(p.commessa_id?'<span class="pv-cant">'+es(p.cantiere||'Cantiere')+'</span>':'<span class="pv-cant no">Senza cantiere</span>')+
   (p.cliente?' · '+es(p.cliente):'')+(!p.commessa_id&&p.indirizzo_lavoro?' · '+es(p.indirizzo_lavoro):'')+'</p></div>'+
   '<div class="pv-stc">'+statoHtml(p.stato)+(info?'<span class="pv-st-info">'+es(info)+'</span>':'')+'</div>'+
   '<div class="pv-imp"><b>'+(p.totale==null?'—':euro(p.totale))+'</b><span>+ IVA</span></div>'+
   // la bozza mai mandata si elimina anche dall'elenco
   (p.stato==='bozza'&&Number(p.revisione)===1?'<div class="pv-azr del"><span class="pv-b sm pv-togli pv-elim" role="button" tabindex="0" data-elimina="'+es(p.id)+'" data-cod="'+es(p.codice)+'">'+CESTINO+'Elimina</span><span class="pv-b sm pv-pr apri">Apri</span></div>'
    :'<div class="pv-azr"><span class="pv-b sm'+(p.stato==='bozza'?' pv-pr':'')+'">Apri</span></div>')+'</a>';});
 h+='</div></section>';
 app.innerHTML=h;
 caricaCrediti();
 Array.prototype.forEach.call(app.querySelectorAll('[data-elimina]'),function(b){
  var via=function(e){e.preventDefault();e.stopPropagation();
   if(!confirm('Eliminare la bozza '+b.getAttribute('data-cod')+'? Non è mai stata mandata: sparisce dall\'elenco.'))return;
   b.style.opacity='.5';api('elimina',{id:b.getAttribute('data-elimina')}).then(function(r){b.style.opacity='';if(r&&r.esito==='ok')location.href=link('');else alert(msgErr(r));});};
  b.onclick=via;b.onkeydown=function(e){if(e.key==='Enter'||e.key===' ')via(e);};});
 Array.prototype.forEach.call(app.querySelectorAll('[data-fil]'),function(b){b.onclick=function(){var k=b.getAttribute('data-fil'),v=b.getAttribute('data-v');FIL[k]=FIL[k]===v&&v?'':v;elenco();};});
 $('pv-nuovo').onclick=nuovo;
}
function chip(k,v,t,n){return '<button type="button" class="pv-chip'+(k==='stato'?' st':'')+(FIL[k]===v?' on':'')+'" data-fil="'+k+'" data-v="'+es(v)+'">'+es(t)+' <small>'+(n||0)+'</small></button>';}
function scegliImpresa(){if(!D.filippo||CFG.c)return '';var I=D.imprese||[],az=D.azienda;
 return '<form class="pv-scegli" method="get" action="'+es(CFG.pagina)+'"><input type="hidden" name="t" value="'+es(CFG.t)+'"><label>Impresa <select name="a" onchange="this.form.submit()"><option value="">Scegli l\'impresa…</option>'+
  I.map(function(x){return '<option value="'+es(x.id)+'"'+(az&&az.id===x.id?' selected':'')+'>'+es(x.nome)+'</option>';}).join('')+'</select></label></form>';}

// nuovo preventivo
function nuovo(){
 var C=(D.cantieri||[]).filter(function(c){return c.stato!=='chiuso'||c.id===FIL.cant;});
 $('pv-n-cant').innerHTML=C.map(function(c){return '<option value="'+es(c.id)+'">'+es(c.nome)+(c.contratto?' · con il contratto':'')+'</option>';}).join('')+'<option value="">Senza cantiere (lavoro nuovo)</option>';
 $('pv-n-cant').value=FIL.cant&&FIL.cant!=='senza'?FIL.cant:(FIL.cant==='senza'||!C.length?'':(CFG.c||C[0].id));
 $('pv-rubrica').innerHTML=(D.rubrica||[]).map(function(r){return '<option value="'+es(r.nome)+'">'+es([r.impresa,r.email].filter(Boolean).join(' · '))+'</option>';}).join('');
 ['pv-n-titolo','pv-n-cliente','pv-n-dove','pv-n-email','pv-n-piva'].forEach(function(i){$(i).value='';});
 riempiCant();msg($('pv-n-msg'),'');velo('pv-v-nuovo',true);
}
function riempiCant(){var id=$('pv-n-cant').value,c=(D.cantieri||[]).filter(function(x){return x.id===id;})[0];
 if(c){$('pv-n-cliente').value=c.committente||'';$('pv-n-dove').value=c.ubicazione||'';}else{$('pv-n-cliente').value='';$('pv-n-dove').value='';}}
$('pv-n-cant').onchange=riempiCant;
$('pv-n-cliente').onchange=function(){var r=(D.rubrica||[]).filter(function(x){return x.nome===$('pv-n-cliente').value;})[0];
 if(r){if(!$('pv-n-email').value)$('pv-n-email').value=r.email||'';if(!$('pv-n-piva').value)$('pv-n-piva').value=r.partita_iva||'';}};
$('pv-n-crea').onclick=function(){var b=this;b.disabled=true;msg($('pv-n-msg'),'Un momento…');
 api('nuovo',{commessa_id:$('pv-n-cant').value,titolo:$('pv-n-titolo').value,cliente_nome:$('pv-n-cliente').value,indirizzo_lavoro:$('pv-n-dove').value,
  cliente_email:$('pv-n-email').value,cliente_piva:$('pv-n-piva').value}).then(function(r){b.disabled=false;
  if(r&&r.esito==='ok'){apri(r.id);return;}msg($('pv-n-msg'),msgErr(r),'ko');});};

// ---------------------------------------------------------------- preventivo
var P=null,F=null,FONTE='',ULTIMA='';
function carica(){return api('dati',{id:CFG.id}).then(function(r){if(r&&r.esito==='ok'){D=r;disegna();caricaIa();caricaCant();}else{$('pv-app').innerHTML='<section class="pv-card"><p class="pv-msg ko">'+es(msgErr(r))+'</p></section>';}});}
function disegna(){
 F=D.preventivo;var bozza=D.stato==='bozza',T=F.totali||{},k=F.contratto,c=F.cantiere;
 var rib=num(k&&k.ribasso_pct);
 var h='<div class="pv-due"><section class="pv-card"><div class="pv-testa"><div><p class="pv-chi">'+es(F.codice)+' · Rev. '+F.revisione+' · '+statoHtml(D.stato)+'</p><h1>'+es(F.titolo)+'</h1></div>'+
  '<div class="pv-az-t">'+bottoniStato()+'</div></div>'+esitoHtml();
 // intestazione
 h+='<div class="pv-campi">'+
  campo('titolo','Che lavoro è',F.titolo,'l2',200)+
  (c?'<div class="pv-c"><span class="pv-et">Cantiere</span><div class="pv-fisso">'+es(c.nome)+'</div></div>':'<div class="pv-c"><span class="pv-et">Cantiere</span><div class="pv-fisso">Senza cantiere</div></div>')+
  campo('cliente_nome','Cliente',F.cliente&&F.cliente.nome,'',200)+campo('cliente_indirizzo','Indirizzo del cliente',F.cliente&&F.cliente.indirizzo,'',300)+
  campo('cliente_piva','Partita IVA o codice fiscale',F.cliente&&F.cliente.piva,'',40)+campo('cliente_email','Email del cliente',F.cliente&&F.cliente.email,'',200)+
  campo('indirizzo_lavoro','Dove si fa il lavoro',F.indirizzo_lavoro,'',300)+campo('validita_giorni','Validità (giorni)',F.validita_giorni,'',4)+
  '<label class="pv-c"><span class="pv-et">Prezzario</span><select data-c="prezzario_id"'+(bozza?'':' disabled')+'>'+(D.prezzari||[]).map(function(z){return '<option value="'+z.id+'"'+(Number(D.prezzario_id)===Number(z.id)?' selected':'')+'>'+es(z.titolo)+'</option>';}).join('')+'<option value=""'+(D.prezzario_id?'':' selected')+'>Nessuno</option></select></label>'+
  (c?'<label class="pv-c"><span class="pv-et">Ribasso del contratto <small>'+(k?cifra(rib,2)+' %':'nessun contratto nel SAL')+'</small></span><span class="pv-interr"><input type="checkbox" data-c="ribasso_applicato"'+(F.ribasso_applicato?' checked':'')+(bozza&&k?'':' disabled')+'>'+(F.ribasso_applicato&&k?'Applicato':'Non applicato')+'</span></label>':'')+
  campo('oneri_sicurezza','Oneri della sicurezza + IVA (€)',txt2(D.oneri_sicurezza),'',16)+campo('sconto','Sconto (€)',txt2(D.sconto),'',16)+
  '<label class="pv-c tutta"><span class="pv-et">Note per il cliente <small>facoltative, vanno nel preventivo</small></span><textarea data-c="note" rows="2" maxlength="2000"'+(bozza?'':' disabled')+'>'+es(F.note||'')+'</textarea></label></div>'+
  (bozza?'<div class="pv-az"><button type="button" class="pv-b sm pv-pr" id="pv-salva-int">Salva i dati</button><span class="pv-msg" id="pv-int-msg"></span></div>':'');
 if(c&&!k)h+='<p class="pv-info">Nel cantiere non c\'è un computo caricato nella sezione SAL: le voci si prendono dal prezzario o si scrivono a mano.</p>';
 // «Prepara con TIX» (lo riempie disegnaIa)
 if(bozza)h+='<div id="pv-ia"></div>';
 if(D.stato==='accettato')h+='<div id="pv-cant"></div>';
 // ricerca
 if(bozza){
  h+='<div class="pv-cerca"><h3>Aggiungi una voce</h3><label class="pv-barra"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5"/></svg>'+
   '<input id="pv-q" placeholder="Scrivi il lavoro o il codice, per esempio «massetto» o «demolizione tramezzi»" autocomplete="off" value="'+es(ULTIMA)+'"><span id="pv-q-n"></span></label>'+
   '<div class="pv-fonti">'+fchip('','Tutte')+(k?fchip('contratto','Contratto'):'')+(D.prezzario_id?fchip('prezzario',nomePrezzario())+fchip('elementari','Materiali, noli e manodopera'):'')+'</div>'+
   '<div class="pv-ris" id="pv-ris"></div><div class="pv-altre"><button type="button" class="pv-b sm" id="pv-libera">+ Voce libera</button></div></div>';
 }
 // voci
 var V=F.voci||[];
 var VI=bozza&&IA&&IA.voci_ia||{},nIa=0,nVerdi=0;
 V.forEach(function(v){var x=VI[String(v.id)];if(x&&!x.confermata){nIa++;if(x.livello==='verde')nVerdi++;}});
 h+='<div class="pv-voci"><h3>Voci del preventivo</h3>';
 if(nIa)h+='<div class="pv-ia-barra">Voci preparate da TIX da controllare: '+nIa+' <button type="button" class="pv-b sm pv-pr" data-iaaz="conferma_verdi"'+(nVerdi?'':' disabled')+'>Conferma tutte le verdi ('+nVerdi+')</button>'+
  '<button type="button" class="pv-b sm" data-iaaz="togli_ia">Togli le voci di TIX non controllate</button></div>';
 if(!V.length)h+='<p class="pv-vuoto">Nessuna voce ancora.'+(bozza?' Cercala qui sopra o aggiungi una voce libera.':'')+'</p>';
 else h+='<div class="pv-vt th"><span>Nr</span><span>Fonte</span><span>Descrizione</span><span>U.M.</span><span class="n">Quantità</span><span class="n">Prezzo</span><span class="n">Importo</span></div>';
 // 04/11/2026 (preventivi-computo-1): super-categorie e categorie del computo con il totale, voci fuori dal totale, extra computo
 var kS=null,kC=null,sc=0,cc='',ex=false,se=0,ss=0;
 function capT(){if(cc)h+='<div class="pv-capt"><span>Totale '+es(cc)+'</span><b>'+euro(sc)+'</b></div>';sc=0;}
 function sezT(){if(kS)h+='<div class="pv-capt sez"><span>Totale '+es(kS)+'</span><b>'+euro(ss)+'</b></div>';ss=0;}
 V.forEach(function(v,i){var x=VI[String(v.id)],daVedere=x&&!x.confermata,st=v.stato||'ok',conta=st==='ok'||st==='da_verificare',dentro=v.extra?conta&&num(v.prezzo)>0:v.nel_totale!==false;
  if(v.extra&&!ex){if(kC!==null){capT();sezT();}kC=null;ex=true;h+='<div class="pv-cap ex">Extra computo – lavorazioni rilevate dagli elaborati <small>non comprese nel totale del preventivo</small></div>';}
  if(!v.extra){var ks=((v.sez_n!=null?'SpCat '+v.sez_n+' ':'')+(v.sez_nome||'')).trim(),kc=ks+'|'+(v.cat_n!=null?v.cat_n:'')+'|'+(v.cat_nome||'');
   if(kc!==kC){if(kC!==null){capT();if(ks!==kS)sezT();}cc=(v.cat_n!=null||v.cat_nome)?('Cat '+(v.cat_n!=null?v.cat_n+' ':'')+(v.cat_nome||'')).trim():'';
    if(ks!==kS&&ks)h+='<div class="pv-cap sez">'+es(ks)+'</div>';if(cc)h+='<div class="pv-cap">'+es(cc)+'</div>';kS=ks;kC=kc;}
   if(dentro){sc+=num(v.importo);ss+=num(v.importo);}}
  else if(conta)se+=num(v.importo);
  h+='<div class="pv-vt'+(x?' ia-'+es(x.livello)+(x.confermata?' ia-ok':''):'')+(dentro?'':' fuori')+'"><span class="nr">'+(i+1)+'</span><span class="fo">'+fonteHtml(v.fonte,v.codice)+'</span><div class="ds">'+(x?tagIa(x):'')+statoV(v)+'<p class="pv-ds corta" title="Tocca per leggerla tutta">'+es(v.descrizione)+'</p>'+rifV(v)+
   (v.fonte!=='libera'&&!v.ribassabile?'<span class="pv-agg">senza ribasso</span>':'')+(v.fonte==='libera'?'<span class="pv-agg">voce dell\'impresa, senza ribasso</span>':'')+
   (v.prezzo_origine!=null&&num(v.prezzo_origine)!==num(v.prezzo)?'<span class="pv-agg">prezzo di partenza '+euro(v.prezzo_origine)+'</span>':'')+
   (daVedere&&x.fonte?'<span class="pv-agg">Da: '+es(x.fonte)+'</span>':'')+(daVedere&&x.nota?'<span class="pv-agg">'+es(x.nota)+'</span>':'')+'</div>'+
   '<span class="um">'+es(v.unita||'')+'</span><span class="n q">'+qta(v.quantita)+'</span><span class="n pu">'+euro(v.prezzo)+'</span><span class="n im">'+euro(v.importo)+'</span>'+
   (v.misure&&v.misure.length?misureHtml(v.misure):'')+
   (bozza?'<div class="pv-vbt">'+(daVedere?(num(v.prezzo)?'<button type="button" class="pv-b sm pv-pr" data-iaok="'+v.id+'">Va bene</button>':'<button type="button" class="pv-b sm pv-pr" data-mod="'+v.id+'">Metti il prezzo</button>')+
    ((x.alternative||[]).length?'<button type="button" class="pv-b sm" data-iaalt="'+v.id+'">Scegli un\'altra ('+x.alternative.length+')</button>':''):'')+
    '<button type="button" class="pv-b sm" data-mod="'+v.id+'">Modifica</button><button type="button" class="pv-b sm pv-arg" data-su="'+v.id+'"'+(i?'':' disabled')+'>↑</button><button type="button" class="pv-b sm pv-arg" data-giu="'+v.id+'"'+(i<V.length-1?'':' disabled')+'>↓</button>'+
    (daVedere?'<button type="button" class="pv-b sm pv-togli" data-iatogli="'+v.id+'">Togli</button>':'')+'</div>':'')+'</div>';});
 if(!ex&&kC!==null){capT();sezT();}
 if(ex)h+='<div class="pv-capt ex"><span>Totale extra computo (non compreso nel totale)</span><b>'+euro(se)+'</b></div>';
 h+='</div>';
 // revisioni
 if((D.revisioni||[]).length){h+='<div class="pv-voci"><h3>Revisioni mandate</h3><ul class="pv-revs">'+D.revisioni.map(function(r){
  return '<li><b>Rev. '+r.revisione+'</b> · mandata il '+dt(r.mandato_il)+(r.mandato_da?' da '+es(r.mandato_da):'')+' · '+euro(r.totale)+' + IVA · impronta <code>'+es(String(r.sha256).slice(0,12))+'…</code> · '+
   '<a href="'+es(CFG.stampa+'?t='+CFG.t+'&id='+F.id+'&rev='+r.revisione)+'" target="_blank" rel="noopener">Stampa o PDF</a> · <a href="'+es(CFG.excel+'?t='+CFG.t+'&id='+F.id+'&rev='+r.revisione)+'">Excel</a></li>';}).join('')+'</ul></div>';}
 h+='</section>';
 // 08/11/2026 (preventivi-offerte-1): richieste di offerta ed email al DL
 h+='<section class="pv-card pv-of"><h2>Fornitori e Direttore dei Lavori</h2><p>Chiedi i prezzi delle voci da quotare a fornitori e subappaltatori, e manda al DL le cose da chiarire.</p><button type="button" class="pv-b pv-pr" data-ofapri>Richieste di offerta</button><button type="button" class="pv-b" data-chapri>Email al Direttore dei Lavori</button></section>';
 // totale
 h+='<section class="pv-card pv-riep"><h2>Totale</h2>'+
  '<div class="pv-rr"><span>Voci con il ribasso</span><b>'+euro(T.soggetto)+'</b></div>'+
  (num(T.ribasso_pct)>0?'<div class="pv-rr rib"><span>Ribasso del contratto '+cifra(num(T.ribasso_pct),2)+' %</span><b>− '+euro(T.ribasso)+'</b></div>':'')+
  '<div class="pv-rr"><span>Voci senza ribasso</span><b>'+euro(T.non_soggetto)+'</b></div>'+
  '<div class="pv-rr"><span>Totale lavori</span><b>'+euro(T.lavori)+'</b></div>'+
  '<div class="pv-rr"><span>Oneri della sicurezza (senza ribasso)</span><b>'+euro(T.oneri)+'</b></div>'+
  (num(T.sconto)?'<div class="pv-rr"><span>Sconto</span><b>− '+euro(T.sconto)+'</b></div>':'')+
  '<div class="pv-rr tot"><span>Totale del preventivo</span><b>'+euro(T.totale)+'<small>+ IVA</small></b></div>'+
  (num(T.fuori_totale)?'<div class="pv-rr fuori"><span>Voci del computo fuori dal totale (NP o da quotare)</span><b>'+num(T.fuori_totale)+'</b></div>':'')+
  (num(T.extra_voci)?'<div class="pv-rr fuori"><span>Extra computo, non compreso ('+pl(T.extra_voci,'voce','voci')+')</span><b>'+euro(T.extra)+'</b></div>':'')+
  controlliHtml(D.controlli)+
  '<div class="pv-bott"><div class="riga"><a class="pv-b" href="'+es(CFG.stampa+'?t='+CFG.t+'&id='+F.id)+'" target="_blank" rel="noopener">'+(bozza?'Anteprima':'Stampa o PDF')+'</a><a class="pv-b pv-xl" href="'+es(CFG.excel+'?t='+CFG.t+'&id='+F.id)+'">Scarica Excel</a></div>'+
  (bozza?'<button type="button" class="pv-b pv-pr" data-az="manda">Segna come mandato</button>':'')+'</div>'+
  (bozza?'<p class="pv-avviso">Quando lo segni come mandato, questa revisione resta così, con la sua impronta. Se poi cambi qualcosa, nasce la <b>Rev. '+(F.revisione+1)+'</b>.</p>':'')+
  '<p class="pv-msg" id="pv-az-msg" aria-live="polite"></p></section></div>';
 $('pv-app').innerHTML=h;
 lega();
 disegnaIa();
 if(bozza&&ULTIMA)cerca();
}
function nomePrezzario(){var z=(D.prezzari||[]).filter(function(x){return Number(x.id)===Number(D.prezzario_id);})[0];return z?z.titolo:'Prezzario';}
function campo(k,et,v,cl,max){var bozza=D.stato==='bozza';return '<label class="pv-c'+(cl?' '+cl:'')+'"><span class="pv-et">'+es(et)+'</span><input data-c="'+k+'" maxlength="'+max+'" value="'+es(v==null?'':v)+'"'+(bozza?'':' disabled')+'></label>';}
function fchip(v,t){return '<button type="button" class="pv-chip'+(FONTE===v?' on':'')+'" data-fonte="'+v+'">'+es(t)+'</button>';}
function misureHtml(M){return '<div class="pv-misv"><div class="h"><span>Dove</span><span>Parti</span><span>Lungh.</span><span>Largh.</span><span>H/peso</span><span>Quantità</span></div>'+
 M.map(function(m){return '<div><span>'+es(m.dove||'')+'</span><span>'+nv(m.parti)+'</span><span>'+nv(m.lun)+'</span><span>'+nv(m.lar)+'</span><span>'+nv(m.alt)+'</span><span>'+qta(m.q)+'</span></div>';}).join('')+'</div>';}
function nv(x){return x==null||x===''?'':String(x).replace('.',',');}
function bottoniStato(){var s=D.stato,h='';
 if(s==='bozza'){if(F.revisione===1&&!(D.revisioni||[]).length)h+='<button type="button" class="pv-b pv-togli pv-elim" data-az="elimina">'+CESTINO+'Elimina la bozza</button>';}
 if(s==='mandato')h+='<button type="button" class="pv-b sm pv-ok" data-az="accettato">Segna accettato</button><button type="button" class="pv-b sm" data-az="rifiutato">Segna rifiutato</button><button type="button" class="pv-b sm" data-az="revisione">Cambialo (Rev. '+(F.revisione+1)+')</button>';
 if(s==='accettato'){h+=D.firmato?'<a class="pv-b sm pv-ok" href="'+es(CFG.firmato+'?t='+CFG.t+'&id='+F.id)+'">Scarica la copia firmata</a><button type="button" class="pv-b sm" data-az="firmato">Sostituisci la copia firmata</button>':'<button type="button" class="pv-b sm pv-pr" data-az="firmato">Carica la copia firmata</button><button type="button" class="pv-b sm" data-az="annulla_esito">Togli l\'accettazione</button>';}
 if(s==='rifiutato')h+='<button type="button" class="pv-b sm" data-az="revisione">Rifallo (Rev. '+(F.revisione+1)+')</button><button type="button" class="pv-b sm" data-az="annulla_esito">Togli il rifiuto</button>';
 return h;}
function esitoHtml(){var s=D.stato;
 if(s==='mandato')return '<p class="pv-info">Mandato il '+dt(D.mandato_il)+(D.valido_fino?' · valido fino al '+dt(D.valido_fino):'')+'. Non si cambia più: per cambiarlo fai una revisione nuova.</p>';
 if(s==='accettato')return '<div class="pv-esito">✓ Accettato il '+dt(D.esito_il)+(D.esito_chi?' da '+es(D.esito_chi):'')+(D.esito_nota?' · '+es(D.esito_nota):'')+
  (D.firmato?' · copia firmata caricata il '+dt(D.firmato.il)+' («'+es(D.firmato.nome||'file')+'»)':'')+'</div>';
 if(s==='rifiutato')return '<div class="pv-esito ko">Rifiutato il '+dt(D.esito_il)+(D.esito_nota?' · '+es(D.esito_nota):'')+'</div>';
 return '';}
function lega(){
 var app=$('pv-app');
 var si=$('pv-salva-int');if(si)si.onclick=salvaInt;
 Array.prototype.forEach.call(app.querySelectorAll('[data-c="ribasso_applicato"]'),function(x){x.onchange=salvaInt;});
 Array.prototype.forEach.call(app.querySelectorAll('.pv-ds.corta'),function(p){p.onclick=function(){p.classList.toggle('corta');};});
 Array.prototype.forEach.call(app.querySelectorAll('[data-mod]'),function(b){b.onclick=function(){var v=(F.voci||[]).filter(function(x){return String(x.id)===b.getAttribute('data-mod');})[0];if(v)modulo(v);};});
 Array.prototype.forEach.call(app.querySelectorAll('[data-su],[data-giu]'),function(b){b.onclick=function(){var su=b.hasAttribute('data-su');
  api('sposta_voce',{id:F.id,voce_id:b.getAttribute(su?'data-su':'data-giu'),verso:su?'su':'giu'}).then(function(r){if(r&&r.esito==='ok')carica();else alert(msgErr(r));});};});
 Array.prototype.forEach.call(app.querySelectorAll('[data-az]'),function(b){b.onclick=function(){azione(b.getAttribute('data-az'),b);};});
 Array.prototype.forEach.call(app.querySelectorAll('[data-fonte]'),function(b){b.onclick=function(){FONTE=b.getAttribute('data-fonte');Array.prototype.forEach.call(app.querySelectorAll('[data-fonte]'),function(x){x.classList.toggle('on',x===b);});cerca();};});
 var q=$('pv-q');if(q){var tm=null;q.oninput=function(){clearTimeout(tm);tm=setTimeout(cerca,350);};q.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();clearTimeout(tm);cerca();}};}
 var lib=$('pv-libera');if(lib)lib.onclick=function(){modulo({fonte:'libera',descrizione:'',unita:'',prezzo:'',quantita:'',misure:[]});};
 // voci preparate da TIX
 Array.prototype.forEach.call(app.querySelectorAll('[data-iaok]'),function(b){b.onclick=function(){b.disabled=true;
  api('ia_conferma',{id:F.id,voce_id:b.getAttribute('data-iaok')}).then(function(r){if(r&&r.esito==='ok')carica();else{b.disabled=false;alert(msgErr(r));}});};});
 Array.prototype.forEach.call(app.querySelectorAll('[data-iatogli]'),function(b){b.onclick=function(){if(!confirm('Togliere questa voce dal preventivo?'))return;b.disabled=true;
  api('togli_voce',{id:F.id,voce_id:b.getAttribute('data-iatogli')}).then(function(r){if(r&&r.esito==='ok')carica();else{b.disabled=false;alert(msgErr(r));}});};});
 Array.prototype.forEach.call(app.querySelectorAll('[data-iaalt]'),function(b){b.onclick=function(){alternative(b.getAttribute('data-iaalt'));};});
 Array.prototype.forEach.call(app.querySelectorAll('[data-iaaz]'),function(b){b.onclick=function(){var az=b.getAttribute('data-iaaz');
  if(az==='togli_ia'&&!confirm('Togliere tutte le voci preparate da TIX che non hai ancora controllato?'))return;b.disabled=true;
  api('ia_'+az,{id:F.id}).then(function(r){if(r&&r.esito==='ok')carica();else{b.disabled=false;alert(msgErr(r));}});};});
}
function salvaInt(){var d={id:F.id};Array.prototype.forEach.call(document.querySelectorAll('#pv-app [data-c]'),function(x){var k=x.getAttribute('data-c');d[k]=x.type==='checkbox'?x.checked:x.value;});
 var m=$('pv-int-msg');if(m){m.textContent='Un momento…';m.className='pv-msg';}
 api('intestazione',d).then(function(r){if(r&&r.esito==='ok'){carica();}else{if(m){m.textContent=msgErr(r);m.className='pv-msg ko';}else alert(msgErr(r));}});}
var NCERCA=0;
function cerca(){var q=$('pv-q');if(!q)return;var t=q.value.trim();ULTIMA=q.value;var box=$('pv-ris');
 if(t.length<2){box.innerHTML='';$('pv-q-n').textContent='';return;}
 var n=++NCERCA;$('pv-q-n').textContent='cerco…';
 api('cerca',{id:F.id,testo:t,fonte:FONTE}).then(function(r){if(n!==NCERCA)return;
  if(!r||r.esito!=='ok'){box.innerHTML='<p class="pv-msg ko">'+es(msgErr(r))+'</p>';$('pv-q-n').textContent='';return;}
  var L=(r.contratto||[]).concat(r.prezzario||[]);$('pv-q-n').textContent=L.length?(L.length+(L.length>=40?'+':'')+' voci'):'nessuna voce';
  box.innerHTML=L.length?L.map(function(x,i){var desc=x.fonte==='prezzario'?(x.titolo+(x.descrizione&&x.descrizione!==x.titolo?' — '+x.descrizione:'')):(x.titolo&&x.descrizione&&x.descrizione.indexOf(x.titolo)!==0?x.titolo+' — '+x.descrizione:(x.descrizione||x.titolo||''));
   return '<div class="pv-ri">'+fonteHtml(x.fonte,x.codice,x.elementare)+'<p>'+es(desc.length>260?desc.slice(0,257)+'…':desc)+(x.fonte==='prezzario'&&x.settore?'<small>'+es(x.settore)+'</small>':'')+'</p>'+
    '<span class="um">'+es(x.unita||'')+'</span><span class="pr"><b>'+euro(x.prezzo)+'</b>'+(x.prezzo_ribassato!=null?'<small>'+euro(x.prezzo_ribassato)+' con il ribasso</small>':(x.fonte!=='prezzario'&&x.ribassabile===false?'<small>senza ribasso</small>':''))+'</span>'+
    '<button type="button" class="pv-b sm pv-pr" data-i="'+i+'">Aggiungi</button></div>';}).join(''):'<p class="pv-vuoto">Nessuna voce trovata. Prova con un\'altra parola, oppure aggiungi una voce libera.</p>';
  Array.prototype.forEach.call(box.querySelectorAll('[data-i]'),function(b){b.onclick=function(){aggiungi(L[Number(b.getAttribute('data-i'))],b);};});});}
function aggiungi(x,b){var v={fonte:x.fonte,rif:x.rif,codice:x.codice,unita:x.unita,prezzo:x.prezzo,prezzo_origine:x.prezzo,quantita:'',misure:[],ribassabile:x.ribassabile,
 descrizione:x.fonte==='prezzario'?(x.titolo+(x.descrizione&&x.descrizione!==x.titolo?' — '+x.descrizione:'')):(x.descrizione||x.titolo||'')};
 if(x.fonte!=='prezzario'){modulo(v);return;}
 b.disabled=true;api('estesa',{id:F.id,rif:x.rif}).then(function(r){b.disabled=false;if(r&&r.esito==='ok'&&r.descrizione)v.descrizione=r.descrizione;modulo(v);});}

// modulo della voce
var VOCE=null;
function modulo(v){VOCE=v;var nuova=!v.id,lib=v.fonte==='libera';
 $('pv-vo-t').textContent=nuova?(lib?'Nuova voce libera':'Nuova voce'):'Modifica la voce';
 $('pv-vo-fonte').innerHTML=lib?'Voce scritta dall\'impresa, senza ribasso.':(v.fonte==='contratto'?'Dall\'elenco prezzi del contratto':'Dal '+es(nomePrezzario()))+(v.codice?' · codice <b>'+es(v.codice)+'</b>':'')+(v.ribassabile===false?' · senza ribasso':'');
 $('pv-vo-c-cod').hidden=!lib;$('pv-vo-c-um').hidden=!lib;
 $('pv-vo-cod').value=v.codice||'';$('pv-vo-um').value=v.unita||'';$('pv-vo-descr').value=v.descrizione||'';
 $('pv-vo-prezzo').value=v.prezzo===''||v.prezzo==null?'':txt2(v.prezzo);
 $('pv-vo-orig').textContent=v.prezzo_origine!=null&&!lib?'di partenza '+euro(v.prezzo_origine):'';
 $('pv-vo-q').value=v.quantita===''||v.quantita==null||(nuova&&!num(v.quantita))?'':txt2(v.quantita);
 $('pv-vo-um2').textContent=v.unita?'in '+v.unita:'';
 var M=$('pv-vo-mis');M.innerHTML='<div class="pv-mis-r h"><span>Dove</span><span class="parti">Parti</span><span>Lungh.</span><span>Largh.</span><span class="alt">H/peso</span><span class="q">Quantità</span><span></span></div>';
 (v.misure||[]).forEach(function(m){riga(m);});
 $('pv-vo-togli').hidden=nuova;msg($('pv-vo-msg'),'');ricalcola();velo('pv-v-voce',true);
}
function riga(m){m=m||{};var r=document.createElement('div');r.className='pv-mis-r';
 var fat=['parti','lun','lar','alt'].some(function(k){return m[k]!=null&&m[k]!=='';});
 r.innerHTML='<input data-m="dove" maxlength="300" placeholder="es. Ingresso" value="'+es(m.dove||'')+'"><input class="parti" data-m="parti" inputmode="decimal" value="'+es(nv(m.parti))+'"><input data-m="lun" inputmode="decimal" value="'+es(nv(m.lun))+'">'+
  '<input data-m="lar" inputmode="decimal" value="'+es(nv(m.lar))+'"><input class="alt" data-m="alt" inputmode="decimal" value="'+es(nv(m.alt))+'"><input class="q" data-m="q" inputmode="decimal" title="Senza parti e dimensioni: scrivi la quantità della riga" value="'+es(fat||m.q==null?'':nv(m.q))+'"><button type="button" title="Togli la riga">×</button>';
 r.querySelector('button').onclick=function(){r.parentNode.removeChild(r);ricalcola();};
 Array.prototype.forEach.call(r.querySelectorAll('input'),function(i){i.oninput=ricalcola;});
 $('pv-vo-mis').appendChild(r);}
$('pv-vo-riga').onclick=function(){riga({});ricalcola();var r=$('pv-vo-mis').lastChild;if(r)r.querySelector('input').focus();};
function misure(){return Array.prototype.map.call($('pv-vo-mis').querySelectorAll('.pv-mis-r:not(.h)'),function(r){var o={};Array.prototype.forEach.call(r.querySelectorAll('input'),function(i){o[i.getAttribute('data-m')]=i.value;});return o;});}
// 06/11/2026 (preventivi-computo-2): con parti o dimensioni la quantità della riga è il loro prodotto (casella bloccata); senza,
// si scrive la quantità della riga, come le righe «Vedi voce n. …» dei computi
function ricalcola(){var M=misure(),tot=0,usa=false,err=false;
 Array.prototype.forEach.call($('pv-vo-mis').querySelectorAll('.pv-mis-r:not(.h)'),function(r,i){var m=M[i],q=null,cq=r.querySelector('input.q');['parti','lun','lar','alt'].forEach(function(k){var n=inNum(m[k]);if(n===null)return;if(isNaN(n)){err=true;return;}q=(q===null?1:q)*n;});
  if(q!==null){cq.disabled=true;cq.value=qta(q);}
  else{if(cq.disabled){cq.disabled=false;cq.value='';}var nq=inNum(cq.value);if(nq!==null){if(isNaN(nq))err=true;else q=nq;}}
  if(q!==null||String(m.dove||'').trim())usa=true;tot+=q||0;});
 $('pv-vo-q').disabled=usa;if(usa)$('pv-vo-q').value=txt2(tot);
 var p=inNum($('pv-vo-prezzo').value),q=inNum($('pv-vo-q').value);
 $('pv-vo-imp').textContent=err?'Nelle righe di misura scrivi solo numeri.':(p!==null&&!isNaN(p)&&q!==null&&!isNaN(q)?'Importo: '+euro(Math.round(p*q*100)/100):'');}
$('pv-vo-prezzo').oninput=ricalcola;$('pv-vo-q').oninput=ricalcola;
$('pv-vo-salva').onclick=function(){var b=this,v=VOCE,lib=v.fonte==='libera',M=misure().filter(function(m){return String(m.dove||'').trim()||m.parti||m.lun||m.lar||m.alt||m.q;}).map(function(m){if(m.parti||m.lun||m.lar||m.alt)m.q='';return m;});
 var d={id:F.id,descrizione:$('pv-vo-descr').value,prezzo:$('pv-vo-prezzo').value,quantita:M.length?'':$('pv-vo-q').value,misure:M};
 if(v.id)d.voce_id=String(v.id);else{d.fonte=v.fonte;if(v.rif)d.rif=v.rif;}
 if(lib){d.codice=$('pv-vo-cod').value;d.unita=$('pv-vo-um').value;}
 if(!M.length&&!String($('pv-vo-q').value).trim()){msg($('pv-vo-msg'),'Scrivi la quantità, oppure le righe di misura.','ko');return;}
 b.disabled=true;msg($('pv-vo-msg'),'Un momento…');
 api('voce',d).then(function(r){b.disabled=false;if(r&&r.esito==='ok'){velo('pv-v-voce',false);
  // una voce di TIX corretta a mano è controllata
  var x=v.id&&IA&&IA.voci_ia&&IA.voci_ia[String(v.id)];if(x&&!x.confermata)api('ia_conferma',{id:F.id,voce_id:String(v.id)}).then(carica);else carica();}
  else msg($('pv-vo-msg'),msgErr(r),'ko');});};
$('pv-vo-togli').onclick=function(){if(!VOCE||!VOCE.id||!confirm('Togliere questa voce dal preventivo?'))return;
 api('togli_voce',{id:F.id,voce_id:String(VOCE.id)}).then(function(r){if(r&&r.esito==='ok'){velo('pv-v-voce',false);carica();}else msg($('pv-vo-msg'),msgErr(r),'ko');});};

// azioni sullo stato
var ESITO='';
function azione(az,b){var m=$('pv-az-msg');
 if(az==='accettato'||az==='rifiutato'){ESITO=az;$('pv-es-t').textContent=az==='accettato'?'Il cliente l\'ha accettato':'Il cliente l\'ha rifiutato';
  $('pv-es-data').value=oggiIso();$('pv-es-data').max=oggiIso();$('pv-es-chi').value=az==='accettato'?((F.cliente&&F.cliente.nome)||''):'';$('pv-es-c-chi').hidden=az!=='accettato';
  $('pv-es-nota').value='';msg($('pv-es-msg'),'');velo('pv-v-esito',true);return;}
 if(az==='firmato'){$('pv-file').value='';$('pv-file').click();return;}
 var dom={manda:'Segnarlo come mandato? Da quel momento la Rev. '+F.revisione+' non si cambia più.',revisione:'Fare la Rev. '+(F.revisione+1)+'? La Rev. '+F.revisione+' resta com\'era, con la sua impronta.',
  elimina:'Eliminare questa bozza? Non è mai stata mandata.',annulla_esito:'Togliere l\'esito e tornare a «Mandato»?'}[az];
 if(dom&&!confirm(dom))return;
 if(b)b.disabled=true;if(m){m.textContent='Un momento…';m.className='pv-msg';}
 api(az,{id:F.id}).then(function(r){if(b)b.disabled=false;
  if(r&&r.esito==='ok'){if(az==='elimina'){location.href=link('');return;}carica();}else{if(m){m.textContent=msgErr(r);m.className='pv-msg ko';}else alert(msgErr(r));}});}
$('pv-es-ok').onclick=function(){var b=this;b.disabled=true;msg($('pv-es-msg'),'Un momento…');
 api(ESITO,{id:F.id,data:$('pv-es-data').value,chi:$('pv-es-chi').value,nota:$('pv-es-nota').value}).then(function(r){b.disabled=false;
  if(r&&r.esito==='ok'){velo('pv-v-esito',false);carica();}else msg($('pv-es-msg'),msgErr(r),'ko');});};
$('pv-file').onchange=function(){var f=this.files&&this.files[0],m=$('pv-az-msg');if(!f)return;
 if(!/\.(pdf|p7m)$/i.test(f.name)){alert('Carica la copia firmata in PDF (anche con firma digitale: .pdf o .p7m).');return;}
 if(f.size>18*1024*1024){alert('Il file è troppo grande (massimo 18 MB).');return;}
 if(m){m.textContent='Carico «'+f.name+'»…';m.className='pv-msg';}
 fetch(CFG.firmato+'?t='+encodeURIComponent(CFG.t)+'&id='+encodeURIComponent(F.id)+'&nome='+encodeURIComponent(f.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:f})
  .then(function(r){return r.json().catch(function(){return {esito:'errore'};});}).catch(function(){return {esito:'rete'};})
  .then(function(r){if(r&&r.esito==='ok'){carica();}else if(m){m.textContent=msgErr(r);m.className='pv-msg ko';}});};

// ---------------------------------------------------------------- Prepara con TIX
var IA=null,IA_T=null,IA_MSG=null;
// logo vero di TIX (/marchio-tix.svg, senza il riflesso): spunta e lettere, disegnati una volta in testa al riquadro
var LOGO='<svg class="pv-tix-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>'+
 '<linearGradient id="pvt-g1" gradientUnits="userSpaceOnUse" x1="130" y1="300" x2="700" y2="950"><stop offset="0" stop-color="#FF9A3D"/><stop offset=".55" stop-color="#F26A10"/><stop offset="1" stop-color="#D9480A"/></linearGradient>'+
 '<linearGradient id="pvt-g2" gradientUnits="userSpaceOnUse" x1="1352" y1="503" x2="1868" y2="925"><stop offset="0" stop-color="#FF9A3D"/><stop offset=".5" stop-color="#F26A10"/><stop offset="1" stop-color="#D9480A"/></linearGradient>'+
 '<linearGradient id="pvt-g3" gradientUnits="userSpaceOnUse" x1="0" y1="503" x2="0" y2="925"><stop offset="0" stop-color="#3A5577"/><stop offset=".45" stop-color="#1B2F4A"/><stop offset="1" stop-color="#1B2F4A"/></linearGradient></defs>'+
 '<symbol id="pvt-spunta" viewBox="110 255 870 710"><path fill="url(#pvt-g1)" d="M130 682L178 636C208 608 248 612 268 640L343 746C515 500 700 328 962 270C760 365 598 560 434 878C404 936 334 948 296 902Z"/></symbol>'+
 '<symbol id="pvt-scritta" viewBox="742 493 1136 442"><path fill="url(#pvt-g3)" d="M838 503L1218 503L1200 605L1078 605L1018 925L890 925L950 605L752 605ZM1268 503L1392 503L1312 925L1188 925Z"/>'+
 '<path fill="url(#pvt-g2)" d="M1410 503L1550 503L1828 925L1688 925ZM1728 503L1868 503L1492 925L1352 925Z"/><path fill="none" stroke="#1B2F4A" stroke-width="11" stroke-linecap="round" d="M1615 708L1516 558M1615 708L1749 558M1615 708L1471 870M1615 708L1722 870"/>'+
 '<g fill="#1B2F4A"><circle cx="1516" cy="558" r="22"/><circle cx="1749" cy="558" r="22"/><circle cx="1471" cy="870" r="22"/><circle cx="1722" cy="870" r="22"/><circle cx="1615" cy="708" r="34"/></g></symbol></svg>';
// variante C scelta da Filippo il 03/11: la spunta come icona, le lettere TIX nel titolo e, su un'etichetta bianca, nel pulsante
var SPUNTA='<svg aria-hidden="true" focusable="false"><use href="#pvt-spunta"/></svg>';
var TIX='<svg class="pv-tix" role="img" aria-label="TIX"><use href="#pvt-scritta"/></svg>';
var TIXET='<span class="pv-tix-et">'+TIX+'</span>';
var NUVOLA='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';
var TIPI={computo:'Computo (Excel o PDF)',relazione:'Relazione (PDF)',tavole:'Tavole (PDF)'};
var PASSI={controllo:'Controllo dei file',stima:'Pronto da leggere',attesa:'In coda',lettura:'TIX sta leggendo'};
function usd(n){n=num(n);return n>0&&n<0.01?'meno di 0,01':n.toFixed(2).replace('.',',');}
function ora(x){var d=new Date(x);return isNaN(d)?'':String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
function mbTxt(n){n=num(n);return n<1048576?Math.max(1,Math.round(n/1024))+' KB':(n/1048576).toFixed(1).replace('.',',')+' MB';}
function pl(n,uno,tanti){n=num(n);return n+' '+(n===1?uno:tanti);}
// 05/11/2026 (preventivi-rilettura-1): «Rifai la lettura con gli stessi file» e link salvati del preventivo
var CATENA='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
var TIPI_IA={relazione:'Relazione',tavole:'Tavole',computo:'Computo (Excel o PDF)'};
function riprendiIa(){var r=IA&&IA.ripresa;if(!r)return '';var n=num(r.file)+num(r.link);
 if(!n)return num(r.persi)?'<p class="pv-ia-nota pv-ia-rip0">I file della lettura del '+dt(r.finita_il)+' sono già stati cancellati (restano 3 giorni): riallegali, oppure usa i link salvati.</p>':'';
 return '<div class="pv-ia-rip"><button type="button" class="pv-b pv-pr" id="pv-ia-riprendi">Rifai la lettura con gli stessi file</button><span class="pv-ia-nota">Riprende '+
  (num(r.file)?pl(r.file,'file','file'):'')+(num(r.file)&&num(r.link)?' e ':'')+(num(r.link)?pl(r.link,'link','link'):'')+' della lettura del '+dt(r.finita_il)+
  (num(r.file)?': i file restano fino al '+dt(r.scade_il)+' alle '+ora(r.scade_il)+'.':'.')+(num(r.persi)?' '+pl(r.persi,'file è già stato cancellato','file sono già stati cancellati')+': riallegalo.':'')+'</span></div>';}
function linkSalvatiIa(mod){var L=(IA&&IA.link_salvati)||[];if(!L.length)return '';
 return '<details class="pv-ia-links"><summary><span class="pv-arg pv-ia-lic">'+CATENA+'</span>Link salvati <small>'+L.length+'</small></summary>'+
  '<p class="pv-ia-nota">I link usati nelle letture di questo preventivo: copiali'+(mod?', oppure usali di nuovo con un tocco':' e incollali quando apri «Prepara con TIX»')+'.</p>'+
  L.map(function(x,i){return '<div class="pv-ia-lr"><div><b>'+es(x.nome||'Link')+'</b> <small>'+es(TIPI_IA[x.tipo]||x.tipo||'')+(x.il?' · '+dt(x.il):'')+'</small><code>'+es(x.link)+'</code></div>'+
   '<button type="button" class="pv-b sm" data-iacopia="'+i+'">Copia</button>'+(mod?'<button type="button" class="pv-b sm pv-pr" data-iariusa="'+i+'">Usa di nuovo</button>':'')+'</div>';}).join('')+'</details>';}
function legaRiprendiIa(){
 var rp=$('pv-ia-riprendi');if(rp)rp.onclick=function(){rp.disabled=true;msgIa('Un momento…');
  api('ia_nuova',{id:CFG.id,riprendi:true}).then(function(r){rp.disabled=false;if(r&&r.esito==='ok'){msgIa('');caricaIa();}else{msgIa(msgErr(r),'ko');if(!$('pv-ia-msg'))alert(msgErr(r));}});};
 var L=(IA&&IA.link_salvati)||[];
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-iacopia]'),function(b){b.onclick=function(){var x=L[Number(b.getAttribute('data-iacopia'))];if(!x)return;
  var fatto=function(){b.textContent='Copiato';setTimeout(function(){b.textContent='Copia';},1600);};
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(x.link).then(fatto,function(){prompt('Copia il link:',x.link);});else prompt('Copia il link:',x.link);};});
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-iariusa]'),function(b){b.onclick=function(){var x=L[Number(b.getAttribute('data-iariusa'))];if(!x)return;
  azIa('link',{link:x.link,tipo:x.tipo||'relazione'},b);};});}
// pagine dei PDF se si conoscono per tutti i file, altrimenti il numero dei file
function docTxt(p,n){p=num(p);n=num(n);return p?p+' pag.':n?pl(n,'file','file'):'0';}
// 04/11/2026 (preventivi-computo-1): stato della voce, da dove viene nel computo o negli elaborati, controlli del preventivo
function statoV(v){var s=v.stato||'ok';if(s==='ok')return '';return '<span class="pv-sv '+es(s)+'">'+es(({np:'NP – nuovo prezzo da analizzare',da_quotare:'Da quotare con l\'offerta del fornitore',da_verificare:'Da verificare',esclusa:'Esclusa'})[s]||s)+'</span>';}
function rifV(v){var a=[];if(v.nr_computo!=null)a.push('Computo n. '+v.nr_computo);if(v.codice_computo&&v.codice_computo!==v.codice)a.push('codice nel computo '+v.codice_computo);
 if(v.extra){if(v.riferimento)a.push('Da: '+v.riferimento);if(v.affidabilita)a.push('affidabilità: '+String(v.affidabilita).replace('_',' '));if(v.metodo)a.push(v.metodo);}
 return a.length?'<span class="pv-agg">'+es(a.join(' · '))+'</span>':'';}
function controlliHtml(c){if(!c)return '';var b=c.blocchi||[],a=c.avvisi||[],r=c.riepilogo||{};
 var h='<div class="pv-ctl'+(b.length?' ko':a.length?' at':' ok')+'"><b>Controlli</b>';
 if(!b.length&&!a.length)h+='<p>Nessun problema trovato.</p>';
 b.forEach(function(x){h+='<p class="bl">Da sistemare: '+es(x.testo)+'</p>';});
 a.forEach(function(x){h+='<p>'+es(x.testo)+'</p>';});
 if(r.voci_documento)h+='<small>Voci del computo lette: '+num(r.voci_computo_lette)+' su '+num(r.voci_documento)+'</small>';
 return h+'</div>';}
function tagIa(x){return '<span class="pv-ia-tag '+(x.confermata?'ok':es(x.livello))+'">'+(x.confermata?'TIX · controllata':({verde:'TIX · sicura',giallo:'TIX · da guardare',rosso:'TIX · da controllare'})[x.livello]||'TIX')+'</span>';}
function caricaIa(){if(!CFG.id)return;api('ia_dati',{id:CFG.id}).then(function(r){var prima=IA;IA=r&&r.esito==='ok'&&r.attiva?r:null;
 if(IA&&IA.voci_ia&&Object.keys(IA.voci_ia).length||prima&&prima.voci_ia&&Object.keys(prima.voci_ia).length)disegna();else disegnaIa();pianificaIa();});}
function inCorso(){var l=IA&&IA.lettura;return !!l&&['controllo','attesa','lettura'].indexOf(l.stato)>=0;}
function pianificaIa(){clearTimeout(IA_T);if(!inCorso())return;
 IA_T=setTimeout(function(){api('ia_dati',{id:CFG.id}).then(function(r){if(!(r&&r.esito==='ok'&&r.attiva)){pianificaIa();return;}
  var era=IA.lettura&&IA.lettura.stato;IA=r;if(era!=='pronta'&&IA.lettura&&IA.lettura.stato==='pronta'){carica();return;}disegnaIa();pianificaIa();});},6000);}
function msgIa(t,cl){IA_MSG=t?{t:t,cl:cl||''}:null;var m=$('pv-ia-msg');if(m)msg(m,t,cl);}
function disegnaIa(){var box=$('pv-ia');if(!box)return;if(!IA){box.innerHTML='';return;}
 var l=IA.lettura,s=l?l.stato:'',h;
 if(!l||['preparazione','controllo','stima','attesa','lettura'].indexOf(s)<0){
  h=LOGO+'<div class="pv-ia chiuso"><div class="pv-ia-t"><button type="button" class="pv-ia-ic" id="pv-ia-apri-ic" aria-label="Prepara con TIX">'+SPUNTA+'</button><div><h3>Prepara con '+TIX+'</h3><p>Allega quello che hai ricevuto: computo metrico <b>in Excel o in PDF stampato da PriMus</b>, tavole e relazioni in PDF, oppure i loro link. TIX li legge con l\'intelligenza artificiale e compila le voci con i prezzi del contratto e del prezzario; tu controlli e decidi: niente parte da solo.</p></div>'+
   '<button type="button" class="pv-b pv-pr" id="pv-ia-apri">'+'Prepara con '+TIXET+'</button></div>';
  if(s==='pronta')h+=esitoIa(l);
  if(s==='errore')h+='<p class="pv-msg ko">'+es(l.errore||'La lettura non è riuscita.')+'</p>';
  if(s==='annullata')h+='<p class="pv-msg">L\'ultima lettura è stata annullata.</p>';
  h+=ricontrollaIa()+riprendiIa()+linkSalvatiIa(false);
  box.innerHTML=h+'</div>';
  $('pv-ia-apri-ic').onclick=function(){$('pv-ia-apri').click();};
  $('pv-ia-apri').onclick=function(){var b=this;b.disabled=true;api('ia_nuova',{id:CFG.id}).then(function(r){b.disabled=false;if(r&&r.esito==='ok')caricaIa();else alert(msgErr(r));});};
  legaRiprendiIa();legaRicontrollaIa();
  return;}
 var mod=s==='preparazione'||s==='stima',F2=l.file||[];
 h=LOGO+'<div class="pv-ia"><div class="pv-ia-t"><span class="pv-ia-ic">'+SPUNTA+'</span><div><h3>Prepara con '+TIX+'</h3><p>'+
  (mod?'Il computo metrico in Excel o in PDF stampato da PriMus (non una scansione): TIX lo prende <b>tale quale</b>, con le descrizioni intere e le righe di misura. Tavole e relazioni in PDF. Prima TIX controlla i file e ti dice quanto costa; poi decidi tu se partire.':'Puoi chiudere la pagina: il lavoro continua e le voci compaiono qui sotto.')+'</p></div>'+
  '<button type="button" class="pv-b sm" id="pv-ia-annulla">Annulla</button></div>';
 if(mod){
  h+='<label class="pv-c tutta"><span class="pv-et">Cosa c\'è da fare <small>due righe con le tue parole: aiuta TIX a non sbagliare</small></span><textarea id="pv-ia-lavoro" rows="2" maxlength="1000" placeholder="es. Rifacimento dei due bagni al piano primo, sanitari forniti dal cliente">'+es(l.lavoro||'')+'</textarea></label>'+
   '<div class="pv-ia-cari"><label class="pv-ia-drop" id="pv-ia-drop"><input type="file" id="pv-ia-file" multiple accept=".xlsx,.xls,.xlsm,.ods,.csv,.pdf" hidden>'+NUVOLA+'<b>Aggiungi file (anche più di uno)</b><small>Computo metrico <b>in Excel o in PDF</b> · tavole e relazioni in PDF · fino a 18 MB per file</small></label>'+
   '<div class="pv-ia-link"><b>Oppure incolla un link</b><div class="pv-ia-lb"><input id="pv-ia-url" placeholder="https://drive.google.com/…" maxlength="600" autocomplete="off">'+
   '<select id="pv-ia-url-tipo"><option value="relazione">Relazione</option><option value="tavole">Tavole</option><option value="computo">Computo (Excel o PDF)</option></select><button type="button" class="pv-b sm pv-pr" id="pv-ia-url-ok">Aggiungi</button></div>'+
   '<small>Google Drive (file o cartella), OneDrive, Dropbox, condivisi con «Chiunque abbia il link». I link restano salvati nel preventivo; i file caricati restano 3 giorni dopo la lettura, poi si cancellano da soli.</small></div></div>'+
   linkSalvatiIa(true);
 }
 var ric=l.profondita==='ricontrollo';
 if(!ric){h+='<div class="pv-ia-file">'+F2.map(function(f){return rigaFileIa(f,mod);}).join('')+'</div>';
  if(!F2.length)h+='<p class="pv-vuoto">Nessun file ancora.</p>'+(s==='preparazione'?riprendiIa():'');}
 if(l.errore&&mod)h+='<p class="pv-msg ko">'+es(l.errore)+'</p>';
 if(s==='preparazione')h+='<div class="pv-az"><button type="button" class="pv-b pv-pr" id="pv-ia-controlla"'+(F2.length?'':' disabled')+'>Controlla i file</button><span class="pv-ia-nota">Gratis: TIX legge i file, trova i prezzi per codice e ti dice quanto costa preparare le voci.</span></div>';
 if(s==='stima')h+=stimaIa(l);
 if(!mod)h+='<div class="pv-ia-att"><div class="pv-ia-gira"></div><div><b>'+es(l.passo||PASSI[s]||'')+'</b><small>'+(s==='controllo'?'Di solito qualche minuto: TIX controlla un file per volta.':ric?(l.modalita==='subito'?'Ricontrollo delle voci, «Subito»: pochi minuti.':'Ricontrollo delle voci, «Senza fretta»: di solito entro un\'ora.'):(l.profondita==='approfondita'?(l.modalita==='subito'?'Lettura approfondita, «Subito»: circa 10 minuti.':'Lettura approfondita, «Senza fretta»: di solito entro due ore, al massimo un giorno.'):(l.modalita==='subito'?'Velocità «Subito»: pochi minuti.':'Velocità «Senza fretta»: di solito entro un\'ora, al massimo un giorno.')))+
  (l.partita_il?' Partita alle '+ora(l.partita_il)+'.':'')+' Puoi chiudere la pagina: il lavoro continua.</small></div></div>';
 h+='<p class="pv-msg'+(IA_MSG&&IA_MSG.cl?' '+IA_MSG.cl:'')+'" id="pv-ia-msg" aria-live="polite">'+es(IA_MSG?IA_MSG.t:'')+'</p></div>';
 box.innerHTML=h;
 legaIa(l);}
function rigaFileIa(f,mod){var est=f.fonte==='link'?'LINK':(/\.(xlsx|xls|xlsm|ods|csv)$/i.test(f.nome)?'XLSX':'PDF'),info=[];
 if(f.voci)info.push(f.voci+' voci');if(f.pagine)info.push(f.pagine+(f.pagine===1?' pagina':' pagine'));if(f.byte)info.push(mbTxt(f.byte));
 var cl=f.stato==='pronto'?' pronto':(f.stato==='rifiutato'||f.stato==='errore')?' no':'';
 return '<div class="pv-ia-f'+cl+'"><span class="tipo '+est.toLowerCase()+'">'+est+'</span><p>'+es(f.nome)+'<small>'+es(info.length?info.join(' · '):(f.fonte==='link'?f.link:''))+'</small>'+(f.messaggio?'<small class="m">'+es(f.messaggio)+'</small>':'')+'</p>'+
  (mod?'<select data-iatipo="'+f.id+'" aria-label="Che cos\'è">'+['computo','relazione','tavole'].map(function(t){return '<option value="'+t+'"'+(f.tipo===t?' selected':'')+'>'+TIPI[t]+'</option>';}).join('')+'</select>'+
   '<label class="pv-ia-sp"><input type="checkbox" data-ialeggi="'+f.id+'"'+(f.leggi?' checked':'')+'> Leggi</label><button type="button" class="pv-ia-x" data-iax="'+f.id+'" title="Togli" aria-label="Togli">×</button>'
   :'<span class="pv-ia-st">'+es(TIPI[f.tipo]||'')+(f.leggi?'':' · non letto')+'</span>')+'</div>';}
function stimaIa(l){var t=l.stima||{},sub=l.modalita==='subito',ap=l.profondita==='approfondita',manca=ap&&t.usd_appr_batch==null,
 costo=ap?(sub?t.usd_appr_subito:t.usd_appr_batch):(sub?t.usd_subito:t.usd_senza_fretta);
 var h='<div class="pv-ia-stima"><div><span>Voci del computo</span><b>'+(t.voci_computo||0)+'</b><small>'+(t.per_codice||0)+' con il prezzo per codice · '+(t.np?t.np+' NP (codice non nel prezzario) · ':'')+(t.da_scegliere||0)+' da scegliere con TIX · '+(t.senza_prezzo||0)+' senza voci simili</small></div>'+
  '<div><span>Relazioni</span><b>'+docTxt(t.pagine_relazioni,t.file_relazioni)+'</b><small>lette da TIX in PDF</small></div>'+
  '<div><span>Tavole</span><b>'+docTxt(t.pagine_tavole,t.file_tavole)+'</b><small>lette da TIX in PDF</small></div>'+
  '<div class="soldi"><span>Costo stimato</span><b>'+(manca?'—':usd(costo)+' $')+'</b><small>'+(manca?'premi «Controlla di nuovo»':'+ IVA · '+(ap?(sub?'circa 10 minuti':'di solito entro due ore'):(sub?'pochi minuti':'di solito entro un\'ora')))+'</small></div></div>';
 if((t.avvisi||[]).length)h+='<p class="pv-avviso">'+t.avvisi.map(es).join('<br>')+'</p>';
 h+='<div class="pv-ia-vel"><span class="et">Lettura</span><button type="button" class="pv-chip'+(ap?'':' on')+'" data-iaprof="normale">Normale</button>'+
  '<button type="button" class="pv-chip'+(ap?' on':'')+'" data-iaprof="approfondita">Approfondita <em>· voce per voce</em></button></div>'+
  (ap?'<p class="pv-ia-nota pv-ia-appr">Più voci simili per ogni voce, con le varianti e i sovrapprezzi; il prezzo adeguato con il calcolo scritto; l\'analisi del prezzo per le voci che nel prezzario non ci sono; il confronto con i tuoi prezzi e un controllo finale di tutte le voci.</p>':'');
 h+='<div class="pv-ia-vel"><span class="et">Velocità</span><button type="button" class="pv-chip'+(sub?'':' on')+'" data-iamod="batch">Senza fretta <em>· metà prezzo</em></button>'+
  '<button type="button" class="pv-chip'+(sub?' on':'')+'" data-iamod="subito">Subito <em>· prezzo pieno</em></button></div>'+
  // 04/11/2026 (preventivi-computo-1): con le voci di una lettura di prima si sceglie se sostituirle o integrarle
  (num(IA.voci_precedenti)?'<div class="pv-ia-vel pv-ia-scr"><span class="et">Voci di prima</span><button type="button" class="pv-chip'+(l.scrittura==='sostituisci'?' on':'')+'" data-iascr="sostituisci">Sostituisci <em>· toglie le '+num(IA.voci_precedenti)+' voci delle letture di prima</em></button>'+
   '<button type="button" class="pv-chip'+(l.scrittura==='integra'?' on':'')+'" data-iascr="integra">Integra <em>· aggiorna le voci uguali del computo e aggiunge solo le nuove</em></button></div>'+
   (IA.gia_importato?'<p class="pv-avviso">Questo computo è già stato letto in una lettura di prima: di solito conviene «Sostituisci».</p>':''):'')+
  '<div class="pv-az"><button type="button" class="pv-b pv-pr" id="pv-ia-parti">Prepara il preventivo</button><button type="button" class="pv-b" id="pv-ia-ricontrolla">Controlla di nuovo</button>'+
  '<span class="pv-ia-nota">Le voci scritte a mano restano. Quelle di TIX entrano segnate, con la super-categoria e la categoria del computo, e le controlli prima di mandare il preventivo. Le voci in più rilevate da tavole e relazioni vanno nel capitolo «Extra computo», fuori dal totale.</span></div>';
 return h;}
// 05/11/2026 (preventivi-ricontrollo-1): «Ricontrolla le voci» senza file: il pulsante (prima la stima del costo) e l'esito
function ricontrollaIa(){if(!F||!(F.voci||[]).length||D.stato!=='bozza')return '';
 return '<div class="pv-ia-rip ric"><button type="button" class="pv-b" id="pv-ia-ricontrolla-voci">Ricontrolla le voci</button><span class="pv-ia-nota">Senza file: TIX rilegge le '+pl((F.voci||[]).length,'voce','voci')+' del preventivo (prezzi, codici, unità, quantità, doppioni) e ti segnala cosa non torna. Prima ti dice quanto costa.</span></div>';}
function legaRicontrollaIa(){var b=$('pv-ia-ricontrolla-voci');if(!b)return;b.onclick=function(){b.disabled=true;
 api('ia_ricontrolla',{id:CFG.id}).then(function(r){b.disabled=false;
  if(!r||r.esito!=='stima'){alert(msgErr(r));return;}
  if(!confirm('Ricontrollo di '+pl(r.voci,'voce','voci')+': TIX rilegge prezzi, codici, unità e quantità e segnala cosa non torna. Le voci non cambiano.\n\nCosta circa '+usd(r.stima_usd)+' $ + IVA («Senza fretta», di solito entro un\'ora). Partire?'))return;
  b.disabled=true;api('ia_ricontrolla',{id:CFG.id,conferma:true,modalita:'batch'}).then(function(r2){b.disabled=false;if(r2&&r2.esito==='ok')caricaIa();else alert(msgErr(r2));});});};}
function esitoRicontrolloIa(l){var r=l.riepilogo||{},S=r.segnalazioni||[];
 var h='<div class="pv-ia-esito"><p class="pv-ia-rie">Ultimo ricontrollo delle voci: '+pl(r.voci,'voce ricontrollata','voci ricontrollate')+' · '+pl(r.errori,'errore','errori')+' · '+pl(r.attenzione,'cosa da guardare','cose da guardare')+' · costo '+usd(l.costo_usd)+' $ + IVA</p>';
 if(S.length)h+='<div class="pv-ia-segn">'+S.map(function(s){return '<div class="'+(s.gravita==='errore'?'err':'att')+'"><b>'+(s.gravita==='errore'?'Errore':'Da guardare')+'</b> '+
  (s.nr!=null?'n. '+es(s.nr)+' ':(s.extra?'voce in più ':''))+'«'+es(s.d||'')+'»: '+es(s.testo)+'</div>';}).join('')+'</div>';
 else h+='<p class="pv-ia-nota">TIX non ha trovato niente da segnalare.</p>';
 if((l.da_chiarire||[]).length)h+='<div class="pv-ia-chiarire"><b>Da chiarire con il cliente</b><ol>'+l.da_chiarire.map(function(x){return '<li>'+es(x)+'</li>';}).join('')+'</ol></div>';
 return h+'<p class="pv-ia-nota">Le voci non sono cambiate: correggile tu con «Modifica».</p></div>';}
function esitoIa(l){var r=l.riepilogo||{},ap=r.profondita==='approfondita';if(r.profondita==='ricontrollo')return esitoRicontrolloIa(l);var h='<div class="pv-ia-esito"><p class="pv-ia-rie">'+(ap?'Ultima lettura approfondita: ':'Ultima lettura: ')+pl(r.scritte,'voce aggiunta','voci aggiunte')+' · '+(r.per_codice||0)+' con il prezzo per codice · '+
  pl(r.scelte_ia,'scelta da TIX','scelte da TIX')+' · '+(ap?pl(r.adeguati,'prezzo adeguato','prezzi adeguati')+' · '+pl(r.analisi,'analisi del prezzo','analisi del prezzo')+' · ':'')+(r.senza_prezzo||0)+' senza prezzo · '+(r.in_piu||0)+' in più dalle relazioni e dalle tavole'+
  (ap?' · '+pl(r.segnalazioni,'segnalazione del controllo finale','segnalazioni del controllo finale'):'')+
  (r.tolte?' · '+pl(r.tolte,'voce tolta','voci tolte')+' delle letture di prima':'')+(r.aggiornate?' · '+pl(r.aggiornate,'voce aggiornata','voci aggiornate'):'')+
  (r.extra_tolte?' · '+pl(r.extra_tolte,'voce in più non aggiunta perché già presente','voci in più non aggiunte perché già presenti'):'')+' · costo '+usd(l.costo_usd)+' $ + IVA</p>';
 if((l.da_chiarire||[]).length)h+='<div class="pv-ia-chiarire"><b>Da chiarire con il cliente</b><ol>'+l.da_chiarire.map(function(x){return '<li>'+es(x)+'</li>';}).join('')+'</ol></div>';
 h+='<details class="pv-ia-letti"><summary>File letti</summary>'+(l.file||[]).map(function(f){return '<div>'+es(f.nome)+(f.pagine?' · '+f.pagine+' pag.':'')+(f.voci?' · '+f.voci+' voci':'')+
  (f.sha256?' · impronta <code>'+es(String(f.sha256).slice(0,8))+'…</code>':'')+(f.messaggio?' · '+es(f.messaggio):'')+'</div>';}).join('')+'<small>I file caricati restano 3 giorni dopo la lettura, poi si cancellano da soli: resta questo elenco, con le impronte. I link restano salvati.</small></details></div>';
 return h;}
function azIa(az,d,b){if(b)b.disabled=true;msgIa('Un momento…');d=d||{};d.id=CFG.id;
 return api('ia_'+az,d).then(function(r){if(b)b.disabled=false;if(r&&r.esito==='ok'){msgIa('');caricaIa();}else msgIa(msgErr(r),'ko');return r;});}
function legaIa(l){
 var an=$('pv-ia-annulla');if(an)an.onclick=function(){if(confirm('Annullare «Prepara con TIX»? I file caricati restano 3 giorni, poi si cancellano da soli.'))azIa('annulla',{},an);};
 legaRiprendiIa();
 var lv=$('pv-ia-lavoro');if(lv)lv.onchange=function(){azIa('lavoro',{lavoro:lv.value});};
 var fi=$('pv-ia-file');if(fi)fi.onchange=function(){caricaFileIa(fi.files);};
 var dr=$('pv-ia-drop');if(dr){dr.ondragover=function(e){e.preventDefault();dr.classList.add('su');};dr.ondragleave=function(){dr.classList.remove('su');};
  dr.ondrop=function(e){e.preventDefault();dr.classList.remove('su');caricaFileIa(e.dataTransfer&&e.dataTransfer.files);};}
 var uo=$('pv-ia-url-ok');if(uo)uo.onclick=function(){var u=$('pv-ia-url').value.trim();if(!u){msgIa('Incolla il link.','ko');return;}azIa('link',{link:u,tipo:$('pv-ia-url-tipo').value},uo);};
 var co=$('pv-ia-controlla');if(co)co.onclick=function(){azIa('controlla',{},co);};
 var rc=$('pv-ia-ricontrolla');if(rc)rc.onclick=function(){azIa('controlla',{},rc);};
 var pa=$('pv-ia-parti');if(pa)pa.onclick=function(){parti(pa,false);};
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-iamod]'),function(b){b.onclick=function(){azIa('lavoro',{modalita:b.getAttribute('data-iamod')},b);};});
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-iaprof]'),function(b){b.onclick=function(){azIa('lavoro',{profondita:b.getAttribute('data-iaprof')},b);};});
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-iascr]'),function(b){b.onclick=function(){azIa('lavoro',{scrittura:b.getAttribute('data-iascr')},b);};});
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-iatipo]'),function(s){s.onchange=function(){azIa('tipo_file',{file_id:s.getAttribute('data-iatipo'),tipo:s.value});};});
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-ialeggi]'),function(c){c.onchange=function(){azIa('tipo_file',{file_id:c.getAttribute('data-ialeggi'),leggi:c.checked});};});
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-iax]'),function(b){b.onclick=function(){azIa('togli_file',{file_id:b.getAttribute('data-iax')},b);};});}
// 09/11/2026 (crediti-1, chat 02B): con i Crediti TIX attivi la conferma è in crediti; senza crediti si comprano dall'elenco
function parti(b,conferma,crediti){b.disabled=true;msgIa('Un momento…');
 api('ia_parti',{id:CFG.id,conferma_tetto:conferma,conferma_crediti:!!crediti}).then(function(r){b.disabled=false;
  if(r&&r.esito==='tetto'){msgIa('');if(confirm(r.messaggio))parti(b,true,crediti);return;}
  if(r&&r.esito==='crediti'){msgIa('');if(confirm(r.messaggio))parti(b,conferma,true);return;}
  if(r&&r.esito==='crediti_mancano'){msgIa(r.messaggio+' I crediti si comprano dall\'elenco dei preventivi, nel riquadro «Crediti TIX».','ko');return;}
  if(r&&r.esito==='ok'){msgIa('');caricaIa();}else msgIa(msgErr(r),'ko');});}
// 09/11/2026 (cantiere-da-preventivo-1, chat 02B): preventivo accettato → «Apri il cantiere» già compilato, «Collega», «Cosa manca»
var CANT=null;
function caricaCant(){if(!CFG.id||!D||D.stato!=='accettato')return;api('pc_stato',{id:CFG.id}).then(function(r){CANT=r&&r.esito==='ok'&&r.mostra?r:null;disegnaCant();});}
function disegnaCant(){var box=$('pv-cant');if(!box)return;var r=CANT;if(!r){box.innerHTML='';return;}var base=String(CFG.pagina||'').replace(/\/preventivi$/,'');
 var h='<section class="pv-cant"><h3>Cantiere del preventivo accettato</h3>';
 if(r.collegato){var c=r.cantiere||{};
  h+='<p class="pv-cant-s">Collegato al cantiere <b>'+es(c.nome)+'</b>'+(c.ubicazione?' · '+es(c.ubicazione):'')+(r.collegato_il?' dal '+es(r.collegato_il):'')+
   '. Se il preventivo cambia, la differenza diventa una variante nella sezione SAL: il contratto non si riscrive da solo.</p>'+
   '<h4>Cosa manca per completare l\'attivazione</h4><ul class="pv-cant-l">'+(r.mancano||[]).map(function(m){
    return '<li class="'+(m.ok===true?'ok':m.ok===false?'no':'opz')+'"><span>'+(m.ok===true?'✓':m.ok===false?'•':'○')+'</span>'+es(m.testo)+'</li>';}).join('')+'</ul>'+
   '<p class="pv-cant-s"><a class="pv-b sm pv-pr" href="'+es(base+'/?t='+CFG.t+'&c='+c.id)+'">Vai al cantiere</a></p>';}
 else{var d=r.dati||{};
  h+='<p class="pv-cant-s">Il preventivo è accettato. Apri il cantiere con il modulo di sempre, già compilato con i dati del preventivo: <b>'+es(d.nome||'')+'</b>'+
   (d.ubicazione?' · '+es(d.ubicazione):'')+(d.committente?' · committente '+es(d.committente):'')+'. Controlli i dati e confermi tu: il modulo dice anche se il cantiere cambia il canone.</p>'+
   '<p><button type="button" class="pv-b pv-pr" id="pv-cant-apri">Apri il cantiere</button></p>'+
   ((r.proposte||[]).length?'<h4>Oppure collega un cantiere che c\'è già</h4><div class="pv-cant-p">'+r.proposte.map(function(p){
    return '<span class="pv-cant-k'+(p.stesso_nome||p.stesso_luogo?' su':'')+'"><b>'+es(p.nome)+'</b>'+(p.ubicazione?' · '+es(p.ubicazione):'')+
     ' <button type="button" class="pv-b sm" data-pccol="'+es(p.id)+'">Collega</button></span>';}).join('')+'</div>':'');}
 h+='<p class="pv-msg" id="pv-cant-msg"></p></section>';box.innerHTML=h;
 var a=$('pv-cant-apri');if(a)a.onclick=function(){a.disabled=true;api('pc_apri',{id:CFG.id}).then(function(x){a.disabled=false;
  if(x&&x.esito==='ok'){location.href=base+'/nuovo-cantiere?t='+CFG.t+'&a='+encodeURIComponent(x.azienda_id||'')+'&pv='+encodeURIComponent(CFG.id);}
  else msg($('pv-cant-msg'),msgErr(x),'ko');});};
 Array.prototype.forEach.call(box.querySelectorAll('[data-pccol]'),function(b){b.onclick=function(){
  if(!confirm('Collegare il preventivo a questo cantiere? Dopo il collegamento compare la lista di cosa manca.'))return;b.disabled=true;
  api('pc_collega',{id:CFG.id,commessa_id:b.getAttribute('data-pccol')}).then(function(x){b.disabled=false;if(x&&x.esito==='ok')caricaCant();else msg($('pv-cant-msg'),msgErr(x),'ko');});};});}
function caricaCrediti(){var box=$('pv-crediti');if(!box)return;
 api('cr_saldo',{}).then(function(r){if(!r||r.esito!=='ok'){box.innerHTML='';return;}var s=r.saldo||{};
  var h='<div class="pv-cr"><div class="pv-cr-t"><b>Crediti TIX: '+(s.totale||0)+'</b><span>'+
   (s.compresi_mese?(s.compresi||0)+' compresi di questo mese (su '+s.compresi_mese+') · ':'')+(s.comprati||0)+' comprati'+
   (s.prossima_scadenza?' · i primi scadono il '+es(s.prossima_scadenza):'')+'</span></div>'+
   '<p class="pv-cr-s">«Prepara con TIX» usa 1 credito per un preventivo fino a 100 voci, 2 fino a 300, 3 oltre; +1 per la lettura approfondita o «Subito». '+
   'Il credito comprende email al direttore dei lavori, richieste di offerta e posta. Se una lettura non riesce per un problema di TIX, il credito torna indietro. '+
   'I crediti comprati valgono 12 mesi.</p><div class="pv-cr-p">'+
   (r.pacchetti||[]).map(function(p){return '<span class="pv-cr-k"><b>'+p.crediti+' crediti</b> '+es(euro(p.eur))+' + IVA'+
    (r.carta?' <button type="button" class="pv-b sm pv-pr" data-crcarta="'+p.crediti+'">Paga con carta</button>':'')+
    ' <button type="button" class="pv-b sm" data-crbon="'+p.crediti+'">Con bonifico</button></span>';}).join('')+'</div>'+
   '<p class="pv-msg" id="pv-cr-msg"></p>'+
   ((r.movimenti||[]).length?'<details class="pv-cr-m"><summary>Movimenti dei crediti</summary><table>'+r.movimenti.map(function(m){
     return '<tr><td>'+es(m.data)+'</td><td>'+es(m.descrizione||m.tipo)+'</td><td class="n">'+(m.crediti>0?'+':'')+es(m.crediti)+'</td></tr>';}).join('')+'</table></details>':'')+'</div>';
  box.innerHTML=h;
  Array.prototype.forEach.call(box.querySelectorAll('[data-crcarta]'),function(b){b.onclick=function(){b.disabled=true;
   api('cr_compra',{pacchetto:b.getAttribute('data-crcarta')}).then(function(x){b.disabled=false;if(x&&x.esito==='ok'&&x.url){location.href=x.url;}else msg($('pv-cr-msg'),msgErr(x),'ko');});};});
  Array.prototype.forEach.call(box.querySelectorAll('[data-crbon]'),function(b){b.onclick=function(){
   if(!confirm('Chiedi '+b.getAttribute('data-crbon')+' crediti da pagare con bonifico? Ti mandiamo i dati per il bonifico; i crediti si caricano quando arriva il pagamento.'))return;
   b.disabled=true;api('cr_bonifico',{pacchetto:b.getAttribute('data-crbon')}).then(function(x){b.disabled=false;
    msg($('pv-cr-msg'),x&&x.esito==='ok'?x.messaggio:msgErr(x),x&&x.esito==='ok'?'ok':'ko');});};});
 });}
function caricaFileIa(files){var L=Array.prototype.slice.call(files||[]);
 var no=L.filter(function(f){return !/\.(xlsx|xls|xlsm|ods|csv|pdf)$/i.test(f.name)||f.size>18*1024*1024;});
 L=L.filter(function(f){return no.indexOf(f)<0;});
 var errori=no.length?['Non caricati: '+no.map(function(f){return f.name;}).join(', ')+' (computo in Excel o in PDF, tavole e relazioni in PDF, fino a 18 MB).']:[];
 if(!L.length){msgIa(errori.join(' '),'ko');return;}
 var i=0;
 // uno alla volta; se un file non va, si passa al successivo e alla fine si dice quali non sono entrati
 function uno(){if(i>=L.length){msgIa(errori.join(' '),errori.length?'ko':'');caricaIa();return;}var f=L[i++];msgIa('Carico «'+f.name+'» ('+i+' di '+L.length+')…');
  fetch(CFG.ia+'?t='+encodeURIComponent(CFG.t)+'&id='+encodeURIComponent(CFG.id)+'&nome='+encodeURIComponent(f.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:f})
   .then(function(r){return r.json().catch(function(){return {esito:'errore'};});}).catch(function(){return {esito:'rete'};})
   .then(function(r){if(!(r&&r.esito==='ok'))errori.push('«'+f.name+'»: '+msgErr(r));uno();});}
 uno();}
// le voci simili al posto di quella proposta
function alternative(id){var v=(F.voci||[]).filter(function(x){return String(x.id)===String(id);})[0],x=IA&&IA.voci_ia&&IA.voci_ia[String(id)];if(!v||!x)return;
 var A=x.alternative||[];$('pv-alt-voce').textContent=v.descrizione.length>220?v.descrizione.slice(0,217)+'…':v.descrizione;msg($('pv-alt-msg'),'');
 $('pv-alt-lista').innerHTML=A.map(function(c,i){var desc=(c.titolo||'')+(c.descrizione&&c.descrizione!==c.titolo?' — '+c.descrizione:'');
  return '<div class="pv-ri">'+fonteHtml(c.fonte,c.codice)+'<p>'+es(desc.length>260?desc.slice(0,257)+'…':desc)+'</p><span class="um">'+es(c.unita||'')+'</span><span class="pr"><b>'+euro(c.prezzo)+'</b></span>'+
   '<button type="button" class="pv-b sm pv-pr" data-alt="'+i+'">Usa questa</button></div>';}).join('')||'<p class="pv-vuoto">Nessuna voce simile.</p>';
 Array.prototype.forEach.call($('pv-alt-lista').querySelectorAll('[data-alt]'),function(b){b.onclick=function(){b.disabled=true;msg($('pv-alt-msg'),'Un momento…');
  api('ia_scegli',{id:F.id,voce_id:String(id),alt:b.getAttribute('data-alt')}).then(function(r){b.disabled=false;if(r&&r.esito==='ok'){velo('pv-v-alt',false);carica();}else msg($('pv-alt-msg'),msgErr(r),'ko');});};});
 velo('pv-v-alt',true);}

if(CFG.id){disegna();caricaIa();caricaCant();}else elenco();
})();
`;

// ---------------------------------------------------------------------------- foglio da stampare
function cifra(n, dec) {
  const v = Number(n);
  if (!isFinite(v)) return "";
  const neg = v < 0;
  const s = Math.abs(v).toFixed(dec).split(".");
  return (neg ? "−" : "") + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (dec ? "," + s[1] : "");
}
function dataIt(x) { const m = String(x || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + "/" + m[2] + "/" + m[1] : ""; }

async function datiPerStampa(env, h, tok, id, revParam) {
  let rev = Math.max(0, Math.min(999, parseInt(revParam || "0", 10) || 0));
  let d = await h.rpc(env, "preventivo_dati", { p_token: tok, p_id: id, p_revisione: rev }, 15000).catch(() => null);
  // senza revisione chiesta: se il preventivo è già mandato si stampa l'ultima revisione mandata, non la bozza
  if (d && d.esito === "ok" && !rev && d.stato !== "bozza" && Array.isArray(d.revisioni) && d.revisioni.length) {
    rev = Number(d.revisioni[0].revisione) || 0;
    if (rev) d = await h.rpc(env, "preventivo_dati", { p_token: tok, p_id: id, p_revisione: rev }, 15000).catch(() => null);
  }
  return d;
}

async function stampa(request, env, base, inUrl, h) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const tok = gettone(inUrl.searchParams.get("t"));
  const id = uuid(inUrl.searchParams.get("id"));
  if (!tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!id) return new Response("Not Found", { status: 404 });
  const d = await datiPerStampa(env, h, tok, id, inUrl.searchParams.get("rev"));
  if (!d) return h.risposta(h.foglio(base, "Preventivo", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", ""), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Preventivo", "Preventivo non trovato.", ""), 404);
  return h.risposta(foglio(base, h, tok, d));
}

// foglio da stampare (04/11/2026, preventivi-stampa-1): il modello 26 «Computo grafite e ottone» scelto da Filippo. Intestazione a
// tabella, computo metrico estimativo con le righe di misura e «SOMMANO», riepilogo (per categorie se il computo le ha, altrimenti
// per provenienza dei prezzi), quadro economico, condizioni e firme. Le voci restano nell'ordine dell'app.
function foglio(base, h, tok, d) {
  const e = h.esc;
  const f = d.preventivo || {};
  const T = f.totali || {};
  const imp = f.impresa || {};
  const cl = f.cliente || {};
  const c = f.cantiere && typeof f.cantiere === "object" ? f.cantiere : null;
  const k = f.contratto && typeof f.contratto === "object" ? f.contratto : null;
  const z = f.prezzario && typeof f.prezzario === "object" ? f.prezzario : null;
  const foto = d.foto === true;
  const voci = Array.isArray(f.voci) ? f.voci : [];
  const rib = Number(T.ribasso_pct) || 0;
  const nomeFonte = (v) => v.fonte === "contratto" ? "Elenco prezzi del contratto" : v.fonte === "prezzario" ? (z ? z.titolo : "Prezzario regionale") : "Voce dell'impresa";
  // «senza ribasso» si scrive solo se nel preventivo il ribasso c'è e quella voce non lo ha
  const senzaRib = (v) => rib > 0 && !((v.fonte === "contratto" || v.fonte === "prezzario") && v.ribassabile);
  const vuoto = (x) => x === null || x === undefined || x === "";
  const del = (s) => (/^(8|11?)(,|$)|^8/.test(s) ? "dell'" : "del ") + s;
  const fonti = [];
  if (voci.some((v) => v.fonte === "contratto")) fonti.push("dall'elenco prezzi del contratto" + (k && k.data_contratto ? " del " + dataIt(k.data_contratto) : ""));
  // 04/11/2026 (preventivi-stampa-2, Filippo): nel foglio per il cliente non si dice da quale prezzario vengono i prezzi
  const sigla = String(imp.nome || "").split(/[\s.,&'’-]+/).filter((x) => x && !/^(s\.?r\.?l|s\.?p\.?a|s\.?n\.?c|s\.?a\.?s|di|e|ed|la|il)$/i.test(x))
    .slice(0, 2).map((x, i, a) => a.length === 1 ? x.slice(0, 2) : x[0]).join("").toUpperCase();
  const logo = /^https:\/\/[^\s"'<>]+$/.test(String(imp.logo_url || "")) ? '<img class="logo-img" src="' + e(imp.logo_url) + '" alt="" onerror="this.remove()">'
    : (sigla ? '<span class="sigla" aria-hidden="true">' + e(sigla) + "</span>" : "");
  const data = foto ? dataIt(f.data || d.mandato_il) : "";
  // 04/11/2026 (preventivi-computo-1): super-categorie e categorie del computo con il «Totale categoria», voci NP o da quotare
  // fuori dal totale, voci extra computo in un capitolo a parte (non comprese). Le revisioni di prima non hanno questi campi.
  const nel = (v) => v.nel_totale !== false && !v.extra;
  const comp = voci.filter((v) => !v.extra), extra = voci.filter((v) => v.extra);
  const n2 = (n) => (n === null || n === undefined || n === "" ? "" : String(n).padStart(2, "0"));
  const nomeCat = (v) => (v.cat_n != null || v.cat_nome ? "CATEGORIA " + n2(v.cat_n) + (v.cat_nome ? " — " + v.cat_nome : "") : "");
  const nomeSez = (v) => (v.sez_n != null || v.sez_nome ? (v.sez_nome || "") + (v.sez_n != null ? " (SpCat " + v.sez_n + ")" : "") : "");
  // preventivi-stampa-2: il motivo per il cliente, senza dire da dove vengono i prezzi
  const fuoriTxt = (v) => (v.stato === "da_quotare" ? "da quotare con l'offerta del fornitore" : v.stato === "esclusa" ? "esclusa"
    : !Number(v.quantita) ? "NP – prezzo da definire: mancano le quantità" : "NP – prezzo da definire per mancanza di dati tecnici");
  // nella colonna «Tariffa» solo il codice del computo del cliente o dell'elenco prezzi del suo contratto, mai quello messo da TIX
  const tariffa = (v) => v.codice_computo || (v.fonte === "contratto" ? v.codice : "") || "";
  // sotto la descrizione solo il riferimento al contratto del cliente o agli elaborati di progetto
  const fonteFoglio = (v) => (v.extra ? "Da: " + (v.riferimento || "elaborati di progetto") : v.fonte === "contratto" ? "Elenco prezzi del contratto" : "");
  const voce = (v, nr, testa) => {
    const mis = Array.isArray(v.misure) ? v.misure : [];
    const dentro = v.extra ? !!v.prezzo && ["ok", "da_verificare"].includes(v.stato) : nel(v);
    return '<tbody class="vg">' + testa + '<tr class="v' + (dentro ? "" : " fuori") + '"><td class="c">' + e(nr) + '</td><td class="tar">' + e(tariffa(v)) + '</td><td class="des">' + e(v.descrizione) +
      '<span class="fonte">' + e(fonteFoglio(v)) +
      (senzaRib(v) && dentro ? '<span class="sr">senza ribasso</span>' : "") + (dentro ? "" : '<span class="sr np">' + e(fuoriTxt(v)) + "</span>") + "</span></td>" + "<td></td>".repeat(7) + "</tr>" +
      mis.map((m) => '<tr class="m"><td></td><td></td><td class="des">' + e(m.dove || "") + "</td>" +
        ["parti", "lun", "lar", "alt"].map((x) => '<td class="r">' + (vuoto(m[x]) ? "" : cifra(m[x], x === "parti" && Number.isInteger(Number(m[x])) ? 0 : 2)) + "</td>").join("") +
        '<td class="r">' + cifra(m.q, 2) + "</td><td></td><td></td></tr>").join("") +
      '<tr class="s"><td></td><td></td><td class="des">SOMMANO ' + e(v.unita || "") + '</td><td></td><td></td><td></td><td></td><td class="r q">' + cifra(v.quantita, 2) +
      '</td><td class="r">' + (dentro || Number(v.prezzo) ? cifra(v.prezzo, 2) : v.stato === "da_quotare" ? "da quotare" : "NP") + '</td><td class="r i">' + (dentro ? cifra(v.importo, 2) : "—") + "</td></tr></tbody>";
  };
  const pezzi = [];
  let kS = null, kC = null, sc = 0, ss = 0, cc = "", nPrima = 0;
  const chiudiCat = () => { if (cc) pezzi.push('<tbody><tr class="tc"><td colspan="9" class="des">Totale ' + e(cc.toLowerCase().replace(/^categoria/, "categoria")) + '</td><td class="r">' + cifra(sc, 2) + "</td></tr></tbody>"); sc = 0; };
  const chiudiSez = () => { if (kS) pezzi.push('<tbody><tr class="ts"><td colspan="9" class="des">Totale ' + e(kS.toUpperCase()) + '</td><td class="r">' + cifra(ss, 2) + "</td></tr></tbody>"); ss = 0; };
  comp.forEach((v, i) => {
    const ks = nomeSez(v), kc = ks + "|" + nomeCat(v);
    let testa = "";
    if (kc !== kC) {
      if (kC !== null) { chiudiCat(); if (ks !== kS) chiudiSez(); }
      if (ks !== kS && ks) testa += '<tr class="sez"><td colspan="10">' + e(ks.toUpperCase()) + "</td></tr>";
      cc = nomeCat(v);
      if (cc) testa += '<tr class="cat"><td colspan="10">' + e(cc.toUpperCase()) + "</td></tr>";
      kS = ks; kC = kc;
    }
    if (nel(v)) { sc += Number(v.importo) || 0; ss += Number(v.importo) || 0; }
    pezzi.push(voce(v, v.nr_computo != null ? v.nr_computo : i + 1, testa));
    nPrima = i + 1;
  });
  if (kC !== null) { chiudiCat(); chiudiSez(); }
  if (extra.length) {
    let se = 0;
    extra.forEach((v, i) => {
      if (["ok", "da_verificare"].includes(v.stato)) se += Number(v.importo) || 0;
      pezzi.push(voce(v, "E" + (i + 1), i ? "" : '<tr class="ex"><td colspan="10">EXTRA COMPUTO – LAVORAZIONI RILEVATE DAGLI ELABORATI · NON COMPRESE NEL TOTALE</td></tr>'));
    });
    pezzi.push('<tbody><tr class="tc ex"><td colspan="9" class="des">Totale extra computo (non compreso nel totale del preventivo)</td><td class="r">' + cifra(se, 2) + "</td></tr></tbody>");
  }
  const righe = pezzi.join("") || '<tbody><tr class="s"><td colspan="10" class="des vuote">Nessuna voce</td></tr></tbody>';
  // riepilogo: per categorie se il computo le ha, altrimenti per provenienza dei prezzi (importi nel totale, prima del ribasso)
  const sub = (Array.isArray(f.subtotali) ? f.subtotali : []).filter((s) => s.cat_n != null || s.cat_nome || s.sez_n != null || s.sez_nome);
  const piuSez = new Set(sub.map((s) => s.sez_n)).size > 1;
  const gruppi = sub.length ? sub.map((s) => ({ nome: (piuSez && s.sez_n != null ? "SpCat " + s.sez_n + " · " : "") + (s.cat_n != null ? n2(s.cat_n) + " — " : "") + (s.cat_nome || s.sez_nome || ""), n: s.voci, t: Number(s.importo) || 0,
      sez: s.sez_n, sezNome: s.sez_nome }))
    // preventivi-stampa-2: senza categorie, il contratto a parte e tutto il resto come «Lavorazioni» (non si dice da dove vengono i prezzi)
    : [["contratto", "Elenco prezzi del contratto"], ["altre", "Lavorazioni"]].map(([fo, nome]) => {
      const g = comp.filter((v) => nel(v) && (fo === "altre" ? v.fonte !== "contratto" : v.fonte === fo));
      return { nome, n: g.length, t: g.reduce((s, v) => s + (Number(v.importo) || 0), 0) };
    }).filter((g) => g.n);
  const lordo = gruppi.reduce((s, g) => s + g.t, 0);
  // con una sola provenienza basta la riga del totale, con il suo nome
  // con più super-categorie, dopo le loro categorie la riga «Totale SpCat»
  const lista = [];
  gruppi.forEach((g, i) => {
    lista.push(g);
    const nx = gruppi[i + 1];
    if (piuSez && g.sez != null && (!nx || nx.sez !== g.sez)) {
      lista.push({ sz: true, nome: "Totale SpCat " + g.sez + (g.sezNome ? " — " + g.sezNome : ""), t: gruppi.filter((x) => x.sez === g.sez).reduce((s, x) => s + x.t, 0) });
    }
  });
  const rc = gruppi.length === 1 ? '<tr class="f"><td>' + e(gruppi[0].nome) + '</td><td class="r">' + cifra(lordo, 2) + ' €</td><td class="r pc">100 %</td></tr>' : lista.map((g) => { const p = lordo > 0 ? g.t / lordo * 100 : 0;
    return "<tr" + (g.sz ? ' class="sz"' : "") + "><td>" + e(g.nome) + '</td><td class="r">' + cifra(g.t, 2) + ' €</td><td class="r pc"><span class="b"><i style="width:' + p.toFixed(1) + '%"></i></span>' + cifra(p, 1) + " %</td></tr>"; }).join("") +
    '<tr class="f"><td>' + (rib > 0 ? "Totale prima del ribasso" : "Totale delle voci") + '</td><td class="r">' + cifra(lordo, 2) + ' €</td><td class="r pc">' + (lordo > 0 ? "100 %" : "") + "</td></tr>";
  const fuori = comp.filter((v) => !nel(v)).length;
  const qe = (rib > 0 ? "<tr><td>Voci con il ribasso</td><td class=\"r\">" + cifra(T.soggetto, 2) + " €</td></tr>" +
      "<tr><td>Ribasso del contratto " + cifra(rib, 2) + ' %</td><td class="r">− ' + cifra(T.ribasso, 2) + " €</td></tr>" +
      (Number(T.non_soggetto) ? '<tr><td>Voci senza ribasso</td><td class="r">' + cifra(T.non_soggetto, 2) + " €</td></tr>" : "") : "") +
    '<tr class="p"><td>Totale lavori</td><td class="r">' + cifra(T.lavori, 2) + " €</td></tr>" +
    (Number(T.oneri) ? '<tr><td>Oneri della sicurezza (senza ribasso)</td><td class="r">' + cifra(T.oneri, 2) + " €</td></tr>" : "") +
    (Number(T.sconto) ? '<tr><td>Sconto</td><td class="r">− ' + cifra(T.sconto, 2) + " €</td></tr>" : "") +
    '<tr class="f"><td>TOTALE</td><td class="r">' + cifra(T.totale, 2) + " € + IVA</td></tr>";
  const cond = [];
  if (fuori) cond.push(fuori === 1 ? "1 voce del computo (NP o da quotare) non ha ancora il prezzo e non è compresa nel totale."
    : fuori + " voci del computo (NP o da quotare) non hanno ancora il prezzo e non sono comprese nel totale.");
  if (extra.length) cond.push("Le lavorazioni del capitolo «Extra computo», rilevate dagli elaborati di progetto, non sono comprese nel totale.");
  if (fonti.length) cond.push("Prezzi presi " + e(fonti.join(" e ")) + (rib > 0 ? ", con il ribasso del contratto " + del(cifra(rib, 2)) + " %" +
    (voci.some(senzaRib) ? " (le voci segnate «senza ribasso» non lo hanno)" : "") : "") + ".");
  cond.push("Le quantità si misurano a lavoro finito" + (c ? ", in contraddittorio con la Direzione Lavori" : "") + ".");
  cond.push("Il preventivo vale " + e(f.validita_giorni) + " giorni dalla data. Importi in euro, IVA esclusa.");
  if (f.note) cond.push(e(f.note).replace(/\r?\n/g, "<br>"));
  const sha = String(d.sha256 || "");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>" + e(f.codice + " " + (f.titolo || "")) + "</title>" +
    "<style>" + STILE_FOGLIO + "</style></head><body>" +
    '<div class="barra"><button type="button" onclick="window.print()">Stampa o salva in PDF</button><a href="' + e(base + "/preventivi?t=" + tok + "&id=" + f.id) + '">‹ Torna al preventivo</a>' +
    (foto ? "" : '<span>Bozza: non ancora mandato al cliente</span>') + "</div>" +
    '<div class="carta' + (foto ? "" : " bozza") + '">' +
    '<table class="int"><tr><td colspan="4" class="imp"><div>' + logo + "<span><b>" + e(imp.nome || "") + "</b><small>" +
      e([imp.indirizzo, imp.partita_iva ? "P. IVA " + imp.partita_iva : "", imp.telefono ? "Tel. " + imp.telefono : "", imp.email].filter(Boolean).join(" · ")) + "</small></span></div></td></tr>" +
    '<tr><td class="k">COMMITTENTE</td><td>' + e(cl.nome || "") + (cl.indirizzo ? " — " + e(cl.indirizzo) : "") + (cl.piva ? "<br>P. IVA / C.F. " + e(cl.piva) : "") +
      '</td><td class="k">PREVENTIVO N.</td><td>' + e(f.codice) + " · Rev. " + e(f.revisione) + "</td></tr>" +
    '<tr><td class="k">LAVORI</td><td>' + (c ? "Lavori extracontrattuali — " : "") + e(f.titolo || "") + '</td><td class="k">DATA</td><td>' + (data || "bozza") +
      " · valido " + e(f.validita_giorni) + " giorni</td></tr>" +
    '<tr><td class="k">' + (c ? "CANTIERE" : "LUOGO") + "</td><td>" + (c ? e(c.nome || "") + (c.ubicazione ? " — " + e(c.ubicazione) : "") +
      (f.indirizzo_lavoro && f.indirizzo_lavoro !== c.ubicazione ? "<br>" + e(f.indirizzo_lavoro) : "") : e(f.indirizzo_lavoro || "—")) +
      '</td><td class="k">REFERENTE</td><td>' + e(imp.referente || "—") + "</td></tr></table>" +
    '<div class="titolo"><h1>PREVENTIVO</h1><span>COMPUTO METRICO ESTIMATIVO</span></div>' +
    '<div class="scorri"><table class="cm"><colgroup><col style="width:7mm"><col style="width:25mm"><col><col style="width:9mm"><col style="width:10mm"><col style="width:10mm">' +
      '<col style="width:10mm"><col style="width:14mm"><col style="width:15mm"><col style="width:17mm"></colgroup>' +
      "<thead><tr><th>N.<br>ORD.</th><th>TARIFFA</th><th>DESIGNAZIONE DEI LAVORI</th><th>PAR.<br>UG.</th><th>LUNG.</th><th>LARG.</th><th>H/<br>PESO</th>" +
      "<th>QUANTITÀ</th><th>PREZZO<br>UNIT. €</th><th>IMPORTO €</th></tr></thead>" + righe + "</table></div>" +
    '<div class="due"><div><h2>' + (sub.length ? "RIEPILOGO PER CATEGORIE" : "RIEPILOGO PER PROVENIENZA") + '</h2><table class="rc">' + rc + "</table></div>" +
      '<div><h2>QUADRO ECONOMICO</h2><table class="qe">' + qe + "</table></div></div>" +
    '<ul class="cond">' + cond.map((x) => "<li>" + x + "</li>").join("") + "</ul>" +
    '<div class="firme"><div>L\'impresa<br><b>' + e(imp.nome || "") + "</b><small>timbro e firma</small></div>" +
      (imp.referente ? "<div>Il referente di cantiere<br><b>" + e(imp.referente) + "</b><small>firma</small></div>" : "") +
      "<div>Per accettazione<br><b>il committente</b><small>data, timbro e firma</small></div></div>" +
    '<div class="piede"><span>' + e(imp.nome || "") + " · Preventivo " + e(f.codice) + " · Rev. " + e(f.revisione) + (data ? " del " + data : " · bozza") + "</span><span>" +
      (foto && sha ? "Impronta SHA-256 " + e(sha.slice(0, 8)) + "…" + e(sha.slice(-4)) + " · " : "") + "Preparato con " + LOGO_TIX + "™ · www.tixcantiere.it</span></div>" +
    "</div></body></html>";
}

// logo di TIX (spunta e lettere) per il piede del foglio
const LOGO_TIX = '<svg class="tixlogo" viewBox="120 262 1756 694" role="img" aria-label="TIX"><defs>' +
  '<linearGradient id="ft-g1" gradientUnits="userSpaceOnUse" x1="130" y1="300" x2="700" y2="950"><stop offset="0" stop-color="#FF9A3D"/><stop offset=".55" stop-color="#F26A10"/><stop offset="1" stop-color="#D9480A"/></linearGradient>' +
  '<linearGradient id="ft-g2" gradientUnits="userSpaceOnUse" x1="1352" y1="503" x2="1868" y2="925"><stop offset="0" stop-color="#FF9A3D"/><stop offset=".5" stop-color="#F26A10"/><stop offset="1" stop-color="#D9480A"/></linearGradient>' +
  '<linearGradient id="ft-g3" gradientUnits="userSpaceOnUse" x1="0" y1="503" x2="0" y2="925"><stop offset="0" stop-color="#3A5577"/><stop offset=".45" stop-color="#1B2F4A"/><stop offset="1" stop-color="#1B2F4A"/></linearGradient></defs>' +
  '<path fill="url(#ft-g1)" d="M130 682L178 636C208 608 248 612 268 640L343 746C515 500 700 328 962 270C760 365 598 560 434 878C404 936 334 948 296 902Z"/>' +
  '<path fill="url(#ft-g3)" d="M838 503L1218 503L1200 605L1078 605L1018 925L890 925L950 605L752 605ZM1268 503L1392 503L1312 925L1188 925Z"/>' +
  '<path fill="url(#ft-g2)" d="M1410 503L1550 503L1828 925L1688 925ZM1728 503L1868 503L1492 925L1352 925Z"/>' +
  '<path fill="none" stroke="#1B2F4A" stroke-width="11" stroke-linecap="round" d="M1615 708L1516 558M1615 708L1749 558M1615 708L1471 870M1615 708L1722 870"/>' +
  '<g fill="#1B2F4A"><circle cx="1516" cy="558" r="22"/><circle cx="1749" cy="558" r="22"/><circle cx="1471" cy="870" r="22"/><circle cx="1722" cy="870" r="22"/><circle cx="1615" cy="708" r="34"/></g></svg>';

// colori: grafite (#24282C) e ottone (#A8843A), come il modello 26
const STILE_FOGLIO =
  ":root{--p:#24282C;--a:#A8843A;--oro:#E2C989;--linea:#C8C0AE;--sub:#6B675E;--mis:#3F3D38;--chiaro:#F6F2E8;--cat:#F0EADB;--t:#EDE4CD;--col:#FBF9F4}" +
  "*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
  "body{margin:0;background:#E3E1DA;color:#202326;font-family:Arial,'Segoe UI',Roboto,sans-serif}" +
  ".barra{position:sticky;top:0;z-index:2;display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 16px;background:#1B2F4A;color:#fff;font-size:15px}" +
  ".barra button{min-height:40px;padding:0 16px;border:0;border-radius:10px;background:#66741C;color:#fff;font:inherit;font-weight:700;cursor:pointer}.barra a{color:#fff;font-weight:600}.barra span{margin-left:auto;font-weight:700;color:#FFD9B8}" +
  ".carta{position:relative;width:210mm;margin:20px auto;background:#fff;box-shadow:0 2px 4px rgba(16,27,43,.08),0 24px 48px -24px rgba(16,27,43,.35);padding:15mm}" +
  ".carta.bozza::after{content:'BOZZA';position:absolute;top:30%;left:0;right:0;text-align:center;font-size:7rem;font-weight:900;color:rgba(168,132,58,.10);transform:rotate(-24deg);pointer-events:none}" +
  "table{width:100%;border-collapse:collapse}" +
  ".int{border:1.2px solid var(--p);margin-bottom:5mm}.int td{border:1px solid var(--linea);padding:1.8mm 2.5mm;font-size:8.6pt;vertical-align:top}" +
  ".int td.k{width:24mm;white-space:nowrap;font-size:6.8pt;font-weight:700;letter-spacing:.08em;color:var(--p);background:var(--chiaro)}.int td:last-child{width:44mm}" +
  ".int td.imp{padding:3.5mm 4mm;color:var(--p);border-color:var(--p)}.int .imp div{display:flex;gap:4mm;align-items:center}" +
  ".int .sigla{flex:none;display:flex;align-items:center;justify-content:center;width:13mm;height:13mm;border-radius:1.5mm;background:var(--p);color:var(--oro);font-weight:800;font-size:11.5pt;letter-spacing:-.02em}" +
  ".int .logo-img{flex:none;max-width:32mm;max-height:15mm;object-fit:contain}" +
  ".int .imp b{display:block;font-size:13pt;letter-spacing:.01em}.int .imp small{display:block;font-size:7.8pt;opacity:.85;margin-top:.6mm}" +
  ".titolo{text-align:center;margin:1mm 0 4.5mm}.titolo h1{margin:0;font-size:15pt;letter-spacing:.22em;color:var(--p)}" +
  ".titolo h1::before,.titolo h1::after{content:'';display:inline-block;width:14mm;height:.3mm;background:var(--a);vertical-align:middle;margin:0 5mm}" +
  ".titolo span{display:block;font-size:8pt;letter-spacing:.26em;color:var(--sub);margin-top:.5mm}" +
  ".titolo::after{content:'';display:block;width:22mm;height:.8mm;background:var(--a);margin:2.2mm auto 0;border-radius:1mm}" +
  ".cm{font-size:7.8pt;border:1px solid var(--p)}" +
  ".cm th{border:1px solid #3A3F44;background:var(--p);color:#F1E3BC;padding:1.7mm 1mm;font-size:6.6pt;letter-spacing:.04em;text-align:center;line-height:1.2;box-shadow:inset 0 -.6mm 0 var(--a)}" +
  ".cm td{border-left:1px solid var(--linea);border-right:1px solid var(--linea);padding:.9mm 1.2mm;vertical-align:top}" +
  ".cm td.c{text-align:center}.cm td.r{text-align:right;white-space:nowrap}" +
  ".cm td.tar{font-size:6.8pt;font-weight:700;color:#8A6B2C;overflow-wrap:anywhere}" +
  ".cm tr.v td{padding-top:1.7mm}.cm tr.v td.c{font-weight:700;color:var(--p)}.cm tr.v td.des{font-weight:700}" +
  ".cm .fonte{display:block;font-weight:400;font-size:6.8pt;color:var(--sub);margin-top:.3mm}" +
  ".cm .sr{display:inline-block;margin-left:1.2mm;padding:0 1.5mm;border-radius:99px;background:#F0E6CC;color:#6E5420;font-size:6.2pt;font-weight:700;letter-spacing:.02em}" +
  ".cm tr.m td{color:var(--mis)}.cm tr.m td.des{font-style:italic;padding-left:4mm}" +
  ".cm tr.s td{border-bottom:1px solid var(--linea);padding-bottom:1.7mm}" +
  ".cm tr.s td.des{text-align:right;font-weight:700;letter-spacing:.04em;color:var(--p);font-size:7.4pt}.cm tr.s td.q,.cm tr.s td.i{font-weight:700}" +
  ".cm td.vuote{text-align:center!important;color:var(--sub)}" +
  // preventivi-computo-1: super-categoria, categoria, totale di categoria, capitolo extra, voci fuori dal totale
  ".cm tr.sez td{border:1px solid var(--p);background:var(--p)!important;color:var(--oro);font-weight:700;font-size:7.6pt;letter-spacing:.1em;padding:1.6mm 1.2mm 1.6mm 3.2mm}" +
  ".cm tr.cat td{border:1px solid var(--linea);background:var(--cat)!important;color:var(--p);font-weight:700;font-size:7.6pt;letter-spacing:.07em;padding:1.5mm 1.2mm 1.5mm 3.2mm;box-shadow:inset 1.3mm 0 0 var(--a)}" +
  ".cm tr.tc td{border:1px solid var(--linea);background:var(--chiaro)!important;color:var(--p);font-weight:700;padding:1.5mm 1.2mm}.cm tr.tc td.des{text-align:right}" +
  ".cm tr.ts td{border:1px solid var(--p);background:var(--t)!important;color:var(--p);font-weight:700;letter-spacing:.05em;padding:1.7mm 1.2mm;border-bottom:.6mm solid var(--p)}.cm tr.ts td.des{text-align:right}" +
  ".cm tr.ex td{border:1px solid var(--a);background:#FBF3E1!important;color:#6E5420;font-weight:700;font-size:7.4pt;letter-spacing:.06em;padding:1.6mm 1.2mm 1.6mm 3.2mm}" +
  ".cm tr.fuori td.des{color:#5d5a52}.cm .sr.np{background:#F7E3DE;color:#8A2E1E}" +
  ".cm tbody td:last-child{background:var(--col)}.cm thead{display:table-header-group}" +
  ".due{display:grid;grid-template-columns:1fr 1fr;gap:6mm;margin-top:6mm}" +
  ".due h2{margin:0 0 2mm;font-size:8.5pt;letter-spacing:.14em;color:var(--p);display:flex;align-items:center;gap:2mm}" +
  ".due h2::before{content:'';width:1.3mm;height:3.6mm;background:var(--a);border-radius:.4mm}" +
  ".rc td,.qe td{border:1px solid var(--linea);padding:1.6mm 2.4mm;font-size:8.4pt}.rc td.r,.qe td.r{text-align:right;white-space:nowrap}" +
  ".rc td.pc{width:23mm}.rc .b{display:inline-block;width:8mm;height:2mm;background:var(--t);border-radius:1mm;margin-right:2mm;vertical-align:.2mm;overflow:hidden}" +
  ".rc .b i{display:block;height:100%;background:var(--a)}" +
  ".rc tr.f td,.qe tr.p td{background:var(--t);font-weight:700}.rc tr.sz td{background:var(--chiaro);font-weight:700;color:var(--p)}" +
  ".qe tr.f td{background:var(--p);color:#fff;font-weight:700;font-size:10pt;border-color:var(--p);padding:2mm 2.4mm}.qe tr.f td.r{color:var(--oro)}" +
  ".cond{margin:5mm 0 0;padding:2.5mm 4mm 2.5mm 8mm;font-size:8.2pt;line-height:1.5;color:#2B3038;background:#FAF8F2;border-left:1.2mm solid var(--a)}" +
  ".firme{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:8mm;margin-top:12mm}" +
  ".firme div{border-top:1px solid var(--p);padding-top:1.5mm;font-size:7.8pt;text-align:center;color:#3A414B}.firme b{color:var(--p)}" +
  ".firme small{display:block;font-size:6.6pt;color:var(--sub);margin-top:.6mm}" +
  ".piede{margin-top:8mm;padding-top:6px;border-top:1px solid var(--linea);display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:8pt;color:#5B6672}" +
  ".piede .tixlogo{height:9pt;width:auto;vertical-align:-1.5pt;margin:0 1px 0 2px}" +
  "@media screen and (max-width:840px){.carta{width:auto;margin:10px;padding:16px 12px}" +
  ".int,.int tbody,.int tr,.int td,.int td:last-child{display:block;width:auto}.int td{border-width:0 0 1px}.int td.k{border-bottom:0;padding-bottom:.4mm}.scorri{overflow-x:auto}.cm{min-width:660px}.due{grid-template-columns:1fr}" +
  ".firme{grid-auto-flow:row;gap:28px}.piede{flex-direction:column;align-items:flex-start}.carta.bozza::after{font-size:4rem}}" +
  "@page{size:A4;margin:12mm 0 14mm}@page:first{margin-top:0}" +
  "@media print{body{background:#fff}.barra{display:none}.carta{width:auto;margin:0;box-shadow:none;padding:15mm 15mm 0}.scorri{overflow:visible}.cm{min-width:0}" +
  "tr,.due,.firme,.cond,.cm tbody.vg{break-inside:avoid}.due h2{break-after:avoid}.firme{break-before:avoid}}";

// ---------------------------------------------------------------------------- Excel
// 05/11/2026 (preventivi-excel-1, chat 02B): «Scarica Excel» dà un vero file .xlsx con la grafica B «Blu e arancione TIX», scelta
// da Filippo tra tre proposte (il foglio da stampare e il PDF non cambiano). Due fogli: «Riepilogo» (intestazione, totale in
// evidenza, riepilogo per categorie con le barre, quadro economico, condizioni, firme: una pagina A4) e «Computo» (tutte le voci
// con super-categorie, categorie, totali e il capitolo «Extra computo» a parte). Formule vere (importo = quantità × prezzo, totali,
// percentuali, quadro economico), A4 pronto da stampare, stesse regole del foglio per il cliente: niente fonte dei prezzi.
// Il file (zip di XML, senza compressione) lo scrive il Worker, senza librerie. «?formato=csv» dà ancora il CSV di prima (per
// l'ufficio, con la fonte dei prezzi); PREVENTIVI_XLSX = "off" nel Worker torna al CSV per tutti.
async function excel(request, env, base, inUrl, h) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const tok = gettone(inUrl.searchParams.get("t"));
  const id = uuid(inUrl.searchParams.get("id"));
  if (!tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!id) return new Response("Not Found", { status: 404 });
  if (String(env.PREVENTIVI_XLSX || "").toLowerCase() === "off" || inUrl.searchParams.get("formato") === "csv") return excelCsv(request, env, base, inUrl, h, tok, id);
  const d = await datiPerStampa(env, h, tok, id, inUrl.searchParams.get("rev"));
  if (!d) return h.risposta(h.foglio(base, "Preventivo", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", ""), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Preventivo", "Preventivo non trovato.", ""), 404);
  let file;
  try {
    file = xlsxPreventivo(d);
  } catch (e) {
    // se il file non riesce, si dà il CSV di prima: meglio un file semplice che nessun file
    console.log(JSON.stringify({ evento: "preventivi_xlsx_errore", errore: String((e && e.message) || e).slice(0, 300) }));
    return excelCsv(request, env, base, inUrl, h, tok, id);
  }
  const f = d.preventivo || {};
  const nome = (String(f.codice || "Preventivo") + " Rev." + (Number(f.revisione) || 1) + (f.cliente && f.cliente.nome ? " - " + f.cliente.nome : ""))
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim().slice(0, 150) + ".xlsx";
  return new Response(request.method === "HEAD" ? null : file, { status: 200, headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": 'attachment; filename="' + nome.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}

// il CSV di prima (preventivo_csv): con la fonte dei prezzi, per l'ufficio
async function excelCsv(request, env, base, inUrl, h, tok, id) {
  let rev = Math.max(0, Math.min(999, parseInt(inUrl.searchParams.get("rev") || "0", 10) || 0));
  if (!rev) {
    const d = await datiPerStampa(env, h, tok, id, "0");
    if (d && d.esito === "ok" && d.foto === true) rev = Number(d.preventivo && d.preventivo.revisione) || 0;
  }
  const r = await h.rpc(env, "preventivo_csv", { p_token: tok, p_id: id, p_revisione: rev }, 15000).catch(() => null);
  if (!r) return h.risposta(h.foglio(base, "Preventivo", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", ""), 503);
  if (r.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (r.esito !== "ok") return h.risposta(h.foglio(base, "Preventivo", "Preventivo non trovato.", ""), 404);
  const nome = String(r.nome_file || "TIX preventivo.csv");
  return new Response(request.method === "HEAD" ? null : "\uFEFF" + String(r.csv || ""), { status: 200, headers: {
    "Content-Type": "text/csv; charset=UTF-8",
    "Content-Disposition": 'attachment; filename="' + nome.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}

// colori della grafica B «Blu e arancione TIX»
const XL = { scuro: "1B2F4A", acc: "F26A10", chiaro: "E9EFF7", zebra: "F3F6FA", bordo: "C8D3E1", grigio: "5C6B7E", barra: "F59A5B",
  nota: "C2540B", bianco: "FFFFFF", extra: "EFEFEC", tenue: "C8D3E1" };
const XL_EURO = "#,##0.00", XL_EURO0 = '#,##0.00;-#,##0.00;"—"', XL_TOT = '#,##0.00 "€ + IVA"';
// zoom dei due fogli all'apertura (preventivi-excel-3): a 150% sul portatile di Filippo (1536 px) il foglio riempie quasi tutta la larghezza
const XL_ZOOM = 150;

// il preventivo (risultato di preventivo_dati) come file .xlsx: Uint8Array
export function xlsxPreventivo(d) {
  const f = d.preventivo || {};
  const T = f.totali || {};
  const imp = f.impresa || {};
  const cl = f.cliente || {};
  const cant = f.cantiere && typeof f.cantiere === "object" ? f.cantiere : null;
  const voci = Array.isArray(f.voci) ? f.voci : [];
  const num = (x) => { const v = Number(x); return isFinite(v) ? v : 0; };
  const rib = num(T.ribasso_pct);
  const foto = d.foto === true;
  const data = foto ? dataIt(f.data || d.mandato_il) : "";
  const codice = String(f.codice || "");
  const rev = Number(f.revisione) || 1;
  const valido = f.validita_giorni || 30;
  const nomeImp = String(imp.nome || "");

  // ---- stili (fonti, riempimenti, bordi, formati dei numeri) registrati una volta sola
  const fonts = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  const numFmts = [];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const formati = {};
  const posto = (arr, x) => { let i = arr.indexOf(x); if (i < 0) { arr.push(x); i = arr.length - 1; } return i; };
  const idFormato = (code) => {
    if (!code) return 0;
    if (code === "0") return 1;
    if (code === "0%") return 9;
    if (!(code in formati)) { formati[code] = 164 + numFmts.length; numFmts.push('<numFmt numFmtId="' + formati[code] + '" formatCode="' + xe(code) + '"/>'); }
    return formati[code];
  };
  const S = (o) => {
    const font = "<font>" + (o.b ? "<b/>" : "") + (o.i ? "<i/>" : "") + '<sz val="' + (o.sz || 10) + '"/><color rgb="FF' + (o.c || XL.scuro) + '"/><name val="' +
      (o.f || "Calibri") + '"/><family val="2"/></font>';
    const fill = o.bg ? '<fill><patternFill patternType="solid"><fgColor rgb="FF' + o.bg + '"/><bgColor indexed="64"/></patternFill></fill>' : fills[0];
    const lato = (n) => (o[n] ? "<" + n + ' style="' + o[n][0] + '"><color rgb="FF' + o[n][1] + '"/></' + n + ">" : "<" + n + "/>");
    const border = "<border>" + lato("left") + lato("right") + lato("top") + lato("bottom") + "<diagonal/></border>";
    const nf = idFormato(o.nf);
    const al = "<alignment" + (o.h ? ' horizontal="' + o.h + '"' : "") + ' vertical="' + (o.v || "top") + '"' + (o.wrap ? ' wrapText="1"' : "") +
      (o.ind ? ' indent="' + o.ind + '"' : "") + "/>";
    return posto(xfs, '<xf numFmtId="' + nf + '" fontId="' + posto(fonts, font) + '" fillId="' + posto(fills, fill) + '" borderId="' + posto(borders, border) +
      '" xfId="0"' + (nf ? ' applyNumberFormat="1"' : "") + ' applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' + al + "</xf>");
  };
  const RPR_N = '<sz val="10"/><color rgb="FF' + XL.scuro + '"/><rFont val="Calibri"/><family val="2"/>';
  const RPR_NOTA = '<i/><sz val="8"/><color rgb="FF' + XL.nota + '"/><rFont val="Calibri"/><family val="2"/>';

  // ---- celle
  const colonna = (c) => { let s = ""; c++; while (c) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
  const A1 = (r, c, abs) => (abs ? "$" : "") + colonna(c) + (abs ? "$" : "") + (r + 1);
  const vn = (n) => String(Math.round(num(n) * 1e6) / 1e6);
  const nuovoFoglio = () => ({ celle: new Map(), alte: new Map(), unite: [], max: 0 });
  const metti = (F, r, c, x) => { let riga = F.celle.get(r); if (!riga) F.celle.set(r, (riga = new Map())); riga.set(c, x); if (r > F.max) F.max = r; };
  const vuota = (F, r, c, s) => metti(F, r, c, '<c r="' + A1(r, c) + '" s="' + s + '"/>');
  const scritta = (F, r, c, t, s) => (t === null || t === undefined || t === "" ? vuota(F, r, c, s)
    : metti(F, r, c, '<c r="' + A1(r, c) + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + xe(t) + "</t></is></c>"));
  const numero = (F, r, c, n, s) => metti(F, r, c, '<c r="' + A1(r, c) + '" s="' + s + '"><v>' + vn(n) + "</v></c>");
  const formula = (F, r, c, fx, v, s) => metti(F, r, c, '<c r="' + A1(r, c) + '" s="' + s + '"><f>' + xe(fx) + "</f><v>" + vn(v) + "</v></c>");
  const ricca = (F, r, c, parti, s) => metti(F, r, c, '<c r="' + A1(r, c) + '" s="' + s + '" t="inlineStr"><is>' +
    parti.map(([t, rp]) => "<r><rPr>" + rp + '</rPr><t xml:space="preserve">' + xe(t) + "</t></r>").join("") + "</is></c>");
  const unisci = (F, r1, c1, r2, c2, t, s) => {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) vuota(F, r, c, s);
    if (t !== undefined) scritta(F, r1, c1, t, s);
    F.unite.push(A1(r1, c1) + ":" + A1(r2, c2));
  };
  const alta = (F, r, x) => { F.alte.set(r, x); if (r > F.max) F.max = r; };
  // righe stimate di un testo a capo automatico (le maiuscole occupano più spazio)
  const righe = (s, larghezza, fattore) => String(s || "").split("\n").reduce((n, p) => {
    let l = 0;
    for (const ch of p) l += ch !== ch.toLowerCase() ? 1.3 : 1;
    return n + Math.max(1, Math.ceil(l / (larghezza * (fattore || 1.3))));
  }, 0);

  // ---- regole del foglio per il cliente (come foglio(): preventivi-stampa-2)
  const nel = (v) => v.nel_totale !== false && !v.extra;
  const senzaRib = (v) => rib > 0 && !((v.fonte === "contratto" || v.fonte === "prezzario") && v.ribassabile);
  const fuoriTxt = (v) => (v.stato === "da_quotare" ? "da quotare con l'offerta del fornitore" : v.stato === "esclusa" ? "esclusa"
    : !num(v.quantita) ? "NP – prezzo da definire: mancano le quantità" : "NP – prezzo da definire per mancanza di dati tecnici");
  const tariffa = (v) => v.codice_computo || (v.fonte === "contratto" ? v.codice : "") || "";
  const n2 = (n) => (n === null || n === undefined || n === "" ? "" : String(n).padStart(2, "0"));
  const nomeCat = (v) => (v.cat_n != null || v.cat_nome ? "CATEGORIA " + n2(v.cat_n) + (v.cat_nome ? " — " + v.cat_nome : "") : "");
  const nomeSez = (v) => (v.sez_n != null || v.sez_nome ? String(v.sez_nome || "").toUpperCase() + (v.sez_n != null ? " (SpCat " + v.sez_n + ")" : "") : "");
  const maiuscola = (s) => { s = String(s || "").toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };

  // ==================================================================== foglio «Computo»
  const C = nuovoFoglio();
  const th = S({ b: 1, sz: 9, c: XL.bianco, bg: XL.scuro, h: "center", v: "center", wrap: 1, bottom: ["thick", XL.acc] });
  const sSez = S({ b: 1, sz: 12, c: XL.bianco, bg: XL.scuro, v: "center", ind: 1 });
  const sCat = S({ b: 1, sz: 10, c: XL.scuro, bg: XL.chiaro, v: "center", ind: 1, left: ["thick", XL.acc] });
  const VF = [0, 1].map((z) => {
    const g = (o) => S(Object.assign(z ? { bg: XL.zebra } : {}, o));
    return { nr: g({ h: "center", c: XL.grigio }), tar: g({ sz: 8, c: XL.grigio, wrap: 1 }), des: g({ wrap: 1 }), um: g({ h: "center" }),
      q: g({ nf: XL_EURO }), p: g({ nf: XL_EURO }), i: g({ nf: XL_EURO, b: 1 }), fP: g({ i: 1, h: "right", c: XL.nota }), fI: g({ h: "center", c: XL.grigio }),
      nascosta: g({ c: XL.bianco, nf: "0" }), vuota: g({}), mis: g({ sz: 9, c: XL.grigio, wrap: 1, ind: 1 }), misQ: g({ i: 1, sz: 9, c: XL.grigio, nf: XL_EURO }) };
  });
  const totcL = S({ b: 1, h: "right", c: XL.acc, bg: XL.chiaro, v: "center" });
  const totcV = S({ b: 1, nf: XL_EURO0, bg: XL.chiaro, v: "center" });
  const totsL = S({ b: 1, sz: 11, h: "right", c: XL.bianco, bg: XL.acc, v: "center" });
  const totsV = S({ b: 1, sz: 11, nf: XL_EURO0, c: XL.bianco, bg: XL.acc, v: "center" });
  const totgL = S({ b: 1, sz: 12, h: "right", c: XL.bianco, bg: XL.scuro, v: "center" });
  const totgV = S({ b: 1, sz: 12, nf: '#,##0.00 "€"', c: XL.bianco, bg: XL.scuro, v: "center", bottom: ["thick", XL.acc] });
  const toteL = S({ i: 1, h: "right", c: XL.grigio, top: ["thin", XL.grigio], v: "center" });
  const toteV = S({ i: 1, nf: XL_EURO0, c: XL.grigio, top: ["thin", XL.grigio], v: "center" });
  const sExtra = S({ b: 1, i: 1, c: XL.grigio, bg: XL.extra, v: "center", ind: 1, wrap: 1, top: ["thin", XL.grigio] });

  alta(C, 0, 24);
  unisci(C, 0, 0, 0, 3, nomeImp, S({ f: "Calibri Light", sz: 13, v: "center" }));
  unisci(C, 0, 4, 0, 6, codice + " · Rev. " + rev + " · " + (foto ? data : "bozza"), S({ b: 1, c: XL.acc, h: "right", v: "center" }));
  const titolo = (cant ? "Lavori extracontrattuali — " : "") + String(f.titolo || "");
  if (righe(titolo, 120) > 1) alta(C, 1, 12 * righe(titolo, 120));
  unisci(C, 1, 0, 1, 6, "COMPUTO METRICO ESTIMATIVO · " + titolo, S({ sz: 9, c: XL.grigio, wrap: 1, v: "center" }));
  alta(C, 2, 6);
  const sRiga = S({ bottom: ["medium", XL.acc] });
  for (let c = 0; c < 7; c++) vuota(C, 2, c, sRiga);
  const R0 = 3;
  alta(C, R0, 30);
  ["N.", "TARIFFA", "DESIGNAZIONE DEI LAVORI", "U.M.", "QUANTITÀ", "PREZZO\nUNITARIO €", "IMPORTO €"].forEach((x, c) => scritta(C, R0, c, x, th));

  let r = R0 + 1, zebra = 0;
  const scriviVoce = (v, nr, dentro) => {
    const z = VF[zebra];
    const note = [];
    if (v.extra) note.push("Da: " + (v.riferimento || "elaborati di progetto"));
    else if (v.fonte === "contratto") note.push("Elenco prezzi del contratto");
    if (senzaRib(v) && dentro) note.push("senza ribasso");
    if (!dentro) note.push(fuoriTxt(v));
    if (typeof nr === "number") numero(C, r, 0, nr, z.nr); else scritta(C, r, 0, String(nr), z.nr);
    scritta(C, r, 1, tariffa(v), z.tar);
    // 06/11/2026 (preventivi-computo-2): la descrizione intera del computo; oltre ~1400 caratteri continua nelle righe sotto
    // (una riga di Excel non supera 409 punti di altezza, circa 30 righe di testo)
    const pezzi = spezzaTesto(String(v.descrizione || ""), 1400);
    const ultimo = pezzi.length - 1;
    const desc = (rr, t, conNote) => (conNote && note.length ? ricca(C, rr, 2, [[t, RPR_N], ["\n" + note.join(" · "), RPR_NOTA]], z.des) : scritta(C, rr, 2, t, z.des));
    desc(r, pezzi[0], ultimo === 0);
    scritta(C, r, 3, v.unita || "", z.um);
    const q = num(v.quantita), p = num(v.prezzo);
    numero(C, r, 4, q, z.q);
    if (dentro || p) numero(C, r, 5, p, z.p); else scritta(C, r, 5, v.stato === "da_quotare" ? "da quotare" : "NP", z.fP);
    let val = 0;
    if (dentro) {
      val = Math.round(q * p * 100) / 100;
      formula(C, r, 6, "ROUND(" + A1(r, 4) + "*" + A1(r, 5) + ",2)", val, z.i);
      // colonne nascoste per il quadro economico: H = 1 voce con il ribasso / 0 senza; I = 1 elenco prezzi del contratto / 0 altre
      if (!v.extra) { numero(C, r, 7, rib > 0 && !senzaRib(v) ? 1 : 0, z.nascosta); numero(C, r, 8, v.fonte === "contratto" ? 1 : 0, z.nascosta); }
    } else {
      scritta(C, r, 6, "—", z.fI);
    }
    r++;
    for (let k = 1; k <= ultimo; k++) {
      for (let c = 0; c < 7; c++) vuota(C, r, c, z.vuota);
      desc(r, pezzi[k], k === ultimo);
      r++;
    }
    // righe di misura sotto la voce: dove, fattori e quantità parziale
    (Array.isArray(v.misure) ? v.misure : []).forEach((m) => {
      const fattori = ["parti", "lun", "lar", "alt"].filter((x) => m[x] !== null && m[x] !== undefined && m[x] !== "")
        .map((x) => cifra(m[x], x === "parti" && Number.isInteger(Number(m[x])) ? 0 : 2));
      for (let c = 0; c < 7; c++) vuota(C, r, c, z.vuota);
      scritta(C, r, 2, (m.dove ? m.dove + (fattori.length ? ": " : "") : "") + fattori.join(" × "), z.mis);
      numero(C, r, 4, num(m.q), z.misQ);
      r++;
    });
    zebra = 1 - zebra;
    return val;
  };

  const righeCat = [];   // { nome, n, rif, val, sez }
  const righeSez = [];   // { nome, rif, val }
  let kS = null, kC = null, cc = "", sc = 0, ss = 0, celleCat = [], prima = null, nVoci = 0;
  const chiudiCat = () => {
    if (prima === null) return;
    alta(C, r, 18);
    const m = /^CATEGORIA (\S*)(?: — (.*))?$/.exec(cc || "");
    unisci(C, r, 0, r, 5, m ? "Totale categoria " + m[1] + (m[2] ? " — " + maiuscola(m[2]) : "") : "Totale lavori", totcL);
    formula(C, r, 6, "SUM(" + A1(prima, 6) + ":" + A1(r - 1, 6) + ")", Math.round(sc * 100) / 100, totcV);
    righeCat.push({ nome: cc, n: nVoci, rif: "Computo!" + A1(r, 6, true), val: Math.round(sc * 100) / 100, sez: kS });
    celleCat.push(A1(r, 6));
    r++;
    sc = 0; prima = null; nVoci = 0;
  };
  const chiudiSez = () => {
    if (!kS) { celleCat = []; return; }
    alta(C, r, 21);
    unisci(C, r, 0, r, 5, "Totale " + kS, totsL);
    formula(C, r, 6, celleCat.join("+"), Math.round(ss * 100) / 100, totsV);
    righeSez.push({ nome: kS, rif: "Computo!" + A1(r, 6, true), val: Math.round(ss * 100) / 100 });
    r++;
    alta(C, r, 8);
    r++;
    ss = 0; celleCat = [];
  };
  const comp = voci.filter((v) => !v.extra), extra = voci.filter((v) => v.extra);
  comp.forEach((v, i) => {
    const ks = nomeSez(v), kc = ks + "|" + nomeCat(v);
    if (kc !== kC) {
      if (kC !== null) { chiudiCat(); if (ks !== kS) chiudiSez(); }
      if (ks !== kS && ks) { alta(C, r, 24); unisci(C, r, 0, r, 6, ks, sSez); r++; }
      cc = nomeCat(v);
      if (cc) { alta(C, r, 19); unisci(C, r, 0, r, 6, cc.toUpperCase(), sCat); r++; }
      kS = ks; kC = kc; zebra = 0;
    }
    if (prima === null) prima = r;
    const val = scriviVoce(v, v.nr_computo != null ? v.nr_computo : i + 1, nel(v));
    sc += val; ss += val; nVoci++;
  });
  if (kC !== null) { chiudiCat(); chiudiSez(); }
  const lordo = Math.round(righeCat.reduce((s, x) => s + x.val, 0) * 100) / 100;
  r++;
  alta(C, r, 26);
  unisci(C, r, 0, r, 5, rib > 0 ? "TOTALE PRIMA DEL RIBASSO" : "TOTALE DELLE VOCI DEL COMPUTO", totgL);
  const celleTot = (righeSez.length ? righeSez : righeCat).map((x) => x.rif.replace("Computo!", ""));
  formula(C, r, 6, celleTot.length ? celleTot.join("+") : "0", lordo, totgV);
  const cellaLordo = "Computo!" + A1(r, 6, true);
  r += 2;
  let totExtra = 0, cellaExtra = null;
  if (extra.length) {
    alta(C, r, 30);
    unisci(C, r, 0, r, 6, "EXTRA COMPUTO – LAVORAZIONI RILEVATE DAGLI ELABORATI DI PROGETTO\nNon comprese nel totale del preventivo", sExtra);
    r++;
    const primaE = r;
    zebra = 0;
    extra.forEach((v, i) => { totExtra += scriviVoce(v, "E" + (i + 1), !!num(v.prezzo) && ["ok", "da_verificare"].includes(v.stato)); });
    alta(C, r, 18);
    unisci(C, r, 0, r, 5, "Totale extra computo (non compreso nel totale del preventivo)", toteL);
    formula(C, r, 6, "SUM(" + A1(primaE, 6) + ":" + A1(r - 1, 6) + ")", Math.round(totExtra * 100) / 100, toteV);
    cellaExtra = "Computo!" + A1(r, 6, true);
    r++;
  }
  r++;
  unisci(C, r, 0, r, 6, "Importi in euro, IVA esclusa. Il riepilogo e il quadro economico sono nel foglio «Riepilogo».", S({ i: 1, sz: 8, c: XL.grigio }));
  const ultimaC = r;

  // ==================================================================== foglio «Riepilogo»
  const R = nuovoFoglio();
  const sigla = nomeImp.split(/[\s.,&'’-]+/).filter((x) => x && !/^(s\.?r\.?l|s\.?p\.?a|s\.?n\.?c|s\.?a\.?s|di|e|ed|la|il)$/i.test(x))
    .slice(0, 2).map((x, i, a) => (a.length === 1 ? x.slice(0, 2) : x[0])).join("").toUpperCase();
  alta(R, 0, 8); alta(R, 1, 30); alta(R, 2, 16);
  unisci(R, 1, 1, 2, 1, sigla, S({ b: 1, f: "Calibri Light", sz: 16, c: XL.bianco, bg: XL.scuro, h: "center", v: "center" }));
  scritta(R, 1, 2, nomeImp, S({ f: "Calibri Light", sz: 16, v: "center", ind: 1 }));
  scritta(R, 2, 2, [imp.indirizzo, imp.partita_iva ? "P. IVA " + imp.partita_iva : "", imp.telefono ? "Tel. " + imp.telefono : "", imp.email].filter(Boolean).join(" · "),
    S({ sz: 9, c: XL.grigio, v: "center", ind: 1 }));
  unisci(R, 1, 3, 1, 5, "PREVENTIVO N. " + codice, S({ b: 1, sz: 11, c: XL.acc, h: "right", v: "center" }));
  unisci(R, 2, 3, 2, 5, "Rev. " + rev + " · " + (foto ? "del " + data : "Bozza") + " · valido " + valido + " giorni", S({ sz: 9, c: XL.grigio, h: "right", v: "center" }));
  alta(R, 3, 8);
  const sLinea = S({ bottom: ["thick", XL.acc] });
  for (let c = 1; c <= 5; c++) vuota(R, 3, c, sLinea);
  alta(R, 4, 10); alta(R, 5, 32);
  unisci(R, 5, 1, 5, 5, "PREVENTIVO", S({ f: "Calibri Light", sz: 24, h: "center", v: "center" }));
  alta(R, 6, 15);
  unisci(R, 6, 1, 6, 5, "C O M P U T O   M E T R I C O   E S T I M A T I V O", S({ sz: 9, c: XL.acc, h: "center", v: "center" }));
  alta(R, 7, 10);
  const etich = S({ b: 1, sz: 8, c: XL.grigio, bg: XL.chiaro, v: "center", ind: 1, bottom: ["thin", XL.bianco] });
  const valore = S({ wrap: 1, v: "center", ind: 1, bottom: ["thin", XL.bordo] });
  const info = [
    ["COMMITTENTE", String(cl.nome || "") + (cl.indirizzo ? " — " + cl.indirizzo : "") + (cl.piva ? "\nP. IVA / C.F. " + cl.piva : "")],
    ["LAVORI", titolo],
    [cant ? "CANTIERE" : "LUOGO", cant ? String(cant.nome || "") + (cant.ubicazione ? " — " + cant.ubicazione : "") +
      (f.indirizzo_lavoro && f.indirizzo_lavoro !== cant.ubicazione ? "\n" + f.indirizzo_lavoro : "") : f.indirizzo_lavoro || "—"],
    ["REFERENTE", imp.referente || "—"]];
  let rr = 8;
  info.forEach(([k, v]) => {
    alta(R, rr, Math.max(18, 13 * righe(v, 105) + 5));
    scritta(R, rr, 1, k, etich);
    unisci(R, rr, 2, rr, 5, v, valore);
    rr++;
  });
  rr++;
  // il totale in evidenza, subito sotto l'intestazione
  alta(R, rr, 16);
  unisci(R, rr, 1, rr, 3, "TOTALE DEL PREVENTIVO", S({ b: 1, sz: 9, c: XL.bianco, bg: XL.scuro, v: "bottom", ind: 1 }));
  unisci(R, rr, 4, rr, 5, comp.length + " voci" + (extra.length ? " · " + extra.length + " extra a parte" : ""), S({ sz: 8, c: XL.tenue, bg: XL.scuro, h: "right", v: "bottom" }));
  rr++;
  alta(R, rr, 34);
  const rigaKpi = rr;
  const sKpi = S({ b: 1, sz: 22, c: XL.bianco, bg: XL.scuro, nf: XL_TOT, h: "left", v: "center", ind: 1 });
  unisci(R, rr, 1, rr, 5, undefined, sKpi);
  rr++;
  alta(R, rr, 5);
  const sStriscia = S({ bg: XL.acc });
  for (let c = 1; c <= 5; c++) vuota(R, rr, c, sStriscia);
  rr += 2;
  const h2 = S({ b: 1, sz: 12, v: "center", bottom: ["medium", XL.acc] });
  const conCat = righeCat.some((x) => x.nome);
  alta(R, rr, 22);
  unisci(R, rr, 1, rr, 5, conCat ? "RIEPILOGO PER CATEGORIE" : "RIEPILOGO PER PROVENIENZA", h2);
  rr++;
  alta(R, rr, 16);
  [["N.", "center"], ["CATEGORIA", "left"], ["VOCI", "center"], ["IMPORTO €", "right"], ["%", "right"]].forEach(([x, al], i) =>
    scritta(R, rr, i + 1, conCat || i !== 1 ? x : "PROVENIENZA", S({ b: 1, sz: 8, c: XL.grigio, v: "center", h: al, bottom: ["thin", XL.bordo] })));
  rr++;
  const rz = [0, 1].map((z) => {
    const g = (o) => S(Object.assign(z ? { bg: XL.zebra } : {}, o));
    return { n: g({ h: "center", c: XL.grigio, v: "center" }), t: g({ v: "center" }), vo: g({ h: "center", c: XL.grigio, v: "center" }),
      val: g({ nf: XL_EURO0, v: "center" }), pc: g({ nf: "0.0%", v: "center", h: "right", c: XL.grigio }) };
  });
  const szT = S({ b: 1, v: "center", bg: XL.chiaro, left: ["thick", XL.acc] });
  const szT2 = S({ b: 1, v: "center", bg: XL.chiaro });
  const szV = S({ b: 1, nf: XL_EURO0, v: "center", bg: XL.chiaro });
  const szP = S({ b: 1, nf: "0.0%", v: "center", h: "right", bg: XL.chiaro });
  const righeRie = [];   // { r, val, z }
  // senza categorie: come nel foglio da stampare, l'elenco prezzi del contratto a parte e il resto come «Lavorazioni»
  const gruppi = conCat ? righeCat : [
    { nome: "Elenco prezzi del contratto", n: comp.filter((v) => nel(v) && v.fonte === "contratto").length, rif: "SUMIF(Computo!$I:$I,1,Computo!$G:$G)",
      val: Math.round(comp.filter((v) => nel(v) && v.fonte === "contratto").reduce((s, v) => s + Math.round(num(v.quantita) * num(v.prezzo) * 100) / 100, 0) * 100) / 100, formula: true },
    { nome: "Lavorazioni", n: comp.filter((v) => nel(v) && v.fonte !== "contratto").length, rif: "SUMIF(Computo!$I:$I,0,Computo!$G:$G)",
      val: Math.round(comp.filter((v) => nel(v) && v.fonte !== "contratto").reduce((s, v) => s + Math.round(num(v.quantita) * num(v.prezzo) * 100) / 100, 0) * 100) / 100, formula: true }
  ].filter((g) => g.n);
  const piuSez = new Set(righeCat.map((x) => x.sez)).size > 1;
  zebra = 0;
  gruppi.forEach((g, i) => {
    alta(R, rr, 16);
    const z = rz[zebra];
    const m = /^CATEGORIA (\d+)(?: — (.*))?/.exec(g.nome || "");
    scritta(R, rr, 1, m ? m[1] : "", z.n);
    scritta(R, rr, 2, m ? maiuscola(m[2] || "") : g.nome || "Lavorazioni", z.t);
    numero(R, rr, 3, g.n, z.vo);
    formula(R, rr, 4, g.formula ? g.rif : g.rif, g.val, z.val);
    righeRie.push({ r: rr, val: g.val, z });
    zebra = 1 - zebra;
    rr++;
    const nx = gruppi[i + 1];
    if (conCat && piuSez && (!nx || nx.sez !== g.sez)) {
      const sz = righeSez.find((x) => x.nome === g.sez);
      if (sz) {
        alta(R, rr, 18);
        vuota(R, rr, 1, szT);
        unisci(R, rr, 2, rr, 3, "Totale " + sz.nome, szT2);
        formula(R, rr, 4, sz.rif, sz.val, szV);
        righeRie.push({ r: rr, val: null });
        rr++;
        zebra = 0;
      }
    }
  });
  const totT = S({ b: 1, sz: 11, v: "center", top: ["medium", XL.scuro] });
  alta(R, rr, 20);
  vuota(R, rr, 1, totT);
  unisci(R, rr, 2, rr, 3, rib > 0 ? "Totale prima del ribasso" : "Totale delle voci", totT);
  formula(R, rr, 4, cellaLordo, lordo, S({ b: 1, sz: 11, nf: XL_EURO, v: "center", top: ["medium", XL.scuro] }));
  formula(R, rr, 5, "IF(" + A1(rr, 4) + ">0,1,0)", lordo > 0 ? 1 : 0, S({ b: 1, sz: 11, nf: "0%", v: "center", h: "right", top: ["medium", XL.scuro] }));
  const totRie = A1(rr, 4, true);
  const barre = [];
  righeRie.forEach((x) => {
    formula(R, x.r, 5, "IF(" + totRie + ">0," + A1(x.r, 4) + "/" + totRie + ",0)", lordo > 0 && x.val !== null ? x.val / lordo : 0, x.val !== null ? x.z.pc : szP);
    if (x.val !== null) barre.push(A1(x.r, 5));
  });
  rr++;
  if (extra.length) {
    alta(R, rr, 16);
    unisci(R, rr, 2, rr, 3, "Extra computo: " + extra.length + (extra.length === 1 ? " lavorazione rilevata" : " lavorazioni rilevate") + " dagli elaborati, non comprese",
      S({ i: 1, sz: 9, c: XL.grigio, v: "center" }));
    formula(R, rr, 4, cellaExtra, Math.round(totExtra * 100) / 100, S({ i: 1, sz: 9, c: XL.grigio, nf: XL_EURO0, v: "center", h: "right" }));
    rr++;
  }
  rr++;
  // quadro economico
  alta(R, rr, 22);
  unisci(R, rr, 1, rr, 5, "QUADRO ECONOMICO", h2);
  rr++;
  const qb = { bottom: ["thin", XL.bordo] };
  const sQ = S(qb);
  const rigaQe = (testo, fx, v, grassetto) => {
    alta(R, rr, 18);
    vuota(R, rr, 1, sQ);
    unisci(R, rr, 2, rr, 3, testo, S(Object.assign({ b: grassetto ? 1 : 0, v: "center" }, qb)));
    formula(R, rr, 4, fx, v, S(Object.assign({ b: grassetto ? 1 : 0, nf: XL_EURO, v: "center" }, qb)));
    vuota(R, rr, 5, sQ);
    return A1(rr++, 4);
  };
  let lav;
  if (rib > 0) {
    const s1 = rigaQe("Voci con il ribasso", "SUMIF(Computo!$H:$H,1,Computo!$G:$G)", num(T.soggetto));
    const s2 = rigaQe("Ribasso del contratto " + cifra(rib, 2) + " %", "-ROUND(" + s1 + "*" + vn(rib) + "/100,2)", -num(T.ribasso));
    const s3 = rigaQe("Voci senza ribasso", "SUMIF(Computo!$H:$H,0,Computo!$G:$G)", num(T.non_soggetto));
    lav = rigaQe("Totale lavori", s1 + "+" + s2 + "+" + s3, num(T.lavori), true);
  } else {
    lav = rigaQe("Totale lavori", totRie, lordo, true);
  }
  const parti = [lav];
  if (num(T.oneri)) parti.push(rigaQe("Oneri della sicurezza (senza ribasso)", vn(T.oneri), num(T.oneri)));
  if (num(T.sconto)) parti.push(rigaQe("Sconto", "-" + vn(T.sconto), -num(T.sconto)));
  alta(R, rr, 30);
  const bigL = S({ b: 1, sz: 13, c: XL.bianco, bg: XL.acc, v: "center", ind: 1 });
  const bigV = S({ b: 1, sz: 14, c: XL.bianco, bg: XL.acc, nf: XL_TOT, h: "right", v: "center" });
  vuota(R, rr, 1, bigL);
  unisci(R, rr, 2, rr, 3, "TOTALE", bigL);
  unisci(R, rr, 4, rr, 5, undefined, bigV);
  formula(R, rr, 4, parti.join("+"), num(T.totale), bigV);
  const cellaTot = A1(rr, 4, true);
  formula(R, rigaKpi, 1, cellaTot, num(T.totale), sKpi);
  rr += 2;
  // condizioni (come nel foglio da stampare)
  alta(R, rr, 22);
  unisci(R, rr, 1, rr, 5, "CONDIZIONI", h2);
  rr++;
  const fuori = comp.filter((v) => !nel(v)).length;
  const cond = [];
  if (fuori) cond.push(fuori === 1 ? "1 voce del computo (NP o da quotare) non ha ancora il prezzo e non è compresa nel totale."
    : fuori + " voci del computo (NP o da quotare) non hanno ancora il prezzo e non sono comprese nel totale.");
  if (extra.length) cond.push("Le lavorazioni del capitolo «Extra computo», rilevate dagli elaborati di progetto, non sono comprese nel totale.");
  const k = f.contratto && typeof f.contratto === "object" ? f.contratto : null;
  if (voci.some((v) => v.fonte === "contratto")) cond.push("Prezzi presi dall'elenco prezzi del contratto" + (k && k.data_contratto ? " del " + dataIt(k.data_contratto) : "") +
    (rib > 0 ? ", con il ribasso del contratto " + cifra(rib, 2) + " %" + (voci.some(senzaRib) ? " (le voci segnate «senza ribasso» non lo hanno)" : "") : "") + ".");
  cond.push("Le quantità si misurano a lavoro finito" + (cant ? ", in contraddittorio con la Direzione Lavori" : "") + ".");
  cond.push("Il preventivo vale " + valido + " giorni dalla data. Importi in euro, IVA esclusa.");
  if (f.note) cond.push(String(f.note));
  const sPunto = S({ b: 1, c: XL.acc, h: "right" });
  const sCond = S({ wrap: 1 });
  cond.forEach((x) => {
    alta(R, rr, Math.max(16, 13 * righe(x, 108, 1.5) + 3));
    scritta(R, rr, 1, "•", sPunto);
    unisci(R, rr, 2, rr, 5, x, sCond);
    rr++;
  });
  rr++;
  // firme
  const fl = S({ sz: 9, c: XL.grigio, h: "center" }), fn = S({ b: 1, h: "center" }), ff = S({ sz: 8, c: XL.grigio, h: "center", top: ["thin", XL.scuro] });
  unisci(R, rr, 1, rr, 2, "L'impresa", fl); unisci(R, rr, 4, rr, 5, "Per accettazione", fl); rr++;
  unisci(R, rr, 1, rr, 2, nomeImp, fn); unisci(R, rr, 4, rr, 5, "il committente", fn); rr++;
  alta(R, rr, 34); rr++;
  unisci(R, rr, 1, rr, 2, "timbro e firma", ff); unisci(R, rr, 4, rr, 5, "data, timbro e firma", ff);
  rr += 2;
  const sha = String(d.sha256 || "");
  unisci(R, rr, 1, rr, 5, "Il dettaglio delle voci è nel foglio «Computo».   " + (foto && sha ? "Impronta SHA-256 " + sha.slice(0, 8) + "…" + sha.slice(-4) + " · " : "") +
    "Preparato con TIX™ · www.tixcantiere.it", S({ i: 1, sz: 8, c: XL.grigio, h: "center" }));
  const ultimaR = rr;

  // ==================================================================== file
  const piede = "&L&8" + nomeImp.replace(/&/g, "&&") + " · Preventivo " + codice + " · Rev. " + rev +
    "&C&8Preparato con TIX™ · www.tixcantiere.it&R&8Pagina &P di &N";
  const UID = "{DA7ABA51-AAAA-BBBB-0001-000000000001}";
  const xmlFoglio = (F, o) => {
    const nr = [...new Set([...F.celle.keys(), ...F.alte.keys()])].sort((a, b) => a - b);
    const rows = nr.map((x) => {
      const cs = F.celle.get(x), hh = F.alte.get(x);
      const dentro = cs ? [...cs.keys()].sort((a, b) => a - b).map((c) => cs.get(c)).join("") : "";
      return '<row r="' + (x + 1) + '"' + (hh ? ' ht="' + hh + '" customHeight="1"' : "") + (dentro ? ">" + dentro + "</row>" : "/>");
    }).join("");
    const sq = (o.barre || []).join(" ");
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetPr><tabColor rgb="FF' + o.tab + '"/><pageSetUpPr fitToPage="1"/></sheetPr>' +
      '<sheetViews><sheetView showGridLines="0"' + (o.attivo ? ' tabSelected="1"' : "") + ' zoomScale="' + XL_ZOOM + '" zoomScaleNormal="' + XL_ZOOM + '" workbookViewId="0">' +
      (o.blocca ? '<pane ySplit="' + o.blocca + '" topLeftCell="A' + (o.blocca + 1) + '" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>' : "") +
      "</sheetView></sheetViews>" +
      '<sheetFormatPr defaultRowHeight="15"/><cols>' +
      o.colonne.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (w + 0.7109375) + '" customWidth="1"' + (i >= 7 ? ' hidden="1"' : "") + "/>").join("") +
      "</cols><sheetData>" + rows + "</sheetData>" +
      (F.unite.length ? '<mergeCells count="' + F.unite.length + '">' + F.unite.map((m) => '<mergeCell ref="' + m + '"/>').join("") + "</mergeCells>" : "") +
      (sq ? '<conditionalFormatting sqref="' + sq + '"><cfRule type="dataBar" priority="1"><dataBar><cfvo type="num" val="0"/><cfvo type="num" val="1"/>' +
        '<color rgb="FF' + XL.barra + '"/></dataBar><extLst><ext xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" ' +
        'uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}"><x14:id>' + UID + "</x14:id></ext></extLst></cfRule></conditionalFormatting>" : "") +
      '<printOptions horizontalCentered="1"/><pageMargins left="0.45" right="0.45" top="0.5" bottom="0.6" header="0.3" footer="0.25"/>' +
      '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="' + o.pagine + '"/>' +
      "<headerFooter><oddFooter>" + xe(piede) + "</oddFooter></headerFooter>" +
      (sq ? '<extLst><ext xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}">' +
        '<x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">' +
        '<x14:cfRule type="dataBar" id="' + UID + '"><x14:dataBar minLength="0" maxLength="100" gradient="0"><x14:cfvo type="num"><xm:f>0</xm:f></x14:cfvo>' +
        '<x14:cfvo type="num"><xm:f>1</xm:f></x14:cfvo><x14:negativeFillColor rgb="FFFF0000"/><x14:axisColor rgb="FF000000"/></x14:dataBar></x14:cfRule>' +
        "<xm:sqref>" + sq + "</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst>" : "") +
      "</worksheet>";
  };
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const NS_P = "http://schemas.openxmlformats.org/package/2006/relationships";
  const CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.";
  const ora = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const stili = XML + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (numFmts.length ? '<numFmts count="' + numFmts.length + '">' + numFmts.join("") + "</numFmts>" : "") +
    '<fonts count="' + fonts.length + '">' + fonts.join("") + '</fonts><fills count="' + fills.length + '">' + fills.join("") +
    '</fills><borders count="' + borders.length + '">' + borders.join("") + '</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + xfs.length + '">' + xfs.join("") + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/></styleSheet>';
  // 06/11/2026 (preventivi-excel-3, Filippo: «vorrei vedere tutto quanto nello stesso modo»): il Riepilogo largo quanto il Computo
  // (128 caratteri in tutti e due) e tutti e due i fogli con lo stesso zoom all'apertura (XL_ZOOM)
  const foglioR = xmlFoglio(R, { tab: XL.scuro, attivo: true, colonne: [2, 15, 54, 10, 24, 20, 3], pagine: 1, barre });
  const foglioC = xmlFoglio(C, { tab: XL.acc, blocca: R0 + 1, colonne: [6, 17, 58, 7, 11, 12, 17, 4, 4], pagine: 0 });
  const titoloDoc = "Preventivo " + codice + " · Rev. " + rev;
  return zipSenzaCompressione([
    ["[Content_Types].xml", XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="' + CT + 'sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="' + CT + 'worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="' + CT + 'worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="' + CT + 'styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'],
    ["_rels/.rels", XML + '<Relationships xmlns="' + NS_P + '"><Relationship Id="rId1" Type="' + NS_R + '/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="' + NS_R + '/extended-properties" Target="docProps/app.xml"/></Relationships>'],
    ["docProps/core.xml", XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + xe(titoloDoc) + "</dc:title><dc:subject>" + xe(f.titolo || "Preventivo") +
      "</dc:subject><dc:creator>" + xe(nomeImp) + "</dc:creator><dc:description>Preparato con TIX™ · www.tixcantiere.it</dc:description>" +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + ora + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + ora + "</dcterms:modified></cp:coreProperties>"],
    ["docProps/app.xml", XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>TIX</Application><Company>' + xe(nomeImp) + "</Company></Properties>"],
    // 06/11/2026 (preventivi-excel-2, Filippo: «la pagina è chiusa»): la finestra si apre a tutto schermo, con i valori che Excel
    // stesso scrive per una finestra ingrandita (prima era 16095×9660 twip, circa 1073×644 pixel)
    ["xl/workbook.xml", XML + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + NS_R + '">' +
      '<workbookPr/><bookViews><workbookView xWindow="-120" yWindow="-120" windowWidth="29040" windowHeight="15720" activeTab="0"/></bookViews>' +
      '<sheets><sheet name="Riepilogo" sheetId="1" r:id="rId1"/><sheet name="Computo" sheetId="2" r:id="rId2"/></sheets><definedNames>' +
      '<definedName name="_xlnm.Print_Area" localSheetId="0">Riepilogo!$A$1:$G$' + (ultimaR + 1) + "</definedName>" +
      '<definedName name="_xlnm.Print_Area" localSheetId="1">Computo!$A$1:$G$' + (ultimaC + 1) + "</definedName>" +
      '<definedName name="_xlnm.Print_Titles" localSheetId="1">Computo!$' + (R0 + 1) + ":$" + (R0 + 1) + "</definedName>" +
      '</definedNames><calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>'],
    ["xl/_rels/workbook.xml.rels", XML + '<Relationships xmlns="' + NS_P + '"><Relationship Id="rId1" Type="' + NS_R + '/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="' + NS_R + '/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="' + NS_R + '/styles" Target="styles.xml"/></Relationships>'],
    ["xl/styles.xml", stili],
    ["xl/worksheets/sheet1.xml", foglioR],
    ["xl/worksheets/sheet2.xml", foglioC]
  ]);
}

// un testo lungo in pezzi di al massimo n caratteri, tagliati dopo un punto o, se non c'\u00e8, a uno spazio
function spezzaTesto(s, n) {
  const out = [];
  s = String(s || "");
  while (s.length > n) {
    let k = s.lastIndexOf(". ", n);
    if (k < n * 0.6) k = s.lastIndexOf(" ", n); else k += 1;
    if (k < n * 0.5) k = n;
    out.push(s.slice(0, k).trim());
    s = s.slice(k).trim();
  }
  out.push(s);
  return out;
}

// testo sicuro dentro l'XML (via anche i caratteri che l'XML non ammette); senza caratteri speciali il testo resta com'\u00e8
const XE_SPECIALI = /[&<>"\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;
const XE_SOST = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function xe(s) {
  s = String(s === null || s === undefined ? "" : s);
  if (!XE_SPECIALI.test(s)) return s;
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").replace(/[&<>"]/g, (c) => XE_SOST[c]);
}

// archivio zip senza compressione (metodo «stored»): file = [[nome, testo]] → Uint8Array
let TAB_CRC = null;
function crc32(b) {
  if (!TAB_CRC) {
    TAB_CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; TAB_CRC[n] = c >>> 0; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = TAB_CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipSenzaCompressione(file) {
  const enc = new TextEncoder();
  const ora = new Date();
  const tempo = (ora.getUTCHours() << 11) | (ora.getUTCMinutes() << 5) | Math.floor(ora.getUTCSeconds() / 2);
  const giorno = ((ora.getUTCFullYear() - 1980) << 9) | ((ora.getUTCMonth() + 1) << 5) | ora.getUTCDate();
  const locali = [], centrali = [];
  let pos = 0;
  for (const [nome, testo] of file) {
    const n = enc.encode(nome), dati = enc.encode(testo), crc = crc32(dati);
    const l = new DataView(new ArrayBuffer(30));
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0, true); l.setUint16(8, 0, true);
    l.setUint16(10, tempo, true); l.setUint16(12, giorno, true); l.setUint32(14, crc, true);
    l.setUint32(18, dati.length, true); l.setUint32(22, dati.length, true); l.setUint16(26, n.length, true); l.setUint16(28, 0, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0, true); c.setUint16(10, 0, true);
    c.setUint16(12, tempo, true); c.setUint16(14, giorno, true); c.setUint32(16, crc, true);
    c.setUint32(20, dati.length, true); c.setUint32(24, dati.length, true); c.setUint16(28, n.length, true);
    c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, pos, true);
    locali.push(new Uint8Array(l.buffer), n, dati);
    centrali.push(new Uint8Array(c.buffer), n);
    pos += 30 + n.length + dati.length;
  }
  const dimC = centrali.reduce((s, x) => s + x.length, 0);
  const fine = new DataView(new ArrayBuffer(22));
  fine.setUint32(0, 0x06054b50, true); fine.setUint16(4, 0, true); fine.setUint16(6, 0, true);
  fine.setUint16(8, file.length, true); fine.setUint16(10, file.length, true); fine.setUint32(12, dimC, true); fine.setUint32(16, pos, true); fine.setUint16(20, 0, true);
  const parti = [...locali, ...centrali, new Uint8Array(fine.buffer)];
  const out = new Uint8Array(parti.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const p of parti) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------------------- copia firmata
// La copia firmata (a mano e scansionata, o con firma digitale: .pdf o .p7m) va nell'archivio: con il cantiere in
// «documenti/<cantiere>/preventivi/…» (si cancella con il cantiere), senza in «preventivi/<impresa>/…» (si cancella con l'impresa).
async function caricaFirmato(request, env, inUrl, h) {
  const tok = gettone(inUrl.searchParams.get("t"));
  const id = uuid(inUrl.searchParams.get("id"));
  const nome = String(inUrl.searchParams.get("nome") || "").replace(/[\u0000-\u001f\\/]+/g, " ").trim().slice(0, 180);
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!id) return json({ esito: "errore" }, 400);
  const est = ((/\.(pdf|p7m)$/i.exec(nome) || [])[1] || "").toLowerCase();
  if (!est) return json({ esito: "formato", messaggio: "Carica la copia firmata in PDF (anche con firma digitale: .pdf o .p7m)." }, 400);
  if (Number(request.headers.get("Content-Length") || 0) > MAX_FILE) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 18 MB)." }, 413);
  // prima il controllo dell'accesso, poi il file
  const info = await h.rpc(env, "preventivo_azione", { p_token: tok, p_azienda: "", p_azione: "firmato_info", p_dati: { id } }, 10000).catch(() => null);
  if (!info) return json({ esito: "incerto" }, 503);
  if (info.esito !== "ok") return json({ esito: String(info.esito), messaggio: info.messaggio || "" }, info.esito === "gettone" ? 403 : 400);
  if (info.stato !== "accettato") return json({ esito: "errore", messaggio: "La copia firmata si carica dopo aver segnato il preventivo come accettato." });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length > MAX_FILE) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 18 MB)." }, 413);
  if (est === "pdf" && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "%PDF") return json({ esito: "formato", messaggio: "Il file non è un PDF." }, 400);
  const ora = new Date();
  const giorno = ora.getUTCFullYear() + String(ora.getUTCMonth() + 1).padStart(2, "0") + String(ora.getUTCDate()).padStart(2, "0");
  const cartella = UUID.test(String(info.commessa_id || "")) ? "documenti/" + info.commessa_id + "/preventivi/" : "preventivi/" + info.azienda_id + "/";
  if (!UUID.test(String(info.commessa_id || "")) && !UUID.test(String(info.azienda_id || ""))) return json({ esito: "errore" }, 400);
  const percorso = cartella + String(info.codice || "preventivo").replace(/[^A-Za-z0-9-]+/g, "") + "-rev" + (Number(info.revisione) || 1) + "-firmato-" + giorno + "-" + casuale() + "." + est;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const up = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorso, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY,
                 "Content-Type": est === "pdf" ? "application/pdf" : "application/pkcs7-mime", "x-upsert": "false" },
      body: bytes, signal: ctrl.signal
    });
    if (!up.ok) return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } catch (e) {
    return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } finally { clearTimeout(timer); }
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
  const r = await h.rpc(env, "preventivo_azione", { p_token: tok, p_azienda: "", p_azione: "firmato",
    p_dati: { id, path: percorso, nome: nome || null, sha256: sha, byte: String(bytes.length) } }, 10000).catch(() => null);
  if (!r) return json({ esito: "incerto" }, 503);
  if (r.esito !== "ok") return json({ esito: String(r.esito), messaggio: r.messaggio || "" });
  // la copia sostituita non serve più: si toglie dall'archivio (solo se è davvero di questo preventivo)
  const vecchio = String(info.path || "");
  if (vecchio && vecchio !== percorso && vecchio.indexOf(cartella) === 0 && !/\.\./.test(vecchio)) {
    await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + vecchio.split("/").map(encodeURIComponent).join("/"), {
      method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  }
  return json({ esito: "ok", sha256: sha });
}

// ---------------------------------------------------------------------------- «Prepara con TIX»: un file per la lettura
// Il computo in Excel o in PDF, tavole e relazioni in PDF (il resto lo controlla la funzione preventivo-ia). Il file va in
// «preventivi/<impresa>/ia/<lettura>/…» solo finché serve: la funzione lo toglie quando la lettura finisce, e con l'impresa
// si cancella comunque tutta la cartella «preventivi/<impresa>/».
async function caricaFileIa(request, env, inUrl, h) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const tok = gettone(inUrl.searchParams.get("t"));
  const id = uuid(inUrl.searchParams.get("id"));
  const nome = String(inUrl.searchParams.get("nome") || "").replace(/[\u0000-\u001f\\/]+/g, " ").trim().slice(0, 180);
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!id) return json({ esito: "errore" }, 400);
  const est = ((/\.(pdf|xlsx|xlsm|xls|ods|csv)$/i.exec(nome) || [])[1] || "").toLowerCase();
  if (!est) return json({ esito: "formato", messaggio: "Il computo metrico in Excel o in PDF; tavole e relazioni in PDF." }, 400);
  if (Number(request.headers.get("Content-Length") || 0) > MAX_FILE) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 18 MB)." }, 413);
  // prima il controllo dell'accesso e della lettura, poi il file
  const info = await h.rpc(env, "preventivo_ia_azione", { p_token: tok, p_id: id, p_azione: "file_info", p_dati: {} }, 10000).catch(() => null);
  if (!info) return json({ esito: "incerto" }, 503);
  if (info.esito !== "ok") return json({ esito: String(info.esito), messaggio: info.messaggio || "" }, info.esito === "gettone" ? 403 : 400);
  if (!UUID.test(String(info.azienda_id || "")) || !UUID.test(String(info.lettura_id || ""))) return json({ esito: "errore" }, 400);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length > MAX_FILE) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 18 MB)." }, 413);
  const [tipo, firma] = FILE_IA[est];
  if (firma.some((b, i) => bytes[i] !== b)) return json({ esito: "formato", messaggio: "Il file non è un " + (est === "pdf" ? "PDF" : "file Excel") + " valido." }, 400);
  const percorso = "preventivi/" + info.azienda_id + "/ia/" + info.lettura_id + "/" + String(Number(info.n) || 1).padStart(2, "0") + "-" + casuale() + "." + est;
  const indirizzo = supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorso;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const up = await fetch(indirizzo, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY, "Content-Type": tipo, "x-upsert": "false" },
      body: bytes, signal: ctrl.signal
    });
    if (!up.ok) return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } catch (e) {
    return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } finally { clearTimeout(timer); }
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
  const r = await h.rpc(env, "preventivo_ia_azione", { p_token: tok, p_id: id, p_azione: "file",
    p_dati: { path: percorso, nome: nome || ("file." + est), sha256: sha, byte: String(bytes.length) } }, 10000).catch(() => null);
  if (!r || r.esito !== "ok") {
    // non registrato: il file non serve
    await fetch(indirizzo, { method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
    return r ? json({ esito: String(r.esito), messaggio: r.messaggio || "" }) : json({ esito: "incerto" }, 503);
  }
  return json({ esito: "ok", file_id: r.file_id, tipo: r.tipo, sha256: sha });
}

async function scaricaFirmato(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD, POST" } });
  const tok = gettone(inUrl.searchParams.get("t"));
  if (!tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const id = uuid(inUrl.searchParams.get("id"));
  if (!id) return new Response("Not Found", { status: 404 });
  const info = await h.rpc(env, "preventivo_azione", { p_token: tok, p_azienda: "", p_azione: "firmato_info", p_dati: { id } }, 10000).catch(() => null);
  if (!info) return h.risposta(h.foglio(base, "Preventivo", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), 503);
  if (info.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (info.esito !== "ok" || !info.path) return h.risposta(h.foglio(base, "Preventivo", "", '<p class="err">Copia firmata non trovata.</p>'), 404);
  const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + String(info.path).split("/").map(encodeURIComponent).join("/"), {
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  if (!f || !f.ok) return h.risposta(h.foglio(base, "Preventivo", "", '<p class="err">Il file non si legge dall’archivio: riprova tra un minuto.</p>'), 502);
  const nome = String(info.nome || String(info.path).split("/").pop());
  return new Response(metodo === "HEAD" ? null : f.body, { status: 200, headers: {
    "Content-Type": /\.p7m$/i.test(info.path) ? "application/pkcs7-mime" : "application/pdf",
    "Content-Disposition": 'attachment; filename="' + nome.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}

// ---------------------------------------------------------------------------- richieste di offerta ed email al DL
// 08/11/2026 (preventivi-offerte-1, chat 02B): due finestre nel preventivo aperto.
//  • «Richieste di offerta»: voci NP / da quotare → fornitori e subappaltatori della Rubrica; testo pronto, «Copia» o «Invia»
//    (l'invio parte da TIX come «<impresa> tramite TIX», le risposte vanno alle email dell'impresa); offerte inserite
//    dall'impresa, confronto per voce, «Usa questo prezzo». Al fornitore non arriva mai un prezzo.
//  • «Email al Direttore dei Lavori»: le cose da chiarire per temi, DL nel «A», progettista e committente in copia solo se spuntati.
const STILE_OF =
  ".pv-of{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.pv-of h2{flex:1 1 100%;margin:0}.pv-of p{flex:1 1 100%;margin:0;color:var(--s);font-size:.88rem}" +
  ".pv-ofv{position:fixed;inset:0;z-index:60;background:rgba(27,47,74,.45);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px}" +
  ".pv-ofm{background:#fff;border-radius:18px;max-width:1100px;width:100%;padding:22px 22px 28px;box-shadow:0 18px 48px rgba(27,47,74,.25);border-top:5px solid #66741C}" +
  ".pv-ofm h2{margin:0 0 4px;color:#1B2F4A}.pv-ofm h3{margin:18px 0 8px;color:#66741C;font-size:1rem}.pv-ofm .sotto{color:var(--s);font-size:.88rem;margin:0 0 12px}" +
  ".pv-ofm .chiudi{float:right}.pv-ofm textarea,.pv-ofm input[type=text],.pv-ofm input[type=date],.pv-ofm select{width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid #CBD2DA;border-radius:10px}" +
  ".pv-ofm textarea{min-height:90px}.pv-ofm .testo{min-height:260px;font-family:inherit;line-height:1.45}.pv-ofm label{display:block;margin:8px 0}.pv-ofm label span{display:block;font-size:.8rem;color:var(--s);margin-bottom:3px}" +
  ".pv-ofl{max-height:280px;overflow:auto;border:1px solid #E1E6EC;border-radius:12px;padding:6px 10px}.pv-ofl label{display:flex;gap:8px;align-items:flex-start;margin:4px 0;font-size:.88rem}" +
  ".pv-ofl small{color:var(--s)}.pv-ofr{border:1px solid #E1E6EC;border-radius:14px;padding:12px 14px;margin:10px 0}.pv-ofr .tt{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}" +
  ".pv-ofs{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.75rem;font-weight:700;background:#EEF1E2;color:#4E5915}.pv-ofs.bozza{background:#FFF3E8;color:#B34E0B}" +
  ".pv-ofg{width:100%;border-collapse:collapse;font-size:.85rem;margin-top:8px}.pv-ofg th,.pv-ofg td{border-bottom:1px solid #E9EDF1;padding:6px;text-align:left;vertical-align:top}" +
  ".pv-ofg td.n{text-align:right;white-space:nowrap}.pv-ofg input{width:110px}.pv-ofg .min{background:#EEF1E2;font-weight:700}.pv-ofbt{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}" +
  ".pv-ofcc{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:.88rem}.pv-ofcc label{display:flex;gap:6px;align-items:center;margin:2px 0}" +
  ".pv-ofnota{padding:10px 12px;border-radius:10px;background:#F5F6F8;font-size:.85rem;color:#3A4757}" +
  "@media (max-width:700px){.pv-ofm{padding:16px 12px 22px}.pv-ofg input{width:80px}}";

const SCRIPT_OF = String.raw`
(function(){
var CFG=__CFG__;
if(!CFG.id)return;
function es(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function api(azione,dati){dati=dati||{};dati.id=CFG.id;return fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,a:CFG.a,c:CFG.c,azione:azione,dati:dati})})
 .then(function(r){return r.json().catch(function(){return {esito:'errore'};});}).catch(function(){return {esito:'rete'};});}
function errore(r){return (r&&r.messaggio)||({spento:'Non è acceso per questo accesso.',rete:'Connessione assente: riprova.',gettone:'Accesso scaduto: rientra dall\'elenco dei cantieri.'})[r&&r.esito]||'Non è andato: riprova.';}
function dt(d){var m=String(d||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'/'+m[2]+'/'+m[1]:'';}
function eur(v){var n=Number(v);if(!isFinite(n))return '';var s=n.toFixed(2).split('.');return s[0].replace(/\B(?=(\d{3})+(?!\d))/g,'.')+','+s[1]+' €';}
function lista(s){return String(s||'').split(/[,;\s]+/).map(function(x){return x.trim();}).filter(Boolean);}
function ricorda(k,v){try{if(v===undefined)return localStorage.getItem('tix_pv_'+k)||'';localStorage.setItem('tix_pv_'+k,v);}catch(e){return '';}}
function copia(t){if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(t).then(function(){return true;},function(){return vecchio(t);});return Promise.resolve(vecchio(t));}
function vecchio(t){var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();var ok=false;try{ok=document.execCommand('copy');}catch(e){}a.remove();return ok;}
var V=null;
function finestra(html){if(!V){V=document.createElement('div');V.className='pv-ofv';V.addEventListener('click',function(e){if(e.target===V)chiudi();});document.body.appendChild(V);}
 V.innerHTML='<div class="pv-ofm" role="dialog" aria-modal="true">'+html+'</div>';V.hidden=false;document.body.style.overflow='hidden';}
function chiudi(){if(V){V.hidden=true;V.innerHTML='';}document.body.style.overflow='';}
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&V&&!V.hidden)chiudi();});
function testa(t,s){return '<button type="button" class="pv-b sm chiudi" data-ofx="chiudi">Chiudi</button><h2>'+es(t)+'</h2><p class="sotto">'+s+'</p>';}
function nota(id,t,cl){var el=document.getElementById(id);if(el){el.textContent=t||'';el.className='pv-msg'+(cl?' '+cl:'');}}
var STATI={bozza:'Da mandare',copiata:'Mandata dalla tua posta',inviata:'Mandata da TIX',offerta:'Offerta ricevuta',annullata:'Annullata',risposta:'Risposta ricevuta',chiusa:'Chiusa'};

// ------------------------------------------------ richieste di offerta
var OF=null;
// 08/11/2026 (preventivi-posta-1): le email ricevute su posta.tixcantiere.it, insieme alle richieste
var PO={posta:[],indirizzi:{rdo:{},ch:{}}};
function caricaPosta(){return api('po_elenco').then(function(r){PO=r&&r.esito==='ok'?r:{posta:[],indirizzi:{rdo:{},ch:{}}};});}
function pesoKb(b){var n=Number(b)||0;return n>1048576?(n/1048576).toFixed(1).replace('.',',')+' MB':Math.max(1,Math.round(n/1024))+' KB';}
function postaDi(tipo,id){var ind=(PO.indirizzi&&PO.indirizzi[tipo]||{})[id],L=(PO.posta||[]).filter(function(x){return x[tipo+'_id']===id;}),h='';
 if(PO.attiva&&ind)h+='<p class="sotto">Indirizzo di TIX per le risposte: <code>'+es(ind)+'</code></p>';
 if(!L.length)return h;
 h+='<h3>Email ricevute ('+L.length+')</h3>'+L.map(function(x){return '<div class="pv-ofr"><div class="tt"><b>'+es(x.mittente||'')+'</b><span class="sotto">'+dt(x.ricevuta_il)+(x.inoltrata?' · inoltrata all\'impresa':'')+'</span></div>'+
  '<p style="margin:4px 0"><b>'+es(x.oggetto||'(senza oggetto)')+'</b></p><details><summary>Testo</summary><div style="white-space:pre-wrap;font-size:.86rem;margin-top:6px">'+es(x.testo||'')+'</div></details>'+
  ((x.allegati||[]).length?'<p class="sotto">Allegati: '+x.allegati.map(function(a){return '<a href="'+es(CFG.pf+'?t='+encodeURIComponent(CFG.t)+'&id='+CFG.id+'&p='+x.id+'&n='+a.n)+'">'+es(a.nome)+'</a> ('+pesoKb(a.byte)+')';}).join(' · ')+'</p>':'')+
  (tipo==='ch'?'<div class="pv-ofbt"><button type="button" class="pv-b sm pv-pr" data-pox="usa" data-p="'+x.id+'">Usa come risposta del DL</button></div>':'')+'</div>';}).join('');
 return h;}
function smistareHtml(){var L=(PO.posta||[]).filter(function(x){return x.stato==='da_smistare'||x.stato==='errore';});if(!L.length)return '';
 var dest='<option value="">— sposta in… —</option>'+((OF&&OF.richieste)||[]).map(function(q){return '<option value="rdo:'+q.id+'">Richiesta n. '+q.numero+' · '+es(q.destinatario)+'</option>';}).join('')+
  ((CH&&CH.email)||[]).map(function(q){return '<option value="ch:'+q.id+'">Email al DL del '+dt(q.creato_il)+'</option>';}).join('');
 return '<h3>Da smistare ('+L.length+')</h3><p class="sotto">Email arrivate all\'indirizzo generale del preventivo'+(PO.generale?' (<code>'+es(PO.generale)+'</code>)':'')+' o non riconosciute.</p>'+L.map(function(x){
  return '<div class="pv-ofr"><div class="tt"><b>'+es(x.mittente||'')+'</b><span class="sotto">'+dt(x.ricevuta_il)+'</span></div><p style="margin:4px 0">'+es(x.oggetto||'')+'</p>'+
   '<details><summary>Testo</summary><div style="white-space:pre-wrap;font-size:.86rem">'+es(x.testo||x.stato)+'</div></details>'+
   '<div class="pv-ofbt"><select data-dest="'+x.id+'" style="max-width:340px">'+dest+'</select><button type="button" class="pv-b sm" data-pox="sposta" data-p="'+x.id+'">Sposta</button></div></div>';}).join('');}
function azionePo(az,el){var pid=el.dataset.p;
 if(az==='sposta'){var s=document.querySelector('[data-dest="'+pid+'"]'),v=s?s.value:'';if(!v){alert('Scegli dove spostarla.');return;}
  var d={posta_id:pid};d[v.split(':')[0]+'_id']=v.split(':')[1];el.disabled=true;
  api('po_sposta',d).then(function(r){el.disabled=false;if(r.esito!=='ok'){alert(errore(r));return;}(CH?caricaCh():caricaOf());});return;}
 if(az==='usa'){if(!confirm('Mettere il testo di questa email come risposta del DL?'))return;el.disabled=true;
  api('po_usa_risposta',{posta_id:pid}).then(function(r){el.disabled=false;if(r.esito!=='ok'){alert(errore(r));return;}caricaCh();});}}
function caricaOf(){CH=null;return Promise.all([api('of_elenco'),caricaPosta()]).then(function(x){var r=x[0];if(r.esito!=='ok'){finestra(testa('Richieste di offerta','')+'<p class="pv-msg err">'+es(errore(r))+'</p>');return;}OF=r;disegnaOf();});}
function disegnaOf(){
 var r=OF,bozza=r.stato==='bozza';
 var aperte={np:1,da_quotare:1,da_verificare:1};
 var h=testa('Richieste di offerta','Preventivo '+es(r.codice)+'. Scegli le voci e a chi chiedere il prezzo. Al fornitore arrivano descrizione, unità e quantità: <b>mai i prezzi</b>.');
 h+='<h3>Nuova richiesta</h3><div class="pv-ofl" id="of-voci">'+(r.voci||[]).map(function(v){var on=aperte[v.stato]||v.senza_prezzo;
  return '<label><input type="checkbox" value="'+v.id+'"'+(on?' checked':'')+'><span><b>'+v.ordine+'.</b> '+es(v.descrizione)+' <small>· '+es(v.unita||'')+' '+String(v.quantita==null?'':v.quantita).replace('.',',')+(v.stato&&v.stato!=='ok'?' · '+es(v.stato.replace('_',' ')):'')+'</small></span></label>';}).join('')+'</div>';
 var rub=r.rubrica||[];
 h+='<label><span>Dalla Rubrica (fornitori e subappaltatori)</span><select id="of-rub"><option value="">— scegli, oppure scrivi qui sotto —</option>'+
  rub.map(function(k,i){return '<option value="'+i+'">'+es((k.tipo==='fornitore'?'Fornitore · ':'Subappaltatore · ')+(k.impresa||k.nome)+(k.impresa&&k.nome?' ('+k.nome+')':''))+'</option>';}).join('')+'</select></label>'+
  (rub.length?'':'<p class="pv-ofnota">Nella Rubrica non ci sono ancora fornitori o subappaltatori: puoi scrivere qui sotto il nome e le email, oppure aggiungerli in Rubrica con il rapporto «Fornitore».</p>')+
  '<label><span>A chi va la richiesta</span><input type="text" id="of-dest" maxlength="200"></label>'+
  '<label><span>Email del fornitore (fino a 10, separate da virgola)</span><input type="text" id="of-ea"></label>'+
  '<label><span>Email dell\'impresa dove arrivano le risposte (fino a 5) · ricevono anche una copia della richiesta</span><input type="text" id="of-ei" value="'+es(ricorda('of_imp')||(r.impresa&&r.impresa.email)||'')+'"></label>'+
  '<div class="pv-ofbt"><button type="button" class="pv-b pv-pr" data-ofx="prepara">Prepara la richiesta</button></div><p class="pv-msg" id="of-msg" aria-live="polite"></p>';
 // confronto delle offerte per voce
 var per={};(r.richieste||[]).forEach(function(q){if(q.stato==='annullata')return;(q.righe||[]).forEach(function(g){if(g.prezzo==null)return;(per[g.voce_id]=per[g.voce_id]||{v:g,o:[]}).o.push({q:q,g:g});});});
 var ids=Object.keys(per);
 if(ids.length){h+='<h3>Confronto delle offerte</h3><table class="pv-ofg"><tr><th>Voce</th><th>Offerte (prezzo unitario + IVA)</th></tr>'+ids.map(function(k){var x=per[k],min=Math.min.apply(null,x.o.map(function(o){return Number(o.g.prezzo);}));
  return '<tr><td><b>'+x.v.ordine+'.</b> '+es(x.v.descrizione)+'</td><td>'+x.o.map(function(o){return '<div class="'+(Number(o.g.prezzo)===min?'min':'')+'">'+es(o.q.destinatario)+': '+eur(o.g.prezzo)+(o.g.note?' <small>('+es(o.g.note)+')</small>':'')+
   (o.g.scelta?' ✓ <small>nel preventivo</small>':(bozza?' <button type="button" class="pv-b sm" data-ofx="scegli" data-riga="'+o.g.id+'">Usa questo prezzo</button>':''))+'</div>';}).join('')+'</td></tr>';}).join('')+'</table>';}
 h+='<h3>Richieste fatte</h3>'+((r.richieste||[]).length?'':'<p class="sotto">Nessuna richiesta ancora.</p>');
 (r.richieste||[]).forEach(function(q){
  h+='<div class="pv-ofr" data-rdo="'+q.id+'"><div class="tt"><b>N. '+q.numero+' · '+es(q.destinatario)+'</b><span class="pv-ofs '+q.stato+'">'+es(STATI[q.stato]||q.stato)+(q.inviata_il?' il '+dt(q.inviata_il):'')+'</span></div>';
  if(q.stato==='bozza'){
   h+='<label><span>Email del fornitore</span><input type="text" data-k="email_a" value="'+es((q.email_a||[]).join(', '))+'"></label>'+
    '<label><span>Email dell\'impresa per le risposte</span><input type="text" data-k="email_impresa" value="'+es((q.email_impresa||[]).join(', '))+'"></label>'+
    '<label><span>Oggetto</span><input type="text" data-k="oggetto" maxlength="200" value="'+es(q.oggetto)+'"></label>'+
    '<label><span>Testo</span><textarea class="testo" data-k="testo">'+es(q.testo)+'</textarea></label>'+
    '<div class="pv-ofbt"><button type="button" class="pv-b" data-ofx="salva">Salva le modifiche</button><button type="button" class="pv-b" data-ofx="copia">Copia il testo</button>'+
    '<button type="button" class="pv-b pv-pr" data-ofx="invia"'+(OF.email_attive?'':' disabled title="L\'invio da TIX non è ancora acceso"')+'>Invia da TIX</button><button type="button" class="pv-b pv-togli" data-ofx="annulla">Annulla</button></div>'+
    (OF.email_attive?'<p class="pv-ofnota">«Invia da TIX» la manda a nome di '+es(r.impresa.nome)+' («'+es(r.impresa.nome)+' tramite TIX»): quando il fornitore risponde, la risposta arriva alle email dell\'impresa.</p>':'<p class="pv-ofnota">L\'invio da TIX non è ancora acceso: con «Copia il testo» la incolli nella tua posta e la mandi tu.</p>');
  } else if(q.stato!=='annullata'){
   h+='<table class="pv-ofg"><tr><th>Voce</th><th class="n">Quantità</th><th>Prezzo offerto + IVA</th><th>Note</th></tr>'+(q.righe||[]).map(function(g){
    return '<tr><td><b>'+g.ordine+'.</b> '+es(g.descrizione)+'</td><td class="n">'+String(g.quantita==null?'':g.quantita).replace('.',',')+' '+es(g.unita||'')+'</td>'+
     '<td><input type="text" inputmode="decimal" data-voce="'+g.voce_id+'" value="'+(g.prezzo==null?'':String(g.prezzo).replace('.',','))+'"></td><td><input type="text" data-nota="'+g.voce_id+'" maxlength="500" value="'+es(g.note||'')+'" style="width:100%"></td></tr>';}).join('')+'</table>'+
    '<label><span>Data dell\'offerta</span><input type="date" data-k="data" value="'+es(q.offerta_data||'')+'" style="max-width:200px"></label>'+
    '<div class="pv-ofbt"><button type="button" class="pv-b pv-pr" data-ofx="offerta">Salva l\'offerta</button><button type="button" class="pv-b" data-ofx="copia">Copia di nuovo il testo</button></div>';
  }
  h+=postaDi('rdo',q.id);
  h+='<p class="pv-msg" data-m="'+q.id+'" aria-live="polite"></p></div>';});
 h+=smistareHtml();
 finestra(h);
 var sel=document.getElementById('of-rub');
 if(sel)sel.onchange=function(){var k=(OF.rubrica||[])[Number(sel.value)];if(!k)return;document.getElementById('of-dest').value=k.impresa||k.nome||'';document.getElementById('of-ea').value=k.email||'';sel.dataset.cid=k.id;sel.dataset.tipo=k.tipo;};
}
function voceSel(){return Array.prototype.slice.call(document.querySelectorAll('#of-voci input:checked')).map(function(x){return x.value;});}
function campiRdo(box){var d={};box.querySelectorAll('[data-k]').forEach(function(x){d[x.dataset.k]=x.value;});return d;}
function mOf(box,t,cl){var el=box?box.querySelector('[data-m]'):null;if(el){el.textContent=t||'';el.className='pv-msg'+(cl?' '+cl:'');}}
function azioneOf(az,el){
 var box=el.closest('[data-rdo]'),rid=box?box.dataset.rdo:null;
 if(az==='prepara'){var sel=document.getElementById('of-rub'),ei=document.getElementById('of-ei').value;
  var d={voci:voceSel(),destinatario:document.getElementById('of-dest').value,email_a:document.getElementById('of-ea').value,email_impresa:ei,
   contatto_id:sel&&sel.value!==''?sel.dataset.cid:'',tipo:sel&&sel.value!==''?sel.dataset.tipo:'altro'};
  if(!d.voci.length){nota('of-msg','Scegli almeno una voce.','err');return;}
  el.disabled=true;nota('of-msg','Preparo la richiesta…');
  api('of_prepara',d).then(function(r){el.disabled=false;if(r.esito!=='ok'){nota('of-msg',errore(r),'err');return;}ricorda('of_imp',ei);caricaOf();});return;}
 if(az==='scegli'){el.disabled=true;api('of_scegli',{riga_id:el.dataset.riga}).then(function(r){if(r.esito!=='ok'){el.disabled=false;alert(errore(r));return;}caricaOf().then(function(){OF.cambiato=true;});});return;}
 if(az==='copia'){var q=(OF.richieste||[]).filter(function(x){return x.id===rid;})[0];var d2=campiRdo(box);
  var t=(d2.oggetto||q.oggetto)+'\n\n'+(d2.testo||q.testo);
  copia(t).then(function(ok){mOf(box,ok?'Testo copiato: incollalo nella tua email. A: '+(d2.email_a||(q.email_a||[]).join(', ')):'Non riesco a copiare: seleziona il testo e copialo a mano.',ok?'ok':'err');
   if(ok&&q.stato==='bozza'){api('of_testo',Object.assign({rdo_id:rid},d2)).then(function(){return api('of_copiata',{rdo_id:rid});});}});return;}
 var dati={rdo_id:rid};
 if(az==='salva'||az==='invia'){Object.assign(dati,campiRdo(box));}
 if(az==='offerta'){var d3=campiRdo(box);dati.data=d3.data;dati.prezzi=Array.prototype.slice.call(box.querySelectorAll('[data-voce]')).map(function(x){
   var n=box.querySelector('[data-nota="'+x.dataset.voce+'"]'),p=x.value.replace(/[€\s]/g,'');if(/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(p))p=p.replace(/\./g,'');
   return {voce_id:x.dataset.voce,prezzo:p,note:n?n.value:''};});}
 if(az==='annulla'&&!confirm('Annullare questa richiesta? Resta nell\'elenco come annullata.'))return;
 if(az==='invia'&&!confirm('Mandare la richiesta da TIX a: '+lista(dati.email_a).join(', ')+'?'))return;
 el.disabled=true;mOf(box,'Un momento…');
 var prima=az==='invia'?api('of_testo',dati):Promise.resolve({esito:'ok'});
 prima.then(function(r0){if(r0.esito!=='ok'){el.disabled=false;mOf(box,errore(r0),'err');return;}
  api('of_'+(az==='salva'?'testo':az),dati).then(function(r){el.disabled=false;if(r.esito!=='ok'){mOf(box,errore(r),'err');return;}
   if(az==='invia')ricorda('of_imp',dati.email_impresa||'');caricaOf();});});
}

// ------------------------------------------------ email al Direttore dei Lavori
var CH=null;
function caricaCh(){return Promise.all([api('ch_elenco'),caricaPosta()]).then(function(x){var r=x[0];if(r.esito!=='ok'){finestra(testa('Email al Direttore dei Lavori','')+'<p class="pv-msg err">'+es(errore(r))+'</p>');return;}CH=r;disegnaCh();});}
function ccBox(q){var c=CH.contatti||{},h='',viste={};(q.email_cc||[]).forEach(function(e){viste[e]=1;});
 [['progettista','Progettista'],['committente','Committente']].forEach(function(p){(c[p[0]]||[]).forEach(function(k){if(!k.email)return;
  h+='<label><input type="checkbox" data-cc="'+es(k.email)+'"'+(viste[k.email]?' checked':'')+'> '+p[1]+': '+es(k.nome||'')+' <small>'+es(k.email)+'</small></label>';delete viste[k.email];});});
 return '<div class="pv-ofcc">'+(h||'<span class="sotto">Nessun progettista o committente con email: puoi scriverli qui sotto.</span>')+'</div>'+
  '<label><span>Altre email in copia (facoltativo)</span><input type="text" data-k="cc_altre" value="'+es(Object.keys(viste).join(', '))+'"></label>';}
function disegnaCh(){
 var r=CH;
 var h=testa('Email al Direttore dei Lavori','Preventivo '+es(r.codice)+'. Le cose da chiarire della lettura, raggruppate per argomento. Nessun prezzo va al DL.');
 if(!(r.email||[]).length||r.email.every(function(q){return q.stato!=='bozza';}))
  h+=(r.domande?'<div class="pv-ofbt"><button type="button" class="pv-b pv-pr" data-chx="prepara">Prepara l\'email dalle '+r.domande+' cose da chiarire</button></div>':'<p class="pv-ofnota">Nell\'ultima lettura di questo preventivo non ci sono cose da chiarire.</p>')+'<p class="pv-msg" id="ch-msg"></p>';
 var dl=((r.contatti||{}).dl||[]).map(function(k){return k.email;});
 (r.email||[]).forEach(function(q){
  h+='<div class="pv-ofr" data-ch="'+q.id+'"><div class="tt"><b>'+es(q.oggetto)+'</b><span class="pv-ofs '+q.stato+'">'+es(STATI[q.stato]||q.stato)+(q.inviata_il?' il '+dt(q.inviata_il):'')+'</span></div>';
  if(q.stato==='bozza'){
   h+='<label><span>A (Direttore dei Lavori)</span><input type="text" data-k="email_a" value="'+es((q.email_a||[]).length?q.email_a.join(', '):dl.join(', '))+'"></label>'+
    '<div><span class="sotto">In copia (si mettono solo se li spunti)</span>'+ccBox(q)+'</div>'+
    '<label><span>Email dell\'impresa per la risposta (ricevono anche una copia)</span><input type="text" data-k="email_impresa" value="'+es((q.email_impresa||[]).length?q.email_impresa.join(', '):(ricorda('of_imp')||(r.impresa&&r.impresa.email)||''))+'"></label>'+
    '<label><span>Oggetto</span><input type="text" data-k="oggetto" maxlength="200" value="'+es(q.oggetto)+'"></label>'+
    '<label><span>Testo</span><textarea class="testo" data-k="testo">'+es(q.testo)+'</textarea></label>'+
    '<div class="pv-ofbt"><button type="button" class="pv-b" data-chx="salva">Salva le modifiche</button><button type="button" class="pv-b" data-chx="copia">Copia il testo</button>'+
    '<button type="button" class="pv-b pv-pr" data-chx="invia"'+(r.email_attive?'':' disabled title="L\'invio da TIX non è ancora acceso"')+'>Invia da TIX</button></div>'+
    (r.email_attive?'':'<p class="pv-ofnota">L\'invio da TIX non è ancora acceso: con «Copia il testo» la incolli nella tua posta e la mandi tu.</p>');
  } else {
   h+='<details><summary>Vedi il testo mandato</summary><div style="white-space:pre-wrap;font-size:.88rem;margin-top:8px">'+es(q.testo)+'</div></details>'+
    '<label><span>Risposta del Direttore dei Lavori: incollala qui</span><textarea data-k="risposta">'+es(q.risposta||'')+'</textarea></label>'+
    '<div class="pv-ofbt"><button type="button" class="pv-b" data-chx="risposta">Salva la risposta</button>'+
    (q.risposta_il?'<button type="button" class="pv-b pv-pr" data-cpx="leggi">Leggi la risposta con TIX</button>':'')+'</div>'+
    (q.risposta_il?'<p class="pv-ofnota">Risposta salvata il '+dt(q.risposta_il)+'. «Leggi la risposta con TIX» ti propone le modifiche al preventivo (circa 3–5 centesimi + IVA): '+
     'il preventivo cambia solo con le proposte che accetti tu.</p><div class="pv-ofprop" data-prop="'+q.id+'"></div>':'');
  }
  h+=postaDi('ch',q.id);
  h+='<p class="pv-msg" data-m="'+q.id+'" aria-live="polite"></p></div>';});
 h+=smistareHtml();
 finestra(h);
 (r.email||[]).forEach(function(q){if(q.risposta_il)caricaProp(q.id,0);});
}
// 08/11/2026 (preventivi-risposta-1): le proposte lette dalla risposta del DL, da accettare una per una o tutte insieme
var CAMBIATO=false;
var TIPI={quantita:'Quantità',verifica:'Da verificare',escludi:'Escludi',includi:'Includi',aggiungi:'Voce nuova',oneri:'Oneri della sicurezza',nota:'Nota'};
function eur2(v){var n=Number(v)||0,s=n.toFixed(2).split('.');return s[0].replace(/\B(?=(\d{3})+(?!\d))/g,'.')+','+s[1]+' €';}
var STATI_P={da_vedere:'Da decidere',accettata:'Accettata',scartata:'Scartata',non_applicata:'Non applicata'};
function q2(v){return v==null?'':String(v).replace('.',',');}
function caricaProp(id,giro){var el=document.querySelector('[data-prop="'+id+'"]');if(!el)return;
 api('cp_stato',{ch_id:id}).then(function(r){el=document.querySelector('[data-prop="'+id+'"]');if(!el)return;
  if(r.esito!=='ok'){el.innerHTML='<p class="pv-msg err">'+es(errore(r))+'</p>';return;}
  if(r.lettura_stato==='in_corso'){el.innerHTML='<p class="pv-ofnota">TIX sta leggendo la risposta… di solito meno di un minuto.</p>';
   if(giro<45)setTimeout(function(){caricaProp(id,giro+1);},4000);return;}
  if(r.lettura_stato==='errore'){el.innerHTML='<p class="pv-msg err">La lettura non è riuscita: '+es(r.lettura_errore||'')+'. Puoi riprovare.</p>';return;}
  if(r.lettura_stato!=='fatta'){el.innerHTML='';return;}
  var P=r.proposte||[],aperte=P.filter(function(p){return p.stato==='da_vedere';}).length;
  var h='<h3>Proposte di TIX dalla risposta</h3>'+(r.riassunto?'<p class="pv-ofnota">'+es(r.riassunto)+'</p>':'');
  if(!P.length)h+='<p class="sotto">Dalla risposta non nasce nessuna modifica al preventivo.</p>';
  h+='<table class="pv-ofg"><tr><th>#</th><th>Cosa cambia</th><th>Dalla risposta</th><th></th></tr>'+P.map(function(p){
   var cosa=p.tipo==='quantita'?'Voce '+es(p.k)+' · '+es(p.voce||'')+': da '+q2(p.quantita_prima)+' a <b>'+q2(p.quantita_nuova)+'</b> '+es(p.unita_voce||''):
    p.tipo==='escludi'?'Voce '+es(p.k)+' · '+es(p.voce||'')+': <b>esclusa</b> dal preventivo':
    p.tipo==='includi'?'Voce '+es(p.k)+' · '+es(p.voce||'')+': <b>compresa</b> nel preventivo':
    p.tipo==='aggiungi'?'<b>'+es(p.descrizione||'')+'</b>'+(p.quantita?' · '+q2(p.quantita)+' '+es(p.unita||''):'')+' <small>(da quotare)</small>':
    p.tipo==='verifica'?'Voce '+es(p.k)+' · '+es(p.voce||'')+': <b>da ricalcolare</b> (la quantità '+q2(p.quantita_prima)+' '+es(p.unita_voce||'')+' non cambia)':
    p.tipo==='oneri'?'Oneri della sicurezza: da '+eur2(p.oneri_prima)+' a <b>'+eur2(p.importo)+'</b> + IVA':
    (p.k?'Voce '+es(p.k)+' · '+es(p.voce||'')+' — ':'')+'Nelle note: '+es(p.testo||'');
   return '<tr><td>'+p.n+'</td><td><span class="pv-ofs">'+es(TIPI[p.tipo]||p.tipo)+'</span> '+cosa+(p.motivo?'<br><small>'+es(p.motivo)+'</small>':'')+'</td>'+
    '<td><small><i>«'+es(p.citazione||'')+'»</i></small></td><td>'+(p.stato==='da_vedere'&&r.bozza?
     '<button type="button" class="pv-b sm pv-pr" data-cpx="accetta" data-n="'+p.n+'">Accetta</button> <button type="button" class="pv-b sm" data-cpx="scarta" data-n="'+p.n+'">Scarta</button>':
     '<span class="pv-ofs'+(p.stato==='accettata'?'':' bozza')+'">'+es(STATI_P[p.stato]||p.stato)+(p.errore?': '+es(p.errore):'')+'</span>')+'</td></tr>';}).join('')+'</table>';
  if(aperte>1&&r.bozza)h+='<div class="pv-ofbt"><button type="button" class="pv-b pv-pr" data-cpx="tutte">Accetta tutte ('+aperte+')</button></div>';
  if(!r.bozza)h+='<p class="pv-ofnota">Il preventivo è già stato mandato: per cambiarlo fai una revisione nuova.</p>';
  if(r.costo_usd)h+='<p class="sotto">Costo della lettura: '+Number(r.costo_usd).toFixed(3).replace('.',',')+' $ (circa '+Math.max(1,Math.round(Number(r.costo_usd)*100))+' centesimi).</p>';
  el.innerHTML=h;});}
function azioneCp(az,el){var box=el.closest('[data-ch]'),cid=box?box.dataset.ch:null;if(!cid)return;
 if(az==='tutte'&&!confirm('Applicare al preventivo tutte le proposte ancora da decidere?'))return;
 el.disabled=true;
 api('cp_'+(az==='tutte'?'accetta_tutte':az),{ch_id:cid,n:el.dataset.n||''}).then(function(r){el.disabled=false;
  if(r.esito!=='ok'){mOf(box,errore(r),'err');return;}
  if(az==='leggi'){mOf(box,r.gia?'TIX sta già leggendo la risposta.':'TIX legge la risposta…','ok');caricaProp(cid,0);return;}
  if(az!=='scarta')CAMBIATO=true;caricaProp(cid,0);});}
function campiCh(box){var d={};box.querySelectorAll('[data-k]').forEach(function(x){d[x.dataset.k]=x.value;});
 var cc=Array.prototype.slice.call(box.querySelectorAll('[data-cc]:checked')).map(function(x){return x.dataset.cc;}).concat(lista(d.cc_altre));delete d.cc_altre;d.email_cc=cc.join(', ');return d;}
function azioneCh(az,el){
 var box=el.closest('[data-ch]'),cid=box?box.dataset.ch:null;
 if(az==='prepara'){el.disabled=true;nota('ch-msg','Preparo l\'email…');api('ch_prepara').then(function(r){el.disabled=false;if(r.esito!=='ok'){nota('ch-msg',errore(r),'err');return;}caricaCh();});return;}
 if(az==='copia'){var d0=campiCh(box);copia(d0.oggetto+'\n\n'+d0.testo).then(function(ok){mOf(box,ok?'Testo copiato. A: '+d0.email_a+(d0.email_cc?' · In copia: '+d0.email_cc:''):'Non riesco a copiare: seleziona il testo e copialo a mano.',ok?'ok':'err');
   if(ok)api('ch_testo',Object.assign({ch_id:cid},d0)).then(function(){return api('ch_copiata',{ch_id:cid});});});return;}
 var dati={ch_id:cid};
 if(az==='risposta'){dati.testo=(box.querySelector('[data-k="risposta"]')||{}).value||'';}
 else Object.assign(dati,campiCh(box));
 if(az==='invia'&&!confirm('Mandare l\'email da TIX a: '+lista(dati.email_a).concat(lista(dati.email_cc)).join(', ')+'?'))return;
 el.disabled=true;mOf(box,'Un momento…');
 var prima=az==='invia'?api('ch_testo',dati):Promise.resolve({esito:'ok'});
 prima.then(function(r0){if(r0.esito!=='ok'){el.disabled=false;mOf(box,errore(r0),'err');return;}
  api('ch_'+(az==='salva'?'testo':az),dati).then(function(r){el.disabled=false;if(r.esito!=='ok'){mOf(box,errore(r),'err');return;}
   if(az==='salva'||az==='risposta'){mOf(box,'Salvato.','ok');if(az==='risposta')caricaCh();}else caricaCh();});});
}

document.addEventListener('click',function(e){
 var b=e.target.closest('[data-ofapri],[data-chapri],[data-ofx],[data-chx],[data-cpx],[data-pox]');if(!b)return;
 if(b.hasAttribute('data-pox')){azionePo(b.getAttribute('data-pox'),b);return;}
 if(b.hasAttribute('data-cpx')){azioneCp(b.getAttribute('data-cpx'),b);return;}
 if(b.hasAttribute('data-ofapri')){finestra('<p>Un momento…</p>');caricaOf();return;}
 if(b.hasAttribute('data-chapri')){finestra('<p>Un momento…</p>');caricaCh();return;}
 var az=b.getAttribute('data-ofx')||b.getAttribute('data-chx');
 if(az==='chiudi'){var ric=(OF&&OF.cambiato)||CAMBIATO;chiudi();if(ric)location.reload();return;}
 if(b.hasAttribute('data-ofx'))azioneOf(az,b);else azioneCh(az,b);
});
})();
`;

// ---------------------------------------------------------------------------- posta dei Preventivi (ricezione)
// 08/11/2026 (preventivi-posta-1, chat 02B): Cloudflare Email Routing su posta.tixcantiere.it → email() del Worker → qui.
// Si controlla la forma dell'indirizzo, il database dice se esiste (chiave casuale della richiesta); se no l'email è rifiutata.
// Il messaggio grezzo si salva in wa-media/posta/<id>.eml senza leggerlo (pochi millisecondi di calcolo); lo legge la funzione
// preventivo-posta, chiamata dal database. POSTA_PREVENTIVI=off rifiuta tutto.
const POSTA_RE = /^(offerta|dl|prev)-\d{4}-\d{3}(-n\d{1,3})?\.[a-z0-9]{6,16}@[a-z0-9.-]+$/;
async function rpcServizio(env, nome, corpo) {
  const r = await fetch(supabaseUrl(env) + "/rest/v1/rpc/" + nome, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY }, body: JSON.stringify(corpo) });
  if (!r.ok) throw new Error(nome + " HTTP " + r.status);
  return r.json();
}
export async function postaPreventivi(message, env, ctx) {
  const a = String(message.to || "").toLowerCase().trim();
  if (env.POSTA_PREVENTIVI === "off" || !env.SUPABASE_SERVICE_KEY) { message.setReject("Indirizzo non attivo"); return; }
  if (!POSTA_RE.test(a)) { message.setReject("Indirizzo sconosciuto"); return; }
  if (Number(message.rawSize || 0) > 25 * 1024 * 1024) { message.setReject("Messaggio troppo grande (massimo 25 MB)"); return; }
  let arrivo = null;
  try { arrivo = await rpcServizio(env, "preventivi_posta_arrivo", { p_indirizzo: a, p_da: String(message.from || "").slice(0, 300), p_byte: Number(message.rawSize || 0) }); }
  catch (e) { console.log(JSON.stringify({ posta_errore: "arrivo", dettaglio: String(e && e.message || e).slice(0, 200) })); message.setReject("Servizio non disponibile, riprova più tardi"); return; }
  if (!arrivo || arrivo.esito !== "ok") {
    message.setReject(arrivo && arrivo.esito === "grande" ? "Messaggio troppo grande" : arrivo && arrivo.esito === "troppe" ? "Troppe email per questo indirizzo" : "Indirizzo sconosciuto");
    return;
  }
  const percorso = "posta/" + arrivo.id + ".eml";
  const grezzo = await new Response(message.raw).arrayBuffer();
  const up = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorso, { method: "POST",
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY, "Content-Type": "message/rfc822", "x-upsert": "true" }, body: grezzo }).catch(() => null);
  if (!up || !up.ok) { console.log(JSON.stringify({ posta_errore: "salvataggio", id: arrivo.id })); message.setReject("Servizio non disponibile, riprova più tardi"); return; }
  await rpcServizio(env, "preventivi_posta_caricata", { p_id: arrivo.id, p_percorso: percorso }).catch((e) => console.log(JSON.stringify({ posta_errore: "caricata", id: arrivo.id, dettaglio: String(e && e.message || e).slice(0, 200) })));
  console.log(JSON.stringify({ posta: arrivo.id, byte: grezzo.byteLength }));
}

// allegato di un'email ricevuta: GET /preventivi/posta/file?t=…&id=<preventivo>&p=<email>&n=<numero>
async function scaricaPosta(request, env, base, inUrl, h) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const tok = gettone(inUrl.searchParams.get("t"));
  if (!tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const id = uuid(inUrl.searchParams.get("id")), p = uuid(inUrl.searchParams.get("p"));
  const n = Math.max(0, Math.min(99, parseInt(inUrl.searchParams.get("n") || "0", 10) || 0));
  if (!id || !p) return new Response("Not Found", { status: 404 });
  const info = await h.rpc(env, "preventivo_posta", { p_token: tok, p_id: id, p_azione: "file", p_dati: { posta_id: p, n } }, 10000).catch(() => null);
  if (!info || info.esito !== "ok" || !info.percorso) return h.risposta(h.foglio(base, "Preventivo", "", '<p class="err">Allegato non trovato.</p>'), 404);
  const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + String(info.percorso).split("/").map(encodeURIComponent).join("/"), {
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  if (!f || !f.ok) return h.risposta(h.foglio(base, "Preventivo", "", '<p class="err">Il file non si legge dall’archivio: riprova tra un minuto.</p>'), 502);
  const nome = String(info.nome || "allegato");
  return new Response(request.method === "HEAD" ? null : f.body, { status: 200, headers: {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": 'attachment; filename="' + nome.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}
