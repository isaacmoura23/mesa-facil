-- =============================================================================
-- 0124 · Fase 5 (DB-7) · dashboard_metrics + restaurant_report (somente leitura)
--
-- RPCs novas (SECURITY DEFINER, search_path = '', EXECUTE só authenticated):
--   public.dashboard_metrics(p_restaurant, p_from, p_to)                       -> jsonb
--   public.restaurant_report(p_restaurant, p_report, p_from, p_to, p_group)    -> jsonb
-- Internos (app_private, sem EXECUTE para clientes):
--   check_period, report_tz, money_ok
--
-- Autorização DENTRO da função: auth.uid() + is_member + has_permission('reports.view').
-- Owner e manager passam; cashier/kitchen/waiter -> FORBIDDEN; usuário sem vínculo ativo,
-- restaurante suspenso/inexistente ou de outro tenant -> RESTAURANT_NOT_FOUND (idêntico).
--
-- Erros (exceção "CODIGO: texto"):
--   UNAUTHENTICATED (28000) · RESTAURANT_NOT_FOUND (P0002) · FORBIDDEN (42501)
--   INVALID_PERIOD (22023)  from/to nulos, from >= to ou intervalo > 366 dias
--   INVALID_REPORT / INVALID_GROUP (22023)
--
-- Definições (documentadas aqui porque a UI as exibe):
--   * Janela = [from, to) sobre orders.created_at. Dias/semanas/meses no fuso do restaurante
--     (restaurants.timezone; se inválido -> America/Sao_Paulo). Semana ISO (começa na segunda);
--     a coluna "period" é a data local do início do bucket (pode ser anterior a "from").
--   * gross = pedidos exceto CANCELLED/REJECTED (todo o fluxo, inclusive em andamento);
--     completed = somente COMPLETED. ticket médio = gross / nº de pedidos gross, arredondado
--     ao centavo (0 se não há pedidos: sem divisão por zero).
--   * orders_count = TODOS os pedidos da janela; gross_orders_count = pedidos que compõem o gross.
--   * in_progress_orders / open_tabs / occupied_tables / tables_total são o estado ATUAL (não
--     dependem da janela). tables_total = mesas não INACTIVE.
--   * top_products usa os snapshots de order_items (product_name + variant_name_snapshot), nunca
--     a tabela products (nome/preço podem ter mudado ou o produto sido removido).
--   * payment_methods: somente payments PAID, filtrados por paid_at na janela.
--   * cancelamentos: motivos agregados (status_reason normalizado, truncado em 80 chars,
--     e-mails e sequências de >= 6 dígitos mascarados -> sem PII), janela por created_at.
--   * Valores monetários: inteiros em centavos (soma exata em bigint).
--   * restaurant_report: no máximo 5000 linhas (truncated=true se houver mais); totals sempre
--     calculados sobre TODOS os dados da janela, não sobre as linhas devolvidas.
--
-- Índices de apoio (EXPLAIN mostrou seq scan sem eles em payments por paid_at e em orders por
-- cliente/data): ver final do arquivo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helpers internos
-- ---------------------------------------------------------------------------
create or replace function app_private.check_period(p_from timestamptz, p_to timestamptz, p_max_days integer default 366)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_from >= p_to
     or p_to - p_from > make_interval(days => p_max_days) then
    raise exception 'INVALID_PERIOD: período inválido (from < to, máximo % dias)', p_max_days using errcode = '22023';
  end if;
end;
$$;

