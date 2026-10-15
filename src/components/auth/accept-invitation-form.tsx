"use client";

import { useActionState } from "react";
import { acceptInvitationAction } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** Botão "Aceitar" de um convite pendente (chama a RPC accept_invitation). */
export function AcceptInvitationForm({
  membershipId,
  restaurantName,
}: {
  membershipId: string;
  restaurantName: string;
}) {
  const [state, formAction, pending] = useActionState(
    acceptInvitationAction,
    initialFormState,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="membershipId" value={membershipId} />
      <Button
        type="submit"
        size="sm"
        loading={pending}
        aria-label={`Aceitar convite de ${restaurantName}`}
      >
        {pending ? "Aceitando..." : "Aceitar"}
      </Button>
      {state.status === "error" && state.message ? (
        <Alert tone="danger" className="w-full text-left">
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}
