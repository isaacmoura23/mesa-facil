import { ExternalLink, MapPin, MessageCircle, Phone } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { PublicMenu } from "@/modules/storefront/schemas";

type Restaurant = PublicMenu["restaurant"];

const linkClass =
  "inline-flex min-h-11 items-center gap-2 rounded-control px-2 text-sm font-medium text-fg hover:bg-surface-2 hover:text-accent";

export function whatsappHref(digits: string): string {
  return `https://wa.me/${digits}`;
}

/** Botão compacto de WhatsApp para o cabeçalho (some se não houver número). */
export function HeaderWhatsApp({ restaurant }: { restaurant: Restaurant }) {
  const digits = restaurant.contact?.whatsappDigits;
  if (!digits) return null;
  return (
    <a
      href={whatsappHref(digits)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Falar com ${restaurant.name} no WhatsApp (abre em nova aba)`}
      className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-control px-3 text-sm font-medium text-fg hover:bg-surface-2 hover:text-accent"
    >
      <MessageCircle aria-hidden="true" className="size-5" />
      <span className="hidden sm:inline">WhatsApp</span>
    </a>
  );
}

/**
 * Contato no rodapé: WhatsApp, telefone, endereço e link para a vitrine
 * personalizada. Cada item só aparece se o dado existir (sem dados inventados).
 */
export function FooterContact({ restaurant, className }: { restaurant: Restaurant; className?: string }) {
  const { contact, storefrontUrl } = restaurant;
  const hasAny = Boolean(contact?.whatsappDigits || contact?.phoneHref || contact?.address || storefrontUrl);
  if (!hasAny) return null;

  return (
    <section aria-labelledby="contato-titulo" className={cn("mx-auto w-full max-w-5xl px-4", className)}>
      <h2 id="contato-titulo" className="text-sm font-semibold text-fg">
        Contato de {restaurant.name}
      </h2>
      <ul className="mt-2 flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-2">
        {contact?.whatsappDigits ? (
          <li>
            <a
              href={whatsappHref(contact.whatsappDigits)}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              <MessageCircle aria-hidden="true" className="size-4 shrink-0" />
              WhatsApp
              <span className="sr-only"> (abre em nova aba)</span>
            </a>
          </li>
        ) : null}
        {contact?.phoneHref && contact.phone ? (
          <li>
            <a href={`tel:${contact.phoneHref}`} className={linkClass}>
              <Phone aria-hidden="true" className="size-4 shrink-0" />
              <span className="sr-only">Ligar para </span>
              {contact.phone}
            </a>
          </li>
        ) : null}
        {storefrontUrl ? (
          <li>
            <a href={storefrontUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
              Site do restaurante
              <span className="sr-only"> (abre em nova aba)</span>
            </a>
          </li>
        ) : null}
      </ul>
      {contact?.address ? (
        <p className="mt-1 flex items-start gap-2 px-2 text-sm text-muted">
          <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">
            <span className="sr-only">Endereço: </span>
            {contact.address}
          </span>
        </p>
      ) : null}
    </section>
  );
}
