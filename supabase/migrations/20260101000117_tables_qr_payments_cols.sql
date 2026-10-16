-- =============================================================================
-- DB-6 / 0117 — Base da Fase 4: F-03 (qr_token só do servidor), colunas de
-- pagamento/fechamento e Realtime de pagamentos.
--
-- F-03 · restaurant_tables.qr_token
--   * O token nasce por DEFAULT no servidor (generate_public_code) e só muda por
--     public.rotate_table_qr (SECURITY DEFINER, tables.manage; migração 0120).
--   * Clientes (authenticated) perdem INSERT/UPDATE de tabela inteira e ganham
--     INSERT/UPDATE apenas das colunas de cadastro (sem qr_token, created_at,
--     updated_at). Tentar gravar qr_token => 42501 "permission denied".
--   * Trigger de defesa em profundidade: se algum dia o GRANT for reaberto, o
--     cliente direto não define o token no INSERT (é regerado) nem o altera.
--   * unique(qr_token) permanece; como o cliente não o define, deixa de ser
--     oráculo de existência entre tenants.
--
-- payments.tendered_cents (valor entregue em dinheiro; troco = tendered - amount,
--   só informativo, calculado no retorno de record_payment).
--
-- tabs.unpaid_cents / tabs.unpaid_reason: saldo e justificativa quando a comanda
--   é fechada com conta em aberto (close_tab com p_unpaid_reason). Só a RPC grava
--   (clientes diretos não têm UPDATE nestas colunas; o CHECK impede lixo no INSERT).
--
-- Realtime: payments entra na publication (UPDATE traz a linha antiga: REPLICA
--   IDENTITY FULL). O Realtime avalia payments_select (reports.view|payments.record).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- F-03 · privilégios por coluna em restaurant_tables
-- ---------------------------------------------------------------------------
revoke insert, update on public.restaurant_tables from authenticated;
grant insert (id, restaurant_id, name, area, capacity, status, sort_order)
  on public.restaurant_tables to authenticated;
grant update (name, area, capacity, status, sort_order)
  on public.restaurant_tables to authenticated;

create or replace function public.restaurant_tables_qr_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_direct_client() then
    if tg_op = 'INSERT' then
      new.qr_token := public.generate_public_code();
    elsif new.qr_token is distinct from old.qr_token then
      raise exception 'FORBIDDEN_FIELD: o token do QR só é gerado pelo servidor (rotate_table_qr)' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.restaurant_tables_qr_guard() from public, anon, authenticated;

create trigger restaurant_tables_a_qr_guard
  before insert or update on public.restaurant_tables
  for each row execute function public.restaurant_tables_qr_guard();

-- ---------------------------------------------------------------------------
-- payments: dinheiro entregue (troco informativo)
-- ---------------------------------------------------------------------------
alter table public.payments
  add column tendered_cents integer;
alter table public.payments
  add constraint payments_tendered_cash_only
    check (tendered_cents is null or (method = 'CASH' and tendered_cents >= amount_cents));

-- ---------------------------------------------------------------------------
-- tabs: conta fechada com saldo em aberto (auditável)
-- ---------------------------------------------------------------------------
alter table public.tabs
  add column unpaid_cents  integer not null default 0 check (unpaid_cents >= 0),
  add column unpaid_reason text check (unpaid_reason is null or length(btrim(unpaid_reason)) >= 10);
alter table public.tabs
  add constraint tabs_unpaid_only_when_closed
    check ((unpaid_cents = 0 and unpaid_reason is null) or status = 'CLOSED');

-- ---------------------------------------------------------------------------
-- Realtime: payments
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'payments'
  ) then
    alter publication supabase_realtime add table public.payments;
  end if;
end
$$;
alter table public.payments replica identity full;
