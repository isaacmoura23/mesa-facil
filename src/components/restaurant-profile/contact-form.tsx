"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { TextField } from "@/components/ui/input";
import { FormError } from "@/components/menu-admin/form-dialog";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { saveContactAction } from "@/modules/restaurant-profile/actions";
import {
  ADDRESS_MAX,
  NOTICE_MAX,
  maskPhoneInput,
  whatsappToInput,
} from "@/modules/restaurant-profile/format";
import { contactSchema, fieldErrorsOf } from "@/modules/restaurant-profile/schemas";
import type { ContactRow } from "@/modules/restaurant-profile/types";

type ContactFormProps = {
  slug: string;
  contact: ContactRow;
};

/** Seção "Contato e vitrine": WhatsApp, telefone, endereço e URL da vitrine personalizada. */
export function ContactForm({ slug, contact }: ContactFormProps) {
  const { run, pending } = useMenuAction();
  const [whatsapp, setWhatsapp] = useState(() => whatsappToInput(contact.whatsapp));
  const [phone, setPhone] = useState(() => maskPhoneInput(contact.phone ?? ""));
  const [address, setAddress] = useState(contact.address_text ?? "");
  const [storefrontUrl, setStorefrontUrl] = useState(contact.storefront_url ?? "");
  const [notice, setNotice] = useState(contact.storefront_notice ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData();
    formData.set("whatsapp", whatsapp);
    formData.set("phone", phone);
    formData.set("addressText", address);
    formData.set("storefrontUrl", storefrontUrl);
    formData.set("notice", notice);

    const parsed = contactSchema.safeParse({
      whatsapp,
      phone,
      addressText: address,
      storefrontUrl,
      notice,
    });
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError(null);
      return;
    }

    setErrors({});
    setFormError(null);
    const result = await run(() => saveContactAction(slug, formData), { inlineError: true });
    if (result.ok) {
      // Mostra o valor já normalizado (ex.: https:// acrescentado).
      if (parsed.data.storefrontUrl !== null) setStorefrontUrl(parsed.data.storefrontUrl);
      return;
    }
    setErrors(result.fieldErrors ?? {});
    setFormError(result.fieldErrors ? null : result.message);
  }

  return (
    <Card aria-labelledby="contact-title">
      <CardHeader
        title={<span id="contact-title">Contato e vitrine</span>}
        description="Aparecem no seu cardápio online, para o cliente falar com você."
      />
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="WhatsApp"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="(11) 91234-5678"
            hint="Com DDD. Salvamos só os números, com +55."
            value={whatsapp}
            onChange={(event) => setWhatsapp(maskPhoneInput(event.target.value))}
            error={errors.whatsapp}
          />
          <TextField
            label="Telefone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="(11) 3456-7890"
            hint="Fixo ou outro número de contato."
            value={phone}
            onChange={(event) => setPhone(maskPhoneInput(event.target.value))}
            error={errors.phone}
          />
        </div>
        <TextField
          label="Endereço"
          maxLength={ADDRESS_MAX}
          autoComplete="off"
          placeholder="Rua, número, bairro e cidade"
          hint={`${address.length} de ${ADDRESS_MAX} caracteres.`}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          error={errors.addressText}
        />
        <TextField
          label="Endereço da vitrine personalizada"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://minha-vitrine.vercel.app"
          hint="Opcional. Use se o seu site próprio é quem mostra o cardápio. Precisa começar com https://."
          value={storefrontUrl}
          onChange={(event) => setStorefrontUrl(event.target.value)}
          error={errors.storefrontUrl}
        />
        <TextField
          label="Aviso no topo do cardápio"
          maxLength={NOTICE_MAX}
          autoComplete="off"
          placeholder="Ex.: Encomendas de Natal até 20/12"
          hint={`Opcional. Aparece no topo dos cardápios ligados ao Mesa Fácil (ex.: o da Qi Buxo). Deixe em branco para não mostrar. ${notice.length} de ${NOTICE_MAX} caracteres.`}
          value={notice}
          onChange={(event) => setNotice(event.target.value)}
          error={errors.notice}
        />
        <FormError message={formError} />
        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            Salvar contato
          </Button>
        </div>
      </form>
    </Card>
  );
}
