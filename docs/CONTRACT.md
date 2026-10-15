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
