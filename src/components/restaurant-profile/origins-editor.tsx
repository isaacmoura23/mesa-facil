"use client";

import { useState, type FormEvent } from "react";
import { Globe, Plus, Trash2 } from "lucide-react";
import { IconButton } from "@/components/menu-admin/icon-button";
import { useConfirm } from "@/components/menu-admin/use-confirm";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { FormError } from "@/components/menu-admin/form-dialog";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { TextField } from "@/components/ui/input";
import { saveOriginsAction } from "@/modules/restaurant-profile/actions";
import { MAX_STOREFRONT_ORIGINS, normalizeOrigin } from "@/modules/restaurant-profile/format";

type OriginsEditorProps = {
  slug: string;
  origins: string[];
};

/**
 * "Domínios autorizados da vitrine": os sites (origens https exatas) que podem
 * chamar a API pública do navegador. As alterações só valem ao salvar.
 */
export function OriginsEditor({ slug, origins }: OriginsEditorProps) {
  const { run, pending } = useMenuAction();
  const { confirm, dialog } = useConfirm();
  const [saved, setSaved] = useState(origins);
  const [draft, setDraft] = useState(origins);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);

  const dirty = draft.length !== saved.length || draft.some((origin, index) => origin !== saved[index]);
  const full = draft.length >= MAX_STOREFRONT_ORIGINS;

  function addOrigin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeOrigin(input);
    if (!normalized.ok) {
      setInputError(normalized.message);
      return;
    }
    if (draft.includes(normalized.value)) {
      setInputError(`${normalized.value} já está na lista.`);
      return;
    }
    if (full) {
      setInputError(`Use no máximo ${MAX_STOREFRONT_ORIGINS} domínios.`);
      return;
    }
    setDraft([...draft, normalized.value]);
    setInput("");
    setInputError(undefined);
    setFormError(null);
  }

  function removeOrigin(origin: string) {
    confirm({
      title: "Remover este domínio?",
      description: (
        <>
          O site <strong className="break-all">{origin}</strong> deixa de poder consultar o seu cardápio pelo
          navegador depois que você salvar.
        </>
      ),
      confirmLabel: "Remover domínio",
      tone: "danger",
      onConfirm: async () => setDraft((current) => current.filter((item) => item !== origin)),
    });
  }

  async function save() {
    setFormError(null);
    const result = await run(() => saveOriginsAction(slug, draft), { inlineError: true });
    if (result.ok) {
      setSaved(draft);
      return;
    }
    setFormError(result.message);
  }

  return (
    <Card aria-labelledby="origins-title">
      <CardHeader
        title={<span id="origins-title">Domínios autorizados da vitrine</span>}
        description="O endereço do site que consome a API do seu cardápio."
      />
      <div className="flex flex-col gap-4">
        <Alert tone="info">
          Se você tem um site próprio (por exemplo, <span className="break-all">https://la-pastelaria.vercel.app</span>)
          que mostra o cardápio, cadastre aqui o endereço exato dele. Sem isso o navegador bloqueia as consultas
          desse site. Use só https, sem curinga (*), sem barra no final e sem caminho; no máximo{" "}
          {MAX_STOREFRONT_ORIGINS} domínios. Em desenvolvimento, <strong>localhost</strong> é liberado
          automaticamente. O seu cardápio padrão (/r/{slug}) não precisa de cadastro.
        </Alert>

        {draft.length === 0 ? (
          <div className="flex items-center gap-3 rounded-control border border-dashed border-line-strong px-4 py-5 text-sm text-muted">
            <Globe aria-hidden="true" className="size-5 shrink-0" />
            Nenhum domínio cadastrado. Só o cardápio padrão e o servidor do seu site (que não passa por esse
            bloqueio) conseguem ler o cardápio.
          </div>
        ) : (
          <ul aria-label="Domínios autorizados" className="flex flex-col divide-y divide-line rounded-control border border-line">
            {draft.map((origin) => (
              <li key={origin} className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
                <Globe aria-hidden="true" className="size-4 shrink-0 text-muted" />
                <code className="min-w-0 flex-1 text-sm break-all text-fg">{origin}</code>
                <IconButton
                  label={`Remover ${origin}`}
                  tone="danger"
                  disabled={pending}
                  onClick={() => removeOrigin(origin)}
                >
                  <Trash2 aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={addOrigin} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <TextField
              label="Adicionar domínio"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://minha-vitrine.vercel.app"
              value={input}
              disabled={full || pending}
              onChange={(event) => {
                setInput(event.target.value);
                setInputError(undefined);
              }}
              error={inputError}
              hint={full ? `Limite de ${MAX_STOREFRONT_ORIGINS} domínios atingido.` : undefined}
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            disabled={full || pending || input.trim() === ""}
            className="sm:mt-[1.875rem]"
          >
            <Plus aria-hidden="true" className="size-4" />
            Adicionar
          </Button>
        </form>

        <FormError message={formError} />
        <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
          {dirty ? (
            <p className="text-sm text-muted" role="status">
              Alterações ainda não salvas.
            </p>
          ) : null}
          <Button onClick={() => void save()} loading={pending} disabled={!dirty}>
            Salvar domínios
          </Button>
        </div>
      </div>
      {dialog}
    </Card>
  );
}
