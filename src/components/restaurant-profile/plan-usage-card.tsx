import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { getSubscriptionStatus } from "@/modules/plan/queries";
import { STATE_LABELS, type SubscriptionState } from "@/modules/plan/status";

const STATE_TONES: Record<SubscriptionState, BadgeTone> = {
  active: "accent",
  trial: "info",
  expired: "danger",
  past_due: "warning",
  cancelled: "danger",
  none: "neutral",
};

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "America/Sao_Paulo" }).format(date);
}

/** Plano contratado e uso dos limites (equipe, mesas, produtos). Só leitura: a troca é feita pelo suporte. */
export async function PlanUsageCard({ restaurantId }: { restaurantId: string }) {
  const status = await getSubscriptionStatus(restaurantId);
  if (!status) return null;

  const until = formatDate(status.state === "trial" ? status.trialEndsAt : status.periodEnd);
  const untilLabel = status.state === "trial" ? "Teste até" : "Período até";

  return (
    <Card aria-labelledby="plano-uso">
      <CardHeader
        title={<span id="plano-uso">Plano e uso</span>}
        description="Limites contratados e quanto você já usa. Para trocar de plano, fale com o suporte."
        action={<Badge tone={STATE_TONES[status.state]}>{STATE_LABELS[status.state]}</Badge>}
      />
      <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Plano</dt>
          <dd className="font-medium text-fg">{status.planName ?? "Sem plano definido"}</dd>
        </div>
        {until ? (
          <div>
            <dt className="text-muted">{untilLabel}</dt>
            <dd className="font-medium text-fg">{until}</dd>
          </div>
        ) : null}
      </dl>
      <ul className="mt-5 flex flex-col gap-4">
        {status.usage.map((row) => {
          const pct = row.limit === null ? 0 : row.limit === 0 ? 100 : Math.min(100, Math.round((row.used / row.limit) * 100));
          return (
            <li key={row.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-fg">{row.label}</span>
                <span className={row.reached ? "font-medium text-danger-soft-fg" : "text-muted"}>
                  {row.used} {row.limit === null ? "(ilimitado)" : `de ${row.limit}`}
                </span>
              </div>
              {row.limit !== null ? (
                <div
                  role="progressbar"
                  aria-label={row.label}
                  aria-valuemin={0}
                  aria-valuemax={row.limit}
                  aria-valuenow={Math.min(row.used, row.limit)}
                  className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2"
                >
                  <div
                    className={row.reached ? "h-full bg-danger" : "h-full bg-accent"}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
