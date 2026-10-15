import Link from "next/link";
import { SearchX } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { buttonStyles } from "@/components/ui/button";

type NotFoundViewProps = {
  title?: string;
  description?: string;
  homeHref?: string;
  homeLabel?: string;
};

export function NotFoundView({
  title = "Página não encontrada",
  description = "O endereço pode estar incorreto ou você não tem acesso a esta página.",
  homeHref = "/",
  homeLabel = "Voltar ao início",
}: NotFoundViewProps) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10 text-center">
      <BrandMark className="mb-8" />
      <span
        aria-hidden="true"
        className="mb-4 flex size-12 items-center justify-center rounded-control bg-surface-2 text-muted"
      >
        <SearchX className="size-6" />
      </span>
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">{description}</p>
      <Link href={homeHref} className={buttonStyles({ className: "mt-6" })}>
        {homeLabel}
      </Link>
    </div>
  );
}
