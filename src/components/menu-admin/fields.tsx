"use client";

import {
  useId,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { inputStyles } from "@/components/ui/input";
import { cn } from "@/lib/utils/cn";

type FieldFrameProps = {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
};

function FieldFrame({ id, label, hint, error, required, children }: FieldFrameProps) {
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
        <p id={`${id}-hint`} className="-mt-1 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
  label: string;
  hint?: string;
  error?: string;
};

export function TextAreaField({ label, hint, error, required, className, ...props }: TextAreaFieldProps) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} required={required}>
      <textarea
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        rows={3}
        className={cn(
          "block min-h-24 w-full rounded-control border bg-surface px-3 py-2.5 text-base text-fg placeholder:text-muted/80 transition-colors sm:text-sm",
          "hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-60",
          error ? "border-danger" : "border-line",
          className,
        )}
        {...props}
      />
    </FieldFrame>
  );
}

type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
};

export function SelectField({ label, hint, error, required, className, children, ...props }: SelectFieldProps) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} required={required}>
      <select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={inputStyles(Boolean(error), className)}
        {...props}
      >
        {children}
      </select>
    </FieldFrame>
  );
}

type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Descrição curta lida junto com o rótulo. */
  description?: string;
  disabled?: boolean;
  className?: string;
};

/** Interruptor acessível (role="switch") com alvo de toque de 44 px. */
export function Switch({ checked, onChange, label, description, disabled, className }: SwitchProps) {
  const descriptionId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={description ? descriptionId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex min-h-11 items-center gap-2.5 rounded-control px-1 text-left text-sm text-fg disabled:opacity-55",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors",
          checked ? "border-transparent bg-accent" : "border-line-strong bg-surface-2",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 size-[1.125rem] rounded-full shadow-card transition-transform duration-150 motion-reduce:transition-none",
            checked ? "translate-x-4 bg-accent-fg" : "translate-x-0 bg-muted",
          )}
        />
      </span>
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        {description ? (
          <span id={descriptionId} className="text-xs text-muted">
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}

type CheckRowProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
};

/** Linha de checklist com caixa de seleção nativa (alvo de toque amplo). */
export function CheckRow({ checked, onChange, label, hint }: CheckRowProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 cursor-pointer items-start gap-3 rounded-control px-2 py-2 hover:bg-surface-2"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-(--accent)"
      />
      <span className="min-w-0 text-sm">
        <span className="block font-medium text-fg">{label}</span>
        {hint ? <span className="block text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}
