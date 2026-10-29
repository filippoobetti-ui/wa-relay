// ============================================================================
// RAPPORTINI DELL'UFFICIO — anche con data passata (22/10/2026, pacchetto A approvato da Filippo il 22/10).
// Nell'area riservata si scrive un rapportino per un giorno scelto da un calendario del mese, da PC, telefono o tablet:
//   GET  /rapportino?t=<gettone>&c=<cantiere>[&m=AAAA-MM][&g=AAAA-MM-GG]  → calendario, giorno scelto, modulo
//   POST /rapportino/salva   {t, c, dati}            → RPC rapportino_salva (bozza; con dati.registra la registra)
//   POST /rapportino/azione  {t, id, azione, dati}   → RPC rapportino_azione (correggi, annulla, scarta, leggi)
//   GET  /rapportino/documento?t=<gettone>&id=<n>[&originale=1] → documento registrato (da stampare, o il file originale)
// Il database decide tutto: giorni ammessi, numero, testo del documento e impronta SHA-256 (livello L1), versioni.
// Una correzione non riscrive niente: nasce una versione nuova con il motivo e la vecchia resta con la sua impronta.
// Il diario di cantiere del giorno non si tocca mai. Il relay non conserva nulla.
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GETTONE = /^[0-9a-f]{64}$/;
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

function json(o, stato) {
  return new Response(JSON.stringify(o), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

async function leggiCorpo(request) {
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return { errore: 415 };
  try {
    const t = await request.text();
    if (t.length > 16000) return { errore: 413 };
    const b = JSON.parse(t);
    return b && typeof b === "object" ? b : { errore: 400 };
  } catch (e) { return { errore: 400 }; }
}

function pulisciDati(d) {
  const o = {};
  if (!d || typeof d !== "object") return o;
  const s = (k, n) => { if (d[k] !== undefined && d[k] !== null) o[k] = String(d[k]).slice(0, n); };
  s("data", 10); s("lavorazioni", 4000); s("luogo", 200); s("mezzi", 2000); s("note", 2000); s("autore", 120); s("motivo", 600);
  if (/^[0-9]{1,18}$/.test(String(d.id || ""))) o.id = String(d.id);
  if (d.registra === true) o.registra = true;
  if (Array.isArray(d.manodopera)) {
    const t = (v, n) => String(v == null ? "" : v).slice(0, n);
    o.manodopera = d.manodopera.slice(0, 30).filter((r) => r && typeof r === "object")
      .map((r) => ({ squadra: t(r.squadra, 120), qualifica: t(r.qualifica, 20), operai: t(r.operai, 5), ore: t(r.ore, 6), economia: r.economia === "si" ? "si" : "no" }));
  }
  // Cronoprogramma (23/10/2026, pacchetto B): attività eseguite con l'esito
  if (Array.isArray(d.crono)) {
    o.crono = d.crono.filter((r) => r && typeof r === "object" && UUID.test(String(r.attivita_id || "").toLowerCase())).slice(0, 15)
      .map((r) => ({ attivita_id: String(r.attivita_id).toLowerCase(), esito: String(r.esito || "").slice(0, 12), pct: String(r.pct == null ? "" : r.pct).slice(0, 3) }));
  }
  return o;
}

export async function portaleRapportino(request, env, base, inUrl, h) {
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length);
  if (sotto === "/rapportino/salva" || sotto === "/rapportino/azione") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    const b = await leggiCorpo(request);
    if (b.errore) return json({ esito: "errore" }, b.errore);
    const tok = String(b.t || "").toLowerCase();
    if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
    if (sotto === "/rapportino/salva") {
      const c = String(b.c || "").toLowerCase();
      if (!UUID.test(c)) return json({ esito: "errore" }, 400);
      const r = await h.rpc(env, "rapportino_salva", { p_token: tok, p_commessa: c, p_dati: pulisciDati(b.dati) }, 20000).catch(() => null);
      return r ? json(r) : json({ esito: "incerto" });
    }
    const id = Number(b.id);
    const az = String(b.azione || "");
    if (!Number.isInteger(id) || id <= 0 || ["correggi", "annulla", "scarta", "leggi"].indexOf(az) === -1) return json({ esito: "errore" }, 400);
    const r = await h.rpc(env, "rapportino_azione", { p_token: tok, p_id: id, p_azione: az, p_dati: pulisciDati(b.dati) }, 20000).catch(() => null);
    return r ? json(r) : json({ esito: "incerto" });
  }
  if (sotto === "/rapportino/documento") return documento(request, env, base, inUrl, h);
  if (sotto !== "/rapportino") return new Response("Not Found", { status: 404 });
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  const torna = base + "/?t=" + tok;
  if (!UUID.test(c)) return Response.redirect(inUrl.origin + torna, 303);
  const g = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(inUrl.searchParams.get("g") || "") ? inUrl.searchParams.get("g") : "";
  const mese = /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(inUrl.searchParams.get("m") || "") ? inUrl.searchParams.get("m") : g.slice(0, 7);
  const d = await h.rpc(env, "rapportino_contesto", { p_token: tok, p_commessa: c, p_mese: mese }, 15000).catch(() => null);
  if (!d) {
    return h.risposta(h.foglio(base, "Rapportini", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>' +
      '<p class="piede"><a href="' + torna + '">&larr; Torna ai cantieri</a></p>'), 503);
  }
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return Response.redirect(inUrl.origin + torna, 303);
  return new Response(metodo === "HEAD" ? null : paginaRapportino(base, tok, c, d, g, h), { status: 200, headers: h.headers() });
}

