# Achados de segurança e consistência (Fases 1 a 4)

Origem: suíte `tests/rls` rodando contra o Supabase local real. Os testes dos bugs confirmados usam `it.fails`:
quando a migração é corrigida, o teste passa a falhar e vira `it`. F-01, F-02, F-05, F-06 e F-07 já foram promovidos a `it` (mig. 111); F-08 foi corrigido na mig. 0116.

| # | Sev. | Tema | Teste | Status |
|---|---|---|---|---|
| F-05 | Média | `orders.payment_status` errado com pagamentos concorrentes | `07` | corrigido (mig. 111) |
| F-06 | Média | pedido entra em comanda que está fechando e escapa do total | `07` | corrigido (mig. 111) |
| F-04 | Alta (config) | convite reivindicável por pré-cadastro quando `enable_confirmations=false` | `15` | produção exige `true` |
| F-01 | Baixa | `tabs` INSERT aceita colunas de auditoria forjadas | `06` | corrigido (mig. 111) |
| F-07 | Baixa | limite de 5 restaurantes em `register_restaurant` furado por concorrência | `07` | corrigido (mig. 111) |
| F-02 | Baixa | `image_path` / `logo_path` sem validação de escopo | `14` | corrigido (mig. 111) |
| F-08 | Baixa | `print_jobs.payload` definido pelo cliente | `06`, `14`, `20` | corrigido (mig. 0116: INSERT direto removido; payload montado por `request_print`) |
| F-03 | Info | `qr_token` definível pelo cliente | `14`, `22` | **corrigido (migs. 0117/0121)**: cliente sem INSERT/UPDATE da coluna (42501); `rotate_table_qr` é o único caminho; virou `it` |
| F-10 | Info | `support` lê `audit_logs` de todos sem sessão | — | corrigido (mig. 111) |
| F-11 | Info | funções de trigger com EXECUTE para PUBLIC | — | corrigido (mig. 111) |
| F-12 | Info | dono alterna AVAILABLE/INACTIVE (cadastro de mesa) | `04`, `06` | decisão de produto mantida: agora só via `set_table_status` (tables.manage); UPDATE direto de `status` negado a todos |
| F-13 | Info | tabelas do domínio sem `FORCE ROW LEVEL SECURITY` | — | corrigido (mig. 111) |
| F-14 | Info | RPCs de negócio ainda inexistentes | `20`, `22` | **resolvido**: pedido/impressão (Fase 3, `20`) e comanda/pagamento/mesa/conta (Fase 4, `22`) são RPCs |
| F-15 | Info | colegas leem `phone`/`avatar_url`; cozinha lê PII do cliente | — | aceito pelo contrato; revisar |

## Detalhes

- **F-05** `payments_sync_order` agrega no snapshot da transação; dois pagamentos simultâneos deixam PENDING. Correção aplicada: lock do pedido no início do trigger com `FOR NO KEY UPDATE` (não `FOR UPDATE`: a FK de `payments` já segura `FOR KEY SHARE` no pedido, e `FOR UPDATE` causaria deadlock entre as duas transações; `NO KEY UPDATE` serializa igual).
- **F-06** `orders_before_insert` lê `tabs.status` sem travar. Correção aplicada: `FOR SHARE` na linha da comanda (sem deadlock com o fechamento; 07 rodado 4x sem erro).
- **F-04** Em produção/staging `enable_confirmations = true`. Em dev usar o Mailpit (`http://127.0.0.1:54324`).
- **F-01** Correção aplicada: `tabs_before_insert` força `opened_at/created_at/updated_at/closed_by/status_reason` quando há `auth.uid()` (grant por coluna quebraria os fluxos/testes que enviam `status`/`total_cents`).
- **F-07** `pg_advisory_xact_lock(hashtextextended(uid::text,0))` no início de `register_restaurant`.
- **F-02** Constraints: `products.image_path like 'restaurants/<rid>/products/%'` e `restaurants.logo_path like 'restaurants/<id>/logo/%'`, sem `..`.
- **F-10** Policy de `audit_logs` agora usa `is_platform_superadmin()` OU (restaurant_id não nulo e `team.manage`/`has_support_access`). Teste 12 atualizado (support sem sessão não lê).
- **F-11** Revogado EXECUTE de PUBLIC/anon/authenticated em todas as funções de trigger de `public`/`app_private`.
- **F-13** `FORCE ROW LEVEL SECURITY` nas 22 tabelas do domínio; `postgres`/`service_role` têm BYPASSRLS e as funções DEFINER pertencem a `postgres`, então nada quebrou.
- **F-09** (plataforma) Realtime envia ao anon um aviso 401 sem dados quando há evento em tabela privada; nenhum dado de linha vaza.

---

# Achados da Fase 2 (cardápio: `public_menu`, `validate_cart`, `reorder_menu`, imagens)

Origem: `tests/rls/16-menu-rpcs`, `tests/rls/17-menu-admin-storage` e `tests/unit/*` (Fase 2). Mesma convenção: bug confirmado = `it.fails` com o código `F-xx` no nome
(quando for corrigido o teste passa a falhar e vira `it`). **Nenhuma falha de isolamento entre restaurantes, escalonamento de privilégio ou gravação indevida foi encontrada nas RPCs novas.**

