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
//   GET  /preventivi/excel?t&id[&rev]               → file per Excel (CSV)
//   POST /preventivi/firmato?t&id&nome              → copia firmata (corpo = il file, .pdf o .p7m)
//   GET  /preventivi/firmato?t&id                   → scarica la copia firmata
// «Prepara con TIX» (03/11/2026, preventivi-ia-1; nome e logo TIX da preventivi-tix-1): nella bozza si allegano file o link
// (computo SOLO in Excel, tavole e relazioni in PDF); la funzione preventivo-ia li legge e TIX, con l'intelligenza artificiale,
// compila le voci, segnate verde / giallo / rosso, da controllare. Dal 03/11 sera (preventivi-pdf-1) relazioni e tavole le legge
// Claude in PDF: la funzione non li apre più (ogni sua chiamata ha ~2 secondi di calcolo).
//   POST /preventivi/api  azione ia_dati | ia_nuova | ia_lavoro | ia_link | ia_tipo_file | ia_togli_file | ia_controlla |
//                         ia_parti | ia_annulla | ia_conferma | ia_scegli | ia_conferma_verdi | ia_togli_ia
//   POST /preventivi/ia/file?t&id&nome              → un file per la lettura (corpo = il file, Excel o PDF, fino a 18 MB)
// Interruttori: impostazioni.preventivi_attiva (no / prova = solo Filippo / si) e PREVENTIVI = "off" nel Worker;
// per «Prepara con TIX» anche impostazioni.preventivi_ia_attiva (no / prova / si).
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FILE = 18 * 1024 * 1024;
const AZIONI = new Set(["nuovo", "intestazione", "voce", "togli_voce", "sposta_voce", "manda", "revisione", "accettato", "rifiutato",
  "annulla_esito", "elimina"]);
const AZIONI_IA = new Set(["nuova", "lavoro", "link", "tipo_file", "togli_file", "controlla", "parti", "annulla", "conferma", "scegli",
  "conferma_verdi", "togli_ia"]);
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

