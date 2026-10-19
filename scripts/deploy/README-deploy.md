# Deploy da demo (Vercel + Supabase na nuvem)

Tudo roda da raiz do projeto, com `npx tsx`. Nenhum script imprime chaves, senhas ou a connection string.
Os segredos ficam em dois arquivos ignorados pelo git: `.env.deploy` (chaves) e `scripts/data/.deploy-credentials.json` (senhas da demo).

## 1. Criar o projeto Supabase (novo e VAZIO)

1. supabase.com -> New project. Região: a mais próxima (ex.: South America / sa-east-1). Anote a **senha do banco** que você definir.
2. Project Settings -> **API**: copie *Project URL*, a chave *publishable/anon* e a chave *secret/service_role*.
3. Botão **Connect** (ou Project Settings -> Database) -> **Session pooler** (porta **5432**): copie a connection string e troque `[YOUR-PASSWORD]` pela senha do banco.
   Use o Session pooler (funciona em IPv4). Não use a porta 6543 (Transaction pooler) para migrações.

## 2. Preencher `.env.deploy`

```
copy scripts\deploy\env.deploy.template .env.deploy      (PowerShell/cmd)
cp scripts/deploy/env.deploy.template .env.deploy        (Git Bash)
```

Preencha `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_DB_URL`.
Nunca cole esses valores em chats, prints ou commits.

## 3. Ajustes no painel do Supabase (Authentication)

- **URL Configuration**: *Site URL* = `https://SEU-SITE.vercel.app`; em *Redirect URLs* adicione `https://SEU-SITE.vercel.app/auth/callback`.
  (Se ainda não sabe o domínio, faça o passo 5 primeiro e volte aqui.)
- **Providers -> Email -> "Confirm email"**: desligue **somente para a demo**, se quiser mostrar o cadastro (`/cadastro`) sem depender de e-mail
  (o SMTP padrão do Supabase é limitado a poucos e-mails por hora). **Risco (F-04, `tests/FINDINGS.md`)**: sem confirmação, um convite de equipe
  pode ser reivindicado por alguém que se cadastre antes com o e-mail do convidado. **Religue "Confirm email" logo depois da reunião** e antes de
  qualquer uso real. As contas de demo já nascem com e-mail confirmado: o login delas funciona com a opção ligada ou desligada.

## 4. Banco de dados e dados de demonstração

```
npx tsx scripts/deploy/apply-migrations.ts --dry-run     # varredura de privilégios + checagens, NÃO grava
npx tsx scripts/deploy/apply-migrations.ts               # aplica as 41 migrações + seed de planos e roda as checagens de segurança
npx tsx scripts/deploy/seed-demo-remote.ts               # importa La Pastelaria e O Nailton, cria contas de demo, mesas
```

- `apply-migrations` recusa host que não seja `*.supabase.co/.com`, banco que não esteja vazio e `SUPABASE_DB_URL` de projeto diferente da API.
  Se falhar no meio, corrija e rode de novo: ele **retoma** da migração que falhou (cada uma é uma transação).
- Para refazer as checagens de segurança a qualquer momento: `npx tsx scripts/deploy/apply-migrations.ts --check-only`.
- O `seed-demo-remote` sobe as imagens do Nailton a partir da pasta irmã do projeto; se estiverem em outro lugar, use `--src-root=<pasta>`.
- Não cria pedidos, clientes nem pagamentos: a operação fica vazia para você criar pedidos **ao vivo pela vitrine** (`/r/la-pastelaria`).

## 5. Publicar na Vercel

Importe o repositório na Vercel (ou `npx vercel --prod`) e defina as variáveis de ambiente do projeto **antes do build**
(as `NEXT_PUBLIC_*` são embutidas no build):

| Variável | Valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | chave publishable/anon |
| `SUPABASE_SERVICE_ROLE_KEY` | chave secret/service_role (só servidor; nunca com prefixo `NEXT_PUBLIC_`) |
| `NEXT_PUBLIC_SITE_URL` | `https://SEU-SITE.vercel.app` |

Depois volte ao passo 3 com o domínio definitivo. Os restaurantes-piloto têm `storefront_origins` apontando para os sites originais;
a vitrine do próprio app (`/r/<slug>`) não depende disso.

## 6. Verificar

```
npx tsx scripts/deploy/verify-remote.ts --site-url=https://SEU-SITE.vercel.app
```

Imprime PASS/FAIL para: `/` e `/login`; vitrines `/r/la-pastelaria` e `/r/o-nailton` com itens; API pública `/api/public/v1/.../menu`;
RPC `public_menu` direto na nuvem; `anon` sem leitura de orders/customers/payments/tabs; rotas internas redirecionando sem sessão;
login do caixa de demo e acesso à própria operação; isolamento entre os donos dos dois restaurantes. Sai com código 1 se algo falhar.

## Credenciais de demo

As senhas (aleatórias, 32 caracteres) ficam **só** em `scripts/data/.deploy-credentials.json` (e-mail, papel, restaurante, senha). O console mostra apenas os e-mails.
Contas: `dono@`, `gerente@`, `caixa@`, `cozinha@`, `garcom@la-pastelaria.example.test` e `dono@o-nailton.example.test`.

- Rodar o seed de novo **não** duplica nada nem troca senhas.
- Rotacionar todas: `npx tsx scripts/deploy/seed-demo-remote.ts --skip-import --rotate-passwords` (as senhas antigas deixam de valer).
- Se perder o arquivo, as contas continuam existindo mas sem senha conhecida: rode com `--rotate-passwords`. (Sem o arquivo, o importador gera
  senha nova para os donos na próxima execução.)
- Os e-mails usam o domínio reservado `.test`; se o Auth da nuvem recusar esse domínio, o script avisa no erro.

## Desfazer

- Pausar ou apagar o projeto em Supabase -> Project Settings -> General (apagar remove banco, Auth e Storage de uma vez).
- Na Vercel, remova o projeto ou as variáveis de ambiente. Apague `.env.deploy` e `scripts/data/.deploy-credentials.json` localmente.
- Se a service role vazar, gere uma nova em Project Settings -> API (e atualize `.env.deploy` e a Vercel).

## O que a demo NÃO tem

- A área **Plataforma** (`/platform`) é um placeholder: não há conta superadmin de demo (`platform_admins` fica vazio de propósito).
- Sem pagamento online real (apenas pagamento manual registrado pelo caixa), sem e-mails transacionais próprios e sem pedidos pré-criados.
- Assinatura dos restaurantes é um *trial* de teste (90 dias, plano Básico), sem cobrança.
