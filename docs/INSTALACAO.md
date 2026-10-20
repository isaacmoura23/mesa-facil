# Instalação e publicação

Comandos pensados para a raiz do projeto. Em Windows/PowerShell, se aparecer "a execução de scripts foi desabilitada",
troque `npm`/`npx` por `npm.cmd`/`npx.cmd` (ver "Erros comuns").

## Parte 1 — Local

### Requisitos
- Node 22+ e npm; Docker Desktop **aberto e rodando**; Git.

### Passo a passo
1. `npm install`
2. `npm run db:start` — `supabase start`: sobe os containers (API em `127.0.0.1:54321`, Postgres em `54322`, Studio em `54323`),
   aplica `supabase/migrations/*` e `supabase/seed.sql` (planos). Primeira vez baixa imagens (demora).
3. `npx supabase status` — anote **API URL**, **anon/publishable key** e **service_role/secret key**.
4. Copie `.env.example` para `.env.local` e preencha `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` e `NEXT_PUBLIC_SITE_URL=http://localhost:3000`.
5. `npm run db:seed:dev` — restaurantes DEMO A/B, contas `@example.test` e superadmin (senhas em `tests/fixtures/accounts.ts`).
6. `npx tsx scripts/import-restaurants.ts` — La Pastelaria, O Nailton e Qi Buxo (use `--dry-run` antes, se quiser só validar).
7. `npm run dev` e abra http://localhost:3000. Vitrine: `/r/la-pastelaria`. Painéis: faça login em `/login`.

Outros: `npm run db:stop`, `npm run db:reset` (recria banco: migrações + seed), `npm run typecheck`, `npm run lint`, `npm run build`.

### Alternativas ao Supabase CLI (Windows, antivírus bloqueando `supabase.exe`)
Se `npm run db:start` falhar por bloqueio do executável, o Supabase local pode ser subido de outra forma (por exemplo, o
CLI baixado do GitHub e liberado no antivírus, ou os containers pelo Docker) e as migrações aplicadas assim:

- **`docker exec` + psql** (container do banco local, nome `supabase_db_test1`, usuário `postgres`), em ordem lexicográfica:
  ```bash
  for f in supabase/migrations/*.sql; do docker exec -i supabase_db_test1 psql -U postgres -v ON_ERROR_STOP=1 -f - < "$f"; done
  docker exec -i supabase_db_test1 psql -U postgres -v ON_ERROR_STOP=1 -f - < supabase/seed.sql
  ```
  (Git Bash. O redirecionamento `<` do PowerShell não funciona: use `Get-Content arquivo | docker exec -i ... psql ...`.)
- **`scripts/deploy/apply-migrations.ts`**: foi feito para a nuvem (recusa host que não seja `*.supabase.co/.com`); para o banco
  local use as opções acima.
- Aviso: o fluxo `supabase db reset` do zero nunca foi validado no Windows com o CLI bloqueado.

### Testes
Ver `README.md` e `tests/README.md`. Resumo: `npm test` (com Supabase local de pé); `npx vitest run --project unit` não precisa de banco.

## Parte 2 — Publicar (Supabase na nuvem + Vercel)

Referência detalhada: `scripts/deploy/README-deploy.md`. Os scripts nunca imprimem chaves, senhas nem a connection string.
Segredos ficam em arquivos ignorados pelo git: `.env.deploy` e `scripts/data/.deploy-credentials.json`.

### 1. Projeto Supabase (novo e VAZIO)
1. supabase.com -> New project; região próxima (ex.: South America / sa-east-1). Guarde a **senha do banco**.
2. Project Settings -> **API**: copie *Project URL*, chave *publishable/anon* e chave *secret/service_role*.
3. Botão **Connect** -> **Session pooler**, porta **5432**: copie a connection string e troque `[YOUR-PASSWORD]` pela senha.
   - **Use o Session pooler** (funciona em IPv4). O host *direto* (`db.<id>.supabase.co`) costuma ser só IPv6 e falha em muitas redes.
   - **Não use a porta 6543** (Transaction pooler) para migrações.

### 2. `.env.deploy`
```
copy scripts\deploy\env.deploy.template .env.deploy      (PowerShell/cmd)
cp scripts/deploy/env.deploy.template .env.deploy        (Git Bash)
```
Preencha `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_DB_URL`.

Para a connection string sem expô-la: `npx.cmd tsx scripts/deploy/set-db-url.ts` — pede a conexão com a **entrada escondida**,
valida formato/host/projeto e grava em `.env.deploy`. Precisa de terminal **interativo** (painel de Terminal/PowerShell
normal, não um execução em segundo plano). Se a senha do banco tiver caracteres especiais (`@ : / # ? %`), prefira
trocar a senha por uma só com letras e números em Project Settings -> Database, ou codifique-os em URL (`@` -> `%40`).

