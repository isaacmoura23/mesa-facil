# Revisão de segurança independente (agente SEC)

Data: 2026-10-20. Escopo: SaaS de restaurantes multi-tenant (Next.js 16 + Supabase), código em `main` e Supabase LOCAL.
Método: leitura de código, consultas ao catálogo do Postgres local (`docker exec supabase_db_test1 psql`) e requisições reais a
`http://127.0.0.1:54321` (PostgREST/Auth/Storage) e `http://localhost:3100` (app) como anon, dono A, gerente A, caixa A, garçom A,
cozinha A, dono B, usuário sem vínculo e superadmin. A nuvem, `.env.deploy` e arquivos de credenciais NÃO foram tocados.
Achados já conhecidos (`tests/FINDINGS.md`, F-01..F-54) não são repetidos; só comento severidade quando discordo.

## 1. Resumo executivo

O isolamento entre restaurantes está **sólido**: não consegui nenhum acesso, leitura ou escrita cross-tenant por RPC, PostgREST, embed,
FK, Storage ou escalonamento de papel. As 70+ funções `SECURITY DEFINER` têm `search_path` vazio, nenhuma é executável por `PUBLIC`
(exceto um helper público inofensivo) e todas validam `auth.uid()`/permissão dentro. Não há views, não há SQL dinâmico injetável,
todas as tabelas têm RLS + FORCE, o bucket só aceita imagens e só a própria pasta do tenant.

Os riscos reais estão na **camada de borda e de configuração**, não no banco:

1. Nenhum cabeçalho de segurança no app (sem CSP, X-Frame-Options/frame-ancestors, nosniff, Referrer-Policy, HSTS) e o token de sessão fica em cookie legível por JS (S-01).
2. Limite do plano e status da assinatura **não são aplicados em lugar nenhum**: trial nunca vence na prática (S-02).
3. Política de autenticação fraca no config atual (senha mínima 6, sem CAPTCHA, MFA desligado inclusive para superadmin) (S-03; soma-se ao F-04).
4. Criação pública de pedidos é frágil a flood: limite em memória por instância e por IP (S-04, agrava o F-24).

Nenhum segredo está no repositório nem no histórico (8 commits); `npm audit --omit=dev`: 0 vulnerabilidades; nenhum segredo no bundle `.next/static`.

Nenhum achado Crítico. Nenhum achado Alto no código; Alto de configuração: F-04 (já conhecido) e MFA do superadmin (S-03).

## 2. Tabela de achados novos

