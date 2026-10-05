// Collaudo offline del PDF/X-1a: testi in tracciati, immagini CMYK, OutputIntent, xref ricostruita.
const fs = require('fs');
const path = require('path');
const { jsPDF } = require('../nodework/node_modules/jspdf/dist/jspdf.umd.min.js');
const opentype = require('../nodework/node_modules/opentype.js');
const M = require('../src/motore.js');
const S = require('../src/stampa.js');

const BASE = path.join(__dirname, '..');
const ris = JSON.parse(fs.readFileSync(path.join(BASE, 'risorse.json'), 'utf8'));
const imgs = JSON.parse(fs.readFileSync(path.join(__dirname, 'immagini.json'), 'utf8'));
const pixel = JSON.parse(fs.readFileSync(path.join(__dirname, 'pixel.json'), 'utf8')); // {render:{w,h,file}, stemma:…, loghi:[…]}
const mis = M.creaMisuratore(jsPDF, ris.font);
const b64ab = (b64) => { const buf = Buffer.from(b64, 'base64'); return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); };
const fontOT = { regolare: opentype.parse(b64ab(ris.font.regolare)), grassetto: opentype.parse(b64ab(ris.font.grassetto)) };

function sorgenteDaFile(info) {
  const raw = fs.readFileSync(path.join(__dirname, info.file));
  return { larghezza: info.w, altezza: info.h, banda(y0, n) { return new Uint8ClampedArray(raw.buffer, raw.byteOffset + y0 * info.w * 4, n * info.w * 4); } };
}
const pixelDi = new Map([[imgs.render, pixel.render], [imgs.stemma, pixel.stemma]]);
imgs.loghi.forEach((l, i) => pixelDi.set(l, pixel.loghi[i]));

const privato = JSON.parse(fs.readFileSync(path.join(__dirname, 'dati_privato.json'), 'utf8'));

(async () => {
  const casi = [
    { nome: 'x1a-privato-200x300-verticale-render', dati: { ...privato, formato: '200x300', orientamento: 'verticale', abbondanza: 10, immagini: { render: imgs.render, loghi: imgs.loghi, stemma: imgs.stemma } } },
    { nome: 'x1a-privato-100x100-senza', dati: { ...privato, formato: '100x100', orientamento: 'verticale', abbondanza: 0, immagini: {} } },
  ];
  for (const c of casi) {
    const t0 = Date.now();
    const esito = M.impagina(c.dati, mis);
    const mappa = await M.preparaImmaginiCmyk(esito, S, async (img) => sorgenteDaFile(pixelDi.get(img)), null);
    const t1 = Date.now();
    const doc = M.pdf(esito, jsPDF, ris, { cmyk: true, stampa: S, fontOT, immaginiCmyk: mappa, filigrana: c.nome.includes('filigrana') });
    const src = doc.output();
    const u8 = S.completaPdfX1a(src, { titolo: `Cartello di cantiere ${esito.formato.nome}` });
    fs.writeFileSync(path.join(BASE, 'out', c.nome + '.pdf'), Buffer.from(u8));
    console.log(`${c.nome}: ${u8.length} byte, immagini ${mappa.size} (${t1 - t0} ms), pdf ${Date.now() - t1} ms`);
  }
})();

// anteprima con filigrana (tracciati, RGB, non X-1a) e caso orizzontale con render
(async () => {
  await new Promise((ok) => setTimeout(ok, 1500));
  const esito = M.impagina({ ...privato, formato: '100x200', orientamento: 'orizzontale', abbondanza: 5, immagini: { render: imgs.render, loghi: imgs.loghi.slice(0, 2), stemma: imgs.stemma } }, mis);
  const doc = M.pdf(esito, jsPDF, ris, { stampa: S, fontOT, filigrana: true });
  fs.writeFileSync(path.join(BASE, 'out', 'anteprima-tracciati-filigrana.pdf'), Buffer.from(doc.output('arraybuffer')));
  const mappa = await M.preparaImmaginiCmyk(esito, S, async (img) => sorgenteDaFile(pixelDi.get(img)), null);
  const doc2 = M.pdf(esito, jsPDF, ris, { cmyk: true, stampa: S, fontOT, immaginiCmyk: mappa });
  fs.writeFileSync(path.join(BASE, 'out', 'x1a-privato-100x200-orizzontale.pdf'), Buffer.from(S.completaPdfX1a(doc2.output(), { titolo: 'Cartello 100x200' })));
  console.log('anteprima e orizzontale ok');
})();
