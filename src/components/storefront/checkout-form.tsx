"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bike, CircleCheck, ShoppingBag, Store, UtensilsCrossed, type LucideIcon } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { TextField, inputStyles } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import type { OrderErrorItem, PaymentMethod } from "@/modules/orders-server/schemas";
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
import { createOrderAction } from "@/modules/storefront/order-actions";
import {
  EMPTY_PAYMENT_FORM,
  changeForCents,
  clearCheckoutKey,
  fingerprint,
  getCheckoutKey,
  paymentFormSchema,
  rememberOrder,
  type PaymentFieldErrors,
} from "@/modules/storefront/order-checkout";
import {
  FULFILLMENT_LABELS,
  type Fulfillment,
  type PublicMenu,
} from "@/modules/storefront/schemas";
import { useCartQuote } from "@/modules/storefront/use-cart-quote";
import { CheckoutSummary } from "./checkout-summary";
import { PaymentSection } from "./payment-section";

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

/** Campo do RPC (ex.: "customer.phone") -> campo do formulário. */
const SERVER_FIELD_MAP: Record<string, keyof CheckoutFormValues> = {
  "customer.name": "name",
  "customer.phone": "phone",
  "customer.email": "email",
  "address.street": "street",
  "address.number": "number",
  "address.neighborhood": "neighborhood",
  "address.city": "city",
  "address.postal_code": "postalCode",
  "address.complement": "complement",
  "address.instructions": "instructions",
  notes: "notes",
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
  const router = useRouter();
  const [payment, setPayment] = useState<{ method: PaymentMethod | ""; changeFor: string }>(EMPTY_PAYMENT_FORM);
  const [paymentErrors, setPaymentErrors] = useState<PaymentFieldErrors>({});
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [orderErrors, setOrderErrors] = useState<OrderErrorItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  // Trava síncrona: dois cliques no mesmo tick nunca disparam dois envios.
  const inFlight = useRef(false);
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
    setSubmitMessage(null);
  }

  function setPaymentField(next: Partial<typeof payment>) {
    setPayment((current) => ({ ...current, ...next }));
    setPaymentErrors({});
    setSubmitMessage(null);
  }

  const touch = (key: keyof CheckoutFormValues) => () =>
    setTouched((current) => ({ ...current, [key]: true }));

  const errorFor = (key: keyof CheckoutFormValues): string | undefined =>
    serverErrors[key] ?? (attempted || touched[key] ? clientErrors[key] : undefined);

  const delivery = values.fulfillment === "DELIVERY";
  const zone = settings.deliveryZones.find((z) => z.id === values.zoneId);

  const quoteTotal = result?.status === "ok" && result.quote.ok ? result.quote.totalCents : null;

  async function submit() {
    if (inFlight.current) return;
    setAttempted(true);
    setSubmitMessage(null);
    setOrderErrors([]);

    const paymentParsed = paymentFormSchema.safeParse(payment);
    const nextPaymentErrors: PaymentFieldErrors = {};
    if (!paymentParsed.success) {
      for (const issue of paymentParsed.error.issues) {
        const key = issue.path[0];
        if ((key === "method" || key === "changeFor") && !(key in nextPaymentErrors)) {
          nextPaymentErrors[key] = issue.message;
        }
      }
    } else {
      const change = changeForCents(payment);
      if (change !== null && quoteTotal !== null && change < quoteTotal) {
        nextPaymentErrors.changeFor = `O valor para troco precisa ser maior ou igual ao total (${formatCents(quoteTotal)}).`;
      }
    }
    setPaymentErrors(nextPaymentErrors);

    if (!parsed.success || Object.keys(nextPaymentErrors).length > 0) {
      setSubmitMessage("Revise os campos destacados antes de enviar.");
      const firstKey = Object.keys(clientErrors)[0];
      if (firstKey) document.getElementById(`${uid}-${firstKey}`)?.focus();
      else if (nextPaymentErrors.method) document.getElementById(`${uid}-payment-CASH`)?.focus();
      else if (nextPaymentErrors.changeFor) document.getElementById(`${uid}-changeFor`)?.focus();
      return;
    }

    const items = toCheckoutItems(cart.lines);
    const form = { ...values, zoneId: values.zoneId };
    // A chave vale para ESTE conteúdo: reenviar o mesmo pedido nunca duplica.
    const idempotencyKey = getCheckoutKey(slug, fingerprint({ form, payment, items }));

    inFlight.current = true;
    setSubmitting(true);
    try {
      const response = await createOrderAction({ slug, form, payment, items, idempotencyKey });
      switch (response.status) {
        case "created": {
          setRedirecting(true);
          clearCheckoutKey(slug);
          rememberOrder({
            slug,
            publicCode: response.publicCode,
            orderNumber: response.orderNumber,
            at: new Date().toISOString(),
          });
          router.push(`/r/${encodeURIComponent(slug)}/pedido/${encodeURIComponent(response.publicCode)}`);
          // Esvazia o carrinho só depois de pedir a navegação (sem piscar "carrinho vazio").
          cart.clear();
          return;
        }
        case "invalid": {
          setServerErrors(response.fieldErrors);
          setPaymentErrors(response.paymentErrors);
          setSubmitMessage("Revise os campos destacados antes de enviar.");
          break;
        }
        case "rejected": {
          const fieldErrors: CheckoutFieldErrors = {};
          const general: OrderErrorItem[] = [];
          for (const error of response.errors) {
            const key = error.field ? SERVER_FIELD_MAP[error.field] : undefined;
            if (key && !(key in fieldErrors)) fieldErrors[key] = error.message;
            else general.push(error);
          }
          setServerErrors(fieldErrors);
          setOrderErrors(general);
          setNonce((n) => n + 1); // reconfere o resumo com os avisos atualizados
          setSubmitMessage(
            general.length > 0 || Object.keys(fieldErrors).length > 0
              ? "Não foi possível enviar o pedido. Veja os avisos abaixo."
              : "Não foi possível enviar o pedido.",
          );
          break;
        }
        default:
          setSubmitMessage(response.message);
      }
    } catch {
      setSubmitMessage("Não foi possível enviar o pedido agora. Verifique sua conexão e tente novamente.");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
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

  if (redirecting) {
    return (
      <div role="status" className="flex flex-col items-center gap-3 py-16 text-center">
        <CircleCheck aria-hidden="true" className="size-10 text-accent" />
        <p className="text-lg font-semibold text-fg">Pedido enviado</p>
        <p className="text-sm text-muted">Abrindo o acompanhamento do seu pedido...</p>
      </div>
    );
  }

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
            void submit();
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

          <PaymentSection
            id={uid}
            fulfillment={values.fulfillment}
            method={payment.method}
            changeFor={payment.changeFor}
            errors={paymentErrors}
            onMethod={(method) =>
              setPaymentField({ method, changeFor: method === "CASH" ? payment.changeFor : "" })
            }
            onChangeFor={(changeFor) => setPaymentField({ changeFor })}
          />

          <section aria-labelledby={`${uid}-final`} className="space-y-3">
            <h2 id={`${uid}-final`} className="sr-only">
              Enviar pedido
            </h2>
            <div aria-live="polite">
              {submitMessage ? <Alert tone="danger">{submitMessage}</Alert> : null}
              {orderErrors.length > 0 ? (
                <ul className="mt-2 space-y-1 rounded-control bg-danger-soft px-4 py-3 text-sm text-danger-soft-fg">
                  {orderErrors.map((error, index) => (
                    <li key={`${error.code}-${error.itemIndex ?? "x"}-${index}`}>
                      {error.itemIndex !== null && cart.lines[error.itemIndex] ? (
                        <strong>{cart.lines[error.itemIndex].snapshot.name}: </strong>
                      ) : null}
                      {error.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <Button type="submit" size="lg" fullWidth loading={submitting} disabled={submitting}>
              {quoteTotal !== null ? `Enviar pedido (${formatCents(quoteTotal)})` : "Enviar pedido"}
            </Button>
            <p className="text-center text-sm text-muted">
              Ao enviar, o restaurante recebe o pedido na hora. Não há cobrança online.
            </p>
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
