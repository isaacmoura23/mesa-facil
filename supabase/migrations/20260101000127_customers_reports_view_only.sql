-- =============================================================================
-- 0127 · Fase 5 (DB-7) · list_customers/get_customer exigem apenas reports.view
--
-- Decisão de privacidade: o diretório de clientes é de owner/manager (reports.view).
-- cashier/kitchen/waiter -> FORBIDDEN (antes passavam por orders.view). A RLS direta de
-- public.customers (operação de pedidos) NÃO muda. Não-membro/outro tenant continua
-- RESTAURANT_NOT_FOUND.
-- =============================================================================
create or replace function app_private.require_customer_access(p_rid uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  if p_rid is null or not public.is_member(p_rid) then
    raise exception 'RESTAURANT_NOT_FOUND: não encontrado' using errcode = 'P0002';
  end if;
  if not public.has_permission(p_rid, 'reports.view') then
    raise exception 'FORBIDDEN: requer permissão reports.view' using errcode = '42501';
  end if;
end;
$$;
revoke all on function app_private.require_customer_access(uuid) from public, anon, authenticated;
