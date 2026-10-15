import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export type AlertTone = "danger" | "success" | "info" | "warning";

const tones: Record<AlertTone, { box: string; icon: typeof Info }> = {
  danger: { box: "bg-danger-soft text-danger-soft-fg", icon: CircleAlert },
  success: { box: "bg-accent-soft text-accent-soft-fg", icon: CircleCheck },
  info: { box: "bg-info-soft text-info-soft-fg", icon: Info },
  warning: { box: "bg-warning-soft text-warning-soft-fg", icon: TriangleAlert },
};

type AlertProps = {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
  className?: string;
};

/** Feedback inline. Erros usam role="alert"; os demais, role="status". */
export function Alert({ tone = "info", title, children, className }: AlertProps) {
  const { box, icon: Icon } = tones[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex gap-3 rounded-control px-4 py-3 text-sm", box, className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && "mt-1", "leading-relaxed")}>{children}</div> : null}
      </div>
    </div>
  );
}
