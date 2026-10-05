-- ============================================================================
-- CARTELLO DI CANTIERE — migrazioni del 05/10/2026 (progetto Supabase rvigugiufrjmzedjstuz)
-- 1) cartello_cantiere_05_10_2026            tabella delle vendite, RPC contatore download, impostazioni
-- 2) cartello_pagamento_webhook_05_10_2026    colonna token, RPC cartello_completa_da_pagamento, archivio id 191
-- 3) onboarding_completa_ramo_cartello_05_10  ramo CRT- in onboarding_completa_da_pagamento (sostituzione guardata)
-- 4) cartello_completa_idempotente_05_10_2026 secondo recapito del webhook → 'ok' senza avvisi
-- ============================================================================

-- ---------- 1) cartello_cantiere_05_10_2026
create table if not exists public.cartelli_cantiere (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  stato text not null default 'creato' check (stato in ('creato', 'pagato', 'annullato', 'scaduto')),
  formato text not null check (formato in ('100x100', '100x200', '150x300', '200x300')),
  orientamento text not null check (orientamento in ('verticale', 'orizzontale')),
  tipo text not null check (tipo in ('privato', 'pubblico')),
  oggetto text,
  ubicazione text,
  ritorno text,
  importo_cent integer not null,
  iva_pct numeric(5,2) not null default 22,
  totale_cent integer,
  valuta text not null default 'eur',
  email text,
  cliente text,
  partita_iva text,
  paese text,
  stripe_payment_intent text,
  stripe_customer text,
  scarichi integer not null default 0,
  ultimo_scarico_il timestamptz,
  ip_hash text,
  user_agent text,
  creato_il timestamptz not null default now(),
  pagato_il timestamptz,
  aggiornato_il timestamptz not null default now()
);
comment on table public.cartelli_cantiere is 'Vendite del cartello di cantiere (PDF, 9 € + IVA): una riga per Checkout Session Stripe. Scritta solo dalla Edge Function cartello con service role.';
create index if not exists cartelli_cantiere_stato_creato_idx on public.cartelli_cantiere (stato, creato_il desc);
alter table public.cartelli_cantiere enable row level security;
revoke all on table public.cartelli_cantiere from anon, authenticated;

create or replace function public.cartello_registra_scarico(p_session text)
returns void language sql security definer set search_path = public as $$
  update public.cartelli_cantiere
     set scarichi = scarichi + 1, ultimo_scarico_il = now(), aggiornato_il = now()
   where session_id = p_session and stato = 'pagato';
$$;
revoke execute on function public.cartello_registra_scarico(text) from public, anon, authenticated;
grant execute on function public.cartello_registra_scarico(text) to service_role;

insert into public.impostazioni (chiave, valore, descrizione) values
  ('cartello_url', 'https://wa-relay.filippo-obetti.workers.dev/cartello', 'Indirizzo pubblico del generatore del cartello di cantiere (usato per i ritorni da Stripe). Cambiandolo cambiano i link di ritorno delle vendite nuove.'),
  ('cartello_prezzo_cent', '900', 'Prezzo imponibile del cartello di cantiere in centesimi (IVA 22 % a parte). 900 = 9,00 € + IVA.'),
  ('cartello_attivo', 'si', 'Interruttore del servizio cartello di cantiere: "no" sospende pagina e pagamenti senza deploy.')
on conflict (chiave) do nothing;

-- ---------- 2) cartello_pagamento_webhook_05_10_2026
alter table public.cartelli_cantiere add column if not exists token text;
create unique index if not exists cartelli_cantiere_token_idx on public.cartelli_cantiere (token) where token is not null;

-- (definizione finale, dopo la 4: un secondo recapito risponde 'ok')
create or replace function public.cartello_completa_da_pagamento(p_token text, p_session text, p_customer text, p_indirizzo jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v record;
begin
  select * into v from cartelli_cantiere where token = p_token;
  if v.id is null then
    return jsonb_build_object('esito','errore','messaggio','cartello non trovato per il token indicato');
  end if;
  if v.stato = 'pagato' then
    return jsonb_build_object('esito','ok','gia_registrato', true, 'cartello_id', v.id, 'messaggio','Pagamento del cartello gia'' registrato.');
  end if;
  update cartelli_cantiere
     set stato = 'pagato',
         pagato_il = coalesce(pagato_il, now()),
         stripe_customer = coalesce(stripe_customer, nullif(trim(coalesce(p_customer,'')),'')),
         paese = coalesce(paese, nullif(upper(trim(coalesce(p_indirizzo->>'paese',''))),'')),
         aggiornato_il = now()
   where id = v.id;
  return jsonb_build_object('esito','ok','cartello_id', v.id, 'formato', v.formato, 'messaggio','Cartello di cantiere pagato: il PDF e'' sbloccato nella pagina del cliente.');
end $$;
revoke execute on function public.cartello_completa_da_pagamento(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.cartello_completa_da_pagamento(text, text, text, jsonb) to service_role;

insert into public.archivio_oggetti_superati (tipo, nome, definizione, motivo)
select 'function', 'onboarding_completa_da_pagamento(jsonb)', pg_get_functiondef(p.oid),
       'Prima del ramo CRT- (cartello di cantiere) del 05/10/2026'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'onboarding_completa_da_pagamento';
-- → archivio id 191 (md5 d275c9bc796c4728784d6670e94f667f, 10.614 caratteri)

-- ---------- 3) onboarding_completa_ramo_cartello_05_10_2026 (sostituzione testuale guardata)
do $$
declare
  v_def text;
  v_anc text := E'  if v_token like ''ASS-%'' then\n    return assistenza_completa_da_pagamento(v_token, p->>''stripe_session_id'');\n  end if;\n';
  v_new text := E'  if v_token like ''ASS-%'' then\n    return assistenza_completa_da_pagamento(v_token, p->>''stripe_session_id'');\n  end if;\n\n  -- Cartello di cantiere (05/10/2026): PDF a 9 EUR + IVA pagato con Checkout one-off dallo stesso webhook\n  if v_token like ''CRT-%'' then\n    return cartello_completa_da_pagamento(v_token, p->>''stripe_session_id'', p->>''stripe_customer_id'', p->''indirizzo'');\n  end if;\n';
  v_n int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'onboarding_completa_da_pagamento';
  v_n := (length(v_def) - length(replace(v_def, v_anc, ''))) / length(v_anc);
  if v_n <> 1 then raise exception 'ancora trovata % volte, attesa 1: nessuna modifica', v_n; end if;
  if position('CRT-' in v_def) > 0 then raise exception 'il ramo CRT- esiste gia'': nessuna modifica'; end if;
  execute replace(v_def, v_anc, v_new);
end $$;

-- ---------- Collaudo eseguito (transazione annullata con RAISE): r1=ok stato=pagato paese=IT | r2=ok (gia_registrato) | r3=errore (token sconosciuto) | r4=errore (token assente)

-- ---------- Ritorno indietro
-- update onboarding_completa_da_pagamento: eseguire la definizione archiviata con id 191 (archivio_oggetti_superati)
-- drop function public.cartello_completa_da_pagamento(text, text, text, jsonb);
-- drop function public.cartello_registra_scarico(text);
-- drop table public.cartelli_cantiere;   -- solo se non contiene vendite vere
-- delete from impostazioni where chiave in ('cartello_url','cartello_prezzo_cent','cartello_attivo');