| ID | Sev. | Componente | Evidência | Correção sugerida |
|---|---|---|---|---|
| S-01 | Média | `next.config.ts` (sem `headers()`) | `curl -I http://localhost:3100/` e `/login`: só `Cache-Control`, `X-Powered-By: Next.js`, `Vary`, `Link`. Ausentes: `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Permissions-Policy`. A API pública (`public-api/http.ts:10`) tem `nosniff`, o resto do app não. Sessão em cookie via `createBrowserClient` (`src/lib/supabase/client.ts:11`), logo não HttpOnly (padrão do `@supabase/ssr`): qualquer XSS futuro rouba o token. Painel enquadrável em iframe (clickjacking em ações de um clique: registrar pagamento, mudar status). | Em `next.config.ts`: `poweredByHeader:false` e `headers()` com CSP (`default-src 'self'`; `img-src 'self' data: https://*.supabase.co`; `connect-src 'self' https://*.supabase.co wss://*.supabase.co`; `frame-ancestors 'none'`; nonce para scripts), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `Permissions-Policy`. |
| S-02 | Média | Banco: `has_permission`, `restaurant_is_public`, `register_restaurant` | `plans.limits` só é lido (`grep limits` em migrações: apenas definição e RPCs de leitura/escrita da plataforma). `has_permission` e `restaurant_is_public` consideram só `restaurants.status`, nunca `subscriptions.status`/`trial_ends_at`/`current_period_end`. Seed: `subscriptions` em `trialing`. Resultado: trial vencido, `past_due` e `canceled` continuam operando e nenhum limite do plano (produtos, mesas, equipe) é imposto. Perda de receita, não vazamento. | Decidir a política: função `app_private.subscription_active(rid)` usada em `restaurant_is_public` e nas RPCs de escrita; triggers de limite (contagem vs `plans.limits`) em `products`, `restaurant_tables`, `restaurant_memberships`; job para vencer trials. |
| S-03 | Média (Alta p/ MFA do superadmin) | Auth (`supabase/config.toml`, projeto Supabase) | Local: `minimum_password_length = 6`, `password_requirements = ""`, `[auth.mfa.totp] enroll_enabled=false`, sem `[auth.captcha]`. Repro: `POST /auth/v1/signup {"email":"sec.probe1@example.test","password":"123456"}` => 200 e conta criada já confirmada (removida depois). Com confirmação desligada, signup de e-mail existente devolve `user_already_exists`, enumerando contas (`signupAction` tem o código em `src/lib/auth/actions.ts:116`, comentário diz "resposta neutra" mas só é neutra com confirmação ligada). 8 logins errados seguidos: nenhum bloqueio além do limite por IP do GoTrue (30/5 min). | No projeto de produção: senha mínima 10 + `lower_upper_letters_digits`, "leaked password protection" (plano Pro), CAPTCHA (Turnstile/hCaptcha) em signup/login/recover, MFA TOTP habilitado e **obrigatório para `platform_admins`** (checar `aal2` em `requirePlatformAdmin`), confirmação de e-mail ligada (F-04). |
| S-04 | Média | `orders-server/limits.ts`, `public-api/rate-limit.ts` + `create_public_order` | Pedido público é anônimo, sem CAPTCHA nem teto por telefone/restaurante. Limites vivem em `globalThis` da instância (5 pedidos/10 min por IP+slug). Em serverless cada instância tem contador próprio e o IP vem do 1º `X-Forwarded-For` (F-24). Cada chave de idempotência nova gera pedido novo, que cai na fila da cozinha e cria/atualiza linha em `customers` (upsert por telefone, `create_public_order` linhas ~190: `on conflict (restaurant_id, phone)`). Também: telefone de um cliente real sem e-mail pode receber e-mail escolhido pelo atacante (`set email = coalesce(c.email, excluded.email)`). | Contador compartilhado (Upstash/Vercel KV) por IP e por restaurante (ex.: 60 pedidos/h) e por telefone; CAPTCHA/Turnstile no checkout; opção do restaurante "exigir confirmação por WhatsApp"; não atualizar `email` de cliente existente pelo canal público. Eleva o F-24 de Média para **Média/Alta** quando combinado com isto. |
| S-05 | Baixa | PostgREST anon (chave pública) | O que o app limita (CORS por restaurante, 64 KB, rate limit) é contornável indo direto ao Supabase: `GET /rest/v1/products?select=id` como anon devolve 232 linhas (todos os produtos ativos de todos os restaurantes públicos, `Content-Range: 0-231/*`), mais `restaurant_settings` (telefone, WhatsApp, endereço). `validate_cart` e `track_order` ficam sem limite (só `statement_timeout` de 3 s do anon). `GET /rest/v1/` entrega o OpenAPI com todos os nomes de tabelas/colunas/funções, e `graphql_public` está em `[api].schemas` sem o `pg_graphql` instalado. | Aceitável pelo desenho "cardápio público"; documentar. Remover `graphql_public` de `schemas`; considerar limitar `max_rows` e rate limit por IP no gateway/Cloudflare; desligar o OpenAPI para anon (`PGRST_OPENAPI_MODE=disabled` self-hosted; no Supabase hospedado não é configurável). |
| S-06 | Baixa | `src/proxy.ts:15` | O matcher é uma string TS com `\.` (escape inválido vira `.`), então o padrão efetivo é `.*.(?:svg\|png\|...)$`: qualquer caminho terminando em letras como `...png`, `...xml`, `...txt` pula o proxy (renovação de sessão e redirecionamento otimista). Nenhuma rota atual termina assim e os guards de servidor (`requireRestaurantAccess`, `requirePlatformAdmin`) continuam valendo; é defeito latente. | Usar `\\.` (ou `String.raw`) no matcher. |
| S-07 | Baixa | `src/lib/auth/actions.ts:30-40` | Se `NEXT_PUBLIC_SITE_URL` estiver vazia, `emailRedirectTo` é montado com `x-forwarded-host`/`Host` da requisição (`.env.example` diz "Se vazia, é deduzida"). Host forjado entra no link do e-mail de confirmação; o Supabase só aceita URL da allowlist, então o ataque depende de allowlist frouxa (curinga). | Tornar `NEXT_PUBLIC_SITE_URL` obrigatória em produção; allowlist do Auth só com URLs exatas. |
| S-08 | Info | `restaurant_tables.qr_token` | O F-03 cobriu a escrita. A leitura continua liberada a todo papel com `tables.view` (inclui garçom/cozinha) e a coluna está na publicação Realtime. Hoje nenhum fluxo usa o token como segredo de autorização (`grep qr_token src` só acha um comentário). | Se o pedido por QR da mesa for implementado, tratar o token como credencial: tirá-lo do SELECT/Realtime de papéis comuns (view/RPC só para `tables.manage`). |
| S-09 | Info | Papéis | O "dono somente leitura" (sem permissões operacionais) é contornável pelo próprio dono: `invite_member` com um segundo e-mail dele como `manager`/`cashier` (dono tem `team.manage`). Coerente com o contrato, mas anula a restrição como controle de segurança. | Só documentar, ou exigir `owner` ≠ operador em auditoria. |
| S-10 | Info | Sessão | Logout/revogação não invalida o JWT já emitido (`jwt_expiry = 3600`); o acesso a dados é cortado na hora pelas checagens no banco (membership/permissão/suspensão), mas o token continua válido para `auth.uid()` por até 1 h. `getClaims()` valida só a assinatura. | Aceitável; para conta comprometida usar `auth.admin.signOut(scope=global)` + banir usuário. |
| S-11 | Info | `scripts/data/*.json` (repo público) | Telefones/WhatsApp de 3 restaurantes reais (`la-pastelaria`, `o-nailton`, `qibuxo`) e URLs de produção no GitHub público. São dados já publicados nos sites deles. | Confirmar autorização dos clientes; senão trocar por placeholders. |
| S-12 | Info | Tickets / suporte | `support_tickets` INSERT sem limite de quantidade por usuário/hora (só RLS por membro); spam possível a ponto de inflar o painel da plataforma. | Rate limit por usuário (trigger com contagem por janela). |

