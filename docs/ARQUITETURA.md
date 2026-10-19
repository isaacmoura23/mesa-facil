# Mesa Fácil (nome provisório) — estrutura do SaaS e planejamento

Atualizado em 2026-10-16. Estado: Fases 1–4 concluídas e commitadas; Fase 5 em andamento.

## 1. Visão geral

SaaS web multi-tenant para restaurantes. Uma aplicação Next.js 16 (App Router, TypeScript estrito, Tailwind 4) sobre Supabase (Auth, Postgres com RLS,
Storage, Realtime). Regras de negócio críticas ficam no banco (funções SQL `SECURITY DEFINER`), a UI nunca é a autoridade.
Quatro ambientes + API pública:

| Ambiente | Rota | Quem usa | Natureza |
|---|---|---|---|
| Site/Auth | `/`, `/planos`, `/login`, `/cadastro`, `/entrar` | visitantes | institucional + entrada |
| Vitrine padrão | `/r/[slug]/…` | cliente final | cardápio, carrinho, checkout, acompanhamento |
| Operação | `/operacao/[slug]/…` | caixa, garçom, cozinha, gerente | opera pedidos, mesas, comandas, pagamento, impressão |
| Painel do dono | `/app/[slug]/…` | dono e gerente | gestão + monitoramento somente leitura |
| Plataforma | `/platform/…` | superadmin/suporte | gestão do SaaS (Fase 6) |
| API pública | `/api/public/v1/restaurants/{slug}/…` | vitrines personalizadas (sites dos clientes) | cardápio, cotação, pedidos, acompanhamento |

Vitrines próprias (ex.: La Pastelaria, O Nailton) são sites separados do dono da plataforma que consomem a API pública (SDK em `sdk/`).

## 2. Páginas e estado

| Área | Página | Estado |
|---|---|---|
| Auth/site | login, cadastro, entrar (convites, seletor de restaurante), sem-acesso, home, planos | pronto |
| Vitrine `/r` | cardápio, produto (variantes/adicionais), checkout, acompanhamento do pedido | pronto |
| Operação | pedidos (tempo real, som), cozinha, histórico (CSV), mesas, comandas + detalhe (itens, pagamento, conta, fechamento) | pronto |
| Dono `/app` | cardápio, mesas (cadastro), comandas (leitura + CSV), restaurante (contato/vitrine/domínios da API) | pronto (parcial em `restaurante`) |
| Dono `/app` | dashboard, pedidos (monitoramento), clientes, relatórios, equipe, configurações | Fase 5 (em andamento) |
| Plataforma | dashboard, restaurantes, planos, assinaturas, suporte, auditoria, configurações | Fase 6 (placeholders) |

## 3. Papéis e permissões

Papéis: `owner`, `manager`, `cashier`, `kitchen`, `waiter` (restaurante) e `superadmin`/`support` (plataforma).
Permissões granulares (`orders.*`, `menu.manage`, `tables.*`, `tabs.*`, `payments.record`, `print.request`, `reports.view`, `team.manage`,
`restaurant.settings.manage`) em `role_permissions` + overrides por membro. **O dono nunca recebe permissão operacional**: monitora em leitura;
a equipe opera. Superadmin só acessa dados de um restaurante via sessão de suporte justificada (temporária, somente leitura, auditada).

## 4. Banco (Supabase local, 37 migrações, 35 tabelas, 53 funções DEFINER)

- Identidade/tenancy: `profiles`, `restaurants`, `restaurant_memberships`, `platform_admins`, `permissions`, `role_permissions`, `membership_permission_overrides`,
  `audit_logs` (imutável), `plans`, `subscriptions`, `support_sessions`, `support_tickets`.
- Cardápio: `menu_categories`, `products`, `product_variants`, `modifier_groups`, `modifiers`, `product_modifier_groups`.
- Operação: `restaurant_settings`, `business_hours`, `business_hour_exceptions`, `delivery_zones`, `customers`, `customer_addresses`,
  `restaurant_tables`, `tabs`, `orders`, `order_items`, `order_item_modifiers`, `order_status_history`, `order_status_transitions`, `payments`, `print_jobs`.
