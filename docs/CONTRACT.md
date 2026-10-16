# Contrato de arquitetura (fonte única para todos os módulos)

Produto provisório: **Mesa Fácil** (nome configurável em `src/config/brand.ts`).
Idioma da UI: PT-BR. Moeda: BRL, valores em centavos (int). Fuso padrão: `America/Sao_Paulo`.

## Papéis e status

- `restaurant_role` (enum): `owner`, `manager`, `cashier`, `kitchen`, `waiter`
- `membership_status` (enum): `invited`, `active`, `revoked`
- `restaurant_status` (enum): `pending`, `active`, `suspended`
- `platform_admin_role` (enum): `superadmin`, `support`

## Permissões (texto, tabela `permissions` como catálogo)

`orders.view`, `orders.create`, `orders.accept`, `orders.reject`, `orders.update_status`, `orders.cancel`,
`menu.manage`, `tables.view`, `tables.manage` (configurar/cadastrar mesas), `tables.operate` (mudar estado operacional),
`tabs.view`, `tabs.manage`, `payments.record`, `print.request`, `reports.view`, `team.manage`, `restaurant.settings.manage`

### Matriz padrão (tabela `role_permissions`)

| Permissão | owner | manager | cashier | kitchen | waiter |
|---|---|---|---|---|---|
| orders.view | ✔ (somente leitura) | ✔ | ✔ | ✔ | ✔ |
| orders.create | – | ✔ | ✔ | – | ✔ |
| orders.accept / reject | – | ✔ | ✔ | – | – |
| orders.update_status | – | ✔ | ✔ | ✔ | – |
| orders.cancel | – | ✔ | – | – | – |
| menu.manage | ✔ | ✔ | – | – | – |
| tables.view | ✔ | ✔ | ✔ | – | ✔ |
| tables.manage | ✔ | ✔ | – | – | – |
| tables.operate | – | ✔ | ✔ | – | ✔ |
| tabs.view | ✔ (somente leitura) | ✔ | ✔ | – | ✔ |
| tabs.manage | – | ✔ | ✔ | – | ✔ |
| payments.record | – | ✔ | ✔ | – | – |
| print.request | – | ✔ | ✔ | ✔ | ✔ |
| reports.view | ✔ | ✔ | – | – | – |
| team.manage | ✔ | – | – | – | – |
| restaurant.settings.manage | ✔ | ✔ | – | – | – |

**Regra de separação:** o papel `owner` NUNCA recebe permissões operacionais (`orders.create|accept|reject|update_status|cancel`,
`tables.operate`, `tabs.manage`, `payments.record`, `print.request`), nem por override. O dono atribui/revoga permissões
operacionais apenas a membros não-owner via `membership_permission_overrides`.

## Funções SQL de apoio (schema `public`, STABLE, `SECURITY DEFINER`, `search_path = ''` ou fixo)

- `is_platform_admin() returns boolean`
- `is_member(rid uuid) returns boolean` — vínculo `active` do `auth.uid()` e restaurante não `suspended` (ou admin ver abaixo)
- `has_permission(rid uuid, perm text) returns boolean` — role_permissions + overrides, vínculo ativo
- `has_support_access(rid uuid) returns boolean` — existe `support_sessions` ativa (não expirada, não encerrada) do `auth.uid()` para `rid`; **só concede SELECT**
- `my_permissions(rid uuid) returns text[]`
- `my_restaurants() returns table(restaurant_id, slug, name, role, status)`
- `resolve_restaurant_by_slug(p_slug text)` — retorna `id`, `slug`, `name`, `status`, `logo_path` apenas de restaurantes `active` (uso público)

Tabelas de políticas usam `restaurant_id` + estas funções. **Nunca** confiar em `restaurant_id` vindo do cliente sem `has_permission`/`is_member`.

## RPCs de negócio (SECURITY DEFINER, validam `auth.uid()` e permissão dentro da função)

Fase 1 (identidade/equipe): `create_restaurant(p_name, p_slug, p_owner_id)` (apenas platform admin), `register_restaurant(p_name, p_slug)`
(usuário autenticado, cria restaurante `pending`), `invite_member(p_restaurant, p_email, p_role)`, `change_member_role`, `revoke_member`,
`set_member_permission(p_membership, p_permission, p_granted)`, `open_support_session(p_restaurant, p_reason, p_minutes)`, `close_support_session`.
Fase 2+ : `create_public_order`, `transition_order_status`, `open_tab`, `close_tab`, `record_payment`, `request_print`.

