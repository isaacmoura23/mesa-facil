# Mesa Fácil (nome provisório)

SaaS web de gestão para restaurantes, multi-tenant: cardápio público, painel operacional dos funcionários, painel
administrativo do dono (monitoramento em modo leitura) e painel da plataforma. Next.js 16 (App Router) + TypeScript +
Tailwind 4 + Supabase (Auth, Postgres com RLS, Storage, Realtime).

> Estado: **Fase 1 (fundação)** — autenticação, esquema/migrações, RLS, permissões, layouts dos 4 ambientes e testes de
> isolamento. Módulos de cardápio, pedidos, mesas/comandas, relatórios e plataforma aparecem como "previsto para a Fase X".

## Pré-requisitos

- Node 22+ e npm
- Docker Desktop (para o Supabase local)

## Execução local

```bash
npm install
npm run db:start          # sobe o Supabase local e aplica as migrações + seed de planos
npx supabase status       # copie API URL e anon/publishable key
cp .env.example .env.local   # preencha NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev               # http://localhost:3000
```

Dados de demonstração (restaurantes `demo-a` e `demo-b`, contas `@example.test`, superadmin): `npm run db:seed:dev`
(recusa rodar fora de localhost). Credenciais de teste ficam em `tests/fixtures/accounts.ts` — valem só para o banco local.

## Banco de dados

Migrações versionadas em `supabase/migrations/` (identidade/permissões `0001–0013`, domínio `0100–0110`, endurecimento `0111`).

```bash
npm run db:reset    # recria o banco local do zero (migrações + seed)
npm run db:stop
```

Para um projeto na nuvem: `npx supabase link --project-ref <ref>` e `npx supabase db push`. Nunca coloque a service role
em variáveis `NEXT_PUBLIC_*`. Em produção/staging, ligue `enable_confirmations = true` no Auth (ver `tests/FINDINGS.md`, F-04).

## Testes

```bash
npm test           # unitários + integração RLS (exige Supabase local rodando, ~100 s)
npm run typecheck && npm run lint && npm run build
```

Os testes de integração atacam a API como um navegador (chave anon + login real), cobrindo isolamento entre restaurantes,
escalonamento de privilégio, anônimo, dono somente-leitura, máquina de estados, concorrência, Storage, Realtime e sessões
de suporte. Detalhes em `tests/README.md`; achados de segurança em `tests/FINDINGS.md`.

## Arquitetura

- `docs/CONTRACT.md` — papéis, permissões, funções SQL e divisão de módulos.
- Autorização: RLS + funções `has_permission(rid, perm)`; o `slug` só identifica o restaurante. O papel `owner` nunca recebe
  permissões operacionais (monitora em leitura). Superadmin só acessa dados de um restaurante via sessão de suporte
  justificada, temporária, somente leitura e auditada.
- Guards no servidor: `src/lib/auth/guards.ts`. Proxy de sessão: `src/proxy.ts`.

## Vitrines personalizadas (headless)

Cada restaurante pode ter um site próprio que consome o SaaS pela API pública (`/api/public/v1/restaurants/{slug}/menu` e
`.../cart/quote`), sem chaves do Supabase. O dono cadastra o domínio da vitrine em `/app/[slug]/restaurante` (CORS por restaurante).
SDK tipado em `sdk/` (ver `sdk/README.md`). `/r/[slug]` é a vitrine padrão. Criação de pedidos pela API: Fase 3.

Importação dos clientes piloto (La Pastelaria e O Nailton, só no Supabase local): `npx tsx scripts/import-restaurants.ts`
(idempotente; `--dry-run`, `--reset`; senhas dos donos locais em `scripts/data/.local-owner-credentials.json`, fora do git).

## Variáveis de ambiente

Ver `.env.example`. `SUPABASE_SERVICE_ROLE_KEY` é só de servidor (módulo `server-only`).

## Fora desta fase

Checkout e criação de pedidos (RPC), operação em tempo real, impressão, mesas/comandas, relatórios, planos/assinaturas,
cobrança online (pagamentos hoje serão manuais), recuperação de senha, geração de `database.types.ts`.