// solo i campi che il database conosce, già accorciati
function pulisci(d) {
  const x = d && typeof d === "object" ? d : {};
  const o = {};
  const testi = { id: 36, commessa_id: 36, voce_id: 20, titolo: 200, cliente_nome: 200, cliente_indirizzo: 300, cliente_piva: 40,
    cliente_email: 200, indirizzo_lavoro: 300, note: 2000, validita_giorni: 6, oneri_sicurezza: 20, sconto: 20, prezzario_id: 6,
    fonte: 12, rif: 60, codice: 60, descrizione: 6000, unita: 20, prezzo: 20, quantita: 20, verso: 4, data: 10, chi: 200, nota: 500,
    lavoro: 1000, link: 600, tipo: 12, modalita: 8, file_id: 20, alt: 3 };
  for (const k of Object.keys(testi)) if (k in x) o[k] = testo(x[k], testi[k]);
  if ("ribasso_applicato" in x) o.ribasso_applicato = x.ribasso_applicato === true || x.ribasso_applicato === "true";
  if ("leggi" in x) o.leggi = x.leggi === true || x.leggi === "true";
  if ("conferma_tetto" in x) o.conferma_tetto = x.conferma_tetto === true || x.conferma_tetto === "true";
  if (Array.isArray(x.misure)) {
    o.misure = x.misure.slice(0, 50).map((r) => ({ dove: testo(r && r.dove, 120), parti: testo(r && r.parti, 14), lun: testo(r && r.lun, 14),
      lar: testo(r && r.lar, 14), alt: testo(r && r.alt, 14) }));
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
    "<style>" + STILE + STILE_IA + "</style></head><body><main id=\"pv-main\">" +
    (id
      ? '<a class="pv-torna" href="' + e(base + "/preventivi?t=" + tok + (a ? "&a=" + a : "") + (c ? "&c=" + c : "")) + '">‹ Tutti i preventivi</a>'
      : '<a class="pv-torna" href="' + e(torna) + '">‹ ' + (c ? "Torna al cantiere" : "Torna ai cantieri") + "</a>") +
    '<div id="pv-app"><p class="pv-carica">Un momento…</p></div>' +
    "</main>" + MODALI +
    "<script>" + SCRIPT.replace("__CFG__", cfg) + "</script></body></html>";
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
  ".pv-ia-vel{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}.pv-ia-vel .et{font-size:.82rem;font-weight:700;color:var(--s)}.pv-ia-vel em{font-style:normal;font-weight:600;opacity:.85;font-size:.8rem}" +
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
  ".pv-r{position:relative;display:grid;grid-template-columns:150px minmax(0,1fr) 180px 150px 150px;gap:14px;align-items:center;padding:14px 16px 14px 20px;border:1px solid var(--l);border-radius:14px;background:#fff;text-decoration:none;color:inherit}" +
  ".pv-r:hover{border-color:var(--pv-b);box-shadow:0 8px 18px -14px rgba(74,85,18,.6)}" +
  ".pv-r::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:4px;border-radius:0 4px 4px 0;background:var(--pv)}" +
  ".pv-num{font-weight:800;color:var(--pv-s);font-size:.95rem}.pv-num small{display:block;font-weight:600;color:var(--s);font-size:.78rem;margin-top:2px}" +
  ".pv-r h3{margin:0;font-size:1.02rem;color:var(--t)}.pv-dove{margin:3px 0 0;font-size:.84rem;color:var(--s)}" +
  ".pv-imp{text-align:right}.pv-imp b{display:block;font-size:1.15rem;color:var(--navy)}.pv-imp span{font-size:.78rem;color:var(--s)}" +
  ".pv-r .pv-azr{display:flex;justify-content:flex-end}" +
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
  ".pv-mis-r.h{font-size:.72rem;font-weight:700;color:var(--s);text-transform:uppercase;letter-spacing:.04em}.pv-mis-r button{border:0;background:none;color:var(--ko);font-size:1.1rem;cursor:pointer}" +
  ".pv-az{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.pv-az .pv-togli{margin-left:auto}" +
  "@media (max-width:1100px){.pv-r{grid-template-columns:130px minmax(0,1fr) 150px}.pv-r .pv-imp{grid-column:3}.pv-r .pv-azr{display:none}}" +
  "@media (max-width:900px){.pv-ri{grid-template-columns:minmax(0,1fr) 120px}.pv-ri .um{display:none}.pv-ri .pv-fonte{grid-column:1/-1;flex-direction:row;gap:6px}.pv-ri .pv-b{grid-column:2}.pv-campi{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
  "@media (max-width:640px){main{padding:12px 10px 40px}.pv-card{padding:14px}h1{font-size:1.3rem}.pv-sep{display:none}" +
  ".pv-r{grid-template-columns:minmax(0,1fr) auto;gap:8px 10px;padding:12px 12px 12px 16px}.pv-r .pv-num{grid-column:1}.pv-r .pv-stc{grid-column:2;grid-row:1;justify-self:end;text-align:right}" +
  ".pv-r .pv-tit{grid-column:1/-1}.pv-r .pv-imp{grid-column:1/-1;text-align:left}.pv-r .pv-imp b{display:inline;margin-right:6px}" +
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
  '<p class="pv-spiega">Preventivi per i lavori extra di un cantiere e per i lavori nuovi. Le voci si prendono dall\'<b>elenco prezzi del contratto</b> (il computo della sezione SAL), dal <b>prezzario regionale</b> o si scrivono a mano. Un preventivo mandato non si riscrive più: ogni modifica diventa una revisione nuova. I prezzi li vede e li scrive solo l\'ufficio.</p>'+
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
   '<div class="pv-imp"><b>'+(p.totale==null?'—':euro(p.totale))+'</b><span>+ IVA</span></div><div class="pv-azr"><span class="pv-b sm'+(p.stato==='bozza'?' pv-pr':'')+'">Apri</span></div></a>';});
 h+='</div></section>';
 app.innerHTML=h;
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
function carica(){return api('dati',{id:CFG.id}).then(function(r){if(r&&r.esito==='ok'){D=r;disegna();caricaIa();}else{$('pv-app').innerHTML='<section class="pv-card"><p class="pv-msg ko">'+es(msgErr(r))+'</p></section>';}});}
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
 V.forEach(function(v,i){var x=VI[String(v.id)],daVedere=x&&!x.confermata;
  h+='<div class="pv-vt'+(x?' ia-'+es(x.livello)+(x.confermata?' ia-ok':''):'')+'"><span class="nr">'+(i+1)+'</span><span class="fo">'+fonteHtml(v.fonte,v.codice)+'</span><div class="ds">'+(x?tagIa(x):'')+'<p class="pv-ds corta" title="Tocca per leggerla tutta">'+es(v.descrizione)+'</p>'+
   (v.fonte!=='libera'&&!v.ribassabile?'<span class="pv-agg">senza ribasso</span>':'')+(v.fonte==='libera'?'<span class="pv-agg">voce dell\'impresa, senza ribasso</span>':'')+
   (v.prezzo_origine!=null&&num(v.prezzo_origine)!==num(v.prezzo)?'<span class="pv-agg">prezzo di partenza '+euro(v.prezzo_origine)+'</span>':'')+
   (daVedere&&x.fonte?'<span class="pv-agg">Da: '+es(x.fonte)+'</span>':'')+(daVedere&&x.nota?'<span class="pv-agg">'+es(x.nota)+'</span>':'')+'</div>'+
   '<span class="um">'+es(v.unita||'')+'</span><span class="n q">'+qta(v.quantita)+'</span><span class="n pu">'+euro(v.prezzo)+'</span><span class="n im">'+euro(v.importo)+'</span>'+
   (v.misure&&v.misure.length?misureHtml(v.misure):'')+
   (bozza?'<div class="pv-vbt">'+(daVedere?(num(v.prezzo)?'<button type="button" class="pv-b sm pv-pr" data-iaok="'+v.id+'">Va bene</button>':'<button type="button" class="pv-b sm pv-pr" data-mod="'+v.id+'">Metti il prezzo</button>')+
    ((x.alternative||[]).length?'<button type="button" class="pv-b sm" data-iaalt="'+v.id+'">Scegli un\'altra ('+x.alternative.length+')</button>':''):'')+
    '<button type="button" class="pv-b sm" data-mod="'+v.id+'">Modifica</button><button type="button" class="pv-b sm pv-arg" data-su="'+v.id+'"'+(i?'':' disabled')+'>↑</button><button type="button" class="pv-b sm pv-arg" data-giu="'+v.id+'"'+(i<V.length-1?'':' disabled')+'>↓</button>'+
    (daVedere?'<button type="button" class="pv-b sm pv-togli" data-iatogli="'+v.id+'">Togli</button>':'')+'</div>':'')+'</div>';});
 h+='</div>';
 // revisioni
 if((D.revisioni||[]).length){h+='<div class="pv-voci"><h3>Revisioni mandate</h3><ul class="pv-revs">'+D.revisioni.map(function(r){
  return '<li><b>Rev. '+r.revisione+'</b> · mandata il '+dt(r.mandato_il)+(r.mandato_da?' da '+es(r.mandato_da):'')+' · '+euro(r.totale)+' + IVA · impronta <code>'+es(String(r.sha256).slice(0,12))+'…</code> · '+
   '<a href="'+es(CFG.stampa+'?t='+CFG.t+'&id='+F.id+'&rev='+r.revisione)+'" target="_blank" rel="noopener">Stampa o PDF</a> · <a href="'+es(CFG.excel+'?t='+CFG.t+'&id='+F.id+'&rev='+r.revisione)+'">Excel</a></li>';}).join('')+'</ul></div>';}
 h+='</section>';
 // totale
 h+='<section class="pv-card pv-riep"><h2>Totale</h2>'+
  '<div class="pv-rr"><span>Voci con il ribasso</span><b>'+euro(T.soggetto)+'</b></div>'+
  (num(T.ribasso_pct)>0?'<div class="pv-rr rib"><span>Ribasso del contratto '+cifra(num(T.ribasso_pct),2)+' %</span><b>− '+euro(T.ribasso)+'</b></div>':'')+
  '<div class="pv-rr"><span>Voci senza ribasso</span><b>'+euro(T.non_soggetto)+'</b></div>'+
  '<div class="pv-rr"><span>Totale lavori</span><b>'+euro(T.lavori)+'</b></div>'+
  '<div class="pv-rr"><span>Oneri della sicurezza (senza ribasso)</span><b>'+euro(T.oneri)+'</b></div>'+
  (num(T.sconto)?'<div class="pv-rr"><span>Sconto</span><b>− '+euro(T.sconto)+'</b></div>':'')+
  '<div class="pv-rr tot"><span>Totale del preventivo</span><b>'+euro(T.totale)+'<small>+ IVA</small></b></div>'+
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
 if(s==='bozza'){if(F.revisione===1&&!(D.revisioni||[]).length)h+='<button type="button" class="pv-b sm pv-togli" data-az="elimina">Elimina la bozza</button>';}
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
 r.innerHTML='<input data-m="dove" maxlength="120" placeholder="es. Ingresso" value="'+es(m.dove||'')+'"><input class="parti" data-m="parti" inputmode="decimal" value="'+es(nv(m.parti))+'"><input data-m="lun" inputmode="decimal" value="'+es(nv(m.lun))+'">'+
  '<input data-m="lar" inputmode="decimal" value="'+es(nv(m.lar))+'"><input class="alt" data-m="alt" inputmode="decimal" value="'+es(nv(m.alt))+'"><span class="q"></span><button type="button" title="Togli la riga">×</button>';
 r.querySelector('button').onclick=function(){r.parentNode.removeChild(r);ricalcola();};
 Array.prototype.forEach.call(r.querySelectorAll('input'),function(i){i.oninput=ricalcola;});
 $('pv-vo-mis').appendChild(r);}
