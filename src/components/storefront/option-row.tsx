import { cn } from "@/lib/utils/cn";

type OptionRowProps = {
  type: "radio" | "checkbox";
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Texto à direita (preço, "Indisponível"). */
  extra?: string;
  value?: string;
};

/** Linha selecionável (radio/checkbox) com área de toque de 44 px. */
export function OptionRow({ type, name, checked, disabled, onChange, label, extra, value }: OptionRowProps) {
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-control border px-3 py-2 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
        checked ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong",
        disabled && "cursor-not-allowed opacity-55",
      )}
    >
      <input
        type={type}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-5 shrink-0 accent-[var(--accent)]"
      />
      <span className="min-w-0 flex-1 text-sm font-medium text-fg">{label}</span>
      {extra ? <span className="shrink-0 text-sm tabular-nums text-muted">{extra}</span> : null}
    </label>
  );
}