create or replace function app_private.report_tz(p_rid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when exists (select 1 from pg_catalog.pg_timezone_names n where n.name = r.timezone) then r.timezone
           else 'America/Sao_Paulo'
         end
  from public.restaurants r
  where r.id = p_rid;
$$;

revoke all on function app_private.check_period(timestamptz, timestamptz, integer) from public, anon, authenticated;
revoke all on function app_private.report_tz(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- dashboard_metrics
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_metrics(p_restaurant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz           text;
  v_orders       bigint;
  v_gross_n      bigint;
  v_gross        bigint;
  v_completed    bigint;
  v_cancelled    bigint;
  v_rejected     bigint;
  v_in_progress  bigint;
  v_open_tabs    bigint;
  v_occupied     bigint;
  v_tables       bigint;
  v_by_ful       jsonb;
  v_top          jsonb;
  v_series       jsonb;
  v_pay          jsonb;
begin
  perform app_private.require_perm(p_restaurant, 'reports.view', 'RESTAURANT_NOT_FOUND');
  perform app_private.check_period(p_from, p_to);
  v_tz := app_private.report_tz(p_restaurant);

  select count(*),
         count(*) filter (where o.status not in ('CANCELLED', 'REJECTED')),
         coalesce(sum(o.total_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0),
         coalesce(sum(o.total_cents) filter (where o.status = 'COMPLETED'), 0),
         count(*) filter (where o.status = 'CANCELLED'),
         count(*) filter (where o.status = 'REJECTED')
    into v_orders, v_gross_n, v_gross, v_completed, v_cancelled, v_rejected
    from public.orders o
   where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to;

  select count(*) into v_in_progress
    from public.orders o
   where o.restaurant_id = p_restaurant
     and o.status in ('RECEIVED', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY');
  select count(*) into v_open_tabs
    from public.tabs t where t.restaurant_id = p_restaurant and t.status = 'OPEN';
  select count(*) filter (where rt.status = 'OCCUPIED'), count(*) filter (where rt.status <> 'INACTIVE')
    into v_occupied, v_tables
    from public.restaurant_tables rt where rt.restaurant_id = p_restaurant;

  select jsonb_agg(jsonb_build_object('type', t.type, 'orders', coalesce(a.n, 0), 'sales_cents', coalesce(a.s, 0))
                   order by t.ord)
    into v_by_ful
    from (values ('DELIVERY', 1), ('PICKUP', 2), ('DINE_IN', 3)) as t(type, ord)
    left join (
      select o.fulfillment_type::text as ft, count(*) as n, sum(o.total_cents)::bigint as s
        from public.orders o
       where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
         and o.status not in ('CANCELLED', 'REJECTED')
       group by 1
    ) a on a.ft = t.type;

  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'variant', x.variant, 'quantity', x.q, 'sales_cents', x.s)
                            order by x.s desc, x.q desc, x.name, x.variant nulls first), '[]'::jsonb)
    into v_top
    from (
      select oi.product_name as name, oi.variant_name_snapshot as variant,
             sum(oi.quantity)::bigint as q, sum(oi.line_total_cents)::bigint as s
        from public.orders o
        join public.order_items oi on oi.restaurant_id = o.restaurant_id and oi.order_id = o.id
       where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
         and o.status not in ('CANCELLED', 'REJECTED')
       group by oi.product_name, oi.variant_name_snapshot
       order by s desc, q desc, oi.product_name, oi.variant_name_snapshot nulls first
       limit 10
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object('day', b.day, 'orders', coalesce(a.n, 0), 'sales_cents', coalesce(a.s, 0))
                            order by b.day), '[]'::jsonb)
    into v_series
    from (
      select d::date as day
        from generate_series((p_from at time zone v_tz)::date::timestamp,
                             ((p_to - interval '1 microsecond') at time zone v_tz)::date::timestamp,
                             interval '1 day') d
    ) b
    left join (
      select (o.created_at at time zone v_tz)::date as day, count(*) as n, sum(o.total_cents)::bigint as s
        from public.orders o
       where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
         and o.status not in ('CANCELLED', 'REJECTED')
       group by 1
    ) a on a.day = b.day;

  select coalesce(jsonb_agg(jsonb_build_object('method', x.method, 'amount_cents', x.s, 'count', x.n)
                            order by x.s desc, x.method), '[]'::jsonb)
    into v_pay
    from (
      select p.method::text as method, sum(p.amount_cents)::bigint as s, count(*) as n
        from public.payments p
       where p.restaurant_id = p_restaurant and p.status = 'PAID'
         and p.paid_at >= p_from and p.paid_at < p_to
       group by 1
    ) x;

  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_tz),
    'orders_count', v_orders,
    'gross_orders_count', v_gross_n,
    'gross_sales_cents', v_gross,
    'completed_sales_cents', v_completed,
    'avg_ticket_cents', case when v_gross_n = 0 then 0 else round(v_gross::numeric / v_gross_n)::bigint end,
    'in_progress_orders', v_in_progress,
    'open_tabs', v_open_tabs,
    'occupied_tables', v_occupied,
    'tables_total', v_tables,
    'cancelled_count', v_cancelled,
    'rejected_count', v_rejected,
    'by_fulfillment', coalesce(v_by_ful, '[]'::jsonb),
    'top_products', v_top,
    'sales_series', v_series,
    'payment_methods', v_pay
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- restaurant_report
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_report(
  p_restaurant uuid,
  p_report     text,
  p_from       timestamptz,
  p_to         timestamptz,
  p_group      text default 'day'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz        text;
  v_report    text := lower(btrim(coalesce(p_report, '')));
  v_unit      text := lower(btrim(coalesce(nullif(btrim(p_group), ''), 'day')));
  v_step      interval;
  v_cols      jsonb;
  v_rows      jsonb;
  v_totals    jsonb;
  v_truncated boolean := false;
begin
  perform app_private.require_perm(p_restaurant, 'reports.view', 'RESTAURANT_NOT_FOUND');
  if v_report not in ('sales_by_period', 'orders_by_fulfillment', 'top_products', 'avg_ticket',
                      'cancellations', 'fees_discounts', 'payment_methods') then
    raise exception 'INVALID_REPORT: relatório desconhecido' using errcode = '22023';
  end if;
  if v_unit not in ('day', 'week', 'month') then
    raise exception 'INVALID_GROUP: agrupamento deve ser day, week ou month' using errcode = '22023';
  end if;
  perform app_private.check_period(p_from, p_to);
  v_tz := app_private.report_tz(p_restaurant);
  v_step := case v_unit when 'day' then interval '1 day' when 'week' then interval '1 week' else interval '1 month' end;

  if v_report in ('sales_by_period', 'avg_ticket', 'fees_discounts') then
    -- Série completa de buckets (inclui períodos sem pedidos, com zeros).
    select coalesce(jsonb_agg(to_jsonb(r) order by r.period), '[]'::jsonb)
      into v_rows
      from (
        select b.period,
               coalesce(a.orders, 0)                 as orders,
               coalesce(a.sales_cents, 0)            as sales_cents,
               case when coalesce(a.orders, 0) = 0 then 0
                    else round(a.sales_cents::numeric / a.orders)::bigint end as avg_ticket_cents,
               coalesce(a.completed_sales_cents, 0)  as completed_sales_cents,
               coalesce(a.cancelled_count, 0)        as cancelled_count,
               coalesce(a.subtotal_cents, 0)         as subtotal_cents,
               coalesce(a.delivery_fee_cents, 0)     as delivery_fee_cents,
               coalesce(a.discount_cents, 0)         as discount_cents
          from (
            select d::date as period
              from generate_series(date_trunc(v_unit, p_from at time zone v_tz),
                                   (p_to - interval '1 microsecond') at time zone v_tz,
                                   v_step) d
             limit 5001
          ) b
          left join (
            select date_trunc(v_unit, o.created_at at time zone v_tz)::date as period,
                   count(*) filter (where o.status not in ('CANCELLED', 'REJECTED'))::bigint as orders,
                   coalesce(sum(o.total_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0)::bigint as sales_cents,
                   coalesce(sum(o.total_cents) filter (where o.status = 'COMPLETED'), 0)::bigint as completed_sales_cents,
                   count(*) filter (where o.status in ('CANCELLED', 'REJECTED'))::bigint as cancelled_count,
                   coalesce(sum(o.subtotal_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0)::bigint as subtotal_cents,
                   coalesce(sum(o.delivery_fee_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0)::bigint as delivery_fee_cents,
                   coalesce(sum(o.discount_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0)::bigint as discount_cents
              from public.orders o
             where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
             group by 1
          ) a on a.period = b.period
      ) r;

    select jsonb_build_object(
             'orders', count(*) filter (where o.status not in ('CANCELLED', 'REJECTED')),
             'sales_cents', coalesce(sum(o.total_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0),
             'avg_ticket_cents',
               case when count(*) filter (where o.status not in ('CANCELLED', 'REJECTED')) = 0 then 0
                    else round((sum(o.total_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')))::numeric
                               / (count(*) filter (where o.status not in ('CANCELLED', 'REJECTED'))))::bigint end,
             'completed_sales_cents', coalesce(sum(o.total_cents) filter (where o.status = 'COMPLETED'), 0),
             'cancelled_count', count(*) filter (where o.status in ('CANCELLED', 'REJECTED')),
             'subtotal_cents', coalesce(sum(o.subtotal_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0),
             'delivery_fee_cents', coalesce(sum(o.delivery_fee_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0),
             'discount_cents', coalesce(sum(o.discount_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0))
      into v_totals
      from public.orders o
     where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to;

    if v_report = 'sales_by_period' then
      v_cols := '[{"key":"period","label":"Período","type":"date"},{"key":"orders","label":"Pedidos","type":"integer"},
                  {"key":"sales_cents","label":"Faturamento bruto","type":"cents"},
                  {"key":"completed_sales_cents","label":"Concluídos","type":"cents"},
                  {"key":"avg_ticket_cents","label":"Ticket médio","type":"cents"},
                  {"key":"cancelled_count","label":"Cancelados/recusados","type":"integer"}]'::jsonb;
      select coalesce(jsonb_agg(e - 'subtotal_cents' - 'delivery_fee_cents' - 'discount_cents'), '[]'::jsonb)
        into v_rows from jsonb_array_elements(v_rows) e;
      v_totals := v_totals - 'subtotal_cents' - 'delivery_fee_cents' - 'discount_cents';
    elsif v_report = 'avg_ticket' then
      v_cols := '[{"key":"period","label":"Período","type":"date"},{"key":"orders","label":"Pedidos","type":"integer"},
                  {"key":"sales_cents","label":"Faturamento bruto","type":"cents"},
                  {"key":"avg_ticket_cents","label":"Ticket médio","type":"cents"}]'::jsonb;
      select coalesce(jsonb_agg(jsonb_build_object('period', e->'period', 'orders', e->'orders',
                                                   'sales_cents', e->'sales_cents',
                                                   'avg_ticket_cents', e->'avg_ticket_cents')), '[]'::jsonb)
        into v_rows from jsonb_array_elements(v_rows) e;
      v_totals := jsonb_build_object('orders', v_totals->'orders', 'sales_cents', v_totals->'sales_cents',
                                     'avg_ticket_cents', v_totals->'avg_ticket_cents');
    else
      v_cols := '[{"key":"period","label":"Período","type":"date"},{"key":"orders","label":"Pedidos","type":"integer"},
                  {"key":"subtotal_cents","label":"Subtotal","type":"cents"},
                  {"key":"delivery_fee_cents","label":"Taxas de entrega","type":"cents"},
                  {"key":"discount_cents","label":"Descontos","type":"cents"},
                  {"key":"sales_cents","label":"Total","type":"cents"}]'::jsonb;
      select coalesce(jsonb_agg(jsonb_build_object('period', e->'period', 'orders', e->'orders',
                                                   'subtotal_cents', e->'subtotal_cents',
                                                   'delivery_fee_cents', e->'delivery_fee_cents',
                                                   'discount_cents', e->'discount_cents',
                                                   'sales_cents', e->'sales_cents')), '[]'::jsonb)
        into v_rows from jsonb_array_elements(v_rows) e;
      v_totals := jsonb_build_object('orders', v_totals->'orders', 'subtotal_cents', v_totals->'subtotal_cents',
                                     'delivery_fee_cents', v_totals->'delivery_fee_cents',
                                     'discount_cents', v_totals->'discount_cents',
                                     'sales_cents', v_totals->'sales_cents');
    end if;

  elsif v_report = 'orders_by_fulfillment' then
    v_cols := '[{"key":"type","label":"Tipo","type":"text"},{"key":"orders","label":"Pedidos","type":"integer"},
                {"key":"sales_cents","label":"Faturamento bruto","type":"cents"},
                {"key":"avg_ticket_cents","label":"Ticket médio","type":"cents"}]'::jsonb;
    select coalesce(jsonb_agg(to_jsonb(r) order by r.ord), '[]'::jsonb)
      into v_rows
      from (
        select t.type, t.ord, coalesce(a.n, 0) as orders, coalesce(a.s, 0) as sales_cents,
               case when coalesce(a.n, 0) = 0 then 0 else round(a.s::numeric / a.n)::bigint end as avg_ticket_cents
          from (values ('DELIVERY', 1), ('PICKUP', 2), ('DINE_IN', 3)) as t(type, ord)
          left join (
            select o.fulfillment_type::text as ft, count(*)::bigint as n, sum(o.total_cents)::bigint as s
              from public.orders o
             where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
               and o.status not in ('CANCELLED', 'REJECTED')
             group by 1
          ) a on a.ft = t.type
      ) r;
    select coalesce(jsonb_agg(e - 'ord'), '[]'::jsonb) into v_rows from jsonb_array_elements(v_rows) e;
    select jsonb_build_object('orders', coalesce(sum((e->>'orders')::bigint), 0),
                              'sales_cents', coalesce(sum((e->>'sales_cents')::bigint), 0),
                              'avg_ticket_cents',
                                case when coalesce(sum((e->>'orders')::bigint), 0) = 0 then 0
                                     else round(sum((e->>'sales_cents')::bigint)::numeric / sum((e->>'orders')::bigint))::bigint end)
      into v_totals from jsonb_array_elements(v_rows) e;

  elsif v_report = 'top_products' then
    v_cols := '[{"key":"name","label":"Produto","type":"text"},{"key":"variant","label":"Variante","type":"text"},
                {"key":"quantity","label":"Quantidade","type":"integer"},
                {"key":"sales_cents","label":"Faturamento","type":"cents"}]'::jsonb;
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
      into v_rows
      from (
        select oi.product_name as name, oi.variant_name_snapshot as variant,
               sum(oi.quantity)::bigint as quantity, sum(oi.line_total_cents)::bigint as sales_cents
          from public.orders o
          join public.order_items oi on oi.restaurant_id = o.restaurant_id and oi.order_id = o.id
         where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
           and o.status not in ('CANCELLED', 'REJECTED')
         group by oi.product_name, oi.variant_name_snapshot
         order by sales_cents desc, quantity desc, oi.product_name, oi.variant_name_snapshot nulls first
         limit 5001
      ) r;
    select jsonb_build_object('quantity', coalesce(sum(oi.quantity), 0), 'sales_cents', coalesce(sum(oi.line_total_cents), 0))
      into v_totals
      from public.orders o
      join public.order_items oi on oi.restaurant_id = o.restaurant_id and oi.order_id = o.id
     where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
       and o.status not in ('CANCELLED', 'REJECTED');

  elsif v_report = 'cancellations' then
    v_cols := '[{"key":"status","label":"Situação","type":"text"},{"key":"reason","label":"Motivo","type":"text"},
                {"key":"count","label":"Pedidos","type":"integer"},
                {"key":"lost_sales_cents","label":"Valor perdido","type":"cents"}]'::jsonb;
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
      into v_rows
      from (
        select x.status, x.reason, sum(x.cnt)::bigint as count, sum(x.lost)::bigint as lost_sales_cents
          from (
            -- agrupa pelo texto bruto primeiro (barato) e saneia só os valores distintos
            select g.status, g.cnt, g.lost,
                   coalesce(nullif(left(btrim(
                     regexp_replace(
                       regexp_replace(
                         regexp_replace(g.raw, '[[:cntrl:]]+', ' ', 'g'),
                         '[^[:space:]@]+@[^[:space:]@]+', '[e-mail]', 'g'),
                       '[0-9][0-9 ().+-]{4,}[0-9]', '[número]', 'g')), 80), ''), '(sem motivo)') as reason
              from (
                select o.status::text as status, left(coalesce(o.status_reason, ''), 300) as raw,
                       count(*) as cnt, sum(o.total_cents) as lost
                  from public.orders o
                 where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
                   and o.status in ('CANCELLED', 'REJECTED')
                 group by 1, 2
              ) g
          ) x
         group by x.status, x.reason
         order by count desc, x.status, x.reason
         limit 5001
      ) r;
    select jsonb_build_object('cancelled_count', count(*) filter (where o.status = 'CANCELLED'),
                              'rejected_count', count(*) filter (where o.status = 'REJECTED'),
                              'count', count(*), 'lost_sales_cents', coalesce(sum(o.total_cents), 0))
      into v_totals
      from public.orders o
     where o.restaurant_id = p_restaurant and o.created_at >= p_from and o.created_at < p_to
       and o.status in ('CANCELLED', 'REJECTED');

  else -- payment_methods
    v_cols := '[{"key":"method","label":"Forma","type":"text"},{"key":"count","label":"Pagamentos","type":"integer"},
                {"key":"amount_cents","label":"Valor","type":"cents"}]'::jsonb;
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
      into v_rows
      from (
        select p.method::text as method, count(*)::bigint as count, sum(p.amount_cents)::bigint as amount_cents
          from public.payments p
         where p.restaurant_id = p_restaurant and p.status = 'PAID'
           and p.paid_at >= p_from and p.paid_at < p_to
         group by 1
         order by amount_cents desc, method
         limit 5001
      ) r;
    select jsonb_build_object('count', count(*), 'amount_cents', coalesce(sum(p.amount_cents), 0))
      into v_totals
      from public.payments p
     where p.restaurant_id = p_restaurant and p.status = 'PAID'
       and p.paid_at >= p_from and p.paid_at < p_to;
  end if;

  if jsonb_array_length(v_rows) > 5000 then
    v_truncated := true;
    v_rows := v_rows - 5000;
  end if;

  return jsonb_build_object(
    'report', v_report,
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_tz, 'group', v_unit),
    'columns', v_cols,
    'rows', v_rows,
    'totals', v_totals,
    'truncated', v_truncated
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.dashboard_metrics(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.restaurant_report(uuid, text, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.dashboard_metrics(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.restaurant_report(uuid, text, timestamptz, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Índices de apoio
-- ---------------------------------------------------------------------------
-- payments por paid_at (métodos de pagamento na janela).
create index if not exists payments_restaurant_paid_idx
  on public.payments (restaurant_id, paid_at) where status = 'PAID';
-- agregados por cliente (list_customers/get_customer) com data.
create index if not exists orders_restaurant_customer_created_idx
  on public.orders (restaurant_id, customer_id, created_at desc) where customer_id is not null;
-- keyset da auditoria (created_at desc, id desc).
create index if not exists audit_logs_restaurant_created_id_idx
  on public.audit_logs (restaurant_id, created_at desc, id desc);