| # | Sev. | Tema | Onde | Teste |
|---|---|---|---|---|
| F-21 | Média | `validate_cart` público sem teto de custo/erros: 50 linhas × 50 ids de adicional = 2.500 consultas e 2.500 erros na resposta | `app_private.price_cart` (mig. 0112) | **corrigido (mig. 0113)**: `16` virou `it` (3 testes) |
| F-17 | Baixa | bucket `restaurant-public` só valida o Content-Type **declarado**: HTML/JS enviado como `image/png` é aceito (sem `nosniff`) | Storage (config do bucket) / upload do painel | `17` `it.fails` |
| F-18 | Baixa | `parseToCents` aceita entrada malformada: `"-5"`→R$ 5,00, `","`→R$ 0,00, `"1.2.3"`→R$ 12,30, `"12,50,30"`→R$ 1.250,30, `"1e5"`→R$ 15,00 | `src/lib/format.ts` | **corrigido**: `unit/format` e `unit/menu-schemas` viraram `it` (ver nota F-26) |
| F-16 | Info | JSON com ~100 mil níveis de aninhamento estoura a pilha do Postgres e o PostgREST responde **500** (54001) em qualquer RPC/insert com jsonb | plataforma (Postgres/PostgREST) | `16` `it.fails` |
| F-19 | Info | `cartErrorMessage("constructor"/"toString"/"__proto__")` devolve uma função (herança de `Object.prototype`) em vez da mensagem genérica | `src/modules/storefront/messages.ts` | **corrigido** (`Object.hasOwn`): virou `it` |
| F-20 | Info | `isOwnProductImagePath`: flag `/i` aceita `RESTAURANTS/...` e uuid do restaurante em maiúsculas (o CHECK do banco recusa); `restaurantId` é interpolado no RegExp sem escapar | `src/modules/menu/image.ts` | `unit/menu-image-format` `it.fails` ×2 (continua aberto) |
| F-22 | Info | seed não restaurava `sort_order`, nomes, preços, `is_active`, zonas, horários nem apagava sobras da UI | `scripts/seed-dev.ts` | **corrigido** (ver abaixo) |
| F-23 | Info | `TOO_MANY_ITEMS` e `NOTES_TOO_LONG` (acrescentados na 0112) não têm mensagem em `messages.ts` (caem no texto genérico); inalcançáveis pela UI (limites do cliente 50 linhas / 300 caracteres) | `src/modules/storefront/messages.ts` | **corrigido**: os 20 códigos têm mensagem (`unit/storefront-messages-masks`, `16`) |

## Detalhes e correções sugeridas

- **F-21** Repro (anon, REST cru): `POST /rest/v1/rpc/validate_cart` com 50 itens do mesmo produto e `modifier_ids` = 50 uuids aleatórios cada. Medido: 1 chamada ≈ 0,9 s; 30 em paralelo ≈ 7,5 s de relógio; resposta com 2.500 objetos de erro. A RPC é pública por desenho (sem login), então é um amplificador de custo barato. Correção: (1) limite TOTAL de adicionais por carrinho (ex.: 200) além dos 50 por linha; (2) parar de acumular erros após N (ex.: 20) e devolver `truncated: true`; (3) rate limit por IP no gateway/CDN. O teste exige `errors.length <= 100`.
- **F-17** Repro: `storage.from('restaurant-public').upload('restaurants/<A>/products/<uuid>.png', Buffer.from('<html><script>alert(1)</script></html>'), { contentType: 'image/png' })` como gerente de A → aceito e servido como `image/png` (`x-content-type-options` ausente, `access-control-allow-origin: *`). Risco prático baixo (navegadores não convertem `image/png` em HTML), mas o limite de "só imagem" depende do cliente. Correção: o painel deve enviar via server action que confere os *magic bytes* (PNG `89 50 4E 47`, JPEG `FF D8 FF`, WebP `RIFF....WEBP`, AVIF `ftypavif`), ou um webhook/edge function de verificação; opcionalmente adicionar `X-Content-Type-Options: nosniff` no proxy. SVG e > 5 MB **são** rejeitados corretamente.
- **F-18** `parseToCents` remove tudo que não é dígito/vírgula/ponto antes de interpretar. Repro: `parseToCents("-5") === 500`. O JSDoc promete `null` para negativo. Correção: antes de limpar, rejeitar `/-/`, `/e/i` e mais de um separador decimal (`/[.,]\d{1,2}$/` com o resto sendo só grupos de milhar `\d{1,3}([.,]\d{3})*`), e retornar `null` quando não há nenhum dígito. O teto `MAX_PRICE_CENTS` e o CHECK `price_cents >= 0` do banco limitam o dano (nada negativo chega ao banco; o risco é preço errado silencioso).
- **F-16** Repro: corpo `{"p_slug":"demo-a","p_fulfillment":"PICKUP","p_items":[{"x":[[[...100000 níveis...]]]}]}` → HTTP 500 `54001 max_stack_depth`. Não é falha da lógica de `validate_cart` (o parse de jsonb acontece antes). Mitigação: limitar o tamanho do corpo no gateway; nas server actions do app o zod já impede (itens tipados).
- **F-19** Correção: `Object.hasOwn(CART_ERROR_MESSAGES, code) ? CART_ERROR_MESSAGES[code] : GENERIC_CART_ERROR`. Hoje latente: o código vem de `parseCartValidation` (string 1–64) e do servidor (conjunto fixo).
- **F-20** Correção: `new RegExp(`^restaurants/${escapeRegExp(restaurantId)}/products/${UUID}\.(jpg|png|webp|avif)$`)` e aplicar `i` apenas à extensão (ex.: comparar `ext.toLowerCase()`), ou validar `restaurantId` com `isUuid` antes de montar o padrão.
- **F-22** Corrigido em `scripts/seed-dev.ts` (cardápio/zonas/horários/configurações voltam ao estado base a cada execução e o que não pertence ao seed é removido nos restaurantes DEMO; `zz-` de grupos, zonas e exceções de horário também são limpos). Estado base do cardápio de A (e de B): categorias `DEMO Lanches`(1) / `DEMO Bebidas`(2) / `DEMO Categoria Oculta`(9, inativa); produtos `X-Burger`(1, em Lanches, R$ 25,00), `Refrigerante`(2, sem categoria, R$ 6,00), `Produto Oculto`(3, inativo); grupo `DEMO Adicionais` (0–3) com `Bacon` +R$ 5,00 e `Queijo extra` +R$ 4,00; zonas `DEMO Centro` (R$ 5,00, mín. R$ 15,00) e `DEMO Zona Inativa`; horário 11:00–23:00 todos os dias.