$('pv-vo-riga').onclick=function(){riga({});ricalcola();var r=$('pv-vo-mis').lastChild;if(r)r.querySelector('input').focus();};
function misure(){return Array.prototype.map.call($('pv-vo-mis').querySelectorAll('.pv-mis-r:not(.h)'),function(r){var o={};Array.prototype.forEach.call(r.querySelectorAll('input'),function(i){o[i.getAttribute('data-m')]=i.value;});return o;});}
function ricalcola(){var M=misure(),tot=0,usa=false,err=false;
 Array.prototype.forEach.call($('pv-vo-mis').querySelectorAll('.pv-mis-r:not(.h)'),function(r,i){var m=M[i],q=null;['parti','lun','lar','alt'].forEach(function(k){var n=inNum(m[k]);if(n===null)return;if(isNaN(n)){err=true;return;}q=(q===null?1:q)*n;});
  if(q!==null||String(m.dove||'').trim())usa=true;r.querySelector('.q').textContent=q===null?'':qta(q);tot+=q||0;});
 $('pv-vo-q').disabled=usa;if(usa)$('pv-vo-q').value=txt2(tot);
 var p=inNum($('pv-vo-prezzo').value),q=inNum($('pv-vo-q').value);
 $('pv-vo-imp').textContent=err?'Nelle righe di misura scrivi solo numeri.':(p!==null&&!isNaN(p)&&q!==null&&!isNaN(q)?'Importo: '+euro(Math.round(p*q*100)/100):'');}
