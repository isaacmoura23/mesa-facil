import { Skeleton } from "@/components/ui/skeleton";

/** Esqueleto da lista de pedidos: filtros, contadores e linhas. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Carregando os pedidos
      </span>
      <Skeleton className="h-9 w-40" />
      <Skeleton className="mt-3 h-4 w-full max-w-lg" />
      <Skeleton className="mt-6 h-16 w-full" />
      <Skeleton className="mt-6 h-28 w-full" />
      <div className="mt-5 flex flex-wrap gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-24" />
        ))}
      </div>
      <div className="mt-5 flex flex-col gap-px overflow-hidden rounded-card">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-16 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}
