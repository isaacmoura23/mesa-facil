import { Skeleton } from "@/components/ui/skeleton";

/** Esqueleto dos relatórios: cabeçalho, seletor, filtros, gráfico e tabela. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Carregando os relatórios</span>
      <Skeleton className="h-9 w-40" />
      <Skeleton className="mt-3 h-4 w-full max-w-md" />
      <Skeleton className="mt-6 h-10 w-full max-w-2xl" />
      <Skeleton className="mt-5 h-28 w-full" />
      <Skeleton className="mt-5 h-64 w-full" />
      <Skeleton className="mt-5 h-48 w-full" />
    </div>
  );
}
