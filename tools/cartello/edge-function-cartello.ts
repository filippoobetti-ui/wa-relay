// 24/10/2026: nome del servizio «TIX · Diario di cantiere» nei testi visibili (prima «Il Giornale Lavori»).
// cartello — Il Giornale Lavori (05/10/2026) — v10 (23/10/2026: nuovo dominio tixcantiere.it — ritorni ammessi, logo, testi e mittente info@tixcantiere.it; il vecchio dominio resta ammesso) — v9 (16/10/2026: email al tipografo e pagine con i colori e il marchio TIX) — v7 (11/10/2026: invio del PDF al tipografo con link da scaricare) — v6 (10/10/2026: campo «abbonato» nella verifica, per la frase in fondo al cartello) — v4 (09/10/2026: misure personalizzate, stati rimborsato/annullato definitivi) — v2 (sera): client_reference_id CRT-<token> per la conferma dal webhook Stripe
// già esistente (scenario 7490419 → onboarding_completa_da_pagamento → cartello_completa_da_pagamento).
// Generatore del cartello di cantiere: la PAGINA (public/cartello/index.html del relay wa-relay) si compila
// e compone il PDF nel browser del cliente (jsPDF + motore condiviso); QUI ci sono solo i passaggi del
// pagamento Stripe (Checkout Session da 9,00 € + IVA 22 % a cartello) e il registro delle vendite
// in cartelli_cantiere. Nessuno scenario Make coinvolto. Nessun dato del cartello viene salvato oltre a
// formato, oggetto dei lavori e ubicazione (servono a riconoscere il cantiere pagato).
//
// Percorsi (dopo /functions/v1/cartello — in pubblico dietro il relay: <cartello_url>/…):
//   GET  /                        stato del servizio (JSON)
//   POST /checkout                {formato, orientamento, tipo, oggetto, ubicazione, ritorno} → {id, url}
//   GET  /verifica?sessione=cs_…[&piva=…&testo=…]  {esito: 'pagato'|'in_attesa'|'non_trovato', formato, oggetto, ubicazione, pagato_il, abbonato}
//        abbonato (v6, 10/10/2026): true se chi compra o l'impresa esecutrice scritta sul cartello è un'impresa abbonata con un cantiere attivo
//        (partita IVA, email o ragione sociale, funzione SQL cartello_abbonato) → in fondo al cartello «Questo cantiere viene gestito con».
//   POST /scarico                 {sessione} → registra un download del PDF pagato
//   v7 (11/10/2026) — invio al tipografo, solo per cartelli pagati, al massimo cartello_invio_max volte:
//   POST /invio-prepara           {sessione, email_cliente, nome_cliente, email_tipografo, nota, byte, base_cm, altezza_cm}
//                                 → {id, caricamento} (URL firmato: il browser carica il PDF direttamente nell'archivio privato «cartelli-stampa»)
//   POST /invio-conferma          {id, sessione} → controlla che il file ci sia e manda l'email (scenario Make 7899006, Brevo,
//                                 mittente «<impresa> tramite TIX» <info@tixcantiere.it>, Rispondi a = cliente, copia al cliente)
//   GET  /file?k=…                link dell'email: rimanda a un indirizzo firmato di 10 minuti; scade dopo cartello_invio_giorni (30)
//   POST /pulizia                 (pg_cron, intestazione x-chiave) cancella i file scaduti e gli invii mai completati
//
// Variabili: STRIPE_SECRET_KEY (segreto Supabase, facoltativo: senza, si passa da Make 7820289), SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (automatiche).
// Impostazioni lette dal database a ogni richiesta: cartello_url, cartello_prezzo_cent, cartello_attivo, stripe_tax_rate_id_iva22.

const URL_BASE = Deno.env.get('SUPABASE_URL') ?? '';
const CHIAVE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const CARTELLO_URL_DEFAULT = 'https://wa-relay.filippo-obetti.workers.dev/cartello';
const FORMATI: Record<string, string> = { '100x100': '100 × 100 cm', '100x200': '100 × 200 cm', '150x300': '150 × 300 cm', '200x300': '200 × 300 cm' };
const RE_SESSIONE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

// v4 (09/10/2026): misure personalizzate «BxH» in cm (40–600 per lato, lato lungo ≤ 3 volte il corto).
function etichettaFormato(formato: string): string {
  if (FORMATI[formato]) return FORMATI[formato];
  const m = /^(\d{2,3})x(\d{2,3})$/.exec(formato);
  if (!m) return '';
  const b = Number(m[1]), h = Number(m[2]);
  if (b < 40 || h < 40 || b > 600 || h > 600 || Math.max(b, h) / Math.min(b, h) > 3) return '';
  return `${b} × ${h} cm (su misura)`;
}

type Dizionario = Record<string, unknown>;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-chiave',
  'Access-Control-Max-Age': '86400',
};