### Revisão de severidade de achados conhecidos

- **F-24** Média -> **Média/Alta** quando combinado com S-04 (contador por instância torna o limite praticamente decorativo em serverless, mesmo na Vercel onde o XFF é confiável).
- **F-15 / F-47**: mantidos Info/Baixa; confirmei que cozinha lê nome, telefone e endereço de todos os pedidos (publicados no Realtime), o que contraria o princípio de menor privilégio. Sugiro mover PII para uma view/RPC por permissão.
- **F-17**: confirmado de novo contra o Storage local: HTML enviado como `image/png` é aceito e servido `Content-Type: image/png`, sem `X-Content-Type-Options` (Baixa, concordo).
- **F-04** permanece **Alta (config)**: confirmei que com `enable_confirmations=false` o signup devolve sessão e `register_restaurant` funciona logo em seguida.

## 3. O que foi verificado e está sólido

Banco
- Inventário de `pg_proc`: 85 funções `SECURITY DEFINER` em `public`/`app_private`; **todas** com `proconfig = search_path=""`. `app_private.*` sem EXECUTE para anon/authenticated e sem USAGE no schema. Funções de trigger sem EXECUTE para clientes. `create_public_order` só executável por `service_role`/`postgres`.
- Funções executáveis por `anon`: apenas `public_menu`, `public_platform_flags`, `resolve_restaurant_by_slug`, `restaurant_is_public`, `storefront_origins`, `track_order`, `validate_cart`; todas só leem dados públicos de restaurantes `active`.
- Funções INVOKER expostas (`can_manage_restaurant_asset`, `generate_public_code`, `is_direct_client`, `storage_path_restaurant_id`): sem efeito sensível.
- Oráculos `has_permission`, `is_member`, `my_permissions`, `shares_restaurant_with`, `product_has_orders`, `variant_has_orders` com uuid de outro tenant: respondem `false`/`[]`; nunca confirmam dados de terceiros.
- SQL dinâmico: só `reorder_menu` usa `format('%I')` com tabela vinda de whitelist (`CASE` fixo), valores por `USING`; demais `execute format` estão em migrações (DDL fixo). Sem injeção.
- GUC `mesa.sync` (única `current_setting` usada): setada só dentro de funções DEFINER com `set_config(...,true)`; cliente PostgREST não consegue setar GUC arbitrário.
- Sem views; RLS ligada e `FORCE` nas 37 tabelas; policies `using (true)` apenas em `permissions`, `role_permissions`, `order_status_transitions` (catálogos). Policies anon só em tabelas de cardápio e sempre com `restaurant_is_public()`.
- Grants por coluna: anon sem acesso a `storefront_origins`; authenticated sem INSERT/UPDATE em `memberships`, `overrides`, `payments`, `orders` (exceto 3 colunas), `audit_logs`, `support_sessions`, `platform_admins`.
- FKs compostas `(restaurant_id, x_id)`: tentei apontar produto, grupo de adicionais, modificador e variante do tenant A para ids do tenant B por REST (`23503` em todos). Sem referência cross-tenant.
- Triggers de guarda: dono/gerente tentando mudar `restaurants.status`/`slug` => `restaurant_status_slug_platform_only`; assinatura própria => 0 linhas; transição inválida de pedido => `ORDER_INVALID_TRANSITION`; `status_reason` solto => `FORBIDDEN_FIELD`.
- Storage: bucket `restaurant-public` público de leitura, 5 MB, MIME só jpeg/png/webp/avif; SVG e HTML recusados (415); upload na pasta do tenant B, `..` e `%2e%2e` => 403; listagem anônima vazia; listagem do dono só enxerga a própria pasta. Policies via `can_manage_restaurant_asset` (UUID por regex, permissão por pasta).
- Extensões: só `uuid-ossp`, `pgcrypto`, `pg_stat_statements`, `supabase_vault`.
- Realtime: publicação com 5 tabelas (`restaurant_tables`, `tabs`, `orders`, `order_status_history`, `payments`), todas com RLS; sem tabelas privadas fora de RLS.

