/**
 * Módulos ainda não implementados. A fase é provisória (planejamento do
 * produto) e pode ser ajustada aqui sem tocar nas páginas.
 */
export type ModuleKey =
  | "pedidos"
  | "cozinha"
  | "mesas"
  | "comandas"
  | "historico"
  | "cardapio"
  | "clientes"
  | "relatorios"
  | "equipe"
  | "restaurante"
  | "configuracoes"
  | "platform-restaurants"
  | "platform-plans"
  | "platform-subscriptions"
  | "platform-support"
  | "platform-audit"
  | "platform-settings"
  | "public-menu"
  | "public-product"
  | "public-checkout"
  | "public-order";

export type ModuleInfo = {
  title: string;
  description: string;
  phase: number;
};

export const MODULES: Record<ModuleKey, ModuleInfo> = {
  pedidos: {
    title: "Pedidos",
    description: "Fila de pedidos do restaurante, com acompanhamento de status.",
    phase: 3,
  },
  cozinha: {
    title: "Cozinha",
    description: "Tela de preparo com os pedidos em andamento.",
    phase: 3,
  },
  mesas: {
    title: "Mesas",
    description: "Cadastro e estado operacional das mesas do salão.",
    phase: 4,
  },
  comandas: {
    title: "Comandas",
    description: "Contas abertas por mesa ou cliente e registro de pagamentos.",
    phase: 4,
  },
  historico: {
    title: "Histórico",
    description: "Consulta de pedidos e comandas já encerrados.",
    phase: 5,
  },
  cardapio: {
    title: "Cardápio",
    description: "Categorias, produtos, preços e disponibilidade.",
    phase: 2,
  },
  clientes: {
    title: "Clientes",
    description: "Cadastro e histórico de clientes do restaurante.",
    phase: 5,
  },
  relatorios: {
    title: "Relatórios",
    description: "Indicadores de vendas e desempenho do restaurante.",
    phase: 5,
  },
  equipe: {
    title: "Equipe",
    description: "Convites, papéis e permissões de cada pessoa da equipe.",
    phase: 2,
  },
  restaurante: {
    title: "Restaurante",
    description: "Dados cadastrais, horários de funcionamento e zonas de entrega.",
    phase: 2,
  },
  configuracoes: {
    title: "Configurações",
    description: "Preferências gerais, impressão e integrações.",
    phase: 2,
  },
  "platform-restaurants": {
    title: "Restaurantes",
    description: "Cadastro, ativação e suspensão de restaurantes da plataforma.",
    phase: 2,
  },
  "platform-plans": {
    title: "Planos",
    description: "Catálogo de planos oferecidos aos restaurantes.",
    phase: 6,
  },
  "platform-subscriptions": {
    title: "Assinaturas",
    description: "Situação de cobrança de cada restaurante.",
    phase: 6,
  },
  "platform-support": {
    title: "Suporte",
    description: "Sessões de suporte com acesso temporário e somente leitura.",
    phase: 2,
  },
  "platform-audit": {
    title: "Auditoria",
    description: "Registro de ações administrativas na plataforma.",
    phase: 6,
  },
  "platform-settings": {
    title: "Configurações da plataforma",
    description: "Parâmetros globais da plataforma.",
    phase: 6,
  },
  "public-menu": {
    title: "Cardápio",
    description: "Cardápio público do restaurante.",
    phase: 2,
  },
  "public-product": {
    title: "Produto",
    description: "Detalhes do produto do cardápio.",
    phase: 2,
  },
  "public-checkout": {
    title: "Finalizar pedido",
    description: "Revisão do carrinho, dados do cliente e envio do pedido.",
    phase: 3,
  },
  "public-order": {
    title: "Acompanhar pedido",
    description: "Status do pedido a partir do código recebido.",
    phase: 3,
  },
};
