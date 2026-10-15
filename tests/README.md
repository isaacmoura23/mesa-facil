# Testes

Integração **real** contra o Supabase local (PostgREST, RPC, Storage, Realtime) com chave `anon` + JWT de usuário
obtido por `signInWithPassword` — o mesmo caminho de um navegador. O service role só monta fixtures e confere o
estado real do banco depois de cada tentativa de ataque.

## Como rodar

```bash
npm run db:start      # Supabase local (Docker); aplica migrações e seed.sql (planos)
npm test              # unitários + integração (~3-4 min)
API_BASE_URL=http://localhost:3100 npm test   # tests/api exige o dev server do app no ar (senão o arquivo se pula com aviso)
npm run db:seed:dev   # opcional: só o seed de demonstração (idempotente)
npx vitest run --project unit            # só unitários (não precisa de banco)
npx vitest run --project rls tests/rls/05-orders-state-machine.test.ts
```

O `globalSetup` (`tests/setup/global-setup.ts`) verifica que o Supabase local responde, roda o seed (DEMO A/B, 14 contas
`*@example.test`, dados de exemplo; recusa URL que não seja localhost) e faz o login real das contas (tokens em cache
em `node_modules/.cache/` para respeitar o rate limit de sign-in do Auth local: 30 / 5 min). Os arquivos rodam em
sequência porque alguns testes alteram e restauram estado compartilhado (status/slug de restaurante, sessões de
suporte). Dados efêmeros usam o prefixo `zz-` e são removidos ao final (e pelo seed, se um teste for interrompido).
`audit_logs` é append-only por desenho, então cresce a cada execução.

Senha de teste e contas: `tests/fixtures/accounts.ts` (somente banco local). Helpers: `tests/helpers/`.

## O que cada arquivo cobre

| Arquivo | Cobertura |
|---|---|
| `rls/00-baseline` | login real, tokens forjados rejeitados, seed não vacuoso (A e B têm dados em todas as tabelas) |
| `rls/01-tenant-isolation` | A x B em todas as tabelas privadas (leitura) e escrita cross-tenant (cardápio, mesas, horários, zonas, clientes, pedidos, comandas, FKs compostas), RPCs com `restaurant_id` alheio, controle positivo |
| `rls/02-privilege-escalation` | sem escrita direta em memberships/overrides/platform_admins, garçom não se promove, gerente não vira owner, ninguém atribui owner, dono não vira superadmin, `create_restaurant`/`register_restaurant`, status/slug só da plataforma, matriz de permissões = contrato |
| `rls/03-anon` | anon só lê dados públicos de restaurantes ativos, `resolve_restaurant_by_slug`, nada privado, nenhuma escrita, funções internas inacessíveis |
| `rls/04-owner-readonly` | dono lê tudo, não aceita/recusa/muda status/cancela, não abre/fecha comanda, não paga, não muda estado de mesa |
| `rls/05-orders-state-machine` | caixa aceita/recusa com motivo, cozinha só PREPARING/READY, gerente cancela com motivo, transições inválidas, colunas congeladas (totais, payment_status...), corrida aceitar x recusar |
| `rls/06-tabs-tables-payments` | abertura/fechamento/cancelamento de comanda, mesas (manage x operate), leitura de pagamentos, constraints de pagamento, fila de impressão |
| `rls/07-concurrency` | uma comanda aberta por mesa (Promise.all), `order_number` sem duplicar, idempotência de pedido e pagamento, `provider_reference` duplicado, corridas confirmadas (F-05/06/07, `it.fails`) |
| `rls/08-slug-and-suspension` | autorização independe do slug, REST/Auth/GraphQL crus, restaurante suspenso/pendente |
| `rls/09-support-sessions` | superadmin sem sessão não lê; com sessão lê e não escreve; encerra/expira; auditoria; usuário comum não abre |
| `rls/10-members-permissions` | invite -> accept -> change role -> revoke (efeito imediato), overrides vs `has_permission`, `team.manage` indelegável, vínculos em dois restaurantes |
| `rls/11-storage` | upload só no próprio `restaurants/{id}/...` com a permissão certa, leitura pública, anon, mime/tamanho, traversal, buckets |
| `rls/12-audit` | `audit_logs` append-only (até para service role), não escrevível por cliente, leitura restrita |
| `rls/13-realtime` | eventos de `orders`/`tabs`/`restaurant_tables` só para quem pode ler; B não vaza para A; filtro forjado não fura |
| `rls/14-contract-and-catalog` | `docs/CONTRACT.md` x banco x constantes do app; RLS ligado em tudo, grants mínimos, `search_path` fixo, whitelist de funções do anon (`public_menu`, `validate_cart`, `resolve_restaurant_by_slug`, `restaurant_is_public`, `storefront_origins`), `product_variants` legível por anon, `restaurant_settings` com SELECT por coluna (sem `storefront_origins`), `app_private.*` inacessível (via `docker exec psql`, pulado sem Docker) |
| `rls/15-signup-and-tickets` | `signUp` com metadata hostil, convite x confirmação de e-mail, `support_tickets` |
| `rls/16-menu-rpcs` | Fase 2: `public_menu` (só ativos, ordem, sem campos internos, isolamento), `validate_cart` (recálculo no servidor, 15 códigos de erro, mínimo/taxa/zona, 46 payloads hostis sem 5xx, não grava nada), `reorder_menu` (permissão, tenant, ids inválidos, auditoria, concorrência) e contrato RPC real x parsers da vitrine. O horário de hoje é forçado por exceção para não depender da hora do teste |
| `rls/17-menu-admin-storage` | Fluxo de imagem de produto: upload (PNG gerado em memória) -> `products.image_path` -> URL pública -> `public_menu`; `image_path` de outro tenant / `..` rejeitado; papéis sem permissão; SVG e > 5 MB; remoção |
| `rls/18-variants-headless` | Etapa 2.5 (mig. 0113): `product_variants` (RLS, FK composta, DELETE de vendida, unicidades), `badges`, `validate_cart` com variantes, `public_menu` (variants/badges/contact/URL), `storefront_origins(slug)`, `get_storefront_origins`, `storefront_origins` ilegível por anon/authenticated, escrita de contato/URL/origens por papel, CHECKs, snapshot em `order_items`. Restaurantes efêmeros `zz-hl-*`; só toca no DEMO A onde precisa da equipe de A (restaura em `finally`) |
| `api/19-public-api` | API pública v1 por HTTP real (`/menu`, `/cart/quote`): formato camelCase, 404/403/405/400/413/429, CORS por restaurante (origem cadastrada, localhost em dev, preflight), rate limit (IPs de teste via `X-Forwarded-For`), ausência de vazamentos e o SDK (`sdk/src`) contra o servidor. **Não sobe servidor**: usa `API_BASE_URL` (padrão `http://localhost:3100`) e se pula com aviso se não responder. Fixtures `zz-api-*` criadas antes do 1º request (o servidor guarda cardápio 30 s e origens 60 s em cache) |
| `unit/*` | `safe-redirect`, `permissions`, `validation` (pulados sozinhos se o módulo do app sumir); Fase 2: `format`, `storage`, `storefront-cart`, `storefront-messages-masks`, `storefront-schemas`, `storefront-data` (mock mínimo de `server-only`/`next/cache`), `menu-schemas`, `menu-image-format` |

Bugs confirmados nas migrações estão marcados com `it.fails`/`it.todo` e um código `F-xx` no nome do teste (descrição, repro e correção sugerida no relatório do agente TESTS / `tests/FINDINGS.md`).
