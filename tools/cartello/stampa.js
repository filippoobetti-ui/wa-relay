// Cartello di cantiere — Il Giornale Lavori
// Strumenti per il file di stampa PDF/X-1a:2001: conversione in CMYK, codifica JPEG a quattro componenti
// (convenzione Adobe, valori invertiti + Decode [1 0 1 0 1 0 1 0] di jsPDF), testi in tracciati (opentype.js)
// e completamento del PDF prodotto da jsPDF (Info, OutputIntent, tabella xref ricostruita).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CartelloStampa = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ colori
  // Quadricromia del marchio e dei neutri; gli altri esadecimali passano dalla conversione semplice.
  const CMYK_MARCHIO = {
    '#052A21': [0.90, 0.55, 0.70, 0.70],
    '#0A7D48': [0.85, 0.15, 0.80, 0.20],
    '#12B764': [0.75, 0.00, 0.75, 0.00],
    '#A11C1C': [0.20, 1.00, 1.00, 0.15],
    '#CFE3D8': [0.18, 0.02, 0.12, 0.00],
    '#D5DCD8': [0.00, 0.00, 0.00, 0.15],
    '#111111': [0.00, 0.00, 0.00, 1.00],
    '#222222': [0.00, 0.00, 0.00, 0.95],
    '#555555': [0.00, 0.00, 0.00, 0.70],
    '#000000': [0.00, 0.00, 0.00, 1.00],
    '#FFFFFF': [0.00, 0.00, 0.00, 0.00]
  };
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function cmykDaRgb(r, g, b) {
    const R = r / 255, G = g / 255, B = b / 255;
    const k = 1 - Math.max(R, G, B);
    if (k >= 0.999) return [0, 0, 0, 1];
    return [(1 - R - k) / (1 - k), (1 - G - k) / (1 - k), (1 - B - k) / (1 - k), k];
  }
  function cmykDaHex(hex) {
    const h = String(hex).toUpperCase();
    if (CMYK_MARCHIO[h]) return CMYK_MARCHIO[h];
    const [r, g, b] = hexRgb(h);
    return cmykDaRgb(r, g, b).map((v) => Math.round(v * 1000) / 1000);
  }

  // ------------------------------------------------------------------ JPEG CMYK (baseline, 4 componenti, marker Adobe)
  const ZIGZAG = [0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
    10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63];
  const QT_LUMA = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
  const DC_NR = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const DC_VAL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const AC_NR = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
  const AC_VAL = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];

  function tabellaHuffman(nr, val) {
    const ht = []; let codice = 0, pos = 0;
    for (let k = 1; k <= 16; k++) {
      for (let j = 1; j <= nr[k]; j++) { ht[val[pos]] = [codice, k]; pos++; codice++; }
      codice *= 2;
    }
    return ht;
  }

  // sorgente: { larghezza, altezza, banda(y0, n) → Uint8ClampedArray RGBA (n righe) }
  // sfondo: colore RGB su cui appiattire l'eventuale trasparenza. qualita: 1–100.
  async function codificaJpegCmyk(sorgente, qualita, sfondo, avanzamento) {
    const W = sorgente.larghezza, H = sorgente.altezza;
    const q = Math.max(1, Math.min(100, qualita || 85));
    const sf = q < 50 ? Math.floor(5000 / q) : Math.floor(200 - q * 2);
    const YT = new Array(64), fdt = new Float32Array(64);
    for (let i = 0; i < 64; i++) { let t = Math.floor((QT_LUMA[i] * sf + 50) / 100); if (t < 1) t = 1; else if (t > 255) t = 255; YT[ZIGZAG[i]] = t; }
    const aasf = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];
    for (let r = 0, k = 0; r < 8; r++) for (let c = 0; c < 8; c++, k++) fdt[k] = 1.0 / (YT[ZIGZAG[k]] * aasf[r] * aasf[c] * 8.0);
    const HTDC = tabellaHuffman(DC_NR, DC_VAL), HTAC = tabellaHuffman(AC_NR, AC_VAL);
    const categoria = new Uint8Array(65535), bitcode = new Array(65535);
    for (let cat = 1, lo = 1, hi = 2; cat <= 15; cat++, lo <<= 1, hi <<= 1) {
      for (let n = lo; n < hi; n++) { categoria[32767 + n] = cat; bitcode[32767 + n] = [n, cat]; }
      for (let n = -(hi - 1); n <= -lo; n++) { categoria[32767 + n] = cat; bitcode[32767 + n] = [hi - 1 + n, cat]; }
    }

    // uscita a blocchi
    const pezzi = []; let buf = new Uint8Array(1 << 16), pos = 0;
    const byte = (b) => { if (pos === buf.length) { pezzi.push(buf); buf = new Uint8Array(1 << 16); pos = 0; } buf[pos++] = b; };
    const word = (w) => { byte((w >> 8) & 255); byte(w & 255); };
    let bytenew = 0, bytepos = 7;
    function bits(bs) {
      const valore = bs[0]; let p = bs[1] - 1;
      while (p >= 0) {
        if (valore & (1 << p)) bytenew |= (1 << bytepos);
        p--; bytepos--;
        if (bytepos < 0) { if (bytenew === 0xFF) { byte(0xFF); byte(0); } else byte(bytenew); bytepos = 7; bytenew = 0; }
      }
    }

    const dati = new Float32Array(64), DU = new Int32Array(64), qz = new Int32Array(64);
    function fdctQuant() {
      let off = 0;
      for (let i = 0; i < 8; i++) {
        const d0 = dati[off], d1 = dati[off + 1], d2 = dati[off + 2], d3 = dati[off + 3], d4 = dati[off + 4], d5 = dati[off + 5], d6 = dati[off + 6], d7 = dati[off + 7];
        const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6, t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
        let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
        dati[off] = t10 + t11; dati[off + 4] = t10 - t11;
        const z1 = (t12 + t13) * 0.707106781;
        dati[off + 2] = t13 + z1; dati[off + 6] = t13 - z1;
        t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
        const z5 = (t10 - t12) * 0.382683433, z2 = 0.541196100 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
        const z11 = t7 + z3, z13 = t7 - z3;
        dati[off + 5] = z13 + z2; dati[off + 3] = z13 - z2; dati[off + 1] = z11 + z4; dati[off + 7] = z11 - z4;
        off += 8;
      }
      off = 0;
      for (let i = 0; i < 8; i++) {
        const d0 = dati[off], d1 = dati[off + 8], d2 = dati[off + 16], d3 = dati[off + 24], d4 = dati[off + 32], d5 = dati[off + 40], d6 = dati[off + 48], d7 = dati[off + 56];
        const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6, t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
        let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
        dati[off] = t10 + t11; dati[off + 32] = t10 - t11;
        const z1 = (t12 + t13) * 0.707106781;
        dati[off + 16] = t13 + z1; dati[off + 48] = t13 - z1;
        t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
        const z5 = (t10 - t12) * 0.382683433, z2 = 0.541196100 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
        const z11 = t7 + z3, z13 = t7 - z3;
        dati[off + 40] = z13 + z2; dati[off + 24] = z13 - z2; dati[off + 8] = z11 + z4; dati[off + 56] = z11 - z4;
        off++;
      }
      for (let i = 0; i < 64; i++) { const v = dati[i] * fdt[i]; qz[i] = v > 0 ? (v + 0.5) | 0 : (v - 0.5) | 0; }
    }
    const EOB = HTAC[0x00], M16 = HTAC[0xF0];
    function blocco(DC) {
      fdctQuant();
      for (let j = 0; j < 64; j++) DU[ZIGZAG[j]] = qz[j];
      const diff = DU[0] - DC; DC = DU[0];
      if (diff === 0) bits(HTDC[0]); else { const p = 32767 + diff; bits(HTDC[categoria[p]]); bits(bitcode[p]); }
      let fine = 63; while (fine > 0 && DU[fine] === 0) fine--;
      if (fine === 0) { bits(EOB); return DC; }
      let i = 1;
      while (i <= fine) {
        const inizio = i; while (DU[i] === 0 && i <= fine) i++;
        let zeri = i - inizio;
        if (zeri >= 16) { const n = zeri >> 4; for (let m = 1; m <= n; m++) bits(M16); zeri &= 0xF; }
        const p = 32767 + DU[i]; bits(HTAC[(zeri << 4) + categoria[p]]); bits(bitcode[p]); i++;
      }
      if (fine !== 63) bits(EOB);
      return DC;
    }

    // intestazioni
    word(0xFFD8);
    word(0xFFEE); word(14); for (const ch of 'Adobe') byte(ch.charCodeAt(0)); word(100); word(0); word(0); byte(0); // APP14: transform 0 = CMYK
    word(0xFFDB); word(67); byte(0); for (let i = 0; i < 64; i++) byte(YT[i]);
    word(0xFFC0); word(20); byte(8); word(H); word(W); byte(4); for (let c = 1; c <= 4; c++) { byte(c); byte(0x11); byte(0); }
    word(0xFFC4); word(2 + 29 + 179); byte(0x00); for (let i = 1; i <= 16; i++) byte(DC_NR[i]); for (const v of DC_VAL) byte(v);
    byte(0x10); for (let i = 1; i <= 16; i++) byte(AC_NR[i]); for (const v of AC_VAL) byte(v);
    word(0xFFDA); word(14); byte(4); for (let c = 1; c <= 4; c++) { byte(c); byte(0x00); } byte(0); byte(0x3f); byte(0);

    const sr = sfondo ? sfondo[0] : 255, sg = sfondo ? sfondo[1] : 255, sb = sfondo ? sfondo[2] : 255;
    const DCs = [0, 0, 0, 0];
    const righeBanda = 8;
    const cmykBanda = new Uint8Array(W * 8 * 4);
    let bandeFatte = 0;
    for (let y0 = 0; y0 < H; y0 += righeBanda) {
      const n = Math.min(righeBanda, H - y0);
      const rgba = sorgente.banda(y0, n);
      // conversione della banda in CMYK invertito (convenzione Adobe)
      for (let y = 0; y < 8; y++) {
        const ys = Math.min(y, n - 1);
        for (let x = 0; x < W; x++) {
          const i = (ys * W + x) * 4;
          const a = rgba[i + 3] / 255;
          const r = rgba[i] * a + sr * (1 - a), g = rgba[i + 1] * a + sg * (1 - a), b = rgba[i + 2] * a + sb * (1 - a);
          const R = r / 255, G = g / 255, B = b / 255;
          const k = 1 - Math.max(R, G, B);
          let c = 0, m = 0, yy = 0;
          if (k < 0.999) { const d = 1 - k; c = (d - R) / d; m = (d - G) / d; yy = (d - B) / d; }
          const o = (y * W + x) * 4;
          cmykBanda[o] = 255 - Math.round(c * 255); cmykBanda[o + 1] = 255 - Math.round(m * 255); cmykBanda[o + 2] = 255 - Math.round(yy * 255); cmykBanda[o + 3] = 255 - Math.round(k * 255);
        }
      }
      for (let x0 = 0; x0 < W; x0 += 8) {
        for (let comp = 0; comp < 4; comp++) {
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const xs = Math.min(x0 + x, W - 1);
            dati[y * 8 + x] = cmykBanda[(y * W + xs) * 4 + comp] - 128;
          }
          DCs[comp] = blocco(DCs[comp]);
        }
      }
      bandeFatte++;
      if (avanzamento && (bandeFatte & 15) === 0) {
        avanzamento(Math.min(0.99, (y0 + n) / H));
        await new Promise((ok) => setTimeout(ok, 0));
      }
    }
    if (bytepos >= 0) bits([(1 << (bytepos + 1)) - 1, bytepos + 1]);
    word(0xFFD9);
    pezzi.push(buf.subarray(0, pos));
    let tot = 0; for (const p of pezzi) tot += p.length;
    const out = new Uint8Array(tot); let o = 0; for (const p of pezzi) { out.set(p, o); o += p.length; }
    return out;
  }

  // ------------------------------------------------------------------ testi in tracciati
  // Restituisce i comandi per jsPDF.path() (coordinate assolute, y verso il basso), già allineati.
  function tracciatoTesto(font, testo, x, y, size, allinea, letterSpacing) {
    const opz = { kerning: false, letterSpacing: letterSpacing || 0 };
    let x0 = x;
    if (allinea === 'center' || allinea === 'right') {
      const w = font.getAdvanceWidth(testo, size, opz);
      x0 = allinea === 'center' ? x - w / 2 : x - w;
    }
    const p = font.getPath(testo, x0, y, size, opz);
    const out = [];
    let cx = 0, cy = 0;
    for (const c of p.commands) {
      if (c.type === 'M') { out.push({ op: 'm', c: [c.x, c.y] }); cx = c.x; cy = c.y; }
      else if (c.type === 'L') { out.push({ op: 'l', c: [c.x, c.y] }); cx = c.x; cy = c.y; }
      else if (c.type === 'C') { out.push({ op: 'c', c: [c.x1, c.y1, c.x2, c.y2, c.x, c.y] }); cx = c.x; cy = c.y; }
      else if (c.type === 'Q') {
        const c1x = cx + 2 / 3 * (c.x1 - cx), c1y = cy + 2 / 3 * (c.y1 - cy);
        const c2x = c.x + 2 / 3 * (c.x1 - c.x), c2y = c.y + 2 / 3 * (c.y1 - c.y);
        out.push({ op: 'c', c: [c1x, c1y, c2x, c2y, c.x, c.y] }); cx = c.x; cy = c.y;
      } else if (c.type === 'Z') out.push({ op: 'h' });
    }
    return out;
  }

  // ------------------------------------------------------------------ PDF/X-1a:2001 — completamento del file jsPDF
  // src: stringa binaria prodotta da doc.output(). Restituisce una Uint8Array.
  function dataPdf(d) {
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset(); const seg = off >= 0 ? '+' : '-'; const ao = Math.abs(off);
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${seg}${p(Math.floor(ao / 60))}'${p(ao % 60)}'`;
  }
  function escPdf(s) { return String(s).replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7E]/g, (c) => { const code = c.charCodeAt(0); return code < 256 ? '\\' + code.toString(8).padStart(3, '0') : '?'; }); }

  function completaPdfX1a(src, info) {
    const mStart = src.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
    if (!mStart) throw new Error('startxref non trovato');
    const xrefPos = parseInt(mStart[1], 10);
    const mX = src.slice(xrefPos).match(/^xref\s+0 (\d+)\s/);
    if (!mX) throw new Error('tabella xref non riconosciuta');
    const n = parseInt(mX[1], 10);
    const tab = xrefPos + mX[0].length;
    const offsets = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const e = src.substr(tab + i * 20, 20);
      const me = e.match(/^(\d{10}) (\d{5}) ([nf])/);
      if (!me) throw new Error('voce xref non valida: ' + i);
      if (me[3] === 'n') offsets[i] = parseInt(me[1], 10);
    }
    const trailer = src.slice(src.indexOf('trailer', tab));
    const root = parseInt((trailer.match(/\/Root (\d+) 0 R/) || [])[1], 10);
    const infoId = parseInt((trailer.match(/\/Info (\d+) 0 R/) || [])[1], 10);
    const idm = trailer.match(/\/ID \[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\]/);
    if (!root || !infoId) throw new Error('Root o Info non trovati nel trailer');
    let corpo = src.slice(0, xrefPos);
    const modifiche = []; // {pos, delta}
    const spostato = (p) => { let d = 0; for (const m of modifiche) if (m.pos < p) d += m.delta; return p + d; };

    const dizionario = (inizio) => {
      const apre = corpo.indexOf('<<', inizio);
      const fine = corpo.indexOf('endobj', apre);
      const chiude = corpo.lastIndexOf('>>', fine);
      return { apre, chiude };
    };
    // --- Info: dizionario riscritto
    {
      const { apre, chiude } = dizionario(spostato(offsets[infoId]));
      const vecchio = corpo.slice(apre, chiude + 2);
      const creazione = (vecchio.match(/\/CreationDate \(([^)]*)\)/) || [])[1] || dataPdf(new Date());
      const prod = (vecchio.match(/\/Producer \(([^)]*)\)/) || [])[1] || 'jsPDF';
      const nuovo = '<<\n' +
        `/Producer (${prod} + Il Giornale Lavori cartello)\n` +
        `/Creator (${escPdf(info.creator || 'Il Giornale Lavori - www.ilgiornalelavori.it')})\n` +
        `/Title (${escPdf(info.titolo || 'Cartello di cantiere')})\n` +
        `/Subject (${escPdf(info.soggetto || 'Cartello di cantiere')})\n` +
        `/Author (${escPdf(info.autore || 'Il Giornale Lavori')})\n` +
        `/CreationDate (${creazione})\n` +
        `/ModDate (${creazione})\n` +
        '/Trapped /False\n' +
        '/GTS_PDFXVersion (PDF/X-1:2001)\n' +
        '/GTS_PDFXConformance (PDF/X-1a:2001)\n' +
        '>>';
      corpo = corpo.slice(0, apre) + nuovo + corpo.slice(chiude + 2);
      modifiche.push({ pos: offsets[infoId] + 1, delta: nuovo.length - vecchio.length });
    }
    // --- OutputIntent: nuovo oggetto in coda
    const idOI = n; // primo numero libero
    const oi = `${idOI} 0 obj\n<<\n/Type /OutputIntent\n/S /GTS_PDFX\n/OutputConditionIdentifier (${escPdf(info.condizione || 'FOGRA39')})\n` +
      `/OutputCondition (${escPdf(info.condizioneTesto || 'Offset printing according to ISO 12647-2:2004 / Amd 1, paper type 1 or 2 (gloss or matte coated), FOGRA39')})\n` +
      `/RegistryName (${escPdf(info.registro || 'http://www.color.org')})\n` +
      `/Info (${escPdf(info.condizioneInfo || 'Coated FOGRA39 (ISO 12647-2:2004)')})\n>>\nendobj\n`;
    // --- Catalog: riferimento all'OutputIntent, via l'OpenAction (niente azioni in un PDF/X)
    {
      const { apre, chiude } = dizionario(spostato(offsets[root]));
      const vecchio = corpo.slice(apre, chiude + 2);
      const nuovo = vecchio.replace(/\n\/OpenAction \[[^\]]*\]/, '').replace(/>>$/, `/OutputIntents [${idOI} 0 R]\n>>`);
      corpo = corpo.slice(0, apre) + nuovo + corpo.slice(chiude + 2);
      modifiche.push({ pos: offsets[root] + 1, delta: nuovo.length - vecchio.length });
    }
    if (!/\n$/.test(corpo)) corpo += '\n';
    const offOI = corpo.length;
    corpo += oi;
    // --- xref e trailer ricostruiti
    const nuovi = new Array(idOI + 1).fill(0);
    for (let i = 1; i < n; i++) nuovi[i] = offsets[i] ? spostato(offsets[i]) : 0;
    nuovi[idOI] = offOI;
    const xrefOff = corpo.length;
    let xref = `xref\n0 ${idOI + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= idOI; i++) xref += nuovi[i] ? `${String(nuovi[i]).padStart(10, '0')} 00000 n \n` : '0000000000 00000 f \n';
    const id = idm ? idm[1] : Array.from({ length: 32 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');
    const tr = `trailer\n<<\n/Size ${idOI + 1}\n/Root ${root} 0 R\n/Info ${infoId} 0 R\n/ID [<${id}> <${id}>]\n>>\nstartxref\n${xrefOff}\n%%EOF`;
    const finale = corpo + xref + tr;
    const u8 = new Uint8Array(finale.length);
    for (let i = 0; i < finale.length; i++) u8[i] = finale.charCodeAt(i) & 255;
    return u8;
  }

  return { cmykDaHex, cmykDaRgb, codificaJpegCmyk, tracciatoTesto, completaPdfX1a, dataPdf };
});
