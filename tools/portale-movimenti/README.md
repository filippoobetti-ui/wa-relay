# Collaudo dei movimenti del portale (09/10/2026)

Collaudo locale della VERA `portaleRoute` del worker, con Supabase sostituito da due pagine di prova
che hanno la stessa struttura delle pagine del portale (elenco e cantiere, `dashboard_html`).

Come si usa (dal container di Claude o da un PC con Node 22 e Playwright):

    cp src/index.js tools/portale-movimenti/index.mjs
    printf '\nexport { portaleRoute, portaleMovimenti, PORTALE_MOVIMENTI_STILE, PORTALE_MOVIMENTI_SCRIPT };\n' >> tools/portale-movimenti/index.mjs
    cd tools/portale-movimenti && node server.mjs &          # http://127.0.0.1:8787/
    node collaudo.mjs                                        # 50 controlli: livello HTTP (acceso di norma, ?movimenti=0/1, cookie gl_mov, MOVIMENTI=off), nomi di transizione, pillola, scorrimento, trascinamento (tocco CDP), conteggio ore, riduci animazioni, scelta del singolo telefono, interruttore del Worker

Dal 10/10/2026 i movimenti sono accesi per tutti: `?movimenti=0` li spegne su un telefono (cookie `gl_mov=0`), `?movimenti=1` li riaccende,
la variabile del Worker `MOVIMENTI=off` li spegne per tutti. Il server di prova simula la variabile con `GET /__prova/movimenti?v=off|on`.

`collaudo.mjs` usa `executablePath` del Chromium preinstallato (/opt/pw-browsers/chromium-1194): adeguarlo se cambia.
Se `import "playwright"` non si trova: `mkdir -p node_modules && ln -sfn "$(npm root -g)/playwright" node_modules/playwright` (cartella ignorata da git).
Il file `index.mjs` e' una copia usa-e-getta: non va committato.