// ---------------------------------------------------------------------------- documento registrato
async function documento(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const id = Number(inUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return new Response("Not Found", { status: 404 });
  const r = await h.rpc(env, "rapportino_documento", { p_token: tok, p_id: id }, 15000).catch(() => null);
  if (!r) return h.risposta(h.foglio(base, "Rapportino", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), 503);
  if (r.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (r.esito !== "ok" || typeof r.html !== "string") return h.risposta(h.foglio(base, "Rapportino", "", '<p class="err">Documento non trovato.</p>'), 404);
  const nome = "Rapportino-ufficio-n" + (Number(r.numero) || 0) + "-v" + (Number(r.versione) || 1) + ".html";
  // L'originale è il testo registrato, byte per byte: è quello su cui si verifica l'impronta.
  if (inUrl.searchParams.get("originale") === "1") {
    return new Response(metodo === "HEAD" ? null : r.html, { status: 200, headers: {
      "Content-Type": "text/html; charset=UTF-8", "Content-Disposition": 'attachment; filename="' + nome + '"',
      "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
  }
  const e = h.esc;
  const c = UUID.test(String(r.commessa_id || "")) ? String(r.commessa_id) : "";
  const succ = Number(r.successivo) || 0;
  const barra = '<div class="rp-barra">' +
    (c ? '<a href="' + e(base + "/rapportino?t=" + tok + "&c=" + c) + '">&larr; Calendario dei rapportini</a>' : "") +
    '<button type="button" onclick="window.print()">Stampa o salva in PDF</button>' +
    '<a href="' + e(base + "/rapportino/documento?t=" + tok + "&id=" + id + "&originale=1") + '">Scarica l’originale</a>' +
    (r.stato === "sostituito" && succ
      ? '<p class="rp-av">Questa versione è stata sostituita. <a href="' + e(base + "/rapportino/documento?t=" + tok + "&id=" + succ) + '">Apri la versione successiva</a>.</p>' : "") +
    '<p class="rp-nota">Impronta SHA-256 registrata: <code>' + e(r.impronta || "") + "</code></p></div>";
  const stile = '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">' +
    '<title>' + e(nome.replace(/\.html$/, "").replace(/-/g, " ")) + "</title><style>" +
    '.rp-barra{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#FFF7EA;border:1px solid #F1D7AE;border-radius:10px;padding:10px 12px;margin:0 0 16px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;font-size:13px}' +
    ".rp-barra a{color:#8A4A06;font-weight:700}.rp-barra button{font:inherit;font-weight:700;border:1px solid #C27A12;background:#C27A12;color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}" +
    ".rp-barra p{flex-basis:100%;margin:0}.rp-av{color:#8c1d18;font-weight:700}.rp-nota{color:#5b6560;font-size:12px;overflow-wrap:anywhere}@media print{.rp-barra{display:none}}</style>";
  let html = r.html;
  html = html.indexOf("</head>") !== -1 ? html.replace("</head>", () => stile + "</head>") : stile + html;
  html = html.indexOf("<body>") !== -1 ? html.replace("<body>", () => "<body>" + barra) : barra + html;
  return new Response(metodo === "HEAD" ? null : html, { status: 200, headers: h.headers() });
}

// ---------------------------------------------------------------------------- pagina
function meseVicino(ay, am, passo) {
  const t = ay * 12 + (am - 1) + passo;
  return Math.floor(t / 12) + "-" + String((t % 12) + 1).padStart(2, "0");
}

export function paginaRapportino(base, tok, c, d, g, h) {
  const e = h.esc;
  const cant = d.cantiere || {};
  const torna = base + "/?t=" + tok + "&c=" + c + "#r";
  const logoImpresa = d.logo_impresa
    ? '<div class="dx"><div class="logo-impresa"><img src="' + e(d.logo_impresa) + '" alt="' + e(d.azienda_nome) + '"></div></div>'
    : '<div class="dx"></div>';
  const mese = /^[0-9]{4}-[0-9]{2}$/.test(String(d.mese || "")) ? String(d.mese) : String(d.oggi || "").slice(0, 7);
  const ay = Number(mese.slice(0, 4)), am = Number(mese.slice(5, 7));
  const min = String(d.data_min || ""), max = String(d.data_max || "");
  const giorni = Array.isArray(d.giorni) ? d.giorni : [];
  const link = (mm, gg) => base + "/rapportino?t=" + tok + "&c=" + c + "&m=" + mm + (gg ? "&g=" + gg : "");
  const mPrec = meseVicino(ay, am, -1), mSucc = meseVicino(ay, am, 1);
  const nav = '<div class="cal-nav">' +
    (mPrec >= min.slice(0, 7) ? '<a class="fr" href="' + e(link(mPrec, "")) + '" aria-label="Mese precedente">&lsaquo;</a>' : '<span class="fr off">&lsaquo;</span>') +
    '<div class="mese">' + e(MESI[am - 1] || "") + " " + ay + "</div>" +
    (mSucc <= max.slice(0, 7) ? '<a class="fr" href="' + e(link(mSucc, "")) + '" aria-label="Mese successivo">&rsaquo;</a>' : '<span class="fr off">&rsaquo;</span>') +
    "</div>";
  let griglia = ["Lu", "Ma", "Me", "Gi", "Ve", "Sa", "Do"].map((x) => '<span class="gs">' + x + "</span>").join("");
  const vuoti = (new Date(Date.UTC(ay, am - 1, 1)).getUTCDay() + 6) % 7;
  for (let i = 0; i < vuoti; i++) griglia += '<span class="gv"></span>';
  for (const x of giorni) {
    const gg = String(x.g || "");
    const n = Number(gg.slice(8, 10)) || "";
    const fuori = gg < min || gg > max;
    const cl = ["gg"];
    if (fuori) cl.push("fuori");
    if (x.diario) cl.push("dia"); else if (Number(x.voci) > 0) cl.push("voci");
    if (Number(x.uff) > 0) cl.push("uff");
    if (Number(x.bozze) > 0) cl.push("boz");
    if (gg === d.oggi) cl.push("oggi");
    if (gg === g) cl.push("sel");
    griglia += fuori ? '<span class="' + cl.join(" ") + '">' + n + "</span>"
      : '<a class="' + cl.join(" ") + '" href="' + e(link(mese, gg)) + '" data-g="' + e(gg) + '">' + n + "</a>";
  }
  const dati = JSON.stringify({
    base: base, t: tok, c: c, oggi: d.oggi, min: min, max: max, mese: mese, g: g, chiuso: d.chiuso === true,
    giorni: giorni, diari: Array.isArray(d.diari) ? d.diari : [], rapportini: Array.isArray(d.rapportini) ? d.rapportini : [],
    crono: Array.isArray(d.crono) ? d.crono : []
  }).replace(/</g, "\\u003c");
  const conCrono = Array.isArray(d.crono) && d.crono.length > 0;
  const opzQ = '<option value="">Qualifica</option><option value="comune">Operaio comune</option><option value="qualificato">Operaio qualificato</option>' +
    '<option value="specializzato">Operaio specializzato</option><option value="capo_squadra">Capo squadra</option>';
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>Rapportini - " + e(cant.nome || "") + "</title>" + h.testa(base) +
    "<style>" + STILE + "</style></head><body>" +
    "<header>" + (d.logo_html || '<div class="marchio">TIX · Diario di cantiere</div>') +
    '<div class="centro"><h1>Rapportini</h1><p>' + e(cant.nome || "") + (cant.ubicazione ? " &middot; " + e(cant.ubicazione) : "") + "</p></div>" + logoImpresa + "</header>" +
    '<main><a class="indietro" href="' + e(torna) + '">&larr; Torna al cantiere</a>' +
    (d.chiuso ? '<div class="avviso">Cantiere chiuso: i rapportini restano consultabili, non se ne registrano di nuovi.</div>' : "") +
    '<section class="cal" aria-label="Calendario dei rapportini">' + nav + '<div class="griglia">' + griglia + "</div>" +
    '<div class="leg"><span><i class="l-dia"></i>diario di cantiere</span><span><i class="l-uff"></i>rapportino dell’ufficio</span>' +
    '<span><i class="l-boz"></i>bozza</span><span><i class="l-vuo"></i>nessuna registrazione</span></div></section>' +
    '<section id="giorno" class="pannello"><p class="nota" style="margin:0">Tocca un giorno del calendario: vedi cosa c’è già e puoi scrivere il rapportino di quel giorno.</p></section>' +
    // modulo
    '<section id="modulo" class="pannello" hidden><div class="tit" id="mo-tit">Nuovo rapportino</div>' +
    '<form id="mo-form" novalidate>' +
    '<label>Giorno a cui si riferisce<input type="date" id="f-data" min="' + e(min) + '" max="' + e(max) + '" required></label>' +
    '<label>Lavorazioni eseguite<textarea id="f-lav" rows="4" maxlength="4000" placeholder="es. Posa di casseri e ferri del solaio del piano 1"></textarea></label>' +
    (conCrono ? '<div class="et">Attività del cronoprogramma <small>(facoltativo: scegli quelle lavorate e com’è andata)</small></div>' +
      '<input type="search" id="f-cr-q" placeholder="Cerca un’attività" autocomplete="off"><div class="cr-l" id="f-cr"></div>' : "") +
    '<label>Dove <small>(facoltativo)</small><input type="text" id="f-luogo" maxlength="200" placeholder="es. Piano 1, blocco B"></label>' +
    '<div class="et">Manodopera</div><div id="f-mano"></div>' +
    '<button type="button" class="piccolo-b" id="f-agg">+ Aggiungi una riga</button><p class="tot" id="f-tot"></p>' +
    '<label>Mezzi e noli <small>(facoltativo)</small><textarea id="f-mezzi" rows="2" maxlength="2000" placeholder="es. autogru 4 ore, escavatore"></textarea></label>' +
    '<label>Note <small>(facoltative)</small><textarea id="f-note" rows="2" maxlength="2000"></textarea></label>' +
    '<label id="l-motivo" hidden>Motivo della correzione<textarea id="f-motivo" rows="2" maxlength="600" placeholder="es. gli operai erano tre, non due"></textarea></label>' +
    '<label>Registrato da <small>(nome e cognome)</small><input type="text" id="f-autore" maxlength="120" autocomplete="name"></label>' +
    '<p class="msg" id="mo-msg" aria-live="polite"></p>' +
    '<div class="bott"><button type="button" class="no" id="mo-chiudi">Chiudi</button><button type="button" class="sec" id="mo-bozza">Salva bozza</button>' +
    '<button type="submit" class="si" id="mo-reg">Registra</button></div>' +
    "</form></section>" +
    '<template id="riga-m"><div class="riga-m"><input type="text" class="m-sq" maxlength="120" placeholder="Squadra o impresa">' +
    '<select class="m-q">' + opzQ + "</select>" +
    '<input type="number" class="m-op" min="1" max="200" step="1" inputmode="numeric" placeholder="Operai">' +
    '<input type="text" class="m-ore" maxlength="6" inputmode="decimal" placeholder="Ore">' +
    '<label class="m-eco" title="Lavori extra, fuori contratto"><input type="checkbox" class="m-e"> In economia</label>' +
    '<button type="button" class="m-x" aria-label="Togli la riga">&times;</button></div></template>' +
    '<p class="nota">Il rapportino dell’ufficio è un documento a parte: il diario di cantiere del giorno resta com’è. ' +
    'Con «Registra» riceve un numero e un’impronta SHA-256 (livello L1) e non si modifica più: ogni correzione crea una versione nuova con il motivo, ' +
    'e quella di prima resta consultabile. Solo le righe con «In economia» (lavori extra, fuori contratto) entrano nella lista settimanale delle ore in economia, se la lista di quella settimana non è ancora uscita ' +
    '(il lunedì alle 6:30).</p>' +
    "<noscript><p class=\"nota\"><b>Per scrivere i rapportini serve JavaScript attivo nel browser.</b></p></noscript>" +
    "</main>" +
    // annullamento
    '<dialog id="an-dlg" aria-labelledby="an-tit"><form method="dialog" id="an-form">' +
    '<div class="dl-t"><h2 id="an-tit">Annullare il rapportino?</h2><p id="an-sub"></p></div><div class="dl-c">' +
    '<p class="piccolo">Il rapportino non si cancella: nasce una versione «annullata» con il motivo, e quella di prima resta consultabile con la sua impronta.</p>' +
    '<label>Motivo dell’annullamento<textarea id="an-motivo" rows="2" maxlength="600" placeholder="es. rapportino inserito due volte"></textarea></label>' +
    '<label>Annullato da <small>(nome e cognome)</small><input type="text" id="an-autore" maxlength="120" autocomplete="name"></label>' +
    '<p class="msg" id="an-msg" aria-live="polite"></p></div>' +
    '<div class="dl-b"><button type="button" class="no" id="an-no">Indietro</button><button type="submit" class="si rosso" id="an-si">Annulla il rapportino</button></div>' +
    "</form></dialog>" +
    "<script>var GL_RP=" + dati + ";" + SCRIPT + "</script></body></html>";
}

const STILE =
  ":root{--accento:#0A7D48;--bordo:#d5dcd8;--sfondo:#F4F6F5;--ar:#C27A12;--ar-s:#8A4A06;--ar-c:#FFF7EA;--ar-b:#F1D7AE}" +
  '*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding:0 0 40px;background:var(--sfondo);color:#111;line-height:1.45;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
  "header{background:#052A21;color:#fff;padding:16px 20px 18px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;column-gap:16px}" +
  "header .logo{display:block;height:44px;width:auto}header .marchio{font-weight:800;font-size:1.05rem}" +
  "header .centro{grid-column:2;grid-row:1;text-align:center}header .centro p{margin:4px 0 0;font-size:.88rem;opacity:.9}" +
  "@keyframes gl-argento{0%{background-position:0% 50%}100%{background-position:100% 50%}}" +
  "header h1{margin:0;font-size:clamp(1.4rem,3vw,1.9rem);letter-spacing:-.01em;background:linear-gradient(90deg,#9AA6AB 0%,#E9EEF0 22%,#FFFFFF 38%,#C9D3D6 55%,#F4F7F8 72%,#9AA6AB 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent}" +
  "@media (prefers-reduced-motion:no-preference){header h1{animation:gl-argento 3.5s ease-in-out infinite alternate}}" +
  "header .dx{grid-column:3;grid-row:1;justify-self:end}" +
  "header .logo-impresa{display:inline-block;background:#fff;border-radius:12px;padding:8px 14px;box-shadow:0 2px 10px rgba(0,0,0,.12)}" +
  "header .logo-impresa img{display:block;height:52px;width:auto;max-width:240px;object-fit:contain}" +
  "@media (max-width:640px){header{grid-template-columns:1fr auto}header .centro{grid-column:1/-1;grid-row:2;margin-top:12px}header .dx{grid-column:2}header .logo{height:36px}header .logo-impresa img{height:40px}}" +
  "main{max-width:680px;margin:0 auto;padding:16px 16px 0}" +
  "a.indietro{display:inline-flex;align-items:center;min-height:44px;padding:0 12px 0 0;margin:-8px 0 4px;font-size:.95rem;font-weight:800;color:#0A7D48;text-decoration:none}" +
  ".avviso{background:#fff;border-left:4px solid var(--ar);border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:.92rem}" +
  ".cal,.pannello{background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:12px 14px;margin:0 0 14px}" +
  ".cal-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.cal-nav .mese{font-weight:800;font-size:1.05rem;text-transform:capitalize;color:var(--ar-s)}" +
  ".cal-nav .fr{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:var(--ar);color:#fff;font-size:1.6rem;line-height:1;text-decoration:none;padding-bottom:3px}.cal-nav .fr.off{background:#E4E8E6;color:#fff}" +
  ".griglia{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}" +
  ".gs{text-align:center;font-size:.74rem;font-weight:700;color:#5b6560;padding:2px 0}" +
  ".gg{position:relative;display:flex;align-items:center;justify-content:center;min-height:44px;border-radius:10px;background:#F4F6F5;color:#23302A;font-weight:600;font-variant-numeric:tabular-nums;text-decoration:none}" +
  ".gg.voci{background:#EEF6F1}.gg.dia{background:#E3F3EA;color:#0B5E37;font-weight:800}" +
  '.gg.uff::after{content:"";position:absolute;bottom:5px;left:50%;width:8px;height:8px;margin-left:-4px;border-radius:50%;background:var(--ar)}' +
  ".gg.boz{outline:2px dashed var(--ar);outline-offset:-3px}.gg.oggi{text-decoration:underline;text-underline-offset:3px}" +
  ".gg.sel{box-shadow:inset 0 0 0 3px #052A21}.gg.fuori{background:transparent;color:#B9C3BE;font-weight:400}" +
  ".leg{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font-size:.78rem;color:#4A524E}.leg span{display:inline-flex;align-items:center;gap:6px}" +
  ".leg i{display:inline-block;width:14px;height:14px;border-radius:4px}.l-dia{background:#E3F3EA;border:1px solid #9ED3B4}.l-uff{background:var(--ar);border-radius:50%!important;width:9px!important;height:9px!important}" +
  ".l-boz{outline:2px dashed var(--ar);outline-offset:-2px;background:#fff}.l-vuo{background:#F4F6F5;border:1px solid #E1E6E3}" +
  ".tit{font-size:.98rem;color:var(--ar-s);font-weight:800;margin:0 0 8px;padding-bottom:4px;border-bottom:2px solid var(--ar)}" +
  ".info{font-size:.88rem;color:#4A524E;margin:0 0 10px}.info a{color:#0A7D48;font-weight:700}" +
  ".rp{border:1px solid var(--bordo);border-radius:10px;padding:10px 12px;margin:0 0 8px}.rp.bz{border-style:dashed;border-color:var(--ar)}.rp.ann .t{text-decoration:line-through}" +
  ".rp .t{font-weight:700}.rp .n{font-size:.88rem;color:#333;white-space:pre-line;margin-top:2px;overflow-wrap:anywhere}.rp .k{font-size:.76rem;color:#4A524E;margin-top:3px}" +
  ".pl{display:inline-block;border-radius:999px;padding:0 8px;font-size:.72rem;font-weight:700;margin-left:6px;vertical-align:middle}.pl.ann{background:#fdeaea;color:#8c1d18}.pl.mov{background:#FFF4DC;color:#7A5300}" +
  ".az{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.az button,.az a{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border-radius:8px;border:1px solid var(--bordo);background:#fff;color:#23302A;font:inherit;font-size:.84rem;font-weight:600;cursor:pointer;text-decoration:none}" +
  ".az .rosso{color:#8c1d18;border-color:#f0c9c6}.az button:disabled{opacity:.5}" +
  "details.vers{margin-top:6px;font-size:.8rem;color:#4A524E}details.vers summary{cursor:pointer}details.vers div{margin:4px 0 0 10px}details.vers a{color:var(--ar-s);font-weight:600}" +
  ".nuovo{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;min-height:50px;margin:6px 0 0;border:0;border-radius:12px;background:var(--ar);color:#fff;font:inherit;font-weight:700;font-size:1rem;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15)}" +
  ".pannello label{display:block;font-weight:600;font-size:.9rem;margin:10px 0 0}.pannello label small,.dl-c label small{font-weight:400;color:#666}" +
  ".pannello input,.pannello select,.pannello textarea,.dl-c input,.dl-c textarea{display:block;width:100%;margin-top:4px;font:inherit;font-size:1rem;padding:10px;border:1px solid var(--bordo);border-radius:10px;background:#fff;color:#111}" +
  ".et{font-weight:600;font-size:.9rem;margin:12px 0 4px}" +
  ".riga-m{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(0,1.6fr) minmax(0,.8fr) minmax(0,.8fr) auto 40px;gap:6px;margin:0 0 6px;align-items:center}" +
  ".riga-m input,.riga-m select{margin-top:0!important;padding:9px 8px!important;font-size:.95rem!important}" +
  ".m-x{width:40px;height:40px;border-radius:10px;border:1px solid #f0c9c6;background:#fff;color:#8c1d18;font-size:1.3rem;cursor:pointer}" +
  "@media (max-width:560px){.riga-m{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 40px;padding:8px;border:1px solid #E4E8E6;border-radius:10px}" +
  ".riga-m .m-sq{grid-column:1/3;grid-row:1}.riga-m .m-x{grid-column:3;grid-row:1}.riga-m .m-q{grid-column:1/4;grid-row:2}" +
  ".riga-m .m-op{grid-column:1;grid-row:3}.riga-m .m-ore{grid-column:2/4;grid-row:3}.riga-m .m-eco{grid-column:1/4;grid-row:4}}" +
  ".m-eco{display:inline-flex!important;align-items:center;gap:6px;margin:0!important;font-weight:600;font-size:.85rem;white-space:nowrap}.m-eco input{width:auto!important;margin:0!important}" +
  ".piccolo-b{min-height:38px;padding:0 12px;border-radius:8px;border:1px dashed var(--ar);background:#fff;color:var(--ar-s);font:inherit;font-weight:700;font-size:.88rem;cursor:pointer}" +
  ".tot{font-size:.9rem;font-weight:700;color:var(--ar-s);margin:8px 0 0}.tot:empty{display:none}" +
  ".cr-l{max-height:260px;overflow:auto;border:1px solid var(--bordo);border-radius:10px;margin-top:6px;background:#fff}" +
  ".cr-i{border-bottom:1px solid #EEF0EF;padding:7px 10px}.cr-i.sel{background:#FFF7EA}" +
  ".pannello label.cr-n{display:flex;align-items:flex-start;gap:8px;margin:0;font-weight:500;font-size:.88rem;cursor:pointer}" +
  ".pannello label.cr-n input{display:inline-block;width:auto;margin:3px 0 0;flex:none}.cr-n small{display:block;color:#5b6560;font-weight:400;font-size:.76rem}" +
  ".cr-e{display:flex;gap:8px;margin:6px 0 2px 26px}.pannello .cr-e select{flex:1;margin-top:0;padding:7px}.pannello .cr-e input{width:90px;flex:none;margin-top:0;padding:7px}" +
  ".cr-vuoto{padding:8px 10px;font-size:.84rem;color:#5b6560}" +
  ".msg{font-size:.9rem;margin:12px 0 0;min-height:1.2em}.msg.ko{color:#8c1d18;font-weight:600}.msg.ok{color:#0B5E37;font-weight:600}.msg:empty{display:none}.msg a{color:inherit}" +
  ".bott{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.bott button{flex:1 1 120px;min-height:48px;font:inherit;font-weight:700;font-size:1rem;border-radius:10px;cursor:pointer}" +
  ".bott .no{background:#fff;color:#333;border:1px solid #c9d1cc}.bott .sec{background:#fff;color:var(--ar-s);border:1px solid var(--ar)}.bott .si{background:var(--ar);color:#fff;border:1px solid var(--ar)}.bott button:disabled{opacity:.5;cursor:wait}" +
  ".nota{font-size:.82rem;color:#5b6560;margin:16px 2px 0;line-height:1.5}.piccolo{font-size:.84rem;color:#4A524E;margin:0 0 6px}" +
  "dialog{border:0;border-radius:16px;padding:0;width:min(480px,calc(100vw - 24px));max-height:calc(100vh - 24px);box-shadow:0 18px 50px rgba(0,0,0,.28);color:#111}" +
  "dialog::backdrop{background:rgba(5,20,15,.55)}dialog form{margin:0}" +
  ".dl-t{background:var(--ar-c);border-bottom:1px solid var(--ar-b);padding:14px 18px 10px}.dl-t h2{margin:0;font-size:1.1rem;color:var(--ar-s)}.dl-t p{margin:4px 0 0;font-size:.9rem;color:#4A524E}" +
  ".dl-c{padding:12px 18px 2px}.dl-c label{display:block;font-weight:600;font-size:.9rem;margin:8px 0 0}" +
  ".dl-b{display:flex;gap:10px;padding:14px 18px 18px}.dl-b button{flex:1;min-height:46px;font:inherit;font-weight:700;font-size:1rem;border-radius:10px;cursor:pointer}" +
  ".dl-b .no{background:#fff;color:#333;border:1px solid #c9d1cc}.dl-b .si{background:var(--ar);color:#fff;border:1px solid var(--ar)}.dl-b .si.rosso{background:#8c1d18;border-color:#8c1d18}.dl-b .si:disabled{opacity:.5;cursor:wait}";

// Script della pagina: giorno scelto, modulo (bozza, registrazione, correzione), annullamento. Nessuna libreria esterna.
const SCRIPT = String.raw`(function(){try{
var D=GL_RP,q=function(s){return document.querySelector(s)};
var R=D.rapportini||[],G=D.giorni||[],DI=D.diari||[];
var pan=q('#giorno'),mod=q('#modulo'),form=q('#mo-form'),tit=q('#mo-tit'),msg=q('#mo-msg');
var fdata=q('#f-data'),flav=q('#f-lav'),fluogo=q('#f-luogo'),fmano=q('#f-mano'),ftot=q('#f-tot'),fmezzi=q('#f-mezzi'),fnote=q('#f-note'),fmot=q('#f-motivo'),fautore=q('#f-autore');
var bChiudi=q('#mo-chiudi'),bBozza=q('#mo-bozza'),bReg=q('#mo-reg'),tpl=q('#riga-m');
var NOMI=['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];
var ESITI={iniziata:'iniziata',in_corso:'in corso',finita:'finita'};
var stato={modo:'nuovo',id:null,occupato:false,sporco:false,salvato:false,ricarica:false};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function dIt(s){var p=String(s||'').split('-');if(p.length!==3)return '';var d=new Date(Date.UTC(+p[0],+p[1]-1,+p[2]));return NOMI[d.getUTCDay()]+' '+p[2]+'/'+p[1]+'/'+p[0];}
function num(v){var n=parseFloat(String(v==null?'':v).replace(',','.'));return isNaN(n)?0:n;}
function ore(n){return (Math.round(n*100)/100).toFixed(2).replace('.',',')+' h';}
function m(cl,t){msg.className='msg '+cl;msg.textContent=t;}
function mHtml(cl,h){msg.className='msg '+cl;msg.innerHTML=h;}
function post(p,corpo){return fetch(D.base+'/rapportino/'+p,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(corpo)}).then(function(r){return r.json();});}
function link(g){return D.base+'/rapportino?t='+D.t+'&c='+D.c+'&m='+String(g||D.mese).slice(0,7)+(g?'&g='+g:'');}
function docLink(id){return D.base+'/rapportino/documento?t='+D.t+'&id='+id;}
function autoreSalvato(){try{return localStorage.getItem('gl_rp_autore')||'';}catch(x){return '';}}
function ricordaAutore(v){try{if(v)localStorage.setItem('gl_rp_autore',v);}catch(x){}}
function inPeriodo(g){return g>=D.min&&g<=D.max;}
/* ---------- giorno scelto ---------- */
function giorno(g){for(var i=0;i<G.length;i++)if(G[i].g===g)return G[i];return null;}
function diarioUrl(g){for(var i=0;i<DI.length;i++)if(DI[i].g===g)return DI[i].url;return '';}
function versioni(x){var a=[];for(var i=0;i<R.length;i++)if(R[i].numero&&R[i].numero===x.numero&&R[i].id!==x.id)a.push(R[i]);a.sort(function(p,q){return p.versione-q.versione;});return a;}
function scheda(x){
 if(x.stato==='bozza'){return '<div class="rp bz"><div class="t">Bozza da completare</div>'+
  (x.lavorazioni?'<div class="n">'+esc(x.lavorazioni.slice(0,200))+'</div>':'')+
  '<div class="k">ultima modifica '+esc(x.aggiornato_il)+(x.autore?' &middot; '+esc(x.autore):'')+'</div>'+
  (D.chiuso?'':'<div class="az"><button type="button" data-az="riprendi" data-id="'+x.id+'">Riprendi</button><button type="button" class="rosso" data-az="scarta" data-id="'+x.id+'">Scarta la bozza</button></div>')+'</div>';}
 var ann=x.stato==='annullato',vv=versioni(x),h='';
 h+='<div class="rp'+(ann?' ann':'')+'"><div class="t">Rapportino n. '+x.numero+(x.versione>1?' <span class="pl mov">versione '+x.versione+'</span>':'')+(ann?' <span class="pl ann">annullato</span>':'')+'</div>';
 if(x.lavorazioni)h+='<div class="n">'+esc(x.lavorazioni.slice(0,240))+(x.lavorazioni.length>240?'…':'')+'</div>';
 h+='<div class="k">'+ore(num(x.ore_totali))+' &middot; registrato il '+esc(x.registrato_il)+' da '+esc(x.autore)+(x.motivo?' &middot; motivo: '+esc(x.motivo):'')+'</div>';
 if(x.crono&&x.crono.length)h+='<div class="k">&#128202; Cronoprogramma: '+x.crono.map(function(c){return esc(c.nome)+' ('+esc(ESITI[c.esito]||c.esito)+(c.pct!=null&&c.esito!=='finita'?' '+c.pct+'%':'')+')';}).join(', ')+'</div>';
 h+='<div class="az"><a href="'+esc(docLink(x.id))+'" target="_blank" rel="noopener noreferrer">Apri il documento</a>';
 if(!ann&&!D.chiuso)h+='<button type="button" data-az="correggi" data-id="'+x.id+'">Correggi</button><button type="button" class="rosso" data-az="annulla" data-id="'+x.id+'">Annulla</button>';
 h+='</div>';
 if(vv.length){h+='<details class="vers"><summary>Versioni precedenti ('+vv.length+')</summary>';
  for(var i=0;i<vv.length;i++)h+='<div>versione '+vv[i].versione+' del '+esc(vv[i].registrato_il)+' &middot; '+esc(vv[i].autore)+' &middot; <a href="'+esc(docLink(vv[i].id))+'" target="_blank" rel="noopener noreferrer">apri</a></div>';
  h+='</details>';}
 return h+'</div>';}
function mostraGiorno(g){
 var info=giorno(g)||{},u=diarioUrl(g),h='<div class="tit">'+esc(dIt(g))+'</div>';
 h+='<p class="info">'+(u?'<a href="'+esc(u)+'" target="_blank" rel="noopener noreferrer">&#128196; Diario di cantiere</a>':(info.diario?'Diario di cantiere emesso':'Nessun diario di cantiere per questo giorno'))+
  (info.voci?' &middot; '+info.voci+(info.voci===1?' messaggio':' messaggi')+' dal cantiere':'')+'</p>';
 var lista=[];for(var i=0;i<R.length;i++)if(R[i].data===g&&R[i].stato!=='sostituito')lista.push(R[i]);
 lista.sort(function(a,b){return (a.stato==='bozza'?1e9:a.numero)-(b.stato==='bozza'?1e9:b.numero);});
 for(var j=0;j<lista.length;j++)h+=scheda(lista[j]);
 if(D.chiuso){h+='';}
 else if(inPeriodo(g))h+='<button type="button" class="nuovo" data-az="nuovo" data-g="'+esc(g)+'">+ Nuovo rapportino per questo giorno</button>';
 else h+='<p class="piccolo">Questo giorno è fuori dal periodo del cantiere.</p>';
 pan.innerHTML=h;
 var sel=document.querySelectorAll('.gg.sel');for(var k=0;k<sel.length;k++)sel[k].classList.remove('sel');
 var a=document.querySelector('.gg[data-g="'+g+'"]');if(a)a.classList.add('sel');
 D.g=g;try{history.replaceState(null,'',link(g));}catch(x){}}
var gg=document.querySelectorAll('a.gg[data-g]');
for(var i=0;i<gg.length;i++)gg[i].addEventListener('click',function(ev){if(stato.sporco&&!mod.hidden&&!confirm('Il rapportino che stai scrivendo non è salvato. Cambiare giorno lo stesso?')){ev.preventDefault();return;}
 ev.preventDefault();if(stato.ricarica){location.href=link(this.getAttribute('data-g'));return;}
 chiudiModulo(true);mostraGiorno(this.getAttribute('data-g'));pan.scrollIntoView({behavior:'smooth',block:'start'});});
/* ---------- modulo ---------- */
function nuovaRiga(r){var n=tpl.content.firstElementChild.cloneNode(true);
 if(r){n.querySelector('.m-sq').value=r.squadra||'';n.querySelector('.m-q').value=r.qualifica||'';n.querySelector('.m-op').value=r.operai==null?'':r.operai;n.querySelector('.m-ore').value=r.ore==null?'':String(r.ore).replace('.',',');n.querySelector('.m-e').checked=r.economia==='si';}
 n.querySelector('.m-x').addEventListener('click',function(){n.parentNode.removeChild(n);if(!fmano.children.length)nuovaRiga();totale();stato.sporco=true;});
 fmano.appendChild(n);}
function righe(){var a=[],rr=fmano.querySelectorAll('.riga-m');for(var i=0;i<rr.length;i++){var r=rr[i];
 var o={squadra:r.querySelector('.m-sq').value.trim(),qualifica:r.querySelector('.m-q').value,operai:r.querySelector('.m-op').value.trim(),ore:r.querySelector('.m-ore').value.trim(),economia:r.querySelector('.m-e').checked?'si':'no'};
 if(o.squadra||o.operai||o.ore)a.push(o);}return a;}
function totale(){var t=0,a=righe();for(var i=0;i<a.length;i++)t+=num(a[i].operai)*num(a[i].ore);ftot.textContent=t>0?'Totale manodopera: '+ore(t):'';}
fmano.addEventListener('input',function(){totale();});
q('#f-agg').addEventListener('click',function(){nuovaRiga();stato.sporco=true;});
form.addEventListener('input',function(){stato.sporco=true;});
/* cronoprogramma (pacchetto B): attività lavorate con l'esito e la percentuale */
var CR=D.crono||[],crSel={},crL=q('#f-cr'),crQ=q('#f-cr-q');
function crTrova(id){for(var i=0;i<CR.length;i++)if(CR[i].id===id)return CR[i];return null;}
function crRender(){if(!crL)return;var qq=(crQ.value||'').toLowerCase().trim(),h='',n=0,lista=[];
 for(var i=0;i<CR.length;i++)if(crSel[CR[i].id])lista.push(CR[i]);
 for(var j=0;j<CR.length;j++){var a=CR[j];if(crSel[a.id])continue;if(qq&&(a.nome+' '+a.fase).toLowerCase().indexOf(qq)===-1)continue;if(n>=80)break;n++;lista.push(a);}
 for(var k=0;k<lista.length;k++){var b=lista[k],s=crSel[b.id];
  h+='<div class="cr-i'+(s?' sel':'')+'" data-id="'+esc(b.id)+'"><label class="cr-n"><input type="checkbox"'+(s?' checked':'')+'><span>'+esc(b.nome)+'<small>'+
   [b.fase,(b.ip?'prevista '+dIt(b.ip).replace(/^[a-zà-ù]+ /i,'')+(b.fp&&b.fp!==b.ip?' – '+dIt(b.fp).replace(/^[a-zà-ù]+ /i,''):''):''),(b.pct!=null?Math.round(b.pct)+'% fatto':'')].filter(Boolean).map(esc).join(' · ')+'</small></span></label>'+
   (s?'<div class="cr-e"><select class="cr-s"><option value="in_corso"'+(s.esito==='in_corso'?' selected':'')+'>In corso</option><option value="iniziata"'+(s.esito==='iniziata'?' selected':'')+'>Iniziata</option><option value="finita"'+(s.esito==='finita'?' selected':'')+'>Finita</option></select>'+
    '<input type="number" class="cr-p" min="0" max="100" step="5" inputmode="numeric" placeholder="%" value="'+(s.pct!=null&&s.pct!==''?esc(s.pct):'')+'"'+(s.esito==='finita'?' style="display:none"':'')+'></div>':'')+'</div>';}
 crL.innerHTML=h||'<div class="cr-vuoto">Nessuna attività con queste parole.</div>';}
if(crL){crQ.addEventListener('input',crRender);
 crL.addEventListener('change',function(ev){var t=ev.target,r=t.closest('.cr-i');if(!r)return;var id=r.getAttribute('data-id');stato.sporco=true;
  if(t.type==='checkbox'){if(t.checked){if(Object.keys(crSel).length>=15){t.checked=false;return;}crSel[id]={esito:'in_corso',pct:''};var a=crTrova(id);if(a&&!flav.value.trim())flav.value=a.nome;}else delete crSel[id];crRender();return;}
  if(t.classList.contains('cr-s')&&crSel[id]){crSel[id].esito=t.value;var p=r.querySelector('.cr-p');if(p)p.style.display=t.value==='finita'?'none':'';}});
 crL.addEventListener('input',function(ev){var t=ev.target,r=t.closest('.cr-i');if(r&&t.classList.contains('cr-p')&&crSel[r.getAttribute('data-id')])crSel[r.getAttribute('data-id')].pct=t.value.trim();});}
function crDati(){var a=[];for(var id in crSel)a.push({attivita_id:id,esito:crSel[id].esito,pct:crSel[id].esito==='finita'?'':crSel[id].pct});return a;}
function riempi(x,g){fdata.value=x?x.data:g;flav.value=x?x.lavorazioni:'';fluogo.value=x?x.luogo:'';fmezzi.value=x?x.mezzi:'';fnote.value=x?x.note:'';fmot.value='';
 fautore.value=(x&&x.autore&&x.stato==='bozza')?x.autore:autoreSalvato();
 crSel={};var cc=(x&&x.crono)||[];for(var c=0;c<cc.length;c++)crSel[cc[c].attivita_id]={esito:cc[c].esito,pct:cc[c].pct==null?'':String(cc[c].pct)};if(crQ)crQ.value='';crRender();
 fmano.innerHTML='';var mm=(x&&x.manodopera)||[];for(var i=0;i<mm.length;i++)nuovaRiga(mm[i]);if(!mm.length)nuovaRiga();totale();}
function apriModulo(modo,x,g){stato.modo=modo;stato.id=x?x.id:null;stato.sporco=false;stato.salvato=false;
 riempi(x,g);q('#l-motivo').hidden=modo!=='correggi';bBozza.hidden=modo==='correggi';bReg.hidden=false;bReg.disabled=false;bBozza.disabled=false;
 tit.textContent=modo==='correggi'?'Correzione del rapportino n. '+x.numero:(modo==='bozza'?'Bozza del rapportino':'Nuovo rapportino');
 bReg.textContent=modo==='correggi'?'Registra la correzione':'Registra';bChiudi.textContent='Chiudi';m('','');
 mod.hidden=false;mod.scrollIntoView({behavior:'smooth',block:'start'});setTimeout(function(){try{flav.focus();}catch(e){}},300);}
function chiudiModulo(silenzioso){if(stato.occupato)return false;mod.hidden=true;if(stato.ricarica&&!silenzioso){location.href=link(D.g);}return true;}
bChiudi.addEventListener('click',function(){if(stato.sporco&&!confirm('Chiudere senza salvare le ultime modifiche?'))return;if(stato.ricarica){location.href=link(D.g);return;}chiudiModulo();});
function datiModulo(){return {id:stato.id,data:fdata.value,lavorazioni:flav.value.trim(),luogo:fluogo.value.trim(),manodopera:righe(),mezzi:fmezzi.value.trim(),note:fnote.value.trim(),autore:fautore.value.trim(),motivo:fmot.value.trim(),crono:crDati()};}
function controlla(reg){var d=datiModulo();
 if(!d.data){return 'Indica il giorno a cui si riferisce il rapportino.';}
 if(d.data<D.min||d.data>D.max){return 'Scegli un giorno tra il '+D.min.split('-').reverse().join('/')+' e il '+D.max.split('-').reverse().join('/')+'.';}
 for(var i=0;i<d.manodopera.length;i++){var r=d.manodopera[i];if(!r.squadra||!(num(r.operai)>=1)||!(num(r.ore)>0)||num(r.ore)>24)return 'Manodopera: in ogni riga servono squadra o impresa, numero di operai e ore per operaio (fino a 24).';}
 if(reg){if(!d.lavorazioni&&!d.manodopera.length)return 'Scrivi le lavorazioni eseguite o almeno una riga di manodopera.';
  if(!d.autore)return 'Scrivi chi registra il rapportino (nome e cognome).';
  if(stato.modo==='correggi'&&d.motivo.length<5)return 'Scrivi il motivo della correzione.';}
 return '';}
function occupa(s){stato.occupato=s;bReg.disabled=s;bBozza.disabled=s;bChiudi.disabled=s;}
function esitoComune(j){if(j.esito==='gettone'){location.href=D.base+'/';return true;}
 if(j.esito==='chiuso'){m('ko','Il cantiere è chiuso: non si registrano rapportini.');return true;}
 if(j.esito==='incerto'){m('ko','Non ho avuto risposta: ricarica la pagina tra un minuto per vedere se è stato salvato.');return true;}
 return false;}
bBozza.addEventListener('click',function(){if(stato.occupato)return;var err=controlla(false);if(err){m('ko',err);return;}
 var d=datiModulo();if(!d.lavorazioni&&!d.manodopera.length&&!d.mezzi&&!d.note){m('ko','Scrivi qualcosa prima di salvare la bozza.');return;}
 occupa(true);m('','Salvo la bozza…');ricordaAutore(d.autore);
 post('salva',{t:D.t,c:D.c,dati:d}).then(function(j){occupa(false);if(esitoComune(j))return;
  if(j.esito==='ok'){stato.id=j.id;stato.modo='bozza';stato.sporco=false;stato.ricarica=true;var o=new Date();
   m('ok','Bozza salvata alle '+String(o.getHours()).padStart(2,'0')+':'+String(o.getMinutes()).padStart(2,'0')+'. Puoi chiudere e riprenderla quando vuoi, anche da un altro dispositivo.');return;}
  m('ko',j.messaggio||'Non sono riuscito a salvare: riprova tra poco.');
 }).catch(function(){occupa(false);m('ko','Il servizio non risponde: controlla la connessione e riprova.');});});
form.addEventListener('submit',function(ev){ev.preventDefault();if(stato.occupato)return;var err=controlla(true);if(err){m('ko',err);return;}
 var d=datiModulo(),corr=stato.modo==='correggi';
 if(!confirm(corr?'Registrare la correzione? Nasce la versione nuova con il motivo; quella di prima resta consultabile con la sua impronta.':
   'Registrare il rapportino del '+d.data.split('-').reverse().join('/')+'? Dopo la registrazione non si modifica più: ogni correzione diventa una versione nuova, con il motivo.'))return;
 occupa(true);m('','Registro…');ricordaAutore(d.autore);
 var pr=corr?post('azione',{t:D.t,id:Number(stato.id),azione:'correggi',dati:d}):post('salva',{t:D.t,c:D.c,dati:Object.assign({},d,{registra:true})});
 pr.then(function(j){occupa(false);if(esitoComune(j))return;
  if(j.esito==='ok'||j.esito==='gia'){stato.sporco=false;stato.ricarica=true;bReg.hidden=true;bBozza.hidden=true;bChiudi.textContent='Chiudi e torna al calendario';
   mHtml('ok',(corr?'Correzione registrata.':'Rapportino registrato'+(j.numero?': n. '+j.numero:'')+'.')+' <a href="'+esc(docLink(j.id))+'" target="_blank" rel="noopener noreferrer">Apri il documento</a>');return;}
  if(j.id){stato.id=j.id;stato.modo='bozza';stato.ricarica=true;}
  m('ko',(j.messaggio||'Non sono riuscito a registrare: riprova tra poco.')+(j.id&&!corr?' Il rapportino è salvato come bozza.':''));
 }).catch(function(){occupa(false);m('ko','Il servizio non risponde: controlla la connessione e riprova.');});});
/* ---------- azioni sul giorno ---------- */
function trova(id){for(var i=0;i<R.length;i++)if(String(R[i].id)===String(id))return R[i];return null;}
var dlg=q('#an-dlg'),anMsg=q('#an-msg'),anId=null,anOcc=false;
pan.addEventListener('click',function(ev){var b=ev.target.closest?ev.target.closest('[data-az]'):null;if(!b)return;var az=b.getAttribute('data-az'),x=trova(b.getAttribute('data-id'));
 if(!mod.hidden&&stato.sporco&&!confirm('Il rapportino che stai scrivendo non è salvato. Continuare lo stesso?'))return;
 if(az==='nuovo'){apriModulo('nuovo',null,b.getAttribute('data-g'));return;}
 if(!x)return;
 if(az==='riprendi'){apriModulo('bozza',x);return;}
 if(az==='correggi'){apriModulo('correggi',x);return;}
 if(az==='scarta'){if(!confirm('Scartare questa bozza? Non è ancora registrata e verrà eliminata.'))return;b.disabled=true;
  post('azione',{t:D.t,id:Number(x.id),azione:'scarta'}).then(function(j){if(j.esito==='ok'){location.href=link(D.g);return;}if(j.esito==='gettone'){location.href=D.base+'/';return;}
   alert(j.messaggio||'Non sono riuscito a scartare la bozza: riprova tra poco.');b.disabled=false;}).catch(function(){alert('Il servizio non risponde: riprova tra poco.');b.disabled=false;});return;}
 if(az==='annulla'){anId=x.id;q('#an-sub').textContent='Rapportino n. '+x.numero+' del '+x.data.split('-').reverse().join('/');q('#an-motivo').value='';q('#an-autore').value=autoreSalvato();anMsg.textContent='';anMsg.className='msg';
  if(dlg&&typeof dlg.showModal==='function')dlg.showModal();else{var mo=prompt('Motivo dell’annullamento');if(!mo)return;var au=prompt('Annullato da (nome e cognome)',autoreSalvato());if(!au)return;annulla(mo,au);}}});
function annulla(mo,au){anOcc=true;var bs=q('#an-si');if(bs)bs.disabled=true;
 post('azione',{t:D.t,id:Number(anId),azione:'annulla',dati:{motivo:mo,autore:au}}).then(function(j){anOcc=false;if(bs)bs.disabled=false;
  if(j.esito==='ok'){ricordaAutore(au);location.href=link(D.g);return;}if(j.esito==='gettone'){location.href=D.base+'/';return;}
  var t=j.messaggio||(j.esito==='incerto'?'Non ho avuto risposta: ricarica la pagina tra un minuto.':'Non sono riuscito ad annullare: riprova tra poco.');if(dlg&&dlg.open){anMsg.className='msg ko';anMsg.textContent=t;}else alert(t);
 }).catch(function(){anOcc=false;if(bs)bs.disabled=false;var t='Il servizio non risponde: riprova tra poco.';if(dlg&&dlg.open){anMsg.className='msg ko';anMsg.textContent=t;}else alert(t);});}
if(dlg){q('#an-form').addEventListener('submit',function(ev){ev.preventDefault();if(anOcc)return;var mo=q('#an-motivo').value.trim(),au=q('#an-autore').value.trim();
  if(mo.length<5){anMsg.className='msg ko';anMsg.textContent='Scrivi il motivo dell’annullamento.';return;}
  if(!au){anMsg.className='msg ko';anMsg.textContent='Scrivi chi annulla il rapportino (nome e cognome).';return;}annulla(mo,au);});
 q('#an-no').addEventListener('click',function(){if(!anOcc)dlg.close();});dlg.addEventListener('cancel',function(ev){if(anOcc)ev.preventDefault();});}
window.addEventListener('pageshow',function(ev){if(ev.persisted)location.reload();});
if(D.g)mostraGiorno(D.g);
}catch(x){}})();
`;
