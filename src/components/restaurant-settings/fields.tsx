"use client";

import { useId, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Button } from "@/components/ui/button";
import { inputStyles } from "@/components/ui/input";
import { cn } from "@/lib/utils/cn";

type FieldShellProps = {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
};

function FieldShell({ id, label, hint, error, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
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
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  label: string;
  hint?: string;
  error?: string;
};

export function SelectField({ label, hint, error, className, children, ...props }: SelectFieldProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={inputStyles(Boolean(error), cn("pr-8", className))}
        {...props}
      >
        {children}
      </select>
    </FieldShell>
  );
}

type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
  label: string;
  hint?: string;
  error?: string;
};

export function TextAreaField({ label, hint, error, className, ...props }: TextAreaFieldProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={inputStyles(Boolean(error), cn("h-auto min-h-24 py-2 leading-relaxed", className))}
        {...props}
      />
    </FieldShell>
  );
}

type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
};

/** Interruptor acessível (role="switch") com rótulo e descrição ligados por aria. */
export function Switch({ checked, onChange, label, description, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className="flex items-start gap-4">
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:opacity-55",
          checked ? "border-transparent bg-accent" : "border-line-strong bg-surface-2",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "block size-5 rounded-full shadow-sm transition-transform duration-150",
            checked ? "translate-x-6 bg-accent-fg" : "translate-x-1 bg-muted",
          )}
        />
      </button>
      <div className="min-w-0">
        <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {description ? (
          <div id={`${id}-desc`} className="mt-1 text-sm leading-relaxed text-muted">
            {description}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type CheckFieldProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
};

export function CheckField({ checked, onChange, label, hint, disabled }: CheckFieldProps) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-1 size-5 shrink-0 accent-[var(--accent)]"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-sm text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

type SaveBarProps = {
  dirty: boolean;
  pending: boolean;
  label: string;
  onDiscard?: () => void;
  disabled?: boolean;
};

/** Rodapé de cada formulário: estado "não salvo", descartar e salvar. */
export function SaveBar({ dirty, pending, label, onDiscard, disabled }: SaveBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
      <p role="status" className="mr-auto text-sm text-muted">
        {dirty ? "Há alterações não salvas." : "Tudo salvo."}
      </p>
      {dirty && onDiscard ? (
        <Button variant="ghost" onClick={onDiscard} disabled={pending}>
          Descartar
        </Button>
      ) : null}
      <Button type="submit" loading={pending} disabled={!dirty || disabled}>
        {label}
      </Button>
    </div>
  );
}
