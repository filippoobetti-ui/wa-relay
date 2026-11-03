// ============================================================================
// REGISTRO DELLE ECONOMIE — area riservata (02/11/2026, registro-economie-1; prima, dal 29/10/2026, «Economie dei
// subappaltatori»). Il pulsante «Registro delle economie» della pagina del cantiere apre il registro del mese, giorno
// per giorno, in tre schede che non si mescolano mai (decisione di Filippo del 29/10/2026):
//   «Per il committente»  economie da far pagare al committente (gli stessi numeri del rapportino settimanale);
//   «Dei subappaltatori»  lavori extra dei subappaltatori per l'impresa, con la lista del mese da firmare per ogni
//                         impresa e «Riporta al committente» (come prima);
//   «Ore normali»         le ore di ogni giorno, dalle timbrature e dai rapportini firmati.
// Ogni giorno è «firmato dall'ufficio» (c'è il rapportino del giorno registrato: valgono le sue righe) o «da confermare».
//   GET  /economie?t=<gettone>&c=<cantiere>[&mese=AAAA-MM][&scheda=committente|sub|normali]  → pagina
//   GET  /economie/foglio?t=…&c=…&mese=…&scheda=…    → foglio pulito da stampare o salvare in PDF
//   GET  /economie/excel?t=…&c=…&mese=…&scheda=…     → file per Excel (.csv), come «Scarica in Excel»
//   GET  /economie/stampa?t=…&c=…&mese=…&impresa=…   → lista del mese di un subappaltatore, da firmare (come prima)
//   POST /economie/riporta  {t, c, id, si}          → riporta o togli una riga del subappaltatore dal committente
// Il database decide tutto (RPC registro_economie_portale, economie_impresa_portale, economia_riporta): righe, totali,
// stato dei giorni e file per Excel. Si spegne con ECONOMIE_SUB = "off" (pagina e pulsante).
// 03/11/2026 (mezzi-1): il registro si legge con registro_economie_euro, che con impostazioni.mezzi_attiva accesa aggiunge alla
// scheda «Per il committente» prezzi e importi (+ IVA) della manodopera per qualifica, i mezzi e le attrezzature in economia
// (src/mezzi.js) e i prezzi concordati per questo cantiere; spenta, dà gli stessi dati di prima.
//   POST /economie/mezzo   {t, c, dati, togli}   → mezzo in economia: aggiungi, correggi o togli (solo l'ufficio)
//   POST /economie/prezzo  {t, c, dati}          → prezzo concordato per questo cantiere (vuoto = torna al prezzo di base)
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MESE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const GIORNO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const SETTIMANA = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
// 03/11/2026 (Filippo): sotto il nome di ogni scheda una riga che dice cosa contiene («economie extracontrattuali»,
// «presenze di ogni giorno»); anche nel titolo del foglio da stampare
const SCHEDE = [
  { k: "committente", t: "Per il committente", sotto: "economie extracontrattuali", foglio: "Economie extracontrattuali per il committente", chi: "Squadra o impresa", gruppo: "Per squadra o impresa" },
  { k: "sub", t: "Dei subappaltatori", sotto: "economie extracontrattuali", foglio: "Economie extracontrattuali dei subappaltatori", chi: "Squadra", gruppo: "Per impresa" },
  { k: "normali", t: "Ore normali", sotto: "presenze di ogni giorno", foglio: "Ore normali", chi: "Persona o squadra", gruppo: "Per persona o squadra" }
];
const VUOTA = { righe: [], ore: 0, n_righe: 0, giorni: 0, giorni_firmati: 0, ore_riportate: 0, gruppi: 0, per_giorno: [], per_qualifica: [], per_gruppo: [] };

