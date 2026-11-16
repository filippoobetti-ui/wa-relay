// ============================================================================
// MEZZI E ATTREZZATURE — area riservata (03/11/2026, mezzi-1). Pulsante «Mezzi e attrezzature» nell'elenco dei cantieri
// (portale_azioni_html). Il parco dell'impresa in due schede, «Automezzi e macchine» e «Attrezzature», con il prezzo in
// economia + IVA di ogni mezzo (all'ora, al giorno o a mezza giornata, con o senza operatore) e i prezzi della manodopera per
// qualifica. Sono i prezzi «di base»: nel Registro delle economie di un cantiere si mette il prezzo concordato con quel
// committente (src/economie.js). I prezzi li cambia solo l'ufficio; ogni cambio resta nello storico con data e autore e vale
// da quel giorno in poi (il primo prezzo di un mezzo vale dall'inizio). Decisioni di Filippo del 03/11/2026.
//   GET  /mezzi?t=<gettone>[&a=<impresa>]   → pagina (database: mezzi_portale; «a» solo con l'accesso «Tutte le aziende»)
//   POST /mezzi/api  {t, a, azione, dati}    → salva | elimina | prezzo  (mezzi_salva, mezzi_elimina, prezzo_economia_salva)
// Interruttori: impostazioni.mezzi_attiva (no / prova = solo Filippo / si) e MEZZI = "off" nel Worker.
// 14/11/2026 (campi-rossi-b2, regola di Filippo): nella scheda del mezzo e nei prezzi della manodopera ciò che manca o è scritto
// male si segna in rosso con la riga che dice cosa scrivere (modulo comune src/campi-rossi.js).
// ============================================================================
import { CAMPI_ROSSI_CSS, CAMPI_ROSSI_JS } from "./campi-rossi.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: {
    "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
function testo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function gettone(x) { const m = String(x || "").match(/^[0-9a-fA-F]{64}$/); return m ? m[0].toLowerCase() : ""; }
function impresa(x) { const a = String(x || "").toLowerCase().trim(); return UUID.test(a) ? a : ""; }

// solo i campi che il database conosce, già accorciati
// 16/11/2026 (mezzi-anagrafica-1): scheda completa sul modello dell'elenco di Brenta Lavori srl, 4 prezzi, stato, importazione
const TARIFFE = ["ora_con", "ora_senza", "giorno_con", "giorno_senza"];
function pulisci(d) {
  const x = d && typeof d === "object" ? d : {};
  const p = x.prezzi && typeof x.prezzi === "object" ? x.prezzi : {};
  const prezzi = {};
  for (const k of TARIFFE) if (k in p) prezzi[k] = testo(p[k], 20);
  return {
    id: testo(x.id, 36), scheda: testo(x.scheda, 20), tipo: testo(x.tipo, 60), nome: testo(x.nome, 80),
    marca_modello: testo(x.marca_modello, 160), targa: testo(x.targa, 30), proprieta: testo(x.proprieta, 20),
    noleggiatore: testo(x.noleggiatore, 120), con_operatore: x.con_operatore === true || x.con_operatore === "true" ? "true" : "false",
    unita: testo(x.unita, 20), note: testo(x.note, 1000), prezzo: testo(x.prezzo, 20), valido_dal: testo(x.valido_dal, 10),
    voce: testo(x.voce, 20), qualifica: testo(x.qualifica, 20), mezzo_id: testo(x.mezzo_id, 36),
    tariffa: TARIFFE.includes(x.tariffa) ? x.tariffa : "", prezzi,
    categoria: testo(x.categoria, 80), sottocategoria: testo(x.sottocategoria, 80), numero_aziendale: testo(x.numero_aziendale, 20),
    cespite: testo(x.cespite, 40), matricola: testo(x.matricola, 80), anno: testo(x.anno, 4), data_acquisto: testo(x.data_acquisto, 10),
    classe_emissione: testo(x.classe_emissione, 40), revisione: testo(x.revisione, 3), revisione_scadenza: testo(x.revisione_scadenza, 10),
    revisione_frequenza: testo(x.revisione_frequenza, 2), revisione_nota: testo(x.revisione_nota, 300), luogo_cc: testo(x.luogo_cc, 120),
    cronotachigrafo: testo(x.cronotachigrafo, 200), bollo_scadenza: testo(x.bollo_scadenza, 10), descrizione: testo(x.descrizione, 300),
    telepass: testo(x.telepass, 120), cartella: testo(x.cartella, 60), documenti: testo(x.documenti, 60),
    stato: x.stato === "non_in_uso" ? "non_in_uso" : "in_uso", stato_motivo: testo(x.stato_motivo, 200)
  };
}