Autorização multi-tenant (dono A atacando ids reais do tenant B, e gerente/caixa/garçom/cozinha/sem-vínculo contra A)
- Todas as RPCs com uuid (`transition_order_status`, `close_tab`, `cancel_tab`, `get_tab_balance`, `get_customer`, `rotate_table_qr`, `set_table_status`, `request_print`, `request_tab_print`, `record_payment`, `open_tab`, `create_staff_order`, `list_*`, `restaurant_report`, `revoke_member`, `accept_invitation`, `open_support_session`, `close_support_session`, `create_restaurant`): `*_NOT_FOUND` ou `forbidden`, sem dado. `require_perm` devolve NOT_FOUND para não-membro (não vaza existência).
- `platform_*` (16 RPCs): todas chamam `app_private.require_platform(...)` na primeira linha; escrita exige superadmin; dono/usuário comum => `FORBIDDEN`. `platform_support_overview` só serve a sessão do próprio admin, não expirada.
- Equipe: `change_member_role`/`revoke_member`/`set_member_permission` bloqueiam auto-modificação, dono e `team.manage` não delegável; override apagado ao mudar papel; `accept_invitation` exige e-mail confirmado quando o convite é por e-mail; `register_restaurant` serializa por advisory lock e limita 5.
- Escrita direta por papéis baixos (garçom): membership, override, payments, orders, audit_logs, support_sessions, tickets de outro restaurante, PATCH de profiles de terceiros: todos negados/0 linhas.
- Pedido público: preço sempre recalculado no servidor (`price_cart`), `public_code` com 80 bits (16 caracteres Crockford), idempotência por `(restaurant_id, key)` com advisory lock, cliente só ganha `email` se não tinha.
- Embed `orders?select=*,customers(*),restaurants(*)` e filtros `or=`: RLS aplicada em cada nível.