$('pv-vo-prezzo').oninput=ricalcola;$('pv-vo-q').oninput=ricalcola;
$('pv-vo-salva').onclick=function(){var b=this,v=VOCE,lib=v.fonte==='libera',M=misure().filter(function(m){return String(m.dove||'').trim()||m.parti||m.lun||m.lar||m.alt;});
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
var TIPI={computo:'Computo (Excel)',relazione:'Relazione (PDF)',tavole:'Tavole (PDF)'};
var PASSI={controllo:'Controllo dei file',stima:'Pronto da leggere',attesa:'In coda',lettura:'TIX sta leggendo'};
function usd(n){n=num(n);return n>0&&n<0.01?'meno di 0,01':n.toFixed(2).replace('.',',');}
function ora(x){var d=new Date(x);return isNaN(d)?'':String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
function mbTxt(n){n=num(n);return n<1048576?Math.max(1,Math.round(n/1024))+' KB':(n/1048576).toFixed(1).replace('.',',')+' MB';}
function pl(n,uno,tanti){n=num(n);return n+' '+(n===1?uno:tanti);}
// pagine dei PDF se si conoscono per tutti i file, altrimenti il numero dei file
function docTxt(p,n){p=num(p);n=num(n);return p?p+' pag.':n?pl(n,'file','file'):'0';}
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
  h=LOGO+'<div class="pv-ia chiuso"><div class="pv-ia-t"><button type="button" class="pv-ia-ic" id="pv-ia-apri-ic" aria-label="Prepara con TIX">'+SPUNTA+'</button><div><h3>Prepara con '+TIX+'</h3><p>Allega quello che hai ricevuto: computo metrico <b>in Excel</b>, tavole e relazioni in PDF, oppure i loro link. TIX li legge con l\'intelligenza artificiale e compila le voci con i prezzi del contratto e del prezzario; tu controlli e decidi: niente parte da solo.</p></div>'+
   '<button type="button" class="pv-b pv-pr" id="pv-ia-apri">'+'Prepara con '+TIXET+'</button></div>';
  if(s==='pronta')h+=esitoIa(l);
  if(s==='errore')h+='<p class="pv-msg ko">'+es(l.errore||'La lettura non è riuscita.')+'</p>';
  if(s==='annullata')h+='<p class="pv-msg">L\'ultima lettura è stata annullata.</p>';
  box.innerHTML=h+'</div>';
  $('pv-ia-apri-ic').onclick=function(){$('pv-ia-apri').click();};
  $('pv-ia-apri').onclick=function(){var b=this;b.disabled=true;api('ia_nuova',{id:CFG.id}).then(function(r){b.disabled=false;if(r&&r.esito==='ok')caricaIa();else alert(msgErr(r));});};
  return;}
 var mod=s==='preparazione'||s==='stima',F2=l.file||[];
 h=LOGO+'<div class="pv-ia"><div class="pv-ia-t"><span class="pv-ia-ic">'+SPUNTA+'</span><div><h3>Prepara con '+TIX+'</h3><p>'+
  (mod?'Il computo metrico <b>solo in Excel</b>; tavole e relazioni in PDF. Prima TIX controlla i file e ti dice quanto costa; poi decidi tu se partire.':'Puoi chiudere la pagina: il lavoro continua e le voci compaiono qui sotto.')+'</p></div>'+
  '<button type="button" class="pv-b sm" id="pv-ia-annulla">Annulla</button></div>';
 if(mod){
  h+='<label class="pv-c tutta"><span class="pv-et">Cosa c\'è da fare <small>due righe con le tue parole: aiuta TIX a non sbagliare</small></span><textarea id="pv-ia-lavoro" rows="2" maxlength="1000" placeholder="es. Rifacimento dei due bagni al piano primo, sanitari forniti dal cliente">'+es(l.lavoro||'')+'</textarea></label>'+
   '<div class="pv-ia-cari"><label class="pv-ia-drop" id="pv-ia-drop"><input type="file" id="pv-ia-file" multiple accept=".xlsx,.xls,.xlsm,.ods,.csv,.pdf" hidden>'+NUVOLA+'<b>Aggiungi file (anche più di uno)</b><small>Computo metrico <b>solo in Excel</b> · tavole e relazioni in PDF · fino a 18 MB per file</small></label>'+
   '<div class="pv-ia-link"><b>Oppure incolla un link</b><div class="pv-ia-lb"><input id="pv-ia-url" placeholder="https://drive.google.com/…" maxlength="600" autocomplete="off">'+
   '<select id="pv-ia-url-tipo"><option value="relazione">Relazione</option><option value="tavole">Tavole</option><option value="computo">Computo (Excel)</option></select><button type="button" class="pv-b sm pv-pr" id="pv-ia-url-ok">Aggiungi</button></div>'+
   '<small>Google Drive (file o cartella), OneDrive, Dropbox, condivisi con «Chiunque abbia il link». TIX legge i file e non ne tiene la copia: dopo puoi togliere la condivisione.</small></div></div>';
 }
 h+='<div class="pv-ia-file">'+F2.map(function(f){return rigaFileIa(f,mod);}).join('')+'</div>';
 if(!F2.length)h+='<p class="pv-vuoto">Nessun file ancora.</p>';
 if(l.errore&&mod)h+='<p class="pv-msg ko">'+es(l.errore)+'</p>';
 if(s==='preparazione')h+='<div class="pv-az"><button type="button" class="pv-b pv-pr" id="pv-ia-controlla"'+(F2.length?'':' disabled')+'>Controlla i file</button><span class="pv-ia-nota">Gratis: TIX legge i file, trova i prezzi per codice e ti dice quanto costa preparare le voci.</span></div>';
 if(s==='stima')h+=stimaIa(l);
 if(!mod)h+='<div class="pv-ia-att"><div class="pv-ia-gira"></div><div><b>'+es(l.passo||PASSI[s]||'')+'</b><small>'+(s==='controllo'?'Di solito qualche minuto: TIX controlla un file per volta.':(l.modalita==='subito'?'Velocità «Subito»: pochi minuti.':'Velocità «Senza fretta»: di solito entro un\'ora, al massimo un giorno.'))+
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
function stimaIa(l){var t=l.stima||{},sub=l.modalita==='subito',costo=sub?t.usd_subito:t.usd_senza_fretta;
 var h='<div class="pv-ia-stima"><div><span>Voci del computo</span><b>'+(t.voci_computo||0)+'</b><small>'+(t.per_codice||0)+' con il prezzo per codice · '+(t.da_scegliere||0)+' da scegliere con TIX · '+(t.senza_prezzo||0)+' senza voci simili</small></div>'+
  '<div><span>Relazioni</span><b>'+docTxt(t.pagine_relazioni,t.file_relazioni)+'</b><small>lette da TIX in PDF</small></div>'+
  '<div><span>Tavole</span><b>'+docTxt(t.pagine_tavole,t.file_tavole)+'</b><small>lette da TIX in PDF</small></div>'+
  '<div class="soldi"><span>Costo stimato</span><b>'+usd(costo)+' $</b><small>+ IVA · '+(sub?'pochi minuti':'di solito entro un\'ora')+'</small></div></div>';
 if((t.avvisi||[]).length)h+='<p class="pv-avviso">'+t.avvisi.map(es).join('<br>')+'</p>';
 h+='<div class="pv-ia-vel"><span class="et">Velocità</span><button type="button" class="pv-chip'+(sub?'':' on')+'" data-iamod="batch">Senza fretta <em>· metà prezzo</em></button>'+
  '<button type="button" class="pv-chip'+(sub?' on':'')+'" data-iamod="subito">Subito <em>· prezzo pieno</em></button></div>'+
  '<div class="pv-az"><button type="button" class="pv-b pv-pr" id="pv-ia-parti">Prepara il preventivo</button><button type="button" class="pv-b" id="pv-ia-ricontrolla">Controlla di nuovo</button>'+
  '<span class="pv-ia-nota">Le voci che ci sono già restano. Quelle di TIX si aggiungono sotto, segnate, e le controlli una per una prima di mandare il preventivo.</span></div>';
 return h;}
function esitoIa(l){var r=l.riepilogo||{},h='<div class="pv-ia-esito"><p class="pv-ia-rie">Ultima lettura: '+pl(r.scritte,'voce aggiunta','voci aggiunte')+' · '+(r.per_codice||0)+' con il prezzo per codice · '+
  pl(r.scelte_ia,'scelta da TIX','scelte da TIX')+' · '+(r.senza_prezzo||0)+' senza prezzo · '+(r.in_piu||0)+' in più dalle relazioni e dalle tavole · costo '+usd(l.costo_usd)+' $ + IVA</p>';
 if((l.da_chiarire||[]).length)h+='<div class="pv-ia-chiarire"><b>Da chiarire con il cliente</b><ol>'+l.da_chiarire.map(function(x){return '<li>'+es(x)+'</li>';}).join('')+'</ol></div>';
 h+='<details class="pv-ia-letti"><summary>File letti</summary>'+(l.file||[]).map(function(f){return '<div>'+es(f.nome)+(f.pagine?' · '+f.pagine+' pag.':'')+(f.voci?' · '+f.voci+' voci':'')+
  (f.sha256?' · impronta <code>'+es(String(f.sha256).slice(0,8))+'…</code>':'')+(f.messaggio?' · '+es(f.messaggio):'')+'</div>';}).join('')+'<small>I file non restano in TIX: resta questo elenco, con le impronte.</small></details></div>';
 return h;}
function azIa(az,d,b){if(b)b.disabled=true;msgIa('Un momento…');d=d||{};d.id=CFG.id;
 return api('ia_'+az,d).then(function(r){if(b)b.disabled=false;if(r&&r.esito==='ok'){msgIa('');caricaIa();}else msgIa(msgErr(r),'ko');return r;});}
function legaIa(l){
 var an=$('pv-ia-annulla');if(an)an.onclick=function(){if(confirm('Annullare «Prepara con TIX»? I file allegati si tolgono.'))azIa('annulla',{},an);};
 var lv=$('pv-ia-lavoro');if(lv)lv.onchange=function(){azIa('lavoro',{lavoro:lv.value});};
 var fi=$('pv-ia-file');if(fi)fi.onchange=function(){caricaFileIa(fi.files);};
 var dr=$('pv-ia-drop');if(dr){dr.ondragover=function(e){e.preventDefault();dr.classList.add('su');};dr.ondragleave=function(){dr.classList.remove('su');};
  dr.ondrop=function(e){e.preventDefault();dr.classList.remove('su');caricaFileIa(e.dataTransfer&&e.dataTransfer.files);};}
 var uo=$('pv-ia-url-ok');if(uo)uo.onclick=function(){var u=$('pv-ia-url').value.trim();if(!u){msgIa('Incolla il link.','ko');return;}azIa('link',{link:u,tipo:$('pv-ia-url-tipo').value},uo);};
 var co=$('pv-ia-controlla');if(co)co.onclick=function(){azIa('controlla',{},co);};
 var rc=$('pv-ia-ricontrolla');if(rc)rc.onclick=function(){azIa('controlla',{},rc);};
 var pa=$('pv-ia-parti');if(pa)pa.onclick=function(){parti(pa,false);};
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-iamod]'),function(b){b.onclick=function(){azIa('lavoro',{modalita:b.getAttribute('data-iamod')},b);};});
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-iatipo]'),function(s){s.onchange=function(){azIa('tipo_file',{file_id:s.getAttribute('data-iatipo'),tipo:s.value});};});
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-ialeggi]'),function(c){c.onchange=function(){azIa('tipo_file',{file_id:c.getAttribute('data-ialeggi'),leggi:c.checked});};});
 Array.prototype.forEach.call(document.querySelectorAll('#pv-ia [data-iax]'),function(b){b.onclick=function(){azIa('togli_file',{file_id:b.getAttribute('data-iax')},b);};});}
