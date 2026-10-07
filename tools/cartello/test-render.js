// Collaudo offline del motore: genera i PDF (e gli SVG) dei casi di prova.
// uso: node test/render.js [filtro]
const fs = require('fs');
const path = require('path');
const { jsPDF } = require('../nodework/node_modules/jspdf/dist/jspdf.node.min.js');
const M = require('../src/motore.js');

const BASE = path.join(__dirname, '..');
const ris = JSON.parse(fs.readFileSync(path.join(BASE, 'risorse.json'), 'utf8'));
const imgs = JSON.parse(fs.readFileSync(path.join(__dirname, 'immagini.json'), 'utf8'));
const mis = M.creaMisuratore(jsPDF, ris.font);

const privato = {
  tipo: 'privato',
  campi: {
    ente: 'Comune di Vigonza', ente_sotto: 'Provincia di Padova',
    oggetto: 'Lavori di ristrutturazione edilizia con ampliamento e adeguamento sismico di fabbricato residenziale bifamiliare',
    ubicazione: 'Via Roma 12 — Vigonza (PD)', catasto: 'Fg. 5, Mapp. 123, Sub. 2',
    titolo_tipo: 'pdc', titolo_estremi: 'n. 45/2026 del 12/03/2026 — prot. 18422',
    titolo_altri: 'Autorizzazione paesaggistica n. 12/2026 del 02/02/2026\nDeposito sismico prot. 1234 del 20/02/2026 (Regione Veneto)',
    notifica: 'prot. 55432 del 01/10/2026 (ASL 6 Euganea — ITL Padova)',
    committente: 'Mario Rossi — Via Verdi 3, Padova',
    progettista: 'arch. Luca Verdi — Ordine Architetti PPC Padova n. 1234',
    progettista_strutture: 'ing. Paolo Neri — Ordine Ingegneri Padova n. 5678',
    progettista_impianti: 'per. ind. Marco Blu',
    direttore_lavori: 'arch. Luca Verdi', dl_strutture: 'ing. Paolo Neri',
    csp: 'geom. Sara Gialli', cse: 'geom. Sara Gialli', responsabile_lavori: '',
    collaudatore: 'ing. Carla Viola (collaudo statico)',
    altri_tecnici: 'geol. Franco Terra (relazione geologica)\ning. Elena Sole (certificazione energetica)',
    impresa: 'Rossi Costruzioni S.r.l. — Via dell’Industria 8, 35100 Padova — P.IVA 01234567890',
    direttore_cantiere: 'geom. Andrea Rossi', capocantiere: 'Giovanni Bianchi',
    subappaltatori: 'Impianti Bianchi S.n.c. — impianti elettrici\nIdraulica Verdi S.r.l. — impianti idrico-sanitari\nPonteggi Alfa S.r.l. — montaggio ponteggi',
    data_inizio: '15/10/2026', data_fine: '30/06/2027',
    avvertenze: ''
  }
};
const pubblico = {
  tipo: 'pubblico',
  campi: {
    ente: 'Comune di Padova', ente_sotto: 'Settore Lavori Pubblici e Infrastrutture',
    oggetto: 'Riqualificazione energetica e adeguamento sismico della scuola primaria «G. Pascoli»',
    ubicazione: 'Via Pascoli 4 — Padova (PD)', catasto: '',
    cup: 'H71B23000000001', cig: 'A0123456789',
    importo_progetto: '€ 1.250.000,00', importo_lavori: '€ 980.000,00', oneri_sicurezza: '€ 32.000,00',
    importo_contratto: '€ 871.250,00 (ribasso del 12,35 %)',
    finanziamento: 'PNRR — Missione 2, Componente 3, Investimento 1.1 · Fondi di bilancio comunale',
    contratto: 'Rep. n. 1234 del 10/01/2026',
    notifica: 'prot. 55432 del 01/10/2026',
    committente: '', rup: 'ing. Anna Bianchi',
    progettista: 'RTP arch. Luca Verdi (capogruppo) — ing. Paolo Neri — per. ind. Marco Blu',
    progettista_strutture: '', progettista_impianti: '',
    direttore_lavori: 'ing. Giulia Rossi — Ufficio Tecnico Comunale', dl_strutture: '',
    csp: 'arch. Sara Gialli', cse: 'arch. Sara Gialli', responsabile_lavori: 'ing. Anna Bianchi',
    collaudatore: 'ing. Carla Viola (collaudo tecnico-amministrativo e statico)',
    altri_tecnici: '',
    impresa: 'Costruzioni Alfa S.p.A. — Via Industria 1, 35010 Vigonza (PD) — P.IVA 09876543210 — SOA OG1 cl. IV',
    direttore_cantiere: 'geom. Andrea Rossi', capocantiere: '',
    subappaltatori: 'Impianti Beta S.r.l. — OS30 impianti elettrici\nTermoidraulica Gamma S.r.l. — OS28 impianti termici',
    data_inizio: '15/10/2026', tempo_utile: '365 giorni naturali e consecutivi', data_fine: '14/10/2027',
    avvertenze: ''
  }
};

const casi = [];
for (const f of M.FORMATI) {
  for (const o of ['verticale', 'orizzontale']) {
    if (f.id === '100x100' && o === 'orizzontale') continue;
    casi.push({ nome: `privato-${f.id}-${o}-render`, dati: { ...privato, formato: f.id, orientamento: o, abbondanza: 10, immagini: { render: imgs.render, loghi: imgs.loghi, stemma: imgs.stemma } } });
    casi.push({ nome: `pubblico-${f.id}-${o}-norender`, dati: { ...pubblico, formato: f.id, orientamento: o, abbondanza: 0, immagini: { loghi: imgs.loghi.slice(0, 2) } } });
  }
}
casi.push({ nome: 'privato-200x300-verticale-minimo', dati: { tipo: 'privato', formato: '200x300', orientamento: 'verticale', abbondanza: 0, campi: { ente: 'Comune di Vigonza', oggetto: 'Lavori di manutenzione straordinaria', ubicazione: 'Via Roma 12 — Vigonza (PD)', titolo_tipo: 'cila', titolo_estremi: 'prot. 1 del 01/01/2026', committente: 'Mario Rossi', direttore_lavori: 'geom. X', impresa: 'Ditta Y' }, immagini: {} } });

const filtro = process.argv[2] || '';
let n = 0;
for (const c of casi) {
  if (filtro && !c.nome.includes(filtro)) continue;
  const t0 = Date.now();
  const esito = M.impagina(c.dati, mis);
  const doc = M.pdf(esito, jsPDF, ris, { filigrana: c.nome.includes('minimo') });
  const buf = Buffer.from(doc.output('arraybuffer'));
  fs.writeFileSync(path.join(BASE, 'out', c.nome + '.pdf'), buf);
  fs.writeFileSync(path.join(BASE, 'out', c.nome + '.svg'), M.svg(esito, ris, { mostraAbbondanza: true, filigrana: c.nome.includes('minimo') }));
  console.log(`${c.nome}: ${esito.W}×${esito.H} mm, k=${esito.k.toFixed(2)}, ${buf.length} byte, ${Date.now() - t0} ms${esito.avvisi.length ? ' | ' + esito.avvisi.join(' | ') : ''}`);
  n++;
}
console.log(n, 'casi');
