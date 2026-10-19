import { Skeleton } from "@/components/ui/skeleton";

/** Esqueleto da visão geral: filtro, cartões e gráfico, na forma do conteúdo final. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Carregando os indicadores
      </span>
      <Skeleton className="h-9 w-56" />
      <Skeleton className="mt-3 h-4 w-full max-w-lg" />
      <Skeleton className="mt-6 h-24 w-full" />
      <div className="mt-6 flex flex-col gap-6">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-52 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-80 w-full" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </div>
    </div>
  );
}