## Resultados positivos (Fase 2) — o que foi atacado e **não** furou

- `public_menu`: nada de B em A (ids/nomes/slug), nenhum campo interno (`created_by`, `status`, `single_tab_per_table`, `restaurant_id`, `is_active`...), restaurante suspenso/pendente/inexistente/slug hostil => `null`, categoria inativa esconde seus produtos, produto/grupo/adicional inativo some, indisponível aparece marcado.
- `validate_cart`: preço do JSON ignorado (`price_cents`, `unit_price_cents`, `total_cents`...), produto/adicional/zona de outro restaurante => erro genérico indistinguível de "inexistente", 15 códigos de erro verificados, erros múltiplos juntos com `item_index` 0-based, mínimo efetivo = max(settings, zona), nenhuma escrita (contagens de 11 tabelas idênticas), 46 payloads hostis (SQLi, NoSQL-ish, unicode, NUL, números 1e999, 5.000 ids) nunca geram 5xx exceto F-16.
- `reorder_menu`: só `menu.manage` do próprio restaurante (garçom/caixa/cozinha, dono/gerente de B, sem vínculo, support/superadmin sem sessão, anon => negado), ids de outro tenant/duplicados/vazios/espécie trocada rejeitados sem alterar nada, auditoria `menu.reordered` gravada só no sucesso, concorrência (mesma espécie e cruzada) sem deadlock e sem ordem "misturada".
- Storage + `products.image_path`: CHECK rejeita outro tenant, `..`, barra inicial, URL absoluta e `logo/`; papéis sem `menu.manage` não escrevem nem trocam `image_path`; SVG/HTML e > 5 MB rejeitados; remoção só por quem tem permissão.
- `app_private.*` não é executável por anon/authenticated/PUBLIC (nem pelo PostgREST).

---

# Achados da Etapa 2.5 (SaaS headless: variantes, selos, contato, origens CORS, API pública v1)

Origem: `tests/rls/18-variants-headless` (87 testes, mig. 0113 via clientes anon/authenticated reais), `tests/api/19-public-api` (HTTP contra o dev server; pulado sem servidor), ajustes em `14`/`16` e unitários. **Nenhuma falha de isolamento entre restaurantes, escalonamento de privilégio, vazamento de `storefront_origins` ou gravação indevida foi encontrada na 0113.**

| # | Sev. | Tema | Onde | Teste |
|---|---|---|---|---|
| F-17 / F-20 / F-16 | Baixa/Info | continuam abertos (Storage declarado-vs-real; `image.ts` regex `/i`; JSON profundo 500) | ver acima | `it.fails` |
| F-24 | Média (deploy) | rate limit da API pública usa o 1º valor de `X-Forwarded-For`; sem proxy confiável basta girar o cabeçalho para zerar a cota | `public-api/rate-limit.ts` | `19` (documentado, passa) |
| F-29 | Baixa | `POST .../cart/quote` com `\u0000` em `notes` passa no zod, o Postgres rejeita o jsonb (22P05) e a API responde **500 internal_error** em vez de 400. Correção: recusar NUL nas strings do corpo em `public-api/schemas.ts` | `public-api/schemas.ts` | `19` `it.fails` |
| F-25 | Info | `POST .../cart/quote` com slug inexistente/suspenso pode responder 200 `ok:false RESTAURANT_UNAVAILABLE`, enquanto `GET .../menu` responde 404 | `public-api/handlers.ts` | `19` (aceita 404 ou 200) |
| F-26 | Info | `parseToCents` estrito (F-18) não aceita mais `",50"`, `".5"`, `"12,"`, `"12."`, `"1 000,50"` | `src/lib/format.ts` | `unit/format` (documentado como `null`) |
| F-27 | Info | slug com tab/quebra de linha não é normalizado em `storefront_origins`/`public_menu` (`btrim` só tira espaços); devolve `[]`/`null`, inofensivo | mig. 0113 | `18` |
| F-28 | Info | caches em memória: origens do CORS (TTL 60 s) e cardápio (`use cache`, 30 s) — editar origens/preços no painel só vale na API depois desse prazo, por instância | `public-api/server.ts`, `data.ts` | `19` (fixtures criadas antes do 1º request) |

