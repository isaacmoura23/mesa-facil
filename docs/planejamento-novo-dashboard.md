# Planejamento: novo painel do dono ("Visão geral")

Status: PROPOSTA. Nada foi alterado no sistema. Depende da aprovação do CEO.

## O que existe hoje
Tela `/app/[slug]/dashboard` (arquivos `src/components/dashboard/*` e `src/modules/dashboard/*`).
Mostra, em cartões empilhados: vendas brutas, pedidos, ticket médio, vendas concluídas, cancelados,
recusados, "Agora" (pedidos em andamento, comandas abertas, mesas ocupadas), vendas por dia,
por modalidade, formas de pagamento e produtos mais vendidos. Filtro de período e atualização automática.

Pontos fracos: tudo tem o mesmo peso visual; o dono precisa rolar para ver o que importa;
não compara com o período anterior; não diz o que fazer; alerta "Faturamento não é lucro" ocupa o topo.

## Objetivo
Em 5 segundos o dono responde: "Como está meu dia? Preciso agir em algo agora? Como estou em relação à semana passada?"

## Princípios
1. O que exige ação vem primeiro (pedidos novos parados, comandas abertas).
2. Um número grande por vez; o resto é apoio.
3. Sempre comparar com o período anterior (seta e percentual).
4. Funciona bem no celular (o dono costuma olhar pelo celular).
5. Linguagem simples, sem jargão. Cores do Mesa Fácil (azul-marinho e laranja), modo claro e escuro.
6. Só mostrar dados que o sistema realmente tem. Nada inventado.

## Dados disponíveis hoje (sem mexer no banco)
Vendas brutas, vendas concluídas, pedidos, ticket médio, cancelados, recusados, em andamento,
comandas abertas, mesas ocupadas / total, vendas por dia, por modalidade, pagamentos, top 10 produtos.

## Dados que exigiriam ajuste novo (precisam de OK do CEO, pois mexem no banco)
- Comparação com o período anterior (nova consulta; pode ser feita rodando a mesma consulta duas vezes, sem migração).
- Vendas por hora do dia (nova consulta/RPC).
- Taxa de cancelamento (dá para calcular com dados atuais).
- Tempo médio de preparo (depende de existirem os horários de cada etapa; verificar antes).

## Blocos da nova tela
1. Faixa "Agora": pedidos novos, em preparo, comandas abertas, mesas ocupadas.
2. Número principal: vendas do período + variação contra o período anterior.
3. Mini-indicadores: pedidos, ticket médio, cancelados.
4. Gráfico de vendas por dia.
5. Produtos mais vendidos, modalidades e pagamentos (lado a lado no computador).
6. Aviso "Faturamento não é lucro" vira nota discreta no rodapé.

## Etapas (cada uma só segue com OK)
1. Escolher a opção visual (A, B ou C).
2. Construir só com dados que já existem (sem banco).
3. Testar no celular e no computador, claro e escuro.
4. Revisão de segurança e acessibilidade.
5. PR para revisão. Nada vai ao ar sem "pode aplicar".
6. Depois, se o dono aprovar, adicionar comparação com período anterior.
