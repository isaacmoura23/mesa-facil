-- =============================================================================
-- seed.sql · Apenas dados de catálogo (planos). Sem usuários, restaurantes ou pedidos.
-- Idempotente: pode rodar várias vezes (db reset ou execução manual).
-- Valores em centavos (BRL). limits/features são lidos pelo app para aplicar cotas.
-- =============================================================================

insert into public.plans
  (code, name, description, price_cents, currency, billing_interval, limits, features, is_active, sort_order)
values
  (
    'basico',
    'Básico',
    'Para restaurantes que estão começando: cardápio digital, pedidos e comandas.',
    9900, 'BRL', 'month',
    '{"max_members": 5, "max_tables": 20, "max_menu_items": 150, "max_print_jobs_per_month": 2000}'::jsonb,
    '{"public_menu": true, "table_orders": true, "tabs": true, "reports_basic": true, "reports_advanced": false, "support": "email"}'::jsonb,
    true, 10
  ),
  (
    'profissional',
    'Profissional',
    'Para operações com equipe maior: mais mesas, relatórios avançados e suporte prioritário.',
    19900, 'BRL', 'month',
    '{"max_members": 25, "max_tables": 100, "max_menu_items": 1000, "max_print_jobs_per_month": 20000}'::jsonb,
    '{"public_menu": true, "table_orders": true, "tabs": true, "reports_basic": true, "reports_advanced": true, "support": "priority"}'::jsonb,
    true, 20
  )
on conflict (code) do update set
  name             = excluded.name,
  description      = excluded.description,
  price_cents      = excluded.price_cents,
  currency         = excluded.currency,
  billing_interval = excluded.billing_interval,
  limits           = excluded.limits,
  features         = excluded.features,
  is_active        = excluded.is_active,
  sort_order       = excluded.sort_order;
