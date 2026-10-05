# Cartello di cantiere — sorgenti del generatore (05/10/2026)

La pagina pubblica è `public/cartello/index.html` (servita dal Worker su `/cartello`). Si ricostruisce così:

1. `pip install qrcode fonttools` e `npm install jspdf@2.5.1` in questa cartella; mettere i TTF Roboto 400/700 (es. da `@expo-google-fonts/roboto`) e creare i sottoinsiemi `Roboto_400Regular.sub.ttf` / `Roboto_700Bold.sub.ttf` con `pyftsubset` (unicodes latino, no hinting).
2. `python3 build_risorse.py` → `risorse.json` (marchio in tracciati + markup, font base64, matrice del QR di `https://www.ilgiornalelavori.it/?da=cartello`).
3. `python3 build_pagina.py` → `cartello.html` (da copiare in `public/cartello/index.html`) e `cartello-edge-index.ts` (la Edge Function Supabase `cartello`, da deployare con `verify_jwt=false`).
4. Collaudo offline: `node test-render.js` genera i PDF dei casi di prova in `out/` (richiede `test/immagini.json` con render/loghi di prova).

- `motore.js`: impaginazione condivisa (anteprima SVG + PDF jsPDF), formati, campi, ordine delle righe.
- `pagina.template.html`: modulo, anteprima, pagamento (segnaposto `__LOGO_INTERNO__`, `__MOTORE__`, `__RISORSE__`).
- `edge-function-cartello.ts`: checkout Stripe (9,00 € + IVA), verifica, contatore download.
- `supabase-05-10-2026.sql`: tabella `cartelli_cantiere`, RPC, ramo `CRT-` nel webhook Stripe.
- Documento di progetto nel Progetto Claude: `claude/cartello-di-cantiere.md`.