App
- Nenhum `dangerouslySetInnerHTML`, `innerHTML`, `eval`, nem `fetch()` no código do app (sem SSRF); `service role` só em módulos `server-only` (`admin.ts`, `env.server.ts`, `orders-server/service.ts`), usado apenas por `create_public_order`; nenhuma chave no `.next/static` (busca pelo valor da service key e por `service_role`).
- `sanitizeNext` bloqueia `//host`, `/\`, controles e URL absoluta; `/auth/callback?next=//evil.com` redireciona para `/login?erro=callback`.
- Rotas protegidas redirecionam sem sessão (`/platform`, `/app/*`, `/operacao/*` => 307 `/login`); `.env`, `.git/config` => 404; sem source maps em `.next/static`.
- Rotas CSV: `requireRestaurantAccess` com permissão (`orders.view`, `tabs.view`, relatórios) antes de qualquer consulta; só GET de leitura, filtros validados; os três serializadores neutralizam fórmula (`= + - @ \t \r`) e escapam aspas; limite de linhas.
- API pública: CORS por origem exata https cadastrada (`Origin: https://evil.example` e `Origin: null` => 403; POST `text/plain` rejeitado com 400/403, sem CSRF cross-site); corpo de 20 MB => 413 em 18 ms (limite 64 KB); `nosniff` e `no-store` nas respostas; validação zod nas entradas.
- Server Actions autorizam por slug -> membership e a RLS/RPC reforça no banco; `restaurant_id` nunca é confiado do cliente. Origin check padrão do Next 16 para Server Actions.
- Login/cadastro: mensagens neutras (`invalid_credentials`), sem eco de senha em logs; logs do servidor imprimem só `error.message`.

Segredos e repositório
- `git grep` e `git log --all -p -S` por `sb_secret_`, `sb_publishable_`, JWT `eyJ…`, `postgres://usuario:senha@`, `BEGIN PRIVATE KEY`, `AKIA`, `ghp_`: sem ocorrências reais (só placeholders `SEU-PROJETO/SUA-SENHA`, regex de testes e um JWT de exemplo `sub:1234567890` em `tests/rls/24`).
- Histórico de arquivos adicionados: nenhum `.env*` (exceto `.env.example`), `.pem`, `.vercel`, credencial ou dump. `.gitignore` cobre `.env*` (menos `.env.example`), `.vercel`, `.env.deploy`, `scripts/data/.deploy-credentials.json`, `.local-owner-credentials.json`, `.cloud-owner-credentials.json`, `~/`. `.vercelignore` exclui `.env*`, `scripts/`, `tests/`, `docs/`, `.claude/`.
- A senha de fixture `DemoLocal#Test2026` (`tests/fixtures/accounts.ts:6`) e as contas `*.example.test` só existem no banco local; os scripts de deploy geram senha aleatória de 32 caracteres (`randomPassword`), e `import-restaurants.ts` também. Risco só se alguém rodar o seed local contra a nuvem: o `seed-dev` deveria recusar host que não seja local.
- `npm audit --omit=dev`: **0 vulnerabilidades**.

## 4. O que NÃO foi verificado (e por quê)

