// cartello — Il Giornale Lavori (05/10/2026) — v4 (09/10/2026: misure personalizzate, stati rimborsato/annullato definitivi) — v2 (sera): client_reference_id CRT-<token> per la conferma dal webhook Stripe
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
//   GET  /verifica?sessione=cs_…  {esito: 'pagato'|'in_attesa'|'non_trovato', formato, oggetto, ubicazione, pagato_il}
//   POST /scarico                 {sessione} → registra un download del PDF pagato
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
  'Access-Control-Allow-Headers': 'Content-Type',
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
  const ammessi = [base, 'https://www.ilgiornalelavori.it', 'https://ilgiornalelavori.it'];
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
    'line_items[0][price_data][product_data][description]': 'File PDF vettoriale per la stampa, con render, loghi e QR — Il Giornale Lavori',
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

async function verifica(sessione: string): Promise<Response> {
  if (!RE_SESSIONE.test(sessione)) return json({ esito: 'non_trovato' }, 404);
  const riga = await leggiVendita(sessione);
  if (!riga) return json({ esito: 'non_trovato' }, 404);
  // v4 (09/10/2026): vendita rimborsata o annullata → non si sblocca più, anche se su Stripe la sessione resta «paid»
  if (riga.stato === 'rimborsato' || riga.stato === 'annullato') return json({ esito: String(riga.stato) }, 410);
  if (riga.stato === 'pagato') {
    return json({ esito: 'pagato', formato: riga.formato, orientamento: riga.orientamento, oggetto: riga.oggetto, ubicazione: riga.ubicazione, pagato_il: dataIt(riga.pagato_il as string) });
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
    await aggiornaVendita(sessione, {
      stato: 'pagato', pagato_il: quando,
      email: String(cd.email ?? s.customer_email ?? '').slice(0, 200) || null,
      cliente: String(cd.name ?? '').slice(0, 200) || null,
      partita_iva: piva || null,
      paese: String(indirizzo.country ?? '').slice(0, 2) || null,
      totale_cent: typeof s.amount_total === 'number' ? s.amount_total : riga.totale_cent,
      stripe_payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : null,
      stripe_customer: typeof s.customer === 'string' ? s.customer : null,
    });
    return json({ esito: 'pagato', formato: riga.formato, orientamento: riga.orientamento, oggetto: riga.oggetto, ubicazione: riga.ubicazione, pagato_il: dataIt(quando) });
  }
  if (s.status === 'expired') { await aggiornaVendita(sessione, { stato: 'scaduto' }); return json({ esito: 'non_trovato' }, 404); }
  return json({ esito: 'in_attesa' });
}

// ------------------------------------------------------------------ instradamento
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!URL_BASE || !CHIAVE) return json({ errore: 'servizio non configurato' }, 503);
  const url = new URL(req.url);
  const percorso = (url.pathname.replace(/^\/functions\/v1/, '').replace(/^\/cartello/, '') || '/').replace(/\/+$/, '') || '/';

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (percorso === '/verifica') return await verifica(url.searchParams.get('sessione') ?? '');
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
