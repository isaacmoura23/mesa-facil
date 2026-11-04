"use client";

import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Button } from "@/components/ui/button";
import { confirmStorefrontDataAction } from "@/modules/restaurant-settings/confirm-action";

/** Botão "Confirmar que está tudo certo". Quem decide o que é confirmado é o servidor. */
export function ConfirmDataButton({ slug, disabled, label }: { slug: string; disabled?: boolean; label: string }) {
  const { run, pending } = useMenuAction();
  return (
    <Button loading={pending} disabled={disabled} onClick={() => void run(() => confirmStorefrontDataAction(slug))}>
      {label}
    </Button>
  );
}