### 3. Migrações e dados de demonstração
```
npx tsx scripts/deploy/apply-migrations.ts --dry-run     # varredura de privilégios + checagens; NÃO grava
npx tsx scripts/deploy/apply-migrations.ts               # aplica todas as migrações + seed de planos + checagens de segurança
npx tsx scripts/deploy/seed-demo-remote.ts               # pilotos, contas de demo, mesas
```
- Recusa host que não seja `*.supabase.co/.com`, banco **não vazio** e `SUPABASE_DB_URL` de projeto diferente da API.
- Se falhar no meio, corrija e rode de novo: ele **retoma** da migração que falhou (cada uma é uma transação).
- Refazer só as checagens: `--check-only`; só a varredura estática: `--scan-only`; reaplicar planos: `--force-seed`.
- `seed-demo-remote` aceita `--rotate-passwords`, `--skip-import`, `--src-root=<pasta>`, `--env-file=<arq>`. Não cria pedidos,
  clientes nem pagamentos. Senhas em `scripts/data/.deploy-credentials.json`.
- Superadmin: o seed da nuvem **não** cria. Para ter um, cadastre-se em `/cadastro` e insira o `user_id` em
  `platform_admins` (role `superadmin`) pelo SQL Editor do Supabase.

### 4. Vercel
Importe o repositório (ou `npx vercel --prod`) e defina as variáveis **antes do build**:

| Variável | Valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | chave publishable/anon |
| `SUPABASE_SERVICE_ROLE_KEY` | chave secret/service_role (só servidor) |
| `NEXT_PUBLIC_SITE_URL` | `https://SEU-SITE.vercel.app` (ou o domínio próprio) |

`.vercelignore` já impede o envio de `.env*`, `scripts/`, `tests/`, `docs/`. Se mudar variáveis `NEXT_PUBLIC_*`, faça novo deploy.

### 5. Domínio e Auth
- Domínio próprio: Vercel -> Settings -> Domains, configure o DNS pedido e atualize `NEXT_PUBLIC_SITE_URL` (novo deploy).
- Supabase -> Authentication -> **URL Configuration**: *Site URL* = seu domínio; em *Redirect URLs* adicione `https://SEU-DOMINIO/auth/callback`.
- Authentication -> Providers -> Email -> **Confirm email**: desligue só para uma demonstração (o SMTP padrão limita poucos e-mails/hora).
  **Religue antes de qualquer uso real** (F-04: com confirmação desligada, um convite de equipe pode ser tomado por quem se cadastrar antes com o e-mail do convidado).
  As contas de demo nascem confirmadas e funcionam nos dois casos.

### 6. Verificar
```
npx tsx scripts/deploy/verify-remote.ts --site-url=https://SEU-SITE.vercel.app
```
Imprime PASS/FAIL (páginas, vitrines, API pública, RPC `public_menu`, anon sem acesso a dados privados, rotas internas
redirecionando, login da demo, isolamento entre donos). Sai com código 1 se algo falhar.

## Erros comuns

| Sintoma | Causa e solução |
|---|---|
| "a execução de scripts foi desabilitada neste sistema" (PowerShell) | Política de execução bloqueia `npm.ps1`/`npx.ps1`. Use `npm.cmd` / `npx.cmd` ou o Git Bash. |
| `set-db-url` trava ou não aceita entrada | Precisa de terminal interativo. Rode no Terminal normal, não por um agente/segundo plano. O instalador do CLI também é interativo: não rode em modo não interativo. |
| `ENOTFOUND`/timeout no host `db.<id>.supabase.co` | Host direto é só IPv6. Use o **Session pooler** (porta 5432). |
| Falha de autenticação no banco com senha "certa" | Caracteres especiais na senha quebram a URL. Troque a senha ou codifique em URL. |
| `supabase.exe` bloqueado/some | Antivírus. Libere o executável ou use as alternativas da Parte 1. |
| Mudei o `.env`/script e "nada acontece" | Você editou outra cópia da pasta do projeto. Confira `pwd`/`cd` e que o arquivo salvo está na raiz usada. |
| `apply-migrations` recusa o banco | O banco não está vazio e não é uma retomada. Use um projeto novo. |
| Site abre mas sem dados / login falha | Variáveis `NEXT_PUBLIC_*` erradas no build (refaça o deploy) ou Redirect URLs sem `/auth/callback`. |
| `tests/api` "pulado" | Não há servidor em `API_BASE_URL` (padrão `http://localhost:3100`). |

## Desfazer
- Supabase -> Project Settings -> General: pausar ou **apagar** o projeto (remove banco, Auth e Storage).
- Vercel: remover o projeto ou as variáveis. Local: apagar `.env.deploy` e `scripts/data/.deploy-credentials.json`.
- Service role vazada: gerar nova em Project Settings -> API e atualizar `.env.deploy` e a Vercel.
- Local: `npm run db:stop` (mantém dados) ou `npm run db:reset` (recria do zero).

## O que falta fora do código
Itens que dependem de serviços/decisões externas (não implementados):
- **Pagamento online** (hoje só registro manual no caixa) e **nota fiscal**.
- **E-mail transacional** e **convites por e-mail** (o convite fica registrado; a pessoa precisa se cadastrar com o mesmo e-mail); **recuperação de senha**.
- **Confirmação de e-mail em produção** (ligar "Confirm email" + SMTP próprio) — requisito antes de uso real.
- **Impressora térmica física**: validar 80/58 mm em hardware; impressão silenciosa exigiria integração local.
- **Domínio próprio** e DNS.
- **Rate limit compartilhado** (Upstash/KV): hoje o limite da API pública é por instância, em memória.
- Backups automáticos e monitoramento (ver `docs/OPERACAO.md`).