- Nada contra a nuvem/produção: a configuração real do projeto Supabase (confirmação de e-mail, política de senha, SMTP, allowlist de redirect, rate limits do Auth, backups) e da Vercel é **desconhecida**; os itens da seção 5 partem do `config.toml` local.
- O servidor em `:3100` parece ser build local; cabeçalhos podem ser adicionados pela Vercel em produção (a Vercel não adiciona CSP/HSTS por conta própria além de HSTS no domínio `vercel.app`). Confirmar com `curl -I` na URL real.
- Realtime por WebSocket: não abri conexões; conclusão sobre `postgres_changes` baseada na publicação + RLS e no F-09. Não inspecionei `realtime.messages` (canais broadcast/presence privados): se o app não usa broadcast, ok, mas qualquer usuário com a anon key pode abrir canais públicos arbitrários.
- Corridas (TOCTOU) em `record_payment`/`close_tab`/`transition_order_status`: li o código (locks `FOR UPDATE`/`NO KEY UPDATE`, idempotência por constraint) e os testes `07`, mas não rodei carga concorrente própria.
- Limites do corpo em requisições chunked sem `Content-Length` na API pública (testei só com `Content-Length`).
- XSS por dados do usuário em componentes React: confirmei ausência de sinks perigosos por `grep`, não auditei cada componente nem o PDF/print de conta e recibo.
- Upload de imagem do painel (bytes reais): F-17 segue como está; não testei sniffing em navegador real.
- Fluxo completo de e-mails (convite, recuperação, troca de e-mail) e MFA: dependem do projeto hospedado.
- Auditoria de dependências transitivas de desenvolvimento e do pacote `sdk/` (fora do `--omit=dev` da raiz).
- Modificações que fiz no banco/Storage locais durante os ataques, todas desfeitas: 1 produto de teste criado e apagado, 1 usuário `sec.probe1@example.test` criado e apagado, objetos `t1.png`/`t6.png` do bucket apagados (restam `t2`..`t5` apenas se tivessem sido aceitos; todos foram recusados). Nenhum dado de seed foi alterado.

## 5. Ações de configuração de produção (exigem o dono)

1. **Confirmação de e-mail ligada** (F-04) e fluxo de teste de convite com conta pré-cadastrada. Sem isso, convite por e-mail é reivindicável por quem se cadastra com o endereço antes.
2. **Rotacionar chaves**: `SUPABASE_SERVICE_ROLE_KEY` e chaves anon/publishable sempre que alguém de fora tiver tido acesso; confirmar que o `.env.local` contém `VERCEL_OIDC_TOKEN` (apenas local, está ignorado pelo git) e que ele não vai a nenhum log. Rotacionar a senha do banco (`SUPABASE_DB_URL`) após o deploy inicial e nunca colocá-la em variável `NEXT_PUBLIC_*`.
3. **Rate limit compartilhado** (Upstash/Vercel KV ou regra no WAF/Cloudflare) para pedidos, `cart/quote`, `track` e para as RPCs diretas do Supabase (S-04, S-05, F-24).
4. **CSP e demais cabeçalhos** (S-01), `poweredByHeader:false`, HSTS com preload só depois de validar subdomínios.
5. **Política de senha e CAPTCHA** no Auth (S-03); SMTP próprio: o limite padrão do Supabase (2 e-mails/hora no local; o SMTP embutido do plano free é igualmente baixo) quebra cadastro, convite e recuperação sob uso real.
6. **MFA TOTP obrigatório para `platform_admins`**, no mínimo para o superadmin; manter a lista de admins mínima e auditada; trocar `platform_admins` só por SQL/painel com dupla checagem.
7. **Backups**: o plano free do Supabase não dá PITR e o projeto pausa por inatividade; antes de operar com dinheiro real, plano Pro com backups diários/PITR e um teste de restauração documentado.
8. **Limites do plano free**: conexões do banco, 200 conexões Realtime simultâneas, storage de 1 GB e egress; um flood de pedidos (S-04) pode estourar a cota e derrubar o serviço para todos os restaurantes. Alertas de uso no painel.
9. **Allowlist de redirect do Auth** só com URLs exatas de produção (sem curinga), `site_url` de produção; `NEXT_PUBLIC_SITE_URL` obrigatório (S-07).
10. **Seed local nunca contra a nuvem**: `scripts/seed-dev.ts` com guarda de host; remover contas `*.example.test` se alguma chegar à produção.
11. **Aplicar a decisão de cobrança** (S-02) antes de vender planos: sem ela o trial é permanente.
12. Habilitar alertas de Auth/Postgres logs para picos de `403/42501` e de criação de restaurantes (`restaurant.registered`), pois o cadastro de restaurantes pendentes é aberto a qualquer conta (5 por usuário).
