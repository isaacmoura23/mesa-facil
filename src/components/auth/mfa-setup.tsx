"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";

export type MfaFactorView = { id: string; friendlyName: string | null; createdAt: string };

type Props = {
  verified: MfaFactorView[];
  /** Cadastros abandonados, removidos antes de iniciar um novo. */
  unverifiedIds: string[];
  /** A sessão já está em aal2 (necessário para remover um fator). */
  aal2: boolean;
  /** Caminho interno para onde ir depois de ativar (fluxo obrigatório do superadmin). */
  next: string | null;
};

type Enrollment = { factorId: string; qrCode: string; secret: string };

function friendlyError(error: { code?: string; message?: string }): string {
  if (error.code === "mfa_totp_enroll_not_enabled" || error.code === "mfa_totp_verify_not_enabled") {
    return "A verificação em duas etapas ainda não está habilitada neste ambiente. Peça ao administrador para ativar o MFA (TOTP) no Supabase Auth.";
  }
  if (error.code === "mfa_verification_failed" || error.code === "mfa_challenge_expired") {
    return "Código incorreto ou expirado. Confira o aplicativo e tente de novo.";
  }
  if (error.code === "insufficient_aal") {
    return "Confirme um código do seu aplicativo antes de remover o fator.";
  }
  return "Não foi possível concluir agora. Tente novamente em instantes.";
}

/** Cadastro e remoção do autenticador TOTP (Google Authenticator, Authy, 1Password...). */
export function MfaSetup({ verified, unverifiedIds, aal2, next }: Props) {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function startEnrollment() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    // Cadastros anteriores nunca confirmados atrapalham (nome repetido): limpa antes.
    for (const id of unverifiedIds) await supabase.auth.mfa.unenroll({ factorId: id });
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Autenticador ${new Date().toLocaleDateString("pt-BR")} ${Date.now().toString(36)}`,
    });
    setBusy(false);
    if (enrollError || !data) {
      setError(friendlyError(enrollError ?? {}));
      return;
    }
    setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollment) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Digite os 6 números mostrados no aplicativo.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const challenge = await supabase.auth.mfa.challenge({ factorId: enrollment.factorId });
    if (challenge.error || !challenge.data) {
      setBusy(false);
      setError(friendlyError(challenge.error ?? {}));
      return;
    }
    const result = await supabase.auth.mfa.verify({
      factorId: enrollment.factorId,
      challengeId: challenge.data.id,
      code: code.trim(),
    });
    setBusy(false);
    if (result.error) {
      setError(friendlyError(result.error));
      setCode("");
      return;
    }
    setEnrollment(null);
    setCode("");
    setDone(true);
    if (next) router.replace(next);
    else router.refresh();
  }

  async function remove(factorId: string) {
    setBusy(true);
    setError(null);
    const { error: removeError } = await createClient().auth.mfa.unenroll({ factorId });
    setBusy(false);
    if (removeError) {
      setError(friendlyError(removeError));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      {done ? (
        <Alert tone="success" title="Verificação em duas etapas ativada">
          Daqui para frente, o login pede o código do aplicativo.
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {verified.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {verified.map((factor) => (
            <li
              key={factor.id}
              className="flex items-center justify-between gap-3 rounded-control border border-line bg-surface-2 px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <ShieldCheck aria-hidden="true" className="size-5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">Aplicativo autenticador</p>
                  <p className="text-xs text-muted">
                    Cadastrado em {new Date(factor.createdAt).toLocaleDateString("pt-BR")}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="accent">Ativo</Badge>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || !aal2}
                  title={aal2 ? undefined : "Confirme um código do aplicativo nesta sessão para poder remover."}
                  onClick={() => void remove(factor.id)}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                  Remover
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {enrollment ? (
        <form onSubmit={confirm} noValidate className="flex flex-col gap-5">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-fg">
            <li>Abra um aplicativo autenticador (Google Authenticator, Authy, 1Password...).</li>
            <li>Escaneie o QR code abaixo ou digite a chave manualmente.</li>
            <li>Digite o código de 6 números que o aplicativo mostrar.</li>
          </ol>
          <div className="flex flex-col items-center gap-3 rounded-control border border-line bg-white p-4">
            {/* QR gerado pelo Supabase como data URI (SVG); next/image não otimiza data URI. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrollment.qrCode} alt="QR code para o aplicativo autenticador" className="size-44" />
          </div>
          <p className="text-sm text-muted">
            Chave manual: <code className="rounded bg-surface-2 px-1.5 py-0.5 text-fg select-all">{enrollment.secret}</code>
          </p>
          <TextField
            label="Código de 6 números"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            required
          />
          <div className="flex gap-3">
            <Button type="submit" size="lg" loading={busy}>
              Confirmar e ativar
            </Button>
            <Button type="button" variant="secondary" size="lg" disabled={busy} onClick={() => setEnrollment(null)}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : verified.length === 0 ? (
        <Button type="button" size="lg" loading={busy} onClick={() => void startEnrollment()}>
          Ativar verificação em duas etapas
        </Button>
      ) : null}
    </div>
  );
}