- **F-21 (corrigido)** verificado em `16`: 50×50 ids => 1 erro `TOO_MANY_MODIFIERS` e `items: []`; exatamente 200 ids passa, 201 não; 50 linhas com 2 erros cada => 50 erros + `TOO_MANY_ERRORS` (último).
- **F-24** repro: 125 × `GET /menu` com `X-Forwarded-For: 198.18.1.1` => 120×200 e 5×429; com `X-Forwarded-For: 198.18.1.2` => 200. Correção: só confiar no cabeçalho atrás de proxy conhecido (a Vercel sobrescreve) ou usar o IP da conexão; para limite global, Upstash/Vercel KV (já previsto no código).
- **F-25** correção sugerida: traduzir o `RESTAURANT_UNAVAILABLE` de restaurante inexistente em 404 no quote, ou documentar no contrato que o quote devolve 200.
- **F-26** se o painel deve aceitar `,50`, tratar `^[.,]\d{1,2}$` como centavos antes de rejeitar.
- Comportamentos da 0113 verificados (não são bugs): `select("*")`, filtro e ordenação por `storefront_origins` em `restaurant_settings` dão `permission denied` até para o dono (use colunas explícitas e `get_storefront_origins`); membro de restaurante **suspenso** perde `get_storefront_origins`; superadmin/suporte só leem as origens com sessão de suporte; a mensagem de `VARIANT_UNAVAILABLE` inclui o nome da variante (só para quem tem o UUID dela).

## Resultados positivos (Etapa 2.5) — atacado e **não** furou

- `product_variants`: anon só lê ativas de restaurante ativo (nunca suspenso/pendente); escrita só `menu.manage` (dono/gerente de A; caixa, cozinha, garçom, dono/gerente de B, sem vínculo e anon negados em insert/update/delete); FK composta impede variante de A em produto de B e mover para B; DELETE de variante vendida é filtrado e o soft-delete é permitido; nome único entre ativas; no máximo 1 padrão ativa; `variant_has_orders` não é oráculo de vendas.
- `products.badges` (CHECK completo, só `menu.manage`), `validate_cart` com variantes (obrigatória/inexistente/outro produto ou restaurante indistinguíveis, preço forjado ignorado, variante + adicionais, nada gravado), `public_menu` (variants/badges/contact/URL, menor preço disponível, inativas ocultas, sem `storefront_origins`, `phone` só em `contact`).
- `storefront_origins(slug)` / `get_storefront_origins`: matriz completa em `18`; a coluna `storefront_origins` é ilegível por anon e authenticated (direto, `select=*`, filtro, ordenação e `UPDATE ... RETURNING`, sem efeito colateral); CHECKs de whatsapp/phone/endereço/URL/origens; `order_items` exige snapshot e apagar a variante preserva o nome.


---

# Achados da Fase 3 (pedidos públicos, acompanhamento, transição de status, impressão, API de pedidos)

Origem: `tests/rls/20-orders-rpcs` (migs. 0114-0116 via clientes anon/authenticated/service role reais), `tests/api/21-public-api-orders` (HTTP contra o dev server), ajustes em `06`/`14` e unitários (`orders-server`, `storefront-orders`, `operations`, `api-orders`, `sdk-orders`). **Nenhuma falha de isolamento entre restaurantes, escalonamento de privilégio, vazamento de PII no acompanhamento/impressão ou gravação indevida foi encontrada nas migrações 0114-0116 nem nas rotas de pedido.**

