import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

type CardProps = HTMLAttributes<HTMLElement> & {
  as?: ElementType;
  padded?: boolean;
};

export function Card({
  as: Tag = "section",
  padded = true,
  className,
  ...props
}: CardProps) {
  return (
    <Tag
      className={cn(
        "rounded-card border border-line bg-surface shadow-card",
        padded && "p-5 sm:p-6",
        className,
      )}
      {...props}
    />
  );
}

type CardHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  as?: "h2" | "h3";
  className?: string;
};

export function CardHeader({
  title,
  description,
  action,
  as: Heading = "h2",
  className,
}: CardHeaderProps) {
  return (
    <div className={cn("mb-4 flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <Heading className="text-base font-semibold text-fg">{title}</Heading>
        {description ? (
          <p className="mt-1 text-sm text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
