# Mesa Fácil (nome provisório)

SaaS web multi-tenant de gestão para restaurantes: vitrine/cardápio público, operação (caixa, cozinha, mesas, comandas),
painel do dono (gestão + monitoramento somente leitura) e painel da plataforma. Next.js 16 (App Router) + TypeScript +
Tailwind 4 + Supabase (Auth, Postgres com RLS, Storage, Realtime).

## Estado

As 7 fases estão concluídas:

| Fase | Conteúdo |
|---|---|
| 1 | Fundação, autenticação, esquema/migrações, RLS, permissões, isolamento |
| 2 + 2.5 | Cardápio, vitrine, API pública + SDK, variantes/adicionais, importação dos pilotos |
| 3 | Pedidos reais, tempo real, cozinha, histórico, impressão |
| 4 | Mesas, comandas, pagamento manual, conta, fechamento |
| 5 | Dashboard, monitoramento, clientes, relatórios (CSV), equipe, configurações |
| 6 | Plataforma: restaurantes, planos/assinaturas, suporte com sessão justificada, auditoria, configurações globais |
| 7 | Validação final: E2E de navegador, revisão de segurança independente (`docs/REVISAO-SEGURANCA.md`), documentação e publicação (`docs/RELATORIO-FINAL.md`) |

Pendências que dependem de decisão ou de serviços externos estão em "Limitações conhecidas" e em
`docs/INSTALACAO.md` (seção "O que falta fora do código").

## Ambientes e rotas

| Ambiente | Rota | Quem usa |
|---|---|---|
| Site / entrada | `/`, `/planos`, `/login`, `/cadastro`, `/entrar` | visitantes |
| Vitrine padrão | `/r/[slug]` (cardápio, carrinho, checkout, acompanhamento) | cliente final |
| Operação | `/operacao/[slug]/` (pedidos, cozinha, histórico, mesas, comandas) | caixa, garçom, cozinha, gerente |
| Painel do dono | `/app/[slug]/` (dashboard, pedidos, cardápio, mesas, comandas, clientes, relatórios, equipe, configurações, restaurante) | dono e gerente |
| Plataforma | `/platform/` (dashboard, restaurantes, planos, assinaturas, suporte, auditoria, configurações) | superadmin / suporte |
| API pública | `/api/public/v1/restaurants/{slug}/menu`, `/cart/quote`, `/orders`, `/orders/{publicCode}` | sites próprios dos restaurantes |

O SDK (`sdk/`, ver `sdk/README.md`) embrulha a API pública para vitrines personalizadas, sem chaves do Supabase.

## Arquitetura em poucas linhas

- Uma aplicação Next.js; as regras críticas ficam no banco (funções SQL `SECURITY DEFINER`, RLS com `FORCE` em tudo).
  A UI nunca é a autoridade.
- Autorização: `has_permission(restaurante, permissão)` + papéis/overrides. O `slug` da URL só identifica o restaurante.
  Guards no servidor em `src/lib/auth/guards.ts`; renovação de sessão em `src/proxy.ts`.
- Preço único: `app_private.price_cart_core` (vitrine e equipe usam a mesma regra). Pedido público: só pela service role,
  idempotente.
- Detalhes: `docs/ARQUITETURA.md` (visão geral) e `docs/CONTRACT.md` (papéis, permissões, funções SQL).

## Requisitos

- Node 22+ e npm
- Docker Desktop (Supabase local)
- Windows: o Supabase CLI instalado pelo npm (`supabase` em `devDependencies`) pode ser bloqueado pelo antivírus. Alternativas
  (psql / `docker exec`, ou `scripts/deploy/apply-migrations.ts`) estão em `docs/INSTALACAO.md`.
  No PowerShell com política de execução restrita, use `npm.cmd` / `npx.cmd`.

## Início rápido local

```bash
npm install
npm run db:start                      # supabase start: sobe os containers e aplica migrações + seed de planos
npx supabase status                   # copie API URL, anon key e service_role
cp .env.example .env.local            # preencha as 4 variáveis (ver .env.example)
npm run db:seed:dev                   # restaurantes DEMO A/B, contas @example.test, superadmin (recusa host não-local)
npx tsx scripts/import-restaurants.ts # clientes piloto: La Pastelaria, O Nailton, Qi Buxo (idempotente)
npm run dev                           # http://localhost:3000
```

Flags úteis do importador: `--dry-run`, `--reset`, `--only=<slug>`, `--prune`, `--src-root=<dir>` (imagens-fonte),
`--env-file=<arq>`. Veja o cabeçalho de `scripts/import-restaurants.ts`. As imagens do O Nailton vêm de uma pasta irmã do
projeto; sem elas, o item fica sem foto.