| # | Sev. | Tema | Onde | Teste |
|---|---|---|---|---|
| F-08 | Baixa | `print_jobs.payload` definido pelo cliente | mig. 0116 | **corrigido**: `06` virou `it` (INSERT/UPDATE/DELETE diretos negados a todos os papéis; payload montado no servidor); `14` confere os grants |
| F-29 | Baixa | NUL (`\u0000`) em `notes` do `cart/quote` => 500 | `public-api/schemas.ts` | `19` `it.fails` (continua aberto) |
| F-30 | Baixa | NUL em `customer.name`/`notes` do `POST .../orders` passa no zod, o jsonb do Postgres recusa (22P05) e a API responde **500 internal_error** em vez de 400. Mesma causa do F-29; nenhum pedido é gravado. Correção: recusar `\u0000` nas strings do corpo (zod `.refine`) em `orders-server/schemas.ts` e `public-api/schemas.ts` | `orders-server/schemas.ts` | `21` `it.fails` |
| F-31 | Info | Mesma `Idempotency-Key` com CONTEÚDO diferente devolve o pedido ORIGINAL (200, `idempotentReplay:true`, total antigo): o `409 idempotency_conflict` está mapeado no app/SDK mas o banco nunca o produz. Um bug de cliente que reutilize a chave descarta pedidos novos em silêncio. Correção: guardar um hash canônico do corpo (`orders.idempotency_hash`) e devolver `IDEMPOTENCY_CONFLICT` quando diferir | mig. 0114 | `20`, `21` (documentado, passa) |
| F-32 | Info | `getCheckoutKey` com JSON corrompido no `sessionStorage` devolve uma chave válida mas NÃO a persiste: cada chamada gera outra chave (a trava do botão ainda segura o duplo clique). Correção: no `catch`, regravar a chave nova | `storefront/order-checkout.ts` | `unit/storefront-orders` (documentado) |
| F-33 | Info | Com a cota cheia (5 criados / 10 min por IP+slug) até o REPLAY de um pedido já criado recebe 429 (a checagem vem antes da idempotência): quem perdeu a resposta do 5º pedido não recupera o código pelo replay (precisa do link/`localStorage`). A cota também é por IP: um NAT compartilhado divide os 5 pedidos. Mitigação: checar a idempotência antes do limite ou aumentar a cota | `orders-server/limits.ts` | `21` (documentado) |
| F-34 | Info | `KITCHEN_TICKET` não leva totais, pagamento, telefone, e-mail nem endereço, mas os itens carregam `unit_price_cents`/`line_total_cents`/`price_delta_cents` (`order_items_json` é compartilhada com o recibo). Quem imprime já lê esses preços por RLS (`orders.view`); só importa se a cozinha não deve ver valores. Correção: parâmetro `p_prices boolean` em `order_items_json` | mig. 0116 | `20` (documentado) |
| F-24 | Média (deploy) | rate limit usa o 1º `X-Forwarded-For`; vale também para pedidos (girar o cabeçalho zera a cota de 5/10 min e o teto de 30 tentativas) | `public-api/rate-limit.ts` | `19` (documentado) |

- **Matriz de permissões**: o garçom TEM `print.request` e `orders.view` (e não `orders.update_status`/`accept`); o dono só tem `orders.view`. Por isso "garçom sem `print.request`" é testado com um override (`membership_permission_overrides granted=false`) no garçom descartável `waiter2A`, restaurado em `finally`. A cozinha também tem `orders.update_status`, então pode avançar READY->COMPLETED/OUT_FOR_DELIVERY (o teste só exige que ela NÃO aceite, recuse nem cancele).
- **Códigos estáveis verificados**: `ORDER_NOT_FOUND` é idêntico (mensagem e SQLSTATE) para pedido inexistente e pedido sem `orders.view` (sem oráculo de existência); `FORBIDDEN` só aparece para quem VÊ o pedido; a máquina de estados do banco segue sendo a autoridade (`ORDER_INVALID_TRANSITION`, `REASON_REQUIRED`, `REASON_TOO_LONG`, `INVALID_STATUS`).
- **Colunas**: `authenticated` só tem UPDATE em `orders.status/status_reason/estimated_ready_at`; `payment_method_intent`/`change_for_cents` são recusadas por grant de coluna (42501) e os CHECKs valem até para service role (23514).

## Resultados positivos (Fase 3) — atacado e **não** furou

- `create_public_order`: EXECUTE só service_role (anon, dono, caixa, sem vínculo e superadmin negados com 42501); preço/total forjado em qualquer lugar do JSON é ignorado; produto/zona/adicional de outro restaurante => erro, nada gravado (contagem de pedidos e de clientes inalterada em todas as recusas); chave de idempotência por restaurante, 8 chamadas simultâneas => 1 pedido (2 rodadas); `order_number` e `public_code` únicos sob concorrência; upsert de cliente não renomeia, não cruza restaurantes e remove o `55` só em 12/13 dígitos; snapshots de nome/variante/preço/adicionais sobrevivem a renomear/reprecificar o cardápio; restaurante suspenso/pendente/inexistente indistinguíveis.
- `track_order`: conjunto de chaves exato, nenhum telefone/e-mail/nome/endereço/CEP/observação/uuid/chave de idempotência/troco em nenhuma resposta; código minúsculo, com espaços e O/I/L normalizado; slug errado, código curto/longo/com símbolos/SQLi => `null` sem erro; restaurante suspenso/pendente => `null`.
- `transition_order_status`: matriz por papel completa; transições concorrentes serializadas (aceitar x recusar: exatamente uma vence, 3 rodadas; duas iguais: 1 aplica + 1 `unchanged`), histórico sem duplicidade.
- `request_print`/`mark_print_job`: só o solicitante com `print.request` ainda ativo marca; `PRINTED` nunca é definido por cliente; payload do recibo sem telefone/e-mail e endereço só em DELIVERY; auditoria `print.requested` gravada.
- API de pedidos: origem hostil recebe 403 antes de processar o corpo (nenhum pedido criado); 400/413/422/429 sem texto interno do banco, sem stack traces, sem chaves do Supabase nem ids de restaurante; o acompanhamento não cacheia (`no-store`, `noindex`) e códigos de outro restaurante dão o mesmo 404.
- Realtime: o INSERT/UPDATE do pedido público chega à caixa e à cozinha de A e a ninguém de B (retry 3).


---

# Achados da Fase 4 (mesas, comandas, pagamento manual, conta impressa)