function json(corpo: Dizionario, stato = 200): Response {
  return new Response(JSON.stringify(corpo), { status: stato, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ------------------------------------------------------------------ database (PostgREST con service role)
const DB_HEAD = () => ({ apikey: CHIAVE, Authorization: `Bearer ${CHIAVE}`, 'Content-Type': 'application/json' });
const RITENTA = new Set([401, 502, 503, 504]);

async function dbFetch(percorso: string, init: RequestInit): Promise<Response | null> {
  for (let tentativo = 0; tentativo < 2; tentativo++) {
    try {
      const r = await fetch(`${URL_BASE}/rest/v1/${percorso}`, { ...init, headers: { ...DB_HEAD(), ...(init.headers as Record<string, string> ?? {}) } });
      if (r.ok || !RITENTA.has(r.status) || tentativo === 1) return r;
    } catch { if (tentativo === 1) return null; }
    await new Promise((ok) => setTimeout(ok, 400));
  }
  return null;
}

async function impostazioni(chiavi: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const r = await dbFetch(`impostazioni?select=chiave,valore&chiave=in.(${chiavi.map(encodeURIComponent).join(',')})`, { method: 'GET' });
  if (r && r.ok) for (const x of (await r.json()) as { chiave: string; valore: string }[]) out[x.chiave] = x.valore ?? '';
  return out;
}

async function inserisciVendita(riga: Dizionario): Promise<boolean> {
  const r = await dbFetch('cartelli_cantiere', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(riga) });
  return !!(r && r.ok);
}

async function leggiVendita(sessione: string): Promise<Dizionario | null> {
  const r = await dbFetch(`cartelli_cantiere?select=*&session_id=eq.${encodeURIComponent(sessione)}&limit=1`, { method: 'GET' });
  if (!r || !r.ok) return null;
  const righe = (await r.json()) as Dizionario[];
  return righe[0] ?? null;
}

async function aggiornaVendita(sessione: string, patch: Dizionario): Promise<void> {
  await dbFetch(`cartelli_cantiere?session_id=eq.${encodeURIComponent(sessione)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...patch, aggiornato_il: new Date().toISOString() }) });
}

async function abbonato(pive: string[], email: string, testo: string): Promise<boolean> {
  const r = await dbFetch('rpc/cartello_abbonato', { method: 'POST', body: JSON.stringify({ p_pive: pive.filter(Boolean), p_email: email || null, p_testo: (testo || '').slice(0, 2000) }) });
  if (!r || !r.ok) return false;
  try { return (await r.json()) === true; } catch { return false; }
}

async function registraScarico(sessione: string): Promise<void> {
  await dbFetch('rpc/cartello_registra_scarico', { method: 'POST', body: JSON.stringify({ p_session: sessione }) });
}

// ------------------------------------------------------------------ Stripe
function formUrl(dati: Record<string, string>): string {
  return Object.entries(dati).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// Stripe: con STRIPE_SECRET_KEY si chiama l'API direttamente; altrimenti (scelta del 07/10/2026) passa dallo
// scenario Make 7820289, che usa la connessione Stripe LIVE 10997898 dell'account «Il Giornale Lavori».
// Il filtro dello scenario ammette solo la chiave condivisa e solo percorsi /v1/checkout/sessions.
let viaMake: { url: string; chiave: string } | null = null;
async function canaleStripe(): Promise<'diretto' | 'make' | null> {
  if (STRIPE_KEY) return 'diretto';
  if (!viaMake) {
    const imp = await impostazioni(['cartello_stripe_hook_url', 'cartello_stripe_hook_chiave']);
    if (imp.cartello_stripe_hook_url && imp.cartello_stripe_hook_chiave) viaMake = { url: imp.cartello_stripe_hook_url, chiave: imp.cartello_stripe_hook_chiave };
  }
  return viaMake ? 'make' : null;
}

async function stripe(metodo: string, percorso: string, dati?: Record<string, string>): Promise<{ ok: boolean; stato: number; corpo: Dizionario }> {
  const canale = await canaleStripe();
  if (canale === 'diretto') {
    const r = await fetch(`https://api.stripe.com/v1/${percorso}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: dati ? formUrl(dati) : undefined,
    });
    let corpo: Dizionario = {};
    try { corpo = (await r.json()) as Dizionario; } catch { /* corpo non JSON */ }
    return { ok: r.ok, stato: r.status, corpo };
  }
  if (canale === 'make' && viaMake) {
    try {
      const r = await fetch(viaMake.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chiave: viaMake.chiave, url: `/v1/${percorso}`, method: metodo, body: dati ? formUrl(dati) : '' }),
      });
      const testo = await r.text();
      let corpo: Dizionario = {};
      try { corpo = JSON.parse(testo) as Dizionario; } catch { corpo = { error: { message: testo.slice(0, 160) } }; }
      if (corpo.errore) return { ok: false, stato: 502, corpo: { error: { message: String(corpo.errore) } } };
      return { ok: r.ok && !!corpo.id, stato: r.status, corpo };
    } catch (e) {
      return { ok: false, stato: 502, corpo: { error: { message: String((e as Error)?.message ?? e) } } };
    }
  }
  return { ok: false, stato: 503, corpo: { error: { message: 'pagamenti non configurati' } } };
}