export async function portaleMezzi(request, env, base, inUrl, h) {
  if (env.MEZZI === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");

  if (sotto === "/mezzi/api") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    let b = null;
    try { b = await request.json(); } catch (e) { b = null; }
    const tok = gettone(b && b.t), a = impresa(b && b.a), az = String(b && b.azione || "");
    if (!tok) return json({ esito: "gettone" }, 400);
    const dati = pulisci(b && b.dati);
    let r = null;
    if (az === "salva") r = await h.rpc(env, "mezzi_salva", { p_token: tok, p_azienda: a, p_dati: dati }, 15000).catch(() => null);
    else if (az === "elimina" && UUID.test(dati.id)) r = await h.rpc(env, "mezzi_elimina", { p_token: tok, p_azienda: a, p_id: dati.id }, 15000).catch(() => null);
    else if (az === "prezzo") r = await h.rpc(env, "prezzo_economia_salva", { p_token: tok, p_azienda: a, p_commessa: "", p_dati: dati }, 15000).catch(() => null);
    else if (az === "importa") {
      // 16/11/2026: fino a 300 righe per chiamata (il browser manda l'elenco a blocchi)
      const righe = Array.isArray(b && b.righe) ? b.righe.slice(0, 300).map(pulisci) : [];
      if (!righe.length) return json({ esito: "errore", messaggio: "Nessuna riga da aggiungere." }, 400);
      r = await h.rpc(env, "mezzi_importa", { p_token: tok, p_azienda: a, p_righe: righe }, 60000).catch(() => null);
    }
    else return json({ esito: "errore" }, 400);
    return json(r || { esito: "errore" }, r ? 200 : 503);
  }

  if (sotto !== "/mezzi") return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const tok = gettone((String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/) || [""])[0]);
  if (!tok) return Response.redirect(inUrl.origin + base + "/", 303);
  const a = impresa(inUrl.searchParams.get("a"));
  const torna = base + "/?t=" + tok;
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna ai cantieri</a></p>';
  const d = await h.rpc(env, "mezzi_portale", { p_token: tok, p_azienda: a }, 15000).catch(() => null);
  if (!d) return h.risposta(h.foglio(base, "Mezzi e attrezzature", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Mezzi e attrezzature", "Questa pagina non è ancora disponibile.", indietro), 404);
  return h.risposta(pagina(base, h, tok, a, d, torna));
}

// ---------------------------------------------------------------------------- pagina
function pagina(base, h, tok, a, d, torna) {
  const e = h.esc;
  const az = d.azienda || null;
  const imprese = Array.isArray(d.imprese) ? d.imprese : [];
  const scelta = d.filippo
    ? '<form class="mz-scegli" method="get" action="' + e(base + "/mezzi") + '"><input type="hidden" name="t" value="' + e(tok) + '">' +
      '<label>Impresa <select name="a" onchange="this.form.submit()"><option value="">Scegli l\'impresa…</option>' +
      imprese.map((x) => '<option value="' + e(x.id) + '"' + (az && az.id === x.id ? " selected" : "") + ">" + e(x.nome) + "</option>").join("") +
      "</select></label></form>"
    : "";
  const cfg = JSON.stringify({ u: base + "/mezzi/api", t: tok, a: az ? az.id : "", d: az ? d : null }).replace(/</g, "\\u003c");
  const icona = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.5 18.5h10"/><circle cx="5" cy="18.5" r="1.6"/><circle cx="10" cy="18.5" r="1.6"/><path d="M3.5 15.5v-4h5.5l2 4"/>' +
    '<path d="M11 11.5l4.5-6 5 3.5-2.5 3"/><path d="M20.5 9l.5 4.5h-3"/></svg>';
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>Mezzi e attrezzature - TIX · Diario di cantiere</title>" + h.testa(base) +
    "<style>" + STILE + CAMPI_ROSSI_CSS + "</style></head><body><main>" +
    '<a class="mz-torna" href="' + e(torna) + '">‹ Torna ai cantieri</a>' +
    '<section class="mz-card"><div class="mz-testa"><div><p class="mz-chi">' + e(az ? az.nome : "Tutte le aziende") + "</p>" +
    '<h1><span class="mz-ic">' + icona + "</span>Mezzi e attrezzature</h1></div>" +
    (az ? '<div class="mz-az-t"><button type="button" class="mz-b" id="mz-carica">&#128229; Carica da file</button>' +
      '<button type="button" class="mz-b mz-pr" id="mz-nuovo">+ Aggiungi</button></div>' : "") + "</div>" +
    scelta +
    (az
      ? '<p class="mz-spiega">I prezzi che scrivi qui sono il <b>listino dell\'impresa</b>, + IVA, per tutti i cantieri. Se il contratto d\'appalto di un cantiere prevede prezzi diversi (per esempio 28 €/ora invece di 35), li scrivi solo in quel cantiere: <b>Registro delle economie → Prezzi del contratto d\'appalto</b>. Un prezzo cambiato vale da oggi in poi: i giorni passati restano con il prezzo di allora.</p>' +
        '<nav class="mz-tabs" aria-label="Schede"><button type="button" data-s="mezzo" class="on">Automezzi e macchine <small id="mz-n-mezzo">0</small></button>' +
        '<button type="button" data-s="attrezzatura">Attrezzature <small id="mz-n-attrezzatura">0</small></button></nav>' +
        // 16/11/2026: ricerca, categoria e «non più in uso» (elenchi di centinaia di mezzi)
        '<div class="mz-filtri"><input type="search" id="mz-cerca" placeholder="Cerca: numero, marca, targa, matricola…" aria-label="Cerca">' +
        '<select id="mz-cat" aria-label="Categoria"><option value="">Tutte le categorie</option></select>' +
        '<label class="mz-chk"><input type="checkbox" id="mz-vecchi"> Mostra anche quelli non più in uso <small id="mz-n-vecchi"></small></label></div>' +
        '<p class="mz-scad" id="mz-scad" hidden></p>' +
        '<div class="mz-griglia" id="mz-griglia"></div>' +
        '<div class="mz-mano"><div class="mz-mano-t"><h2>Manodopera in economia · listino dell\'impresa</h2><p>Prezzo orario + IVA per qualifica. Nel Registro delle economie ogni riga di ore prende il prezzo della sua qualifica, oppure quello del contratto d\'appalto del cantiere, se l\'hai scritto.</p></div>' +
        '<div class="mz-qual" id="mz-qual"></div><p class="mz-msg" id="mz-msg-q" aria-live="polite"></p></div>'
      : '<p class="mz-spiega">Scegli l\'impresa per vedere e scrivere i suoi mezzi, le attrezzature e i prezzi in economia.</p>') +
    "</section>" +
    '<p class="mz-piede">Su WhatsApp operai e capocantiere non vedono mai i prezzi. Le ore dei mezzi in economia si scrivono nel Registro delle economie di ogni cantiere.</p>' +
    "</main>" +
    MODULO + (az ? CARICA_HTML : "") +
    "<script>" + CAMPI_ROSSI_JS + "</script>" +
    "<script>" + SCRIPT.replace("__CFG__", cfg).replace("__CARICA__", az ? CARICA_JS : "") + "</script></body></html>";
}

// 16/11/2026 (mezzi-anagrafica-1): scheda a gruppi sul modello dell'elenco di Brenta Lavori srl; obbligatorio solo il nome
const MODULO =
  '<div class="mz-velo" id="mz-velo" hidden><div class="mz-mod" role="dialog" aria-modal="true" aria-labelledby="mz-mod-t">' +
  '<h2 id="mz-mod-t">Nuovo mezzo</h2>' +
  '<h3 class="mz-gr">Che cos\'è</h3><div class="mz-campi">' +
  '<div class="mz-c tutta"><span class="mz-et">Scheda</span><div class="mz-scelta" data-campo="scheda"><button type="button" data-v="mezzo">Automezzi e macchine</button><button type="button" data-v="attrezzatura">Attrezzature</button></div></div>' +
  '<label class="mz-c"><span class="mz-et">Categoria <small>dall\'elenco, o scrivine una nuova</small></span><input id="f-cat" list="mz-cats" maxlength="80" autocomplete="off"><datalist id="mz-cats"></datalist></label>' +
  '<label class="mz-c"><span class="mz-et">Sottocategoria <small>facoltativo</small></span><input id="f-sotto" list="mz-sotto" maxlength="80" autocomplete="off"><datalist id="mz-sotto"></datalist></label>' +
  '<label class="mz-c"><span class="mz-et">Numero aziendale <small>il vostro numero del mezzo</small></span><input id="f-num" maxlength="20"></label>' +
  '<label class="mz-c"><span class="mz-et">Nome per riconoscerlo <small>è quello che vedi nelle economie</small></span><input id="f-nome" maxlength="80" placeholder="es. N. 5 · Escavatore Kubota 8 t"></label>' +
  '<label class="mz-c"><span class="mz-et">Marca e modello</span><input id="f-mm" maxlength="160"></label>' +
  '<label class="mz-c"><span class="mz-et">Matricola o telaio</span><input id="f-matr" maxlength="80"></label>' +
  '<label class="mz-c"><span class="mz-et">Targa</span><input id="f-targa" maxlength="30"></label>' +
  '<label class="mz-c"><span class="mz-et">Anno di immatricolazione o fabbricazione</span><input id="f-anno" inputmode="numeric" maxlength="4" placeholder="es. 2019"></label>' +
  '<label class="mz-c tutta"><span class="mz-et">Descrizione <small>facoltativo</small></span><input id="f-descr" maxlength="300"></label>' +
  "</div>" +
  '<h3 class="mz-gr">Acquisto e possesso</h3><div class="mz-campi">' +
  '<div class="mz-c tutta"><span class="mz-et">Titolo di possesso</span><div class="mz-scelta" data-campo="proprieta"><button type="button" data-v="proprieta">Di proprietà</button><button type="button" data-v="leasing">In leasing</button><button type="button" data-v="noleggio">A noleggio</button></div></div>' +
  '<label class="mz-c" id="c-nol"><span class="mz-et">Noleggiato da</span><input id="f-nol" maxlength="120"></label>' +
  '<label class="mz-c"><span class="mz-et">Data di acquisto</span><input id="f-acq" type="date"></label>' +
  '<label class="mz-c"><span class="mz-et">Numero di cespite</span><input id="f-cesp" maxlength="40"></label>' +
  '<label class="mz-c"><span class="mz-et">Classe di emissione</span><input id="f-emiss" list="mz-emiss" maxlength="40" placeholder="es. Euro 6, Stage V, elettrica"><datalist id="mz-emiss"><option value="Euro 3"><option value="Euro 4"><option value="Euro 5"><option value="Euro 6"><option value="EU Stage II"><option value="EU Stage IIIA"><option value="EU Stage IIIB"><option value="EU Stage IV"><option value="EU Stage V"><option value="Elettrica"></datalist></label>' +
  "</div>" +
  '<h3 class="mz-gr">Prezzi in economia + IVA</h3>' +
  '<p class="mz-nota">Scrivi quelli che usi: almeno il prezzo all\'ora. <b>Con operatore</b> (nolo a caldo) comprende chi lo guida; <b>senza operatore</b> (nolo a freddo) è solo la macchina, e l\'operatore si mette a parte tra la manodopera.</p>' +
  '<div class="mz-prezzi">' +
  '<label class="mz-c c-con"><span class="mz-et">All\'ora con operatore</span><span class="mz-euro"><input id="p-ora_con" inputmode="decimal" maxlength="12" placeholder="es. 55,00"><b>€</b></span></label>' +
  '<label class="mz-c"><span class="mz-et">All\'ora senza operatore</span><span class="mz-euro"><input id="p-ora_senza" inputmode="decimal" maxlength="12"><b>€</b></span></label>' +
  '<label class="mz-c c-con"><span class="mz-et">Alla giornata con operatore</span><span class="mz-euro"><input id="p-giorno_con" inputmode="decimal" maxlength="12"><b>€</b></span></label>' +
  '<label class="mz-c"><span class="mz-et">Alla giornata senza operatore</span><span class="mz-euro"><input id="p-giorno_senza" inputmode="decimal" maxlength="12"><b>€</b></span></label>' +
  "</div>" +
  '<div class="mz-c tutta" style="margin-top:10px"><span class="mz-et">Nelle economie usa di solito</span><div class="mz-scelta" data-campo="tariffa"><button type="button" class="c-con" data-v="ora_con">all\'ora con operatore</button><button type="button" data-v="ora_senza">all\'ora senza operatore</button><button type="button" class="c-con" data-v="giorno_con">a giornata con operatore</button><button type="button" data-v="giorno_senza">a giornata senza operatore</button></div></div>' +
  '<h3 class="mz-gr">Revisione e scadenze</h3><div class="mz-campi">' +
  '<div class="mz-c"><span class="mz-et">Va fatta la revisione o la verifica?</span><div class="mz-scelta" data-campo="revisione"><button type="button" data-v="si">Sì</button><button type="button" data-v="no">No</button><button type="button" data-v="">Non so</button></div></div>' +
  '<label class="mz-c"><span class="mz-et">Scadenza della revisione</span><input id="f-rev" type="date"></label>' +
  '<label class="mz-c"><span class="mz-et">Ogni quanti anni</span><input id="f-freq" inputmode="numeric" maxlength="2" placeholder="es. 1"></label>' +
  '<label class="mz-c"><span class="mz-et">Nota sulla revisione <small>facoltativo</small></span><input id="f-revn" maxlength="300" placeholder="es. ispezione cisterna 31/10/29"></label>' +
  '<label class="mz-c"><span class="mz-et">Scadenza del bollo</span><input id="f-bollo" type="date"></label>' +
  '<label class="mz-c"><span class="mz-et">Cronotachigrafo</span><input id="f-crono" maxlength="200" placeholder="es. digitale, scad. 14/02/27"></label>' +
  '<label class="mz-c"><span class="mz-et">Dove sta la carta di circolazione</span><input id="f-cc" maxlength="120" placeholder="es. nel mezzo, in ufficio"></label>' +
  '<label class="mz-c"><span class="mz-et">Telepass o Viacard</span><input id="f-tel" maxlength="120"></label>' +
  '<label class="mz-c"><span class="mz-et">Cartella <small>facoltativo</small></span><input id="f-cart" maxlength="60"></label>' +
  '<label class="mz-c"><span class="mz-et">Documenti <small>facoltativo</small></span><input id="f-doc" maxlength="60"></label>' +
  '<label class="mz-c tutta"><span class="mz-et">Note <small>facoltativo</small></span><textarea id="f-note" maxlength="1000" rows="2"></textarea></label>' +
  "</div>" +
  '<h3 class="mz-gr">Stato</h3><div class="mz-campi">' +
  '<div class="mz-c"><span class="mz-et">È ancora in uso?</span><div class="mz-scelta" data-campo="stato"><button type="button" data-v="in_uso">In uso</button><button type="button" data-v="non_in_uso">Non più in uso</button></div></div>' +
  '<label class="mz-c" id="c-motivo"><span class="mz-et">Perché <small>venduto, ceduto, demolito, con la data</small></span><input id="f-motivo" maxlength="200" placeholder="es. venduto il 15/10/22"></label>' +
  "</div>" +
  '<p class="mz-avviso" id="mz-avv-op"><b>Con operatore:</b> il prezzo comprende chi lo guida. Nel registro delle economie non scrivere le sue ore anche tra la manodopera.</p>' +
  '<div class="mz-storico" id="mz-storico" hidden></div>' +
  '<p class="mz-msg" id="mz-msg" aria-live="polite"></p>' +
  '<div class="mz-az"><button type="button" class="mz-b mz-pr" id="mz-salva">Salva</button><button type="button" class="mz-b" id="mz-annulla">Annulla</button>' +
  '<button type="button" class="mz-b mz-togli" id="mz-togli" hidden>Togli dall\'elenco</button></div>' +
  "</div></div>";

// 03/11/2026 (Filippo): «Carica da file». L'elenco dei mezzi (Excel, CSV o PDF) si legge nel browser, come «Importa da file»
// della Rubrica; si mostra l'elenco da controllare, con i nomi già presenti o ripetuti tolti e segnalati; «Aggiungi» salva gli
// altri uno per uno con mezzi_salva (che fa tutti i controlli). C'è anche il modello da scaricare (CSV per Excel).
const CARICA_HTML = '<div class="mz-velo" id="mz-velo-c" hidden><div class="mz-mod" role="dialog" aria-modal="true" aria-labelledby="mz-c-t">' +
  '<h2 id="mz-c-t">Carica mezzi e attrezzature da file</h2>' +
  '<p class="mz-spiega">Carica l\'elenco dei tuoi mezzi e delle attrezzature: Excel (.xlsx, .xls, .ods) oppure CSV, una riga per mezzo; ogni foglio dell\'Excel si legge per conto suo e i fogli dei venduti o demoliti entrano come «non più in uso». ' +
  'TIX riconosce le colonne (numero aziendale, categoria, marca e modello, matricola, targa, anno, acquisto, possesso, revisione, bollo, prezzo…) e prepara l\'elenco da controllare. ' +
  'Quelli che hai già in elenco vengono tolti da soli. Il file resta sul tuo dispositivo: a TIX arrivano solo i mezzi che aggiungi.</p>' +
  '<p class="mz-spiega"><button type="button" class="mz-link" id="mz-modello">Scarica il modello Excel</button> se vuoi partire da un foglio già pronto.</p>' +
  '<label class="mz-file" for="mz-c-file"><input type="file" id="mz-c-file" accept=".xlsx,.xls,.ods,.csv,.txt">&#128196;&nbsp;<span id="mz-c-nome">Scegli il file</span></label>' +
  '<p class="mz-msg" id="mz-c-stato" aria-live="polite"></p><div id="mz-c-ant"></div><p class="mz-msg ko" id="mz-c-err" hidden></p>' +
  '<div class="mz-az"><button type="button" class="mz-b" id="mz-c-chiudi">Chiudi</button><button type="button" class="mz-b mz-pr" id="mz-c-ok" hidden>Aggiungi</button></div>' +
  "</div></div>";

const STILE =
  ":root{--t:#17212E;--s:#5B6672;--c:#fff;--l:rgba(16,27,43,.11);--navy:#1B2F4A;--me:#0B6E79;--me-s:#08505A;--me-f:#E7F4F5;--me-b:#A9D6DA;--dv:#9A4308;--dv-f:#FFF3E8;--dv-b:#F7B98A;--ok:#146C43;--ok-f:#E9F6EF;--ok-b:#A8D8BD}" +
  "*{box-sizing:border-box}body{margin:0;color:var(--t);font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,system-ui,sans-serif;background:#F8FAFC}" +
  "main{max-width:960px;margin:0 auto;padding:16px 12px 48px}" +
  "@media screen and (min-width:760px){main{max-width:min(1600px,calc(100vw - 48px));padding:20px 12px 56px}}" +
  "@media screen and (min-width:900px){main{max-width:min(1600px,calc(100vw - 96px))}}" +
  ".mz-torna{display:inline-block;margin:0 0 12px;color:var(--navy);font-weight:600;text-decoration:none}" +
  ".mz-card{position:relative;background:var(--c);border:1px solid transparent;border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(16,27,43,.05),0 8px 20px -14px rgba(16,27,43,.2)}" +
  ".mz-card::before{content:'';position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#F26A10);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}" +
  ".mz-testa{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}" +
  ".mz-chi{margin:0;font-size:.88rem;color:var(--s)}h1{display:flex;align-items:center;gap:10px;margin:4px 0 0;font-size:1.5rem;color:var(--navy);letter-spacing:-.02em}" +
  ".mz-ic{flex:none;width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#3FB6C2,#0B6E79 55%,#08505A)}.mz-ic svg{width:22px;height:22px}" +
  ".mz-spiega{margin:12px 0 0;font-size:.92rem;line-height:1.55;color:var(--s);max-width:900px}.mz-spiega b{color:var(--t)}" +
  ".mz-scegli{margin:12px 0 0}.mz-scegli select{min-height:40px;margin-left:6px;padding:0 10px;border-radius:10px;border:1px solid rgba(16,27,43,.2);font:inherit}" +
  ".mz-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;padding:0 16px;border-radius:12px;border:1px solid var(--navy);background:#fff;color:var(--navy);font:inherit;font-weight:700;font-size:.92rem;cursor:pointer;text-decoration:none}" +
  ".mz-b:disabled{opacity:.55;cursor:default}.mz-b.sm{min-height:34px;padding:0 12px;font-size:.84rem;border-radius:10px;border-color:rgba(16,27,43,.18);color:var(--t)}" +
  ".mz-pr{border-color:var(--me);color:#fff;background:linear-gradient(180deg,#14919E,#0B6E79)}.mz-togli{border-color:#B3261E;color:#B3261E;margin-left:auto}" +
  ".mz-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 14px}.mz-tabs button{display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border-radius:999px;border:1.5px solid var(--me-b);background:#fff;font:inherit;font-weight:700;color:var(--me-s);cursor:pointer}" +
  ".mz-tabs button.on{background:linear-gradient(180deg,#14919E,#0B6E79);color:#fff;border-color:var(--me)}.mz-tabs small{display:inline-flex;min-width:22px;height:22px;padding:0 6px;align-items:center;justify-content:center;border-radius:999px;background:var(--me-f);color:var(--me-s);font-size:.75rem}.mz-tabs .on small{background:rgba(255,255,255,.25);color:#fff}" +
  ".mz-griglia{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}" +
  ".mz-m{position:relative;border:1px solid var(--l);border-radius:14px;background:#fff;padding:14px 14px 12px}.mz-m::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:4px;border-radius:0 4px 4px 0;background:var(--me)}" +
  ".mz-m h3{margin:0;font-size:1.05rem}.mz-tipo{margin:2px 0 8px;font-size:.84rem;color:var(--s)}" +
  ".mz-tag{display:inline-flex;margin:0 4px 6px 0;padding:2px 9px;border-radius:999px;font-size:.78rem;font-weight:600;border:1px solid var(--me-b);background:var(--me-f);color:var(--me-s)}.mz-tag.p{border-color:var(--ok-b);background:var(--ok-f);color:var(--ok)}.mz-tag.n{border-color:var(--dv-b);background:var(--dv-f);color:var(--dv)}" +
  ".mz-prezzo{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:8px 0 10px;padding:10px 12px;border-radius:10px;background:linear-gradient(180deg,#F7FBFB,#EEF6F7);border:1px solid var(--me-b)}.mz-prezzo b{font-size:1.3rem;color:var(--me-s)}.mz-prezzo span{font-size:.8rem;color:var(--s)}.mz-prezzo.manca b{font-size:.95rem;color:var(--dv)}" +
  ".mz-agg{display:flex;align-items:center;justify-content:center;min-height:150px;border:2px dashed var(--me-b);border-radius:14px;color:var(--me-s);font:inherit;font-weight:700;background:rgba(231,244,245,.45);cursor:pointer}" +
  ".mz-mano{margin:18px 0 0;padding:14px 16px;border-radius:14px;border:1px solid var(--l);background:#FBFCFD}.mz-mano h2{margin:0 0 4px;font-size:1rem;color:var(--navy)}.mz-mano p{margin:0 0 10px;font-size:.86rem;color:var(--s)}" +
  ".mz-qual{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}.mz-q{border:1px solid var(--l);border-radius:12px;background:#fff;padding:10px 12px}.mz-q span{display:block;font-size:.84rem;color:var(--s);margin-bottom:6px}" +
  ".mz-q .r{display:flex;gap:6px;align-items:center}.mz-q input{width:100%;min-height:38px;padding:0 10px;border-radius:10px;border:1px solid rgba(16,27,43,.2);font:inherit;font-size:1.05rem;font-weight:700;color:var(--navy)}.mz-q small{display:block;margin-top:6px;font-size:.76rem;color:var(--s)}" +
  ".mz-msg{min-height:1.2em;margin:8px 0 0;font-size:.88rem;color:var(--s)}.mz-msg.ko{color:#B3261E}.mz-msg.ok{color:var(--ok)}" +
  ".mz-piede{margin:14px 0 0;font-size:.84rem;color:var(--s)}" +
  ".mz-vuoto{grid-column:1/-1;margin:0;padding:14px;border-radius:12px;background:#F5F7FA;color:var(--s);font-size:.9rem}" +
  ".mz-velo{position:fixed;inset:0;z-index:50;background:rgba(16,27,43,.45);display:flex;align-items:flex-start;justify-content:center;padding:24px 12px;overflow:auto}.mz-velo[hidden]{display:none}" +
  ".mz-mod{width:min(760px,100%);background:#fff;border-radius:16px;padding:18px;box-shadow:0 20px 50px -20px rgba(16,27,43,.6)}.mz-mod h2{margin:0 0 12px;color:var(--navy)}" +
  ".mz-campi{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.mz-c{display:flex;flex-direction:column;gap:5px}.mz-c.tutta{grid-column:1/-1}.mz-c[hidden]{display:none}" +
  ".mz-et{font-size:.84rem;font-weight:700}.mz-et small{font-weight:500;color:var(--s)}" +
  ".mz-c input{min-height:42px;padding:0 12px;border:1px solid rgba(16,27,43,.2);border-radius:10px;font:inherit}" +
  ".mz-euro{display:flex;align-items:center;gap:6px}.mz-euro input{flex:1}" +
  ".mz-scelta{display:flex;gap:6px;flex-wrap:wrap}.mz-scelta button{padding:8px 12px;border-radius:10px;border:1px solid rgba(16,27,43,.2);background:#fff;font:inherit;font-weight:600;font-size:.86rem;cursor:pointer}" +
  ".mz-scelta button.on{border-color:var(--me);background:var(--me-f);color:var(--me-s);box-shadow:inset 0 0 0 1px var(--me)}" +
  ".mz-avviso{margin:12px 0 0;padding:10px 12px;border-radius:10px;border:1px solid var(--dv-b);background:var(--dv-f);color:var(--dv);font-size:.86rem}.mz-avviso[hidden]{display:none}" +
  ".mz-storico{margin:12px 0 0;font-size:.84rem;color:var(--s)}.mz-storico ul{margin:6px 0 0;padding:0;list-style:none}.mz-storico li{padding:6px 0;border-top:1px solid var(--l)}.mz-storico b{color:var(--t)}" +
  ".mz-az{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}" +
  // «Carica da file»
  ".mz-az-t{display:flex;gap:8px;flex-wrap:wrap}.mz-link{border:0;background:none;padding:0;font:inherit;font-weight:700;color:var(--me);text-decoration:underline;cursor:pointer}" +
  ".mz-file{position:relative;display:flex;align-items:center;justify-content:center;gap:8px;min-height:64px;margin:12px 0 4px;border:2px dashed var(--me-b);border-radius:12px;cursor:pointer;font-weight:700;color:var(--me-s);background:rgba(231,244,245,.45)}" +
  ".mz-file:hover{border-color:var(--me)}.mz-file input{position:absolute;opacity:0;width:1px;height:1px}" +
  ".mz-ries{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 0}.mz-ries span{padding:3px 9px;border-radius:999px;font-size:.8rem;font-weight:700;background:var(--me-f);color:var(--me-s)}" +
  ".mz-l{max-height:46vh;overflow:auto;border:1px solid var(--l);border-radius:10px;margin-top:8px}" +
  ".mz-r{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-bottom:1px solid var(--l)}.mz-r:last-child{border-bottom:0}.mz-r>span{flex:1;min-width:0}" +
  ".mz-r input{margin-top:4px}.mz-r b{display:block}.mz-r small{display:block;color:var(--s);overflow-wrap:anywhere}.mz-r .perche{color:var(--dv);font-weight:600}.mz-r.no{opacity:.6}" +
  ".mz-r select{font:inherit;font-size:.82rem;padding:3px 6px;border-radius:8px;border:1px solid rgba(16,27,43,.2);margin-top:4px}" +
  // 16/11/2026 (mezzi-anagrafica-1): gruppi della scheda, 4 prezzi, filtri, stato e scadenze sulle carte
  ".mz-gr{margin:18px 0 8px;padding-top:12px;border-top:1px solid var(--l);font-size:.95rem;color:var(--navy)}.mz-mod h3.mz-gr:first-of-type{border-top:0;padding-top:0;margin-top:0}" +
  ".mz-nota{margin:0 0 10px;font-size:.84rem;line-height:1.5;color:var(--s)}.mz-nota b{color:var(--t)}" +
  ".mz-prezzi{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.mz-prezzi [hidden],.mz-scelta [hidden]{display:none}" +
  ".mz-c textarea{min-height:60px;padding:8px 12px;border:1px solid rgba(16,27,43,.2);border-radius:10px;font:inherit;resize:vertical}" +
  ".mz-filtri{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}.mz-filtri input[type=search]{flex:1 1 260px;min-height:40px;padding:0 12px;border:1px solid rgba(16,27,43,.2);border-radius:10px;font:inherit}" +
  ".mz-filtri select{min-height:40px;padding:0 10px;border:1px solid rgba(16,27,43,.2);border-radius:10px;font:inherit;max-width:100%}.mz-chk{display:inline-flex;align-items:center;gap:6px;font-size:.88rem;color:var(--s)}" +
  ".mz-scad{margin:0 0 12px;padding:10px 12px;border-radius:10px;border:1px solid var(--dv-b);background:var(--dv-f);color:var(--dv);font-size:.88rem}" +
  ".mz-m.vecchio{opacity:.62}.mz-m.vecchio::before{background:#9AA4AF}.mz-tag.v{border-color:#C9CFD6;background:#F1F3F5;color:#5B6672}" +
  ".mz-tag.s{border-color:#F3B4AF;background:#FDF1F0;color:#B3261E}.mz-tag.a{border-color:var(--dv-b);background:var(--dv-f);color:var(--dv)}" +
  ".mz-num{display:inline-block;min-width:28px;margin-right:6px;padding:1px 7px;border-radius:8px;background:var(--navy);color:#fff;font-size:.8rem;text-align:center}" +
  ".mz-altri{display:block;margin-top:4px;font-size:.78rem;color:var(--s)}" +
  ".mz-ancora{grid-column:1/-1;justify-self:center}" +
  "@media (max-width:640px){.mz-campi,.mz-prezzi{grid-template-columns:minmax(0,1fr)}.mz-togli{margin-left:0}}";

// «Carica da file»: lettura del file nel browser (librerie da cdnjs, come la Rubrica), riconoscimento delle colonne, anteprima.
// 16/11/2026 (mezzi-anagrafica-1): ogni foglio dell'Excel si legge per conto suo (intestazioni diverse); colonne dell'elenco
// di Brenta Lavori srl (categoria, numero aziendale, cespite, matricola, revisione, bollo…); fogli «venduti/demoliti» = non più
// in uso; doppioni tolti per targa, matricola o nome; salvataggio a blocchi con mezzi_importa.
const CARICA_JS = String.raw`
var IMP=[];
var LIB={xlsx:"https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",pdf:"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",pdfw:"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"};
function libreria(u){return new Promise(function(ok,ko){if(document.querySelector('script[data-lib="'+u+'"]'))return ok();var s=document.createElement('script');s.src=u;s.setAttribute('data-lib',u);
 s.onload=function(){ok();};s.onerror=function(){ko(new Error('non riesco a caricare il lettore del file: controlla la connessione'));};document.head.appendChild(s);});}
function pul(s){return String(s==null?'':s).replace(/\s+/g,' ').trim();}
function senzaAccenti(s){return pul(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');}
function normNome(s){return senzaAccenti(s).replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();}
function chiave(s){return senzaAccenti(s).replace(/[^a-z0-9]/g,'');}
function cStato(t){$('mz-c-stato').className='mz-msg';$('mz-c-stato').textContent=t;}
function cErr(t){var e=$('mz-c-err');e.textContent=t||'';e.hidden=!t;}
function titolo(s){s=pul(s).toLowerCase();return s?s.charAt(0).toUpperCase()+s.slice(1):'';}
// l'ordine conta: «numero cespite» prima di «numero», «data scadenza revisione» prima di «revisione»
var ALIAS=[['ditta',['ditta','impresa','azienda']],['scheda',['scheda','mezzo o attrezzatura']],['sottocategoria',['sottocategoria','sotto categoria']],
 ['categoria',['categoria','tipologia']],['cespite',['numero cespite','n. cespite','cespite']],['numero',['numero aziendale','nr. az','nr az','n. az','n az','numero','nr.','n.']],
 ['cartella',['cartella']],['documenti',['documenti']],['marca',['marca e modello','marca e tipo','marca']],['modello',['modello']],
 ['matricola',['matricola','nr. telaio','telaio','numero di serie','n. serie','seriale']],['targa',['targa']],['anno',['anno']],
 ['acquisto',['data acquisto','data di acquisto','acquisto']],['revdata',['data scadenza revisione','scadenza revisione']],['revvecchia',['scad. revisione','scad revisione']],
 ['emissione',['classe emissione','classe di emissione','emissione']],['possesso',['titolo di possesso','possesso','proprieta','di proprieta o a noleggio']],
 ['revisione',['revisione','verifica']],['frequenza',['frequenza revisione','frequenza']],['luogo',['luogo c.c.','luogo cc','luogo c c','luogo']],
 ['crono',['cronotachigrafo']],['bollo',['scadenza bollo','bollo']],['note',['note','annotazioni','osservazioni']],['descrizione',['descrizione']],
 ['telepass',['telepass','viacard']],['noleggiatore',['noleggiato da','noleggiatore']],['operatore',['operatore','con operatore','autista']],
 ['prezzo',['prezzo','costo orario','costo','tariffa','importo']],['unita',['unita','u.m.','um','unita di misura']],['nome',['nome','nome per riconoscerlo','denominazione']],['tipo',['tipo']]];
function campoDi(t){t=senzaAccenti(String(t).replace(/\(.*$/,'')).replace(/[:*€]/g,'').trim();if(!t||t.length>45)return '';
 for(var i=0;i<ALIAS.length;i++)for(var j=0;j<ALIAS[i][1].length;j++){var a=ALIAS[i][1][j];if(t===a||(a.length>3&&t.indexOf(a)===0))return ALIAS[i][0];}return '';}
var ATTR=/martell|flessibil|smerigl|trapan|idropul|generator|gruppo elettr|compressor|betonier|saldatric|piastra|costipat|vibrator|trabattell|motopomp|\bsega\b|clipper|tagliasfalt|taglia|carotatric|pulitric|levigatric|avvitator|demolitor|tassellator|miscelator|aspirator|ponteggio|benna|pinza|forca|attacco|accessor|vari|altro/;
var MEZZO=/escavat|camion|autocarr|autogru|\bgru\b|\bpala\b|terna|bobcat|minipala|rullo|sollevator|piattaform|furgon|autobetonier|dumper|muletto|carrello elev|trattor|ribaltabil|motrice|rimorch|bilico|autovettura|\bauto\b|finitric|fresa|spazzatric|macchina|moto/;
// categorie dell'elenco comune (database: mezzi_categorie)
function categoriaDi(t){var s=senzaAccenti(t);if(!s)return '';
 if(/autocarr.*(>|oltre)|oltre 35/.test(s))return 'Autocarri oltre 35 q.li';if(/autocarr|^auto$|autovett|furgon/.test(s))return 'Autocarri fino a 35 q.li';
 if(/rimorch/.test(s))return 'Semirimorchi e rimorchi';if(/^tern/.test(s))return 'Terne';if(/escavat/.test(s))return 'Escavatori';if(/^pal[ae]|minipala/.test(s))return 'Pale';
 if(/asfalt|fresa|finitric|\brull/.test(s))return 'Macchine asfalto';if(/special/.test(s))return 'Mezzi speciali';if(/solleva/.test(s))return 'Mezzi e attrezzature di sollevamento';
 if(/accessor/.test(s))return 'Accessori';if(/vari|altro/.test(s))return 'Attrezzature varie';return titolo(t);}
function schedaDi(c){var s=senzaAccenti(c.scheda);if(/attrezz/.test(s))return 'attrezzatura';if(/mezz|macchin|autom/.test(s))return 'mezzo';
 var cat=(D.categorie||[]).filter(function(x){return senzaAccenti(x.c)===senzaAccenti(c.cat);})[0];if(cat)return cat.s;
 var t=senzaAccenti(c.categoria+' '+c.sottocategoria+' '+c.tipo+' '+c.nome+' '+c.marca);if(MEZZO.test(t))return 'mezzo';if(ATTR.test(t))return 'attrezzatura';return 'mezzo';}
var MESI={gen:1,feb:2,mar:3,apr:4,mag:5,giu:6,lug:7,ago:8,set:9,ott:10,nov:11,dic:12};
// «28/06/2023», «1/3/24», «2023-06-28» → aaaa-mm-gg; «lug-25» o testi → resta da scrivere nella nota
function dataDi(s){s=pul(s);var m=s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/),a;
 if(m){a=+m[3];if(a<100)a+=a>60?1900:2000;var g=+m[1],me=+m[2];if(me>12&&g<=12){var x=g;g=me;me=x;}
  var d=new Date(a,me-1,g);if(d.getFullYear()===a&&d.getMonth()===me-1&&d.getDate()===g)return a+'-'+('0'+me).slice(-2)+'-'+('0'+g).slice(-2);}
 m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return m[0];return '';}
function annoDi(s){var m=pul(s).match(/\b(19[5-9]\d|20[0-4]\d)\b/);return m?m[1]:'';}
function prezzoDi(s){var t=pul(s).replace(/€|eur(o)?/gi,'').replace(/\s/g,'');if(!t)return '';
 var m=t.match(/^(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\/|al|all|a|per|x)?[a-z'\/ ]*$/i);if(m)t=m[1];
 if(/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t))t=t.replace(/\./g,'').replace(',','.');else t=t.replace(',','.');
 return /^\d{1,6}(\.\d{1,2})?$/.test(t)?t.replace('.',','):'?';}
// righe di un foglio → mezzi (con la riga d'intestazione, cercata nelle prime 8 righe)
function daTabella(righe,foglio){righe=righe.map(function(r){return (r||[]).map(pul);}).filter(function(r){return r.some(Boolean);});
 var mappa=null,inizio=0,vuote=[];
 for(var i=0;i<Math.min(righe.length,8)&&!mappa;i++){var m={},n=0;righe[i].forEach(function(c,j){var k=campoDi(c);if(k&&!(k in m)){m[k]=j;n++;}});
  if(n>=3&&('nome' in m||'marca' in m||'numero' in m||'targa' in m||'matricola' in m)){mappa=m;inizio=i+1;righe[i].forEach(function(c,j){if(!pul(c))vuote.push(j);});}}
 if(!mappa)return [];
 var vecchi=/vendut|demolit|cedut|dismess|rottam|eliminat/i.test(foglio||'');
 return righe.slice(inizio).map(function(r){var c={foglio:foglio||'',vecchio:vecchi};for(var k in mappa)c[k]=r[mappa[k]]||'';
  ['scheda','categoria','sottocategoria','numero','cespite','cartella','documenti','marca','modello','matricola','targa','anno','acquisto','revdata','revvecchia','emissione','possesso','revisione','frequenza','luogo','crono','bollo','note','descrizione','telepass','noleggiatore','operatore','prezzo','unita','nome','tipo'].forEach(function(k){if(c[k]==null)c[k]='';});
  c.extra=vuote.map(function(j){return r[j]||'';}).filter(Boolean).join(' · ');return c;}).filter(function(c){return c.marca||c.nome||c.matricola||c.targa||c.sottocategoria||c.descrizione;});}
function leggiCsv(testo){var r1=testo.split(/\r?\n/)[0]||'',sep=[';',',','\t'].sort(function(a,b){return r1.split(b).length-r1.split(a).length;})[0];
 var righe=[],riga=[],cella='',q=false;
 for(var i=0;i<testo.length;i++){var ch=testo[i];
  if(q){if(ch==='"'){if(testo[i+1]==='"'){cella+='"';i++;}else q=false;}else cella+=ch;}
  else if(ch==='"')q=true;else if(ch===sep){riga.push(cella);cella='';}else if(ch==='\n'){riga.push(cella.replace(/\r$/,''));righe.push(riga);riga=[];cella='';}else cella+=ch;}
 if(cella||riga.length){riga.push(cella);righe.push(riga);}return righe;}
function leggiFile(f){var nome=f.name.toLowerCase(),ext=nome.slice(nome.lastIndexOf('.')+1);
 if(ext==='csv'||ext==='txt')return f.text().then(function(t){return daTabella(leggiCsv(t),'');});
 if(ext==='xlsx'||ext==='xls'||ext==='ods')return Promise.all([libreria(LIB.xlsx),f.arrayBuffer()]).then(function(x){var wb=window.XLSX.read(x[1],{type:'array',cellDates:true}),tutti=[];
  // le date vere dell'Excel arrivano come date (non come testo, che SheetJS scrive alla americana: 7/8/19)
  function cella(v){if(v instanceof Date&&!isNaN(v)){var d=new Date(v.getTime()+12*3600e3);return ('0'+d.getDate()).slice(-2)+'/'+('0'+(d.getMonth()+1)).slice(-2)+'/'+d.getFullYear();}return v==null?'':String(v);}
  wb.SheetNames.forEach(function(n){var r=window.XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,raw:true,defval:''}).map(function(x){return (x||[]).map(cella);});tutti=tutti.concat(daTabella(r,n));});return tutti;});
 if(ext==='pdf')return Promise.reject(new Error('per i mezzi usa un file Excel o CSV: da PDF un elenco così lungo si legge male'));
 return Promise.reject(new Error('questo tipo di file non si può leggere: salvalo come Excel o CSV'));}
// da una riga letta ai dati per il database
function dati(c){var note=[],rn=[];
 var cat=categoriaDi(c.categoria),sotto=titolo(c.sottocategoria||c.tipo);c.cat=cat;
 var sch=c.sch||schedaDi(c);
 var poss=senzaAccenti(c.possesso),prop='proprieta';if(/leasing/.test(poss))prop='leasing';else if(/nolegg|\bnolo\b/.test(poss))prop='noleggio';
 else if(poss&&!/propriet/.test(poss))note.push(pul(c.possesso));
 var acq=dataDi(c.acquisto);if(!acq&&pul(c.acquisto))note.push('acquisto: '+pul(c.acquisto));
 var rev=dataDi(c.revdata);if(pul(c.revdata)&&(!rev||pul(c.revdata).replace(/^[\d\/.\-\s]+/,'')))rn.push(pul(c.revdata));
 if(pul(c.revvecchia))rn.push('verifica: '+pul(c.revvecchia));
 var bollo=dataDi(c.bollo);if(pul(c.bollo)&&!bollo)note.push('bollo: '+pul(c.bollo));
 var rv=senzaAccenti(c.revisione),revisione=/^si\b/.test(rv)?'si':/^no\b/.test(rv)?'no':'';if(rv&&!revisione)rn.push(pul(c.revisione));
 var fq=pul(c.frequenza).match(/^\d{1,2}$/)?pul(c.frequenza):'';if(pul(c.frequenza)&&!fq)rn.push('frequenza: '+pul(c.frequenza));
 var mm=pul((c.marca+' '+c.modello)).slice(0,160),num=pul(c.numero).slice(0,20);
 if(pul(c.note))note.unshift(pul(c.note));if(c.extra)note.push(c.extra);
 var nome=pul(c.nome)||((num?'N. '+num+' · ':'')+(mm||sotto||cat||'senza nome'));
 var motivo='';if(c.vecchio){var t=[c.note,c.descrizione,c.extra].map(pul).join(' · ');var m=t.match(/(vendut|rottamat|demolit|cedut|incidentat|dismess|permutat)[^·]*/i);motivo=(m?m[0]:'non più in uso').slice(0,200);}
 var pz=prezzoDi(c.prezzo),op=senzaAccenti(c.operatore),un=senzaAccenti(c.unita+' '+c.prezzo),tar=(/giorn|\bgg\b/.test(un)?'giorno':'ora')+'_'+(sch==='mezzo'&&!/^(no|n|senza|freddo)/.test(op)?'con':'senza');
 var d={scheda:sch,categoria:cat,sottocategoria:sotto,tipo:sotto,numero_aziendale:num,nome:nome.slice(0,80),marca_modello:mm,matricola:pul(c.matricola).slice(0,80),
  targa:pul(c.targa).slice(0,30),anno:annoDi(c.anno),data_acquisto:acq,cespite:pul(c.cespite).slice(0,40),classe_emissione:pul(c.emissione).slice(0,40),proprieta:prop,
  noleggiatore:prop==='noleggio'?pul(c.noleggiatore).slice(0,120):'',revisione:revisione,revisione_scadenza:rev,revisione_frequenza:fq,revisione_nota:rn.join(' · ').slice(0,300),
  luogo_cc:pul(c.luogo).slice(0,120),cronotachigrafo:pul(c.crono).slice(0,200),bollo_scadenza:bollo,descrizione:pul(c.descrizione).slice(0,300),telepass:pul(c.telepass).slice(0,120),
  cartella:pul(c.cartella).slice(0,60),documenti:pul(c.documenti).slice(0,60),note:note.join(' · ').slice(0,1000),stato:c.vecchio?'non_in_uso':'in_uso',stato_motivo:motivo,tariffa:tar,prezzi:{}};
 if(pz&&pz!=='?')d.prezzi[tar]=pz;return d;}
function controlla(){var gia={};(D.mezzi||[]).forEach(function(m){[m.targa,m.matricola].forEach(function(k){k=chiave(k);if(k.length>=5)gia['k'+k]=1;});gia['n'+normNome(m.nome)]=1;});
 var visti={};
 IMP.forEach(function(c){c.d=dati(c);c.stato='nuovo';c.perche='';var ks=[c.d.targa,c.d.matricola].map(chiave).filter(function(k){return k.length>=5;});
  if(ks.some(function(k){return gia['k'+k];})||gia['n'+normNome(c.d.nome)]){c.stato='doppio';c.perche='È già nel tuo elenco: non lo aggiungo.';return;}
  if(ks.some(function(k){return visti['k'+k];})){c.stato='doppio';c.perche='È già in un altro foglio o in un\'altra riga del file: lo aggiungo una volta sola.';return;}
  ks.forEach(function(k){visti['k'+k]=1;});
  var av=[];if(!c.d.marca_modello&&!pul(c.nome))av.push('senza marca e modello');if(c.d.prezzi&&!Object.keys(c.d.prezzi).length)av.push('prezzi da scrivere dopo');c.perche=av.join(' · ');});
 disegna();}
function disegna(){var nuovi=IMP.filter(function(c){return c.stato==='nuovo';}),dop=IMP.filter(function(c){return c.stato==='doppio';});
 var fogli=[];IMP.forEach(function(c){if(fogli.indexOf(c.foglio)<0)fogli.push(c.foglio);});
 var h='<div class="mz-ries"><span>'+nuovi.length+' da aggiungere</span>'+(dop.length?'<span>'+dop.length+' già presenti o doppi, tolti</span>':'')+
  (nuovi.filter(function(c){return c.d.stato==='non_in_uso';}).length?'<span>'+nuovi.filter(function(c){return c.d.stato==='non_in_uso';}).length+' non più in uso</span>':'')+'</div><div class="mz-l">';
 fogli.forEach(function(fg){var r=IMP.filter(function(c){return c.foglio===fg;}),nn=r.filter(function(c){return c.stato==='nuovo';}),sel=nn.filter(function(c){return c.scelto!==false;}).length;
  if(fg)h+='<label class="mz-r" style="background:#F5F7FA"><input type="checkbox" data-f="'+es(fg)+'"'+(sel?' checked':'')+(nn.length?'':' disabled')+'><span><b>Foglio «'+es(fg)+'»</b><small>'+r.length+' righe · '+nn.length+' nuove'+(r[0]&&r[0].vecchio?' · segnate come non più in uso':'')+'</small></span></label>';
  r.forEach(function(c){var i=IMP.indexOf(c),no=c.stato!=='nuovo',d=c.d;
   var det=[d.categoria,d.sottocategoria,d.marca_modello,d.targa?'targa '+d.targa:'',d.matricola?'matr. '+d.matricola:'',d.stato==='non_in_uso'?'non più in uso'+(d.stato_motivo?': '+d.stato_motivo:''):''].filter(Boolean).join(' · ');
   h+='<label class="mz-r'+(no?' no':'')+'"><input type="checkbox" data-i="'+i+'"'+(no?' disabled':(c.scelto===false?'':' checked'))+'><span><b>'+es(d.nome)+'</b><small>'+es(det)+'</small>'+
    (no?'':'<select data-s="'+i+'" aria-label="Scheda"><option value="mezzo"'+(d.scheda==='mezzo'?' selected':'')+'>Automezzi e macchine</option><option value="attrezzatura"'+(d.scheda==='attrezzatura'?' selected':'')+'>Attrezzature</option></select>')+
    (c.perche?'<small class="perche">'+es(c.perche)+'</small>':'')+'</span></label>';});});
 $('mz-c-ant').innerHTML=h+'</div>';var n=nuovi.filter(function(c){return c.scelto!==false;}).length;
 var ok=$('mz-c-ok');ok.hidden=!nuovi.length;ok.disabled=!n;ok.textContent='Aggiungi '+n+(n===1?' mezzo':' mezzi');}
$('mz-c-ant').addEventListener('change',function(e){var x=e.target;if(!x)return;
 if(x.hasAttribute('data-f')){var fg=x.getAttribute('data-f');IMP.forEach(function(c){if(c.foglio===fg&&c.stato==='nuovo')c.scelto=x.checked;});disegna();}
 else if(x.type==='checkbox'){IMP[+x.getAttribute('data-i')].scelto=x.checked;disegna();}
 else if(x.hasAttribute('data-s')){var c=IMP[+x.getAttribute('data-s')];c.sch=x.value;c.d=dati(c);disegna();}});
$('mz-carica').onclick=function(){IMP=[];$('mz-c-file').value='';$('mz-c-nome').textContent='Scegli il file';$('mz-c-ant').innerHTML='';$('mz-c-ok').hidden=true;cErr('');
 cStato('Il file si legge qui, sul tuo dispositivo.');$('mz-velo-c').hidden=false;};
$('mz-c-chiudi').onclick=function(){$('mz-velo-c').hidden=true;};
$('mz-velo-c').addEventListener('click',function(ev){if(ev.target===this)this.hidden=true;});
$('mz-modello').onclick=function(){var testo='﻿Numero aziendale;Categoria;Sottocategoria;Nome per riconoscerlo;Marca e modello;Matricola / telaio;Targa;Anno;Data acquisto;Numero cespite;Classe emissione;Titolo di possesso;Noleggiato da;Revisione;Data scadenza revisione;Frequenza revisione;Scadenza bollo;Cronotachigrafo;Luogo C.C.;Telepass;Prezzo €;Unità;Operatore;Descrizione;Note\r\n'+
 '5;Escavatori;Miniescavatore fino a 80 q.li;;Caterpillar 303E CR;CAT0303EKSGE01298;;2020;26/01/2022;9 22;EU Stage V;Proprietà;;Sì;23/04/2027;1;;;in ufficio;;55,00;ora;Con operatore;;\r\n'+
 '2;Autocarri fino a 35 q.li;Macchina;;Nissan Ariya;JN1TBAFE0U0308379;GV441HS;2024;25/06/2024;7 10;Elettrica;Leasing;;Sì;30/06/2028;2;30/04/2029;;nel mezzo;;;;;;\r\n'+
 '120;Attrezzature varie;Generatore;;Honda GX 270;208792;;;07/12/2018;3 71;;Proprietà;;No;;;;;;;25,00;giorno;Senza operatore;;\r\n';
 var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([testo],{type:'text/csv;charset=utf-8'}));a.download='TIX modello mezzi e attrezzature.csv';document.body.appendChild(a);a.click();
 setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},1000);};
$('mz-c-file').addEventListener('change',function(){var f=this.files&&this.files[0];if(!f)return;cErr('');$('mz-c-ok').hidden=true;$('mz-c-ant').innerHTML='';
 if(f.size>20*1024*1024){cErr('Il file è troppo grande (più di 20 MB).');return;}
 $('mz-c-nome').textContent=f.name;cStato('Leggo il file…');
 leggiFile(f).then(function(l){IMP=l.slice(0,2000);
  if(!IMP.length){cStato('');cErr('Nel file non ho trovato mezzi: serve una riga di intestazione con almeno tre colonne riconoscibili (per esempio Numero aziendale, Marca e modello, Targa). Puoi partire dal modello.');return;}
  cStato('Ho trovato '+IMP.length+(IMP.length===1?' riga':' righe')+' in «'+f.name+'». Controlla l\'elenco e tocca «Aggiungi».');controlla();})
 .catch(function(e){cStato('');cErr('Non sono riuscito a leggere il file: '+(e&&e.message?e.message:e)+'.');});});
$('mz-c-ok').onclick=function(){var da=IMP.filter(function(c){return c.stato==='nuovo'&&c.scelto!==false;}).map(function(c){return c.d;});if(!da.length)return;
 var ok=this,fatti=0,errori=[],i=0,BLOCCO=150;ok.disabled=true;cErr('');
 function prossimo(){if(i>=da.length)return Promise.resolve();var pezzo=da.slice(i,i+BLOCCO);i+=pezzo.length;cStato('Aggiungo '+Math.min(i,da.length)+' di '+da.length+'…');
  return chiama('importa',{}, {righe:pezzo}).then(function(r){if(r&&r.esito==='ok'){fatti+=r.aggiunti||0;(r.errori||[]).forEach(function(e){errori.push((e.nome||'riga')+' ('+e.messaggio+')');});}
   else errori.push('un blocco di '+pezzo.length+' righe non è stato salvato'+(r&&r.messaggio?' ('+r.messaggio+')':''));}).then(prossimo);}
 prossimo().then(function(){ok.disabled=false;ok.hidden=true;
  if(errori.length){cStato('Aggiunti '+fatti+(fatti===1?' mezzo':' mezzi')+'.');cErr('Non aggiunti: '+errori.slice(0,20).join('; ')+(errori.length>20?' e altri '+(errori.length-20):'')+'.');$('mz-c-chiudi').onclick=ricarica;}
  else ricarica();});};
`;

const SCRIPT = String.raw`(function(){try{
var C=__CFG__;if(!C.d)return;var D=C.d,S='mezzo',corr=null,MOSTRA=120;
var TAR={ora_con:"all'ora con operatore",ora_senza:"all'ora senza operatore",giorno_con:'a giornata con operatore',giorno_senza:'a giornata senza operatore'};
var TARB={ora_con:'€/ora con op.',ora_senza:'€/ora senza op.',giorno_con:'€/giorno con op.',giorno_senza:'€/giorno senza op.'};
var POSS={proprieta:'Di proprietà',leasing:'In leasing',noleggio:'A noleggio'};
var UN={ora:"all'ora",giorno:'al giorno',mezza_giornata:'a mezza giornata'};
function $(i){return document.getElementById(i);}
function es(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function euro(n){if(n==null||n==='')return '';var x=Number(n);return isFinite(x)?x.toFixed(2).replace('.',','):'';}
function data(iso){iso=String(iso||'');if(iso.slice(0,10)==='2000-01-01')return "dall'inizio";return /^\d{4}-\d{2}-\d{2}/.test(iso)?'dal '+iso.slice(8,10)+'/'+iso.slice(5,7)+'/'+iso.slice(0,4):'';}
function gma(iso){iso=String(iso||'');return /^\d{4}-\d{2}-\d{2}/.test(iso)?iso.slice(8,10)+'/'+iso.slice(5,7)+'/'+iso.slice(0,4):'';}
function chiama(az,dati,extra){var b={t:C.t,a:C.a,azione:az,dati:dati};if(extra)for(var k in extra)b[k]=extra[k];
 return fetch(C.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json();}).catch(function(){return{esito:'rete'};});}
function prezzoOk(v){v=String(v||'').replace(/€|\s/g,'');return !v||/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(v);}
function ricarica(){try{history.replaceState(null,'',location.pathname+location.search+'#'+S);}catch(e){}location.reload();}
function norm(s){return String(s==null?'':s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');}
// scadenze di revisione e bollo: scaduta (rosso) o entro 30 giorni (arancio)
var OGGI=String(D.oggi||'').slice(0,10);
function giorni(iso){if(!/^\d{4}-\d{2}-\d{2}/.test(String(iso||''))||!OGGI)return null;return Math.round((Date.parse(String(iso).slice(0,10))-Date.parse(OGGI))/864e5);}
function scadenze(x){var out=[];if(x.stato==='non_in_uso')return out;
 [['revisione_scadenza','Revisione','scaduta'],['bollo_scadenza','Bollo','scaduto']].forEach(function(k){var g=giorni(x[k[0]]);if(g==null)return;
  if(g<0)out.push({c:'s',t:k[1]+' '+k[2]+' il '+gma(x[k[0]])});else if(g<=30)out.push({c:'a',t:k[1]+' scade il '+gma(x[k[0]])});});return out;}
function categorieDi(sch){var v={},l=[];(D.categorie||[]).forEach(function(c){if(!sch||c.s===sch){v[norm(c.c)]=1;l.push(c.c);}});
 (D.mezzi||[]).forEach(function(x){if((!sch||x.scheda===sch)&&x.categoria&&!v[norm(x.categoria)]){v[norm(x.categoria)]=1;l.push(x.categoria);}});return l;}
function sottoDi(cat){var l=[],v={};(D.categorie||[]).forEach(function(c){if(norm(c.c)===norm(cat))(c.sotto||[]).forEach(function(s){if(!v[norm(s)]){v[norm(s)]=1;l.push(s);}});});
 (D.mezzi||[]).forEach(function(x){if(x.sottocategoria&&(!cat||norm(x.categoria)===norm(cat))&&!v[norm(x.sottocategoria)]){v[norm(x.sottocategoria)]=1;l.push(x.sottocategoria);}});return l;}
function opzioniCat(){var s=$('mz-cat'),prima=s.value;s.innerHTML='<option value="">Tutte le categorie</option>'+categorieDi(S).map(function(c){return '<option value="'+es(c)+'">'+es(c)+'</option>';}).join('');s.value=prima;if(s.value!==prima)s.value='';}
function carte(){var g=$('mz-griglia'),q=norm($('mz-cerca').value).trim(),cat=$('mz-cat').value,vec=$('mz-vecchi').checked,tutti=D.mezzi||[];
 ['mezzo','attrezzatura'].forEach(function(k){$('mz-n-'+k).textContent=tutti.filter(function(x){return x.scheda===k&&x.stato!=='non_in_uso';}).length;});
 var nv=tutti.filter(function(x){return x.scheda===S&&x.stato==='non_in_uso';}).length;$('mz-n-vecchi').textContent=nv?'('+nv+')':'';
 var sc=tutti.filter(function(x){return scadenze(x).some(function(s){return s.c==='s';});}).length,ia=tutti.filter(function(x){var s=scadenze(x);return s.length&&!s.some(function(y){return y.c==='s';});}).length;
 $('mz-scad').hidden=!(sc||ia);$('mz-scad').textContent=(sc?sc+(sc===1?' mezzo ha':' mezzi hanno')+' la revisione o il bollo scaduti':'')+(sc&&ia?'; ':'')+(ia?ia+(ia===1?' scade':' scadono')+' entro 30 giorni':'')+'. Li trovi segnati in rosso e in arancio.';
 var m=tutti.filter(function(x){if(x.scheda!==S)return false;if(!vec&&x.stato==='non_in_uso')return false;if(cat&&norm(x.categoria)!==norm(cat))return false;
  if(q){var t=norm([x.numero_aziendale,x.nome,x.marca_modello,x.targa,x.matricola,x.categoria,x.sottocategoria,x.cespite,x.descrizione,x.note].join(' '));if(t.indexOf(q)<0)return false;}return true;});
 var vis=m.slice(0,MOSTRA);
 g.innerHTML=vis.map(function(x){var desc=[x.categoria,x.sottocategoria].filter(Boolean).join(' · '),id=[x.marca_modello,x.targa?'targa '+x.targa:'',x.matricola?'matr. '+x.matricola:'',x.anno?String(x.anno):''].filter(Boolean).join(' · ');
  var pz=x.prezzi||{},altri=['ora_con','ora_senza','giorno_con','giorno_senza'].filter(function(k){return k!==x.tariffa&&pz[k]!=null;}).map(function(k){return euro(pz[k])+' '+TARB[k];}).join(' · ');
  return '<div class="mz-m'+(x.stato==='non_in_uso'?' vecchio':'')+'"><h3>'+(x.numero_aziendale?'<span class="mz-num">'+es(x.numero_aziendale)+'</span>':'')+es(x.nome)+'</h3>'+
  '<p class="mz-tipo">'+es(desc||' ')+(id?'<br>'+es(id):'')+(x.proprieta==='noleggio'&&x.noleggiatore?'<br>noleggiato da '+es(x.noleggiatore):'')+'</p>'+
  (x.stato==='non_in_uso'?'<span class="mz-tag v">Non più in uso'+(x.stato_motivo?': '+es(x.stato_motivo):'')+'</span>':'<span class="mz-tag '+(x.proprieta==='noleggio'?'n':'p')+'">'+es(POSS[x.proprieta]||'Di proprietà')+'</span>')+
  scadenze(x).map(function(s){return '<span class="mz-tag '+s.c+'">'+es(s.t)+'</span>';}).join('')+
  (x.prezzo!=null?'<div class="mz-prezzo"><b>'+euro(x.prezzo)+' €</b><span>'+es(TAR[x.tariffa]||'')+' + IVA</span></div>':'<div class="mz-prezzo manca"><b>Prezzo da scrivere</b><span>'+es(TAR[x.tariffa]||'')+'</span></div>')+
  (altri?'<small class="mz-altri">Anche: '+es(altri)+'</small>':'')+
  '<button type="button" class="mz-b sm" data-id="'+es(x.id)+'" style="margin-top:8px">Apri la scheda</button></div>';}).join('')+
  (m.length>MOSTRA?'<button type="button" class="mz-b mz-ancora" id="mz-ancora">Mostra altri '+(m.length-MOSTRA)+'</button>':'')+
  '<button type="button" class="mz-agg" id="mz-agg2">+ Aggiungi '+(S==='mezzo'?'un automezzo o una macchina':"un'attrezzatura")+'</button>'+
  (m.length?'':'<p class="mz-vuoto">'+(q||cat?'Nessun risultato con questi filtri.':(S==='mezzo'?'Nessun automezzo ancora: aggiungi camion, escavatori, mini-escavatori, autogru… oppure caricali da file.':'Nessuna attrezzatura ancora: aggiungi martello demolitore, flessibile, idropulitrice, generatore… oppure caricale da file.'))+'</p>');
 Array.prototype.forEach.call(g.querySelectorAll('[data-id]'),function(b){b.onclick=function(){apri((D.mezzi||[]).filter(function(x){return x.id===b.getAttribute('data-id');})[0]);};});
 if($('mz-ancora'))$('mz-ancora').onclick=function(){MOSTRA+=200;carte();};
 $('mz-agg2').onclick=function(){apri(null);};}
function qual(){var q=$('mz-qual');q.innerHTML=(D.manodopera||[]).map(function(x){var st=(x.storico||[]);
  return '<div class="mz-q"><span>'+es(x.etichetta)+'</span><div class="r"><input data-q="'+es(x.qualifica)+'" inputmode="decimal" maxlength="12" value="'+es(euro(x.prezzo))+'" placeholder="es. 32,00" aria-label="Prezzo orario '+es(x.etichetta)+'"><b>€/ora</b></div>'+
  '<small>'+(x.prezzo!=null?es(data(x.prezzo_dal))+(st[0]&&st[0].autore?' · '+es(st[0].autore):''):'Prezzo da scrivere')+'</small></div>';}).join('')+
  '<div class="mz-q" style="display:flex;align-items:flex-end"><button type="button" class="mz-b mz-pr" id="mz-salva-q">Salva i prezzi della manodopera</button></div>';
 $('mz-salva-q').onclick=function(){var b=this,ins=q.querySelectorAll('input[data-q]'),i=0,errori=[];
  if(!crControlla(Array.prototype.map.call(ins,function(x){return {el:x,ok:function(){return prezzoOk(x.value);},testo:'Scrivi il prezzo all\'ora in euro, per esempio 32,00.'};}))){$('mz-msg-q').className='mz-msg ko';$('mz-msg-q').textContent='Correggi i prezzi segnati in rosso.';return;}
  b.disabled=true;$('mz-msg-q').className='mz-msg';$('mz-msg-q').textContent='Salvo…';
  (function prossimo(){if(i>=ins.length){b.disabled=false;if(errori.length){$('mz-msg-q').className='mz-msg ko';$('mz-msg-q').textContent=errori.join(' ');}else ricarica();return;}
   var el=ins[i++],v=el.value.trim(),k=el.getAttribute('data-q'),prima=(D.manodopera||[]).filter(function(x){return x.qualifica===k;})[0];
   if(!v||(prima&&euro(prima.prezzo)===euro(v.replace(',','.')))){prossimo();return;}
   chiama('prezzo',{voce:'qualifica',qualifica:k,prezzo:v}).then(function(r){if(!r||r.esito!=='ok'){errori.push((prima?prima.etichetta+': ':'')+(r&&r.messaggio||'non salvato, riprova.'));crSegna(el,r&&r.messaggio||'Non salvato: riprova.');}prossimo();});})();};}
function scelta(campo,v){var w=document.querySelector('.mz-scelta[data-campo="'+campo+'"]');Array.prototype.forEach.call(w.querySelectorAll('button'),function(b){b.classList.toggle('on',b.getAttribute('data-v')===String(v==null?'':v));});}
function valore(campo){var b=document.querySelector('.mz-scelta[data-campo="'+campo+'"] button.on');return b?b.getAttribute('data-v'):'';}
function aggiorna(){var sch=valore('scheda'),att=sch==='attrezzatura';
 Array.prototype.forEach.call(document.querySelectorAll('#mz-velo .c-con'),function(e){e.hidden=att;});
 if(att&&/_con$/.test(valore('tariffa')))scelta('tariffa',valore('tariffa').replace('_con','_senza'));
 $('c-nol').hidden=valore('proprieta')!=='noleggio';$('c-motivo').hidden=valore('stato')!=='non_in_uso';
 $('mz-avv-op').hidden=!/_con$/.test(valore('tariffa'));
 $('mz-cats').innerHTML=categorieDi(sch).map(function(t){return '<option value="'+es(t)+'">';}).join('');
 $('mz-sotto').innerHTML=sottoDi($('f-cat').value).map(function(t){return '<option value="'+es(t)+'">';}).join('');}
Array.prototype.forEach.call(document.querySelectorAll('.mz-scelta'),function(w){w.addEventListener('click',function(ev){var b=ev.target.closest('button');if(!b)return;
 var c=w.getAttribute('data-campo');scelta(c,b.getAttribute('data-v'));if(c==='scheda'&&!corr)scelta('tariffa',b.getAttribute('data-v')==='mezzo'?'ora_con':'giorno_senza');aggiorna();});});
$('f-cat').addEventListener('input',aggiorna);
var CAMPI={'f-cat':'categoria','f-sotto':'sottocategoria','f-num':'numero_aziendale','f-nome':'nome','f-mm':'marca_modello','f-matr':'matricola','f-targa':'targa','f-anno':'anno',
 'f-descr':'descrizione','f-nol':'noleggiatore','f-acq':'data_acquisto','f-cesp':'cespite','f-emiss':'classe_emissione','f-rev':'revisione_scadenza','f-freq':'revisione_frequenza',
 'f-revn':'revisione_nota','f-bollo':'bollo_scadenza','f-crono':'cronotachigrafo','f-cc':'luogo_cc','f-tel':'telepass','f-cart':'cartella','f-doc':'documenti','f-note':'note','f-motivo':'stato_motivo'};
function apri(x){corr=x||null;$('mz-mod-t').textContent=x?'Scheda: '+x.nome:(S==='mezzo'?'Nuovo automezzo o macchina':'Nuova attrezzatura');
 scelta('scheda',x?x.scheda:S);scelta('proprieta',x?x.proprieta:'proprieta');scelta('tariffa',x?x.tariffa:(S==='mezzo'?'ora_con':'giorno_senza'));
 scelta('revisione',x?(x.revisione||''):'');scelta('stato',x?(x.stato||'in_uso'):'in_uso');
 for(var id in CAMPI){var v=x?x[CAMPI[id]]:'';$(id).value=v==null?'':String(v);}
 ['ora_con','ora_senza','giorno_con','giorno_senza'].forEach(function(k){var p=x&&x.prezzi?x.prezzi[k]:null;$('p-'+k).value=p!=null?euro(p):'';});
 $('mz-msg').textContent='';$('mz-msg').className='mz-msg';$('mz-togli').hidden=!x;
 var st=x&&x.storico||[];$('mz-storico').hidden=!st.length;$('mz-storico').innerHTML=st.length?'<b>Storico dei prezzi</b><ul>'+st.map(function(s){return '<li><b>'+euro(s.prezzo)+' € '+es(TAR[s.tariffa]||'')+'</b> '+es(data(s.valido_dal))+' · scritto il '+es(s.il)+(s.autore?' da '+es(s.autore):'')+'</li>';}).join('')+'</ul><p>Se cambi un prezzo, quello nuovo vale da oggi; i giorni passati restano con il prezzo di prima.</p>':'';
 crPulisci($('mz-velo'));aggiorna();$('mz-velo').hidden=false;$('f-nome').focus();}
function chiudi(){$('mz-velo').hidden=true;}
$('mz-annulla').onclick=chiudi;$('mz-velo').addEventListener('click',function(ev){if(ev.target===this)chiudi();});document.addEventListener('keydown',function(ev){if(ev.key==='Escape')chiudi();});
$('mz-salva').onclick=function(){var b=this,dati={id:corr?corr.id:'',scheda:valore('scheda'),proprieta:valore('proprieta'),tariffa:valore('tariffa'),revisione:valore('revisione'),stato:valore('stato'),prezzi:{}};
 for(var id in CAMPI)dati[CAMPI[id]]=$(id).value.trim();dati.tipo=dati.sottocategoria;
 ['ora_con','ora_senza','giorno_con','giorno_senza'].forEach(function(k){if(!$('p-'+k).closest('[hidden]'))dati.prezzi[k]=$('p-'+k).value.trim();});
 var regole=[{el:$('f-nome'),testo:'Scrivi il nome per riconoscerlo (es. N. 5 · Escavatore Kubota 8 t).'},
  {el:$('f-anno'),ok:function(){return !$('f-anno').value.trim()||/^(19|20)\d\d$/.test($('f-anno').value.trim());},testo:'Scrivi l\'anno con 4 cifre, per esempio 2019.'},
  {el:$('f-freq'),ok:function(){return !$('f-freq').value.trim()||/^\d{1,2}$/.test($('f-freq').value.trim());},testo:'Scrivi ogni quanti anni, per esempio 1.'}];
 ['ora_con','ora_senza','giorno_con','giorno_senza'].forEach(function(k){regole.push({el:$('p-'+k),ok:function(){return prezzoOk($('p-'+k).value);},testo:'Scrivi il prezzo in euro, per esempio 75,00.'});});
 if(!crControlla(regole)){$('mz-msg').className='mz-msg ko';$('mz-msg').textContent='Completa i campi segnati in rosso.';return;}
 b.disabled=true;$('mz-msg').className='mz-msg';$('mz-msg').textContent='Salvo…';
 chiama('salva',dati).then(function(r){b.disabled=false;if(r&&r.esito==='ok'){ricarica();return;}$('mz-msg').className='mz-msg ko';$('mz-msg').textContent=r&&r.messaggio?r.messaggio:'Non è stato possibile salvare. Riprova tra qualche minuto.';
  var mp={};for(var id in CAMPI)mp[CAMPI[id]]=$(id);['ora_con','ora_senza','giorno_con','giorno_senza'].forEach(function(k){mp['prezzo_'+k]=$('p-'+k);});
  if(r&&r.campo&&mp[r.campo])crSegna(mp[r.campo],r.messaggio||'Da correggere');});};
$('mz-togli').onclick=function(){if(!corr)return;var b=this;if(b.getAttribute('data-ok')!=='1'){b.setAttribute('data-ok','1');b.textContent='Confermi? Premi ancora';return;}
 b.disabled=true;chiama('elimina',{id:corr.id}).then(function(r){b.disabled=false;b.removeAttribute('data-ok');b.textContent="Togli dall'elenco";if(r&&r.esito==='ok'){ricarica();return;}$('mz-msg').className='mz-msg ko';$('mz-msg').textContent='Non è stato possibile toglierlo. Riprova.';});};
Array.prototype.forEach.call(document.querySelectorAll('.mz-tabs button'),function(b){b.onclick=function(){S=b.getAttribute('data-s');MOSTRA=120;Array.prototype.forEach.call(document.querySelectorAll('.mz-tabs button'),function(x){x.classList.toggle('on',x===b);});opzioniCat();carte();};});
$('mz-cerca').addEventListener('input',function(){MOSTRA=120;carte();});$('mz-cat').addEventListener('change',function(){MOSTRA=120;carte();});$('mz-vecchi').addEventListener('change',carte);
var n=$('mz-nuovo');if(n)n.onclick=function(){apri(null);};
// dopo un salvataggio si torna sulla stessa scheda
if(location.hash==='#attrezzatura'){S='attrezzatura';Array.prototype.forEach.call(document.querySelectorAll('.mz-tabs button'),function(x){x.classList.toggle('on',x.getAttribute('data-s')===S);});}
__CARICA__
opzioniCat();carte();qual();
}catch(e){}})();`;
