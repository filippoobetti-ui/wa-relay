// ---------------------------------------------------------------------------
// Accesso professionisti (03/11/2026, chat 02A, «accesso-professionisti-1»): Direttore dei Lavori, CSE, ingegnere strutturista,
// committente. Entrano con email e password PERSONALI (tabelle prof_* del database) e vedono in sola lettura solo i cantieri in
// cui l'impresa li ha invitati da «Persone del cantiere», con le sezioni scelte (P1: Sicurezza; dal 04/11/2026, P2a: anche
// «DDT e documenti» e «Cronoprogramma», con l'interruttore impostazioni.professionisti_p2).
// «Porta separata»: il loro gettone non è mai un gettone dell'impresa (dashboard_accessi), quindi le pagine e le funzioni
// dell'impresa non lo riconoscono. Il gettone sta in un cookie HttpOnly (tix_prof), mai nell'indirizzo.
//   GET      /studio                               → i cantieri del professionista
//   GET      /studio/cantiere?c=…[&s=…]            → il cantiere, una sezione per volta (sicurezza / ddt / crono), in sola lettura
//   GET      /studio/file?c=…&d=…[&scarica=1]      → il file di un documento della Sicurezza (registrato in prof_registro)
//   GET      /studio/ddt?c=…&d=…[&scarica=1]       → la foto di un DDT (registrata in prof_registro)
//   GET      /studio/tavola?c=…&d=…[&scarica=1]    → il file di una tavola IN VIGORE dei Progetti (09/11/2026, registrato in
//                                                    prof_registro; se è solo su Drive la si riprende come per la Sicurezza)
//   GET      /studio/costruttivo?c=…&d=…[&scarica=1] → il PDF di un costruttivo di cui è chiesto il visto (09/11/2026, fase C2
//                                                    dei costruttivi dei fornitori, registrato in prof_registro)
//   POST     /studio/visto                         → la risposta di strutturista o DL: «Visto» oppure «Osservazioni» (09/11/2026:
//                                                    l'unica cosa che un professionista scrive; tutto in prof_registro e nello storico)
//   GET/POST /studio/password?c=…                  → scelta della password (invito o «Password dimenticata?»)
//   GET      /studio/esci                          → esce
// L'accesso con email e password passa da /accedi (index.js): prima portale_login, poi prof_login (studioAccedi).
// I documenti della Sicurezza arrivano dalle funzioni interne della chat 02 (_sicurezza_dati, _sicurezza_file,
// _sicurezza_recupero, pacchetto «sicurezza-2»): finché non ci sono la pagina dice «in arrivo».
// Interruttori: impostazioni.professionisti_attivo (no / prova / si) e variabile del Worker PROFESSIONISTI=off.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GETTONE = /^[0-9a-f]{64}$/;
const ATTESA_GIRI = 8;

function supabaseUrl(env) {
  return env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co";
}
function percorsoStorage(p) { return String(p).split("/").map(encodeURIComponent).join("/"); }

export function studioGettone(request) {
  const m = /(?:^|;\s*)tix_prof=([0-9a-f]{64})(?:;|$)/.exec(request.headers.get("Cookie") || "");
  return m ? m[1] : "";
}
function cookieImposta(base, tok) { return "tix_prof=" + tok + "; Path=" + base + "/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax"; }
function cookieTogli(base) { return "tix_prof=; Path=" + base + "/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"; }
function vai(url, cookie) {
  const hd = new Headers({ Location: url, "Cache-Control": "no-store" });
  if (cookie) hd.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers: hd });
}

// Da /accedi (index.js), quando portale_login risponde «no»: se email e password sono di un professionista entra qui.
export async function studioAccedi(env, base, email, password, rpc) {
  const r = await rpc(env, "prof_login", { p_email: email, p_password: password });
  if (r && r.esito === "ok" && GETTONE.test(r.token || "")) return { risposta: vai(base + "/studio", cookieImposta(base, r.token)) };
  return r || {};
}

