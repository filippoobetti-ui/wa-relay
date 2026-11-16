// ============================================================================
// PANNELLO DI FILIPPO (16/11/2026, pannello-1, chat B18). Piano: Strumenti/pannello-filippo/01-piano.md.
// Si apre solo con l'accesso personale di Filippo, dal suo dispositivo registrato. Tre controlli:
//  1. la porta della B16 (accessiPorta) lavora prima, come per ogni pagina dell'area riservata, e qui si vuole esito «ok»;
//  2. le funzioni del database pannello_* ricontrollano gettone, utente «tutte le imprese», elenco pannello_ammessi e
//     dispositivo (cookie protetto tix_disp) con _pannello_chi; il collegamento condiviso non entra mai;
//  3. impostazioni.pannello_attivo (no / prova / si). Interruttore d'emergenza del Worker: PANNELLO = "off".
// Rotte: /pannello?t=…            Oggi + elenco dei clienti
//        /pannello?t=…&a=<impresa> scheda dell'impresa
//        /pannello/azione          POST JSON {t, azione, dati} (oggi solo le note)
// Funzioni del database (chiuse ad anon): pannello_dati, pannello_impresa, pannello_nota.
// ============================================================================

import { accessiChiave } from "./accessi.js";

const ESA64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f-]{36}$/i;

