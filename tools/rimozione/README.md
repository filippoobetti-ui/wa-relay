# Collaudo del blocco dei numeri rimossi (09/10/2026)

Collaudo locale della VERA `processAndForward` del worker, con Supabase (RPC `persone_rimosse_numeri`,
`persona_rimossa_avviso`, `chat_unica_config`, `chat_unica_log`), Meta e Make sostituiti da finti servizi in memoria.

Come si usa (Node 22):

    cp src/index.js tools/rimozione/index.mjs
    printf '\nexport { processAndForward };\n' >> tools/rimozione/index.mjs
    cd tools/rimozione && node collaudo.mjs     # 15 controlli: presente inoltrato, rimosso fermato + avviso una sola volta,
                                                # notifica mista, ripristino entro 60 s, database muto, interruttore RIMOZIONE=off

Il file `index.mjs` e' una copia usa-e-getta: non va committato.
