// Cartello di cantiere — Il Giornale Lavori
// Motore di impaginazione condiviso fra anteprima (SVG) e file di stampa (PDF con jsPDF).
// Unità: millimetri. Il cartello è descritto da una lista di primitive (rettangoli, testi,
// immagini, marchio, QR) che i due renderer disegnano allo stesso modo.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CartelloMotore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BRAND = {
    scuro: '#052A21', accento: '#0A7D48', vivo: '#12B764', fondo: '#F4F6F5', bordo: '#D5DCD8',
    testo: '#111111', grigio: '#555555', bianco: '#FFFFFF', avviso: '#A11C1C'
  };
  const LOGO_RAPPORTO = 317.78 / 100; // larghezza / altezza del marchio orizzontale
  const SITO = 'www.ilgiornalelavori.it';
  const SLOGAN = 'Cartello realizzato con';
  // 10/10/2026 (Filippo): sul cartello delle imprese abbonate «Questo cantiere viene gestito con»; per gli altri resta SLOGAN
  const SLOGAN_ABBONATO = 'Questo cantiere viene gestito con';
  const AVVERTENZA = "ULTERIORI INFORMAZIONI SULL'OPERA POSSONO ESSERE ASSUNTE PRESSO L'UFFICIO COMPETENTE";

  // Colori del cartello scelti dal cliente (Filippo 09/10/2026). Per ogni colore:
  // testata = tinta piena in alto; medio = tinta più tenue per filetti, fascia finale e didascalie di posizione;
  // testo = tinta più scura per titolo ed etichette dei dati; chiaro = scritte secondarie sulla testata.
  // Il piede con il marchio Il Giornale Lavori resta sempre verde.
  const TEMI = {
    verde:     { nome: 'Verde',     testata: '#052A21', medio: '#0A7D48', testo: '#052A21', chiaro: '#CFE3D8' },
    rosso:     { nome: 'Rosso',     testata: '#A11C1C', medio: '#D2423A', testo: '#5C0F0F', chiaro: '#F6D3D0' },
    azzurro:   { nome: 'Azzurro',   testata: '#0B78B8', medio: '#2E96D2', testo: '#08405F', chiaro: '#D3EAF7' },
    blu:       { nome: 'Blu',       testata: '#13306E', medio: '#2F5BB7', testo: '#0B1D45', chiaro: '#D3DCF2' },
    arancione: { nome: 'Arancione', testata: '#C9550C', medio: '#E37A1F', testo: '#6B2C05', chiaro: '#FBE0C7' },
    bordeaux:  { nome: 'Bordeaux',  testata: '#6D1A2E', medio: '#9E2F49', testo: '#3D0C18', chiaro: '#F1D3DA' },
    petrolio:  { nome: 'Verde petrolio', testata: '#0E4D5A', medio: '#1F7A8C', testo: '#082C34', chiaro: '#D2E8EC' },
    oliva:     { nome: 'Verde oliva', testata: '#4E5A1C', medio: '#6F7F2A', testo: '#2C330F', chiaro: '#E5EBCF' },
    viola:     { nome: 'Viola',     testata: '#4A1F6E', medio: '#7442A3', testo: '#2B1142', chiaro: '#E6DAF1' },
    marrone:   { nome: 'Marrone',   testata: '#6B3A1E', medio: '#9A5A2E', testo: '#3B1F0F', chiaro: '#F0DFD2' },
    antracite: { nome: 'Antracite', testata: '#2A2E33', medio: '#4A5058', testo: '#15181B', chiaro: '#DCDFE2' },
    ocra:      { nome: 'Giallo ocra', testata: '#8A6100', medio: '#B07D0A', testo: '#4A3400', chiaro: '#F6E7C3' }
  };
  function temaDi(dati) { return TEMI[dati && dati.colore] || TEMI.verde; }

  const FORMATI = [
    { id: '100x100', nome: '100 × 100 cm', lato1: 1000, lato2: 1000, nota: 'quadrato, pannello singolo' },
    { id: '100x200', nome: '100 × 200 cm', lato1: 1000, lato2: 2000, nota: 'il più diffuso in edilizia privata' },
    { id: '150x300', nome: '150 × 300 cm', lato1: 1500, lato2: 3000, nota: 'cantieri medi e stradali' },
    { id: '200x300', nome: '200 × 300 cm', lato1: 2000, lato2: 3000, nota: 'grandi opere e appalti pubblici' }
  ];

  const TITOLI_ABILITATIVI = [
    ['pdc', 'Permesso di costruire'],
    ['scia', 'SCIA'],
    ['scia_alt', 'SCIA alternativa al permesso di costruire'],
    ['cila', 'CILA'],
    ['cilas', 'CILAS'],
    ['sanatoria', 'Permesso di costruire in sanatoria'],
    ['dia', 'Denuncia di inizio attività'],
    ['autorizzazione', 'Autorizzazione edilizia'],
    ['altro', 'Titolo abilitativo']
  ];

  const IMPIANTI = [
    ['elettrico', 'Impianto elettrico'],
    ['elettronico', 'Impianto elettronico'],
    ['radiotv', 'Impianto radiotelevisivo'],
    ['idraulico', 'Impianto idraulico'],
    ['metano', 'Impianto di trasporto e utilizzo del metano'],
    ['riscaldamento', 'Impianto di riscaldamento'],
    ['climatizzazione', 'Impianto di climatizzazione']
  ];

  // Campi del modulo. «per» dice in quale tipo di cantiere il campo compare.
  // «riga» è l'etichetta stampata sul cartello (se diversa dall'etichetta del modulo).
  // Diciture allineate al cartello di cantiere tradizionale (foto di Filippo, 07/10/2026).
  const CAMPI = [
    { g: 'intestazione', id: 'ente', eti: { privato: 'Comune di (scrivi solo il nome)', pubblico: 'Stazione appaltante' }, ph: { privato: 'Vigonza', pubblico: 'Comune di Padova' }, per: 'entrambi', obbl: true },
    { g: 'intestazione', id: 'ente_sotto', eti: { privato: 'Provincia di (scrivi solo il nome)', pubblico: 'Settore / ufficio competente' }, ph: { privato: 'Padova', pubblico: 'Settore Lavori Pubblici e Infrastrutture' }, per: 'entrambi' },
    { g: 'intestazione', id: 'ufficio', eti: 'Ufficio competente', ph: 'Ufficio Edilizia Privata — Comune di Vigonza', per: 'privato', riga: 'Ufficio competente' },
    { g: 'intestazione', id: 'oggetto', eti: 'Oggetto dei lavori (sul cartello è sempre preceduto da «Lavori di»)', ph: 'ristrutturazione edilizia con ampliamento di fabbricato residenziale', per: 'entrambi', obbl: true, tipo: 'textarea' },
    { g: 'intestazione', id: 'ubicazione', eti: 'Ubicazione del cantiere', ph: 'Via Roma 12 — Vigonza (PD)', per: 'entrambi', obbl: true },
    { g: 'intestazione', id: 'catasto', eti: 'Riferimenti catastali', ph: 'Fg. 5, Mapp. 123, Sub. 2', per: 'entrambi' },

    { g: 'titolo', id: 'titolo_tipo', eti: 'Tipo di titolo abilitativo', per: 'privato', tipo: 'select', opzioni: TITOLI_ABILITATIVI },
    { g: 'titolo', id: 'titolo_estremi', eti: 'N° del titolo', ph: '45/2026', per: 'privato', obbl: true },
    { g: 'titolo', id: 'titolo_data', tipo: 'data', eti: 'In data', ph: '12/03/2026', per: 'privato' },
    { g: 'titolo', id: 'titolo_altri', eti: 'Altri titoli e autorizzazioni', ph: 'Autorizzazione paesaggistica n. … del …\nDeposito sismico prot. … del …', per: 'privato', tipo: 'textarea', riga: 'Altri titoli e autorizzazioni' },
    { g: 'titolo', id: 'notifica', eti: 'Notifica preliminare (art. 99 D.Lgs. 81/2008)', ph: 'prot. 12345 del 01/10/2026', per: 'entrambi', riga: 'Notifica preliminare (art. 99 D.Lgs. 81/2008)' },
    { g: 'titolo', id: 'n_lavoratori', eti: 'Numero presunto di lavoratori sul cantiere', ph: '12', per: 'entrambi', riga: 'Numero presunto di lavoratori sul cantiere' },

    { g: 'appalto', id: 'cup', eti: 'CUP', ph: 'H71B23000000001', per: 'pubblico' },
    { g: 'appalto', id: 'cig', eti: 'CIG', ph: 'A0123456789', per: 'pubblico' },
    { g: 'appalto', id: 'importo_progetto', eti: { privato: 'Importo complessivo dei lavori', pubblico: 'Importo complessivo del progetto' }, ph: { privato: '€ 180.000,00', pubblico: '€ 1.250.000,00' }, per: 'entrambi', riga: { privato: 'Importo complessivo dei lavori', pubblico: 'Importo complessivo del progetto' } },
    { g: 'appalto', id: 'importo_lavori', eti: "Importo lavori a base d'appalto", ph: '€ 980.000,00', per: 'pubblico', riga: "Importo lavori a base d'appalto" },
    { g: 'appalto', id: 'oneri_sicurezza', eti: 'Oneri per la sicurezza (non soggetti a ribasso)', ph: '€ 32.000,00', per: 'pubblico', riga: 'Oneri per la sicurezza' },
    { g: 'appalto', id: 'importo_contratto', eti: 'Importo contrattuale', ph: '€ 871.250,00 (ribasso del 12,35 %)', per: 'pubblico', riga: 'Importo contrattuale' },
    { g: 'appalto', id: 'finanziamento', eti: 'Fonte di finanziamento', ph: 'PNRR — M5C2 Inv. 2.1 · Fondi di bilancio', per: 'pubblico', riga: 'Fonte di finanziamento' },
    { g: 'appalto', id: 'contratto', eti: "Contratto d'appalto", ph: 'Rep. n. 1234 del 10/01/2026', per: 'pubblico', riga: "Contratto d'appalto" },

    { g: 'soggetti', id: 'proprieta', eti: 'Proprietà', ph: 'Mario Rossi e Anna Bianchi', per: 'privato', riga: 'Proprietà' },
    { g: 'soggetti', id: 'committente', eti: 'Committente', ph: 'Mario Rossi — Via Verdi 3, Padova', per: 'entrambi', obblPer: 'privato', riga: 'Committente' },
    { g: 'soggetti', id: 'rup', titolo: true, eti: 'Responsabile unico del progetto (RUP)', ph: 'ing. Anna Bianchi', per: 'pubblico', riga: 'Responsabile unico del progetto (RUP)' },
    { g: 'soggetti', id: 'progettista', titolo: true, eti: 'Progettista', ph: 'arch. Luca Verdi — Ordine Architetti PD n. 1234', per: 'entrambi', riga: 'Progettista' },
    { g: 'soggetti', id: 'direttore_lavori', titolo: true, eti: 'Direttore dei lavori', ph: 'arch. Luca Verdi', per: 'entrambi', obbl: true, riga: 'Direttore dei lavori' },
    { g: 'soggetti', id: 'dl_strutture', titolo: true, eti: 'Direttore dei lavori delle strutture', ph: 'ing. Paolo Neri', per: 'entrambi', riga: 'Direttore dei lavori delle strutture' },
    { g: 'soggetti', id: 'csp', titolo: true, eti: 'Coordinatore per la progettazione (sicurezza)', ph: 'geom. Sara Gialli', per: 'entrambi', riga: 'Coordinatore per la progettazione' },
    { g: 'soggetti', id: 'responsabile_lavori', titolo: true, eti: 'Responsabile dei lavori', ph: '', per: 'entrambi', riga: 'Responsabile dei lavori' },
    { g: 'soggetti', id: 'cse', titolo: true, eti: "Coordinatore per l'esecuzione (sicurezza)", ph: 'geom. Sara Gialli', per: 'entrambi', riga: "Coordinatore per l'esecuzione" },
    { g: 'soggetti', id: 'progettista_strutture', titolo: true, eti: 'Calcolatore statico', ph: 'ing. Paolo Neri', per: 'entrambi', riga: 'Calcolatore statico' },
    { g: 'soggetti', id: 'calcolatore_ca', titolo: true, eti: 'Calcolatore opere in C.A.', ph: 'ing. Paolo Neri', per: 'entrambi', riga: 'Calcolatore opere in C.A.' },
    { g: 'soggetti', id: 'collaudatore', titolo: true, eti: "Collaudatore in corso d'opera", ph: 'ing. Carla Viola', per: 'entrambi', riga: "Collaudatore in corso d'opera" },
    { g: 'soggetti', id: 'altri_tecnici', eti: 'Altri tecnici', ph: 'geol. … (relazione geologica)\ning. … (certificazione energetica)', per: 'entrambi', tipo: 'textarea', riga: 'Altri tecnici' },

    { g: 'impresa', id: 'impresa', eti: 'Impresa esecutrice', ph: 'Rossi Costruzioni S.r.l. — Via dell’Industria 8, Padova — P.IVA 01234567890', per: 'entrambi', obbl: true, tipo: 'textarea', riga: 'Impresa esecutrice' },
    { g: 'impresa', id: 'impresa_cciaa', eti: 'C.C.I.A.A. (iscrizione / n. REA)', ph: 'PD-123456', per: 'entrambi' },
    { g: 'impresa', id: 'impresa_anc', eti: 'A.N.C. (se presente)', ph: '', per: 'entrambi' },
    { g: 'impresa', id: 'impresa_soa', eti: 'S.O.A. (attestazione e categorie)', ph: 'n. 12345/10/00 — OG1 cl. III', per: 'entrambi' },
    { g: 'impresa', id: 'direttore_cantiere', titolo: true, eti: 'Direttore del cantiere', ph: 'geom. Andrea Rossi', per: 'entrambi', riga: 'Direttore del cantiere' },
    { g: 'impresa', id: 'assistente_dc', titolo: true, eti: 'Assistente del direttore di cantiere', ph: 'geom. Marco Verdi', per: 'entrambi', riga: 'Assistente del direttore di cantiere' },
    { g: 'impresa', id: 'capocantiere', titolo: true, eti: 'Capo cantiere', ph: 'Giovanni Bianchi', per: 'entrambi', riga: 'Capo cantiere' },
    { g: 'impresa', id: 'resp_sicurezza', titolo: true, eti: 'Responsabile della sicurezza', ph: 'RSPP: ing. Luisa Neri', per: 'entrambi', riga: 'Responsabile della sicurezza' },
    { g: 'impresa', id: 'subappaltatori', eti: 'Imprese subappaltatrici (una per riga, con C.C.I.A.A., A.N.C., S.O.A.)', ph: 'Impianti Bianchi S.n.c. — C.C.I.A.A. PD-234567 — S.O.A. OS30 cl. II\nIdraulica Verdi S.r.l. — C.C.I.A.A. PD-345678', per: 'entrambi', tipo: 'textarea', riga: 'Imprese subappaltatrici' },
    { g: 'impianti', id: 'imp_elettrico_prog', titolo: true, eti: 'Impianto elettrico — progettista', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_elettrico_inst', eti: 'Impianto elettrico — impresa installatrice', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_elettronico_prog', titolo: true, eti: 'Impianto elettronico — progettista', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_elettronico_inst', eti: 'Impianto elettronico — impresa installatrice', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_radiotv_prog', titolo: true, eti: 'Impianto radiotelevisivo — progettista', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_radiotv_inst', eti: 'Impianto radiotelevisivo — impresa installatrice', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_idraulico_prog', titolo: true, eti: 'Impianto idraulico — progettista', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_idraulico_inst', eti: 'Impianto idraulico — impresa installatrice', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_metano_prog', titolo: true, eti: 'Impianto trasporto e utilizzo metano — progettista', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_metano_inst', eti: 'Impianto trasporto e utilizzo metano — impresa installatrice', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_riscaldamento_prog', titolo: true, eti: 'Impianto di riscaldamento — progettista', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_riscaldamento_inst', eti: 'Impianto di riscaldamento — impresa installatrice', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_climatizzazione_prog', titolo: true, eti: 'Impianto di climatizzazione — progettista', ph: '', per: 'entrambi' },
    { g: 'impianti', id: 'imp_climatizzazione_inst', eti: 'Impianto di climatizzazione — impresa installatrice', ph: '', per: 'entrambi' },

    { g: 'tempi', id: 'data_inizio', tipo: 'data', eti: { privato: 'Data inizio lavori', pubblico: 'Data di consegna / inizio lavori' }, ph: '15/10/2026', per: 'entrambi', riga: { privato: 'Data inizio lavori', pubblico: 'Data di consegna / inizio lavori' } },
    { g: 'tempi', id: 'tempo_utile', eti: "Tempo utile per l'ultimazione", ph: '365 giorni naturali e consecutivi', per: 'pubblico', riga: "Tempo utile per l'ultimazione" },
    { g: 'tempi', id: 'data_fine', tipo: 'data', eti: 'Data contrattuale di ultimazione dei lavori', ph: '30/06/2027', per: 'entrambi', riga: 'Data contrattuale di ultimazione dei lavori' }
  ];

  const ORDINE_RIGHE = {
    privato: ['ufficio', 'titolo', 'titolo_altri', 'proprieta', 'committente', 'importo_progetto', 'date', 'progettista',
      'direttore_cantiere', 'assistente_dc', 'direttore_lavori', 'dl_strutture', 'csp', 'responsabile_lavori', 'cse', 'capocantiere',
      'progettista_strutture', 'calcolatore_ca', 'collaudatore', 'resp_sicurezza', 'impresa', 'subappaltatori', 'n_lavoratori',
      'impianti', 'altri_tecnici', 'notifica'],
    pubblico: ['cupcig', 'importo_progetto', 'importo_lavori', 'oneri_sicurezza', 'importo_contratto', 'finanziamento', 'contratto',
      'committente', 'rup', 'date', 'tempo_utile', 'progettista',
      'direttore_cantiere', 'assistente_dc', 'direttore_lavori', 'dl_strutture', 'csp', 'responsabile_lavori', 'cse', 'capocantiere',
      'progettista_strutture', 'calcolatore_ca', 'collaudatore', 'resp_sicurezza', 'impresa', 'subappaltatori', 'n_lavoratori',
      'impianti', 'altri_tecnici', 'notifica']
  };

  // Prefissi automatici (decisione di Filippo 07/10/2026): il cliente scrive solo il nome.
  // «Vigonza» → «Comune di Vigonza»; «Padova» → «Provincia di Padova»; «ristrutturazione…» → «Lavori di ristrutturazione…».
  // Se il cliente ha già scritto il prefisso, non si raddoppia.
  function conPrefisso(testo, prefisso, re) {
    const t = pulisci(testo);
    if (!t) return '';
    if (re.test(t)) return t;
    return prefisso + ' ' + t.charAt(0).toUpperCase() + t.slice(1);
  }
  function nomeComune(s) { return conPrefisso(s, 'Comune di', /^(comune|citt[aà]|municipio)(?=\s|$)/i); }
  function nomeProvincia(s) { return conPrefisso(s, 'Provincia di', /^(provincia|citt[aà] metropolitana|regione)(?=\s|$)/i); }
  function titoloLavori(s) {
    let t = pulisci(s);
    if (!t) return '';
    // «Lavori di» compare sempre (Filippo 07/10/2026): si toglie un eventuale «lavori di» / «lavori» già scritto e si rimette il prefisso
    t = t.replace(/^lavori(\s+di)?(\s+|$)/i, '');
    if (!t) return '';
    // minuscola iniziale, salvo sigle o nomi propri tutti maiuscoli (es. «SP 52», «PNRR»)
    if (!/^[A-ZÀ-Ý]{2,}\b/.test(t)) t = t.charAt(0).toLowerCase() + t.slice(1);
    return 'Lavori di ' + t;
  }

  // Qualifica dei tecnici (Filippo 09/10/2026): scelta a pulsanti nel modulo, stampata davanti al nome.
  const QUALIFICHE = ['ing.', 'arch.', 'geom.', 'per. ind.', 'dott.'];
  const RE_QUALIFICA = /^(ing|arch|geom|per\.?\s*ind|p\.?\s*i|dott|dr|avv|geol|agr|ind)\.?\s/i;
  function conQualifica(nome, qualifica) {
    const n = pulisci(nome);
    if (!n || !qualifica || RE_QUALIFICA.test(n)) return n;
    return qualifica + ' ' + n;
  }

  function perTipo(v, tipo) { return (v && typeof v === 'object') ? (v[tipo] || '') : (v || ''); }
  function campo(id) { return CAMPI.find((c) => c.id === id); }
  function pulisci(s) { return String(s == null ? '' : s).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }

  // Righe della tabella (etichetta → valore), nell'ordine previsto per il tipo di cantiere.
  function costruisciRighe(dati) {
    const tipo = dati.tipo === 'pubblico' ? 'pubblico' : 'privato';
    const c = dati.campi || {};
    const v = (id) => pulisci(c[id]);
    const righe = [];
    for (const id of ORDINE_RIGHE[tipo]) {
      if (id === 'titolo') {
        const estremi = v('titolo_estremi');
        if (!estremi) continue;
        const t = TITOLI_ABILITATIVI.find((x) => x[0] === (c.titolo_tipo || 'pdc')) || TITOLI_ABILITATIVI[0];
        const data = v('titolo_data');
        righe.push({ id, etichetta: t[1] + ' n°', valore: estremi + (data ? '   in data ' + data : ''), forte: true });
        continue;
      }
      if (id === 'date') {
        // «Data inizio lavori» e «Data contrattuale di ultimazione» come due righe distinte
        for (const d of ['data_inizio', 'data_fine']) {
          const def = campo(d), val = v(d);
          if (val) righe.push({ id: d, etichetta: perTipo(def.riga, tipo), valore: val, forte: false });
        }
        continue;
      }
      if (id === 'impresa') {
        const imp = v('impresa');
        if (!imp) continue;
        const iscr = [['C.C.I.A.A.', 'impresa_cciaa'], ['A.N.C.', 'impresa_anc'], ['S.O.A.', 'impresa_soa']].filter((x) => v(x[1])).map((x) => x[0] + ' ' + v(x[1]));
        righe.push({ id, etichetta: 'Impresa esecutrice', valore: imp + (iscr.length ? '\n' + iscr.join('  ·  ') : ''), forte: true });
        continue;
      }
      if (id === 'impianti') {
        for (const [k, nome] of IMPIANTI) {
          const p = conQualifica(v('imp_' + k + '_prog'), v('imp_' + k + '_prog_titolo')), ins = v('imp_' + k + '_inst');
          if (!p && !ins) continue;
          const parti = [];
          if (p) parti.push('Progettista: ' + p);
          if (ins) parti.push('Impresa installatrice: ' + ins);
          righe.push({ id: 'imp_' + k, etichetta: nome, valore: parti.join('\n'), forte: false });
        }
        continue;
      }
      if (id === 'cupcig') {
        const cup = v('cup'), cig = v('cig');
        if (!cup && !cig) continue;
        const parti = [];
        if (cup) parti.push('CUP ' + cup);
        if (cig) parti.push('CIG ' + cig);
        righe.push({ id, etichetta: 'CUP / CIG', valore: parti.join('  ·  '), forte: true });
        continue;
      }
      const def = campo(id);
      const val = def && def.titolo ? conQualifica(v(id), v(id + '_titolo')) : v(id);
      if (!def || !val) continue;
      righe.push({ id, etichetta: perTipo(def.riga, tipo) || perTipo(def.eti, tipo), valore: val, forte: ['impresa', 'direttore_lavori', 'committente'].includes(id) });
    }
    // tutti i valori compilati in carattere normale (Filippo 07/10/2026)
    for (const r of righe) r.forte = false;
    return righe;
  }

  // ------------------------------------------------------------------ misura e a capo
  // mis.larghezza(testo, grassetto, dimensioneMm) → larghezza in mm
  function spezzaParola(mis, parola, b, size, maxw) {
    const pezzi = [];
    let cur = '';
    for (const ch of parola) {
      if (mis.larghezza(cur + ch, b, size) > maxw && cur) { pezzi.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) pezzi.push(cur);
    return pezzi;
  }

  function aCapo(mis, testo, b, size, maxw) {
    const righe = [];
    for (const par of pulisci(testo).split('\n')) {
      const parole = par.split(/\s+/).filter(Boolean);
      if (parole.length === 0) { righe.push(''); continue; }
      let cur = '';
      for (const p of parole) {
        const prova = cur ? cur + ' ' + p : p;
        if (mis.larghezza(prova, b, size) <= maxw) { cur = prova; continue; }
        if (cur) righe.push(cur);
        if (mis.larghezza(p, b, size) <= maxw) cur = p;
        else { const pezzi = spezzaParola(mis, p, b, size, maxw); cur = pezzi.pop() || ''; righe.push(...pezzi); }
      }
      righe.push(cur);
    }
    return righe;
  }

  // Riduce la dimensione finché il testo sta in maxw × (maxRighe) oppure in maxh.
  function adatta(mis, testo, b, sizeMax, sizeMin, maxw, maxRighe, maxh, lh) {
    lh = lh || 1.18;
    let size = sizeMax;
    for (let i = 0; i < 40; i++) {
      const righe = aCapo(mis, testo, b, size, maxw);
      const h = righe.length * size * lh;
      const okRighe = !maxRighe || righe.length <= maxRighe;
      const okH = !maxh || h <= maxh;
      if ((okRighe && okH) || size <= sizeMin) return { size, righe, h, troncato: !(okRighe && okH) };
      size = Math.max(sizeMin, size * 0.94);
    }
    const righe = aCapo(mis, testo, b, size, maxw);
    return { size, righe, h: righe.length * size * lh, troncato: true };
  }

  function dentro(imgW, imgH, boxW, boxH) {
    const r = Math.min(boxW / imgW, boxH / imgH);
    return { w: imgW * r, h: imgH * r };
  }

  // ------------------------------------------------------------------ impaginazione
  // Misure personalizzate (Filippo 09/10/2026): base e altezza in cm scritte dal cliente, da 40 a 600 cm per lato.
  const MISURA_MIN = 40, MISURA_MAX = 600, MISURA_RAPPORTO = 3;
  function misuraSu(dati) {
    const m = (dati && dati.misura) || {};
    const lim = (v, d) => { const n = Math.round(Number(String(v == null ? '' : v).replace(',', '.'))); return isFinite(n) && n > 0 ? Math.max(MISURA_MIN, Math.min(MISURA_MAX, n)) : d; };
    return { b: lim(m.b, 120), h: lim(m.h, 180) };
  }
  function controllaMisura(dati) {
    const m = (dati && dati.misura) || {};
    const b = Number(String(m.b == null ? '' : m.b).replace(',', '.')), h = Number(String(m.h == null ? '' : m.h).replace(',', '.'));
    if (!b || !h) return 'Scrivi base e altezza del cartello in centimetri.';
    if (b < MISURA_MIN || h < MISURA_MIN || b > MISURA_MAX || h > MISURA_MAX) return 'Ogni lato deve essere tra ' + MISURA_MIN + ' e ' + MISURA_MAX + ' cm.';
    if (Math.max(b, h) / Math.min(b, h) > MISURA_RAPPORTO) return 'Il lato lungo può essere al massimo ' + MISURA_RAPPORTO + ' volte il lato corto, altrimenti i testi non stanno.';
    return '';
  }
  function codiceFormato(dati) {
    if (dati.formato !== 'su_misura') return dati.formato;
    const s = misuraSu(dati); return s.b + 'x' + s.h;
  }
  function dimensioni(dati) {
    if (dati.formato === 'su_misura') {
      const s = misuraSu(dati);
      const f = { id: s.b + 'x' + s.h, nome: s.b + ' × ' + s.h + ' cm (su misura)', lato1: s.b * 10, lato2: s.h * 10, nota: 'su misura' };
      return { W: s.b * 10, H: s.h * 10, formato: f, orizzontale: s.b > s.h };
    }
    const f = FORMATI.find((x) => x.id === dati.formato) || FORMATI[3];
    const oriz = dati.orientamento === 'orizzontale';
    const W = oriz ? f.lato2 : f.lato1;
    const H = oriz ? f.lato1 : f.lato2;
    return { W, H, formato: f, orizzontale: oriz };
  }

  function impagina(dati, mis) {
    const { W, H, formato, orizzontale } = dimensioni(dati);
    const b = Math.max(0, Math.min(100, Number(dati.abbondanza) || 0));
    const tipo = dati.tipo === 'pubblico' ? 'pubblico' : 'privato';
    const c = dati.campi || {};
    const img = dati.immagini || {};
    const loghi = (img.loghi || []).filter(Boolean).slice(0, 7);
    const tema = temaDi(dati);
    const u = Math.min(W, H) / 100;        // unità di disegno: 1 % del lato corto
    const m = 3 * u;                        // margine di sicurezza
    const prims = [];
    const avvisi = [];
    const R = (x, y, w, h, f, extra) => prims.push(Object.assign({ t: 'rect', x, y, w, h, f }, extra || {}));
    const T = (x, y, s, size, b_, col, a, extra) => prims.push(Object.assign({ t: 'text', x, y, s, size, b: !!b_, c: col, a: a || 'left' }, extra || {}));
    const LH = 1.18;
    const baseline = (top, size) => top + 0.86 * size;

    // Sfondo
    R(0, 0, W, H, BRAND.bianco);

    // ---------- testata: riquadro con angoli arrotondati e leggera sfumatura (Filippo 10/10/2026 sera)
    // staccato dal bordo di 1,5 unità; la sfumatura è fatta con riquadri pieni, così esce uguale in anteprima e nel PDF CMYK.
    let hH = 10 * u;
    const iT = 1.5 * u;                     // distacco dal bordo del cartello
    const xB0 = iT, xB1 = W - iT, yB0 = iT, wB = xB1 - xB0;
    const rT = 2.4 * u;                     // raggio degli angoli
    const mescola = (h1, h2, t) => { const a = hexRgb(h1), b2 = hexRgb(h2); return '#' + a.map((v, i) => Math.round(v + (b2[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
    // 10/10/2026 sera (Filippo): sfumatura dal perimetro (più chiaro) verso l'interno (più scuro): riquadri arrotondati
    // concentrici, ognuno un po' più scuro e più interno del precedente; il cuore ha il colore pieno della testata.
    const cChiaro = mescola(tema.medio, '#FFFFFF', 0.1), cScuro = tema.testata;
    const nL = 28, iBanda = prims.length;
    const tPiena = dati.testata === 'piena'; // scelta del cliente: 'sfumata' (perimetro chiaro → centro scuro) o 'piena' (tinta unica)
    for (let k = 0; k < nL; k++) R(xB0, yB0, wB, hH, tPiena ? cScuro : mescola(cChiaro, cScuro, Math.pow(k / (nL - 1), 0.85)), { rx: rT });
    const disponiBanda = () => {
      const maxIn = Math.min(hH * 0.42, 4.6 * u);
      for (let k = 0; k < nL; k++) {
        const p = prims[iBanda + k], ins = maxIn * k / (nL - 1);
        p.x = xB0 + ins; p.y = yB0 + ins; p.w = wB - 2 * ins; p.h = hH - 2 * ins; p.rx = Math.max(0.5 * u, rT - ins * 0.4);
      }
    };
    disponiBanda();
    let xTesto = m + iT;
    if (img.stemma) {
      const lato = hH - 2.6 * u;
      const d = dentro(img.stemma.w, img.stemma.h, lato * 1.6, lato);
      prims.push({ t: 'img', x: m + iT, y: yB0 + (hH - d.h) / 2, w: d.w, h: d.h, img: img.stemma });
      xTesto = m + iT + d.w + 2 * u;
    }
    // blocco a destra: «CARTELLO DI CANTIERE» + riferimento normativo
    const normativa = tipo === 'privato'
      ? 'art. 27, c. 4, D.P.R. 380/2001 · art. 90, c. 7, D.Lgs. 81/2008'
      : 'Circ. Min. LL.PP. n. 1729/UL del 1/6/1990 · art. 90, c. 7, D.Lgs. 81/2008';
    let sEti = 2.5 * u, sNorm = 1.3 * u;
    let wDx = Math.max(mis.larghezza('CARTELLO DI CANTIERE', true, sEti), mis.larghezza(normativa, false, sNorm));
    const ente = (tipo === 'privato' ? nomeComune(c.ente) : pulisci(c.ente)) || (tipo === 'privato' ? 'Comune di …' : 'Stazione appaltante');
    const enteSotto = tipo === 'privato' ? nomeProvincia(c.ente_sotto) : pulisci(c.ente_sotto);
    let wSx = W - m - iT - xTesto - wDx - 3 * u;
    let mostraNorm = true;
    if (wSx < W * 0.4) { mostraNorm = false; sEti = 2.1 * u; wDx = mis.larghezza('CARTELLO DI CANTIERE', true, sEti); wSx = W - m - iT - xTesto - wDx - 3 * u; }
    const fitEnte = adatta(mis, ente.toUpperCase(), true, 3.4 * u, 2.0 * u, wSx, 2, null, 1.12);
    const sSotto = Math.min(1.9 * u, fitEnte.size * 0.6);
    const fitSotto = enteSotto ? adatta(mis, enteSotto, false, sSotto, 1.3 * u, wSx, 1, null, 1.2) : null;
    const hBlocco = fitEnte.h + (fitSotto ? fitSotto.h + 0.4 * u : 0);
    // la testata si allunga se il nome dell'ente va su due righe, così il testo non tocca il bordo arrotondato
    const hNec = Math.max(hBlocco, sEti * 1.1 + (mostraNorm ? sNorm * 1.3 + 0.3 * u : 0)) + 2.6 * u;
    if (hNec > hH) { const dh = hNec - hH; hH = hNec; disponiBanda(); for (let k = iBanda + nL; k < prims.length; k++) { if (prims[k].t === 'img') prims[k].y += dh / 2; } }
    let y = yB0 + (hH - hBlocco) / 2;
    for (const r of fitEnte.righe) { T(xTesto, baseline(y, fitEnte.size), r, fitEnte.size, true, BRAND.bianco); y += fitEnte.size * 1.12; }
    if (fitSotto) { y += 0.4 * u; T(xTesto, baseline(y, fitSotto.size), fitSotto.righe[0], fitSotto.size, false, tema.chiaro); }
    const hDx = sEti * 1.1 + (mostraNorm ? sNorm * 1.3 + 0.3 * u : 0);
    let yDx = yB0 + (hH - hDx) / 2;
    T(W - m - iT, baseline(yDx, sEti), 'CARTELLO DI CANTIERE', sEti, true, BRAND.bianco, 'right');
    if (mostraNorm) { yDx += sEti * 1.1 + 0.3 * u; T(W - m - iT, baseline(yDx, sNorm), normativa, sNorm, false, tema.chiaro, 'right'); }

    // ---------- titolo (oggetto dei lavori) e ubicazione
    y = yB0 + hH + 2.4 * u;
    const oggetto = titoloLavori(c.oggetto) || 'Lavori di …';
    const fitTit = adatta(mis, oggetto, true, 4.6 * u, 2.6 * u, W - 2 * m, 4, null, 1.08);
    if (fitTit.troncato) avvisi.push('L’oggetto dei lavori è molto lungo: è stato ridotto per stare in quattro righe.');
    for (const r of fitTit.righe) { T(m, baseline(y, fitTit.size), r, fitTit.size, true, tema.testo); y += fitTit.size * 1.08; }
    y += 1.4 * u;
    const ubic = [pulisci(c.ubicazione), pulisci(c.catasto)].filter(Boolean).join('  ·  ');
    if (ubic) {
      T(m, baseline(y, 1.35 * u), 'UBICAZIONE DEL CANTIERE', 1.35 * u, true, tema.medio, 'left', { ls: 0.06 });
      y += 1.35 * u * 1.5;
      const fitU = adatta(mis, ubic, false, 2.3 * u, 1.6 * u, W - 2 * m, 2, null, 1.2);
      for (const r of fitU.righe) { T(m, baseline(y, fitU.size), r, fitU.size, false, '#222222'); y += fitU.size * 1.2; }
    }
    y += 1.6 * u;
    R(m, y, W - 2 * m, 0.35 * u, tema.medio);
    y += 0.35 * u + 2.2 * u;
    const yCorpoInizio = y;

    // ---------- piede fisso: marchio, sito, QR (mai modificabile)
    // 10/10/2026 sera (Filippo): frase e sito su UNA sola riga, piede più basso (da 9 a 5,2 unità); marchio e frase più piccoli dei dati:
    // sul cartello devono leggersi bene responsabili, impresa e committente
    const hF = 5.2 * u;
    const yF = H - hF;
    R(0, yF, W, hF, BRAND.bianco, { sfondo: 'piede' });
    R(0, yF, W, 0.3 * u, tema.medio); // riga sopra il piede nel colore scelto (Filippo 09/10/2026)
    const hLogo = 2.8 * u;
    const wLogo = hLogo * LOGO_RAPPORTO;
    prims.push({ t: 'logo', x: m, y: yF + (hF - hLogo) / 2 + 0.15 * u, h: hLogo, w: wLogo });
    const qrLato = hF - 1.2 * u;
    const xQr = W - m - qrLato;
    prims.push({ t: 'qr', x: xQr, y: yF + (hF - qrLato) / 2 + 0.15 * u, size: qrLato });
    const sInq = 0.85 * u;
    T(xQr - 1.0 * u, yF + hF / 2 - 0.05 * u, 'inquadra il QR', sInq, false, BRAND.grigio, 'right');
    T(xQr - 1.0 * u, yF + hF / 2 - 0.05 * u + sInq * 1.3, 'e scopri il servizio', sInq, false, BRAND.grigio, 'right');
    const xT0 = m + wLogo + 2.5 * u;
    const xT1 = xQr - 1.0 * u - mis.larghezza('e scopri il servizio', false, sInq) - 2.5 * u;
    const wT = Math.max(10 * u, xT1 - xT0);
    const frase = (dati.abbonato ? SLOGAN_ABBONATO : SLOGAN) + ' ';
    const fitRiga = adatta(mis, frase + SITO, true, 1.3 * u, 0.8 * u, wT, 1, null, 1.2);
    const sRiga = fitRiga.size;
    const w1 = mis.larghezza(frase, true, sRiga), w2 = mis.larghezza(SITO, true, sRiga);
    const xR = xT0 + Math.max(0, (wT - (w1 + w2)) / 2);
    const yR = baseline(yF + (hF - sRiga * 1.2) / 2 + 0.15 * u, sRiga);
    T(xR, yR, frase.trim(), sRiga, true, BRAND.scuro, 'left');
    T(xR + w1, yR, SITO, sRiga, true, BRAND.accento, 'left');

    // ---------- striscia loghi (facoltativa) sopra il piede
    let yCorpoFine = yF - 2 * u;
    if (loghi.length) {
      // didascalia sopra ogni logo («Impresa esecutrice», «Committente», «Progettista»…), scelta dal cliente (Filippo 07/10/2026)
      const conDidascalie = loghi.some((lg) => pulisci(lg.ruolo));
      const sDid = 1.9 * u;
      const hDid = conDidascalie ? sDid * 1.6 : 0;
      const hL = 7.5 * u + hDid;
      const yL = yF - 1.6 * u - hL;
      R(m, yL - 0.6 * u, W - 2 * m, 0.12 * u, BRAND.bordo);
      const wSlot = (W - 2 * m) / loghi.length;
      loghi.forEach((lg, i) => {
        const ruolo = pulisci(lg.ruolo);
        if (ruolo) {
          const fitD = adatta(mis, ruolo, true, sDid, 1.0 * u, wSlot - 2 * u, 1, null, 1.2);
          T(m + wSlot * i + wSlot / 2, baseline(yL + 0.2 * u, fitD.size), fitD.righe[0], fitD.size, true, tema.testo, 'center');
        }
        const hImg = hL - hDid;
        const d = dentro(lg.w, lg.h, wSlot - 2.4 * u, hImg - 1.2 * u);
        prims.push({ t: 'img', x: m + wSlot * i + (wSlot - d.w) / 2, y: yL + hDid + (hImg - d.h) / 2, w: d.w, h: d.h, img: lg });
      });
      yCorpoFine = yL - 2 * u;
    }

    // ---------- dicitura finale fissa: senza fascia, in nero, stampatello (Filippo 09/10/2026)
    // 10/10/2026 sera (Filippo): carattere più piccolo di quello dei dati (dato meno rilevante): al massimo 1 unità
    {
      const wA = W - 2 * m - 3 * u;
      let fitA = adatta(mis, AVVERTENZA, false, 1.0 * u, 0.8 * u, wA, 1, null, 1.2);
      if (fitA.troncato) fitA = adatta(mis, AVVERTENZA, false, 1.0 * u, 0.8 * u, wA, 2, null, 1.2);
      const passo = fitA.size * 1.2;
      const hA = Math.max(2.4 * u, fitA.righe.length * passo + 1.2 * u);
      const yA = yCorpoFine - hA;
      const y0 = yA + hA / 2 - (fitA.righe.length - 1) * passo / 2 + fitA.size * 0.36;
      fitA.righe.forEach((r, i) => T(W / 2, y0 + i * passo, r, fitA.size, false, BRAND.testo, 'center'));
      yCorpoFine = yA - 2 * u;
    }

    // ---------- corpo: tabella dei dati (+ render)
    const righe = costruisciRighe(dati);
    const hCorpo = Math.max(10 * u, yCorpoFine - yCorpoInizio);
    const wCorpo = W - 2 * m;
    const render = img.render || null;

    // misura una lista di righe a un dato fattore k (dimensioni del testo e spaziature proporzionali)
    const K_MIN = 0.6;
    function misuraTabella(lista, k, wTab) {
      const sEt = 1.6 * u * k, sVal = 2.05 * u * k, pad = 0.85 * u * k;
      const wEt = Math.max(wTab * 0.30, Math.min(wTab * 0.36, 28 * u * k));
      const wVal = wTab - wEt - 1.6 * u;
      const out = [];
      let h = 0;
      for (const r of lista) {
        const le = aCapo(mis, r.etichetta, true, sEt, wEt - 1.2 * u);
        const lv = r.valore ? aCapo(mis, r.valore, r.forte, sVal, wVal) : [];
        while (lv.length < (r.minRighe || 1)) lv.push('');
        const hr = Math.max(le.length * sEt * LH, lv.length * sVal * LH) + 2 * pad;
        out.push({ r, le, lv, hr });
        h += hr;
      }
      return { righe: out, h, sEt, sVal, pad, wEt, wVal };
    }
    function cercaK(lista, wTab, hDisp, kMax) {
      let lo = K_MIN, hi = kMax;
      if (misuraTabella(lista, hi, wTab).h <= hDisp) return hi;
      if (misuraTabella(lista, lo, wTab).h > hDisp) return lo;
      for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (misuraTabella(lista, mid, wTab).h <= hDisp) lo = mid; else hi = mid; }
      return lo;
    }
    // Disegna la tabella; se c'è spazio in avanzo (hDistribuisci) lo distribuisce fra le righe, fino al 60 %.
    function disegnaTabella(x, y0, wTab, mt, hMax, distribuisci) {
      let extra = 0;
      if (distribuisci && mt.righe.length && mt.h < hMax) extra = Math.min((hMax - mt.h) * 0.6 / mt.righe.length, mt.pad * 1.6);
      let yy = y0;
      for (const { r, le, lv, hr } of mt.righe) {
        const hRiga = hr + extra;
        if (yy + hRiga > y0 + hMax + 0.01) { avvisi.push('Troppi dati per il formato scelto: le ultime righe non entrano. Riduci i testi o scegli un formato più grande.'); break; }
        let ye = yy + mt.pad + extra / 2;
        for (const l of le) { T(x, baseline(ye, mt.sEt), l, mt.sEt, true, tema.testo); ye += mt.sEt * LH; }
        let yv = yy + mt.pad + extra / 2;
        for (const l of lv) { if (l) T(x + mt.wEt, baseline(yv, mt.sVal), l, mt.sVal, !!r.forte, BRAND.testo); yv += mt.sVal * LH; }
        yy += hRiga;
        prims.push({ t: 'line', x1: x, y1: yy, x2: x + wTab, y2: yy, c: BRAND.bordo, lw: 0.12 * u });
      }
      return yy - y0;
    }
    function riquadroRender(xR, yR, wR, hR) {
      const d = dentro(render.w, render.h, wR, hR);
      const x = xR + (wR - d.w) / 2, y = yR + (hR - d.h) / 2;
      R(x, y, d.w, d.h, null, { s: BRAND.bordo, lw: 0.15 * u });
      prims.push({ t: 'img', x, y, w: d.w, h: d.h, img: render });
    }

    // due colonne affiancate dentro (x, wTot): si prova lo spartiacque che bilancia meglio le altezze
    function dueColonne(x, y0, wTot, hDisp, kMax) {
      const gap = 4 * u;
      const wCol = (wTot - gap) / 2;
      const mtTutte = misuraTabella(righe, 1, wCol);
      let acc = 0, taglio = righe.length;
      for (let i = 0; i < mtTutte.righe.length; i++) { acc += mtTutte.righe[i].hr; if (acc >= mtTutte.h / 2) { taglio = i + 1; break; } }
      let migliore = null;
      for (let t = Math.max(1, taglio - 2); t <= Math.min(righe.length - 1, taglio + 2); t++) {
        const hA = misuraTabella(righe.slice(0, t), 1, wCol).h, hB = misuraTabella(righe.slice(t), 1, wCol).h;
        const costo = Math.max(hA, hB);
        if (!migliore || costo < migliore.costo) migliore = { t, costo };
      }
      taglio = migliore ? migliore.t : taglio;
      const colA = righe.slice(0, taglio), colB = righe.slice(taglio);
      const kk = Math.min(cercaK(colA, wCol, hDisp, kMax), colB.length ? cercaK(colB, wCol, hDisp, kMax) : kMax);
      disegnaTabella(x, y0, wCol, misuraTabella(colA, kk, wCol), hDisp, true);
      if (colB.length) disegnaTabella(x + wCol + gap, y0, wCol, misuraTabella(colB, kk, wCol), hDisp, true);
      prims.push({ t: 'line', x1: x + wCol + gap / 2, y1: y0, x2: x + wCol + gap / 2, y2: y0 + hDisp, c: BRAND.bordo, lw: 0.12 * u });
      return kk;
    }

    let k = 1;
    if (righe.every((r) => r.fisso)) {
      T(m, baseline(yCorpoInizio, 2 * u), 'Compila i dati del cantiere: compariranno qui.', 2 * u, false, BRAND.grigio);
      if (render) riquadroRender(m, yCorpoInizio + 4 * u, wCorpo, hCorpo - 4 * u);
    } else if (render && orizzontale) {
      // render a destra; a sinistra una o due colonne di dati
      const wTab = wCorpo * (righe.length >= 8 ? 0.64 : 0.56);
      const xR = m + wTab + 3 * u;
      const wR = W - m - xR;
      if (righe.length >= 8) k = dueColonne(m, yCorpoInizio, wTab, hCorpo, 1.0);
      else { k = cercaK(righe, wTab, hCorpo, 1.0); disegnaTabella(m, yCorpoInizio, wTab, misuraTabella(righe, k, wTab), hCorpo); }
      riquadroRender(xR, yCorpoInizio, wR, hCorpo);
    } else if (render) {
      // render sotto la tabella: la tabella prende quello che le serve, al render resta almeno il 26 %
      const hRenderMin = Math.max(hCorpo * 0.26, 12 * u);
      const hTabMax = hCorpo - hRenderMin - 2.2 * u;
      const mt1 = misuraTabella(righe, 1, wCorpo);
      let hTab;
      if (mt1.h <= hTabMax) { hTab = mt1.h; }
      else { k = cercaK(righe, wCorpo, hTabMax, 1.0); hTab = Math.min(misuraTabella(righe, k, wCorpo).h, hTabMax); }
      disegnaTabella(m, yCorpoInizio, wCorpo, misuraTabella(righe, k, wCorpo), hTab + 0.01);
      const yR = yCorpoInizio + hTab + 2.2 * u;
      const hR = yCorpoInizio + hCorpo - yR;
      if (hR > 6 * u) riquadroRender(m, yR, wCorpo, hR);
      else avvisi.push('Non resta spazio per il render: riduci i testi o scegli un formato più alto.');
    } else if (orizzontale && righe.length >= 8) {
      k = dueColonne(m, yCorpoInizio, wCorpo, hCorpo, 1.4);
    } else {
      k = cercaK(righe, wCorpo, hCorpo, 1.6);
      disegnaTabella(m, yCorpoInizio, wCorpo, misuraTabella(righe, k, wCorpo), hCorpo, true);
    }
    if (k <= K_MIN + 0.001 && !avvisi.some((a) => a.startsWith('Troppi dati'))) avvisi.push('Il testo è stato ridotto al minimo per far entrare tutti i dati: valuta un formato più grande o testi più brevi.');

    return { W, H, b, u, prims, avvisi, k, formato, orizzontale, tipo, immagini: img, tema };
  }

  // ------------------------------------------------------------------ anteprima SVG
  function escXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function svg(esito, ris, opz) {
    opz = opz || {};
    const { W, H, b, prims } = esito;
    const bb = opz.mostraAbbondanza ? b : 0;
    const vb = `${-bb} ${-bb} ${W + 2 * bb} ${H + 2 * bb}`;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="100%" style="display:block;max-width:100%;height:auto;background:#fff" font-family="Roboto, Arial, Helvetica, sans-serif">`;
    s += `<defs><symbol id="igl-logo" viewBox="0 0 317.78 100">${ris.logoSvgInterno}</symbol></defs>`;
    if (bb) s += `<rect x="${-bb}" y="${-bb}" width="${W + 2 * bb}" height="${H + 2 * bb}" fill="#e9eeec"/>`;
    for (const p of prims) {
      if (p.t === 'rect') {
        let x = p.x, y = p.y, w = p.w, h = p.h;
        if (bb && p.sfondo === 'testata') { x = -bb; y = -bb; w = W + 2 * bb; h = p.h + bb; }
        if (bb && p.sfondo === 'piede') { x = -bb; w = W + 2 * bb; h = p.h + bb; }
        if (bb && p.x === 0 && p.y === 0 && p.w === W && p.h === H) { x = -bb; y = -bb; w = W + 2 * bb; h = H + 2 * bb; }
        s += `<rect x="${x}" y="${y}" width="${w}" height="${h}"${p.rx ? ` rx="${p.rx}"` : ''} fill="${p.f || 'none'}"${p.s ? ` stroke="${p.s}" stroke-width="${p.lw || 1}"` : ''}/>`;
      } else if (p.t === 'line') {
        s += `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${p.c}" stroke-width="${p.lw}"/>`;
      } else if (p.t === 'text') {
        const anchor = p.a === 'center' ? 'middle' : (p.a === 'right' ? 'end' : 'start');
        s += `<text x="${p.x}" y="${p.y}" font-size="${p.size}" font-weight="${p.b ? 700 : 400}" fill="${p.c}" text-anchor="${anchor}"${p.ls ? ` letter-spacing="${p.ls * p.size}"` : ''}>${escXml(p.s)}</text>`;
      } else if (p.t === 'img') {
        s += `<image href="${opz.usaMini && p.img.mini ? p.img.mini : p.img.src}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" preserveAspectRatio="xMidYMid meet"/>`;
      } else if (p.t === 'logo') {
        s += `<use href="#igl-logo" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/>`;
      } else if (p.t === 'qr') {
        s += qrSvg(ris.qr, p.x, p.y, p.size);
      }
    }
    if (opz.filigrana) s += filigranaSvg(W, H);
    if (bb) {
      // linea di taglio (formato finito) sopra l'abbondanza
      s += `<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#0A7D48" stroke-width="${esito.u * 0.15}" stroke-dasharray="${esito.u} ${esito.u * 0.6}"/>`;
    }
    s += '</svg>';
    return s;
  }

  function qrSvg(qr, x, y, size) {
    const n = qr.n, mod = size / n;
    let d = '';
    for (let r = 0; r < n; r++) {
      const row = qr.rows[r];
      let c = 0;
      while (c < n) {
        if (row[c] === '1') { let c2 = c; while (c2 < n && row[c2] === '1') c2++; d += `M${x + c * mod} ${y + r * mod}h${(c2 - c) * mod}v${mod}h${-(c2 - c) * mod}z`; c = c2; }
        else c++;
      }
    }
    return `<rect x="${x - mod * 2}" y="${y - mod * 2}" width="${size + mod * 4}" height="${size + mod * 4}" fill="#fff"/><path d="${d}" fill="#000"/>`;
  }

  function filigranaSvg(W, H) {
    const testo = 'ANTEPRIMA · NON VALIDA PER LA STAMPA · www.ilgiornalelavori.it';
    const size = Math.min(W, H) / 22;
    let s = '<g opacity="0.14" fill="#052A21" font-weight="700">';
    const passo = size * 5;
    for (let yy = -H; yy < H * 2; yy += passo) {
      s += `<text x="${W / 2}" y="${yy}" font-size="${size}" text-anchor="middle" transform="rotate(-30 ${W / 2} ${H / 2})">${testo}</text>`;
    }
    s += '</g>';
    return s;
  }

  // ------------------------------------------------------------------ PDF (jsPDF)
  function ptDaMm(mm) { return mm * 72 / 25.4; }

  function registraFont(doc, font) {
    doc.addFileToVFS('Roboto-Regular.ttf', font.regolare);
    doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
    doc.addFileToVFS('Roboto-Bold.ttf', font.grassetto);
    doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
  }

  function creaMisuratore(jsPDFctor, font) {
    const doc = new jsPDFctor({ unit: 'mm', format: 'a4' });
    registraFont(doc, font);
    const cache = new Map();
    return {
      larghezza(testo, b, size) {
        const chiave = (b ? 'B' : 'R') + '|' + testo;
        let w1 = cache.get(chiave);
        if (w1 === undefined) {
          doc.setFont('Roboto', b ? 'bold' : 'normal');
          doc.setFontSize(100);
          w1 = doc.getTextWidth(testo) / 100; // mm per mm di dimensione
          cache.set(chiave, w1);
        }
        return w1 * ptDaMm(size); // w1 = mm di larghezza per punto di dimensione
      }
    };
  }

  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  // opz: { filigrana, cmyk, stampa (modulo CartelloStampa), fontOT: {regolare, grassetto} (opentype.js → testi in tracciati),
  //        immaginiCmyk: Map(img → Uint8Array JPEG CMYK), titolo }
  function pdf(esito, jsPDFctor, ris, opz) {
    opz = opz || {};
    const { W, H, b, prims } = esito;
    const pw = W + 2 * b, ph = H + 2 * b;
    const cmyk = !!(opz.cmyk && opz.stampa);
    const tracciati = !!(opz.fontOT && opz.stampa);
    const doc = new jsPDFctor({ unit: 'mm', format: [pw, ph], orientation: pw >= ph ? 'l' : 'p', compress: true, putOnlyUsedFonts: true, floatPrecision: 3 });
    if (!tracciati) registraFont(doc, ris.font);
    const titolo = opz.titolo || `Cartello di cantiere ${esito.formato.nome.replace(/\u00d7/g, 'x')} - Il Giornale Lavori`;
    doc.setProperties({ title: titolo, subject: 'Cartello di cantiere', creator: 'Il Giornale Lavori — www.ilgiornalelavori.it', author: 'Il Giornale Lavori' });
    if (typeof doc.setFileId === 'function') doc.setFileId(Array.from({ length: 32 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join(''));
    // riquadri di pagina: TrimBox = formato finito, BleedBox = foglio con abbondanza (in punti)
    try {
      const k = 72 / 25.4;
      const ctx = doc.getPageInfo(1).pageContext;
      ctx.trimBox = { bottomLeftX: b * k, bottomLeftY: b * k, topRightX: (W + b) * k, topRightY: (H + b) * k };
      if (b > 0) ctx.bleedBox = { bottomLeftX: 0, bottomLeftY: 0, topRightX: pw * k, topRightY: ph * k };
    } catch (e) { /* riquadri facoltativi */ }
    const ox = b, oy = b;
    const colore = (hex, metodo) => {
      if (cmyk) { const c = opz.stampa.cmykDaHex(hex); doc[metodo](c[0], c[1], c[2], c[3]); }
      else { const [r, g, bl] = hexRgb(hex); doc[metodo](r, g, bl); }
    };
    const fill = (hex) => colore(hex, 'setFillColor');
    const stroke = (hex) => colore(hex, 'setDrawColor');
    const testo = (p, x, y) => {
      if (tracciati) {
        const font = p.b ? opz.fontOT.grassetto : opz.fontOT.regolare;
        const linee = opz.stampa.tracciatoTesto(font, p.s, x, y, p.size, p.a, p.ls || 0);
        if (linee.length === 0) return;
        fill(p.c); doc.path(linee); doc.fill();
      } else {
        doc.setFont('Roboto', p.b ? 'bold' : 'normal');
        doc.setFontSize(ptDaMm(p.size));
        colore(p.c, 'setTextColor');
        const o = { align: p.a === 'left' ? 'left' : p.a };
        if (p.ls) o.charSpace = p.ls * p.size;
        doc.text(p.s, x, y, o);
      }
    };

    for (const p of prims) {
      if (p.t === 'rect') {
        let x = p.x, y = p.y, w = p.w, h = p.h;
        if (b && p.sfondo === 'testata') { x = -b; y = -b; w = W + 2 * b; h = p.h + b; }
        if (b && p.sfondo === 'piede') { x = -b; w = W + 2 * b; h = p.h + b; }
        if (b && p.x === 0 && p.y === 0 && p.w === W && p.h === H) { x = -b; y = -b; w = W + 2 * b; h = H + 2 * b; }
        if (p.f) fill(p.f);
        if (p.s) { stroke(p.s); doc.setLineWidth(p.lw || 0.3); }
        const stile = p.f && p.s ? 'FD' : (p.f ? 'F' : 'S');
        if (p.rx) doc.roundedRect(ox + x, oy + y, w, h, p.rx, p.rx, stile); else doc.rect(ox + x, oy + y, w, h, stile);
      } else if (p.t === 'line') {
        stroke(p.c); doc.setLineWidth(p.lw); doc.line(ox + p.x1, oy + p.y1, ox + p.x2, oy + p.y2);
      } else if (p.t === 'text') {
        testo(p, ox + p.x, oy + p.y);
      } else if (p.t === 'img') {
        const jpegCmyk = cmyk && opz.immaginiCmyk ? opz.immaginiCmyk.get(p.img) : null;
        if (jpegCmyk) doc.addImage(jpegCmyk, 'JPEG', ox + p.x, oy + p.y, p.w, p.h, undefined, 'FAST');
        else doc.addImage(p.img.src, p.img.tipo || 'JPEG', ox + p.x, oy + p.y, p.w, p.h, undefined, 'FAST');
      } else if (p.t === 'logo') {
        disegnaLogoPdf(doc, ris.logoTracciati, ox + p.x, oy + p.y, p.h, fill);
      } else if (p.t === 'qr') {
        const n = ris.qr.n, mod = p.size / n;
        fill('#FFFFFF'); doc.rect(ox + p.x - 2 * mod, oy + p.y - 2 * mod, p.size + 4 * mod, p.size + 4 * mod, 'F');
        fill('#000000');
        for (let r = 0; r < n; r++) {
          const row = ris.qr.rows[r];
          let c = 0;
          while (c < n) {
            if (row[c] === '1') { let c2 = c; while (c2 < n && row[c2] === '1') c2++; doc.rect(ox + p.x + c * mod, oy + p.y + r * mod, (c2 - c) * mod, mod, 'F'); c = c2; }
            else c++;
          }
        }
      }
    }

    if (opz.filigrana) {
      const t = 'ANTEPRIMA · NON VALIDA PER LA STAMPA · www.ilgiornalelavori.it';
      const size = Math.min(W, H) / 22;
      doc.saveGraphicsState();
      doc.setGState(new doc.GState({ opacity: 0.14 }));
      const passo = size * 5;
      if (tracciati) {
        // scritte inclinate come tracciati: rotazione di 30° attorno al punto di ancoraggio
        const ang = -30 * Math.PI / 180, cs = Math.cos(ang), sn = Math.sin(ang);
        for (let yy = -H; yy < H * 2; yy += passo) {
          const cx = ox + W / 2, cy = oy + yy;
          const linee = opz.stampa.tracciatoTesto(opz.fontOT.grassetto, t, 0, 0, size, 'center', 0).map((c) => {
            const r = (x, y) => [cx + x * cs - y * sn, cy + x * sn + y * cs];
            if (c.op === 'h') return c;
            if (c.op === 'c') return { op: 'c', c: [...r(c.c[0], c.c[1]), ...r(c.c[2], c.c[3]), ...r(c.c[4], c.c[5])] };
            return { op: c.op, c: r(c.c[0], c.c[1]) };
          });
          fill('#052A21'); doc.path(linee); doc.fill();
        }
      } else {
        doc.setFont('Roboto', 'bold'); doc.setFontSize(ptDaMm(size)); colore('#052A21', 'setTextColor');
        for (let yy = -H; yy < H * 2; yy += passo) doc.text(t, ox + W / 2, oy + yy, { align: 'center', angle: 30 });
      }
      doc.restoreGraphicsState();
    }

    if (b > 0) {
      // crocini di taglio nell'abbondanza (in quadricromia piena, così escono su ogni lastra)
      if (cmyk) doc.setDrawColor(1, 1, 1, 1); else stroke('#000000');
      doc.setLineWidth(0.25);
      const L = Math.min(b * 0.8, 8), g = Math.min(b * 0.15, 2);
      const angoli = [[0, 0, -1, -1], [W, 0, 1, -1], [0, H, -1, 1], [W, H, 1, 1]];
      for (const [cx, cy, dx, dy] of angoli) {
        doc.line(ox + cx + dx * g, oy + cy, ox + cx + dx * (g + L), oy + cy);
        doc.line(ox + cx, oy + cy + dy * g, ox + cx, oy + cy + dy * (g + L));
      }
    }
    return doc;
  }

  // Immagini del cartello → JPEG CMYK (una volta sola per immagine). leggiPixel(img) → {larghezza, altezza, banda(y0, n)}
  async function preparaImmaginiCmyk(esito, stampa, leggiPixel, avanzamento) {
    const mappa = new Map();
    const imgs = esito.prims.filter((p) => p.t === 'img').map((p) => p.img);
    const uniche = Array.from(new Set(imgs));
    for (let i = 0; i < uniche.length; i++) {
      const img = uniche[i];
      const sfondo = img === ((esito.immagini || {}).stemma) ? hexRgb((esito.tema || TEMI.verde).testata) : [255, 255, 255];
      const sorgente = await leggiPixel(img);
      const jpeg = await stampa.codificaJpegCmyk(sorgente, 88, sfondo, (f) => avanzamento && avanzamento((i + f) / uniche.length));
      mappa.set(img, jpeg);
    }
    return mappa;
  }

  // Marchio Il Giornale Lavori in tracciati vettoriali (coordinate 0..317.78 × 0..100).
  function disegnaLogoPdf(doc, tracciati, x, y, h, fill) {
    const s = h / 100;
    for (const tr of tracciati) {
      fill(tr.fill);
      if (tr.rect) { doc.roundedRect(x + tr.rect[0] * s, y + tr.rect[1] * s, tr.rect[2] * s, tr.rect[3] * s, tr.rect[4] * s, tr.rect[4] * s, 'F'); continue; }
      const linee = tr.cmds.map((c) => {
        if (c[0] === 'm') return { op: 'm', c: [x + c[1] * s, y + c[2] * s] };
        if (c[0] === 'l') return { op: 'l', c: [x + c[1] * s, y + c[2] * s] };
        if (c[0] === 'c') return { op: 'c', c: [x + c[1] * s, y + c[2] * s, x + c[3] * s, y + c[4] * s, x + c[5] * s, y + c[6] * s] };
        return { op: 'h' };
      });
      doc.path(linee);
      if (tr.rule === 'evenodd') doc.fillEvenOdd(); else doc.fill();
    }
  }

  return { BRAND, QUALIFICHE, TEMI, controllaMisura, codiceFormato, MISURA_MIN, MISURA_MAX, FORMATI, IMPIANTI, CAMPI, nomeComune, nomeProvincia, titoloLavori, TITOLI_ABILITATIVI, ORDINE_RIGHE, SITO, SLOGAN, SLOGAN_ABBONATO, LOGO_RAPPORTO, costruisciRighe, impagina, svg, pdf, preparaImmaginiCmyk, creaMisuratore, registraFont, dimensioni, pulisci, perTipo };
});