## Divisão de arquivos (nenhum agente edita arquivo de outro)

- **DB-1** (identidade/tenancy): `supabase/migrations/2026010100NNNN_*.sql` com NNNN < 0100, `supabase/seed.sql` (somente planos), `supabase/config.toml`.
- **DB-2** (domínio): `supabase/migrations/2026010100NNNN_*.sql` com NNNN ≥ 0100. Depende das funções acima. Tabelas: cardápio, clientes, mesas, comandas, pedidos, pagamentos, horários, zonas, print_jobs, histórico de status; Storage policies; Realtime publication.
- **APP**: `src/**`, `next.config.ts`, `.env.example`, `src/config/brand.ts`.
- **TESTS** (depois dos DBs): `tests/**`, `scripts/**`, `vitest.config.ts`.
- Raiz (`package.json`, `docs/`, `README.md`): coordenador (eu).

## Rotas (ver prompt original). `slug` apenas identifica; autorização sempre vem de membership/permissão.

---

# Fase 2 — Cardápio (contrato)

Helpers compartilhados (já existem, não reimplementar): `src/lib/format.ts` (`formatCents`, `parseToCents`),
`src/lib/storage.ts` (`publicImageUrl(path)`), `next.config.ts` já libera imagens do Storage (`images.remotePatterns`).
Caminhos de imagem: `restaurants/{restaurant_id}/products/{arquivo}` e `restaurants/{restaurant_id}/logo/{arquivo}` (CHECK no banco, sem `..`).
Bucket `restaurant-public`: 5 MB, jpeg/png/webp/avif.

## RPCs novas (DB-3, migrações `20260101000112+`, anon + authenticated, somente leitura, SECURITY DEFINER, search_path fixo)

- `public_menu(p_slug text) returns jsonb` — restaurante `active`; devolve `{restaurant:{id?,name,slug,logo_path,timezone}, settings:{...públicos}, is_open_now, categories:[{id,name,sort_order,products:[{id,name,description,price_cents,image_path,is_available,modifier_groups:[{id,name,min_selections,max_selections,modifiers:[{id,name,price_delta_cents,is_available}]}]}]}]}` — só itens ativos, ordenados por `sort_order`. Não expõe dados privados.
- `validate_cart(p_slug text, p_fulfillment text, p_items jsonb, p_delivery_zone_id uuid default null) returns jsonb` — NÃO grava nada. Entrada `p_items: [{product_id, quantity, modifier_ids:[uuid], notes?}]`. Recalcula tudo no servidor; devolve `{ok, errors:[{code,item_index?,message}], items:[{product_id,name,unit_price_cents,quantity,modifiers:[{id,name,price_delta_cents}],line_total_cents}], subtotal_cents, delivery_fee_cents, discount_cents, total_cents, minimum_order_cents}`. Erros: `RESTAURANT_UNAVAILABLE`, `RESTAURANT_CLOSED`, `FULFILLMENT_DISABLED`, `PRODUCT_UNAVAILABLE`, `MODIFIER_UNAVAILABLE`, `MODIFIER_NOT_ALLOWED`, `MODIFIER_GROUP_MIN`, `MODIFIER_GROUP_MAX`, `INVALID_QUANTITY`, `BELOW_MINIMUM`, `ZONE_REQUIRED`, `ZONE_UNAVAILABLE`, `EMPTY_CART`. Esta lógica será reaproveitada por `create_public_order` na Fase 3 (extrair função interna `app_private.price_cart`).
- Admin do cardápio usa as tabelas diretamente (RLS `menu.manage`) + RPC `reorder_menu(p_restaurant uuid, p_kind text, p_ids uuid[])` (`p_kind` em `category|product|modifier_group|modifier`; exige `menu.manage`; reordena atômico).

## Divisão (sem sobreposição)

- **DB-3**: `supabase/migrations/20260101000112+`.
- **ADMIN**: `src/app/app/[slug]/cardapio/**`, `src/modules/menu/**`, `src/components/menu-admin/**`.
- **PUBLIC**: `src/app/r/**`, `src/modules/storefront/**`, `src/components/storefront/**`.
- **TESTS**: `tests/**`, `scripts/**` (depois dos demais).
- Compartilhado (só leitura para agentes): `src/components/ui/**`, `src/lib/**`, `src/config/**`. Se precisar de mudança ali, pedir ao coordenador no relatório (ou criar arquivo novo próprio do módulo).