function parti(b,conferma){b.disabled=true;msgIa('Un momento…');
 api('ia_parti',{id:CFG.id,conferma_tetto:conferma}).then(function(r){b.disabled=false;
  if(r&&r.esito==='tetto'){msgIa('');if(confirm(r.messaggio))parti(b,true);return;}
  if(r&&r.esito==='ok'){msgIa('');caricaIa();}else msgIa(msgErr(r),'ko');});}
function caricaFileIa(files){var L=Array.prototype.slice.call(files||[]);
 var no=L.filter(function(f){return !/\.(xlsx|xls|xlsm|ods|csv|pdf)$/i.test(f.name)||f.size>18*1024*1024;});
 L=L.filter(function(f){return no.indexOf(f)<0;});
 var errori=no.length?['Non caricati: '+no.map(function(f){return f.name;}).join(', ')+' (computo in Excel, tavole e relazioni in PDF, fino a 18 MB).']:[];
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

if(CFG.id){disegna();caricaIa();}else elenco();
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
  const fonte = (v) => v.fonte === "contratto" ? "Elenco prezzi del contratto" + (v.codice ? ", " + v.codice : "")
    : v.fonte === "prezzario" ? (z ? z.titolo : "Prezzario regionale") + (v.codice ? ", " + v.codice : "")
    : "Voce dell'impresa" + (v.codice ? ", " + v.codice : "");
  const fonti = [];
  if (voci.some((v) => v.fonte === "contratto")) fonti.push("dall'elenco prezzi del contratto" + (k && k.data_contratto ? " del " + dataIt(k.data_contratto) : ""));
  if (voci.some((v) => v.fonte === "prezzario") && z) fonti.push("dal " + z.titolo + (z.delibera ? " (" + z.delibera + ")" : ""));
  const rib = Number(T.ribasso_pct) || 0;
  const logo = /^https:\/\/[^\s"'<>]+$/.test(String(imp.logo_url || "")) ? '<img class="logo-img" src="' + e(imp.logo_url) + '" alt="" onerror="this.remove()">' : "";
  const righe = voci.map((v, i) => "<tr><td>" + (i + 1) + "</td><td>" + e(v.descrizione) + '<span class="cod">' + e(fonte(v)) + "</span>" +
    (Array.isArray(v.misure) && v.misure.length ? '<span class="mis">' + v.misure.map((m) => e((m.dove ? m.dove + ": " : "") +
      ["parti", "lun", "lar", "alt"].map((x) => m[x]).filter((x) => x !== null && x !== undefined && x !== "").map((x) => cifra(x, 2)).join(" × ") +
      " = " + cifra(m.q, 2))).join(" · ") + "</span>" : "") +
    "</td><td>" + e(v.unita || "") + '</td><td class="n">' + cifra(v.quantita, 2) + '</td><td class="n">' + cifra(v.prezzo, 2) + '</td><td class="n">' + cifra(v.importo, 2) + "</td></tr>").join("");
  const data = foto ? dataIt(f.data || d.mandato_il) : "";
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>" + e(f.codice + " " + (f.titolo || "")) + "</title>" +
    "<style>" + STILE_FOGLIO + "</style></head><body>" +
    '<div class="barra"><button type="button" onclick="window.print()">Stampa o salva in PDF</button><a href="' + e(base + "/preventivi?t=" + tok + "&id=" + f.id) + '">‹ Torna al preventivo</a>' +
    (foto ? "" : '<span>Bozza: non ancora mandato al cliente</span>') + "</div>" +
    '<div class="carta' + (foto ? "" : " bozza") + '">' +
    '<div class="inte"><div class="logo">' + logo + "<div><b>" + e(imp.nome || "") + "</b><span>" + e([imp.indirizzo, imp.partita_iva ? "P. IVA " + imp.partita_iva : "",
      imp.telefono ? "Tel. " + imp.telefono : "", imp.email].filter(Boolean).join(" · ")) + "</span></div></div>" +
    '<div class="num"><b>Preventivo ' + e(f.codice) + "</b><span>Rev. " + e(f.revisione) + (data ? " · " + data : " · bozza") + " · valido " + e(f.validita_giorni) + " giorni</span></div></div>" +
    '<div class="dest"><p><small>Spettabile</small>' + e(cl.nome || "") + (cl.indirizzo ? "<br>" + e(cl.indirizzo) : "") + (cl.piva ? "<br>P. IVA / C.F. " + e(cl.piva) : "") + "</p>" +
    "<p><small>" + (c ? "Cantiere" : "Lavoro") + "</small>" + e(c ? c.nome : (f.indirizzo_lavoro || "")) + (c && c.ubicazione ? "<br>" + e(c.ubicazione) : "") +
    (!c && f.indirizzo_lavoro ? "" : (f.indirizzo_lavoro && c && f.indirizzo_lavoro !== c.ubicazione ? "<br>" + e(f.indirizzo_lavoro) : "")) + "</p></div>" +
    '<p class="ogg"><b>Oggetto:</b> ' + (c ? "lavori extracontrattuali — " : "") + e(f.titolo || "") + ".</p>" +
    '<table><thead><tr><th>Nr</th><th>Descrizione</th><th>U.M.</th><th class="n">Q.tà</th><th class="n">Prezzo €</th><th class="n">Importo €</th></tr></thead><tbody>' + righe + "</tbody></table>" +
    '<div class="tot">' +
    '<div><span>Voci con il ribasso</span><span>' + cifra(T.soggetto, 2) + " €</span></div>" +
    (rib > 0 ? '<div><span>Ribasso del contratto ' + cifra(rib, 2) + " %</span><span>− " + cifra(T.ribasso, 2) + " €</span></div>" : "") +
    (Number(T.non_soggetto) ? '<div><span>Voci senza ribasso</span><span>' + cifra(T.non_soggetto, 2) + " €</span></div>" : "") +
    '<div><span>Totale lavori</span><span>' + cifra(T.lavori, 2) + " €</span></div>" +
    (Number(T.oneri) ? '<div><span>Oneri della sicurezza</span><span>' + cifra(T.oneri, 2) + " €</span></div>" : "") +
    (Number(T.sconto) ? '<div><span>Sconto</span><span>− ' + cifra(T.sconto, 2) + " €</span></div>" : "") +
    '<div class="fin"><span>Totale</span><span>' + cifra(T.totale, 2) + " € + IVA</span></div></div>" +
    '<p class="cond">' + (fonti.length ? "Prezzi presi " + e(fonti.join(" e ")) + (rib > 0 ? ", con il ribasso del contratto del " + cifra(rib, 2) + " %" : "") + ". " : "") +
    "Le quantità si misurano a lavoro finito. Il preventivo vale " + e(f.validita_giorni) + " giorni dalla data." + (f.note ? "<br>" + e(f.note) : "") + "</p>" +
    '<div class="firme"><div>' + e(imp.nome || "") + "<br>" + (imp.referente ? e(imp.referente) : "Referente di cantiere") + '</div><div>Per accettazione · il committente<br>data e firma</div></div>' +
    '<div class="piede"><span>Preparato con TIX™ · Diario di cantiere</span><span>' + (foto ? "Impronta SHA-256 della Rev. " + e(f.revisione) + ": " + e(String(d.sha256 || "").slice(0, 16)) + "…" : "Bozza") + "</span></div>" +
    "</div></body></html>";
}

const STILE_FOGLIO =
  "*{box-sizing:border-box}body{margin:0;background:#E9EDF2;color:#111;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,Arial,sans-serif}" +
  ".barra{position:sticky;top:0;z-index:2;display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 16px;background:#1B2F4A;color:#fff}" +
  ".barra button{min-height:40px;padding:0 16px;border:0;border-radius:10px;background:#66741C;color:#fff;font:inherit;font-weight:700;cursor:pointer}.barra a{color:#fff;font-weight:600}.barra span{margin-left:auto;font-weight:700;color:#FFD9B8}" +
  ".carta{position:relative;max-width:820px;margin:20px auto;background:#fff;border-radius:6px;box-shadow:0 2px 4px rgba(16,27,43,.08),0 24px 48px -24px rgba(16,27,43,.35);padding:40px 44px;font-size:.84rem}" +
  ".carta.bozza::after{content:'BOZZA';position:absolute;top:38%;left:0;right:0;text-align:center;font-size:7rem;font-weight:900;color:rgba(242,106,16,.08);transform:rotate(-24deg);pointer-events:none}" +
  ".inte{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding-bottom:14px;border-bottom:2px solid #1B2F4A}" +
  ".logo{display:flex;align-items:center;gap:10px}.logo-img{max-width:90px;max-height:56px;object-fit:contain}.logo b{display:block;font-size:1.05rem;color:#1B2F4A}.logo span{font-size:.76rem;color:#555}" +
  ".num{text-align:right}.num b{display:block;font-size:1.2rem;color:#1B2F4A;white-space:nowrap}.num span{font-size:.78rem;color:#444}" +
  ".dest{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:16px 0}.dest p{margin:0;line-height:1.5}.dest small{display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#666;font-weight:700}" +
  ".ogg{margin:0 0 12px;padding:8px 10px;border-left:3px solid #F26A10;background:#FAFAFA}" +
  "table{width:100%;border-collapse:collapse;font-size:.78rem}th{text-align:left;font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;border-bottom:1.5px solid #1B2F4A;color:#333;padding:6px}" +
  "td{padding:6px;border-bottom:1px solid #E3E3E3;vertical-align:top}td.n,th.n{text-align:right;white-space:nowrap}tr{break-inside:avoid}" +
  ".cod{display:block;font-size:.68rem;color:#666;margin-top:2px}.mis{display:block;font-size:.68rem;color:#666}" +
  ".tot{width:340px;margin:12px 0 0 auto}.tot div{display:flex;justify-content:space-between;gap:10px;padding:4px 0}.tot div.fin{margin-top:4px;padding:8px 0;border-top:2px solid #1B2F4A;font-weight:800;font-size:1rem;color:#1B2F4A}" +
  ".cond{margin:14px 0 0;font-size:.74rem;color:#333;line-height:1.5}" +
  ".firme{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:26px;break-inside:avoid}.firme div{border-top:1px solid #999;padding-top:6px;font-size:.74rem;color:#444;min-height:46px}" +
  ".piede{margin-top:20px;padding-top:8px;border-top:1px solid #E3E3E3;display:flex;justify-content:space-between;gap:10px;font-size:.68rem;color:#777}" +
  "@media (max-width:640px){.carta{margin:10px;padding:18px 14px}.inte{flex-direction:column}.num{text-align:left}.dest,.firme{grid-template-columns:1fr}.tot{width:100%}}" +
  "@media print{@page{size:A4;margin:14mm}body{background:#fff}.barra{display:none}.carta{margin:0;max-width:none;box-shadow:none;border-radius:0;padding:0}" +
  "*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}";

// ---------------------------------------------------------------------------- Excel
async function excel(request, env, base, inUrl, h) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const tok = gettone(inUrl.searchParams.get("t"));
  const id = uuid(inUrl.searchParams.get("id"));
  if (!tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!id) return new Response("Not Found", { status: 404 });
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
// Il computo in Excel, tavole e relazioni in PDF (il resto lo controlla la funzione preventivo-ia). Il file va in
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
  if (!est) return json({ esito: "formato", messaggio: "Il computo metrico in Excel; tavole e relazioni in PDF." }, 400);
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
