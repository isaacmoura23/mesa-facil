# Operação — rotina do dono e da equipe

Rotas citadas assumem `[slug]` = identificador do restaurante (ex.: `la-pastelaria`). Quem vê o quê depende do papel:
**dono** monitora (leitura); **gerente, caixa, cozinha e garçom** operam. O dono nunca recebe permissão operacional.

## 1. Criar um restaurante (plataforma)
1. Entre como superadmin e abra `/platform/restaurants`; crie o restaurante (nome, slug, plano, e-mail do dono). O slug é minúsculo, sem espaços,
   e a regra é a mesma do banco. Novos restaurantes ganham assinatura em período de teste (dias definidos em `/platform/settings`).
2. Planos e assinaturas: `/platform/plans`, `/platform/subscriptions`. Cadastro público de restaurantes pode ser desligado em
   `/platform/settings` (vira `REGISTRATION_DISABLED`).
3. Alternativa: o próprio usuário se cadastra em `/cadastro` e cria um restaurante `pending`, que a plataforma ativa.
4. Suspender um restaurante tira o acesso do dono e da equipe imediatamente e tira a vitrine do ar.

## 2. Convidar a equipe
Em `/app/[slug]/equipe` (permissão `team.manage`): informe e-mail e papel. **Nenhum e-mail é enviado**: peça para a pessoa se
cadastrar/entrar em `/entrar` com **o mesmo e-mail** e aceitar o convite. Você pode trocar o papel, revogar (efeito imediato) e
ajustar permissões individuais; `team.manage` não pode ser delegada. Com "Confirm email" desligado no Auth, um convite pode ser
tomado por quem se cadastrar primeiro com aquele e-mail: em produção mantenha a confirmação ligada.

## 3. Cardápio (`/app/[slug]/cardapio`)
Categorias e produtos, ordem (arrastar/reordenar), ativar/desativar, foto (até 5 MB; PNG, JPEG, WebP ou AVIF; SVG é recusado).
**Variantes** (ex.: tamanhos, com preço próprio) e **grupos de adicionais** (mín./máx., preço extra) por produto; selos (badges).
O preço é sempre recalculado no servidor: o que o cliente vê no carrinho não é a autoridade. Variantes já vendidas não podem
ser apagadas, apenas desativadas.

## 4. Horários, zonas e configurações (`/app/[slug]/configuracoes`)
Fuso horário, aceitar pedidos, mínimo, modalidades (entrega, retirada, salão), faixas de horário por dia (até 6 por dia, sem
sobreposição), exceções (feriados), zonas de entrega com taxa (até 50). Fora do horário a vitrine recusa pedidos.
Perfil, contato, logo e domínios da API: `/app/[slug]/restaurante`.

## 5. Vitrine própria (API pública + SDK)
1. A vitrine padrão é `/r/[slug]`. Um site próprio consome a API pública:
   `GET /api/public/v1/restaurants/{slug}/menu`, `POST .../cart/quote`, `POST .../orders` (cabeçalho `Idempotency-Key`),
   `GET .../orders/{publicCode}`. Sem chaves do Supabase no site.
2. **Domínios autorizados (CORS)**: cadastre a origem do site (ex.: `https://meu-site.com`) em `/app/[slug]/restaurante`.
   Origem não cadastrada recebe 403; `localhost` só é aceito em desenvolvimento.
3. SDK: `sdk/` (`createStorefrontClient`: `getMenu`, `quoteCart`, `createOrder`, `trackOrder`). Instalação e exemplos em `sdk/README.md`.
4. Cache: cardápio ~30 s e origens ~60 s; a edição aparece na vitrine em até ~1 minuto.
5. Limites: pedidos por IP (5 criados / 10 min), consulta 60/min; por instância, não compartilhado.

## 6. Pedidos em tempo real e cozinha (`/operacao/[slug]`)
- **Pedidos** (`/pedidos`): chegam por Realtime com alerta sonoro (preferência por usuário). Caixa aceita ou recusa (recusa
  exige motivo); gerente cancela com motivo. Transições válidas são impostas pelo banco.
- **Cozinha** (`/cozinha`): só avança PREPARING -> READY. Entrega/retirada conclui o pedido.
- **Histórico** (`/historico`): consulta e exportação CSV.
- O dono vê tudo em `/app/[slug]/pedidos`, sem poder alterar.