---

# Etapa 2.5 — SaaS headless (vitrines personalizadas)

Decisão de produto: cada cliente pode ter uma vitrine própria (site separado, ex.: la-pastelaria.vercel.app, onailton.vercel.app)
desenvolvida pelo dono da plataforma e SEMPRE vinculada ao SaaS (cardápio, preços, horários, pedidos). O dono do restaurante
edita tudo no painel; a vitrine só lê e cria pedidos via **API pública**. `/r/[slug]` continua como vitrine padrão.
As vitrines nunca recebem chaves do Supabase.

## Mudanças de dados (DB-4, migrações `20260101000113+`)

- `product_variants(id, restaurant_id, product_id, name, price_cents, sort_order, is_available, is_default, is_active)` — tamanhos (P/G, M/G…), FK composta, RLS como `products` (leitura pública de ativos em restaurante `active`; escrita `menu.manage`). Produto COM variantes: `variant_id` é obrigatório no carrinho e o preço base vem da variante. Produto sem variantes: comportamento atual.
- `products.badges text[]` (valores permitidos por CHECK: `NEW`, `POPULAR`, `REGIONAL`, `SWEET`, `SPICY`, `VEGETARIAN`).
- `order_items.variant_id` (nullable, FK composta, ON DELETE SET NULL) e `order_items.variant_name_snapshot`.
- `restaurant_settings`: `whatsapp text`, `phone text`, `address_text text`, `storefront_origins text[]` (origens https completas permitidas pelo CORS; validação de formato por CHECK; máx. 5), `storefront_url text`.
- `public_menu` passa a devolver: `restaurant.contact:{whatsapp,phone,address_text}`, `restaurant.storefront_url`, por produto `badges[]` e `variants:[{id,name,price_cents,is_available,is_default}]`; `price_cents` do produto com variantes = menor preço entre variantes disponíveis (exibir "a partir de").
- `validate_cart`/`app_private.price_cart`: item aceita `variant_id`; novos erros `VARIANT_REQUIRED`, `VARIANT_UNAVAILABLE`, `VARIANT_NOT_ALLOWED` (variante de outro produto/restaurante ou produto sem variantes). Item de saída ganha `variant:{id,name,price_cents}|null`.
- RPC pública `public.storefront_origins(p_slug text) returns text[]` (anon; só restaurante `active`) para o CORS da API.

## API pública v1 (`src/app/api/public/v1/**`, handlers Next.js; JSON camelCase; envelope `{data}` ou `{error:{code,message}}`)

- `GET  /api/public/v1/restaurants/{slug}/menu`
- `POST /api/public/v1/restaurants/{slug}/cart/quote` body `{fulfillmentType, items:[{productId, variantId?, quantity, modifierIds?, notes?}], deliveryZoneId?}`
- (Fase 3) `POST .../orders`, `GET .../orders/{publicCode}` — NÃO implementar agora.
- CORS por restaurante: `Access-Control-Allow-Origin` só para origens em `storefront_origins` (resposta ao preflight `OPTIONS` inclusive); em desenvolvimento (`NODE_ENV!=='production'`) também `http://localhost:*` e `http://127.0.0.1:*`. Sem `Allow-Credentials`. `Vary: Origin`.
- Limite de requisições por IP+slug (janela deslizante em memória; documentar a limitação em serverless), corpo ≤ 64 KB, validação zod, nunca vazar mensagens internas.
- Cache: menu `Cache-Control: public, s-maxage=30, stale-while-revalidate=60`; quote `no-store`.
- Códigos de erro HTTP: 400 `invalid_request`, 404 `restaurant_not_found`, 403 `origin_not_allowed` (só para requisições com Origin não permitida), 413, 429 `rate_limited`, 500 `internal_error`.

## SDK (`sdk/` na raiz do repo; pacote independente `@mesafacil/storefront-sdk`, só `fetch`, sem dependências, ESM + tipos)

`createStorefrontClient({ baseUrl, slug })` → `getMenu()`, `quoteCart(input)`, helpers `formatCents`, `lowestPrice(product)`, `isOpenNow(menu)`; erros tipados `StorefrontApiError {code,status}`. Exemplo de uso em `sdk/README.md`.

## Divisão

