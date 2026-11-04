import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import type { TeamMember } from "@/modules/team/types";
import { displayName, initialsOf, roleLabel, sortMembers } from "./team-ui";

/** Lista da equipe SOMENTE LEITURA (gerente): quem trabalha no restaurante e com qual função. Sem edição. */
export function TeamReadOnly({ members, currentUserId }: { members: TeamMember[]; currentUserId: string }) {
  const active = sortMembers(members).filter((member) => member.status === "active");

  return (
    <section aria-labelledby="team-ro-title" className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm leading-relaxed text-muted">
        Quem tem acesso ao restaurante. Só o proprietário convida pessoas, muda funções e remove acessos.
      </p>
      <h2 id="team-ro-title" className="text-base font-semibold text-fg">
        Integrantes ({active.length})
      </h2>
      {active.length === 0 ? (
        <EmptyState icon={<Users />} title="Nenhum integrante ativo" description="Peça ao proprietário para convidar a equipe." />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {active.map((member) => (
            <li key={member.membership_id} className="flex items-center gap-3 p-4">
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-soft-fg"
              >
                {initialsOf(member)}
              </span>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <p className="truncate text-sm font-semibold text-fg">{displayName(member)}</p>
                {member.user_id !== null && member.user_id === currentUserId ? <Badge tone="info">Você</Badge> : null}
                <Badge tone={member.role === "owner" ? "accent" : "neutral"}>{roleLabel(member.role)}</Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
