"use client";

import { useCallback, useId, useRef, useState, useTransition } from "react";
import { LogOut } from "lucide-react";
import { logoutAction } from "@/lib/auth/actions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils/cn";
import { useDismiss } from "./use-dismiss";

type UserMenuProps = {
  name: string | null;
  email: string | null;
  /** Texto auxiliar (ex.: papel no restaurante). */
  caption?: string;
};

function initialOf(name: string | null, email: string | null): string {
  const source = (name ?? email ?? "?").trim();
  return source.charAt(0).toUpperCase() || "?";
}

export function UserMenu({ name, email, caption }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(rootRef, open, close);

  const display = name ?? email ?? "Minha conta";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="true"
        aria-label={`Conta de ${display}`}
        className="flex h-10 items-center gap-2 rounded-control pr-1 pl-1 transition-colors hover:bg-surface-2 sm:pr-3"
      >
        <span
          aria-hidden="true"
          className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-soft-fg"
        >
          {initialOf(name, email)}
        </span>
        <span className="hidden max-w-40 truncate text-sm font-medium text-fg sm:block">
          {display}
        </span>
      </button>

      <div
        id={menuId}
        hidden={!open}
        className={cn(
          "absolute right-0 z-40 mt-2 w-64 rounded-card border border-line bg-surface p-2 shadow-pop",
          !open && "hidden",
        )}
      >
        <div className="px-3 py-2">
          <p className="truncate text-sm font-medium text-fg">{display}</p>
          {email && email !== display ? (
            <p className="truncate text-xs text-muted">{email}</p>
          ) : null}
          {caption ? <p className="mt-1 text-xs text-muted">{caption}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setConfirming(true);
          }}
          className="flex h-10 w-full items-center gap-2 rounded-control px-3 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
        >
          <LogOut aria-hidden="true" className="size-4" />
          Encerrar sessão
        </button>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Encerrar sessão?"
        description="Você precisará entrar de novo para acessar o painel."
        confirmLabel="Encerrar sessão"
        pending={pending}
        onClose={() => setConfirming(false)}
        onConfirm={() => startTransition(() => logoutAction())}
      />
    </div>
  );
}