async function rpc(env, nome, corpo, ms) {
  const url = (env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co") + "/rest/v1/rpc/" + nome;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 15000);
  try {
    const r = await fetch(url, { method: "POST", signal: ctrl.signal, body: JSON.stringify(corpo),
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json", Accept: "application/json" } });
    if (!r.ok) return null;
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

function intestazioni() {
  return { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
}

export async function portalePannello(request, env, base, sotto, inUrl, h) {
  if ((env && env.PANNELLO === "off") || !env.SUPABASE_SERVICE_KEY) return new Response("Not Found", { status: 404 });
  const stato = h && h.stato ? h.stato.get(request) : null;
  const disp = accessiChiave(request);
  const fuori = () => new Response(h.foglio(base, "Pannello", "", '<p>Questa pagina si apre solo con l\'accesso personale dell\'amministratore di TIX, dal suo dispositivo registrato.</p>' +
    '<p class="piede"><a href="' + base + '/">&larr; Torna all\'accesso</a></p>'), { status: 200, headers: intestazioni() });

  if (sotto === "/pannello/azione") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" } });
    let b = {};
    try { b = JSON.parse((await request.text()).slice(0, 20000)); } catch (e) { b = {}; }
    const tok = String(b.t || "").toLowerCase();
    if (!ESA64.test(tok) || !stato || stato.esito !== "ok") return j({ esito: "no" }, 403);
    const d = b.dati || {};
    if (b.azione === "nota") {
      const az = UUID.test(String(d.azienda || "")) ? String(d.azienda).toLowerCase() : null;
      if (!az) return j({ esito: "nontrovata" }, 400);
      const togli = /^\d{1,12}$/.test(String(d.togli || "")) ? Number(d.togli) : null;
      const r = await rpc(env, "pannello_nota", { p_token: tok, p_disp: disp, p_az: az, p_testo: togli ? null : String(d.testo || "").slice(0, 4000), p_togli: togli });
      return j(r || { esito: "servizio" });
    }
    return j({ esito: "azione" }, 400);
  }

  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  if (!stato || stato.esito !== "ok" || !ESA64.test(disp)) return fuori();
  const a = UUID.test(inUrl.searchParams.get("a") || "") ? inUrl.searchParams.get("a").toLowerCase() : null;
  const p = a ? await rpc(env, "pannello_impresa", { p_token: tok, p_disp: disp, p_az: a })
              : await rpc(env, "pannello_dati", { p_token: tok, p_disp: disp });
  if (!p) return new Response(h.foglio(base, "Pannello", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), { status: 503, headers: intestazioni() });
  if (p.esito !== "ok") return fuori();
  const html = a ? paginaScheda(base, tok, p, h) : paginaOggi(base, tok, p, h);
  return new Response(html, { status: 200, headers: intestazioni() });
}

// ---------------------------------------------------------------------------------------------------------------------------
const quando = (s, ora) => {
  if (!s) return "mai";
  try { return new Date(s).toLocaleString("it-IT", Object.assign({ timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric" },
    ora ? { hour: "2-digit", minute: "2-digit" } : {})); } catch (e) { return ""; }
};
const giorno = (s) => {
  if (!s) return "";
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T12:00:00Z" : s;
  return quando(t, false);
};
const euro = (n) => (n === null || n === undefined || n === "") ? "—" :
  Number(n).toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " € + IVA";
const STATI_PAG = { regolare: "In regola", promemoria: "Promemoria mandato", avviso: "Avviso mandato", sospesa: "Sospesa", chiusa: "Chiusa", errore: "Non letto" };
const SEM = { verde: "Tutto a posto", giallo: "Da guardare", rosso: "Serve un intervento", grigio: "Non attiva" };

function stile() {
  return '<style>:root{--v:#1B2F4A;--t:#1b1f1d;--s:#5b6560;--b:#f4f6f5;--c:#fff;--l:#dfe5e2;--r:#B3261E;--g:#8a6100;--ok:#1f7a4d;--gb:#fff7e0;--rb:#fde8e6;--vb:#e6f4ec;--o:#b08a1e}' +
    '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--v:#8fb0d6;--t:#eef2f0;--s:#a9b3ae;--b:#111513;--c:#1a201d;--l:#2c3531;--r:#f2b8b5;--g:#f3d48a;--ok:#8fd6ae;--gb:#3a3214;--rb:#3d1f1d;--vb:#163326;--o:#e3c25e}}' +
    ':root[data-theme="dark"]{--v:#8fb0d6;--t:#eef2f0;--s:#a9b3ae;--b:#111513;--c:#1a201d;--l:#2c3531;--r:#f2b8b5;--g:#f3d48a;--ok:#8fd6ae;--gb:#3a3214;--rb:#3d1f1d;--vb:#163326;--o:#e3c25e}' +
    '*{box-sizing:border-box}html,body{margin:0;background:var(--b);color:var(--t)}body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.45}' +
    'main{max-width:1100px;margin:0 auto;padding:20px 16px 56px}h1{font-size:1.4rem;margin:6px 0 2px}h2{font-size:1.02rem;margin:0 0 10px}h3{font-size:.95rem;margin:14px 0 6px}' +
    'a{color:var(--v);font-weight:600}section{background:var(--c);border:1px solid var(--l);border-radius:14px;padding:16px;margin:14px 0;overflow-x:auto}' +
    '.sub{color:var(--s);font-size:.88rem;margin:2px 0 8px}.nota{background:var(--gb);color:var(--g);border-radius:10px;padding:10px 12px;margin:10px 0;font-size:.9rem}' +
    '.griglia{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.cifra{background:var(--b);border:1px solid var(--l);border-radius:12px;padding:12px}' +
    '.cifra b{display:block;font-size:1.25rem}.cifra span{color:var(--s);font-size:.82rem}' +
    '.avv{list-style:none;margin:0;padding:0}.avv li{padding:8px 10px;border-radius:10px;margin:6px 0;font-size:.92rem}.avv .rosso{background:var(--rb);color:var(--r)}.avv .giallo{background:var(--gb);color:var(--g)}.avv .blu{background:var(--b);border:1px solid var(--l)}' +
    '.filtri{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}.filtri button{background:var(--b);color:var(--t);border:1px solid var(--l);border-radius:999px;padding:6px 12px;font-size:.85rem;font-weight:600;cursor:pointer}' +
    '.filtri button[aria-pressed="true"]{background:var(--v);color:var(--c);border-color:var(--v)}' +
    '.cliente{display:block;text-decoration:none;color:inherit;border:1px solid var(--l);border-radius:12px;padding:12px;margin:8px 0;background:var(--c)}.cliente:hover{border-color:var(--v)}' +
    '.cap{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pallino{width:12px;height:12px;border-radius:50%;flex:none}' +
    '.p-verde{background:var(--ok)}.p-giallo{background:var(--o)}.p-rosso{background:var(--r)}.p-grigio{background:var(--s)}' +
    '.tag{font-size:.74rem;font-weight:700;background:var(--b);border:1px solid var(--l);border-radius:999px;padding:2px 8px;color:var(--s)}' +
    '.riga{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--s);font-size:.86rem;margin-top:6px}.riga b{color:var(--t);font-weight:600}' +
    '.motivi{margin:6px 0 0;padding-left:18px;font-size:.86rem}.motivi .r{color:var(--r)}.motivi .g{color:var(--g)}' +
    'table{width:100%;border-collapse:collapse;font-size:.88rem}th,td{text-align:left;padding:6px 6px;border-top:1px solid var(--l);vertical-align:top}th{color:var(--s);font-weight:600}' +
    'dl{display:grid;grid-template-columns:minmax(120px,200px) 1fr;gap:4px 12px;margin:0;font-size:.92rem}dt{color:var(--s)}dd{margin:0;overflow-wrap:anywhere}' +
    'textarea{width:100%;min-height:80px;font:inherit;padding:10px;border:1px solid var(--l);border-radius:10px;background:var(--b);color:var(--t)}' +
    'button.az{font-size:.92rem;font-weight:600;padding:9px 14px;border:0;border-radius:10px;background:var(--v);color:var(--c);cursor:pointer;margin-top:8px}' +
    'button.piccolo{font-size:.78rem;padding:3px 9px;border:1px solid var(--l);border-radius:8px;background:var(--b);color:var(--s);cursor:pointer}' +
    '.nt{border-top:1px solid var(--l);padding:8px 0}.nt:first-child{border-top:0}.nt p{margin:2px 0;white-space:pre-wrap}.err{color:var(--r);font-weight:600}' +
    '.barra{height:8px;background:var(--b);border:1px solid var(--l);border-radius:999px;overflow:hidden;margin:4px 0}.barra i{display:block;height:100%;background:var(--v)}' +
    '@media (max-width:560px){dl{grid-template-columns:38% 1fr;font-size:.88rem}main{padding:14px 12px 48px}table{font-size:.8rem}}' +
    '</style>';
}

function testa(base, h, titolo) {
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>' + titolo + ' - Pannello TIX</title>' + h.testa(base) + stile() + '</head><body><main>';
}

function provaAvviso(p) {
  return p.stato === "prova" ? '<div class="nota">In prova: questo pannello lo vedi solo tu. Le imprese non vedono niente di diverso.</div>' : "";
}

export function paginaOggi(base, tok, p, h) {
  const e = h.esc;
  const cl = p.clienti || [];
  const veri = cl.filter((c) => !c.prova);
  const avvisi = [];
  cl.forEach((c) => {
    (c.rossi || []).forEach((m) => avvisi.push({ cl: "rosso", c, m }));
    (c.gialli || []).forEach((m) => avvisi.push({ cl: "giallo", c, m }));
    if (c.nuovo && !c.prova) avvisi.push({ cl: "blu", c, m: "Cliente nuovo, dal " + quando(c.inizio) });
  });
  avvisi.sort((x, y) => (x.cl === "rosso" ? 0 : x.cl === "giallo" ? 1 : 2) - (y.cl === "rosso" ? 0 : y.cl === "giallo" ? 1 : 2));
  const link = (c) => base + "/pannello?t=" + tok + "&a=" + c.id;
  const s = p.soldi || {};
  const si = p.sistema || {};
  let x = testa(base, h, "Oggi") +
    '<p><a href="' + base + '/?t=' + tok + '">&larr; Torna ai cantieri</a></p>' +
    '<h1>Pannello di TIX</h1><p class="sub">Aggiornato ' + quando(p.ora, true) + ' · lo vedi solo tu</p>' + provaAvviso(p);

  x += '<section><h2>Oggi</h2><div class="griglia">' +
    '<div class="cifra"><b>' + veri.length + '</b><span>clienti</span></div>' +
    '<div class="cifra"><b>' + veri.filter((c) => c.semaforo === "rosso").length + '</b><span>da sistemare subito</span></div>' +
    '<div class="cifra"><b>' + veri.filter((c) => c.semaforo === "giallo").length + '</b><span>da guardare</span></div>' +
    '<div class="cifra"><b>' + euro(s.incassato_mese) + '</b><span>incassato questo mese</span></div>' +
    '<div class="cifra"><b>' + euro(s.atteso) + '</b><span>atteso (canoni da pagare)</span></div>' +
    '<div class="cifra"><b>' + (s.ritardi || 0) + '</b><span>pagamenti in ritardo</span></div>' +
    '</div>' +
    '<p class="sub" style="margin-top:12px">Sistema, ultime 24 ore: ' + (si.errori_make_24h || 0) + ' errori di Make · ' + (si.messaggi_fermi_24h || 0) + ' messaggi WhatsApp non ancora elaborati.</p>' +
    '</section>';

  x += '<section><h2>Avvisi</h2>' + (avvisi.length
    ? '<ul class="avv">' + avvisi.map((a) => '<li class="' + a.cl + '"><a href="' + link(a.c) + '">' + e(a.c.nome) + '</a>' + (a.c.prova ? ' <span class="tag">prova</span>' : '') + ' — ' + e(a.m) + '</li>').join("") + '</ul>'
    : '<p>Nessun avviso: tutti i clienti sono a posto.</p>') + '</section>';

  x += '<section><h2>Clienti</h2><div class="filtri" role="group" aria-label="Filtra i clienti">' +
    ['tutti:Tutti', 'rosso:Da sistemare', 'giallo:Da guardare', 'nuovo:Nuovi', 'prova:Di prova'].map((f, i) => {
      const [k, t] = f.split(":");
      return '<button type="button" data-f="' + k + '" aria-pressed="' + (i === 0) + '">' + t + '</button>';
    }).join("") + '</div>' +
    cl.map((c) => {
      const v = c.voci || {};
      const pag = (c.pagamento || {}).stato || "regolare";
      const motivi = (c.rossi || []).map((m) => '<li class="r">' + e(m) + '</li>').concat((c.gialli || []).map((m) => '<li class="g">' + e(m) + '</li>')).join("");
      return '<a class="cliente" href="' + link(c) + '" data-sem="' + c.semaforo + '" data-nuovo="' + (c.nuovo ? 1 : 0) + '" data-prova="' + (c.prova ? 1 : 0) + '">' +
        '<div class="cap"><span class="pallino p-' + c.semaforo + '" aria-hidden="true"></span><strong>' + e(c.nome) + '</strong>' +
        '<span class="tag">' + SEM[c.semaforo] + '</span>' + (c.prova ? '<span class="tag">prova</span>' : '') + (c.nuovo && !c.prova ? '<span class="tag">nuovo</span>' : '') +
        (c.note_n ? '<span class="tag">' + c.note_n + (c.note_n === 1 ? ' nota' : ' note') + '</span>' : '') + '</div>' +
        '<div class="riga"><span>Titolare <b>' + e(c.titolare || "—") + '</b></span><span>Pagamento <b>' + (STATI_PAG[pag] || pag) + '</b></span>' +
        '<span>Canone <b>' + (c.listino_v5 ? euro(c.canone_eur) : 'listino vecchio') + '</b></span>' +
        '<span>Persone <b>' + (c.persone_reali === undefined ? "—" : c.persone_reali) + '</b></span>' +
        '<span>Voci <b>' + (v.voci_usate === undefined ? "—" : v.voci_usate + " / " + v.voci_disponibili) + '</b></span>' +
        '<span>Crediti <b>' + ((c.crediti || {}).totale === undefined ? "—" : c.crediti.totale) + '</b></span>' +
        '<span>Cantieri <b>' + (c.cantieri || 0) + '</b></span><span>Numeri WhatsApp <b>' + (c.numeri || 0) + '</b></span>' +
        '<span>Ultimo uso <b>' + quando(c.ultimo_uso, true) + '</b></span></div>' +
        (motivi ? '<ul class="motivi">' + motivi + '</ul>' : '') + '</a>';
    }).join("") + '</section>';

  x += '</main><script>(function(){var b=document.querySelectorAll(".filtri button"),c=document.querySelectorAll(".cliente");' +
    'b.forEach(function(x){x.addEventListener("click",function(){var f=x.getAttribute("data-f");b.forEach(function(y){y.setAttribute("aria-pressed",String(y===x));});' +
    'c.forEach(function(k){var ok=f==="tutti"||(f==="rosso"&&k.dataset.sem==="rosso")||(f==="giallo"&&k.dataset.sem==="giallo")||(f==="nuovo"&&k.dataset.nuovo==="1")||(f==="prova"&&k.dataset.prova==="1");k.hidden=!ok;});});});' +
    '})();</script></body></html>';
  return x;
}

export function paginaScheda(base, tok, p, h) {
  const e = h.esc;
  const c = p.riga || {};
  const an = p.anagrafica || {};
  const v = c.voci || {};
  const cr = c.crediti || {};
  const as = c.assistenza;
  const pag = c.pagamento || {};
  const dd = (k, val) => '<dt>' + k + '</dt><dd>' + (val === null || val === undefined || val === "" ? "—" : val) + '</dd>';
  const mail = (x) => x ? '<a href="mailto:' + e(x) + '">' + e(x) + '</a>' : "";
  const tel = (x) => x ? '<a href="tel:' + e(String(x).replace(/\s/g, "")) + '">' + e(x) + '</a>' : "";
  const motivi = (c.rossi || []).map((m) => '<li class="r">' + e(m) + '</li>').concat((c.gialli || []).map((m) => '<li class="g">' + e(m) + '</li>')).join("");
  const perc = Math.max(0, Math.min(100, Number(v.percentuale || 0)));

  let x = testa(base, h, e(c.nome || "Impresa")) +
    '<p><a href="' + base + '/pannello?t=' + tok + '">&larr; Tutti i clienti</a></p>' +
    '<h1>' + e(c.nome || "") + '</h1><div class="cap"><span class="pallino p-' + c.semaforo + '" aria-hidden="true"></span><span class="tag">' + SEM[c.semaforo] + '</span>' +
    (c.prova ? '<span class="tag">impresa di prova: non si conta</span>' : '') + '</div>' +
    (motivi ? '<ul class="motivi">' + motivi + '</ul>' : '');

  x += '<section><h2>Impresa e titolare</h2><dl>' +
    dd("Ragione sociale", e(an.nome_completo || "")) + dd("Partita IVA", e(an.partita_iva || "")) + dd("Codice fiscale", e(an.codice_fiscale || "")) +
    dd("Codice SDI", e(an.sdi || "")) + dd("PEC", mail(an.pec)) + dd("Sede", e(an.indirizzo || "")) +
    dd("Email dell'impresa", mail(an.email_impresa)) + dd("Telefono", tel(an.telefono)) + dd("Sito", e(an.sito || "")) +
    dd("Titolare", e(an.titolare || "")) + dd("Email del titolare", mail(an.titolare_email)) + dd("Telefono del titolare", tel(an.titolare_telefono)) +
    dd("Cliente dal", quando(an.prima_attivazione || an.creata)) + dd("Configurazione", e(an.configurazione || "")) +
    dd("Disdetta", an.disdetta ? giorno(an.disdetta) : "") + dd("Cessazione", an.cessazione ? giorno(an.cessazione) : "") +
    '</dl></section>';

  x += '<section><h2>Contratto e pagamenti</h2><dl>' +
    dd("Listino", c.listino_v5 ? "89 · 22 · 12" : e("vecchio (" + (an.listino || "") + ")")) +
    dd("Stato del pagamento", e(STATI_PAG[pag.stato] || pag.stato || "") + (pag.scadenza ? " · scadenza " + giorno(pag.scadenza) : "") +
      (pag.sospesa_dal ? " · sospesa dal " + giorno(pag.sospesa_dal) : "") + (pag.chiusa_il ? " · chiusa il " + giorno(pag.chiusa_il) : "")) +
    dd("Canone del mese", c.listino_v5 ? euro(c.canone_eur) + " · calcolato su " + (c.persone_canone || 0) + " persone" : "") +
    dd("Termini accettati", p.contratto ? quando(p.contratto.termini_il, true) + " · versione " + e(p.contratto.versione || "") : "") +
    dd("Carta registrata su Stripe", an.stripe ? "sì" : "no") +
    '</dl>' +
    ((c.in_attesa || []).length ? '<h3>Da pagare</h3><table><thead><tr><th>Scadenza</th><th>Importo</th><th>Modo</th><th>Riferimento</th></tr></thead><tbody>' +
      c.in_attesa.map((r) => '<tr><td>' + giorno(r.scadenza) + '</td><td>' + euro(r.importo) + '</td><td>' + e(r.modo || "") + '</td><td>' + e(r.riferimento || "") + '</td></tr>').join("") + '</tbody></table>' : '') +
    ((p.canoni || []).length ? '<h3>Canoni</h3><table><thead><tr><th>Periodo</th><th>Persone</th><th>Importo</th><th>Stato</th><th>Pagato</th></tr></thead><tbody>' +
      p.canoni.map((r) => '<tr><td>' + giorno(r.dal) + ' – ' + giorno(r.al) + '</td><td>' + (r.persone || 0) + '</td><td>' + euro(r.importo) + '</td><td>' + e(({ in_attesa: "da pagare", pagato: "pagato", annullato: "annullato" })[r.stato] || r.stato || "") + (r.modo ? " · " + e(r.modo) : "") + '</td><td>' + (r.pagato_il ? quando(r.pagato_il) : "") + '</td></tr>').join("") + '</tbody></table>'
      : '<p class="sub">Nessun canone con il listino nuovo.</p>') +
    ((p.pagamenti_vecchi || []).length ? '<h3>Pagamenti del listino vecchio</h3><table><thead><tr><th>Tipo</th><th>Periodo</th><th>Importo</th><th>Incassato</th></tr></thead><tbody>' +
      p.pagamenti_vecchi.map((r) => '<tr><td>' + e(r.tipo || "") + '</td><td>' + giorno(r.dal) + (r.al ? ' – ' + giorno(r.al) : '') + '</td><td>' + euro(r.importo) + '</td><td>' + (r.incassato ? quando(r.incassato_il) : "no") + '</td></tr>').join("") + '</tbody></table>' : '') +
    ((p.ritardi || []).length ? '<h3>Ritardi</h3><table><thead><tr><th>Scadenza</th><th>Promemoria</th><th>Avviso</th><th>Sospesa</th><th>Chiusa</th><th>Riaperta</th></tr></thead><tbody>' +
      p.ritardi.map((r) => '<tr><td>' + giorno(r.scadenza) + '</td><td>' + giorno(r.promemoria_il) + '</td><td>' + giorno(r.avviso_il) + '</td><td>' + giorno(r.sospesa_dal) + '</td><td>' + giorno(r.chiusa_il) + '</td><td>' + giorno(r.riaperta_il) + '</td></tr>').join("") + '</tbody></table>' : '') +
    '</section>';

  const fermi = p.servizi_fermi || {};
  x += '<section><h2>Uso del mese</h2><dl>' +
    dd("Periodo", v.dal ? giorno(v.dal) + " – " + giorno(v.al) : "") +
    dd("Voci", v.voci_usate === undefined ? "" : v.voci_usate + " usate su " + v.voci_disponibili + " (" + v.voci_comprese + " comprese" + (v.voci_pacchetti ? " + " + v.voci_pacchetti + " dei pacchetti" : "") + ") · " + perc + " %" +
      '<div class="barra" role="img" aria-label="' + perc + ' per cento delle voci usate"><i style="width:' + perc + '%"></i></div>') +
    dd("Voci in più", v.voci_in_piu ? v.voci_in_piu + " · pacchetti da comprare: " + (v.pacchetti_da_comprare || 0) : "nessuna") +
    dd("Servizi fermi per voci finite", fermi.fermi ? '<span class="err">sì</span>' + (fermi.motivo ? " · " + e(fermi.motivo) : "") : "nessuno") +
    dd("Crediti", cr.totale === undefined ? "" : cr.totale + " (comprati " + (cr.comprati || 0) + ", compresi " + (cr.compresi || 0) + ")" + (cr.prossima_scadenza ? " · prossima scadenza " + e(cr.prossima_scadenza) : "")) +
    dd("Ore di assistenza", as ? (as.credito_minuti || 0) + " minuti rimasti · questo mese " + (as.minuti_mese_corrente || 0) + " minuti" + (as.prossima_scadenza ? " · scadono il " + giorno(as.prossima_scadenza) : "") : "nessuna comprata") +
    dd("Ultimo accesso all'app", quando(c.ultimo_accesso, true)) + dd("Ultima voce da WhatsApp", quando(c.ultima_voce, true)) +
    '</dl></section>';

  const pc = p.contate || {};
  // Parere B12 via B6 (16/11): nella scheda solo numeri, mai orari o accessi persona per persona.
  x += '<section><h2>Persone</h2><p class="sub">Contate negli ultimi 30 giorni: <b>' + (pc.persone || 0) + '</b> (' + (pc.accessi || 0) + ' con l\'accesso all\'app, ' + (pc.numeri || 0) + ' con il numero WhatsApp). ' +
    'Gli orari e gli accessi delle singole persone non si mostrano: servono solo alla sicurezza.</p>' +
    '<h3>Accessi personali all\'app</h3>' + ((p.utenti || []).length ? '<table><thead><tr><th>Nome</th><th>Email</th><th>Ruolo</th><th>Dispositivi attivi</th></tr></thead><tbody>' +
      p.utenti.map((u) => '<tr><td>' + e(u.nome || "") + (u.attivo ? "" : ' <span class="tag">tolto</span>') + '</td><td>' + mail(u.email) + '</td><td>' + e(u.ruolo || "") + '</td><td>' + (u.dispositivi || 0) + '</td></tr>').join("") + '</tbody></table>'
      : '<p class="sub">Nessuno ha ancora l\'accesso personale.</p>') +
    ((p.collegamenti || []).length ? '<h3>Collegamenti condivisi</h3><table><thead><tr><th>Collegamento</th><th>Attivo</th><th>Ultimo uso</th><th>Usi</th></tr></thead><tbody>' +
      p.collegamenti.map((u) => '<tr><td>' + e(u.etichetta || "") + '</td><td>' + (u.attivo ? "sì" : "no") + '</td><td>' + quando(u.ultimo, true) + '</td><td>' + (u.accessi || 0) + '</td></tr>').join("") + '</tbody></table>' : '') +
    '<h3>Numeri WhatsApp</h3>' + ((p.numeri || []).length ? '<table><thead><tr><th>Nome</th><th>Telefono</th><th>Ruolo</th><th>Rapporto</th><th>Registrato il</th></tr></thead><tbody>' +
      p.numeri.map((u) => '<tr><td>' + e(u.nome || "") + '</td><td>' + tel(u.telefono) + '</td><td>' + e(u.ruolo || "") + '</td><td>' + e(u.rapporto || "dipendente") + '</td><td>' + quando(u.registrato) + '</td></tr>').join("") + '</tbody></table>'
      : '<p class="sub">Nessun numero.</p>') +
    '</section>';

  x += '<section><h2>Cantieri</h2>' + ((p.cantieri || []).length ? '<table><thead><tr><th>Cantiere</th><th>Stato</th><th>Voci del mese</th><th>Chi scrive (30 giorni)</th><th>Ultima voce</th></tr></thead><tbody>' +
    p.cantieri.map((k) => '<tr><td>' + e(k.nome || "") + '</td><td>' + (k.chiuso ? "chiuso il " + quando(k.chiuso) : e(k.stato || "")) + '</td><td>' + (k.voci_mese || 0) + '</td><td>' + (k.chi_scrive || 0) + '</td><td>' + quando(k.ultima_voce, true) + '</td></tr>').join("") + '</tbody></table>'
    : '<p class="sub">Nessun cantiere.</p>') + '</section>';

  x += '<section><h2>Movimenti</h2><h3>Crediti</h3>' + ((p.crediti_movimenti || []).length ? '<table><thead><tr><th>Quando</th><th>Tipo</th><th>Crediti</th><th>Descrizione</th></tr></thead><tbody>' +
    p.crediti_movimenti.map((r) => '<tr><td>' + quando(r.quando) + '</td><td>' + e(r.tipo || "") + '</td><td>' + (r.crediti || 0) + '</td><td>' + e(r.descrizione || "") + '</td></tr>').join("") + '</tbody></table>' : '<p class="sub">Nessuno.</p>') +
    '<h3>Ore di assistenza</h3>' + ((p.assistenza_movimenti || []).length ? '<table><thead><tr><th>Quando</th><th>Tipo</th><th>Minuti</th><th>Descrizione</th></tr></thead><tbody>' +
    p.assistenza_movimenti.map((r) => '<tr><td>' + quando(r.quando) + '</td><td>' + e(r.tipo || "") + '</td><td>' + (r.minuti || 0) + '</td><td>' + e(r.descrizione || "") + '</td></tr>').join("") + '</tbody></table>' : '<p class="sub">Nessuno.</p>') +
    '<h3>Email mandate dal sistema</h3>' + ((p.email || []).length ? '<table><thead><tr><th>Quando</th><th>A</th><th>Oggetto</th><th>Partita</th></tr></thead><tbody>' +
    p.email.map((r) => '<tr><td>' + quando(r.quando, true) + '</td><td>' + e(r.a || "") + '</td><td>' + e(r.oggetto || "") + '</td><td>' + (r.inviata ? "sì" : "in coda") + '</td></tr>').join("") + '</tbody></table>' : '<p class="sub">Nessuna.</p>') +
    '</section>';

  x += '<section><h2>Le tue note</h2><p class="sub">Le vedi solo tu. Una nota tolta resta nel registro.</p><div id="note">' +
    ((p.note || []).length ? p.note.map((n) => '<div class="nt"><div class="sub">' + quando(n.quando, true) + ' <button type="button" class="piccolo" data-togli="' + n.id + '">Togli</button></div><p>' + e(n.testo) + '</p></div>').join("") : '<p class="sub">Nessuna nota.</p>') +
    '</div><label for="nn" class="sub" style="display:block;margin-top:10px">Nuova nota</label><textarea id="nn" maxlength="4000"></textarea>' +
    '<button type="button" class="az" id="salva">Salva la nota</button> <span id="esito" class="err" role="status"></span></section>';

  const cfg = JSON.stringify({ u: base + "/pannello/azione", t: tok, a: c.id }).replace(/</g, "\\u003c");
  x += '</main><script>(function(){var C=' + cfg + ',E=document.getElementById("esito");' +
    'function chiama(d){return fetch(C.u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({t:C.t,azione:"nota",dati:d})}).then(function(r){return r.json();});}' +
    'document.getElementById("salva").addEventListener("click",function(){var t=document.getElementById("nn"),b=this;E.textContent="";' +
    'if(!t.value.trim()){t.style.borderColor="var(--r)";E.textContent="Scrivi la nota prima di salvarla.";t.focus();return;}' +
    'b.disabled=true;chiama({azienda:C.a,testo:t.value}).then(function(r){if(r&&r.esito==="ok"){location.reload();return;}b.disabled=false;E.textContent="Nota non salvata: riprova.";}).catch(function(){b.disabled=false;E.textContent="Il servizio non risponde: riprova.";});});' +
    'document.addEventListener("click",function(ev){var b=ev.target.closest&&ev.target.closest("button[data-togli]");if(!b)return;if(!confirm("Togliere questa nota?"))return;b.disabled=true;' +
    'chiama({azienda:C.a,togli:b.getAttribute("data-togli")}).then(function(r){if(r&&r.esito==="ok"){location.reload();return;}b.disabled=false;E.textContent="Nota non tolta: riprova.";});});' +
    '})();</script></body></html>';
  return x;
}
