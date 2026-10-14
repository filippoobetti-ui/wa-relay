# Cronoprogramma da file (14/10/2026)

Il cronoprogramma entra nel Giornale Lavori mandando il file (WhatsApp con «cronoprogramma» nella didascalia,
oppure area riservata → scheda Cronoprogramma → «Carica il cronoprogramma»). Si conferma prima del salvataggio.

- `../../src/crono-import.js` — parte del relay: riconoscimento dei file in chat, pulsanti `CRONO_IMP_<n>_OK/_NO`,
  `/admin crono_import_avvisa`, pagine `/cronoprogramma`, `/cronoprogramma/carica`, `/stato`, `/azione`.
- `edge-index.ts` + `leggi.js` — sorgente della funzione Supabase `crono-import` (v2, verify_jwt off, chiave
  `x-crono-chiave` = impostazioni.crono_chiave). `leggi.js` legge senza AI: XML di MS Project, XML/XER di Primavera,
  Excel/CSV con intestazione; PDF, foto ed Excel senza intestazione passano da Claude.
- `collaudo-formati.mjs` — rigenera dai dati di un cronoprogramma (file `v1.json`: righe
  `[codice, padre, livello, r|a|c, nome, durata, inizio, fine]`, esportate dal database e NON nel repository) i sei
  formati come li esporterebbe un'impresa e controlla che si rileggano identici. Richiede `npm i fast-xml-parser@4.5.0 xlsx@0.18.5`.
- `collaudo-relay.mjs` — prove del modulo del relay con aiuti finti (`node collaudo-relay.mjs`).

Database: migrazioni `crono_11a…crono_13` (tabella `crono_import`, funzioni `crono_import_*`, cron `crono_import_sveglia`).
Spegnimento: `impostazioni.crono_import_attivo = 'no'` oppure variabile del relay `CRONO_IMPORT=off`.
Registro completo nel progetto: `claude/log-cronoprogramma-da-file-14-10-2026.md`.