## 7. Mesas, comandas e pagamento manual
1. Cadastro de mesas: `/app/[slug]/mesas` (QR por mesa; `rotate_table_qr` troca o token). Operação: `/operacao/[slug]/mesas`.
2. Abrir comanda numa mesa (uma comanda aberta por mesa) ou comanda de balcão (exige etiqueta). Pedidos de salão vão para a cozinha.
3. **Pagamento manual**: o caixa registra pagamentos parciais (dinheiro com troco, Pix, cartão) — não há provedor online.
   Cada registro é idempotente pela referência.
4. Conta parcial ou final (impressão), fechamento: com saldo em aberto exige justificativa (auditada). A mesa vai para limpeza e
   depois é liberada. Garçom abre e lança pedidos mas não paga nem fecha com saldo.
5. Monitoramento e CSV de comandas para o dono: `/app/[slug]/comandas`.

## 8. Impressão
Comanda de cozinha, recibo do pedido e conta (parcial/final) em **80 mm ou 58 mm**. É o **diálogo de impressão do navegador**
(`window.print()`): escolha a impressora e o tamanho do papel nele. **Não há impressão silenciosa**; cada impressão pede
confirmação. Para reduzir cliques, use o navegador em modo quiosque com a impressora padrão — configuração do sistema
operacional, fora do app. O texto impresso não contém telefone/e-mail do cliente na comanda de cozinha. Não foi testado em
impressora térmica física: faça uma impressão de teste antes de abrir.

## 9. Relatórios e CSV (`/app/[slug]/relatorios`, `/dashboard`)
Período (dia/semana/mês ou intervalo de até 366 dias) no fuso do restaurante. Sete relatórios; exportação CSV com BOM e `;`,
com proteção contra fórmulas de planilha. Valores: "bruto" inclui cancelados; "concluídos" não; ticket médio sobre o bruto.
Permissão `reports.view`.

## 10. Clientes e LGPD (`/app/[slug]/clientes`)
Cadastro criado a partir dos pedidos (telefone normalizado). Dados pessoais só para quem tem `reports.view`. **Cada abertura
da ficha de um cliente é registrada** na auditoria (`customer.viewed`), visível em `list_audit_logs`/auditoria. Princípios:
coletar o mínimo, usar só para o pedido, atender pedido de exclusão/correção do titular (hoje via suporte/SQL: não há botão
de exclusão), não expor dados em prints e relatórios compartilhados. A consulta pública de pedido (`track_order`) não devolve PII.

## 11. Suporte com sessão justificada (plataforma)
O superadmin/suporte **não lê** dados de um restaurante por padrão. Para atender um chamado (`/platform/support`):
1. Abra uma sessão de suporte informando o restaurante e a **justificativa**.
2. A sessão é temporária, somente leitura e auditada; o restaurante enxerga o registro de que houve acesso.
3. Encerre ao terminar (ou ela expira sozinha). Chamados: `support_tickets`. Auditoria da plataforma: `/platform/audit-logs`.

## 12. Backups e rotação de chaves
- **Backups**: no Supabase na nuvem, ative backups diários (planos pagos) ou exporte periodicamente com
  `pg_dump` usando a connection string do Session pooler; guarde fora do projeto e teste a restauração. Storage (fotos) tem
  backup separado. `audit_logs` é imutável: preserve-o ao restaurar.
- **Rotação de chaves**: gere nova `service_role`/secret em Project Settings -> API, atualize `.env.deploy` e a variável
  `SUPABASE_SERVICE_ROLE_KEY` na Vercel e faça novo deploy; revogue a antiga. Se a anon key mudar, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  também exige novo deploy (é embutida no build).
- **Senhas da demo**: `npx tsx scripts/deploy/seed-demo-remote.ts --skip-import --rotate-passwords`.
- **Senha do banco**: troque em Project Settings -> Database e rode `set-db-url` de novo.

## Roteiro de validação manual (E2E das 3 modalidades)
Não há E2E automatizado de navegador. Antes de abrir um restaurante:
1. **Retirada**: vitrine `/r/[slug]` -> pedido -> código de acompanhamento -> caixa aceita -> cozinha prepara -> pronto -> concluído.
2. **Entrega**: igual, com endereço dentro de uma zona e taxa; pedido fora da zona deve ser recusado.
3. **Salão**: abrir comanda numa mesa -> lançar pedido -> pagamento parcial + restante -> fechar -> mesa liberada.
4. Imprimir comanda de cozinha, recibo e conta (80 e 58 mm) e conferir o papel.
5. Como dono, confirmar que nada é alterável e que dashboard/relatórios batem com os pedidos.