function num(x) {
  const n = Number(x);
  if (!isFinite(n)) return "-";
  return (Math.round(n * 100) / 100).toString().replace(".", ",");
}
function ore(x) { return num(x) + " h"; }
// 03/11/2026 (mezzi-1): euro con due decimali e separatore delle migliaia («1.430,50 €»); vuoto se manca
function euro(x) {
  if (x == null || x === "") return "";
  const n = Number(x);
  if (!isFinite(n)) return "";
  const [i, dec] = n.toFixed(2).split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + dec + " €";
}
function corto(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
const UNITA = { ora: ["h", "ore", "all'ora", "ora"], giorno: ["g", "giornate", "al giorno", "giornata"], mezza_giornata: ["½ g", "mezze giornate", "a mezza giornata", "mezza giornata"] };
function quantita(q, u) { return num(q) + " " + (UNITA[u] || UNITA.ora)[0]; }
function quantitaTesto(o) {   // {ora: 5.5, giorno: 1} → «5,5 ore · 1 giornata»
  return Object.keys(o || {}).filter((k) => Number(o[k]) > 0).map((k) => num(o[k]) + " " + (UNITA[k] || UNITA.ora)[Number(o[k]) === 1 ? 3 : 1]).join(" · ");
}
// la scheda «Per il committente» con gli euro (solo quando il database li manda)
function conEuro(d, s) { return !!(d && d.euro === true && s.k === "committente"); }
function lista(a) { return Array.isArray(a) ? a : []; }
function parte(d, k) { const x = d && d[k]; return x && typeof x === "object" ? Object.assign({}, VUOTA, x) : VUOTA; }

function parametri(inUrl) {
  const s = inUrl.searchParams;
  const m = String(s.get("t") || "").match(/[0-9a-fA-F]{64}/);
  const c = String(s.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  const mese = MESE.test(s.get("mese") || "") ? s.get("mese") : "";
  const impresa = String(s.get("impresa") || "").slice(0, 200);
  const k = String(s.get("scheda") || "");
  // i vecchi collegamenti con &impresa= aprono la scheda dei subappaltatori
  const scheda = SCHEDE.some((x) => x.k === k) ? k : (impresa ? "sub" : "committente");
  return { tok: m ? m[0].toLowerCase() : "", c, mese, impresa, scheda };
}

// gli ultimi 12 mesi, dal più recente, contati dal giorno di oggi del database (ora di Roma)
function mesiRecenti(oggi) {
  const m = /^([0-9]{4})-([0-9]{2})/.exec(String(oggi || ""));
  const ora = new Date();
  const a = m ? Number(m[1]) : ora.getFullYear(), mm = m ? Number(m[2]) - 1 : ora.getMonth();
  const out = [];
  for (let k = 0; k < 12; k++) {
    const d = new Date(Date.UTC(a, mm - k, 1));
    out.push({ v: d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0"), t: MESI[d.getUTCMonth()] + " " + d.getUTCFullYear() });
  }
  return out;
}

// "2026-10-13" → "martedì 13 ottobre" (con la maiuscola se serve)
function giornoLungo(iso, maiuscola) {
  if (!GIORNO.test(String(iso || ""))) return String(iso || "");
  const d = new Date(iso + "T12:00:00Z");
  const t = SETTIMANA[d.getUTCDay()] + " " + d.getUTCDate() + " " + MESI[d.getUTCMonth()];
  return maiuscola ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
function dataIt(iso) { return GIORNO.test(String(iso || "")) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : String(iso || ""); }
function aggiornato(d) {
  return d.corrente ? "Aggiornato a oggi, " + giornoLungo(d.oggi) + ", alle " + (d.ora || "")
    : "Dati aggiornati al " + dataIt(d.oggi) + " alle " + (d.ora || "");
}

export async function portaleEconomie(request, env, base, inUrl, h) {
  if (env.ECONOMIE_SUB === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");

  if (sotto === "/economie/riporta") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    let d = null;
    try { d = await request.json(); } catch (e) { d = null; }
    const tok = String(d && d.t || "").match(/^[0-9a-fA-F]{64}$/) ? String(d.t).toLowerCase() : "";
    const c = String(d && d.c || "").toLowerCase();
    const id = String(d && d.id || "").toLowerCase();
    if (!tok || !UUID.test(c) || !UUID.test(id)) return json({ esito: "errore" }, 400);
    const r = await h.rpc(env, "economia_riporta", { p_token: tok, p_commessa: c, p_id: id, p_si: !!(d && d.si) }, 15000).catch(() => null);
    return json(r || { esito: "errore" }, r ? 200 : 503);
  }

  // 03/11/2026 (mezzi-1): mezzi e attrezzature in economia e prezzi concordati del cantiere; i controlli li fa il database
  if (sotto === "/economie/mezzo" || sotto === "/economie/prezzo") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    let d = null;
    try { d = await request.json(); } catch (e) { d = null; }
    const tok = String(d && d.t || "").match(/^[0-9a-fA-F]{64}$/) ? String(d.t).toLowerCase() : "";
    const c = String(d && d.c || "").toLowerCase();
    if (!tok || !UUID.test(c)) return json({ esito: "errore" }, 400);
    const x = d && d.dati && typeof d.dati === "object" ? d.dati : {};
    let r = null;
    if (sotto === "/economie/prezzo" && x.voce === "contratto") {
      // 03/11/2026 (mezzi-3): riferimento del contratto d'appalto del cantiere
      r = await h.rpc(env, "contratto_economie_salva", { p_token: tok, p_commessa: c, p_riferimento: corto(x.riferimento, 300) }, 15000).catch(() => null);
    } else if (sotto === "/economie/prezzo") {
      r = await h.rpc(env, "prezzo_economia_salva", { p_token: tok, p_azienda: "", p_commessa: c, p_dati: {
        voce: corto(x.voce, 20), mezzo_id: corto(x.mezzo_id, 36), qualifica: corto(x.qualifica, 20), prezzo: corto(x.prezzo, 20) } }, 15000).catch(() => null);
    } else if (d && d.togli) {
      const id = Number(x.id);
      if (!Number.isInteger(id) || id <= 0) return json({ esito: "errore" }, 400);
      r = await h.rpc(env, "economia_mezzo_togli", { p_token: tok, p_commessa: c, p_id: id }, 15000).catch(() => null);
    } else {
      r = await h.rpc(env, "economia_mezzo_salva", { p_token: tok, p_commessa: c, p_dati: {
        id: corto(x.id, 20), data: corto(x.data, 10), mezzo_id: corto(x.mezzo_id, 36), quantita: corto(x.quantita, 12),
        descrizione: corto(x.descrizione, 300) } }, 15000).catch(() => null);
    }
    return json(r || { esito: "errore" }, r ? 200 : 503);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (["/economie", "/economie/foglio", "/economie/excel", "/economie/stampa"].indexOf(sotto) === -1) {
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const p = parametri(inUrl);
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!UUID.test(p.c)) return Response.redirect(inUrl.origin + base + "/?t=" + p.tok, 303);
  const torna = base + "/?t=" + p.tok + "&c=" + p.c;
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>';

  if (sotto === "/economie/stampa") return stampaLista(request, env, base, inUrl, h, p, indietro);

  if (sotto === "/economie/excel") {
    const r = await h.rpc(env, "registro_economie_euro", { p_token: p.tok, p_commessa: p.c, p_mese: p.mese, p_csv: p.scheda }, 20000).catch(() => null);
    if (!r) return h.risposta(h.foglio(base, "Scarica Excel", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
    if (r.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
    if (r.esito !== "ok" || typeof r.csv !== "string") return h.risposta(h.foglio(base, "Scarica Excel", "Non è stato possibile preparare il file per questo cantiere.", indietro), 400);
    // stesso file di «Scarica in Excel» (src/esporta.js): testo con il BOM, che Excel apre direttamente
    const nome = String(r.nome_file || "TIX registro delle economie.csv");
    const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "TIX.csv";
    return new Response(request.method === "HEAD" ? null : "\uFEFF" + r.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=UTF-8",
        "Content-Disposition": 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }

  const d = await h.rpc(env, "registro_economie_euro", { p_token: p.tok, p_commessa: p.c, p_mese: p.mese, p_csv: "" }, 20000).catch(() => null);
  if (!d) return h.risposta(h.foglio(base, "Registro delle economie", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Registro delle economie", "Questa pagina non è disponibile per questo cantiere.", indietro), 400);
  if (sotto === "/economie/foglio") return h.risposta(foglio(base, h, p, d));
  return h.risposta(pagina(base, h, p, d, torna));
}

function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" } });
}

// Lista del mese di un subappaltatore, da stampare e firmare: come prima del registro (economie_impresa_portale).
async function stampaLista(request, env, base, inUrl, h, p, indietro) {
  const elenco = await h.rpc(env, "economie_impresa_portale", { p_token: p.tok, p_commessa: p.c, p_mese: p.mese, p_impresa: "" }, 15000).catch(() => null);
  if (!elenco) return h.risposta(h.foglio(base, "Lista del mese", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (elenco.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (elenco.esito !== "ok") return h.risposta(h.foglio(base, "Lista del mese", "Questa pagina non è disponibile per questo cantiere.", indietro), 400);
  const mese = elenco.mese || p.mese;
  const imprese = lista(elenco.imprese);
  const scelta = p.impresa && imprese.some((x) => x.impresa === p.impresa) ? p.impresa : (imprese[0] && imprese[0].impresa) || "";
  let l = null;
  if (scelta) l = await h.rpc(env, "economie_impresa_portale", { p_token: p.tok, p_commessa: p.c, p_mese: mese, p_impresa: scelta }, 15000).catch(() => null);
  if (!l || l.esito !== "ok" || typeof l.html !== "string") {
    return h.risposta(h.foglio(base, "Lista del mese", "Nessuna lista da stampare per questo mese.", indietro), 404);
  }
  const stampa = l.html.replace("</body>", '<script>addEventListener("load",function(){setTimeout(function(){window.print();},300);});</script></body>');
  return new Response(request.method === "HEAD" ? null : stampa, { status: 200, headers: h.headers ? h.headers() : { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } });
}

// righe della scheda raggruppate per giorno, nell'ordine del database
function perGiorno(x) {
  const gruppi = [], idx = {};
  lista(x.righe).forEach((v) => {
    const g = String(v.data || "");
    if (!(g in idx)) { idx[g] = gruppi.length; gruppi.push({ data: g, righe: [], ore: 0 }); }
    gruppi[idx[g]].righe.push(v);
  });
  lista(x.per_giorno).forEach((t) => { if (String(t.data) in idx) gruppi[idx[String(t.data)]].ore = t.ore; });
  return gruppi;
}
// 03/11/2026 (mezzi-1): con gli euro, sotto ogni giorno anche i mezzi e le attrezzature in economia (dopo la manodopera) e il
// totale del giorno in euro; i giorni con soli mezzi entrano al loro posto in ordine di data
function perGiornoEuro(x, d) {
  const gruppi = perGiorno(x), idx = {};
  gruppi.forEach((g, i) => { idx[g.data] = i; g.euro = 0; g.senza = 0; });
  lista(d.mezzi).forEach((m) => {
    const g = String(m.data || "");
    if (!(g in idx)) { idx[g] = gruppi.length; gruppi.push({ data: g, righe: [], ore: 0, euro: 0, senza: 0 }); }
    gruppi[idx[g]].righe.push(Object.assign({ _mz: true }, m));
  });
  lista(d.importi && d.importi.per_giorno).forEach((t) => {
    if (String(t.data) in idx) { gruppi[idx[String(t.data)]].euro = t.totale; gruppi[idx[String(t.data)]].senza = Number(t.senza_prezzo) || 0; }
  });
  return gruppi.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}

function fonteTesto(v) {
  if (v.fonte === "rapportino") return "Rapportino n. " + (v.numero == null ? "-" : v.numero) + (Number(v.versione) > 1 ? " (versione " + v.versione + ")" : "");
  if (v.fonte === "timbrature") return "Timbrature";
  return "WhatsApp";
}
function dettaglio(v, s) {
  if (s.k === "normali") {
    const mi = Number(v.minuti);
    return isFinite(mi) && v.minuti != null ? "Tempo timbrato " + Math.floor(mi / 60) + " h " + String(mi % 60).padStart(2, "0") + " min, arrotondato alla mezz'ora" : "";
  }
  return String(v.descrizione || "");
}

// ---------------------------------------------------------------------------- pagina
function pagina(base, h, p, d, torna) {
  const e = h.esc;
  const mesi = mesiRecenti(d.oggi);
  if (!mesi.some((m) => m.v === d.mese)) mesi.push({ v: d.mese, t: d.mese_testo || d.mese });
  const opzMesi = mesi.map((m) => '<option value="' + e(m.v) + '"' + (m.v === d.mese ? " selected" : "") + ">" + e(m.t) + "</option>").join("");
  const cant = d.cantiere || {};
  const radio = SCHEDE.map((s) => '<input type="radio" name="rg-s" class="rg-r" id="rg-s-' + s.k + '" value="' + s.k + '"' + (s.k === p.scheda ? " checked" : "") + ">").join("");
  const schede = '<nav class="rg-tabs" aria-label="Parti del registro">' + SCHEDE.map((s) =>
    '<label for="rg-s-' + s.k + '"><span>' + e(s.t) + "</span><b>" + e(s.sotto) + " · " + ore(parte(d, s.k).ore) + "</b></label>").join("") + "</nav>";
  const cfg = JSON.stringify({ u: base + "/economie/riporta", um: base + "/economie/mezzo", up: base + "/economie/prezzo", t: p.tok, c: p.c }).replace(/</g, "\\u003c");

  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>Registro delle economie - TIX · Diario di cantiere</title>" + h.testa(base) +
    "<style>" + STILE + "</style></head><body><main>" +
    '<a class="rg-torna" href="' + e(torna) + '">‹ Torna al cantiere</a>' +
    '<div class="rg-card"><div class="rg-testa"><div><p>' + e(cant.nome || "") + (d.impresa ? " · " + e(d.impresa) : "") + "</p>" +
    "<h1>Registro delle economie</h1>" +
    '<p class="rg-sott">Lavori extracontrattuali pagati a ore di operai, mezzi e attrezzature, e ore normali di ogni giorno.</p></div>' +
    '<form class="rg-mese" method="get" action="' + e(base + "/economie") + '"><input type="hidden" name="t" value="' + e(p.tok) + '">' +
    '<input type="hidden" name="c" value="' + e(p.c) + '"><input type="hidden" name="scheda" id="rg-sch" value="' + e(p.scheda) + '">' +
    '<select name="mese" aria-label="Mese" onchange="this.form.submit()">' + opzMesi + "</select></form></div>" +
    '<p class="rg-agg"><b>' + e(d.mese_testo || "") + "</b> · " + e(aggiornato(d)) + "</p>" +
    (d.chiuso ? '<p class="rg-chiuso">Cantiere chiuso: il registro si consulta, le scelte non si cambiano più.</p>' : "") +
    radio + schede +
    SCHEDE.map((s) => pannello(base, h, p, d, s)).join("") +
    "</div></main>" +
    "<script>" + SCRIPT.replace("__CFG__", cfg) + "</script>" +
    "</body></html>";
}

function pannello(base, h, p, d, s) {
  const e = h.esc, x = parte(d, s.k), sub = s.k === "sub", norm = s.k === "normali";
  const q = "?t=" + p.tok + "&c=" + p.c + "&mese=" + d.mese + "&scheda=" + s.k;
  const eu = conEuro(d, s), im = (eu && d.importi) || {}, nMezzi = eu ? lista(d.mezzi).length : 0;
  const cifre = eu ? [
    ["Manodopera · " + ore(im.manodopera_ore), euro(im.manodopera) || "0,00 €"],
    ["Automezzi e macchine" + (quantitaTesto(im.mezzi_quantita) ? " · " + quantitaTesto(im.mezzi_quantita) : ""), euro(im.mezzi) || "0,00 €"],
    ["Attrezzature" + (quantitaTesto(im.attrezzature_quantita) ? " · " + quantitaTesto(im.attrezzature_quantita) : ""), euro(im.attrezzature) || "0,00 €"],
    ["Totale del mese + IVA", euro(im.totale) || "0,00 €"]
  ] : [
    [norm ? "Ore normali" : "Ore in economia", ore(x.ore)],
    [norm ? "Giorni con ore" : "Giorni con economie", String(x.giorni)],
    sub ? ["Imprese", String(x.gruppi)] : norm ? ["Persone o squadre", String(x.gruppi)] : ["Registrazioni", String(x.n_righe)],
    sub ? ["Riportate al committente", ore(x.ore_riportate)] : ["Giorni firmati dall'ufficio", x.giorni_firmati + " su " + x.giorni]
  ];
  const intro = s.k === "committente"
    ? "Lavori extra della tua impresa da far pagare al committente: sono le ore del rapportino settimanale delle ore in economia."
    : sub ? "Lavori extra dei subappaltatori per la tua impresa, fuori dal contratto di subappalto: non vanno al committente. Se un lavoro lo fai pagare anche al committente, premi «Riporta al committente»: vale per i rapportini settimanali che devono ancora uscire."
      : "Le ore di lavoro di ogni giorno, dalle timbrature (ENTRO / ESCO) e dai rapportini firmati. Non sono economie: non vanno al committente né nelle liste dei subappaltatori.";
  const vuoto = s.k === "committente"
    ? "Nessuna economia per il committente in " + (d.mese_testo || "questo mese") + ". Le ore in economia che la squadra scrive su WhatsApp compaiono qui il giorno stesso."
    : sub ? "Nessuna economia dei subappaltatori in " + (d.mese_testo || "questo mese") + ". Le ore extra che i subappaltatori scrivono su WhatsApp compaiono qui."
      : "Nessuna ora normale in " + (d.mese_testo || "questo mese") + ". Arrivano dalle timbrature su WhatsApp (ENTRO / ESCO) e dai rapportini firmati.";
  const fonti = norm
    ? "Giorno «firmato dall'ufficio»: c'è il rapportino del giorno registrato e valgono le sue righe «Ore normali». Giorno «da confermare»: valgono le timbrature, arrotondate alla mezz'ora come nella bozza del rapportino delle 22."
    : "Giorno «firmato dall'ufficio»: c'è il rapportino del giorno registrato e valgono le sue righe. Giorno «da confermare»: valgono i messaggi WhatsApp. Se l'ufficio ha scritto il rapportino senza le righe arrivate da WhatsApp, contano anche quelle. " +
      (sub ? "Sono gli stessi numeri delle liste del mese dei subappaltatori." : "Sono gli stessi numeri del rapportino settimanale delle ore in economia.");
  const pieno = x.n_righe || nMezzi;
  // 03/11/2026 (Filippo): i pulsanti ci sono sempre; con il mese vuoto il foglio dice «Nessuna riga in questo mese» (utile da dare
  // alla DL come prova che nel mese non ci sono state economie) e il file per Excel ha solo le intestazioni
  const az = '<div class="rg-az"><a class="rg-b" href="' + e(base + "/economie/foglio" + q) + '" target="_blank" rel="noopener">&#128424;&#65039; Stampa o salva in PDF</a>' +
    '<a class="rg-b rg-xl" href="' + e(base + "/economie/excel" + q) + '">&#128202; Scarica Excel</a></div>';

  return '<section class="rg-pan" id="rg-p-' + s.k + '" aria-label="' + e(s.t) + '">' +
    '<p class="rg-spiega">' + e(intro) + "</p>" +
    (sub ? '<p class="rg-wa"><b>Come le scrive il subappaltatore.</b> Su WhatsApp, come sempre: per esempio «2 operai 4 ore spostamento scarico, lavoro extra». Le ore extra di chi è registrato come subappaltatore o autonomo vengono qui, nella sua lista del mese. Se le segna l\'ufficio, nel rapportino del giorno si sceglie «Economia del subappaltatore» e si scrive il suo nome nella squadra.</p>' +
      '<p class="rg-msg" id="rg-msg" aria-live="polite"></p>' : "") +
    '<div class="rg-cifre' + (eu ? " rg-eu" : "") + '">' + cifre.map((c) => "<div><b>" + e(c[1]) + "</b><span>" + e(c[0]) + "</span></div>").join("") + "</div>" +
    (s.k === "committente" && Number(x.ore_riportate) > 0 ? '<p class="rg-nota">Comprese ' + e(ore(x.ore_riportate)) + " riportate dai subappaltatori.</p>" : "") +
    (eu ? avvisiEuro(base, h, p, d) : "") +
    az +
    (eu ? moduliEuro(base, h, p, d) : "") +
    (pieno ? tabella(base, h, p, d, s, x) + (x.n_righe ? riepiloghi(h, s, x) : "") + (eu && nMezzi ? riepilogoMezzi(h, d) : "") : '<p class="rg-vuoto">' + e(vuoto) + "</p>") +
    (sub && lista(x.per_gruppo).length ? listeSub(base, h, p, d, x) : "") +
    '<p class="rg-fonti">' + e(fonti) + "</p></section>";
}

// sei colonne in tutte le schede; nei subappaltatori la prima ha l'impresa esecutrice e, sotto, la squadra
function colonne(s, eu) {
  if (eu) return ["Squadra, impresa o mezzo", "Qualifica o tipo", "Operai", "Ore per operaio", "Ore o quantità", "Prezzo + IVA", "Importo", "Descrizione"];
  return [s.k === "sub" ? "Impresa esecutrice e squadra" : s.chi, "Qualifica", "Operai", "Ore per operaio", "Ore totali", s.k === "normali" ? "Dettaglio" : "Descrizione"];
}

function tabella(base, h, p, d, s, x) {
  const e = h.esc, eu = conEuro(d, s), cols = colonne(s, eu), n = cols.length;
  const prima = 4, dopo = n - prima - 1; // colonne prima e dopo «Ore totali»
  const numeriche = (i) => (i >= prima - 2 && i <= prima) || (eu && (i === 5 || i === 6));
  const testa = "<thead><tr>" + cols.map((c, i) => "<th" + (numeriche(i) ? ' class="n"' : "") + ">" + e(c) + "</th>").join("") + "</tr></thead>";
  // con gli euro: ore del giorno sotto «Ore o quantità» (solo manodopera), importo del giorno sotto «Importo»
  const totale = (cl, et, o, eur) => '<tr class="' + cl + '"><td colspan="' + prima + '">' + et + '</td><td class="n">' + e(eu && !Number(o) ? "-" : ore(o)) + "</td>" +
    (eu ? '<td></td><td class="n">' + e(euro(eur) || "0,00 €") + '</td><td></td>' : (dopo ? '<td colspan="' + dopo + '"></td>' : "")) + "</tr>";
  const corpo = (eu ? perGiornoEuro(x, d) : perGiorno(x)).map((g) => '<tbody class="rg-g">' + testaGiorno(base, h, p, d, g.data, n) +
    g.righe.map((v) => v._mz ? rigaMezzo(h, v, d.chiuso || d.puo_modificare !== true || d.solo_diario === true) : riga(h, s, v, d.chiuso, eu)).join("") +
    totale("rg-gt", "Totale del giorno", g.ore, g.euro) + "</tbody>").join("");
  // totale del mese in un tbody e non in un tfoot: in stampa il tfoot si ripeterebbe in fondo a ogni pagina
  const piede = '<tbody class="rg-fine">' + totale("rg-mt", "Totale del mese" + (eu ? " + IVA" : ""), x.ore, eu && d.importi ? d.importi.totale : 0) + "</tbody>";
  return '<div class="rg-tw"><table class="rg-t' + (eu ? " rg-teu" : "") + '">' + testa + corpo + piede + "</table></div>";
}

function testaGiorno(base, h, p, d, iso, n) {
  const e = h.esc, g = (d.giorni && d.giorni[iso]) || {};
  let st;
  if (g.firmato) {
    st = '<span class="rg-st ok">&#10003; Firmato dall\'ufficio</span>' + lista(g.rapportini).map((r) =>
      '<a class="rg-rl" href="' + e(base + "/rapportino/documento?t=" + p.tok + "&id=" + r.id) + '">Rapportino n. ' + e(r.numero) +
      (Number(r.versione) > 1 ? " (versione " + e(r.versione) + ")" : "") + "</a>" +
      (r.autore || r.registrato_il ? '<span class="rg-chi">' + e([r.autore, r.registrato_il].filter(Boolean).join(", ")) + "</span>" : "")).join("");
  } else {
    st = '<span class="rg-st da">Da confermare</span><a class="rg-rl" href="' + e(base + "/rapportino?t=" + p.tok + "&c=" + p.c + "&g=" + iso) + '">' +
      (g.bozza ? "Bozza del rapportino pronta: controlla e firma" : "Apri il rapportino del giorno") + "</a>";
  }
  // 03/11/2026 (economie-foto-1): le foto allegate alle economie del giorno nel Diario
  const ft = lista(g.foto);
  if (ft.length) st += '<span class="rg-ft">&#128247; ' + (ft.length === 1 ? "1 foto" : ft.length + " foto") + ft.map((f) =>
    '<a href="' + e(f.url) + '" target="_blank" rel="noopener noreferrer" title="Foto delle ' + e(f.ora) + '"><img src="' + e(f.url) +
    '" alt="Foto delle ' + e(f.ora) + '" loading="lazy"></a>').join("") + "</span>";
  return '<tr class="rg-gh"><th colspan="' + n + '" scope="colgroup"><span class="rg-dt">' + e(giornoLungo(iso, true)) + "</span>" + st + "</th></tr>";
}

// 03/11/2026 (mezzi-1): prezzo e importo di una riga; senza prezzo «prezzo mancante» (si scrive in Mezzi e attrezzature)
function celleEuro(h, v) {
  const e = h.esc;
  if (v.prezzo == null) return '<td class="n c-pr"><span class="rg-manca">prezzo mancante</span></td><td class="n c-im">-</td>';
  return '<td class="n c-pr">' + e(euro(v.prezzo)) + (v.origine === "concordato" ? '<span class="rg-conc">da contratto</span>' : "") + "</td>" +
    '<td class="n c-im">' + e(euro(v.importo)) + "</td>";
}

function riga(h, s, v, chiuso, eu) {
  const e = h.esc, sub = s.k === "sub";
  const op = Number(v.operai);
  const det = (v.qualifica ? e(v.qualifica) + " · " : "") + e(v.operai == null ? "-" : v.operai) + (op === 1 ? " operaio" : " operai") + " × " + e(num(v.ore)) + " h" +
    (eu ? " · " + (v.prezzo == null ? "prezzo mancante" : e(euro(v.importo))) : "");
  const testo = dettaglio(v, s);
  const tag = '<span class="rg-fo">' + e(fonteTesto(v)) + "</span>" +
    (s.k === "committente" && v.riportata ? '<span class="rg-tag">Riportata dal subappaltatore ' + e(v.impresa || "") + "</span>" : "") +
    (sub ? '<span class="rg-tag"' + (v.riportata ? "" : " hidden") + ">Riportata al committente</span>" : "");
  return '<tr class="rg-row"' + (sub && v.id ? ' id="r-' + e(v.id) + '" data-id="' + e(v.id) + '"' : "") + ">" +
    '<td class="c-sq">' + (sub ? '<b class="rg-imp">' + e(v.impresa || "") + '</b><span class="rg-sq2">' + e(v.squadra || "-") + "</span>" : e(v.squadra || "-")) +
    '<span class="m-det">' + det + "</span></td>" +
    '<td class="c-q">' + (v.qualifica ? e(v.qualifica) : '<span class="rg-nd">non indicata</span>') + "</td>" +
    '<td class="n c-op">' + e(v.operai == null ? "-" : v.operai) + '</td><td class="n c-or">' + e(num(v.ore)) + "</td>" +
    '<td class="n c-tot">' + e(ore(v.totale)) + "</td>" + (eu ? celleEuro(h, v) : "") +
    '<td class="c-de">' + (testo ? '<span class="rg-desc">' + e(testo) + "</span>" : "") + tag +
    (sub && !chiuso && v.id ? '<button type="button" class="rg-rip" data-si="' + (v.riportata ? "0" : "1") + '">' +
      (v.riportata ? "Togli dal committente" : "Riporta al committente") + "</button>" : "") + "</td>" +
    "</tr>";
}

function riepiloghi(h, s, x) {
  const e = h.esc;
  const q = lista(x.per_qualifica), g = lista(x.per_gruppo);
  const totOp = q.reduce((a, r) => a + (Number(r.operai) || 0), 0);
  return '<div class="rg-riep"><div><h3>Per qualifica</h3><table class="rg-mini"><thead><tr><th>Qualifica</th><th class="n">Giornate-uomo</th><th class="n">Ore</th></tr></thead><tbody>' +
    q.map((r) => "<tr><td>" + e(r.qualifica) + '</td><td class="n">' + e(r.operai) + '</td><td class="n">' + e(ore(r.ore)) + "</td></tr>").join("") +
    '<tr class="tot"><td>Totale</td><td class="n">' + e(totOp) + '</td><td class="n">' + e(ore(x.ore)) + "</td></tr></tbody></table></div>" +
    "<div><h3>" + e(s.gruppo) + '</h3><table class="rg-mini"><thead><tr><th>' + (s.k === "sub" ? "Impresa" : e(s.chi)) + '</th><th class="n">Righe</th><th class="n">Ore</th></tr></thead><tbody>' +
    g.map((r) => "<tr><td>" + e(r.nome) + '</td><td class="n">' + e(r.righe) + '</td><td class="n">' + e(ore(r.ore)) + "</td></tr>").join("") +
    '<tr class="tot"><td>Totale</td><td class="n">' + e(x.n_righe) + '</td><td class="n">' + e(ore(x.ore)) + "</td></tr></tbody></table></div></div>";
}

// ---------------------------------------------------------------------------- euro, mezzi e prezzi (03/11/2026, mezzi-1)
// riga di un mezzo o di un'attrezzatura in economia, sotto la manodopera del giorno
function rigaMezzo(h, v, bloccato) {
  const e = h.esc, tipo = v.scheda === "attrezzatura" ? "Attrezzatura" : "Automezzo o macchina";
  const dati = JSON.stringify({ id: v.id, data: v.data, mezzo_id: v.mezzo_id, quantita: num(v.quantita), descrizione: v.descrizione || "" });
  return '<tr class="rg-row rg-mz" data-mz="' + e(dati) + '">' +
    '<td class="c-sq"><b class="rg-mzn">' + e(v.nome) + "</b>" + (v.con_operatore ? '<span class="rg-op">con operatore</span>' : "") +
    '<span class="m-det">' + e(tipo) + " · " + e(quantita(v.quantita, v.unita)) + " · " + (v.prezzo == null ? "prezzo mancante" : e(euro(v.importo))) + "</span></td>" +
    '<td class="c-q">' + e(v.tipo || tipo) + '</td><td class="n c-op">-</td><td class="n c-or">-</td>' +
    '<td class="n c-tot">' + e(quantita(v.quantita, v.unita)) + "</td>" + celleEuro(h, v) +
    '<td class="c-de">' + (v.descrizione ? '<span class="rg-desc">' + e(v.descrizione) + "</span>" : "") +
    '<span class="rg-fo">Scritto dall\'ufficio' + (v.autore ? " · " + e(v.autore) : "") + "</span>" +
    (v.mezzo_tolto ? '<span class="rg-tag">Tolto dall\'elenco dei mezzi</span>' : "") +
    (bloccato ? "" : '<span class="rg-mz-az"><button type="button" class="rg-rip rg-mz-mod">Correggi</button><button type="button" class="rg-rip rg-mz-tog">Togli</button></span>') +
    "</td></tr>";
}

// righe senza prezzo e promemoria sui mezzi con operatore
function avvisiEuro(base, h, p, d) {
  const e = h.esc, im = d.importi || {};
  const senza = (Number(im.manodopera_senza_prezzo) || 0) + (Number(im.mezzi_senza_prezzo) || 0);
  const conOp = lista(d.mezzi).some((m) => m.con_operatore);
  // 03/11/2026 (mezzi-3): prezzi del contratto d'appalto del cantiere: riferimento in vista, oppure l'invito a scriverli
  const rif = d.contratto && d.contratto.riferimento ? String(d.contratto.riferimento) : "";
  const conContratto = lista(d.prezzi_cantiere).length > 0;
  const contratto = conContratto || rif
    ? '<p class="rg-contr"><b>Prezzi da contratto d\'appalto</b>' + (rif ? ": " + e(rif) : "") +
      (conContratto ? "" : " · nessun prezzo scritto: vale il listino dell'impresa") + "</p>"
    : (d.chiuso || d.puo_modificare !== true ? "" :
      '<p class="rg-avv rg-avv-c"><b>Questo cantiere usa il listino dell\'impresa.</b> Se il contratto d\'appalto prevede prezzi diversi per le ore in economia (per esempio 28 €/ora invece di 35), scrivili qui: valgono solo per questo cantiere. ' +
      '<button type="button" class="rg-b rg-pr" id="rg-apri-contratto">Scrivi i prezzi del contratto</button></p>');
  return contratto + (senza ? '<p class="rg-avv"><b>' + senza + (senza === 1 ? " riga senza prezzo" : " righe senza prezzo") + "</b>: non entrano nei totali in euro. " +
      'Scrivi i prezzi di base in <a href="' + e(base + "/mezzi?t=" + p.tok) + '">Mezzi e attrezzature</a> (anche quello per le ore senza qualifica), oppure quelli del contratto di questo cantiere in «Prezzi del contratto d\'appalto».</p>' : "") +
    (conOp ? '<p class="rg-nota">I mezzi «con operatore» comprendono chi li guida: le sue ore non vanno scritte anche tra la manodopera.</p>' : "");
}

// «+ Mezzo in economia» e «Prezzi di questo cantiere» (solo l'ufficio, cantiere aperto)
function moduliEuro(base, h, p, d) {
  const e = h.esc;
  if (d.chiuso || d.puo_modificare !== true) return "";
  const el = lista(d.mezzi_elenco);
  const opz = (k, t) => {
    const a = el.filter((m) => m.scheda === k);
    return a.length ? '<optgroup label="' + e(t) + '">' + a.map((m) => '<option value="' + e(m.id) + '" data-u="' + e(m.unita) + '">' + e(m.nome) +
      " · " + e(m.prezzo == null ? "prezzo da scrivere" : euro(m.prezzo) + " " + (UNITA[m.unita] || UNITA.ora)[2]) + "</option>").join("") + "</optgroup>" : "";
  };
  const oggi = String(d.oggi || ""), primo = d.mese + "-01";
  const giorno = d.corrente ? oggi : (d.mese + "-" + String(new Date(Date.UTC(Number(d.mese.slice(0, 4)), Number(d.mese.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0"));
  // 03/11/2026 (economie-diario-1, Filippo): con le economie dal Diario accese il Registro è solo da leggere, tranne i prezzi
  const mezzo = d.solo_diario === true
    ? '<p class="rg-nota rg-diario">Le economie si inseriscono e si correggono solo dal <b>Diario</b> del giorno: «+ Aggiungi una voce» → «Economie extracontrattuali», con manodopera, mezzi e attrezzature. Qui si leggono, si stampano e si scrivono i prezzi.</p>'
    : '<details class="rg-dt-box" id="rg-mz-box"><summary>+ Mezzo o attrezzatura in economia</summary>' +
    (el.length
      ? '<div class="rg-form"><input type="hidden" id="mz-id" value="">' +
        '<label>Giorno<input type="date" id="mz-data" min="' + e(primo) + '" max="' + e(oggi) + '" value="' + e(giorno) + '"></label>' +
        '<label class="lar">Mezzo o attrezzatura<select id="mz-mezzo"><option value="">Scegli…</option>' + opz("mezzo", "Automezzi e macchine") + opz("attrezzatura", "Attrezzature") + "</select></label>" +
        '<label>Quantità <small id="mz-un">ore</small><input id="mz-q" inputmode="decimal" maxlength="8" placeholder="es. 3"></label>' +
        '<label class="lar">Descrizione <small>facoltativa</small><input id="mz-de" maxlength="300" placeholder="es. Demolizione muro lato nord"></label>' +
        '<div class="rg-form-az"><button type="button" class="rg-b rg-pr" id="mz-salva">Salva</button><button type="button" class="rg-b" id="mz-annulla">Annulla</button></div>' +
        '<p class="rg-msg" id="mz-msg" aria-live="polite"></p></div>'
      : '<p class="rg-nota">Prima aggiungi i mezzi e le attrezzature dell\'impresa in <a href="' + e(base + "/mezzi?t=" + p.tok) + '">Mezzi e attrezzature</a>.</p>') +
    "</details>";
  // prezzi: qualifiche e mezzi, con il prezzo di base e quello concordato per questo cantiere (se c'è)
  const conc = lista(d.prezzi_cantiere);
  const baseMezzo = (m) => { const c = conc.find((x) => x.voce === "mezzo" && x.mezzo_id === m.id); return c ? c.base : m.prezzo; };
  const voci = lista(d.qualifiche).map((q) => ({ voce: "qualifica", k: q.qualifica, nome: q.etichetta, u: "all'ora", base: q.base, conc: q.origine === "concordato" ? q.prezzo : null }))
    .concat(el.map((m) => ({ voce: "mezzo", k: m.id, nome: m.nome, u: (UNITA[m.unita] || UNITA.ora)[2], base: baseMezzo(m), conc: m.origine === "concordato" ? m.prezzo : null })));
  // 03/11/2026 (mezzi-3): «Prezzi del contratto d'appalto»: riferimento del contratto, un prezzo per tutte le qualifiche, poi
  // manodopera e mezzi voce per voce
  const rif = d.contratto && d.contratto.riferimento ? String(d.contratto.riferimento) : "";
  const riga = (v) => "<tr><td>" + e(v.nome) + ' <span class="rg-u">' + e(v.u) + '</span></td><td class="n">' + e(v.base == null ? "-" : euro(v.base)) + "</td>" +
    '<td class="n"><input class="rg-pz-in" inputmode="decimal" maxlength="12" data-voce="' + e(v.voce) + '" data-k="' + e(v.k) + '" data-prima="' + e(v.conc == null ? "" : num(v.conc)) + '" value="' + e(v.conc == null ? "" : num(v.conc)) + '" placeholder="come listino" aria-label="Prezzo da contratto ' + e(v.nome) + '"></td></tr>';
  const man = voci.filter((v) => v.voce === "qualifica"), mz = voci.filter((v) => v.voce === "mezzo");
  const prezzi = '<details class="rg-dt-box" id="rg-pz-box">' + "<summary>Prezzi del contratto d'appalto di questo cantiere" + (conc.length ? " · " + conc.length + (conc.length === 1 ? " prezzo" : " prezzi") : "") + "</summary>" +
    '<p class="rg-nota">I prezzi delle economie previsti dal contratto d\'appalto di questo cantiere. Valgono solo qui e prendono il posto del listino dell\'impresa per tutte le economie del cantiere, anche quelle già scritte. Se più avanti il contratto cambia (per esempio un atto aggiuntivo), il prezzo nuovo vale da quel giorno in poi. Lascia vuoto per usare il listino. Prezzi + IVA.</p>' +
    '<div class="rg-form rg-pz-testa"><label class="lar">Riferimento del contratto <small>compare nel registro, nella stampa e nell\'Excel</small><input id="pz-rif" maxlength="300" value="' + e(rif) + '" data-prima="' + e(rif) + '" placeholder="es. Contratto n. 45 del 12/09/2026, art. 18 del capitolato"></label>' +
    '<label>Stesso prezzo per tutte le qualifiche <small>€/ora + IVA</small><input id="pz-tutti" inputmode="decimal" maxlength="12" placeholder="es. 28"></label>' +
    '<div class="rg-pz-app"><button type="button" class="rg-b" id="pz-applica">Applica a tutte le qualifiche</button></div></div>' +
    '<div class="rg-tw"><table class="rg-mini rg-pz"><thead><tr><th>Manodopera</th><th class="n">Listino dell\'impresa</th><th class="n">Da contratto d\'appalto</th></tr></thead><tbody>' + man.map(riga).join("") + "</tbody>" +
    (mz.length ? '<thead><tr><th>Mezzi e attrezzature</th><th class="n">Listino dell\'impresa</th><th class="n">Da contratto d\'appalto</th></tr></thead><tbody>' + mz.map(riga).join("") + "</tbody>" : "") +
    "</table></div>" +
    '<div class="rg-form-az"><button type="button" class="rg-b rg-pr" id="pz-salva">Salva i prezzi del contratto</button></div><p class="rg-msg" id="pz-msg" aria-live="polite"></p></details>';
  return '<div class="rg-moduli">' + mezzo + prezzi + "</div>";
}

// riepilogo del mese dei mezzi e delle attrezzature
function riepilogoMezzi(h, d) {
  const e = h.esc, per = {}, ordine = [];
  lista(d.mezzi).forEach((m) => {
    if (!(m.mezzo_id in per)) { per[m.mezzo_id] = { nome: m.nome, scheda: m.scheda, unita: m.unita, q: 0, imp: 0, senza: false }; ordine.push(m.mezzo_id); }
    const r = per[m.mezzo_id];
    r.q += Number(m.quantita) || 0;
    if (m.importo == null) r.senza = true; else r.imp += Number(m.importo) || 0;
  });
  const im = d.importi || {};
  return '<div class="rg-riep rg-riep1"><div><h3>Mezzi e attrezzature</h3><table class="rg-mini"><thead><tr><th>Mezzo o attrezzatura</th><th class="n">Quantità</th><th class="n">Importo</th></tr></thead><tbody>' +
    ordine.map((k) => { const r = per[k]; return "<tr><td>" + e(r.nome) + '</td><td class="n">' + e(quantita(r.q, r.unita)) + '</td><td class="n">' + e(euro(r.imp)) + (r.senza ? " *" : "") + "</td></tr>"; }).join("") +
    '<tr class="tot"><td>Totale</td><td class="n"></td><td class="n">' + e(euro((Number(im.mezzi) || 0) + (Number(im.attrezzature) || 0))) + "</td></tr></tbody></table>" +
    (ordine.some((k) => per[k].senza) ? '<p class="rg-nota">* alcune righe sono senza prezzo e non sono contate.</p>' : "") + "</div></div>";
}

// Scheda dei subappaltatori: la lista del mese di ogni impresa, da stampare e firmare (come prima)
function listeSub(base, h, p, d, x) {
  const e = h.esc;
  return '<div class="rg-liste"><h3>Liste del mese da firmare</h3>' +
    '<p class="rg-nota">Una lista per ogni subappaltatore: la firma lui, per accettazione la firma la tua impresa.</p>' +
    lista(x.per_gruppo).map((r) => '<div class="rg-lista"><div><b>' + e(r.nome) + "</b><span>" + e(r.righe) + (Number(r.righe) === 1 ? " riga" : " righe") + " · " + e(ore(r.ore)) +
      (Number(r.ore_riportate) > 0 ? " · riportate al committente " + e(ore(r.ore_riportate)) : "") + "</span></div>" +
      '<a class="rg-b" href="' + e(base + "/economie/stampa?t=" + p.tok + "&c=" + p.c + "&mese=" + d.mese + "&impresa=" + encodeURIComponent(r.nome)) + '" target="_blank" rel="noopener">Stampa o salva la lista in PDF</a></div>').join("") +
    "</div>";
}

// ---------------------------------------------------------------------------- foglio da stampare
// Foglio pulito della scheda scelta: intestazione dell'impresa, mese, cifre, tabella giorno per giorno, riepiloghi, piè TIX.
// Niente collegamenti nel foglio: il PDF può girare fuori dall'impresa e non deve portarsi dietro l'accesso.
function foglio(base, h, p, d) {
  const e = h.esc, s = SCHEDE.find((y) => y.k === p.scheda) || SCHEDE[0], x = parte(d, s.k), cant = d.cantiere || {};
  const eu = conEuro(d, s), im = (eu && d.importi) || {};
  const cols = colonne(s, eu), n = cols.length, prima = 4, dopo = n - prima - 1;
  const titolo = "Registro delle economie — " + s.foglio;
  // 03/11/2026 (mezzi-1): con gli euro, prezzo e importo di ogni riga, mezzi del giorno e totali in euro
  const celle = (v) => !eu ? "" : v.prezzo == null ? '<td class="n">mancante</td><td class="n">-</td>'
    : '<td class="n">' + e(euro(v.prezzo)) + (v.origine === "concordato" ? '<span class="fo">da contratto</span>' : "") + '</td><td class="n">' + e(euro(v.importo)) + "</td>";
  const tot = (cl, et, o, eur) => '<tr class="' + cl + '"><td colspan="' + prima + '">' + et + '</td><td class="n">' + e(eu || cl === "mt" ? ore(o) : num(o)) + "</td>" +
    (eu ? '<td></td><td class="n">' + e(euro(eur) || "0,00 €") + "</td><td></td>" : (dopo ? '<td colspan="' + dopo + '"></td>' : "")) + "</tr>";
  const rigaMz = (v) => "<tr><td><b>" + e(v.nome) + "</b>" + (v.con_operatore ? '<span class="fo">con operatore</span>' : "") + "</td><td>" + e(v.tipo || (v.scheda === "attrezzatura" ? "Attrezzatura" : "Automezzo o macchina")) + "</td>" +
    '<td class="n">-</td><td class="n">-</td><td class="n">' + e(quantita(v.quantita, v.unita)) + "</td>" + celle(v) +
    '<td><span class="de">' + e(v.descrizione || "") + '</span><span class="fo">Scritto dall\'ufficio</span></td></tr>';
  const corpo = (eu ? perGiornoEuro(x, d) : perGiorno(x)).map((g) => {
    const gg = (d.giorni && d.giorni[g.data]) || {};
    const st = gg.firmato
      ? '<span class="st ok">Firmato dall\'ufficio</span>' + lista(gg.rapportini).map((r) => '<span class="fo">Rapportino n. ' + e(r.numero) +
          (Number(r.versione) > 1 ? " (versione " + e(r.versione) + ")" : "") + (r.registrato_il ? ", registrato il " + e(r.registrato_il) : "") + (r.autore ? " da " + e(r.autore) : "") + "</span>").join("")
      : '<span class="st da">Da confermare</span>';
    return '<tbody class="g"><tr class="gh"><th colspan="' + n + '">' + e(giornoLungo(g.data, true) + " " + g.data.slice(0, 4)) + st + "</th></tr>" +
      g.righe.map((v) => v._mz ? rigaMz(v) : "<tr><td>" + (s.k === "sub" ? "<b>" + e(v.impresa || "") + '</b><span class="fo">' + e(v.squadra || "-") + "</span>" : e(v.squadra || "-")) + "</td><td>" + e(v.qualifica || "-") + "</td>" +
        '<td class="n">' + e(v.operai == null ? "-" : v.operai) + '</td><td class="n">' + e(num(v.ore)) + '</td><td class="n">' + e(num(v.totale)) + "</td>" + celle(v) +
        '<td><span class="de">' + e(dettaglio(v, s)) + '</span><span class="fo">' + e(fonteTesto(v)) + "</span>" +
        (s.k === "committente" && v.riportata ? '<span class="fo">Riportata dal subappaltatore ' + e(v.impresa || "") + "</span>" : "") +
        (s.k === "sub" && v.riportata ? '<span class="fo">Riportata al committente</span>' : "") + "</td></tr>").join("") +
      tot("gt", "Totale del giorno", g.ore, g.euro) + "</tbody>";
  }).join("");
  const q = lista(x.per_qualifica), g = lista(x.per_gruppo);
  const cifre = eu ? [
    ["Manodopera · " + ore(im.manodopera_ore), euro(im.manodopera) || "0,00 €"],
    ["Automezzi e macchine", euro(im.mezzi) || "0,00 €"], ["Attrezzature", euro(im.attrezzature) || "0,00 €"],
    ["Totale del mese + IVA", euro(im.totale) || "0,00 €"]
  ] : [
    [s.k === "normali" ? "Ore normali" : "Ore in economia", ore(x.ore)], ["Giorni", String(x.giorni)], ["Registrazioni", String(x.n_righe)],
    ["Giorni firmati dall'ufficio", x.giorni_firmati + " su " + x.giorni]
  ].concat(Number(x.ore_riportate) > 0 ? [[s.k === "sub" ? "Riportate al committente" : "Riportate dai subappaltatori", ore(x.ore_riportate)]] : []);
  const senza = eu ? (Number(im.manodopera_senza_prezzo) || 0) + (Number(im.mezzi_senza_prezzo) || 0) : 0;
  const piede = e((d.impresa || "") + " · " + (cant.nome || "") + " · " + s.foglio + " · " + (d.mese_testo || ""));
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>" + e(titolo + " - " + (d.mese_testo || "") + " - " + (cant.nome || "")) + "</title><style>" + STILE_FOGLIO + "</style></head><body>" +
    '<div class="barra"><a href="' + e(base + "/economie?t=" + p.tok + "&c=" + p.c + "&mese=" + d.mese + "&scheda=" + s.k) + '">‹ Torna al registro</a>' +
    '<button type="button" onclick="window.print()">Stampa o salva in PDF</button></div>' +
    '<div class="carta"><table class="pagina"><tfoot><tr><td><div class="spazio"></div></td></tr></tfoot><tbody><tr><td>' +
    (typeof d.intestazione === "string" ? d.intestazione : "") +
    "<h1>" + e(titolo) + "</h1>" +
    '<p class="sotto">' + e((d.mese_testo || "") + " · " + aggiornato(d) + (d.corrente ? " (mese in corso)" : "")) + "</p>" +
    '<table class="dati"><tr><td class="et">Cantiere</td><td>' + e(cant.nome || "-") + '</td><td class="et">Ubicazione</td><td>' + e(cant.ubicazione || "-") + "</td></tr>" +
    '<tr><td class="et">Committente</td><td>' + e(cant.committente || "-") + '</td><td class="et">Direzione Lavori</td><td>' + e(cant.direttore_lavori || "-") + "</td></tr></table>" +
    '<div class="cifre">' + cifre.map((c) => "<div><b>" + e(c[1]) + "</b><span>" + e(c[0]) + "</span></div>").join("") + "</div>" +
    (eu && d.contratto && d.contratto.riferimento ? '<p class="sotto"><b>Prezzi da contratto d\'appalto:</b> ' + e(d.contratto.riferimento) + "</p>" : "") +
    (senza ? '<p class="nota">' + e(senza + (senza === 1 ? " riga è senza prezzo" : " righe sono senza prezzo") + " e non sono contate nei totali in euro. Prezzi + IVA.") + "</p>" : "") +
    (x.n_righe || (eu && lista(d.mezzi).length)
      ? '<table class="t"><thead><tr>' + cols.map((c, i) => "<th" + ((i >= prima - 2 && i <= prima) || (eu && (i === 5 || i === 6)) ? ' class="n"' : "") + ">" + e(c) + "</th>").join("") + "</tr></thead>" + corpo +
        "<tbody>" + tot("mt", "Totale del mese" + (eu ? " + IVA" : ""), x.ore, im.totale) + "</tbody></table>" +
        '<div class="riep"><div><h2>Per qualifica</h2><table class="t"><thead><tr><th>Qualifica</th><th class="n">Giornate-uomo</th><th class="n">Ore</th></tr></thead><tbody>' +
        q.map((r) => "<tr><td>" + e(r.qualifica) + '</td><td class="n">' + e(r.operai) + '</td><td class="n">' + e(num(r.ore)) + "</td></tr>").join("") + "</tbody></table></div>" +
        "<div><h2>" + e(s.gruppo) + '</h2><table class="t"><thead><tr><th>' + (s.k === "sub" ? "Impresa" : e(s.chi)) + '</th><th class="n">Righe</th><th class="n">Ore</th></tr></thead><tbody>' +
        g.map((r) => "<tr><td>" + e(r.nome) + '</td><td class="n">' + e(r.righe) + '</td><td class="n">' + e(num(r.ore)) + "</td></tr>").join("") + "</tbody></table></div></div>"
      : '<p class="sotto">Nessuna riga in questo mese.</p>') +
    '<p class="nota">' + e(s.k === "normali"
      ? "Giorni firmati dall'ufficio: righe «Ore normali» del rapportino del giorno registrato. Giorni da confermare: timbrature, arrotondate alla mezz'ora come nella bozza del rapportino."
      : "Giorni firmati dall'ufficio: righe del rapportino del giorno registrato. Giorni da confermare: messaggi WhatsApp del cantiere. Se il rapportino firmato non contiene le righe arrivate da WhatsApp, contano anche quelle.") + "</p>" +
    "</td></tr></tbody></table>" +
    '<div class="piede"><span>' + piede + '</span><span class="tix">Prodotto con <img src="' + e(base) + '/marchio-tix.png" alt="TIX"> · www.tixcantiere.it</span></div></div>' +
    '<script>addEventListener("load",function(){setTimeout(function(){window.print();},400);});</script></body></html>';
}

const STILE =
  ":root{--t:#1b1f1d;--s:#5b6560;--b:#f4f6f5;--c:#fff;--l:#dfe5e2;--ar:#1B2F4A;--z:#F5F7FA}" +
  "@media (prefers-color-scheme:dark){:root{--t:#eef2f0;--s:#a9b3ae;--b:#111513;--c:#1a201d;--l:#2c3531;--ar:#cfe0ff;--z:#161c1a}}" +
  "*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--b);color:var(--t)}" +
  "main{max-width:960px;margin:0 auto;padding:20px 12px 40px}" +
  // 31/10/2026 (Filippo): sul computer la pagina è larga fino a 1600 px (dal 03/11/2026), come le schede del cantiere
  "@media screen and (min-width:760px){main{max-width:min(1600px,calc(100vw - 48px))}}@media screen and (min-width:900px){main{max-width:min(1600px,calc(100vw - 96px))}}" +
  // «Torna al cantiere» su una pastiglia: si legge sia sul fondo chiaro dello strato premium sia nel tema scuro senza premium
  ".rg-torna{display:inline-block;margin:0 0 12px;padding:6px 14px;border-radius:999px;border:1px solid var(--l);background:var(--c);color:var(--ar);font-weight:600;text-decoration:none}" +
  // cornice sfumata blu TIX → arancione, come le altre pagine del cantiere (30/10/2026)
  ".rg-card{position:relative;background:var(--c);border:1px solid transparent;border-radius:16px;padding:18px 18px 16px}" +
  ".rg-card::before{content:\"\";position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#F26A10);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}" +
  "@media (prefers-color-scheme:dark){.rg-card::before{background:linear-gradient(135deg,#6F8FBF,#F26A10)}}" +
  ".rg-testa{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 6px}" +
  ".rg-testa p{margin:0;font-size:.88rem;color:var(--s)}.rg-testa h1{margin:2px 0 0;font-size:1.35rem;color:var(--ar)}" +
  ".rg-testa p.rg-sott{margin:3px 0 0;font-size:.86rem}" +
  ".rg-mese select{font:inherit;padding:8px 10px;border:1px solid var(--l);border-radius:10px;background:var(--c);color:var(--t)}" +
  ".rg-agg{margin:0 0 14px;font-size:.86rem;color:var(--s)}.rg-agg b{color:var(--t);text-transform:capitalize}" +
  ".rg-chiuso{margin:0 0 12px;padding:8px 12px;border-radius:10px;background:var(--z);font-size:.88rem}" +
  // schede: tre interruttori in una riga, senza ricaricare la pagina
  ".rg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}" +
  ".rg-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:4px;margin:0 0 16px;border-radius:14px;background:var(--z);border:1px solid var(--l)}" +
  ".rg-tabs label{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:56px;padding:6px 4px;border-radius:10px;cursor:pointer;text-align:center;font-weight:700;font-size:.92rem;line-height:1.2;color:var(--ar);-webkit-tap-highlight-color:transparent}" +
  ".rg-tabs label b{font-size:.8rem;font-weight:600;color:var(--s)}" +
  "#rg-s-committente:checked~.rg-tabs label[for=rg-s-committente],#rg-s-sub:checked~.rg-tabs label[for=rg-s-sub],#rg-s-normali:checked~.rg-tabs label[for=rg-s-normali]{background:#1B2F4A;color:#fff;box-shadow:0 6px 14px -8px rgba(27,47,74,.75)}" +
  "#rg-s-committente:checked~.rg-tabs label[for=rg-s-committente] b,#rg-s-sub:checked~.rg-tabs label[for=rg-s-sub] b,#rg-s-normali:checked~.rg-tabs label[for=rg-s-normali] b{color:rgba(255,255,255,.82)}" +
  "#rg-s-committente:focus-visible~.rg-tabs label[for=rg-s-committente],#rg-s-sub:focus-visible~.rg-tabs label[for=rg-s-sub],#rg-s-normali:focus-visible~.rg-tabs label[for=rg-s-normali]{outline:3px solid #F26A10;outline-offset:2px}" +
  ".rg-pan{display:none}#rg-s-committente:checked~#rg-p-committente,#rg-s-sub:checked~#rg-p-sub,#rg-s-normali:checked~#rg-p-normali{display:block}" +
  ".rg-spiega{font-size:.92rem;color:var(--s);line-height:1.45;margin:0 0 12px}" +
  ".rg-wa{margin:0 0 12px;padding:10px 12px;border-radius:10px;background:#E8F4EC;color:#1b1f1d;font-size:.88rem;line-height:1.45}.rg-wa b{color:#1D6F42}" +
  ".rg-cifre{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 10px}" +
  ".rg-cifre div{border:1px solid var(--l);border-radius:12px;padding:10px 12px;background:var(--c)}" +
  ".rg-cifre b{display:block;font-size:1.3rem;line-height:1.25;color:var(--ar)}.rg-cifre span{font-size:.8rem;color:var(--s)}" +
  ".rg-nota{margin:0 0 10px;font-size:.84rem;color:var(--s)}" +
  ".rg-az{display:flex;gap:10px;flex-wrap:wrap;margin:4px 0 14px}" +
  ".rg-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;padding:0 16px;border-radius:10px;border:1px solid #1B2F4A;background:var(--c);color:var(--ar);font-weight:700;font-size:.92rem;text-decoration:none;text-align:center}" +
  ".rg-b:hover,.rg-b:focus-visible{background:#1B2F4A;color:#fff;outline:none}" +
  ".rg-b.rg-xl{border-color:#1D6F42;background:#E8F4EC;color:#1D6F42}.rg-b.rg-xl:hover,.rg-b.rg-xl:focus-visible{background:#1D6F42;color:#fff}" +
  "table.rg-t{width:100%;border-collapse:collapse;font-size:.9rem}" +
  ".rg-t th,.rg-t td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--l)}" +
  ".rg-t thead th{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--s);border-bottom:2px solid #1B2F4A;vertical-align:bottom}" +
  ".rg-t .n{text-align:right;white-space:nowrap}" +
  ".rg-gh th{background:var(--z);padding:10px 8px;font-size:.9rem;font-weight:400;line-height:1.7}" +
  ".rg-dt{font-weight:800;color:var(--ar);margin-right:10px}" +
  ".rg-st{display:inline-block;margin-right:8px;padding:1px 10px;border-radius:999px;font-size:.78rem;font-weight:700;line-height:1.6}" +
  ".rg-st.ok{background:#1B2F4A;color:#fff}.rg-st.da{background:#FFF3E8;color:#9A4308;border:1px solid #F7B98A}" +
  ".rg-rl{display:inline-block;font-size:.82rem;font-weight:600;color:var(--ar);margin-right:8px}.rg-chi{display:inline-block;font-size:.8rem;color:var(--s);margin-right:8px}" +
  ".rg-desc{display:block;margin:0 0 2px;white-space:pre-line}.rg-nd{color:var(--s);font-size:.82rem}" +
  // 03/11/2026 economie-foto-1: le foto allegate alle economie del giorno, dal Diario
  ".rg-ft{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center;vertical-align:middle;margin:2px 8px 0 0;font-size:.8rem;font-weight:600;color:var(--s)}" +
  ".rg-ft a{display:block;line-height:0}.rg-ft img{display:block;height:40px;width:auto;max-width:72px;object-fit:cover;border-radius:5px;border:1px solid var(--l)}" +
  ".rg-fo,.rg-tag{display:inline-block;margin:3px 6px 0 0;padding:0 8px;border-radius:999px;font-size:.74rem;line-height:1.7}" +
  ".rg-fo{background:var(--z);border:1px solid var(--l);color:var(--s)}.rg-tag{background:#FFF3E8;color:#9A4308;font-weight:700}.rg-tag[hidden]{display:none}" +
  ".m-det{display:none}" +
  ".rg-gt td{font-weight:700;color:var(--s);font-size:.86rem}.rg-gt td.n{color:var(--t)}" +
  ".rg-t tr.rg-mt td{font-weight:800;font-size:1rem;color:var(--ar);border-top:2px solid #1B2F4A;border-bottom:0;padding-top:10px}" +
  ".rg-imp{display:block}.rg-sq2{display:block;font-size:.84rem;font-weight:400;color:var(--s)}.rg-t td.c-sq{min-width:180px}.rg-t td.c-de{min-width:230px}" +
  ".rg-rip{display:block;margin-top:6px;min-height:36px;padding:0 12px;border-radius:10px;border:1px solid var(--l);background:var(--c);color:var(--t);font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;white-space:nowrap}" +
  ".rg-rip:hover{border-color:#1B2F4A}.rg-rip[disabled]{opacity:.6;cursor:wait}" +
  ".rg-vuoto{margin:10px 0;padding:14px;border:1px dashed var(--l);border-radius:12px;color:var(--s)}" +
  ".rg-riep{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:20px 0 0}" +
  ".rg-riep h3,.rg-liste h3{margin:0 0 6px;font-size:1rem;color:var(--ar)}" +
  "table.rg-mini{width:100%;border-collapse:collapse;font-size:.88rem}.rg-mini th,.rg-mini td{padding:6px;border-bottom:1px solid var(--l);text-align:left}" +
  ".rg-mini th{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--s)}.rg-mini .n{text-align:right;white-space:nowrap}" +
  ".rg-mini tr.tot td{font-weight:800;border-top:2px solid #1B2F4A;border-bottom:0}" +
  ".rg-liste{margin:22px 0 0}.rg-lista{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--l)}" +
  ".rg-lista span{display:block;font-size:.84rem;color:var(--s)}" +
  ".rg-fonti{margin:18px 0 0;font-size:.82rem;color:var(--s);line-height:1.45}" +
  ".rg-msg{font-size:.88rem;color:#b3261e;margin:0 0 10px}.rg-msg:empty{display:none}" +
  // 03/11/2026 (mezzi-1): euro, mezzi in economia (petrolio, il colore di «Mezzi e attrezzature») e prezzi del cantiere
  ".rg-cifre.rg-eu span{display:block}.rg-cifre.rg-eu div:last-child{background:linear-gradient(180deg,#24406A,#1B2F4A);border-color:#1B2F4A}" +
  ".rg-cifre.rg-eu div:last-child b,.rg-cifre.rg-eu div:last-child span{color:#fff}" +
  ".rg-avv{margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid #F7B98A;background:#FFF3E8;color:#9A4308;font-size:.88rem;line-height:1.45}.rg-avv a{color:#9A4308;font-weight:700}" +
  ".rg-manca{font-size:.78rem;font-weight:700;color:#9A4308;white-space:normal}.rg-conc{display:block;font-size:.7rem;font-weight:700;color:#9A4308}" +
  ".rg-op{display:block;font-size:.78rem;color:#0B6E79}.rg-mzn{color:#08505A}.rg-t tr.rg-mz td{background:rgba(231,244,245,.5)}" +
  ".rg-mz-az{display:flex;gap:6px;flex-wrap:wrap}.rg-mz-az .rg-rip{display:inline-block}" +
  ".rg-moduli{display:grid;gap:10px;margin:0 0 14px}" +
  ".rg-dt-box{border:1px solid var(--l);border-radius:12px;background:var(--c);padding:0 14px}.rg-dt-box[open]{padding-bottom:12px}" +
  ".rg-dt-box summary{cursor:pointer;padding:12px 0;font-weight:700;color:#0B6E79;list-style:none}.rg-dt-box summary::-webkit-details-marker{display:none}" +
  ".rg-dt-box summary::before{content:'\\25B8  '}.rg-dt-box[open] summary::before{content:'\\25BE  '}" +
  ".rg-form{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;align-items:end}" +
  ".rg-form label{display:flex;flex-direction:column;gap:4px;font-size:.84rem;font-weight:700}.rg-form label.lar{grid-column:span 2}.rg-form small{font-weight:500;color:var(--s)}" +
  ".rg-form input,.rg-form select,.rg-pz-in{font:inherit;min-height:40px;padding:6px 10px;border:1px solid var(--l);border-radius:10px;background:var(--c);color:var(--t)}" +
  ".rg-form-az{display:flex;gap:8px;flex-wrap:wrap;grid-column:1/-1;margin-top:8px}.rg-b.rg-pr{background:#0B6E79;border-color:#0B6E79;color:#fff}.rg-b.rg-pr:hover{background:#08505A}" +
  ".rg-msg.inf{color:var(--s)}.rg-contr{margin:0 0 10px;padding:8px 12px;border-radius:10px;border:1px solid #F7B98A;background:#FFFBF7;font-size:.88rem;color:var(--t)}.rg-contr b{color:#9A4308}" +
  ".rg-avv-c{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.rg-avv-c .rg-b{flex:none}" +
  ".rg-pz-testa{margin:4px 0 10px}.rg-pz-app{display:flex;align-items:flex-end}.rg-pz thead+tbody+thead th{padding-top:14px}" +
  ".rg-pz-in{width:9em;text-align:right}.rg-u{font-size:.78rem;color:var(--s)}.rg-pz td{vertical-align:middle}.rg-riep1{grid-template-columns:minmax(0,1fr)}" +
  "@media (max-width:680px){.rg-t td.c-pr,.rg-t td.c-im{display:none}.rg-mz-az .rg-rip{width:auto;flex:1}.rg-form{grid-template-columns:minmax(0,1fr)}.rg-form label.lar{grid-column:auto}.rg-pz-in{width:7em}}" +
  "@media (max-width:680px){.rg-cifre{grid-template-columns:repeat(2,minmax(0,1fr))}.rg-riep{grid-template-columns:minmax(0,1fr)}.rg-az .rg-b{flex:1 1 100%}" +
  // sul telefono la tabella diventa un elenco di righe
  ".rg-t thead{display:none}.rg-t,.rg-t tbody,.rg-t tfoot,.rg-t tr,.rg-t th,.rg-t td{display:block;width:100%}" +
  ".rg-t tr.rg-gh{margin-top:12px}.rg-t tr.rg-gh th{border-radius:10px;border:0}" +
  ".rg-t tr.rg-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:10px 2px;border-bottom:1px solid var(--l)}" +
  ".rg-t tr.rg-row td{padding:0;border:0;width:auto}.rg-t td.c-q,.rg-t td.c-op,.rg-t td.c-or{display:none}" +
  ".rg-t td.c-sq{grid-column:1;font-weight:600}.rg-t td.c-tot{grid-column:2;grid-row:1;font-weight:800;color:var(--ar)}" +
  ".rg-t td.c-de{grid-column:1/-1;min-width:0}.rg-t td.c-sq{min-width:0}.rg-rip{width:100%}" +
  ".m-det{display:block;font-weight:400;font-size:.84rem;color:var(--s)}" +
  ".rg-t tr.rg-gt,.rg-t tr.rg-mt{display:flex;justify-content:space-between;gap:10px}.rg-t tr.rg-gt td,.rg-t tr.rg-mt td{width:auto;border:0;padding:8px 2px}" +
  ".rg-t tr.rg-gt td:empty,.rg-t tr.rg-mt td:empty{display:none}.rg-t tr.rg-mt{border-top:2px solid #1B2F4A}}" +
  "@media print{.rg-torna,.rg-mese,.rg-tabs,.rg-az,.rg-rip,.rg-liste .rg-b{display:none!important}.rg-card::before{display:none}body{background:#fff}}";

const STILE_FOGLIO =
  "@page{size:A4;margin:10mm 9mm 10mm}*{box-sizing:border-box}html,body{background:#fff}" +
  "body{margin:0;font-family:Helvetica,Arial,sans-serif;font-size:9.4pt;line-height:1.4;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
  // lo strato «premium» del portale (src/stile-premium.js) dà al body un fondo sfumato e i caratteri di sistema: sul foglio no
  "html body{background:#fff!important;font-family:Helvetica,Arial,sans-serif!important;letter-spacing:normal!important}h1,h2{letter-spacing:normal!important}" +
  ".barra{display:flex;gap:16px;justify-content:center;align-items:center;padding:12px;background:#F4F6F8;border-bottom:1px solid #dde3ea;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
  ".barra a{color:#1B2F4A;font-weight:600}.barra button{font:inherit;font-weight:700;padding:10px 18px;border-radius:10px;border:0;background:#1B2F4A;color:#fff;cursor:pointer}" +
  ".carta{max-width:200mm;margin:0 auto;padding:8mm 6mm}" +
  "table.pagina{width:100%;border-collapse:collapse}table.pagina>tbody>tr>td,table.pagina>tfoot>tr>td{padding:0;border:0}.spazio{height:0}" +
  "h1{font-size:15pt;line-height:1.25;color:#1B2F4A;margin:2mm 0 1mm}h2{font-size:10.5pt;color:#1B2F4A;margin:4mm 0 1.5mm}" +
  ".sotto{color:#444;margin:0 0 3mm;font-size:9pt}" +
  "table.dati{width:100%;border-collapse:collapse;margin:0 0 3mm}table.dati td{padding:.8mm 2mm .8mm 0;vertical-align:top;font-size:9pt}" +
  "table.dati td.et{color:#666;font-size:7.4pt;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;width:1%}" +
  ".cifre{display:flex;gap:2mm;margin:0 0 3mm}.cifre div{flex:1;border:.8pt solid #cdd4dd;border-radius:2mm;padding:1.8mm;text-align:center}" +
  ".cifre b{display:block;font-size:12.5pt;color:#1B2F4A}.cifre span{font-size:7.2pt;color:#444}" +
  "table.t{width:100%;border-collapse:collapse;margin:1mm 0 3mm}" +
  "table.t th{text-align:left;font-size:6.8pt;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#444;border-bottom:.9pt solid #1B2F4A;padding:1.2mm 1.4mm;vertical-align:bottom}" +
  "table.t td{border-bottom:.5pt solid #d3d8de;padding:1mm 1.4mm;vertical-align:top;font-size:8.5pt}" +
  "table.t tr{break-inside:avoid;page-break-inside:avoid}.n{text-align:right;white-space:nowrap}" +
  "tr.gh th{background:#EEF1F5;color:#1B2F4A;font-size:8.6pt;font-weight:700;text-transform:none;letter-spacing:0;border-bottom:.6pt solid #c9d1db;padding:1.4mm}" +
  "tr.gh{break-after:avoid;page-break-after:avoid}tr.gt td{font-weight:700;color:#333}" +
  "tr.mt td{font-weight:800;font-size:9.6pt;color:#1B2F4A;border-top:1.2pt solid #1B2F4A;border-bottom:0}" +
  ".st{display:inline-block;margin-left:2.5mm;padding:0 1.6mm;border-radius:1mm;font-size:7pt;font-weight:700}" +
  ".st.ok{background:#1B2F4A;color:#fff}.st.da{background:#FFF3E8;color:#9A4308;border:.5pt solid #F26A10}" +
  ".fo{display:inline-block;margin-left:2mm;color:#555;font-size:7.2pt;font-weight:400}td .fo{display:block;margin:0}.de{white-space:pre-line}" +
  ".riep{display:flex;gap:5mm}.riep>div{flex:1}" +
  ".nota{font-size:7.4pt;color:#444;margin:3mm 0 0}" +
  ".piede{display:flex;justify-content:space-between;align-items:center;gap:4mm;font-size:7pt;color:#333;border-top:.5pt solid #c9ced6;padding-top:2mm;margin-top:4mm;background:#fff}" +
  ".piede .tix{display:flex;align-items:center;gap:4px;white-space:nowrap}.piede img{height:9px;width:auto}" +
  "@media print{.barra{display:none}.carta{max-width:none;padding:0}.spazio{height:9mm}.piede{position:fixed;bottom:0;left:0;right:0;margin:0}}";

const SCRIPT = String.raw`(function(){try{
var CFG=__CFG__;
function metti(k,v,hash){try{var u=new URL(location.href);u.searchParams.set(k,v);if(hash)u.hash=hash;history.replaceState(null,'',u.toString());}catch(e){}}
var hid=document.getElementById('rg-sch');
document.querySelectorAll('input.rg-r').forEach(function(r){r.addEventListener('change',function(){if(!r.checked)return;metti('scheda',r.value);if(hid)hid.value=r.value;});});
var msg=document.getElementById('rg-msg');
function errore(b){b.disabled=false;if(msg)msg.textContent='Non è stato possibile salvare la scelta. Riprova tra qualche minuto.';}
document.querySelectorAll('.rg-rip').forEach(function(b){b.addEventListener('click',function(){
var tr=b.closest('tr'),id=tr?tr.getAttribute('data-id'):'',si=b.getAttribute('data-si')==='1';if(!id)return;
b.disabled=true;if(msg)msg.textContent='';
fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,id:id,si:si})})
.then(function(x){return x.json();}).then(function(j){if(!j||j.esito!=='ok'){errore(b);return;}
var tg=tr.querySelector('.rg-tag');if(tg)tg.hidden=!si;b.textContent='Salvato: aggiorno i totali…';
metti('scheda','sub','r-'+id);location.reload();}).catch(function(){errore(b);});});});
// 03/11/2026 (mezzi-1): mezzi in economia (aggiungi, correggi, togli) e prezzi concordati del cantiere
function q(i){return document.getElementById(i);}
function posta(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(x){return x.json();}).catch(function(){return null;});}
function torna(){metti('scheda','committente');location.reload();}
var box=q('rg-mz-box'),ms=q('mz-msg'),sel=q('mz-mezzo');
function unita(){if(!sel)return;var o=sel.options[sel.selectedIndex],u=o?o.getAttribute('data-u'):'';q('mz-un').textContent=u==='giorno'?'giornate':u==='mezza_giornata'?'mezze giornate':'ore';}
if(sel)sel.addEventListener('change',unita);
function pulisci(){q('mz-id').value='';q('mz-q').value='';q('mz-de').value='';sel.value='';unita();if(ms)ms.textContent='';q('mz-salva').textContent='Salva';}
if(q('mz-annulla'))q('mz-annulla').onclick=function(){pulisci();if(box)box.open=false;};
if(q('mz-salva'))q('mz-salva').onclick=function(){var b=this;b.disabled=true;if(ms)ms.textContent='';
posta(CFG.um,{t:CFG.t,c:CFG.c,dati:{id:q('mz-id').value,data:q('mz-data').value,mezzo_id:sel.value,quantita:q('mz-q').value,descrizione:q('mz-de').value}}).then(function(j){
b.disabled=false;if(j&&j.esito==='ok'){torna();return;}if(ms)ms.textContent=j&&j.messaggio?j.messaggio:'Non è stato possibile salvare. Riprova tra qualche minuto.';});};
function dati(b){var tr=b.closest('tr'),v={};try{v=JSON.parse(tr.getAttribute('data-mz'))||{};}catch(e){}return v;}
document.querySelectorAll('.rg-mz-mod').forEach(function(b){b.addEventListener('click',function(){var v=dati(b);if(!q('mz-id'))return;
q('mz-id').value=v.id||'';q('mz-data').value=v.data||'';sel.value=v.mezzo_id||'';unita();q('mz-q').value=String(v.quantita||'');q('mz-de').value=v.descrizione||'';
q('mz-salva').textContent='Salva la correzione';box.open=true;box.scrollIntoView({behavior:'smooth',block:'center'});});});
document.querySelectorAll('.rg-mz-tog').forEach(function(b){b.addEventListener('click',function(){var v=dati(b);
if(b.getAttribute('data-ok')!=='1'){b.setAttribute('data-ok','1');b.textContent='Confermi? Premi ancora';return;}
b.disabled=true;posta(CFG.um,{t:CFG.t,c:CFG.c,togli:true,dati:{id:v.id}}).then(function(j){if(j&&j.esito==='ok'){torna();return;}b.disabled=false;b.textContent='Non riuscito: riprova';});});});
// 03/11/2026 (mezzi-3): prezzi del contratto d'appalto: «Scrivi i prezzi del contratto» apre il riquadro; «Applica» copia lo
// stesso prezzo su tutte le qualifiche; «Salva» manda il riferimento (se cambiato) e i prezzi cambiati
var pzb=q('rg-pz-box');
if(q('rg-apri-contratto'))q('rg-apri-contratto').onclick=function(){if(!pzb)return;pzb.open=true;pzb.scrollIntoView({behavior:'smooth',block:'start'});var r=q('pz-rif');if(r)setTimeout(function(){r.focus();},300);};
if(q('pz-applica'))q('pz-applica').onclick=function(){var v=q('pz-tutti').value.trim();if(!v){q('pz-tutti').focus();return;}
document.querySelectorAll('.rg-pz-in[data-voce=qualifica]').forEach(function(i){i.value=v;});var pm=q('pz-msg');if(pm){pm.className='rg-msg inf';}if(pm)pm.textContent='Prezzo copiato su tutte le qualifiche: ora premi «Salva i prezzi del contratto».';};
if(q('pz-salva'))q('pz-salva').onclick=function(){var b=this,pm=q('pz-msg'),err=[],k=0,rif=q('pz-rif');
var ins=[].slice.call(document.querySelectorAll('.rg-pz-in')).filter(function(i){return i.value.trim().replace(',','.')!==i.getAttribute('data-prima').replace(',','.');});
var cambiaRif=rif&&rif.value.trim()!==rif.getAttribute('data-prima');
if(pm)pm.className='rg-msg';if(!ins.length&&!cambiaRif){if(pm)pm.textContent='Nessun prezzo cambiato.';return;}b.disabled=true;if(pm)pm.textContent='';
(cambiaRif?posta(CFG.up,{t:CFG.t,c:CFG.c,dati:{voce:'contratto',riferimento:rif.value.trim()}}).then(function(j){if(!j||j.esito!=='ok')err.push('Il riferimento del contratto non è stato salvato: riprova.');}):Promise.resolve()).then(function(){
(function va(){if(k>=ins.length){b.disabled=false;if(err.length){if(pm)pm.textContent=err.join(' ');}else torna();return;}
var i=ins[k++],vo=i.getAttribute('data-voce'),dd={voce:vo,prezzo:i.value.trim()};if(vo==='mezzo')dd.mezzo_id=i.getAttribute('data-k');else dd.qualifica=i.getAttribute('data-k');
posta(CFG.up,{t:CFG.t,c:CFG.c,dati:dd}).then(function(j){if(!j||j.esito!=='ok')err.push((j&&j.messaggio)||'Un prezzo non è stato salvato: riprova.');va();});})();});};
}catch(e){}})();`;

// Pulsante nella pagina del cantiere, accanto a «Persone del cantiere» e «Scarica in Excel».
export function economieIniezione(base, token, commessa) {
  // 29/10/2026 sera (Filippo): i tre pulsanti della pagina del cantiere in una riga sola, ordinati e della stessa misura
  // 02/11/2026 (registro-economie-1): il pulsante apre il Registro delle economie, in ogni cantiere
  const u = base + "/economie?t=" + token + "&c=" + encodeURIComponent(commessa);
  return "<style>" +
    ".gl-azioni{margin:12px 0 0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;align-items:stretch}" +
    ".gl-azioni>a,.gl-azioni>button{display:flex!important;align-items:center;justify-content:center;gap:8px;width:100%;min-height:46px!important;margin:0!important;padding:6px 10px!important;" +
    "border-radius:10px!important;font:inherit;font-size:.9rem!important;font-weight:700!important;line-height:1.2;text-align:center;text-decoration:none;box-sizing:border-box;white-space:normal}" +
    ".gl-ec-b{border:1px solid #1B2F4A;background:#EEF2F8;color:#1B2F4A}.gl-ec-b:hover,.gl-ec-b:focus-visible{background:#1B2F4A;color:#fff;outline:none}" +
    "@media (prefers-color-scheme:dark){.gl-ec-b{background:#1d2633;color:#cfe0ff;border-color:#3a4a63}}" +
    // sicurezza-1 (02/11/2026): con il quarto pulsante «Sicurezza» 4 colonne sul computer (riga larga come le schede, fino a
    // 1000 px), 2×2 fino a 900 px, 1 sul telefono
    ".gl-azioni.gl-az4{grid-template-columns:repeat(4,minmax(0,1fr))}@media (max-width:900px){.gl-azioni.gl-az4{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
    "@media screen and (min-width:901px){.gl-azioni.gl-az4{width:min(1600px,calc(100vw - 96px));max-width:none;margin-left:calc(50% - min(800px,calc(50vw - 48px)));box-sizing:border-box}}" +
    "@media (max-width:640px){.gl-azioni,.gl-azioni.gl-az4{grid-template-columns:minmax(0,1fr)}}" +
    // preventivi-1 (03/11/2026, chat 02B): con il quinto pulsante «Preventivi» 5 colonne sul computer, 3 fino a 900 px, 1 sul telefono
    ".gl-azioni.gl-az5{grid-template-columns:repeat(5,minmax(0,1fr))}@media (max-width:900px){.gl-azioni.gl-az5{grid-template-columns:repeat(3,minmax(0,1fr))}}" +
    "@media screen and (min-width:901px){.gl-azioni.gl-az5{width:min(1600px,calc(100vw - 96px));max-width:none;margin-left:calc(50% - min(800px,calc(50vw - 48px)));box-sizing:border-box}}" +
    "@media (max-width:640px){.gl-azioni.gl-az5{grid-template-columns:minmax(0,1fr)}}" +
    "</style>" +
    "<script>(function(){try{var e=document.createElement('a');e.className='gl-ec-b';e.href=" + JSON.stringify(u) + ";e.innerHTML='&#128221; Registro delle economie';" +
    "function riga(){var nav=document.querySelector('nav.schede');var r=document.querySelector('.gl-azioni');" +
    "if(!r){r=document.createElement('div');r.className='gl-azioni';if(nav&&nav.parentNode)nav.parentNode.insertBefore(r,nav.nextSibling);else document.body.insertBefore(r,document.body.firstChild);}" +
    "var p=document.querySelector('.gl-pc-b'),x=document.querySelector('.gl-xl-b'),s=document.querySelector('.gl-sc-b'),w=document.querySelector('.gl-pv-b');" +
    "[p,x,e,s,w].forEach(function(b){if(b)r.appendChild(b);});var n=r.children.length;r.classList.toggle('gl-az4',n===4||(!!s&&n<4));r.classList.toggle('gl-az5',n>=5);" +
    "document.querySelectorAll('.gl-pc-barra,.gl-xl-barra,.gl-sc-barra,.gl-pv-barra').forEach(function(v){if(!v.children.length)v.parentNode.removeChild(v);});}" +
    "riga();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',riga);setTimeout(riga,0);}catch(err){}})();</script>";
}