Origem: `tests/rls/22-tab-rpcs` (migs. 0117-0123, só clientes autenticados reais), ajustes em `04`/`06`/`07`/`14` e unitários (`tab-billing`, `tables-staff`, `bill-and-tables-admin`). **Nenhuma falha de isolamento entre restaurantes, escalonamento de privilégio, dinheiro registrado a mais/menos, deadlock ou comanda fechada com pedido em andamento foi encontrada nas migrações 0117-0123.**

**Brecha fechada pelas migrações:** até a 0120 um cliente com `tabs.manage` ainda conseguia `UPDATE tabs SET status='CLOSED'` (contornando `TAB_UNPAID`, `TAB_HAS_OPEN_ORDERS` e a auditoria), `UPDATE restaurant_tables SET status=...` (contornando `set_table_status`) e `INSERT` direto em `tabs`. A 0121 reduziu o UPDATE de `tabs` a `label`/`guests` e o de `restaurant_tables` a `name/area/capacity/sort_order`; a 0122 removeu o INSERT direto em `tabs` (policy + GRANT). Os testes `04`/`06`/`07`/`14`/`22` passaram a exigir exatamente isso (42501 em todas as variações; parâmetros forjados em `open_tab` => PGRST202).

| # | Sev. | Tema | Onde | Teste |
|---|---|---|---|---|
| F-35 | Baixa | `set_table_status` devolve `{unchanged:true, table:{id,name,status}}` ANTES de checar a permissão: um membro sem `tables.view` (cozinha) lê nome e estado de qualquer mesa do próprio restaurante pedindo o estado em que ela já está | mig. 0120 | `22` `it.fails` |
| F-36 | Info | `create_staff_order` com a mesma `p_idempotency_key` e ITENS diferentes devolve o pedido original com `idempotent_replay:true` (sem `IDEMPOTENCY_CONFLICT`, ao contrário de `record_payment`): um bug de cliente que reutilize a chave perde o pedido novo em silêncio. Mesma família do F-31 | mig. 0123 | `22` (documentado, passa) |
| F-37 | Baixa | `parseMoneyToCents` com vírgula descarta TODOS os pontos sem validar o agrupamento de milhar: `"1.2,50"` => R$ 12,50 e `"12.50,3"` => R$ 1.250,30 (mesma classe do F-18). O servidor limita ao saldo (`OVERPAYMENT`), então o dano é valor errado dentro do saldo | `src/modules/tab-billing/money.ts` | `unit/tab-billing` `it.fails` |
| F-38 | Info | Códigos que o banco levanta e a UI não traduz (caem em "verifique a conexão"): `ORDER_NOT_FOUND`, `RESTAURANT_UNAVAILABLE` (cobrança) e `RESTAURANT_UNAVAILABLE`, `LABEL_REQUIRED`, `INVALID_LABEL`, `INVALID_GUESTS`, `INVALID_NOTES`, `INVALID_IDEMPOTENCY_KEY` (mesas). `tables/errors.ts` mapeia `RESTAURANT_INACTIVE`, que o banco nunca emite | `tab-billing/errors.ts`, `tables/errors.ts` | `unit/tab-billing`, `unit/tables-staff` `it.fails` |
| F-39 | Info | `paymentMethodLabel("constructor"/"toString"/"__proto__")` do painel do dono devolve uma FUNÇÃO (`PAYMENT_METHOD_LABELS[m] ?? "Outro"` herda de `Object.prototype`; mesma classe do F-19). Latente: o método vem do enum do banco | `src/modules/tables-admin/format.ts` | `unit/bill-and-tables-admin` `it.fails` |
| F-40 | Baixa | `parseTabFilters` aceita datas impossíveis (`2026-02-30`, `04-31`): `Date` as rola para o mês seguinte, o filtro passa e o Postgres recusa `2026-02-30T00:00:00-03:00` (22008); a lista de comandas mostra o erro de carregamento em vez de ignorar o parâmetro | `src/modules/tables-admin/schemas.ts` | `unit/bill-and-tables-admin` `it.fails` |
| F-41 | Info | `recordPaymentResultSchema` lê `change_cents`/`remaining_cents` no TOPO da resposta, mas o banco os devolve em `payment.change_cents` e `balance.remaining_cents`; a UI cai no cálculo local do troco (mesmo valor). Sem erro, só contrato desalinhado | `tab-billing/types.ts` | `22` (documentado, passa) |

## Detalhes e correções sugeridas

- **F-35** Repro (cozinha de A, mesa AVAILABLE): `rpc('set_table_status', {p_table: <id>, p_to: 'AVAILABLE'})` => `{"ok":true,"unchanged":true,"table":{"id":...,"name":"...","status":"AVAILABLE"}}`. Correção: checar `tables.operate` OU `tables.manage` logo após validar `p_to`, antes do ramo `unchanged`. Não cruza tenants (`is_member` vale antes).
- **F-36** Correção: guardar um hash canônico dos itens/observações junto da chave (como proposto no F-31) e devolver `IDEMPOTENCY_CONFLICT` quando divergir, ou documentar que a chave identifica a TENTATIVA (o app usa `newAttemptKey()` por tentativa, então o uso correto não é afetado).
- **F-37** Correção: com vírgula, só remover pontos se a parte antes da vírgula casar `^\d{1,3}(\.\d{3})+$`; senão `null`. Aceita `1.234,50`, rejeita `1.2,50`.
- **F-38** Acrescentar as mensagens em PT-BR a `MESSAGES` e trocar `RESTAURANT_INACTIVE` por `RESTAURANT_UNAVAILABLE`.
- **F-39** Usar `Object.hasOwn(PAYMENT_METHOD_LABELS, method)`.
- **F-40** Validar o calendário: `new Date(v + "T00:00:00Z").toISOString().startsWith(v)` além de `!isNaN`.
- **F-41** Ler `payment.change_cents`/`balance.remaining_cents` (ou continuar calculando localmente e tirar os campos do schema).