- RPCs principais: `public_menu`, `validate_cart`, `create_public_order` (só servidor, idempotente), `track_order`, `transition_order_status`,
  `request_print`/`mark_print_job`, `open_tab`, `create_staff_order` (idempotente), `get_tab_balance`, `record_payment`, `close_tab`, `cancel_tab`,
  `set_table_status`, `request_tab_print`, `reorder_menu`, equipe/suporte (`invite_member`, `change_member_role`, `open_support_session`…).
- Cálculo de preço único: `app_private.price_cart_core` (público e equipe compartilham a mesma regra).
- Segurança: RLS + FORCE em todas as tabelas; escritas sensíveis só por RPC (UPDATE/INSERT direto bloqueado em `tabs` e estado de mesa);
  grants por coluna; `storefront_origins` invisível aos clientes; Storage com policy por restaurante.

## 5. Código (`src/`)

Módulos por domínio, cada um com schemas (zod), queries/actions e componentes:
`menu`, `restaurant-profile`, `storefront`, `orders-server`, `public-api`, `operations`, `printing`, `tables`, `tab-billing`, `tables-admin`
(+ Fase 5: `team`, `restaurant-settings`, `dashboard`, `reports`, `customers`). Autorização no servidor: `src/lib/auth/guards.ts`
(`requireRestaurantAccess(slug, {area, permission})`); o `slug` só escolhe o vínculo, nunca concede acesso. `src/proxy.ts` renova a sessão (fora da API pública).
SDK independente em `sdk/` (`createStorefrontClient`: `getMenu`, `quoteCart`, `createOrder`, `trackOrder`).

## 6. Fluxos prontos de ponta a ponta

1. Cliente (vitrine ou site próprio) → carrinho → cotação no servidor → pedido (idempotente) → acompanhamento por código.
2. Equipe recebe em tempo real (som) → aceita/recusa com motivo → cozinha prepara → entrega/retirada → concluído; impressão térmica 80/58 mm.
3. Salão: mesa → comanda → pedidos de salão (vão à cozinha) → pagamentos parciais com troco → conta parcial/final → fechamento (justificativa se houver saldo) → mesa em limpeza → liberada.
4. Dono: cardápio, mesas, monitoramento de comandas (CSV), contato/vitrine/domínios autorizados.

## 7. Qualidade

≈1.350 testes (unitários + integração RLS/RPC/concorrência/Realtime + API HTTP) contra o Supabase real; `typecheck`, `lint` (0 erros) e `build` passam.
Achados de segurança e consistência documentados em `tests/FINDINGS.md` (bugs menores abertos: F-17, F-20, F-24, F-29/F-30, F-35, F-37 a F-40).

## 8. Planejamento

| Fase | Conteúdo | Situação |
|---|---|---|
| 1 | Fundação, auth, RLS, layouts, isolamento | concluída |
| 2 + 2.5 | Cardápio, vitrine, API pública + SDK, variantes, importação dos pilotos | concluída |
| 3 | Pedidos reais, tempo real, cozinha, histórico, impressão | concluída |
| 4 | Mesas, comandas, pagamento manual, conta, fechamento | concluída |
| 5 | Dashboard, monitoramento, clientes, relatórios (CSV), equipe, configurações | em andamento (leva 1: banco, equipe, configurações; leva 2: dashboard, relatórios, clientes) |
| 6 | Plataforma: restaurantes, planos/assinaturas, suporte (sessão justificada), auditoria, configurações globais | pendente |
| 7 | Validação final: E2E de ponta a ponta (3 modalidades), responsividade, segurança, README/instalação, relatório | pendente |
| Backlog | corrigir bugs menores; confirmação de e-mail em produção; limite de requisições compartilhado (Upstash/KV); impressão silenciosa (integração local); divisão de conta e taxa de serviço; pagamento online; deploy na nuvem (Supabase + Vercel); recuperação de senha | a decidir |

## 9. Limitações conhecidas

- Nenhum teste em impressora térmica física; `window.print()` real só foi simulado.
- Nunca testado `supabase db reset` do zero (CLI bloqueado no Windows); migrações aplicadas em sequência.
- Pagamento é registro manual (sem provedor online); sem nota fiscal.
- Limite de requisições da API é por instância (em memória).
- Ainda não implantado na nuvem; tudo roda no Supabase local (Docker).
