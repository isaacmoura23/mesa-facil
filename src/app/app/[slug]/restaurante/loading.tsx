import { Skeleton } from "@/components/ui/skeleton";

/** Esqueleto de Restaurante: cabeçalho e os cartões de contato, domínios e API. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Carregando os dados do restaurante</span>
      <Skeleton className="h-9 w-48" />
      <Skeleton className="mt-3 h-4 w-full max-w-md" />
      <div className="mt-6 flex max-w-3xl flex-col gap-6">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    </div>
  );
}
