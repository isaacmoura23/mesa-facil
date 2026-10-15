import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function inputStyles(invalid?: boolean, className?: string): string {
  return cn(
    "block h-11 w-full rounded-control border bg-surface px-3 text-base text-fg placeholder:text-muted/80 transition-colors sm:text-sm",
    "hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-60",
    invalid ? "border-danger" : "border-line",
    className,
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  /** Texto de apoio exibido abaixo do rótulo. */
  hint?: string;
  /** Mensagem de erro exibida abaixo do campo. */
  error?: string;
  /** Conteúdo à direita do campo (ex.: botão mostrar/ocultar). */
  adornment?: ReactNode;
  id?: string;
};

/**
 * Campo com rótulo visível acima, texto de apoio opcional e erro abaixo,
 * ligados por aria-describedby. Nunca use placeholder no lugar do rótulo.
 */
export function TextField({
  label,
  hint,
  error,
  adornment,
  id: idProp,
  className,
  required,
  ...props
}: TextFieldProps) {
  const generated = useId();
  const id = idProp ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
        {required ? (
          <span className="ml-1 text-muted" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {hint ? (
        <p id={hintId} className="-mt-1 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      <div className="relative">
        <input
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={inputStyles(Boolean(error), cn(adornment && "pr-11", className))}
          {...props}
        />
        {adornment ? (
          <div className="absolute inset-y-0 right-0 flex items-center pr-1">
            {adornment}
          </div>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
