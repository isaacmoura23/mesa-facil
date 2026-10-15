import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type SpinnerProps = {
  className?: string;
  /** Texto lido por leitores de tela. */
  label?: string;
  /** Quando dentro de um botão, o rótulo já existe: oculte o status. */
  decorative?: boolean;
};

export function Spinner({
  className,
  label = "Carregando",
  decorative = false,
}: SpinnerProps) {
  return (
    <span
      role={decorative ? undefined : "status"}
      aria-hidden={decorative || undefined}
      className="inline-flex"
    >
      <LoaderCircle
        aria-hidden="true"
        className={cn("size-4 animate-spin motion-reduce:animate-none", className)}
      />
      {decorative ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}
