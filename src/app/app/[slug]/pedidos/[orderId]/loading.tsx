import { Skeleton } from "@/components/ui/skeleton";

/** Esqueleto do detalhe do pedido. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Carregando o pedido
      </span>
      <Skeleton className="h-9 w-56" />
      <Skeleton className="mt-6 h-12 w-full" />
      <Skeleton className="mt-6 h-36 w-full" />
      <Skeleton className="mt-6 h-64 w-full" />
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}