- **API** (agora): `src/app/api/public/**`, `src/modules/public-api/**`, `sdk/**`.
- **DB-4** (após TESTS da Fase 2): migrações `20260101000113+`.
- **ADMIN2** (após DB-4): variantes, selos, contato, origens e URL da vitrine em `/app/[slug]/cardapio` e `/app/[slug]/restaurante`.
- **PUBLIC2** (após DB-4): `/r/**` com variantes/selos/contato.
- **IMPORT** (após DB-4): `scripts/import-restaurants.ts` (La Pastelaria e O Nailton).

---

# Fase 3 — Pedidos, operação em tempo real e impressão (contrato)

Decisões: criação pública de pedido é **só por servidor** (`create_public_order` com EXECUTE apenas para `service_role`, chamada por
Route Handler/Server Action após rate limit por IP+slug e checagem de origem); acompanhamento por `public_code` é legível por anon
(80 bits, sem PII); pagamento online NÃO existe: o cliente declara a forma (`CASH`, `PIX`, `CARD`) a pagar na entrega/retirada, `payment_status` nasce `UNPAID`.
Reutiliza `app_private.price_cart` (única fonte de cálculo). Realtime só para equipe autenticada (anon acompanha por polling).

## RPCs (DB-5, migrações `20260101000114+`)

- `create_public_order(p_slug text, p_fulfillment text, p_items jsonb, p_customer jsonb /*{name,phone,email?}*/, p_address jsonb /*{street,number,neighborhood,city,postal_code?,complement?,instructions?}|null*/, p_delivery_zone_id uuid, p_notes text, p_idempotency_key text, p_payment jsonb /*{method:'CASH'|'PIX'|'CARD', change_for_cents?}*/) returns jsonb` — service_role apenas. Valida tudo via `price_cart` (erro → `{ok:false,errors}` sem gravar), upsert de `customers` por (restaurant, telefone normalizado), snapshot de endereço, `orders` + `order_items` + `order_item_modifiers` (snapshots de produto/variante/adicionais), status `RECEIVED`, `payment_status` `UNPAID`, `public_code` gerado, tudo numa transação; **idempotente** por (restaurant_id, idempotency_key): repetição devolve o mesmo pedido (`idempotent_replay:true`). Retorna `{ok:true, public_code, order_number, status, total_cents, ...}` (sem IDs internos de cliente).
- `track_order(p_slug text, p_public_code text) returns jsonb` — anon+authenticated; `null` se não existe; devolve restaurante (nome), `order_number`, `fulfillment_type`, `status`, `payment_status`, itens (nome/variante/adicionais/qtd/preço), totais, `status_history` [{to_status,at}] (sem `changed_by`), bairro apenas (sem telefone/endereço completo), `estimated_ready_at`, mensagem de recusa/cancelamento se houver motivo.
- `transition_order_status(p_order uuid, p_to text, p_reason text default null) returns jsonb` — authenticated; trava a linha (`FOR UPDATE`), usa a máquina de estados/permissões existentes (aceitar=orders.accept, recusar=orders.reject, cancelar=orders.cancel, demais=orders.update_status), motivo obrigatório em REJECTED/CANCELLED, retorna o pedido atualizado; idempotente se já estiver no estado pedido pelo mesmo caminho (retorna `{ok:true,unchanged:true}`). Códigos de erro estáveis já existentes (`ORDER_INVALID_TRANSITION`, `REASON_REQUIRED`, `FORBIDDEN`).
- `request_print(p_order uuid, p_document_type text) returns jsonb` — authenticated com `print.request` e acesso de leitura ao pedido; monta o payload no servidor (restaurante, nº, data/hora no fuso, modalidade, mesa/comanda, itens, variantes, adicionais, observações; sem dados desnecessários do cliente), grava `print_jobs` com status `REQUESTED` e `requested_by=auth.uid()` + audit; retorna `{job_id, payload}`. Remover INSERT direto de `print_jobs` pelo cliente (F-08).
- `mark_print_job(p_job uuid, p_status text)` — somente `DISPATCHED` (diálogo aberto) ou `FAILED` pelo solicitante; nunca `PRINTED`.
- Novas colunas em `orders`: `payment_method_intent text` (CASH|PIX|CARD) e `change_for_cents int` com CHECKs.
- Pausar/horário: reutilizar `restaurant_settings.accepts_orders` e `is_open_now` via `price_cart`.

## API pública v1 (acréscimo, ORDERS)

