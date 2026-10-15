import Link from "next/link";
import { ChefHat, LayoutDashboard, QrCode, ShieldCheck } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const environments = [
  {
    icon: QrCode,
    name: "Cardápio público",
    text: "O cliente abre o link do restaurante, escolhe os itens e acompanha o pedido.",
  },
  {
    icon: ChefHat,
    name: "Operação",
    text: "Caixa, cozinha e garçom trabalham pedidos, mesas e comandas em telas próprias.",
  },
  {
    icon: LayoutDashboard,
    name: "Gestão",
    text: "Dono e gerente cuidam do cardápio, da equipe e dos relatórios.",
  },
  {
    icon: ShieldCheck,
    name: "Plataforma",
    text: "Administração dos restaurantes, planos e suporte, restrita à nossa equipe.",
  },
] as const;

const roles = [
  {
    name: "Proprietário",
    text: "Configura o restaurante e acompanha tudo em modo leitura. Nunca executa ações operacionais.",
  },
  {
    name: "Gerente",
    text: "Administra o cardápio e coordena a operação do dia.",
  },
  {
    name: "Caixa",
    text: "Recebe pedidos, gerencia comandas e registra pagamentos.",
  },
  {
    name: "Cozinha",
    text: "Acompanha o preparo e atualiza o status dos pedidos.",
  },
  {
    name: "Garçom",
    text: "Atende as mesas e abre pedidos e comandas.",
  },
] as const;

export default function HomePage() {
  return (
    <>
      <section aria-labelledby="titulo-principal" className="border-b border-line">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-center lg:gap-16 lg:py-20">
          <div>
            <h1
              id="titulo-principal"
              className="text-4xl leading-[1.1] font-semibold tracking-tight text-fg text-balance sm:text-5xl"
            >
              Do cardápio à cozinha, cada pessoa no seu painel
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
              Cardápio digital, pedidos, mesas e comandas, com acesso separado para dono,
              gerente, caixa, cozinha e garçom.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/cadastro" className={buttonStyles({ size: "lg" })}>
                Criar conta
              </Link>
              <Link href="/planos" className={buttonStyles({ size: "lg", variant: "secondary" })}>
                Ver planos
              </Link>
            </div>
          </div>

          <Card as="div" className="lg:-mr-2" aria-label="Ambientes do sistema">
            <ul className="divide-y divide-line">
              {environments.map(({ icon: Icon, name, text }) => (
                <li key={name} className="flex gap-4 py-4 first:pt-0 last:pb-0">
                  <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-soft-fg"
                  >
                    <Icon className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-fg">{name}</h2>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </section>

      <section aria-labelledby="titulo-funcoes">
        <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
          <h2
            id="titulo-funcoes"
            className="max-w-2xl text-3xl font-semibold tracking-tight text-fg text-balance"
          >
            Cada função vê só o que precisa
          </h2>
          <p className="mt-4 max-w-2xl leading-relaxed text-muted">
            As permissões seguem o papel de cada pessoa. O dono atribui acessos
            operacionais apenas à equipe, nunca a si mesmo.
          </p>
          <dl className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-2">
            {roles.map((role) => (
              <div key={role.name} className="border-l-2 border-accent pl-5">
                <dt className="text-base font-semibold text-fg">{role.name}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-muted">{role.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section aria-labelledby="titulo-comecar" className="border-t border-line bg-surface">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-12 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className="max-w-xl">
            <h2 id="titulo-comecar" className="text-2xl font-semibold tracking-tight text-fg">
              Registre seu restaurante
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              O produto está sendo construído por etapas. Crie sua conta para registrar o
              restaurante e acompanhar a ativação.
            </p>
          </div>
          <Link
            href="/cadastro"
            className={buttonStyles({ size: "lg", className: "self-start md:self-auto" })}
          >
            Criar conta
          </Link>
        </div>
      </section>
    </>
  );
}
