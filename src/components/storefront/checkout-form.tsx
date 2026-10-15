"use client";

import { useId, useMemo, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { Bike, ShoppingBag, Store, UtensilsCrossed, type LucideIcon } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { TextField, inputStyles } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import { reviewCheckoutAction } from "@/modules/storefront/actions";
import { toCheckoutItems } from "@/modules/storefront/cart";
import { useCart } from "@/modules/storefront/cart-context";
import {
  EMPTY_CHECKOUT_FORM,
  checkoutFormSchema,
  fieldErrorsFrom,
  type CheckoutFieldErrors,
  type CheckoutFormValues,
} from "@/modules/storefront/checkout-schema";
import { maskCep, maskPhone } from "@/modules/storefront/masks";
import {
  FULFILLMENT_LABELS,
  type Fulfillment,
  type PublicMenu,
} from "@/modules/storefront/schemas";
import { useCartQuote } from "@/modules/storefront/use-cart-quote";
import { CheckoutSummary } from "./checkout-summary";

const ICONS: Record<Fulfillment, LucideIcon> = {
  DELIVERY: Bike,
  PICKUP: Store,
  DINE_IN: UtensilsCrossed,
};

const HINTS: Record<Fulfillment, string> = {
  DELIVERY: "Receba no seu endereço",
  PICKUP: "Busque no restaurante",
  DINE_IN: "Coma no restaurante",
};

type CheckoutFormProps = {
  slug: string;
  settings: PublicMenu["settings"];
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
      <h2 className="mb-4 text-base font-semibold text-fg">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function CheckoutForm({ slug, settings }: CheckoutFormProps) {
  const uid = useId();
  const cart = useCart();
  const available = settings.fulfillmentTypes;
  const [values, setValues] = useState<CheckoutFormValues>({
    ...EMPTY_CHECKOUT_FORM,
    fulfillment: available.includes("PICKUP") ? "PICKUP" : (available[0] ?? "PICKUP"),
  });
  const [touched, setTouched] = useState<Partial<Record<keyof CheckoutFormValues, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<CheckoutFieldErrors>({});
  const [reviewMessage, setReviewMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [reviewing, startReview] = useTransition();
  const [nonce, setNonce] = useState(0);

  const { result, pending } = useCartQuote({
    slug,
    enabled: cart.ready && available.length > 0,
    lines: cart.lines,
    fulfillment: values.fulfillment,
    zoneId: values.zoneId,
    nonce,
  });

  const parsed = useMemo(() => checkoutFormSchema.safeParse(values), [values]);
  const clientErrors: CheckoutFieldErrors = parsed.success ? {} : fieldErrorsFrom(parsed.error);

  function set<K extends keyof CheckoutFormValues>(key: K, value: CheckoutFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setServerErrors((current) => ({ ...current, [key]: undefined }));
    setReviewMessage(null);
  }

  const touch = (key: keyof CheckoutFormValues) => () =>
    setTouched((current) => ({ ...current, [key]: true }));

  const errorFor = (key: keyof CheckoutFormValues): string | undefined =>
    serverErrors[key] ?? (attempted || touched[key] ? clientErrors[key] : undefined);

  const delivery = values.fulfillment === "DELIVERY";
  const zone = settings.deliveryZones.find((z) => z.id === values.zoneId);

  function review() {
    setAttempted(true);
    setReviewMessage(null);
    if (!parsed.success) {
      setReviewMessage({ tone: "danger", text: "Revise os campos destacados antes de continuar." });
      const firstKey = Object.keys(clientErrors)[0];
      if (firstKey) document.getElementById(`${uid}-${firstKey}`)?.focus();
      return;
    }
    startReview(async () => {
      const response = await reviewCheckoutAction({
        form: values,
        cart: {
          slug,
          fulfillment: values.fulfillment,
          zoneId: values.zoneId || null,
          items: toCheckoutItems(cart.lines),
        },
      });
      if (response.status === "invalid") {
        setServerErrors(response.fieldErrors);
        setReviewMessage({ tone: "danger", text: "Revise os campos destacados antes de continuar." });
      } else if (response.status === "error") {
        setReviewMessage({ tone: "danger", text: response.message });
      } else if (!response.quote.ok) {
        setReviewMessage({
          tone: "danger",
          text: "Há problemas com o pedido. Veja os avisos no resumo.",
        });
      } else {
        setReviewMessage({
          tone: "success",
          text: "Dados e valores conferidos. O envio do pedido ainda não está disponível.",
        });
      }
    });
  }

  if (!cart.ready) {
    return (
      <div aria-busy="true">
        <span className="sr-only" role="status">
          Carregando carrinho
        </span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-6 h-64 w-full" />
      </div>
    );
  }

  const menuHref = `/r/${encodeURIComponent(slug)}`;

  if (cart.lines.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag />}
        title="Seu carrinho está vazio"
        description="Escolha itens no cardápio para conferir o pedido."
        action={
          <Link href={menuHref} className={buttonStyles()}>
            Ver cardápio
          </Link>
        }
      />
    );
  }

  if (available.length === 0) {
    return (
      <Alert tone="warning" title="Pedidos indisponíveis">
        Este restaurante ainda não habilitou nenhuma forma de recebimento. Tente mais tarde.
      </Alert>
    );
  }

  const zoneError = errorFor("zoneId");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Finalizar pedido</h1>
      <p className="mt-1 text-sm text-muted">Confira como quer receber e seus dados.</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
          className="order-last space-y-6 lg:order-first"
        >
          <Section title="Como você quer receber?">
            <fieldset>
              <legend className="sr-only">Forma de recebimento</legend>
              <div className={cn("grid gap-3", available.length > 1 && "sm:grid-cols-2")}>
                {available.map((type) => {
                  const Icon = ICONS[type];
                  const checked = values.fulfillment === type;
                  return (
                    <label
                      key={type}
                      className={cn(
                        "flex min-h-14 cursor-pointer items-center gap-3 rounded-control border px-4 py-3 transition-colors",
                        checked ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong",
                      )}
                    >
                      <input
                        type="radio"
                        name={`${uid}-fulfillment`}
                        value={type}
                        checked={checked}
                        onChange={() => set("fulfillment", type)}
                        className="size-5 shrink-0 accent-[var(--accent)]"
                      />
                      <Icon aria-hidden="true" className="size-5 shrink-0 text-muted" />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-fg">
                          {FULFILLMENT_LABELS[type]}
                        </span>
                        <span className="block text-sm text-muted">{HINTS[type]}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {values.fulfillment === "PICKUP" && settings.pickupInstructions ? (
              <Alert tone="info" title="Instruções para retirada">
                {settings.pickupInstructions}
              </Alert>
            ) : null}
          </Section>

          <Section title="Seus dados">
            <TextField
              id={`${uid}-name`}
              label="Nome"
              required
              autoComplete="name"
              maxLength={120}
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              onBlur={touch("name")}
              error={errorFor("name")}
            />
            <TextField
              id={`${uid}-phone`}
              label="Telefone com DDD"
              required
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              placeholder="(11) 91234-5678"
              value={values.phone}
              onChange={(e) => set("phone", maskPhone(e.target.value))}
              onBlur={touch("phone")}
              error={errorFor("phone")}
            />
            <TextField
              id={`${uid}-email`}
              label="E-mail (opcional)"
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={254}
              value={values.email}
              onChange={(e) => set("email", e.target.value)}
              onBlur={touch("email")}
              error={errorFor("email")}
            />
          </Section>

          {delivery ? (
            <Section title="Endereço de entrega">
              {settings.deliveryZones.length === 0 ? (
                <Alert tone="warning">
                  Este restaurante não tem regiões de entrega disponíveis agora. Escolha retirada
                  ou tente mais tarde.
                </Alert>
              ) : (
                <div className="flex flex-col gap-2">
                  <label htmlFor={`${uid}-zoneId`} className="text-sm font-medium text-fg">
                    Região de entrega
                    <span className="ml-1 text-muted" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <select
                    id={`${uid}-zoneId`}
                    required
                    value={values.zoneId}
                    onChange={(e) => set("zoneId", e.target.value)}
                    onBlur={touch("zoneId")}
                    aria-invalid={zoneError ? true : undefined}
                    aria-describedby={zoneError ? `${uid}-zoneId-error` : `${uid}-zoneId-hint`}
                    className={inputStyles(Boolean(zoneError))}
                  >
                    <option value="">Selecione a região</option>
                    {settings.deliveryZones.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name} (taxa {formatCents(z.feeCents)})
                      </option>
                    ))}
                  </select>
                  <p id={`${uid}-zoneId-hint`} className="text-sm text-muted">
                    {zone
                      ? [
                          zone.estimatedMinutes ? `Entrega em cerca de ${zone.estimatedMinutes} min.` : null,
                          zone.minOrderCents > 0
                            ? `Pedido mínimo nesta região: ${formatCents(zone.minOrderCents)}.`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" ") || "A taxa exata aparece no resumo."
                      : "A taxa exata aparece no resumo."}
                  </p>
                  {zoneError ? (
                    <p id={`${uid}-zoneId-error`} className="text-sm font-medium text-danger">
                      {zoneError}
                    </p>
                  ) : null}
                </div>
              )}

              <TextField
                id={`${uid}-postalCode`}
                label="CEP"
                required
                inputMode="numeric"
                autoComplete="postal-code"
                placeholder="01310-100"
                value={values.postalCode}
                onChange={(e) => set("postalCode", maskCep(e.target.value))}
                onBlur={touch("postalCode")}
                error={errorFor("postalCode")}
              />
              <TextField
                id={`${uid}-street`}
                label="Rua"
                required
                autoComplete="address-line1"
                maxLength={160}
                value={values.street}
                onChange={(e) => set("street", e.target.value)}
                onBlur={touch("street")}
                error={errorFor("street")}
              />
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4">
                <TextField
                  id={`${uid}-number`}
                  label="Número"
                  required
                  maxLength={20}
                  value={values.number}
                  onChange={(e) => set("number", e.target.value)}
                  onBlur={touch("number")}
                  error={errorFor("number")}
                />
                <TextField
                  id={`${uid}-complement`}
                  label="Complemento"
                  autoComplete="address-line2"
                  maxLength={120}
                  value={values.complement}
                  onChange={(e) => set("complement", e.target.value)}
                  onBlur={touch("complement")}
                  error={errorFor("complement")}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id={`${uid}-neighborhood`}
                  label="Bairro"
                  required
                  maxLength={120}
                  value={values.neighborhood}
                  onChange={(e) => set("neighborhood", e.target.value)}
                  onBlur={touch("neighborhood")}
                  error={errorFor("neighborhood")}
                />
                <TextField
                  id={`${uid}-city`}
                  label="Cidade"
                  required
                  autoComplete="address-level2"
                  maxLength={120}
                  value={values.city}
                  onChange={(e) => set("city", e.target.value)}
                  onBlur={touch("city")}
                  error={errorFor("city")}
                />
              </div>
              <TextField
                id={`${uid}-instructions`}
                label="Instruções para o entregador (opcional)"
                maxLength={300}
                value={values.instructions}
                onChange={(e) => set("instructions", e.target.value)}
                onBlur={touch("instructions")}
                error={errorFor("instructions")}
              />
            </Section>
          ) : null}

          <Section title="Observações do pedido">
            <div className="flex flex-col gap-2">
              <label htmlFor={`${uid}-notes`} className="text-sm font-medium text-fg">
                Algo mais que o restaurante deva saber? (opcional)
              </label>
              <textarea
                id={`${uid}-notes`}
                rows={3}
                maxLength={500}
                value={values.notes}
                onChange={(e) => set("notes", e.target.value)}
                aria-invalid={errorFor("notes") ? true : undefined}
                className="block w-full resize-y rounded-control border border-line bg-surface px-3 py-2.5 text-base text-fg hover:border-line-strong sm:text-sm"
              />
              {errorFor("notes") ? (
                <p className="text-sm font-medium text-danger">{errorFor("notes")}</p>
              ) : null}
            </div>
          </Section>

          <section aria-labelledby={`${uid}-final`} className="space-y-3">
            <h2 id={`${uid}-final`} className="sr-only">
              Enviar pedido
            </h2>
            <Alert tone="info" title="Envio de pedidos online disponível na próxima etapa">
              Você já pode conferir itens, taxa e total. O botão de envio será liberado quando o
              recebimento de pedidos entrar no ar.
            </Alert>
            <div aria-live="polite">
              {reviewMessage ? (
                <Alert tone={reviewMessage.tone}>{reviewMessage.text}</Alert>
              ) : null}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" variant="secondary" size="lg" loading={reviewing}>
                Conferir dados
              </Button>
              <Button type="button" size="lg" disabled aria-disabled="true">
                Enviar pedido (indisponível)
              </Button>
            </div>
          </section>
        </form>

        <div className="order-first lg:order-last">
          <CheckoutSummary
            lines={cart.lines}
            result={result}
            pending={pending}
            fulfillment={values.fulfillment}
            zoneChosen={Boolean(values.zoneId)}
            onRetry={() => setNonce((n) => n + 1)}
          />
        </div>
      </div>
    </div>
  );
}