export async function portaleStudio(request, env, base, inUrl, h) {
  if (env.PROFESSIONISTI === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  const sotto = inUrl.pathname.slice(base.length);
  if (sotto === "/studio/password") return password(request, env, base, inUrl, h);
  if (sotto === "/studio/visto") return visto(request, env, base, h, studioGettone(request));
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const tok = studioGettone(request);
  if (sotto === "/studio/esci") {
    if (tok) await h.rpc(env, "prof_esci", { p_token: tok }, 8000).catch(() => null);
    // 03/11/2026: «uscito» e non «esci», che nella pagina d'ingresso cancellerebbe anche l'accesso dell'impresa ricordato
    // dal browser (gl_portale_t): chi è anche utente di un'impresa torna lì, gli altri vedono la pagina d'ingresso.
    return vai(base + "/?uscito=1", cookieTogli(base));
  }
  if (!tok) return vai(base + "/");
  if (sotto === "/studio" || sotto === "/studio/") return elenco(request, env, base, h, tok);
  if (sotto === "/studio/cantiere") return cantiere(request, env, base, inUrl, h, tok);
  if (sotto === "/studio/file") return file(request, env, base, inUrl, h, tok);
  if (sotto === "/studio/ddt") return fileDdt(request, env, base, inUrl, h, tok);
  if (sotto === "/studio/tavola") return fileTavola(request, env, base, inUrl, h, tok);
  if (sotto === "/studio/costruttivo") return fileCostruttivo(request, env, base, inUrl, h, tok);
  return new Response("Not Found", { status: 404 });
}

// ---------------------------------------------------------------------------- elenco dei cantieri
async function elenco(request, env, base, h, tok) {
  const d = await h.rpc(env, "prof_cantieri", { p_token: tok }, 15000).catch(() => null);
  if (!d) return h.risposta(h.foglio(base, "Area professionisti", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", ""), 503);
  if (d.esito !== "ok") return vai(base + "/", cookieTogli(base));
  const e = h.esc, cant = d.cantieri || [];
  let corpo = "";
  if (!cant.length) {
    corpo += '<p class="nota">Per ora non hai cantieri. Quando un\'impresa ti dà accesso ai documenti di un cantiere ricevi un\'email e il cantiere compare qui.</p>';
  }
  for (const c of cant) {
    const sez = (c.sezioni || []).map((s) => SEZIONI[s] ? '<span class="chip ' + SEZIONI[s][1] + '">' + SEZIONI[s][0] + "</span>" : "").join("");
    corpo += '<a class="scheda" href="' + e(base + "/studio/cantiere?c=" + c.id) + '">' +
      '<div class="riga"><div class="nome">' + e(c.nome) + '</div>' +
      '<span class="avv">' + (c.da_vistare > 0 ? '<span class="nuovi vis">' + c.da_vistare + (c.da_vistare === 1 ? " costruttivo da vistare" : " costruttivi da vistare") + '</span>' : "") +
      (c.documenti_nuovi > 0 ? '<span class="nuovi">' + c.documenti_nuovi + (c.documenti_nuovi === 1 ? " documento nuovo" : " documenti nuovi") + '</span>' : "") + '</span></div>' +
      '<div class="sub">' + e(c.impresa || "") + (c.ubicazione ? " · " + e(c.ubicazione) : "") + '</div>' +
      '<div class="chips"><span class="chip">' + e(c.ruolo || "") + '</span>' + sez + (c.chiuso ? '<span class="chip">Cantiere chiuso</span>' : "") + '</div></a>';
  }
  corpo += '<p class="nota">Vedi e scarichi i documenti che l\'impresa ti ha aperto, ma non puoi cambiarli. L\'unica cosa che scrivi è il visto sui costruttivi, ' +
    'quando l\'impresa te lo chiede. TIX annota quando apri e scarichi un documento e quando rispondi.</p>';
  return pagina(request, base, h, "I tuoi cantieri", d.utente, "", corpo);
}

// ---------------------------------------------------------------------------- un cantiere
async function cantiere(request, env, base, inUrl, h, tok) {
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  if (!UUID.test(c)) return vai(base + "/studio");
  const el = await h.rpc(env, "prof_cantieri", { p_token: tok }, 15000).catch(() => null);
  if (!el) return h.risposta(h.foglio(base, "Area professionisti", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", ""), 503);
  if (el.esito !== "ok") return vai(base + "/", cookieTogli(base));
  const e = h.esc;
  const ca = (el.cantieri || []).find((x) => x.id === c);
  const torna = '<a class="torna" href="' + e(base + "/studio") + '">&larr; I tuoi cantieri</a>';
  if (!ca) {
    return pagina(request, base, h, "Cantiere non disponibile", el.utente, "",
      torna + '<p class="nota">Questo cantiere non è più tra quelli che puoi vedere: l\'impresa può aver tolto l\'accesso, oppure il cantiere è chiuso da più di 90 giorni.</p>', 404);
  }
  let corpo = torna;
  // 09/11/2026: costruttivi da vistare (solo strutturista e DL con una richiesta dell'impresa), sopra le sezioni
  const cv = await h.rpc(env, "prof_costruttivi", { p_token: tok, p_commessa: c }, 15000).catch(() => null);
  const conVisto = !!(cv && cv.esito === "ok" && (cv.costruttivi || []).length);
  if (conVisto) corpo += vistiRiquadro(base, c, cv, e, inUrl);
  // una sezione per volta: quella chiesta con ?s=, altrimenti la prima aperta (nell'ordine di _prof_sezioni)
  const sez = (ca.sezioni || []).filter((s) => SEZIONI[s]);
  const chiesta = String(inUrl.searchParams.get("s") || "");
  const s = sez.indexOf(chiesta) !== -1 ? chiesta : sez[0];
  if (sez.length > 1) {
    corpo += '<nav class="sezioni" aria-label="Sezioni del cantiere">' +sez.map((k) => '<a href="' + e(base + "/studio/cantiere?c=" + c + "&s=" + k) + '"' +
      (k === s ? ' class="on" aria-current="page"' : "") + ">" + SEZIONI[k][0] + "</a>").join("") + "</nav>";
  }
  if (s === "sicurezza") {
    const d = await h.rpc(env, "prof_sicurezza", { p_token: tok, p_commessa: c }, 15000).catch(() => null);
    corpo += sicurezza(base, c, d, e);
  } else if (s === "ddt") {
    const d = await h.rpc(env, "prof_ddt", { p_token: tok, p_commessa: c }, 15000).catch(() => null);
    corpo += ddt(base, c, d, e);
  } else if (s === "crono") {
    const d = await h.rpc(env, "prof_crono", { p_token: tok, p_commessa: c }, 15000).catch(() => null);
    corpo += crono(base, d);
  } else if (s === "progetti") {
    const d = await h.rpc(env, "prof_progetti", { p_token: tok, p_commessa: c }, 15000).catch(() => null);
    corpo += progetti(base, c, d, e);
  } else if (!conVisto) {
    corpo += '<p class="nota">L\'impresa non ti ha ancora aperto nessuna sezione di questo cantiere.</p>';
  }
  const sotto = e(ca.impresa || "") + (ca.ubicazione ? " · " + e(ca.ubicazione) : "") + " · " + e(ca.ruolo || "");
  return pagina(request, base, h, ca.nome, el.utente, sotto, corpo);
}

// le sezioni che le pagine conoscono: nome della scheda e classe del bollino nell'elenco dei cantieri
const SEZIONI = { sicurezza: ["Sicurezza", "sic"], ddt: ["DDT e documenti", "ddt"], crono: ["Cronoprogramma", "cro"], progetti: ["Progetti", "pro"] };

const STATI = { da_verificare: ["Da verificare", "st-am"], visto_cse: ["Visto dal CSE", "st-ok"], superato: ["Superato", "st-gr"] };
function giorno(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] : ""; }
function quando(s) { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] + " alle " + m[4] + ":" + m[5] : giorno(s); }

function sicurezza(base, c, d, e) {
  let h = '<section class="scheda"><div class="riga"><h2 class="sz"><span class="ic-sic" aria-hidden="true">&#129466;</span>Sicurezza del cantiere</h2><span class="chip">Sola lettura</span></div>';
  if (!d) return h + '<p class="nota">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p></section>';
  if (d.esito === "in_arrivo") return h + '<p class="nota">I documenti della Sicurezza di questo cantiere saranno visibili qui a breve.</p></section>';
  if (d.esito !== "ok") return h + '<p class="nota">La Sicurezza di questo cantiere non è disponibile in questo momento.</p></section>';
  const cc = d.cantiere || {};
  const chi = [["CSE", cc.cse], ["Direzione Lavori", cc.dl], ["CSP", cc.csp]].filter((x) => x[1]).map((x) => x[0] + ": <b>" + e(x[1]) + "</b>").join(" · ");
  if (chi) h += '<p class="sub">' + chi + '</p>';
  const tipi = d.tipi || [], docs = (d.documenti || []).filter((x) => !x.annullato_il);
  const nomeTipo = (k) => { const t = tipi.find((x) => x.chiave === k); return t ? (t.breve || t.etichetta || k) : k; };
  // avvisi: imprese senza POS, idoneità o DURC in TIX; documenti scaduti o in scadenza
  const avv = [];
  for (const i of d.imprese || []) if (i.manca && i.manca.length) avv.push("<b>" + e(i.nome) + "</b>: in TIX manca " + i.manca.map((k) => e(nomeTipo(k))).join(", "));
  for (const x of docs) if (x.stato !== "superato" && (x.scadenza === "scaduto" || x.scadenza === "in_scadenza")) {
    avv.push("<b>" + e(nomeTipo(x.tipo)) + (x.impresa ? " di " + e(x.impresa) : "") + "</b>: " + (x.scadenza === "scaduto" ? "scaduto il " : "scade il ") + giorno(x.scade));
  }
  if (avv.length) h += '<div class="avvisi"><p><b>Da guardare</b></p><ul>' + avv.map((a) => "<li>" + a + "</li>").join("") + "</ul></div>";
  if (!docs.length) h += '<p class="nota">L\'impresa non ha ancora caricato documenti della Sicurezza per questo cantiere.</p>';
  for (const t of tipi) {
    const qui = docs.filter((x) => x.tipo === t.chiave);
    if (!qui.length) continue;
    const vigore = qui.filter((x) => x.stato !== "superato"), vecchi = qui.filter((x) => x.stato === "superato");
    h += '<div class="gruppo"><h3>' + e(t.etichetta || t.breve || t.chiave) + '</h3>';
    for (const x of vigore) h += riga(base, c, x, e);
    if (vecchi.length) h += '<details class="vecchi"><summary>Versioni precedenti (' + vecchi.length + ')</summary>' + vecchi.map((x) => riga(base, c, x, e)).join("") + "</details>";
    h += "</div>";
  }
  h += '<p class="nota">TIX conserva i documenti caricati dall\'impresa con la loro impronta e non ne controlla il contenuto. «Visto dal CSE» è un\'etichetta messa dall\'impresa, non una firma.</p>';
  return h + "</section>";
}

function riga(base, c, x, e) {
  const st = STATI[x.stato] || ["", ""];
  const meta = [x.versione ? "versione " + e(x.versione) : "", x.data ? "del " + giorno(x.data) : "", "caricato il " + quando(x.caricato_il)].filter(Boolean).join(" · ");
  const scad = x.scade ? '<span class="chip ' + (x.scadenza === "scaduto" ? "st-ro" : x.scadenza === "in_scadenza" ? "st-am" : "") + '">' +
    (x.scadenza === "scaduto" ? "Scaduto il " : "Scade il ") + giorno(x.scade) + "</span>" : "";
  const url = base + "/studio/file?c=" + c + "&d=" + x.id;
  const apri = x.apri && x.apri !== "no"
    ? '<div class="azioni"><a class="btn pr" href="' + e(url) + '" target="_blank" rel="noopener">Apri</a><a class="btn" href="' + e(url + "&scarica=1") + '">Scarica</a>' +
      (x.apri === "archivio" ? '<span class="sub">dall\'archivio: qualche secondo</span>' : "") + "</div>"
    : '<p class="sub">Il file non è disponibile in questo momento.</p>';
  return '<article class="doc"><div class="riga"><div class="nome">' + e(x.impresa || "") + (x.impresa && x.titolo ? " · " : "") + e(x.titolo || "") + (!x.impresa && !x.titolo ? e(x.file_nome || "Documento") : "") + "</div>" +
    (st[0] ? '<span class="chip ' + st[1] + '">' + st[0] + "</span>" : "") + "</div>" +
    '<div class="sub">' + meta + "</div>" + (scad ? '<div class="chips">' + scad + "</div>" : "") +
    (x.sha256 ? '<div class="impronta" title="' + e(x.sha256) + '">Impronta SHA-256: ' + e(String(x.sha256).slice(0, 16)) + "…</div>" : "") + apri + "</article>";
}

// ---------------------------------------------------------------------------- DDT e documenti (P2a, 04/11/2026)
// prof_ddt: i documenti registrati e confermati del cantiere (registro_documenti), il più recente in cima.
function ddt(base, c, d, e) {
  let h = '<section class="scheda"><div class="riga"><h2 class="sz"><span class="ic-ddt" aria-hidden="true">&#128666;</span>DDT e documenti</h2><span class="chip">Sola lettura</span></div>';
  if (!d) return h + '<p class="nota">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p></section>';
  if (d.esito !== "ok") return h + '<p class="nota">I DDT di questo cantiere non sono disponibili in questo momento.</p></section>';
  const docs = d.documenti || [];
  if (!docs.length) h += '<p class="nota">L\'impresa non ha ancora registrato DDT o documenti per questo cantiere.</p>';
  for (const x of docs) h += rigaDdt(base, c, x, e);
  h += '<p class="nota">I dati sono letti dalla foto del documento e confermati dall\'impresa. TIX non ne controlla il contenuto: in caso di dubbio fa fede il documento.</p>';
  return h + "</section>";
}

function rigaDdt(base, c, x, e) {
  const titolo = e(x.tipo || "DDT") + (x.numero ? " n. " + e(x.numero) : "") + (x.data ? " del " + e(x.data) : "");
  const dati = [["Fornitore", x.fornitore], ["Materiale", x.materiale], ["Quantità", x.quantita], ["Ordine", x.ordine], ["CIG", x.cig], ["CUP", x.cup]]
    .filter((y) => y[1]).map((y) => y[0] + ": <b>" + e(y[1]) + "</b>").join(" · ");
  const url = base + "/studio/ddt?c=" + c + "&d=" + x.id;
  const apri = x.foto
    ? '<div class="azioni"><a class="btn pr" href="' + e(url) + '" target="_blank" rel="noopener">Apri la foto</a><a class="btn" href="' + e(url + "&scarica=1") + '">Scarica</a></div>'
    : '<p class="sub">La foto di questo documento non è disponibile.</p>';
  return '<article class="doc"><div class="nome">' + titolo + "</div>" + (dati ? '<div class="sub">' + dati + "</div>" : "") +
    '<div class="sub">registrato il ' + oraRoma(x.registrato_il) + "</div>" + apri + "</article>";
}

// prof_ddt restituisce l'ora come timestamptz (UTC): qui si mostra quella di Roma
function oraRoma(s) {
  const t = new Date(String(s || ""));
  if (isNaN(t.getTime())) return "";
  const p = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(t);
  const v = (k) => (p.find((x) => x.type === k) || {}).value || "";
  return v("day") + "/" + v("month") + "/" + v("year") + " alle " + v("hour") + ":" + v("minute");
}

// ---------------------------------------------------------------------------- Cronoprogramma (P2a, 04/11/2026)
// prof_crono: lo stesso documento dell'impresa (crono_scheda_html), già senza i «Lavori fuori programma». È HTML del database,
// con i suoi stili; i caratteri hanno indirizzi relativi alla radice dell'area (caratteri/…), che da /studio non tornerebbero.
function crono(base, d) {
  let h = '<section class="scheda"><div class="riga"><h2 class="sz"><span class="ic-cro" aria-hidden="true">&#128197;</span>Cronoprogramma</h2><span class="chip">Sola lettura</span></div>';
  if (!d) return h + '<p class="nota">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p></section>';
  if (d.esito !== "ok") return h + '<p class="nota">Il cronoprogramma di questo cantiere non è disponibile in questo momento.</p></section>';
  if (!d.attivo) return h + '<p class="nota">L\'impresa non ha ancora caricato il cronoprogramma di questo cantiere.</p></section>';
  const doc = String(d.html || "").replace(/url\(caratteri\//g, "url(" + base + "/caratteri/");
  return h + '<div class="azioni"><button class="btn" type="button" id="stampa">Stampa</button></div><div class="cro">' + doc + "</div>" +
    '<p class="nota">È lo stesso cronoprogramma che vede l\'impresa, aggiornato con quello che arriva dal cantiere. I lavori fuori programma non compaiono qui.</p></section>';
}

// ---------------------------------------------------------------------------- Progetti (09/11/2026, chat 02A)
// prof_progetti: le tavole IN VIGORE del cantiere (funzione interna _progetti_dati_prof della sessione Progetti), divise per tipo.
// Le revisioni superate non si vedono: il professionista lavora sempre sull'ultima.
const TIPI_TAVOLA = [["architettonico", "Architettonico"], ["strutturale", "Strutturale"], ["impianti", "Impianti"], ["altro", "Altro"]];
function progetti(base, c, d, e) {
  let h = '<section class="scheda"><div class="riga"><h2 class="sz"><span class="ic-pro" aria-hidden="true">&#128208;</span>Progetti</h2><span class="chip">Sola lettura</span></div>';
  if (!d) return h + '<p class="nota">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p></section>';
  if (d.esito !== "ok") return h + '<p class="nota">I Progetti di questo cantiere non sono disponibili in questo momento.</p></section>';
  const tav = d.tavole || [];
  if (!tav.length) return h + '<p class="nota">L\'impresa non ha ancora caricato tavole per questo cantiere.</p></section>';
  h += '<p class="sub">' + tav.length + (tav.length === 1 ? " tavola in vigore" : " tavole in vigore") + ": solo l'ultima revisione di ognuna.</p>";
  const noti = TIPI_TAVOLA.map((t) => t[0]);
  for (const [k, nome] of TIPI_TAVOLA) {
    const qui = tav.filter((x) => (k === "altro" ? noti.indexOf(x.tipo) === -1 || x.tipo === "altro" : x.tipo === k));
    if (!qui.length) continue;
    // 09/11/2026 (professionisti-lotto-1): le tavole dello stesso fabbricato / lotto vicine, quelle senza lotto in fondo
    if (qui.some((x) => lottoDi(x))) {
      qui.sort((a, b) => (lottoDi(a) ? 0 : 1) - (lottoDi(b) ? 0 : 1) || lottoDi(a).localeCompare(lottoDi(b), "it", { numeric: true, sensitivity: "base" }));
    }
    h += '<div class="gruppo"><h3>' + nome + " (" + qui.length + ")</h3>" + qui.map((x) => rigaTavola(base, c, x, e)).join("") + "</div>";
  }
  h += '<p class="nota">Sono le tavole caricate dall\'impresa, con la loro impronta. Quando arriva una revisione nuova, qui trovi solo quella. ' +
    'TIX non controlla il contenuto dei disegni: in caso di dubbio fa fede la tavola firmata.</p>';
  return h + "</section>";
}

// «Fabbricato / lotto» della tavola (09/11/2026, campo facoltativo della sessione Progetti): testo oppure null
function lottoDi(x) {
  return String((x && x.lotto) || "").trim();
}

function rigaTavola(base, c, x, e) {
  const lotto = lottoDi(x);
  const titolo = ([x.codice, x.titolo].filter(Boolean).map(e).join(" · ") || e(x.nome || "Tavola")) +
    (lotto ? ' <span class="lotto" title="Fabbricato / lotto">' + e(lotto) + "</span>" : "");
  const chips = (x.revisione ? '<span class="chip pro">Rev. ' + e(x.revisione) + "</span>" : "") +
    (x.variante ? '<span class="chip st-am">Variante</span>' : "") +
    (x.sostituisce ? '<span class="chip">sostituisce la rev. ' + e(x.sostituisce) + "</span>" : "") +
    (x.verificata ? '<span class="chip st-ok" title="La copia nell\'archivio ha la stessa impronta del file caricato">Copia d\'archivio verificata</span>' : "");
  const meta = ["caricata il " + quando(x.caricato_il), x.byte ? mb(x.byte) : "", x.nome ? e(x.nome) : ""].filter(Boolean).join(" · ");
  const url = base + "/studio/tavola?c=" + c + "&d=" + x.id;
  const p7m = /\.p7m$/i.test(String(x.nome || ""));
  const apri = '<div class="azioni">' + (p7m ? "" : '<a class="btn pr" href="' + e(url) + '" target="_blank" rel="noopener">Apri</a>') +
    '<a class="btn' + (p7m ? " pr" : "") + '" href="' + e(url + "&scarica=1") + '">Scarica</a>' + (p7m ? '<span class="sub">firmata digitalmente (.p7m): si apre con il programma di firma</span>' : "") + "</div>";
  return '<article class="doc"><div class="nome">' + titolo + "</div>" + (chips ? '<div class="chips">' + chips + "</div>" : "") +
    '<div class="sub">' + meta + "</div>" +
    (x.sha256 ? '<div class="impronta" title="' + e(x.sha256) + '">Impronta SHA-256: ' + e(String(x.sha256).slice(0, 16)) + "…</div>" : "") + apri + "</article>";
}
function mb(n) { const v = Number(n) || 0; return v >= 1048576 ? (v / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(v / 1024)) + " kB"; }

// prof_progetti_file controlla gettone, cantiere, sezione e che la tavola sia in vigore, scrive nel registro e dà i percorsi
// nell'archivio privato wa-media (transito o cache). Se c'è solo su Drive, prof_progetti_recupero chiede di riprenderla.
async function fileTavola(request, env, base, inUrl, h, tok) {
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const id = String(inUrl.searchParams.get("d") || "").toLowerCase();
  const scarica = inUrl.searchParams.get("scarica") === "1";
  const riprova = inUrl.searchParams.get("riprova") === "1";
  const giro = Math.max(0, Math.min(99, parseInt(inUrl.searchParams.get("n") || "0", 10) || 0));
  const e = h.esc;
  const torna = base + "/studio/cantiere?c=" + c + "&s=progetti";
  const indietro = '<a class="btn" href="' + e(torna) + '">Torna ai Progetti</a>';
  if (!UUID.test(c) || !UUID.test(id)) return h.risposta(h.foglio(base, "Tavola non trovata", "", indietro), 404);
  const info = await h.rpc(env, "prof_progetti_file", { p_token: tok, p_commessa: c, p_id: id }, 10000).catch(() => null);
  if (!info || typeof info !== "object") return h.risposta(h.foglio(base, "Tavola", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (info.esito === "gettone" || info.esito === "spento") return vai(base + "/", cookieTogli(base));
  if (info.esito === "superata") {
    return h.risposta(h.foglio(base, "Questa revisione non è più in vigore", "È arrivata una revisione nuova di questa tavola: apri quella dai Progetti del cantiere.", indietro), 410);
  }
  if (info.esito !== "ok" || String(info.commessa_id || "") !== c) return h.risposta(h.foglio(base, "Tavola non disponibile", "", indietro), 404);
  const radice = "documenti/" + c + "/progetti/";
  let cacheMancante = false, guasto = false;
  for (const [percorso, copia] of [[info.transito, "transito"], [info.cache, "cache"]]) {
    const ps = String(percorso || "");
    if (!ps || ps.indexOf(radice) !== 0 || ps.indexOf("..") !== -1) continue;
    const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(ps), {
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
    if (f && f.ok) return servi(f, info, scarica, request.method);
    if (f && (f.status === 400 || f.status === 404)) { if (copia === "cache") cacheMancante = true; }
    else guasto = true;
  }
  if (guasto) return h.risposta(h.foglio(base, "Tavola", "Il file non si legge dall'archivio in questo momento: riprova tra un minuto.", indietro), 502);
  if (!info.drive) return h.risposta(h.foglio(base, "Tavola", "Il file di questa tavola non è disponibile in questo momento. Riprova tra qualche minuto.", indietro), 404);
  // c'è solo nell'archivio Drive: si chiede di riprenderla (come nella pagina Progetti dell'impresa) e la pagina aspetta
  const qui = base + "/studio/tavola?c=" + c + "&d=" + id + (scarica ? "&scarica=1" : "");
  const rec = await h.rpc(env, "prof_progetti_recupero", { p_token: tok, p_commessa: c, p_id: id,
    p_dati: Object.assign({}, cacheMancante ? { cache_mancante: true } : {}, riprova ? { riprova: true } : {}) }, 10000).catch(() => null);
  if (!rec || typeof rec !== "object") return h.risposta(h.foglio(base, "Tavola", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (rec.esito === "superata") {
    return h.risposta(h.foglio(base, "Questa revisione non è più in vigore", "È arrivata una revisione nuova di questa tavola: apri quella dai Progetti del cantiere.", indietro), 410);
  }
  if (rec.esito === "fallito" || rec.esito === "in_arrivo") {
    return h.risposta(h.foglio(base, "Non riesco a riprenderla dall'archivio", "Riprova tra qualche minuto; se non va, avvisa l'impresa.",
      '<a class="btn" href="' + e(qui + "&riprova=1") + '">Riprova</a><p class="piede"><a href="' + e(torna) + '">Torna ai Progetti</a></p>'), 200);
  }
  if (rec.esito === "pronto" || rec.esito === "chiesto" || rec.esito === "in_corso") {
    if (giro >= ATTESA_GIRI) {
      return h.risposta(h.foglio(base, "Ci vuole più del solito", "L'archivio sta rispondendo piano. Riprova tra qualche minuto.",
        '<a class="btn" href="' + e(qui) + '">Riprova</a><p class="piede"><a href="' + e(torna) + '">Torna ai Progetti</a></p>'), 200);
    }
    const pag = h.foglio(base, "Sto riprendendo la tavola dall'archivio", "Ci vogliono 10–20 secondi: la pagina si aggiorna da sola e poi apre la tavola.",
      '<p style="text-align:center;font-size:1.6rem;margin:0 0 6px" aria-hidden="true">&#8987;</p><p class="piede"><a href="' + e(torna) + '">Torna ai Progetti</a></p>');
    return h.risposta(pag.replace("</head>", '<meta http-equiv="refresh" content="' + (rec.esito === "pronto" ? 0 : 4) + ";url=" + e(qui + "&n=" + (giro + 1)) + '"></head>'), 200);
  }
  return h.risposta(h.foglio(base, "Tavola", "Il file di questa tavola non è disponibile in questo momento.", indietro), 404);
}

// ---------------------------------------------------------------------------- visto sui costruttivi (09/11/2026, fase C2)
// prof_costruttivi dà i costruttivi «Riguarda le strutture» di cui l'impresa ha chiesto il visto al suo ruolo (strutturista o
// DL), anche quelli a cui ha già risposto finché l'impresa non firma. Le funzioni interne sono della chat Progetti.
const ESITI_VISTO = { visto: ["Visto", "st-ok"], osservazioni: ["Osservazioni", "st-am"] };
const MSG_VISTO = {
  ok: ["ok", "Risposta registrata. L'impresa la vede subito."],
  cambiata: ["ok", "Risposta cambiata. Quella di prima resta nello storico."],
  nota: ["err", "Per le osservazioni scrivi il testo: l'impresa lo legge prima di firmare."],
  firmato: ["err", "L'impresa ha già firmato questo costruttivo: la risposta non si cambia più."],
  tolto: ["err", "Questo costruttivo non è più in vigore: l'impresa l'ha tolto o ne ha caricato una revisione nuova."],
  errore: ["err", "La risposta non è stata registrata: riprova tra qualche minuto."]
};
function vistiRiquadro(base, c, d, e, inUrl) {
  const lista = d.costruttivi || [];
  const attesa = lista.filter((x) => !x.esito).length;
  const altro = d.ruolo === "dl" ? "Lo strutturista" : "Il Direttore dei Lavori";
  const msg = MSG_VISTO[String(inUrl.searchParams.get("v") || "")];
  let h = '<section class="scheda visti" id="visti"><div class="riga"><h2 class="sz"><span class="ic-vis" aria-hidden="true">&#9998;</span>Costruttivi da vistare</h2>' +
    '<span class="chip">' + e(d.ruolo_etichetta || "") + "</span></div>" +
    '<p class="sub">' + (attesa ? attesa + (attesa === 1 ? " costruttivo aspetta" : " costruttivi aspettano") + " la tua risposta." : "Hai risposto a tutti.") +
    " L'impresa può firmare un costruttivo solo dopo la risposta dello strutturista e del Direttore dei Lavori.</p>" +
    (msg ? '<p class="msg ' + msg[0] + '" role="status">' + e(msg[1]) + "</p>" : "");
  for (const x of lista) {
    const titolo = [x.fornitore, x.codice, x.titolo].filter(Boolean).map(e).join(" · ") || e(x.nome || "Costruttivo");
    const es = ESITI_VISTO[x.esito];
    const al = ESITI_VISTO[x.altro_esito];
    const chips = (x.revisione ? '<span class="chip pro">Rev. ' + e(x.revisione) + "</span>" : "") +
      (es ? '<span class="chip ' + es[1] + '">' + es[0] + "</span>" : '<span class="chip st-ro">Da vistare</span>') +
      '<span class="chip">' + altro + ": " + (al ? al[0].toLowerCase() : "in attesa") + "</span>";
    const meta = ["visto chiesto il " + quando(x.chiesto_il) + (x.chiesto_da ? " da " + e(x.chiesto_da) : ""), x.byte ? mb(x.byte) : "", x.nome ? e(x.nome) : ""].filter(Boolean).join(" · ");
    const url = base + "/studio/costruttivo?c=" + c + "&d=" + x.id;
    const p7m = /\.p7m$/i.test(String(x.nome || ""));
    const apri = '<div class="azioni">' + (p7m ? "" : '<a class="btn pr" href="' + e(url) + '" target="_blank" rel="noopener">Apri</a>') +
      '<a class="btn' + (p7m ? " pr" : "") + '" href="' + e(url + "&scarica=1") + '">Scarica</a>' + (p7m ? '<span class="sub">firmato digitalmente (.p7m): si apre con il programma di firma</span>' : "") + "</div>";
    const risposta = x.esito ? '<div class="risposta"><strong>La tua risposta</strong> del ' + quando(x.risposto_il) + ": " + es[0] +
      (x.nota ? '<div class="testo-oss">' + e(x.nota) + "</div>" : "") + "</div>" : "";
    const modulo = '<form class="vmod" method="post" action="' + e(base + "/studio/visto") + '">' +
      '<input type="hidden" name="c" value="' + e(c) + '"><input type="hidden" name="d" value="' + e(x.id) + '">' +
      '<label for="n-' + e(x.id) + '">Osservazioni <span class="sub">(obbligatorie solo se scegli «Osservazioni»)</span></label>' +
      '<textarea id="n-' + e(x.id) + '" name="nota" rows="3" maxlength="2000">' + e(x.esito === "osservazioni" ? x.nota || "" : "") + "</textarea>" +
      '<p class="err-oss" role="alert" hidden>Scrivi le osservazioni: l\'impresa le legge prima di firmare.</p>' +
      '<div class="azioni"><button class="btn ok" type="submit" name="esito" value="visto">Visto</button>' +
      '<button class="btn" type="submit" name="esito" value="osservazioni">Invia osservazioni</button></div></form>';
    h += '<article class="doc" id="v-' + e(x.id) + '"><div class="nome">' + titolo + "</div>" + '<div class="chips">' + chips + "</div>" +
      '<div class="sub">' + meta + "</div>" +
      (x.sha256 ? '<div class="impronta" title="' + e(x.sha256) + '">Impronta SHA-256: ' + e(String(x.sha256).slice(0, 16)) + "…</div>" : "") + apri + risposta +
      (x.modificabile === false ? "" : x.esito ? '<details class="cambia"><summary>Cambia la risposta</summary>' + modulo + "</details>" : modulo) + "</article>";
  }
  h += '<p class="nota">La risposta resta registrata con il tuo nome, la data e l\'ora, e l\'impresa la vede prima di firmare. ' +
    'Puoi cambiarla finché l\'impresa non firma; quella di prima resta nello storico. TIX non controlla il contenuto dei disegni.</p>' +
    // «Invia osservazioni» con il testo vuoto: si ferma qui, senza perdere niente
    // (un messaggio sotto il testo, non setCustomValidity: quello bloccherebbe anche il «Visto» dopo)
    "<script>document.querySelectorAll('form.vmod').forEach(function(f){var t=f.querySelector('textarea'),m=f.querySelector('.err-oss');" +
    "f.addEventListener('submit',function(ev){var b=ev.submitter;" +
    "if(b&&b.value==='osservazioni'&&t&&!t.value.trim()){ev.preventDefault();if(m)m.hidden=false;t.focus();}});" +
    "if(t)t.addEventListener('input',function(){if(m)m.hidden=true;});});</script>";
  return h + "</section>";
}

// POST /studio/visto: c, d, esito (visto | osservazioni), nota. Il cookie è SameSite=Lax (niente invii da altri siti) e in più
// si controlla Origin quando il browser lo manda. Dopo, si torna al cantiere con il messaggio.
async function visto(request, env, base, h, tok) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  if (!tok) return vai(base + "/");
  const origine = request.headers.get("Origin");
  if (origine && origine !== "null") {
    let ok = false;
    try { ok = new URL(origine).host === new URL(request.url).host; } catch (x) { ok = false; }
    if (!ok) return new Response("Forbidden", { status: 403 });
  }
  const testo = await request.text();
  if (testo.length > 16000) return new Response("Modulo troppo grande.", { status: 413 });
  const f = new URLSearchParams(testo);
  const c = String(f.get("c") || "").toLowerCase();
  const id = String(f.get("d") || "").toLowerCase();
  const esito = String(f.get("esito") || "");
  if (!UUID.test(c)) return vai(base + "/studio");
  const torna = (v) => vai(base + "/studio/cantiere?c=" + c + "&v=" + v + (UUID.test(id) ? "#v-" + id : "#visti"));
  if (!UUID.test(id) || (esito !== "visto" && esito !== "osservazioni")) return torna("errore");
  const nota = String(f.get("nota") || "").slice(0, 2000);
  if (esito === "osservazioni" && !nota.trim()) return torna("nota");
  const r = await h.rpc(env, "prof_costruttivo_visto", { p_token: tok, p_commessa: c, p_id: id, p_dati: { esito, nota } }, 15000).catch(() => null);
  if (!r || typeof r !== "object") return torna("errore");
  if (r.esito === "gettone" || r.esito === "spento") return vai(base + "/", cookieTogli(base));
  if (r.esito === "ok") return torna(r.cambiato ? "cambiata" : "ok");
  if (r.esito === "non_trovato" || r.esito === "cantiere") return torna("tolto");
  const m = String(r.messaggio || "");
  return torna(/firmato/i.test(m) ? "firmato" : /osservazioni/i.test(m) ? "nota" : "errore");
}

// GET /studio/costruttivo: il PDF (o .p7m) del costruttivo, dall'archivio privato wa-media (documenti/<cantiere>/costruttivi/…)
async function fileCostruttivo(request, env, base, inUrl, h, tok) {
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const id = String(inUrl.searchParams.get("d") || "").toLowerCase();
  const scarica = inUrl.searchParams.get("scarica") === "1";
  const e = h.esc;
  const indietro = '<a class="btn" href="' + e(base + "/studio/cantiere?c=" + c + "#visti") + '">Torna al cantiere</a>';
  if (!UUID.test(c) || !UUID.test(id)) return h.risposta(h.foglio(base, "Costruttivo non trovato", "", indietro), 404);
  const info = await h.rpc(env, "prof_costruttivo_file", { p_token: tok, p_commessa: c, p_id: id }, 10000).catch(() => null);
  if (!info || typeof info !== "object") return h.risposta(h.foglio(base, "Costruttivo", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (info.esito === "gettone" || info.esito === "spento") return vai(base + "/", cookieTogli(base));
  if (info.esito !== "ok" || String(info.commessa_id || "") !== c) {
    return h.risposta(h.foglio(base, "Costruttivo non disponibile", "L'impresa può averlo tolto o averne caricato una revisione nuova.", indietro), 404);
  }
  const ps = String(info.transito || "");
  if (!ps || ps.indexOf("documenti/" + c + "/costruttivi/") !== 0 || ps.indexOf("..") !== -1) {
    return h.risposta(h.foglio(base, "Costruttivo", "Il file di questo costruttivo non è disponibile in questo momento.", indietro), 404);
  }
  const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(ps), {
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  if (f && f.ok) return servi(f, info, scarica, request.method);
  if (f && (f.status === 400 || f.status === 404)) return h.risposta(h.foglio(base, "Costruttivo", "Il file di questo costruttivo non è più nell'archivio: avvisa l'impresa.", indietro), 404);
  return h.risposta(h.foglio(base, "Costruttivo", "Il file non si legge dall'archivio in questo momento: riprova tra un minuto.", indietro), 502);
}

// ---------------------------------------------------------------------------- file
async function file(request, env, base, inUrl, h, tok) {
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const id = String(inUrl.searchParams.get("d") || "").toLowerCase();
  const scarica = inUrl.searchParams.get("scarica") === "1";
  const riprova = inUrl.searchParams.get("riprova") === "1";
  const giro = Math.max(0, Math.min(99, parseInt(inUrl.searchParams.get("n") || "0", 10) || 0));
  const e = h.esc;
  const torna = base + "/studio/cantiere?c=" + c;
  const indietro = '<a class="btn" href="' + e(torna) + '">Torna al cantiere</a>';
  if (!UUID.test(c) || !UUID.test(id)) return h.risposta(h.foglio(base, "Documento non trovato", "", indietro), 404);
  const info = await h.rpc(env, "prof_file", { p_token: tok, p_commessa: c, p_documento: id }, 10000).catch(() => null);
  if (!info || typeof info !== "object") return h.risposta(h.foglio(base, "Documento", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (info.esito === "gettone" || info.esito === "spento") return vai(base + "/", cookieTogli(base));
  if (info.esito !== "ok" || String(info.commessa_id || "") !== c) return h.risposta(h.foglio(base, "Documento non disponibile", "", indietro), 404);
  const radice = "documenti/" + c + "/sicurezza/";
  let cacheMancante = false, guasto = false;
  for (const [percorso, copia] of [[info.transito, "transito"], [info.cache, "cache"]]) {
    const ps = String(percorso || "");
    if (!ps || ps.indexOf(radice) !== 0 || ps.indexOf("..") !== -1) continue;
    const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(ps), {
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
    if (f && f.ok) return servi(f, info, scarica, request.method);
    if (f && (f.status === 400 || f.status === 404)) { if (copia === "cache") cacheMancante = true; }
    else guasto = true;
  }
  if (guasto) return h.risposta(h.foglio(base, "Documento", "Il file non si legge dall'archivio in questo momento: riprova tra un minuto.", indietro), 502);
  if (!info.drive) return h.risposta(h.foglio(base, "Documento", "Il file di questo documento non è disponibile in questo momento. Riprova tra qualche minuto.", indietro), 404);
  // c'è solo nell'archivio Drive: si chiede di riprenderlo (come nella pagina Sicurezza dell'impresa) e la pagina aspetta
  const qui = base + "/studio/file?c=" + c + "&d=" + id + (scarica ? "&scarica=1" : "");
  const rec = await h.rpc(env, "prof_file_recupero", { p_token: tok, p_commessa: c, p_documento: id,
    p_dati: Object.assign({}, cacheMancante ? { cache_mancante: true } : {}, riprova ? { riprova: true } : {}) }, 10000).catch(() => null);
  if (!rec || typeof rec !== "object") return h.risposta(h.foglio(base, "Documento", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (rec.esito === "fallito") {
    return h.risposta(h.foglio(base, "Non riesco a riprenderlo dall'archivio", "Riprova tra qualche minuto; se non va, avvisa l'impresa.",
      '<a class="btn" href="' + e(qui + "&riprova=1") + '">Riprova</a><p class="piede"><a href="' + e(torna) + '">Torna al cantiere</a></p>'), 200);
  }
  if (rec.esito === "pronto" || rec.esito === "chiesto" || rec.esito === "in_corso") {
    if (giro >= ATTESA_GIRI) {
      return h.risposta(h.foglio(base, "Ci vuole più del solito", "L'archivio sta rispondendo piano. Riprova tra qualche minuto.",
        '<a class="btn" href="' + e(qui) + '">Riprova</a><p class="piede"><a href="' + e(torna) + '">Torna al cantiere</a></p>'), 200);
    }
    const pag = h.foglio(base, "Sto riprendendo il documento dall'archivio", "Ci vogliono 10–20 secondi: la pagina si aggiorna da sola e poi apre il documento.",
      '<p style="text-align:center;font-size:1.6rem;margin:0 0 6px" aria-hidden="true">&#8987;</p><p class="piede"><a href="' + e(torna) + '">Torna al cantiere</a></p>');
    return h.risposta(pag.replace("</head>", '<meta http-equiv="refresh" content="' + (rec.esito === "pronto" ? 0 : 4) + ";url=" + e(qui + "&n=" + (giro + 1)) + '"></head>'), 200);
  }
  return h.risposta(h.foglio(base, "Documento", "Il file di questo documento non è disponibile in questo momento.", indietro), 404);
}

// Il tipo del file lo decide la riga del database, mai quello salvato nell'archivio (come in sicurezza.js).
function servi(f, info, scarica, metodo) {
  const p7m = info.mime === "application/pkcs7-mime";
  const nome = String(info.nome || (p7m ? "documento.p7m" : "documento.pdf"));
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || (p7m ? "documento.p7m" : "documento.pdf");
  const hd = {
    "Content-Type": p7m ? "application/pkcs7-mime" : "application/pdf",
    "Content-Disposition": (scarica || p7m ? "attachment" : "inline") + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff"
  };
  const lun = f.headers.get("Content-Length");
  if (lun && /^[0-9]+$/.test(lun)) hd["Content-Length"] = lun;
  return new Response(metodo === "HEAD" ? null : f.body, { status: 200, headers: hd });
}

// ---------------------------------------------------------------------------- foto di un DDT (P2a, 04/11/2026)
// prof_ddt_file controlla gettone, cantiere e sezione, scrive nel registro e dà il percorso nell'archivio privato wa-media.
async function fileDdt(request, env, base, inUrl, h, tok) {
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const id = String(inUrl.searchParams.get("d") || "");
  const scarica = inUrl.searchParams.get("scarica") === "1";
  const e = h.esc;
  const indietro = '<a class="btn" href="' + e(base + "/studio/cantiere?c=" + c + "&s=ddt") + '">Torna ai DDT</a>';
  if (!UUID.test(c) || !/^[0-9]{1,15}$/.test(id)) return h.risposta(h.foglio(base, "Documento non trovato", "", indietro), 404);
  const info = await h.rpc(env, "prof_ddt_file", { p_token: tok, p_commessa: c, p_id: Number(id) }, 10000).catch(() => null);
  if (!info || typeof info !== "object") return h.risposta(h.foglio(base, "Documento", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (info.esito === "gettone" || info.esito === "spento") return vai(base + "/", cookieTogli(base));
  if (info.esito !== "ok" || String(info.commessa_id || "") !== c) return h.risposta(h.foglio(base, "Documento non disponibile", "", indietro), 404);
  const ps = String(info.percorso || "");
  if (!ps || ps.charAt(0) === "/" || ps.indexOf("..") !== -1) return h.risposta(h.foglio(base, "Documento non disponibile", "", indietro), 404);
  const f = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(ps), {
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  if (f && f.ok) return serviDdt(f, info, scarica, request.method);
  if (f && (f.status === 400 || f.status === 404)) return h.risposta(h.foglio(base, "Documento", "La foto di questo documento non è più nell'archivio.", indietro), 404);
  return h.risposta(h.foglio(base, "Documento", "Il file non si legge dall'archivio in questo momento: riprova tra un minuto.", indietro), 502);
}

// Anche qui il tipo lo decide la riga del database (media_ricevuti.mime), e solo tra quelli che il browser può mostrare.
const TIPI_DDT = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
function serviDdt(f, info, scarica, metodo) {
  const tipo = TIPI_DDT.indexOf(info.mime) !== -1 ? info.mime : "application/octet-stream";
  const nome = String(info.nome || "documento");
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "documento";
  const hd = {
    "Content-Type": tipo,
    "Content-Disposition": (scarica || tipo === "application/octet-stream" ? "attachment" : "inline") + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff"
  };
  const lun = f.headers.get("Content-Length");
  if (lun && /^[0-9]+$/.test(lun)) hd["Content-Length"] = lun;
  return new Response(metodo === "HEAD" ? null : f.body, { status: 200, headers: hd });
}

// ---------------------------------------------------------------------------- scelta della password
async function password(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD" && metodo !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD, POST" } });
  let f = new URLSearchParams();
  if (metodo === "POST") {
    const testo = await request.text();
    if (testo.length > 8000) return new Response("Modulo troppo grande.", { status: 413 });
    f = new URLSearchParams(testo);
  }
  const e = h.esc;
  const codice = ((metodo === "POST" ? f.get("c") : inUrl.searchParams.get("c")) || "").replace(/[^0-9a-f]/gi, "").slice(0, 64).toLowerCase();
  const torna = '<p class="piede"><a href="' + e(base + "/") + '">&larr; Torna all\'accesso</a></p>';
  const scaduto = h.foglio(base, "Collegamento scaduto", "",
    '<p>Questo collegamento non è più valido: scade dopo qualche giorno (invito) o dopo poche ore (password dimenticata), e vale una volta sola.</p>' +
    '<a class="btn" href="' + e(base + "/password-dimenticata") + '">Chiedi un nuovo collegamento</a>' + torna);
  const modulo = (email, primo, avviso) => h.foglio(base, primo ? "Scegli la password" : "Nuova password",
    email ? "Per l'accesso di <strong>" + e(email) + "</strong> ai documenti dei cantieri" : "",
    (avviso ? '<p class="err">' + avviso + "</p>" : "") +
    '<form method="post" action="' + e(base + "/studio/password") + '"><input type="hidden" name="c" value="' + codice + '">' +
    '<input type="hidden" name="email" value="' + e(email || "") + '"><input type="hidden" name="primo" value="' + (primo ? "1" : "") + '">' +
    '<label for="p1">Password (almeno 8 caratteri)</label><input id="p1" name="password" type="password" minlength="8" autocomplete="new-password" required>' +
    '<label for="p2">Ripeti la password</label><input id="p2" name="password2" type="password" minlength="8" autocomplete="new-password" required>' +
    '<button type="submit">Salva ed entra</button></form>' +
    '<p class="piede">Poi entri da <strong>app.tixcantiere.it</strong> con la tua email e questa password.</p>');
  if (env.PROFESSIONISTI === "off" || !codice) return h.risposta(scaduto);
  if (metodo === "POST") {
    const p1 = f.get("password") || "", p2 = f.get("password2") || "", email = (f.get("email") || "").slice(0, 200), primo = f.get("primo") === "1";
    if (p1 !== p2) return h.risposta(modulo(email, primo, "Le due password non coincidono."));
    if (p1.length < 8) return h.risposta(modulo(email, primo, "La password deve avere almeno 8 caratteri."));
    const r = await h.rpc(env, "prof_codice_conferma", { p_codice: codice, p_password: p1.slice(0, 200) }, 15000).catch(() => null);
    if (!r) return h.risposta(modulo(email, primo, "Il servizio non risponde in questo momento. Riprova tra qualche minuto."));
    if (r.esito === "ok" && GETTONE.test(r.token || "")) return vai(base + "/studio", cookieImposta(base, r.token));
    if (r.esito === "corta") return h.risposta(modulo(email, primo, "La password deve avere almeno 8 caratteri."));
    return h.risposta(scaduto);
  }
  const v = await h.rpc(env, "prof_codice_valido", { p_codice: codice }, 10000).catch(() => null);
  if (!v || v.esito !== "ok") return h.risposta(scaduto);
  return h.risposta(modulo(v.email, v.primo === true, ""));
}

// ---------------------------------------------------------------------------- pagina
function pagina(request, base, h, titolo, utente, sottotitolo, corpo, stato) {
  const e = h.esc, u = utente || {};
  const html = '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>" + e(titolo) + " - TIX · Diario di cantiere</title>" + h.testa(base) + "<style>" + STILE + "</style></head><body>" +
    '<header class="testa"><div class="in"><div class="riga"><a class="marchio" href="' + e(base + "/studio") + '"><img src="' + e(base + "/icona-192.png") + '" alt="">TIX · Area professionisti</a>' +
    '<span class="chi">' + e(u.nome || u.email || "") + ' <a class="esci" id="impresa" href="' + e(base + "/") + '" hidden>La tua impresa</a>' +
    '<a class="esci" href="' + e(base + "/studio/esci") + '">Esci</a></span></div>' +
    "<h1>" + e(titolo) + "</h1>" + (sottotitolo ? "<p>" + sottotitolo + "</p>" : "") + "</div></header>" +
    '<main class="corpo"><div class="in">' + corpo + "</div></main>" +
    // chi è anche utente di un'impresa (accesso ricordato dal browser) ci torna con un tocco, senza uscire
    "<script>(function(){try{var s=localStorage.getItem(\"gl_portale_t\");if(s&&/^[0-9a-f]{64}$/.test(s)){var a=document.getElementById(\"impresa\");" +
    "a.href=" + JSON.stringify(base) + "+\"/?t=\"+s;a.hidden=false}}catch(e){}" +
    "var b=document.getElementById(\"stampa\");if(b)b.addEventListener(\"click\",function(){window.print()})})();</script></body></html>";
  return new Response(request.method === "HEAD" ? null : html, { status: stato || 200, headers: h.headers() });
}

const STILE = "[hidden]{display:none!important}" +
  ":root{--navy:#1B2F4A;--arancio:#F26A10;--sic:#0CA678;--sic-s:#065F46;--sic-f:#E6F7F0;--bg:#F3F5F7;--carta:#fff;--t:#17212E;--s:#5B6672;--l:#D9DFE6;--chip:#EAF0F6;" +
  "--ro:#B3261E;--ro-f:#FDECEA;--am:#9A4308;--am-f:#FFF3E8;--gr:#5B6672;--gr-f:#EEF1F4;--ddt-s:#7A4A12;--ddt-f:#FBF1E4;--cro-s:#1F5E8C;--cro-f:#E7F0F8}" +
  "@media (prefers-color-scheme:dark){:root{--bg:#0F1722;--carta:#172231;--t:#E8EDF3;--s:#9AA8B8;--l:#2A3A4E;--chip:#203047;--sic-f:#0F3326;--sic-s:#7FE0BF;" +
  "--ro-f:#3A1A18;--ro:#F07A6E;--am-f:#3A2410;--am:#F5B37A;--gr-f:#243244;--gr:#B7C3D1;--ddt-s:#F2C792;--ddt-f:#3A2A14;--cro-s:#9CC8EC;--cro-f:#16314A;color-scheme:dark}}" +
  "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,system-ui,sans-serif;font-size:16px;line-height:1.45}" +
  ".testa{background:var(--navy);color:#fff;padding:14px 16px 20px}.in{max-width:720px;margin:0 auto}" +
  // 31/10/2026 (Filippo): sul computer le pagine sono larghe fino a 1600 px (dal 03/11/2026, prima 1000), con almeno 48 px per lato;
  // da 1300 px di schermo l'elenco dei cantieri va su due colonne, come quello dell'impresa
  "@media screen and (min-width:760px){.in{max-width:min(1600px,calc(100vw - 48px))}}@media screen and (min-width:900px){.in{max-width:min(1600px,calc(100vw - 96px))}}" +
  "@media screen and (min-width:1300px){.corpo .in:has(>a.scheda){display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:16px;align-items:start}" +
  ".corpo .in:has(>a.scheda)>:not(a.scheda){grid-column:1/-1}}" +
  ".riga{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}" +
  ".marchio{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-weight:700}.marchio img{width:32px;height:32px;border-radius:8px}" +
  ".chi{color:#C9D6E5;font-size:.9rem;display:flex;align-items:center;gap:10px;overflow-wrap:anywhere}" +
  ".esci{color:#fff;border:1px solid rgba(255,255,255,.45);border-radius:999px;padding:5px 12px;text-decoration:none;font-size:.85rem;white-space:nowrap}" +
  ".testa h1{font-size:1.6rem;margin:16px 0 2px;letter-spacing:-.02em}.testa p{margin:0;color:#C9D6E5}" +
  ".corpo{padding:16px 16px 64px}.titolo{font-size:1.2rem;margin:4px 0 12px}" +
  ".torna{display:inline-block;margin:0 0 12px;padding:6px 14px;border-radius:999px;border:1px solid var(--l);background:var(--carta);color:var(--t);font-weight:600;text-decoration:none}" +
  // cornice sfumata blu TIX → arancione, come le schede del cantiere; in stampa un bordo semplice
  ".scheda{position:relative;display:block;background:var(--carta);color:inherit;text-decoration:none;border:1px solid transparent;border-radius:16px;padding:16px;margin:0 0 12px;" +
  "box-shadow:0 1px 2px rgba(16,27,43,.05),0 8px 20px -14px rgba(16,27,43,.2)}" +
  "@media screen{.scheda::before{content:\"\";position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#F26A10);padding:2px;" +
  "-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}}" +
  "@media print{.scheda{border:1px solid #1B2F4A;box-shadow:none}.testa{background:none;color:#000}.testa p,.chi{color:#333}.esci,.azioni,.torna{display:none}}" +
  "a.scheda:hover,a.scheda:focus-visible{outline:none;box-shadow:0 1px 2px rgba(16,27,43,.08),0 12px 26px -14px rgba(16,27,43,.35)}" +
  ".nome{font-weight:700;font-size:1.05rem;overflow-wrap:anywhere}.sub{color:var(--s);font-size:.9rem;margin-top:2px}.sub b{color:var(--t);font-weight:600}" +
  ".chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{background:var(--chip);border-radius:999px;padding:2px 10px;font-size:.8rem;font-weight:600;white-space:nowrap}" +
  ".chip.sic{background:var(--sic-f);color:var(--sic-s)}.nuovi{background:var(--arancio);color:#fff;border-radius:999px;padding:3px 10px;font-size:.8rem;font-weight:700}" +
  ".st-ok{background:var(--sic-f);color:var(--sic-s)}.st-am{background:var(--am-f);color:var(--am)}.st-ro{background:var(--ro-f);color:var(--ro)}.st-gr{background:var(--gr-f);color:var(--gr)}" +
  ".sz{display:flex;align-items:center;gap:10px;margin:0;font-size:1.25rem;color:var(--t)}" +
  ".ic-sic{width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#3DD9A4,#0CA678 45%,#065F46);font-size:1.05rem}" +
  ".avvisi{margin:12px 0 4px;border:1px solid var(--am);background:var(--am-f);border-radius:12px;padding:8px 12px;font-size:.92rem}.avvisi p{margin:0 0 4px}.avvisi ul{margin:0;padding-left:18px}" +
  ".gruppo{margin-top:16px}.gruppo h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--s);margin:0 0 6px}" +
  ".doc{border-top:1px solid var(--l);padding:10px 0}.impronta{color:var(--s);font-size:.78rem;margin-top:4px;font-family:ui-monospace,Consolas,monospace}" +
  ".vecchi{margin:4px 0 0}.vecchi summary{cursor:pointer;color:var(--s);font-size:.9rem;padding:6px 0}" +
  ".azioni{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}" +
  ".btn{font:inherit;font-weight:700;font-size:.9rem;border-radius:10px;border:1px solid var(--l);background:var(--carta);color:var(--t);padding:7px 14px;text-decoration:none;display:inline-flex;align-items:center;min-height:38px}" +
  ".btn.pr{background:var(--arancio);border-color:var(--arancio);color:#fff}" +
  ".btn:focus-visible,a:focus-visible{outline:3px solid var(--arancio);outline-offset:2px}" +
  ".nota{border:1px dashed var(--l);border-radius:12px;padding:10px 12px;color:var(--s);font-size:.88rem;margin:14px 0 0}" +
  // P2a (04/11/2026): schede delle sezioni, DDT e Cronoprogramma. «nav.sezioni» e non «nav.schede»: lo stile premium dà a
  // nav.schede la barra a vetro delle schede dell'impresa, chiara anche con il tema scuro
  ".sezioni{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}.sezioni a{padding:7px 14px;border-radius:999px;border:1px solid var(--l);background:var(--carta);color:var(--t);" +
  "font-weight:700;font-size:.92rem;text-decoration:none;min-height:38px;display:inline-flex;align-items:center}.sezioni a.on{background:var(--navy);border-color:var(--navy);color:#fff}" +
  ".chip.ddt{background:var(--ddt-f);color:var(--ddt-s)}.chip.cro{background:var(--cro-f);color:var(--cro-s)}" +
  ".ic-ddt,.ic-cro{width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:1.05rem}" +
  ".ic-ddt{background:linear-gradient(135deg,#F6C88A,#C9832B 45%,#7A4A12)}.ic-cro{background:linear-gradient(135deg,#8CC4EE,#2F7DB8 45%,#1F5E8C)}" +
  // il cronoprogramma ha già il suo foglio bianco (.cr-doc), anche con il tema scuro, come quello stampato
  ".cro{margin-top:12px;overflow-x:auto;color-scheme:light}" +
  // lo stile premium dà a ogni «.p» l'aspetto di una scheda: nel cronoprogramma «td.p» è la colonna delle percentuali
  ".cro .cr-tab td.p,.cro .cr-tab td.p:hover{border-radius:0;background-image:none;box-shadow:none;transition:none;transform:none}" +
  "@media print{.sezioni,#stampa,.cro~.nota{display:none}}" +
  // lo stile premium dà alle schede un riflesso bianco: con il tema scuro schiarisce il fondo e il titolo non si legge
  "@media (prefers-color-scheme:dark){.corpo .scheda{background-image:none}.sezioni a.on{background:var(--t);border-color:var(--t);color:var(--bg)}}" +
  // Progetti (09/11/2026): lo stesso rame della scheda Progetti dell'impresa
  ".chip.pro{background:#F7EEE6;color:#6E4526}.ic-pro{width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:1.05rem;" +
  "background:linear-gradient(135deg,#D19A6A,#A86F44 45%,#6E4526)}" +
  // visto sui costruttivi (09/11/2026): riquadro sopra le sezioni, bollino viola nell'elenco dei cantieri, modulo della risposta
  ".avv{display:inline-flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}.nuovi.vis{background:#6D3FC0}" +
  ".ic-vis{width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:1.05rem;color:#fff;background:linear-gradient(135deg,#B79CF0,#6D3FC0 45%,#3E1F7A)}" +
  ".visti .msg{border-radius:10px;padding:8px 12px;margin:10px 0 0;font-weight:600}.visti .msg.ok{background:var(--sic-f);color:var(--sic-s)}.visti .msg.err{background:var(--ro-f);color:var(--ro)}" +
  ".risposta{margin-top:10px;border-left:3px solid #6D3FC0;padding:4px 0 4px 10px;font-size:.92rem}.testo-oss{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px}" +
  ".vmod{margin-top:10px}.vmod label{display:block;font-weight:600;font-size:.9rem;margin:0 0 4px}" +
  ".vmod textarea{width:100%;font:inherit;border:1px solid var(--l);border-radius:10px;padding:8px 10px;background:var(--carta);color:var(--t);resize:vertical;min-height:72px}" +
  // lo stile premium dà a tutti i .btn lo sfondo chiaro sfumato: qui il verde del «Visto» deve vincere
  ".btn.ok{background:linear-gradient(135deg,#12B886,#0CA678)!important;border-color:#0CA678!important;color:#fff!important}button.btn{cursor:pointer}" +
  ".err-oss{color:var(--ro);font-weight:600;font-size:.9rem;margin:6px 0 0}" +
  ".cambia{margin-top:8px}.cambia summary{cursor:pointer;color:var(--s);font-size:.9rem;padding:4px 0}" +
  "@media print{.vmod,.cambia{display:none}}" +
  // fabbricato / lotto accanto al titolo della tavola (09/11/2026)
  ".lotto{display:inline-block;vertical-align:middle;margin-left:6px;padding:1px 9px;border-radius:6px;border:1px solid var(--navy);color:var(--navy);font-size:.78rem;font-weight:700;max-width:100%;overflow-wrap:anywhere}" +
  "@media (prefers-color-scheme:dark){.lotto{border-color:#C9D6E5;color:#C9D6E5}}" +
  "@media (prefers-color-scheme:dark){.chip.pro{background:#3A2A1E;color:#E8C3A0}}" +
  "@media (prefers-reduced-motion:reduce){*{transition:none!important}}";