- `POST /api/public/v1/restaurants/{slug}/orders` (body: fulfillmentType, items, customer, address?, deliveryZoneId?, notes?, payment, idempotencyKey) → 201 `{data:{publicCode,orderNumber,status,totalCents,...}}`; erros 400/409/422/429; CORS e limites do restante da API; limite próprio mais estrito (ex.: 5 pedidos/10 min por IP+slug).
- `GET  /api/public/v1/restaurants/{slug}/orders/{publicCode}` → acompanhamento (`track_order`), `no-store`.
- SDK: `createOrder`, `trackOrder`. Vitrine padrão `/r/[slug]` usa Server Actions equivalentes (mesmas funções internas em `src/modules/orders-server/`).

## Painel operacional (OPS)

Telas `/operacao/[slug]/{pedidos,cozinha,historico}`; leitura direta das tabelas por RLS (`orders.view`) + RPC `transition_order_status`; Realtime filtrado por `restaurant_id` (canal por restaurante), carga inicial + refetch ao reconectar + dedupe por id; alerta sonoro configurável (volume/ligado, preferências em localStorage, desbloqueio de áudio por clique); impressão via `window.print()` + `@media print` (80 mm/58 mm). `/app/[slug]/pedidos` do dono continua SOMENTE leitura.

## Divisão

- **DB-5**: `supabase/migrations/20260101000114+`.
- **OPS-A**: `src/modules/operations/**`, `src/components/operations/**`, `src/app/operacao/[slug]/pedidos/**`.
- **ORDERS**: `src/modules/orders-server/**`, `src/modules/storefront/**`, `src/components/storefront/**`, `src/app/r/**`, `src/app/api/public/v1/restaurants/[slug]/orders/**`, `src/modules/public-api/**`, `sdk/**`.
- **OPS-B** (após OPS-A): `src/app/operacao/[slug]/{cozinha,historico}/**`, `src/modules/printing/**`, `src/components/printing/**`.
- **TESTS3** (por último): `tests/**`, `scripts/**`.

---

# Fase 4 — Mesas, comandas de consumo e pagamento manual (contrato)

Regras: estados separados (mesa AVAILABLE|OCCUPIED|CLEANING|INACTIVE; comanda OPEN|CLOSED|CANCELLED; pedido; pagamento). Uma comanda OPEN por mesa
(índice parcial já existente; `restaurant_settings.single_tab_per_table`). Pedido de salão = `fulfillment_type='DINE_IN'` ligado a `tab_id`
(mesa opcional: comanda de balcão com `label`). Pagamento é **registro manual** feito por equipe com `payments.record` (sem provedor online).
O dono NÃO opera: só lê comandas/mesas em `/app/[slug]`; cadastra/edita mesas (`tables.manage`). Pedido do salão nasce `CONFIRMED` (a equipe já aceitou) e vai para a cozinha.
Divisão de conta por pessoa e pagamento misto avançado ficam fora do MVP (vários pagamentos parciais na mesma comanda são permitidos).

## RPCs (DB-6, migrações `20260101000117+`; SECURITY DEFINER, `search_path=''`, authenticated; permissões validadas dentro; erros por exceção `CODIGO: texto`)