## Resultados positivos (Fase 4) — atacado e **não** furou

- **Papéis**: o dono lê comandas/mesas/pedidos/pagamentos/saldo e é `FORBIDDEN` em `open_tab`, `create_staff_order`, `record_payment`, `close_tab`, `cancel_tab`, `set_table_status` (transições operacionais) e `request_tab_print`, sem alterar nada; cozinha negada em tudo (`rotate_table_qr` incluído); garçom abre/lança/pede a conta mas não registra pagamento e não fecha com saldo (nem com justificativa); caixa e gerente pagam/fecham; só `tables.manage` (dono/gerente) rotaciona QR e desativa mesa.
- **Tenants**: funcionários de B recebem `RESTAURANT_NOT_FOUND`/`TAB_NOT_FOUND`/`ORDER_NOT_FOUND`/`TABLE_NOT_FOUND` em todas as RPCs sobre ids de A; a mensagem de um id de A, de um id inexistente e de quem não tem vínculo é idêntica (sem oráculo); produto de B no carrinho é indistinguível de inexistente (mesmo código e mensagem); a referência de pagamento é por restaurante; anon não tem EXECUTE em nenhuma das 9 RPCs.
- **Dinheiro**: o valor nunca passa do saldo (`OVERPAYMENT` com `remaining_cents` no detalhe; 6 pagamentos de R$ 10 numa conta de R$ 30 => exatamente 3); `consumido` exclui cancelados/recusados; `overpaid_cents` aparece quando o pedido é cancelado depois do pagamento e `cancel_tab` recusa (`TAB_HAS_PAYMENTS`); troco só em CASH e calculado no servidor; pagamento sempre PAID/MANUAL/`recorded_by = chamador` (parâmetros extras => PGRST202); a mesma referência em 6 chamadas paralelas gera 1 pagamento e 1 auditoria; divergência de valor/forma/alvo => `IDEMPOTENCY_CONFLICT`; o replay continua válido com a comanda já fechada.
- **Fechamento**: `unpaid_cents`/`unpaid_reason` só nascem em `close_tab` (justificativa 10..500 e `payments.record`), auditoria `tab.closed_unpaid` com consumo/pago/saldo/justificativa, justificativa descartada quando não há saldo, repetição `unchanged:true` sem nova auditoria nem re-sujar a mesa, 4 fechamentos paralelos => 1.
- **Concorrência (clientes autenticados, 4-6 rodadas por cenário, ambos os sentidos)**: pagamento x fechamento (com e sem justificativa, por comanda e por pedido), pedido novo x fechamento, pedido novo x `cancel_tab`, 6 aberturas na mesma mesa, 10 pedidos simultâneos (números únicos): nenhum `40P01`/serialização; invariantes `unpaid_cents = consumo - pago` e nenhuma comanda CLOSED/CANCELLED com pedido ativo.
- **price_cart (mig. 0118)**: modo equipe ignora fechado/pausado/mínimo (R$ 10 com mínimo de R$ 1.000 e restaurante fechado e pausado) e mantém `VARIANT_REQUIRED`, `VARIANT_*`, `MODIFIER_GROUP_MIN/MAX`, `MODIFIER_NOT_ALLOWED`, `PRODUCT_UNAVAILABLE`, `INVALID_QUANTITY`, `EMPTY_CART`, `FULFILLMENT_DISABLED`; preço/total/delta forjados no JSON são ignorados; `validate_cart` e `create_public_order` continuam recusando `RESTAURANT_CLOSED` com o mesmo restaurante (regressão); `app_private.price_cart_core` não é executável nem visível por clientes.
- **Conta impressa**: payload montado no servidor sem telefone, e-mail, nome de cliente, endereço, ids de usuário nem justificativa interna (mesmo com um pedido da comanda cheio de dados de cliente), itens consolidados, pagamentos com troco, saldo, `total_cents`/`unpaid_cents` só em comanda CLOSED, PARTIAL só em OPEN, CANCELLED => `TAB_NOT_BILLABLE`, `mark_print_job` só pelo solicitante e nunca PRINTED; a resposta real passa nos schemas do app (`requestTabPrintResultSchema`, `tabBalanceSchema`).
- **QR**: `rotate_table_qr` gera token de 16+ caracteres no servidor, sempre novo, e o token (antigo ou novo) nunca aparece em `audit_logs`; cliente nenhum grava `qr_token` (insert nem update; B não consegue sondar colisão com token de A).
- **Realtime**: `tabs`, `restaurant_tables` e `payments` de A chegam ao caixa e ao garçom de A e nunca a B (e vice-versa); o garçom recebe comandas e mesas mas nenhum `payments` (RLS `payments_select`).