async function hashIp(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
  if (!ip) return '';
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cartello|' + ip));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

function dataIt(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Rome' }).format(new Date(iso));
}

async function checkout(req: Request): Promise<Response> {
  if (!(await canaleStripe())) return json({ errore: 'pagamenti non ancora configurati' }, 503);
  let dati: Dizionario;
  try { dati = (await req.json()) as Dizionario; } catch { return json({ errore: 'richiesta non leggibile' }, 400); }
  const formato = String(dati.formato ?? '');
  const orientamento = String(dati.orientamento ?? 'verticale') === 'orizzontale' ? 'orizzontale' : 'verticale';
  const tipo = String(dati.tipo ?? 'privato') === 'pubblico' ? 'pubblico' : 'privato';
  const oggetto = String(dati.oggetto ?? '').trim().slice(0, 300);
  const ubicazione = String(dati.ubicazione ?? '').trim().slice(0, 200);
  const ritornoRichiesto = String(dati.ritorno ?? '');
  const etichetta = etichettaFormato(formato);
  if (!etichetta) return json({ errore: 'formato non valido' }, 400);
  if (!oggetto) return json({ errore: 'manca l’oggetto dei lavori' }, 400);

  const imp = await impostazioni(['cartello_url', 'cartello_prezzo_cent', 'cartello_attivo', 'stripe_tax_rate_id_iva22']);
  if ((imp.cartello_attivo || 'si') === 'no') return json({ errore: 'servizio momentaneamente sospeso' }, 503);
  const prezzo = Math.max(100, parseInt(imp.cartello_prezzo_cent || '900', 10) || 900);
  const base = (imp.cartello_url || CARTELLO_URL_DEFAULT).replace(/\/+$/, '');
  // l'indirizzo di ritorno è quello configurato, salvo che il cliente non sia già su un indirizzo nostro
  // (23/10/2026: anche tixcantiere.it; il vecchio dominio e l'host tecnico restano ammessi)
  const ammessi = [base, 'https://www.tixcantiere.it', 'https://tixcantiere.it', 'https://www.ilgiornalelavori.it', 'https://ilgiornalelavori.it', CARTELLO_URL_DEFAULT];
  const ritorno = ammessi.some((a) => ritornoRichiesto.startsWith(a)) ? ritornoRichiesto.replace(/\/+$/, '') : base;

  const descrizione = `Cartello di cantiere ${etichetta} (${orientamento}) — file PDF per la stampa`;
  // token CRT-…: lo scenario Make 7490419 lo legge dal client_reference_id e conferma il pagamento nel database
  // anche se il cliente non torna mai sulla pagina (idempotente: un secondo recapito risponde 'ok')
  const token = 'CRT-' + crypto.randomUUID().replace(/-/g, '');
  const campi: Record<string, string> = {
    mode: 'payment',
    locale: 'it',
    client_reference_id: token,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': String(prezzo),
    'line_items[0][price_data][product_data][name]': `Cartello di cantiere ${etichetta}`,
    'line_items[0][price_data][product_data][description]': 'File PDF vettoriale per la stampa, con render, loghi e QR — TIX · Diario di cantiere',
    customer_creation: 'always',
    'tax_id_collection[enabled]': 'true',
    billing_address_collection: 'required',
    'payment_intent_data[description]': descrizione,
    'custom_text[submit][message]': 'Dopo il pagamento torni alla pagina del cartello e scarichi subito il PDF per la stampa.',
    success_url: `${ritorno}?sessione={CHECKOUT_SESSION_ID}&esito=ok`,
    cancel_url: `${ritorno}?esito=annullato`,
    'metadata[prodotto]': 'cartello_cantiere',
    'metadata[token]': token,
    'metadata[formato]': formato,
    'metadata[orientamento]': orientamento,
    'metadata[tipo]': tipo,
    'metadata[oggetto]': oggetto.slice(0, 200),
  };
  if (imp.stripe_tax_rate_id_iva22) campi['line_items[0][tax_rates][0]'] = imp.stripe_tax_rate_id_iva22;

  const r = await stripe('POST', 'checkout/sessions', campi);
  if (!r.ok || !r.corpo.id || !r.corpo.url) {
    const msg = (r.corpo.error as Dizionario | undefined)?.message;
    return json({ errore: 'Stripe non ha accettato la richiesta' + (msg ? ': ' + String(msg).slice(0, 160) : '') }, 502);
  }
  await inserisciVendita({
    session_id: r.corpo.id, token, stato: 'creato', formato, orientamento, tipo, oggetto, ubicazione, ritorno,
    importo_cent: prezzo, iva_pct: 22, totale_cent: Math.round(prezzo * 1.22), valuta: 'eur',
    ip_hash: await hashIp(req), user_agent: (req.headers.get('user-agent') || '').slice(0, 200),
  });
  return json({ id: r.corpo.id, url: r.corpo.url });
}

async function verifica(sessione: string, pivaCartello = '', testoCartello = ''): Promise<Response> {
  if (!RE_SESSIONE.test(sessione)) return json({ esito: 'non_trovato' }, 404);
  const riga = await leggiVendita(sessione);
  if (!riga) return json({ esito: 'non_trovato' }, 404);
  // v4 (09/10/2026): vendita rimborsata o annullata → non si sblocca più, anche se su Stripe la sessione resta «paid»
  if (riga.stato === 'rimborsato' || riga.stato === 'annullato') return json({ esito: String(riga.stato) }, 410);
  if (riga.stato === 'pagato') {
    const ab = await abbonato([String(riga.partita_iva ?? ''), ...pivaCartello.split(',')], String(riga.email ?? ''), testoCartello);
    if (ab !== riga.abbonato) await aggiornaVendita(sessione, { abbonato: ab });
    return json({ esito: 'pagato', formato: riga.formato, orientamento: riga.orientamento, oggetto: riga.oggetto, ubicazione: riga.ubicazione, pagato_il: dataIt(riga.pagato_il as string), abbonato: ab, email: riga.email ?? '', cliente: riga.cliente ?? '', invii: await contaInvii(sessione) });
  }
  if (!(await canaleStripe())) return json({ esito: 'in_attesa' });
  const r = await stripe('GET', `checkout/sessions/${encodeURIComponent(sessione)}`);
  if (!r.ok) return json({ esito: 'in_attesa' });
  const s = r.corpo;
  if (s.payment_status === 'paid') {
    const cd = (s.customer_details as Dizionario | null) ?? {};
    const taxIds = (cd.tax_ids as Dizionario[] | undefined) ?? [];
    const piva = taxIds.map((t) => `${t.type ?? ''} ${t.value ?? ''}`.trim()).join(', ').slice(0, 80);
    const indirizzo = (cd.address as Dizionario | null) ?? {};
    const quando = new Date().toISOString();
    const emailCompratore = String(cd.email ?? s.customer_email ?? '').slice(0, 200);
    const ab = await abbonato([piva, ...pivaCartello.split(',')], emailCompratore, testoCartello);
    await aggiornaVendita(sessione, {
      abbonato: ab,
      stato: 'pagato', pagato_il: quando,
      email: String(cd.email ?? s.customer_email ?? '').slice(0, 200) || null,
      cliente: String(cd.name ?? '').slice(0, 200) || null,
      partita_iva: piva || null,
      paese: String(indirizzo.country ?? '').slice(0, 2) || null,
      totale_cent: typeof s.amount_total === 'number' ? s.amount_total : riga.totale_cent,
      stripe_payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : null,
      stripe_customer: typeof s.customer === 'string' ? s.customer : null,
    });
    return json({ esito: 'pagato', formato: riga.formato, orientamento: riga.orientamento, oggetto: riga.oggetto, ubicazione: riga.ubicazione, pagato_il: dataIt(quando), abbonato: ab, email: emailCompratore, cliente: String(cd.name ?? ''), invii: 0 });
  }
  if (s.status === 'expired') { await aggiornaVendita(sessione, { stato: 'scaduto' }); return json({ esito: 'non_trovato' }, 404); }
  return json({ esito: 'in_attesa' });
}

// ------------------------------------------------------------------ v7 (11/10/2026): invio al tipografo
const BUCKET = 'cartelli-stampa';
const MAX_BYTE = 50 * 1024 * 1024;
const RE_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RE_CHIAVE = /^[A-Za-z0-9_-]{30,60}$/;

function esc(t: unknown): string {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function pulito(t: unknown, max: number): string {
  return String(t ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function chiaveCasuale(): string {
  const b = crypto.getRandomValues(new Uint8Array(30));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function storage(percorso: string, init: RequestInit): Promise<Response> {
  return fetch(`${URL_BASE}/storage/v1/${percorso}`, { ...init, headers: { apikey: CHIAVE, Authorization: `Bearer ${CHIAVE}`, ...(init.headers as Record<string, string> ?? {}) } });
}
async function contaInvii(sessione: string): Promise<number> {
  const r = await dbFetch(`cartelli_invii?select=id&session_id=eq.${encodeURIComponent(sessione)}&stato=in.(inviato,scaduto)`, { method: 'GET', headers: { Prefer: 'count=exact', Range: '0-0' } });
  const cr = r?.headers.get('content-range') || '';
  const n = parseInt(cr.split('/')[1] || '0', 10);
  return Number.isFinite(n) ? n : 0;
}
async function leggiInvio(filtro: string): Promise<Dizionario | null> {
  const r = await dbFetch(`cartelli_invii?select=*&${filtro}&limit=1`, { method: 'GET' });
  if (!r || !r.ok) return null;
  return ((await r.json()) as Dizionario[])[0] ?? null;
}
async function aggiornaInvio(id: string, patch: Dizionario): Promise<void> {
  await dbFetch(`cartelli_invii?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
}
async function cancellaFile(percorsi: string[]): Promise<void> {
  if (!percorsi.length) return;
  try { await storage(`object/${BUCKET}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: percorsi }) }); } catch { /* si riprova alla prossima pulizia */ }
}

async function invioPrepara(req: Request): Promise<Response> {
  let d: Dizionario;
  try { d = (await req.json()) as Dizionario; } catch { return json({ errore: 'richiesta non leggibile' }, 400); }
  const sessione = String(d.sessione ?? '');
  if (!RE_SESSIONE.test(sessione)) return json({ errore: 'cartello non riconosciuto' }, 400);
  const vendita = await leggiVendita(sessione);
  if (!vendita || vendita.stato !== 'pagato') return json({ errore: 'si possono inviare solo cartelli già pagati' }, 403);
  const emailCliente = pulito(d.email_cliente, 200).toLowerCase();
  const emailTip = pulito(d.email_tipografo, 200).toLowerCase();
  const nome = pulito(d.nome_cliente, 80).replace(/["<>]/g, '');
  const nota = String(d.nota ?? '').replace(/\r/g, '').trim().slice(0, 600);
  if (!RE_EMAIL.test(emailCliente)) return json({ errore: 'la tua email non sembra corretta' }, 400);
  if (!RE_EMAIL.test(emailTip)) return json({ errore: 'l’email del tipografo non sembra corretta' }, 400);
  if (emailTip === emailCliente) return json({ errore: 'l’email del tipografo è uguale alla tua: per avere il file usa «Scarica»' }, 400);
  if (!nome) return json({ errore: 'scrivi il tuo nome o quello dell’impresa: il tipografo lo vede come mittente' }, 400);
  const byte = Number(d.byte ?? 0);
  if (!(byte > 1000)) return json({ errore: 'file non valido' }, 400);
  if (byte > MAX_BYTE) return json({ errore: 'il file supera i 50 MB e non si può inviare: scaricalo e mandalo con un servizio come WeTransfer, oppure usa immagini più leggere' }, 413);
  const b = Math.round(Number(d.base_cm)), h = Math.round(Number(d.altezza_cm));
  if (!(b >= 40 && b <= 600 && h >= 40 && h <= 600)) return json({ errore: 'misura del cartello non valida' }, 400);

  const imp = await impostazioni(['cartello_invio_max']);
  const max = Math.max(1, parseInt(imp.cartello_invio_max || '3', 10) || 3);
  if ((await contaInvii(sessione)) >= max) return json({ errore: `hai già usato i ${max} invii compresi per questo cartello: scarica il PDF e mandalo tu` }, 429);
  // freno ai tentativi a vuoto: non più di 3×max preparazioni per cartello
  const rTot = await dbFetch(`cartelli_invii?select=id&session_id=eq.${encodeURIComponent(sessione)}`, { method: 'GET', headers: { Prefer: 'count=exact', Range: '0-0' } });
  const tot = parseInt((rTot?.headers.get('content-range') || '').split('/')[1] || '0', 10) || 0;
  if (tot >= max * 3) return json({ errore: 'troppi tentativi di invio per questo cartello: scarica il PDF e mandalo tu' }, 429);

  const id = crypto.randomUUID();
  const percorso = `${String(vendita.token ?? 'CRT').replace(/[^A-Za-z0-9-]/g, '')}/${id}.pdf`;
  const nomeFile = `cartello-cantiere-${b}x${h}.pdf`;
  const rs = await storage(`object/upload/sign/${BUCKET}/${percorso}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!rs.ok) return json({ errore: 'archivio dei file non disponibile, riprova tra poco' }, 502);
  const firmato = (await rs.json()) as { url?: string };
  if (!firmato.url) return json({ errore: 'archivio dei file non disponibile, riprova tra poco' }, 502);
  const ok = await dbFetch('cartelli_invii', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    id, session_id: sessione, chiave_link: chiaveCasuale(), email_cliente: emailCliente, nome_cliente: nome, email_tipografo: emailTip,
    nota: nota || null, percorso_file: percorso, nome_file: nomeFile, byte: Math.round(byte), formato: `${b}x${h}`,
    oggetto: String(vendita.oggetto ?? '').slice(0, 300), ip_hash: await hashIp(req),
  }) });
  if (!ok || !ok.ok) return json({ errore: 'invio non registrato, riprova tra poco' }, 502);
  return json({ id, caricamento: `${URL_BASE}/storage/v1${firmato.url}` });
}

function htmlEmail(inv: Dizionario, vendita: Dizionario, link: string, scade: string): string {
  const nome = esc(inv.nome_cliente), emailC = esc(inv.email_cliente);
  const [b, h] = String(inv.formato ?? '').split('x');
  const mb = (Number(inv.byte ?? 0) / 1048576).toFixed(1).replace('.', ',');
  const riga = (k: string, v: string) => v ? `<tr><td style="padding:6px 12px 6px 0;color:#5A6573;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 0;color:#1B2F4A">${v}</td></tr>` : '';
  const nota = String(inv.nota ?? '').trim();
  return `<!doctype html><html lang="it"><body style="margin:0;padding:0;background:#F5F6F8">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1B2F4A">
<div style="background:#ffffff;border:1px solid #D9DEE5;border-radius:14px;padding:26px 24px">
<p style="margin:0 0 18px"><img src="https://app.tixcantiere.it/marchio-tix.png" alt="TIX" height="40" style="height:40px;width:auto;display:block"></p>
<p style="margin:0 0 14px">Buongiorno,</p>
<p style="margin:0 0 14px"><strong>${nome}</strong> (<a href="mailto:${emailC}" style="color:#1B2F4A">${emailC}</a>) ti ha inviato il file del suo <strong>cartello di cantiere da stampare</strong>, preparato con TIX · Diario di cantiere.</p>
<table style="border-collapse:collapse;margin:6px 0 18px;font-size:14px">
${riga('Opera', esc(M_titolo(String(vendita.oggetto ?? ''))))}
${riga('Ubicazione', esc(vendita.ubicazione ?? ''))}
${riga('Misura', `base ${esc(b)} × altezza ${esc(h)} cm`)}
${riga('File', `PDF/X-1a:2001 — CMYK FOGRA39, testi convertiti in tracciati, pronto per la stampa (${mb} MB)`)}
</table>
${nota ? `<div style="background:#F5F6F8;border-left:4px solid #F26A10;border-radius:6px;padding:10px 14px;margin:0 0 18px"><div style="font-size:12px;color:#5A6573;margin-bottom:4px">Messaggio di ${nome}</div>${esc(nota).replace(/\n/g, '<br>')}</div>` : ''}
<p style="margin:0 0 8px;text-align:center"><a href="${esc(link)}" style="display:inline-block;background:#F26A10;color:#1B2F4A;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:999px">Scarica il file per la stampa</a></p>
<p style="margin:0 0 18px;text-align:center;font-size:13px;color:#5A6573">Il link resta valido fino al ${esc(scade)}.</p>
<p style="margin:0 0 6px">Per domande sulla stampa, tempi o prezzi <strong>rispondi a questa email</strong>: la risposta arriva direttamente a ${nome} (${emailC}).</p>
</div>
<div style="padding:16px 8px;font-size:12px;line-height:1.5;color:#5A6573">
<p style="margin:0 0 8px"><strong>Chi siamo.</strong> TIX · Diario di cantiere (www.tixcantiere.it) è il servizio con cui le imprese edili tengono il diario di cantiere su WhatsApp e creano online il proprio cartello di cantiere.</p>
<p style="margin:0">Questa email è partita su richiesta di ${nome}, che ha indicato il tuo indirizzo per la stampa del cartello. Non ti abbiamo iscritto a nessuna lista e non riceverai altre email da noi. Il file verrà cancellato dai nostri sistemi dopo la scadenza del link.</p>
</div></div></body></html>`;
}
function M_titolo(oggetto: string): string {
  const t = oggetto.replace(/^\s*lavori(\s+di)?\s*/i, '').trim();
  return t ? 'Lavori di ' + t : '';
}

async function invioConferma(req: Request): Promise<Response> {
  let d: Dizionario;
  try { d = (await req.json()) as Dizionario; } catch { return json({ errore: 'richiesta non leggibile' }, 400); }
  const id = String(d.id ?? ''), sessione = String(d.sessione ?? '');
  if (!RE_UUID.test(id) || !RE_SESSIONE.test(sessione)) return json({ errore: 'invio non riconosciuto' }, 400);
  const inv = await leggiInvio(`id=eq.${id}&session_id=eq.${encodeURIComponent(sessione)}`);
  if (!inv) return json({ errore: 'invio non riconosciuto' }, 404);
  if (inv.stato === 'inviato') return json({ esito: 'inviato', a: inv.email_tipografo });
  if (inv.stato !== 'preparato') return json({ errore: 'invio non più valido: riprova da capo' }, 410);
  const vendita = await leggiVendita(sessione);
  if (!vendita || vendita.stato !== 'pagato') return json({ errore: 'si possono inviare solo cartelli già pagati' }, 403);

  // il file c'è davvero ed è un PDF della dimensione dichiarata?
  const percorso = String(inv.percorso_file);
  const cartella = percorso.split('/')[0], nomeOggetto = percorso.split('/')[1];
  const rl = await storage(`object/list/${BUCKET}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: cartella + '/', search: nomeOggetto, limit: 1 }) });
  const elenco = rl.ok ? ((await rl.json()) as { name: string; metadata?: { size?: number } }[]) : [];
  const ogg = elenco.find((o) => o.name === nomeOggetto);
  const dimensione = Number(ogg?.metadata?.size ?? 0);
  if (!ogg || dimensione < 1000) return json({ errore: 'il file non è arrivato: riprova' }, 409);

  const imp = await impostazioni(['cartello_invio_hook_url', 'cartello_invio_hook_chiave', 'cartello_invio_max', 'cartello_invio_giorni', 'cartello_url']);
  const max = Math.max(1, parseInt(imp.cartello_invio_max || '3', 10) || 3);
  if ((await contaInvii(sessione)) >= max) return json({ errore: `hai già usato i ${max} invii compresi per questo cartello` }, 429);
  if (!imp.cartello_invio_hook_url || !imp.cartello_invio_hook_chiave) return json({ errore: 'invio email non configurato' }, 503);
  const giorni = Math.max(1, parseInt(imp.cartello_invio_giorni || '30', 10) || 30);
  const scadeIl = new Date(Date.now() + giorni * 86400000);
  const base = (imp.cartello_url || CARTELLO_URL_DEFAULT).replace(/\/+$/, '');
  const link = `${base}/file?k=${encodeURIComponent(String(inv.chiave_link))}`;
  const scade = new Intl.DateTimeFormat('it-IT', { dateStyle: 'long', timeZone: 'Europe/Rome' }).format(scadeIl);
  const nome = String(inv.nome_cliente ?? '').replace(/["<>\\]/g, '').slice(0, 60);
  const [b, h] = String(inv.formato ?? '').split('x');
  const payload = {
    chiave: imp.cartello_invio_hook_chiave,
    da: `"${nome} tramite TIX" <info@tixcantiere.it>`,
    a: inv.email_tipografo, cc: inv.email_cliente, rispondi_a: inv.email_cliente,
    oggetto: `Cartello di cantiere da stampare (${b}×${h} cm) — ${nome}`,
    html: htmlEmail({ ...inv, byte: dimensione }, vendita, link, scade),
  };
  let esitoOk = false, motivo = '';
  try {
    const r = await fetch(imp.cartello_invio_hook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const t = await r.text();
    try { const j = JSON.parse(t); esitoOk = j.esito === 'inviato'; motivo = j.errore ?? ''; } catch { motivo = t.slice(0, 160); }
  } catch (e) { motivo = String((e as Error)?.message ?? e).slice(0, 160); }
  if (!esitoOk) {
    await aggiornaInvio(id, { stato: 'errore', errore: motivo || 'invio non confermato' });
    await cancellaFile([percorso]);
    return json({ errore: 'l’email non è partita' + (motivo ? ' (' + motivo.slice(0, 120) + ')' : '') + ': riprova tra poco' }, 502);
  }
  await aggiornaInvio(id, { stato: 'inviato', inviato_il: new Date().toISOString(), scade_il: scadeIl.toISOString(), byte: dimensione });
  return json({ esito: 'inviato', a: inv.email_tipografo, scade, rimasti: Math.max(0, max - (await contaInvii(sessione))) });
}

function paginaSemplice(titolo: string, testo: string, stato: number): Response {
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titolo)}</title></head>
<body style="margin:0;background:#F5F6F8;font-family:Arial,Helvetica,sans-serif;color:#1B2F4A"><div style="max-width:520px;margin:12vh auto;padding:28px 24px;background:#fff;border:1px solid #D9DEE5;border-radius:14px">
<p style="margin:0 0 16px"><img src="https://app.tixcantiere.it/marchio-tix.png" alt="TIX" height="36" style="height:36px;width:auto;display:block"></p>
<h1 style="font-size:20px;margin:0 0 10px">${esc(titolo)}</h1><p style="margin:0 0 14px;line-height:1.55">${testo}</p>
<p style="margin:0;font-size:13px;color:#5A6573">TIX · Diario di cantiere — www.tixcantiere.it</p></div></body></html>`;
  return new Response(html, { status: stato, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

async function scaricaFile(k: string): Promise<Response> {
  if (!RE_CHIAVE.test(k)) return paginaSemplice('Link non valido', 'Il link non è completo. Prova a copiarlo di nuovo dall’email ricevuta.', 404);
  const inv = await leggiInvio(`chiave_link=eq.${encodeURIComponent(k)}`);
  if (!inv || inv.stato !== 'inviato') {
    if (inv && inv.stato === 'scaduto') return paginaSemplice('Link scaduto', 'Il file del cartello non è più disponibile. Chiedi a chi te l’ha inviato di mandarlo di nuovo.', 410);
    return paginaSemplice('File non disponibile', 'Questo file non è disponibile. Chiedi a chi te l’ha inviato di mandarlo di nuovo.', 404);
  }
  if (new Date(String(inv.scade_il)).getTime() < Date.now()) return paginaSemplice('Link scaduto', 'Il file del cartello non è più disponibile. Chiedi a chi te l’ha inviato di mandarlo di nuovo.', 410);
  const rs = await storage(`object/sign/${BUCKET}/${inv.percorso_file}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) });
  const j = rs.ok ? ((await rs.json()) as { signedURL?: string }) : {};
  if (!j.signedURL) return paginaSemplice('File momentaneamente non disponibile', 'Riprova tra qualche minuto.', 503);
  await aggiornaInvio(String(inv.id), { scarichi: Number(inv.scarichi ?? 0) + 1, ultimo_scarico_il: new Date().toISOString() });
  const dest = `${URL_BASE}/storage/v1${j.signedURL}${j.signedURL.includes('?') ? '&' : '?'}download=${encodeURIComponent(String(inv.nome_file))}`;
  return new Response(null, { status: 302, headers: { Location: dest, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

async function pulizia(req: Request): Promise<Response> {
  const imp = await impostazioni(['cartello_invio_hook_chiave']);
  if (!imp.cartello_invio_hook_chiave || req.headers.get('x-chiave') !== imp.cartello_invio_hook_chiave) return json({ errore: 'non autorizzato' }, 401);
  const adesso = new Date().toISOString();
  const ieri = new Date(Date.now() - 86400000).toISOString();
  const r1 = await dbFetch(`cartelli_invii?select=id,percorso_file&stato=eq.inviato&scade_il=lt.${adesso}&limit=200`, { method: 'GET' });
  const scaduti = r1 && r1.ok ? ((await r1.json()) as Dizionario[]) : [];
  const r2 = await dbFetch(`cartelli_invii?select=id,percorso_file&stato=eq.preparato&creato_il=lt.${ieri}&limit=200`, { method: 'GET' });
  const abbandonati = r2 && r2.ok ? ((await r2.json()) as Dizionario[]) : [];
  await cancellaFile([...scaduti, ...abbandonati].map((x) => String(x.percorso_file)));
  for (const x of scaduti) await aggiornaInvio(String(x.id), { stato: 'scaduto' });
  for (const x of abbandonati) await aggiornaInvio(String(x.id), { stato: 'errore', errore: 'file mai confermato, cancellato' });
  return json({ esito: 'ok', scaduti: scaduti.length, abbandonati: abbandonati.length });
}

// ------------------------------------------------------------------ instradamento
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!URL_BASE || !CHIAVE) return json({ errore: 'servizio non configurato' }, 503);
  const url = new URL(req.url);
  const percorso = (url.pathname.replace(/^\/functions\/v1/, '').replace(/^\/cartello/, '') || '/').replace(/\/+$/, '') || '/';

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (percorso === '/file') { try { return await scaricaFile(url.searchParams.get('k') ?? ''); } catch { return paginaSemplice('File momentaneamente non disponibile', 'Riprova tra qualche minuto.', 503); } }
    if (percorso === '/verifica') return await verifica(url.searchParams.get('sessione') ?? '', (url.searchParams.get('piva') ?? '').slice(0, 200), (url.searchParams.get('testo') ?? '').slice(0, 2000));
    if (percorso === '/' || percorso === '/stato') {
      const imp = await impostazioni(['cartello_attivo', 'cartello_prezzo_cent']);
      return json({ servizio: 'cartello', attivo: (imp.cartello_attivo || 'si') !== 'no', prezzo_cent: parseInt(imp.cartello_prezzo_cent || '900', 10) || 900, pagamenti: (await canaleStripe()) ? 'configurati (' + (STRIPE_KEY ? 'chiave diretta' : 'via Make 7820289') + ')' : 'da configurare' });
    }
    return json({ errore: 'percorso non valido' }, 404);
  }

  if (req.method === 'POST') {
    if (percorso === '/checkout') {
      try { return await checkout(req); } catch (e) { return json({ errore: 'errore interno: ' + String((e as Error)?.message ?? e).slice(0, 120) }, 500); }
    }
    if (percorso === '/invio-prepara') {
      try { return await invioPrepara(req); } catch (e) { return json({ errore: 'errore interno: ' + String((e as Error)?.message ?? e).slice(0, 120) }, 500); }
    }
    if (percorso === '/invio-conferma') {
      try { return await invioConferma(req); } catch (e) { return json({ errore: 'errore interno: ' + String((e as Error)?.message ?? e).slice(0, 120) }, 500); }
    }
    if (percorso === '/pulizia') return await pulizia(req);
    if (percorso === '/scarico') {
      try {
        const d = (await req.json()) as Dizionario;
        const s = String(d.sessione ?? '');
        if (RE_SESSIONE.test(s)) await registraScarico(s);
      } catch { /* la registrazione del download non deve mai bloccare il cliente */ }
      return json({ esito: 'ok' });
    }
    return json({ errore: 'percorso non valido' }, 404);
  }

  return new Response('Metodo non ammesso', { status: 405, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD, POST, OPTIONS' } });
});