- `open_tab(p_restaurant uuid, p_table_id uuid default null, p_label text default null, p_guests int default null) returns jsonb` — `tabs.manage`; mesa deve estar AVAILABLE (ou CLEANING se o restaurante permitir? não: só AVAILABLE) e ativa; violação da regra → `TABLE_HAS_OPEN_TAB`/`TABLE_INACTIVE`; mesa vira OCCUPIED (triggers existentes); retorna a comanda.
- `create_staff_order(p_tab uuid, p_items jsonb /*como validate_cart: product_id,variant_id?,quantity,modifier_ids,notes?*/, p_notes text default null) returns jsonb` — `orders.create` + `tabs.manage`; comanda OPEN; recalcula via `price_cart` (ignora horário de funcionamento e `accepts_orders` para equipe, mas exige restaurante `active`, produtos/variantes/adicionais válidos); cria `orders` DINE_IN (`tab_id`, `table_label` snapshot, `source='STAFF'`), itens com snapshots, status `CONFIRMED`, histórico por `auth.uid()`; vários pedidos por comanda; devolve pedido + saldo da comanda.
- `get_tab_balance(p_tab uuid) returns jsonb` — `tabs.view`; `{tab, orders:[{id,order_number,status,total_cents}], consumed_cents (exclui cancelados/recusados), paid_cents (pagamentos PAID), remaining_cents, payments:[...]}`.
- `record_payment(p_tab uuid default null, p_order uuid default null, p_method text, p_amount_cents int, p_tendered_cents int default null, p_reference text default null) returns jsonb` — `payments.record`; exatamente um alvo; métodos CASH|PIX|CREDIT|DEBIT|VOUCHER|OTHER; valor > 0 e ≤ saldo restante (`OVERPAYMENT`); `p_tendered_cents` só CASH ≥ valor (troco calculado e retornado); status PAID; recalcula `payment_status` do pedido; idempotência opcional por `p_reference`; auditoria. Para pedidos DELIVERY/PICKUP também aceita `p_order` (pagamento na entrega/retirada).
- `close_tab(p_tab uuid, p_unpaid_reason text default null) returns jsonb` — `tabs.manage`; exige todos os pedidos em estado terminal ou cancelável (os ativos não-cancelados devem estar `COMPLETED`/`READY`... defina: todos `COMPLETED` ou `CANCELLED`/`REJECTED`; pedidos de salão ativos são concluídos automaticamente ao fechar? NÃO — erro `TAB_HAS_OPEN_ORDERS`), saldo zero (`TAB_UNPAID`) — exceção: com `p_unpaid_reason` (≥10 chars) e permissão `payments.record`+`tabs.manage` fecha com saldo e grava auditoria; calcula `total_cents`, `closed_at/closed_by`; mesa → CLEANING (se última comanda aberta da mesa).
- `cancel_tab(p_tab uuid, p_reason text)` — só comanda sem pedidos ativos/pagamentos; mesa volta AVAILABLE.
- `set_table_status(p_table uuid, p_to text) returns jsonb` — `tables.operate`: CLEANING→AVAILABLE; `tables.manage`: AVAILABLE↔INACTIVE; nunca com comanda aberta.
- `request_tab_print(p_tab uuid, p_document_type text /*PARTIAL_BILL|FINAL_BILL*/) returns jsonb` — `print.request`; payload montado no servidor (restaurante, comanda/mesa, data/hora local, pedidos e itens consolidados com variante/adicionais, subtotal, pagamentos registrados, saldo; sem telefone/e-mail); grava `print_jobs` REQUESTED; FINAL_BILL só se a comanda estiver OPEN ou CLOSED; `mark_print_job` já existe.
- F-03: `restaurant_tables.qr_token` deixa de ser gravável por clientes (gerado só no servidor; `rotate_table_qr(p_table)` com `tables.manage`).
- Realtime: `tabs`, `restaurant_tables`, `orders`, `payments` na publication (adicionar `payments` se faltar).

## UI

- **OPS-C1** `/operacao/[slug]/mesas` e `/comandas`: grade de mesas por estado (tempo real), abrir comanda, abrir comanda de balcão, abrir detalhe da comanda, liberar mesa limpa; detalhe da comanda com pedidos/itens, "Adicionar itens" (seletor de cardápio com variantes/adicionais → `create_staff_order`), e um slot `TabBillingPanel`.
- **OPS-C2** `src/components/tab-billing/tab-billing-panel.tsx` (props `{restaurantId, tabId, permissions, onChanged}`): saldo, registrar pagamento (forma, valor, troco), imprimir conta parcial/final (reutiliza `src/modules/printing`, estendido com PARTIAL_BILL/FINAL_BILL), fechar comanda (com justificativa quando houver saldo), cancelar comanda vazia.
- **ADMIN-T** `/app/[slug]/mesas` (cadastro: nome, capacidade, ativar/inativar via `tables.manage`, QR rotate; mostra estado e comanda aberta SOMENTE leitura) e `/app/[slug]/comandas` (lista aberta/fechada, detalhe somente leitura, sem botões operacionais).

## Divisão

- **DB-6**: `supabase/migrations/20260101000117+`.
- **OPS-C1**: `src/app/operacao/[slug]/{mesas,comandas}/**`, `src/modules/tables/**`, `src/components/tables/**`.
- **OPS-C2**: `src/components/tab-billing/**`, `src/modules/tab-billing/**`, `src/modules/printing/**`, `src/components/printing/**`.
- **ADMIN-T**: `src/app/app/[slug]/{mesas,comandas}/**`, `src/modules/tables-admin/**`, `src/components/tables-admin/**`.
- **TESTS4** (por último): `tests/**`, `scripts/**`.