## Contas de demonstração

Todas usam e-mails reservados `@example.test` e **só funcionam no banco local ou na demo que você mesmo publicou**.

| Conta | Onde ficam as senhas |
|---|---|
| Seed local (`db:seed:dev`): contas dos restaurantes DEMO A/B (dono, gerente, caixa, cozinha, garçom...) e `superadmin@example.test` | `tests/fixtures/accounts.ts` (senha fixa de teste, só para o banco local) |
| Donos dos pilotos no banco local | `scripts/data/.local-owner-credentials.json` (gerado pelo importador, fora do git) |
| Demo na nuvem (`dono@`, `gerente@`, `caixa@`, `cozinha@`, `garcom@la-pastelaria.example.test`, `dono@o-nailton.example.test`) | `scripts/data/.deploy-credentials.json` (aleatórias, fora do git) |

A demo na nuvem pode ter uma conta superadmin criada à parte (ver `docs/INSTALACAO.md`); sua senha, se existir, fica em `scripts/data/.cloud-owner-credentials.json` (fora do git).

## Testes

```bash
npm run typecheck && npm run lint && npm run build
npm test                                      # unit + rls (+ api, se houver servidor): exige Supabase local rodando
npx vitest run --project unit                 # só unitários, sem banco
npx vitest run --project rls tests/rls/05-orders-state-machine.test.ts   # um arquivo
# API HTTP (tests/api): suba o app em outra porta e aponte para ele
npx next dev -p 3100                          # terminal 1
API_BASE_URL=http://localhost:3100 npm test   # terminal 2 (sem servidor, tests/api se pula com aviso)
```

- `unit`: lógica pura (schemas, formatação, período, CSV, carrinho...).
- `rls`: integração real contra o Supabase local como um navegador (chave anon + login real): isolamento entre
  restaurantes, escalonamento de privilégio, dono somente leitura, máquina de estados, concorrência, Storage, Realtime,
  sessões de suporte, RPCs das Fases 2 a 6.
- `api`: API pública por HTTP real e o SDK.
- `e2e`: navegador real (Playwright/Chromium) nas 3 modalidades (entrega, retirada, salão), controle de acesso por papel, responsividade (375/768/1280 px) e idempotência. Roda contra o app local: `npm run test:e2e` (exige Supabase local e `npm run dev -- -p 3100`). Impressão: `window.print` é simulado (hardware real não testado).

Detalhes em `tests/README.md`; achados de segurança em `tests/FINDINGS.md`. O seed de teste é determinístico: restaura o
estado base dos restaurantes DEMO a cada execução.

## Segurança

- RLS + `FORCE` em todas as tabelas; escritas sensíveis só por RPC; grants por coluna; `storefront_origins` invisível aos clientes.
- **O dono nunca recebe permissão operacional**: ele monitora em leitura; a equipe (gerente, caixa, cozinha, garçom) opera.
- **Superadmin** (plataforma) não lê dados de um restaurante por padrão. Só através de uma **sessão de suporte**:
  justificada, temporária, somente leitura e auditada (o restaurante vê o registro).
- `audit_logs` é imutável (nem a service role altera). Dados pessoais de clientes: acesso registrado (`customer.viewed`).
- A service role é só de servidor. Nunca use `NEXT_PUBLIC_` com ela.
- Em produção, ligue "Confirm email" no Auth (achado F-04 em `tests/FINDINGS.md`).

## Limitações conhecidas

- Pagamento é registro manual (sem provedor online); sem nota fiscal.
- Impressão via diálogo do navegador (`window.print()`, 80/58 mm); nunca testada em impressora térmica física; sem impressão silenciosa.
- Limite de requisições da API pública é por instância (em memória), não compartilhado.
- Sem e-mail transacional próprio (convites de equipe não enviam e-mail), sem recuperação de senha.
- Os "bugs menores abertos" listados em `tests/FINDINGS.md` (F-17, F-20, F-24, F-29/F-30, F-35, F-37 a F-40; confira o arquivo, pode ter mudado).
- `supabase db reset` do zero nunca foi validado no Windows com o CLI bloqueado; as migrações foram aplicadas em sequência.
- O nome "Mesa Fácil" é provisório.

## Documentação

- `docs/INSTALACAO.md` — instalação local e publicação (Supabase + Vercel), erros comuns, como desfazer.
- `docs/OPERACAO.md` — rotina do dono e da equipe.
- `docs/ARQUITETURA.md`, `docs/CONTRACT.md` — arquitetura e contrato técnico.
- `scripts/deploy/README-deploy.md` — referência dos scripts de publicação.
