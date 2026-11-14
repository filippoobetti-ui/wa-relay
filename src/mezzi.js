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
function pulisci(d) {
  const x = d && typeof d === "object" ? d : {};
  return {
    id: testo(x.id, 36), scheda: testo(x.scheda, 20), tipo: testo(x.tipo, 60), nome: testo(x.nome, 80),
    marca_modello: testo(x.marca_modello, 80), targa: testo(x.targa, 30), proprieta: testo(x.proprieta, 20),
    noleggiatore: testo(x.noleggiatore, 120), con_operatore: x.con_operatore === true || x.con_operatore === "true" ? "true" : "false",
    unita: testo(x.unita, 20), note: testo(x.note, 300), prezzo: testo(x.prezzo, 20), valido_dal: testo(x.valido_dal, 10),
    voce: testo(x.voce, 20), qualifica: testo(x.qualifica, 20), mezzo_id: testo(x.mezzo_id, 36)
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

const MODULO =
  '<div class="mz-velo" id="mz-velo" hidden><div class="mz-mod" role="dialog" aria-modal="true" aria-labelledby="mz-mod-t">' +
  '<h2 id="mz-mod-t">Nuovo mezzo</h2>' +
  '<div class="mz-campi">' +
  '<div class="mz-c tutta"><span class="mz-et">Scheda</span><div class="mz-scelta" data-campo="scheda"><button type="button" data-v="mezzo">Automezzi e macchine</button><button type="button" data-v="attrezzatura">Attrezzature</button></div></div>' +
  '<label class="mz-c"><span class="mz-et">Tipo <small>dall\'elenco, o scrivine uno nuovo</small></span><input id="f-tipo" list="mz-tipi" maxlength="60" autocomplete="off"><datalist id="mz-tipi"></datalist></label>' +
  '<label class="mz-c"><span class="mz-et">Nome per riconoscerlo <small>è quello che vedi nel registro delle economie</small></span><input id="f-nome" maxlength="80" placeholder="es. Escavatore Kubota 8 t"></label>' +
  '<label class="mz-c"><span class="mz-et">Marca e modello <small>facoltativo</small></span><input id="f-mm" maxlength="80"></label>' +
  '<label class="mz-c"><span class="mz-et">Targa o matricola <small>facoltativo</small></span><input id="f-targa" maxlength="30"></label>' +
  '<div class="mz-c"><span class="mz-et">Di proprietà o a noleggio</span><div class="mz-scelta" data-campo="proprieta"><button type="button" data-v="proprieta">Di proprietà</button><button type="button" data-v="noleggio">A noleggio</button></div></div>' +
  '<label class="mz-c" id="c-nol"><span class="mz-et">Noleggiato da</span><input id="f-nol" maxlength="120"></label>' +
  '<div class="mz-c" id="c-op"><span class="mz-et">Operatore</span><div class="mz-scelta" data-campo="con_operatore"><button type="button" data-v="true">Con operatore</button><button type="button" data-v="false">Senza operatore</button></div></div>' +
  '<label class="mz-c"><span class="mz-et">Prezzo in economia + IVA</span><span class="mz-euro"><input id="f-prezzo" inputmode="decimal" maxlength="12" placeholder="es. 55,00"><b>€</b></span></label>' +
  '<div class="mz-c"><span class="mz-et">Unità</span><div class="mz-scelta" data-campo="unita"><button type="button" data-v="ora">all\'ora</button><button type="button" data-v="giorno">al giorno</button><button type="button" data-v="mezza_giornata">a mezza giornata</button></div></div>' +
  '<label class="mz-c tutta"><span class="mz-et">Note <small>facoltativo</small></span><input id="f-note" maxlength="300"></label>' +
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
  '<p class="mz-spiega">Carica l\'elenco dei tuoi mezzi e delle attrezzature: Excel (.xlsx, .xls), CSV oppure PDF, una riga per mezzo. ' +
  'TIX legge nome, tipo, targa o matricola, proprietà o noleggio, operatore, prezzo e unità e prepara l\'elenco da controllare. ' +
  'Quelli che hai già in elenco vengono tolti da soli. Il file resta sul tuo dispositivo: a TIX arrivano solo i mezzi che aggiungi.</p>' +
  '<p class="mz-spiega"><button type="button" class="mz-link" id="mz-modello">Scarica il modello Excel</button> se vuoi partire da un foglio già pronto.</p>' +
  '<label class="mz-file" for="mz-c-file"><input type="file" id="mz-c-file" accept=".xlsx,.xls,.ods,.csv,.txt,.pdf">&#128196;&nbsp;<span id="mz-c-nome">Scegli il file</span></label>' +
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
  "@media (max-width:640px){.mz-campi{grid-template-columns:minmax(0,1fr)}.mz-togli{margin-left:0}}";

// «Carica da file»: lettura del file nel browser (librerie da cdnjs, come la Rubrica), riconoscimento delle colonne, anteprima
const CARICA_JS = String.raw`
var IMP=[];
var LIB={xlsx:"https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",pdf:"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",pdfw:"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"};
function libreria(u){return new Promise(function(ok,ko){if(document.querySelector('script[data-lib="'+u+'"]'))return ok();var s=document.createElement('script');s.src=u;s.setAttribute('data-lib',u);
 s.onload=function(){ok();};s.onerror=function(){ko(new Error('non riesco a caricare il lettore del file: controlla la connessione'));};document.head.appendChild(s);});}
function pul(s){return String(s==null?'':s).replace(/\s+/g,' ').trim();}
function senzaAccenti(s){return pul(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');}
function normNome(s){return senzaAccenti(s).replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();}
function cStato(t){$('mz-c-stato').className='mz-msg';$('mz-c-stato').textContent=t;}
function cErr(t){var e=$('mz-c-err');e.textContent=t||'';e.hidden=!t;}
var ALIAS={scheda:['scheda','mezzo o attrezzatura','classe'],tipo:['tipo','tipologia','categoria','genere'],
 nome:['nome','nome per riconoscerlo','descrizione','denominazione','mezzo','macchina','attrezzatura','articolo','bene','cespite'],
 marca:['marca e modello','marca'],modello:['modello'],targa:['targa','matricola','targa o matricola','telaio','numero di serie','n. serie','seriale','n serie'],
 proprieta:['proprieta','possesso','di proprieta o a noleggio','proprieta o noleggio','noleggio','a noleggio','nolo'],noleggiatore:['noleggiato da','noleggiatore','fornitore'],
 operatore:['operatore','con operatore','autista','con autista'],prezzo:['prezzo','costo','tariffa','prezzo orario','prezzo giornaliero','costo orario','euro','importo'],
 unita:['unita','u.m.','um','unita di misura','per'],note:['note','annotazioni','osservazioni']};
function campoDi(t){t=senzaAccenti(t).replace(/[:*()€]/g,'').trim();if(!t||t.length>40)return '';
 for(var k in ALIAS)for(var i=0;i<ALIAS[k].length;i++){var a=ALIAS[k][i];if(t===a||(a.length>3&&t.indexOf(a)===0))return k;}return '';}
var ATTR=/martell|flessibil|smerigl|trapan|idropul|generator|gruppo elettr|compressor|betonier|saldatric|piastra|costipat|vibrator|trabattell|motopomp|\bsega\b|clipper|tagliasfalt|taglia giunt|carotatric|pulitric|levigatric|avvitator|demolitor|tassellator|miscelator|aspirator|ponteggio/;
var MEZZO=/escavat|camion|autocarr|autogru|\bgru\b|\bpala\b|terna|bobcat|minipala|rullo|sollevator|piattaform|furgon|autobetonier|pompa|dumper|muletto|carrello elev|trattor|ribaltabil|motrice|semirimorch|bilico|autovettura|\bauto\b/;
function schedaDi(c){var s=senzaAccenti(c.scheda);if(/attrezz/.test(s))return 'attrezzatura';if(/mezz|macchin|autom/.test(s))return 'mezzo';
 var t=senzaAccenti(c.tipo+' '+c.nome);if(ATTR.test(t))return 'attrezzatura';if(MEZZO.test(t))return 'mezzo';
 var u=senzaAccenti(c.unita+' '+c.intest_prezzo);if(/giorn|gg/.test(u))return 'attrezzatura';return 'mezzo';}
function unitaDi(c,sch){var u=senzaAccenti(c.unita+' '+c.intest_prezzo+' '+String(c.prezzo).replace(/[\d.,€\s]+/g,' '));if(/mezza/.test(u))return 'mezza_giornata';if(/giorn|\bgg\b|\bg\b|\bday\b/.test(u))return 'giorno';if(/\bor[ae]\b|\bh\b|orari/.test(u))return 'ora';return sch==='mezzo'?'ora':'giorno';}
function operatoreDi(c,sch){if(sch!=='mezzo')return false;var o=senzaAccenti(c.operatore);if(!o)return true;if(/^(no|n|senza|freddo|a freddo|false|0)$/.test(o)||/senza|freddo/.test(o))return false;return true;}
function prezzoDi(s){var t=pul(s).replace(/€|eur(o)?/gi,'').replace(/\s/g,'');if(!t)return '';
 // «35 €/giorno», «60 all'ora»: si tiene il numero (l'unità la legge unitaDi)
 var m=t.match(/^(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\/|al|all|a|per|x)?[a-z'\/ ]*$/i);if(m)t=m[1];
 if(/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t))t=t.replace(/\./g,'').replace(',','.');else t=t.replace(',','.');
 return /^\d{1,6}(\.\d{1,2})?$/.test(t)?t.replace('.',','):'?';}
// righe (array di celle) → mezzi, con la riga d'intestazione oppure senza (testo libero)
function daTabella(righe){righe=righe.map(function(r){return (r||[]).map(pul);}).filter(function(r){return r.some(Boolean);});
 var mappa=null,inizio=0,intPrezzo='';
 for(var i=0;i<Math.min(righe.length,8)&&!mappa;i++){var m={},n=0;righe[i].forEach(function(c,j){var k=campoDi(c);if(k&&!(k in m)){m[k]=j;n++;if(k==='prezzo')intPrezzo=c;}});
  if(n>=2&&('nome' in m||'tipo' in m)){mappa=m;inizio=i+1;}}
 return righe.slice(inizio).map(function(r){var c={scheda:'',tipo:'',nome:'',marca:'',modello:'',targa:'',proprieta:'',noleggiatore:'',operatore:'',prezzo:'',unita:'',note:'',intest_prezzo:intPrezzo};
  if(mappa){for(var k in mappa)c[k]=r[mappa[k]]||'';if(!c.nome)c.nome=c.tipo;}else daTesto(r.join(' | '),c);return c;});}
var RE_EURO=/(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:€|eur)|€\s*(\d+(?:[.,]\d{1,2})?)/i,RE_TARGA=/\b[A-Z]{2}\s?\d{3}\s?[A-Z]{2}\b/;
function daTesto(t,c){var s=' '+t+' ',m;
 if((m=s.match(RE_EURO))){c.prezzo=m[1]||m[2];s=s.replace(m[0],' ');var dopo=t.slice(t.indexOf(m[0])+m[0].length,t.indexOf(m[0])+m[0].length+20);c.unita=/giorn|gg/i.test(dopo)?'giorno':/or[ae]|\/h/i.test(dopo)?'ora':'';}
 if((m=s.match(RE_TARGA))){c.targa=m[0];s=s.replace(m[0],' ');}
 if(/nolegg/i.test(s))c.proprieta='noleggio';if(/senza operatore|a freddo/i.test(s))c.operatore='no';
 var parti=s.split(/\s*(?:\||;|\t|\s[-–—]\s)\s*/).map(pul).filter(function(x){return /[A-Za-zÀ-ÿ]{2}/.test(x);});c.nome=(parti[0]||'');return c;}
function leggiCsv(testo){var r1=testo.split(/\r?\n/)[0]||'',sep=[';',',','\t'].sort(function(a,b){return r1.split(b).length-r1.split(a).length;})[0];
 var righe=[],riga=[],cella='',q=false;
 for(var i=0;i<testo.length;i++){var ch=testo[i];
  if(q){if(ch==='"'){if(testo[i+1]==='"'){cella+='"';i++;}else q=false;}else cella+=ch;}
  else if(ch==='"')q=true;else if(ch===sep){riga.push(cella);cella='';}else if(ch==='\n'){riga.push(cella.replace(/\r$/,''));righe.push(riga);riga=[];cella='';}else cella+=ch;}
 if(cella||riga.length){riga.push(cella);righe.push(riga);}return righe;}
function leggiPdf(buf){return libreria(LIB.pdf).then(function(){var lib=window.pdfjsLib;lib.GlobalWorkerOptions.workerSrc=LIB.pdfw;return lib.getDocument({data:buf}).promise;}).then(function(doc){
 var pagine=[];for(var p=1;p<=Math.min(doc.numPages,50);p++)pagine.push(p);
 return pagine.reduce(function(pr,n){return pr.then(function(righe){return doc.getPage(n).then(function(pg){return pg.getTextContent();}).then(function(tc){
  var linee={};tc.items.forEach(function(it){if(!pul(it.str))return;var y=Math.round(it.transform[5]/3);(linee[y]=linee[y]||[]).push(it);});
  Object.keys(linee).map(Number).sort(function(a,b){return b-a;}).forEach(function(y){var it=linee[y].sort(function(a,b){return a.transform[4]-b.transform[4];}),celle=[],cur='',fine=null;
   it.forEach(function(x){var x0=x.transform[4];if(fine!==null&&x0-fine>12){celle.push(cur);cur='';}cur+=(cur&&fine!==null&&x0-fine>1.5?' ':'')+x.str;fine=x0+(x.width||0);});celle.push(cur);righe.push(celle);});
  return righe;});});},Promise.resolve([]));});}
function leggiFile(f){var nome=f.name.toLowerCase(),ext=nome.slice(nome.lastIndexOf('.')+1);
 if(ext==='csv'||ext==='txt')return f.text().then(function(t){return daTabella(leggiCsv(t));});
 if(ext==='pdf')return f.arrayBuffer().then(leggiPdf).then(daTabella);
 if(ext==='xlsx'||ext==='xls'||ext==='ods')return Promise.all([libreria(LIB.xlsx),f.arrayBuffer()]).then(function(x){var wb=window.XLSX.read(x[1],{type:'array'}),righe=[];
  wb.SheetNames.forEach(function(n){righe=righe.concat(window.XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,raw:false,defval:''}));});return daTabella(righe);});
 return Promise.reject(new Error('questo tipo di file non si può leggere: salvalo come Excel, CSV o PDF'));}
function controlla(){var gia={},visti={};(D.mezzi||[]).forEach(function(m){gia[normNome(m.nome)]=m;});
 IMP.forEach(function(c){c.nome=pul(c.nome).slice(0,80);c.sch=c.sch||schedaDi(c);c.un=unitaDi(c,c.sch);c.op=operatoreDi(c,c.sch);c.pz=prezzoDi(c.prezzo);c.stato='nuovo';c.perche='';
  var nn=normNome(c.nome);
  if(c.nome.length<2){c.stato='salta';c.perche='Manca il nome: lo salto.';return;}
  if(gia[nn]){c.stato='doppio';c.perche='È già nel tuo elenco: non lo aggiungo.';return;}
  if(visti[nn]){c.stato='doppio';c.perche='È ripetuto nel file: lo aggiungo una volta sola.';return;}visti[nn]=1;
  if(c.pz==='?')c.perche='Prezzo non riconosciuto («'+pul(c.prezzo)+'»): lo salvo senza prezzo.';else if(!c.pz)c.perche='Senza prezzo: lo scrivi dopo.';});
 disegna();}
function disegna(){var nuovi=IMP.filter(function(c){return c.stato==='nuovo';}),dop=IMP.filter(function(c){return c.stato==='doppio';}),sal=IMP.filter(function(c){return c.stato==='salta';});
 var h='<div class="mz-ries"><span>'+nuovi.length+' da aggiungere</span>'+(dop.length?'<span>'+dop.length+' già presenti o doppi, tolti</span>':'')+(sal.length?'<span>'+sal.length+' senza nome, saltati</span>':'')+'</div><div class="mz-l">';
 IMP.forEach(function(c,i){var no=c.stato!=='nuovo';
  var det=[c.tipo,pul((c.marca+' '+c.modello)),c.targa,senzaAccenti(c.proprieta)==='noleggio'||/nolegg/.test(senzaAccenti(c.proprieta))?'a noleggio'+(c.noleggiatore?' da '+c.noleggiatore:''):'',
   c.sch==='mezzo'?(c.op?'con operatore':'senza operatore'):'',c.pz&&c.pz!=='?'?euro(c.pz.replace(',','.'))+' € '+UN[c.un]:''].filter(Boolean).join(' · ');
  h+='<label class="mz-r'+(no?' no':'')+'"><input type="checkbox" data-i="'+i+'"'+(no?' disabled':(c.scelto===false?'':' checked'))+'><span><b>'+es(c.nome||'(senza nome)')+'</b><small>'+es(det)+'</small>'+
   (no?'':'<select data-s="'+i+'" aria-label="Scheda"><option value="mezzo"'+(c.sch==='mezzo'?' selected':'')+'>Automezzi e macchine</option><option value="attrezzatura"'+(c.sch==='attrezzatura'?' selected':'')+'>Attrezzature</option></select>')+
   (c.perche?'<small class="perche">'+es(c.perche)+'</small>':'')+'</span></label>';});
 $('mz-c-ant').innerHTML=h+'</div>';var n=nuovi.filter(function(c){return c.scelto!==false;}).length;
 var ok=$('mz-c-ok');ok.hidden=!nuovi.length;ok.disabled=!n;ok.textContent='Aggiungi '+n+(n===1?' mezzo':' mezzi');}
$('mz-c-ant').addEventListener('change',function(e){var x=e.target;if(!x)return;
 if(x.type==='checkbox'){IMP[+x.getAttribute('data-i')].scelto=x.checked;disegna();}
 else if(x.hasAttribute('data-s')){var c=IMP[+x.getAttribute('data-s')];c.sch=x.value;c.un='';c.op=undefined;c.un=unitaDi(c,c.sch);c.op=operatoreDi(c,c.sch);disegna();}});
$('mz-carica').onclick=function(){IMP=[];$('mz-c-file').value='';$('mz-c-nome').textContent='Scegli il file';$('mz-c-ant').innerHTML='';$('mz-c-ok').hidden=true;cErr('');
 cStato('Il file si legge qui, sul tuo dispositivo.');$('mz-velo-c').hidden=false;};
$('mz-c-chiudi').onclick=function(){$('mz-velo-c').hidden=true;};
$('mz-velo-c').addEventListener('click',function(ev){if(ev.target===this)this.hidden=true;});
$('mz-modello').onclick=function(){var testo='﻿Scheda;Tipo;Nome;Marca e modello;Targa o matricola;Proprietà;Noleggiato da;Operatore;Prezzo €;Unità;Note\r\n'+
 'Automezzi e macchine;Escavatore cingolato;Escavatore Kubota 8 t;Kubota KX080;7731;Di proprietà;;Con operatore;75,00;ora;\r\n'+
 'Automezzi e macchine;Autocarro ribaltabile;Camion Iveco 3 assi;Iveco Trakker;FX482KL;Di proprietà;;Con operatore;65,00;ora;\r\n'+
 'Attrezzature;Martello demolitore;Martello demolitore Hilti;Hilti TE 1000;;Di proprietà;;;25,00;giorno;\r\n';
 var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([testo],{type:'text/csv;charset=utf-8'}));a.download='TIX modello mezzi e attrezzature.csv';document.body.appendChild(a);a.click();
 setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},1000);};
$('mz-c-file').addEventListener('change',function(){var f=this.files&&this.files[0];if(!f)return;cErr('');$('mz-c-ok').hidden=true;$('mz-c-ant').innerHTML='';
 if(f.size>20*1024*1024){cErr('Il file è troppo grande (più di 20 MB).');return;}
 $('mz-c-nome').textContent=f.name;cStato('Leggo il file…');
 leggiFile(f).then(function(l){IMP=l.filter(function(c){return c&&pul(c.nome);}).slice(0,500);
  if(!IMP.length){cStato('');cErr('Nel file non ho trovato mezzi. Va bene un elenco con il nome e, se vuoi, tipo, targa e prezzo: un mezzo per riga. Puoi partire dal modello.');return;}
  cStato('Ho trovato '+IMP.length+(IMP.length===1?' riga':' righe')+' in «'+f.name+'». Controlla l\'elenco e tocca «Aggiungi».');controlla();})
 .catch(function(e){cStato('');cErr('Non sono riuscito a leggere il file: '+(e&&e.message?e.message:e)+'.');});});
$('mz-c-ok').onclick=function(){var da=IMP.filter(function(c){return c.stato==='nuovo'&&c.scelto!==false;});if(!da.length)return;
 var ok=this,fatti=0,errori=[],i=0;ok.disabled=true;cErr('');
 function prossimo(){if(i>=da.length)return Promise.resolve();var c=da[i++];cStato('Aggiungo '+i+' di '+da.length+'…');
  var nol=/nolegg/.test(senzaAccenti(c.proprieta));
  var dati={scheda:c.sch,tipo:pul(c.tipo).slice(0,60),nome:c.nome,marca_modello:pul(c.marca+' '+c.modello).slice(0,80),targa:pul(c.targa).slice(0,30),
   proprieta:nol?'noleggio':'proprieta',noleggiatore:nol?pul(c.noleggiatore).slice(0,120):'',con_operatore:!!c.op,unita:c.un,prezzo:c.pz&&c.pz!=='?'?c.pz:'',note:pul(c.note).slice(0,300)};
  return chiama('salva',dati).then(function(r){if(r&&r.esito==='ok')fatti++;else errori.push(c.nome+(r&&r.messaggio?' ('+r.messaggio+')':''));}).then(prossimo);}
 prossimo().then(function(){ok.disabled=false;ok.hidden=true;
  if(errori.length){cStato('Aggiunti '+fatti+(fatti===1?' mezzo':' mezzi')+'.');cErr('Non aggiunti: '+errori.join('; ')+'.');$('mz-c-chiudi').onclick=ricarica;}
  else ricarica();});};
`;

const SCRIPT = String.raw`(function(){try{
var C=__CFG__;if(!C.d)return;var D=C.d,S='mezzo',corr=null;
var UN={ora:"all'ora",giorno:'al giorno',mezza_giornata:'a mezza giornata'};
function $(i){return document.getElementById(i);}
function es(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function euro(n){if(n==null||n==='')return '';var x=Number(n);return isFinite(x)?x.toFixed(2).replace('.',','):'';}
function data(iso){iso=String(iso||'');if(iso.slice(0,10)==='2000-01-01')return "dall'inizio";return /^\d{4}-\d{2}-\d{2}/.test(iso)?'dal '+iso.slice(8,10)+'/'+iso.slice(5,7)+'/'+iso.slice(0,4):'';}
function chiama(az,dati){return fetch(C.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:C.t,a:C.a,azione:az,dati:dati})}).then(function(r){return r.json();}).catch(function(){return{esito:'rete'};});}
function prezzoOk(v){v=String(v||'').replace(/€|\s/g,'');return !v||/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(v);}
function ricarica(){try{history.replaceState(null,'',location.pathname+location.search+'#'+S);}catch(e){}location.reload();}
function carte(){var g=$('mz-griglia'),m=(D.mezzi||[]).filter(function(x){return x.scheda===S;});
 ['mezzo','attrezzatura'].forEach(function(k){$('mz-n-'+k).textContent=(D.mezzi||[]).filter(function(x){return x.scheda===k;}).length;});
 g.innerHTML=m.map(function(x){var tipo=[x.tipo,x.marca_modello,x.targa?(x.scheda==='mezzo'?'targa ':'matricola ')+x.targa:''].filter(Boolean).join(' · ');
  return '<div class="mz-m"><h3>'+es(x.nome)+'</h3><p class="mz-tipo">'+es(tipo||' ')+(x.proprieta==='noleggio'&&x.noleggiatore?' · noleggiato da '+es(x.noleggiatore):'')+'</p>'+
  '<span class="mz-tag '+(x.proprieta==='noleggio'?'n">A noleggio':'p">Di proprietà')+'</span>'+(x.scheda==='mezzo'?'<span class="mz-tag">'+(x.con_operatore?'Con operatore':'Senza operatore')+'</span>':'')+
  (x.prezzo!=null?'<div class="mz-prezzo"><b>'+euro(x.prezzo)+' €</b><span>'+es(UN[x.unita]||'')+' + IVA</span></div>':'<div class="mz-prezzo manca"><b>Prezzo da scrivere</b><span>'+es(UN[x.unita]||'')+'</span></div>')+
  '<button type="button" class="mz-b sm" data-id="'+es(x.id)+'">Modifica e storico prezzi</button></div>';}).join('')+
  '<button type="button" class="mz-agg" id="mz-agg2">+ Aggiungi '+(S==='mezzo'?'un automezzo o una macchina':"un'attrezzatura")+'</button>'+
  (m.length?'':'<p class="mz-vuoto">'+(S==='mezzo'?'Nessun automezzo ancora: aggiungi camion, escavatori, mini-escavatori, autogru…':'Nessuna attrezzatura ancora: aggiungi martello demolitore, flessibile, idropulitrice, generatore…')+'</p>');
 Array.prototype.forEach.call(g.querySelectorAll('[data-id]'),function(b){b.onclick=function(){apri((D.mezzi||[]).filter(function(x){return x.id===b.getAttribute('data-id');})[0]);};});
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
function scelta(campo,v){var w=document.querySelector('.mz-scelta[data-campo="'+campo+'"]');Array.prototype.forEach.call(w.querySelectorAll('button'),function(b){b.classList.toggle('on',b.getAttribute('data-v')===String(v));});}
function valore(campo){var b=document.querySelector('.mz-scelta[data-campo="'+campo+'"] button.on');return b?b.getAttribute('data-v'):'';}
function aggiorna(){var sch=valore('scheda');$('c-op').hidden=sch!=='mezzo';$('c-nol').hidden=valore('proprieta')!=='noleggio';$('mz-avv-op').hidden=!(sch==='mezzo'&&valore('con_operatore')==='true');
 $('mz-tipi').innerHTML=((D.tipi&&D.tipi[sch])||[]).map(function(t){return '<option value="'+es(t)+'">';}).join('');}
Array.prototype.forEach.call(document.querySelectorAll('.mz-scelta'),function(w){w.addEventListener('click',function(ev){var b=ev.target.closest('button');if(!b)return;
 var c=w.getAttribute('data-campo');scelta(c,b.getAttribute('data-v'));if(c==='scheda'&&!corr){scelta('unita',b.getAttribute('data-v')==='mezzo'?'ora':'giorno');scelta('con_operatore',b.getAttribute('data-v')==='mezzo'?'true':'false');}aggiorna();});});
function apri(x){corr=x||null;$('mz-mod-t').textContent=x?'Modifica: '+x.nome:(S==='mezzo'?'Nuovo automezzo o macchina':'Nuova attrezzatura');
 scelta('scheda',x?x.scheda:S);scelta('proprieta',x?x.proprieta:'proprieta');scelta('con_operatore',x?String(!!x.con_operatore):(S==='mezzo'?'true':'false'));scelta('unita',x?x.unita:(S==='mezzo'?'ora':'giorno'));
 $('f-tipo').value=x?x.tipo||'':'';$('f-nome').value=x?x.nome:'';$('f-mm').value=x?x.marca_modello||'':'';$('f-targa').value=x?x.targa||'':'';$('f-nol').value=x?x.noleggiatore||'':'';
 $('f-prezzo').value=x&&x.prezzo!=null?euro(x.prezzo):'';$('f-note').value=x?x.note||'':'';$('mz-msg').textContent='';$('mz-msg').className='mz-msg';$('mz-togli').hidden=!x;
 var st=x&&x.storico||[];$('mz-storico').hidden=!st.length;$('mz-storico').innerHTML=st.length?'<b>Storico dei prezzi</b><ul>'+st.map(function(s){return '<li><b>'+euro(s.prezzo)+' € '+es(UN[x.unita]||'')+'</b> '+es(data(s.valido_dal))+' · scritto il '+es(s.il)+(s.autore?' da '+es(s.autore):'')+'</li>';}).join('')+'</ul>'+(x.prezzo!=null?'<p>Se cambi il prezzo, quello nuovo vale da oggi; i giorni passati restano con il prezzo di prima.</p>':''):'';
 crPulisci($('mz-velo'));aggiorna();$('mz-velo').hidden=false;$('f-nome').focus();}
function chiudi(){$('mz-velo').hidden=true;}
$('mz-annulla').onclick=chiudi;$('mz-velo').addEventListener('click',function(ev){if(ev.target===this)chiudi();});document.addEventListener('keydown',function(ev){if(ev.key==='Escape')chiudi();});
$('mz-salva').onclick=function(){var b=this,dati={id:corr?corr.id:'',scheda:valore('scheda'),tipo:$('f-tipo').value,nome:$('f-nome').value,marca_modello:$('f-mm').value,targa:$('f-targa').value,
 proprieta:valore('proprieta'),noleggiatore:$('f-nol').value,con_operatore:valore('con_operatore')==='true',unita:valore('unita'),prezzo:$('f-prezzo').value,note:$('f-note').value};
 var regole=[{el:$('f-nome'),testo:'Scrivi il nome per riconoscerlo (es. Escavatore Kubota 8 t).'},
  {el:$('f-prezzo'),ok:function(){return prezzoOk($('f-prezzo').value);},testo:'Scrivi il prezzo in euro, per esempio 75,00.'}];
 if(!crControlla(regole)){$('mz-msg').className='mz-msg ko';$('mz-msg').textContent='Completa i campi segnati in rosso.';return;}
 b.disabled=true;$('mz-msg').className='mz-msg';$('mz-msg').textContent='Salvo…';
 chiama('salva',dati).then(function(r){b.disabled=false;if(r&&r.esito==='ok'){ricarica();return;}$('mz-msg').className='mz-msg ko';$('mz-msg').textContent=r&&r.messaggio?r.messaggio:'Non è stato possibile salvare. Riprova tra qualche minuto.';
  var mp={nome:$('f-nome'),prezzo:$('f-prezzo'),tipo:$('f-tipo'),targa:$('f-targa'),noleggiatore:$('f-nol'),marca_modello:$('f-mm'),note:$('f-note')};if(r&&r.campo&&mp[r.campo])crSegna(mp[r.campo],r.messaggio||'Da correggere');});};
$('mz-togli').onclick=function(){if(!corr)return;var b=this;if(b.getAttribute('data-ok')!=='1'){b.setAttribute('data-ok','1');b.textContent='Confermi? Premi ancora';return;}
 b.disabled=true;chiama('elimina',{id:corr.id}).then(function(r){b.disabled=false;b.removeAttribute('data-ok');b.textContent="Togli dall'elenco";if(r&&r.esito==='ok'){ricarica();return;}$('mz-msg').className='mz-msg ko';$('mz-msg').textContent='Non è stato possibile toglierlo. Riprova.';});};
Array.prototype.forEach.call(document.querySelectorAll('.mz-tabs button'),function(b){b.onclick=function(){S=b.getAttribute('data-s');Array.prototype.forEach.call(document.querySelectorAll('.mz-tabs button'),function(x){x.classList.toggle('on',x===b);});carte();};});
var n=$('mz-nuovo');if(n)n.onclick=function(){apri(null);};
// dopo un salvataggio si torna sulla stessa scheda
if(location.hash==='#attrezzatura'){S='attrezzatura';Array.prototype.forEach.call(document.querySelectorAll('.mz-tabs button'),function(x){x.classList.toggle('on',x.getAttribute('data-s')===S);});}
__CARICA__
carte();qual();
}catch(e){}})();`;