---

# Achados da Fase 5 (painel do dono: relatórios, clientes, equipe, auditoria, configurações)

Origem: `tests/rls/23`, `24`, `25` (migs. 0124-0127, só clientes autenticados reais) e `unit/period`, `unit/reports`, `unit/customers-team-settings`. **Nenhuma falha de isolamento entre restaurantes, escalonamento de privilégio, vazamento de PII/segredo nas respostas, mover linhas de configuração entre restaurantes ou número de relatório divergente do cálculo independente foi encontrada.** (Fuso inválido nunca chega ao banco: o trigger o recusa até para service role, então o fallback `report_tz` fica só como rede de segurança.)

| # | Sev. | Tema | Onde | Teste |
|---|---|---|---|---|
| F-42 | Info | `isValidTimezone` usa `Intl`, que ignora caixa (`america/sao_paulo` passa); o banco compara com `pg_timezone_names` (sensível a caixa) e responde `INVALID_TIMEZONE`. Mesma classe do F-20: validador do app aceita o que o banco recusa. Correção: comparar com `Intl.supportedValuesOf('timeZone')` ou exigir `resolvedOptions().timeZone === valor` | `restaurant-profile/timezones.ts` | `unit/customers-team-settings` `it.fails` |
| F-43 | Baixa | CHECK `delivery_zones_prefixes_valid` valida `array_to_string(...)`, não cada elemento: `['']` (prefixo vazio, casaria TODO CEP) e `['1,2']` passam. Correção: `not exists (select 1 from unnest(postal_code_prefixes) p where p !~ '^[0-9]{1,8}$')` | mig. 0126 | `25` `it.fails` |
| F-44 | Baixa | `sanitize_audit_metadata` não remove chaves em português (`senha`, `segredo`, `chave_api`), embora o cabeçalho da 0125 prometa "senha" (o app, em `team/audit.ts`, já filtra `senha`). Correção: acrescentar `senha|segred|chave` à regex | mig. 0125 | `24` `it.fails` |
| F-45 | Info | Valor `Bearer eyJ...` (ou JWT com espaço antes) em metadata passa: a máscara só vale para strings que COMEÇAM com `eyJ`. Correção: regex `(^|\s)(bearer\s+)?eyJ...` | mig. 0125 | `24` (documentado, passa) |
| F-46 | Info | Triggers de horário não checam o transbordo da virada de dia sobre o dia seguinte (Seg 22:00-02:00 e Ter 01:00-03:00 coexistem); o app (`validateWeek`) checa. Quem escreve direto pela API fura a regra do app | mig. 0126 | `25` (documentado, passa) |
| F-47 | Baixa | Decisão "clientes só `reports.view`" vale só nas RPCs: `customers_select` (RLS) segue permitindo `orders.view`, então caixa/cozinha/garçom leem nome/telefone/e-mail por REST direto, sem a trilha `customer.viewed`. Aceito pelo contrato (0127 não muda a RLS); fechar exigiria restringir o SELECT e usar RPC no fluxo de pedidos | RLS `customers` | `24` (documentado, passa) |
| F-48 | Info | `paymentMethodName('constructor'/'toString')` (dashboard) devolve FUNÇÃO (`PAYMENT_METHOD_NAMES[m] ??`); mesma classe de F-19/F-39. Correção: `Object.hasOwn` | `dashboard/types.ts` | `unit/period` `it.fails` |
| F-49 | Info | `isOwnLogoPath`: flag `/i` aceita `RESTAURANTS/...`, UUID em maiúsculas e `.PNG` (o CHECK do banco recusa); `restaurantId` é interpolado sem escapar (`.*` casa tudo). Mesma causa do F-20 | `restaurant-profile/logo.ts` | `unit/customers-team-settings` `it.fails` x2 |

## Decisões e comportamentos verificados (não são bugs)

- **Clientes só `reports.view`** (mig. 0127): owner/manager listam e abrem; cashier/kitchen/waiter => `FORBIDDEN`; override `reports.view` concede/retira normalmente. Cliente de outro restaurante == inexistente (`CUSTOMER_NOT_FOUND` idêntico).
- **Horários salvos por diff, não atômico**: a tela grava a grade comparando com o estado atual (insere/atualiza/apaga linha a linha). Os triggers (limite de 6 faixas/dia, sobreposição) valem a cada linha sob lock advisory; uma falha no meio deixa a grade parcialmente aplicada. Sem teste de UI aqui; o banco foi testado sob concorrência (10 inserções => exatamente 6).
- Relatórios: janela `[from,to)`, semana ISO (bucket pode começar antes de `from`), 366 dias de relógio = 367 datas locais em SP; `gross` exclui CANCELLED/REJECTED; ticket médio sobre gross; `payment_methods` só PAID por `paid_at`; motivos de cancelamento mascarados (e-mail, >= 6 dígitos), fórmula `=cmd` NÃO é alterada no banco (o CSV do app a neutraliza). Truncamento: 5000 linhas exatas => `truncated=false`; 5001 => true com totais completos.
- `audit_logs` é append-only: as linhas de teste (restaurante efêmero) ficam no banco.
