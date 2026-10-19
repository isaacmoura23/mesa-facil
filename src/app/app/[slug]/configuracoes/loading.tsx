import { Skeleton } from "@/components/ui/skeleton";

/** Esqueleto de Configurações: cabeçalho e as seções empilhadas. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Carregando as configurações</span>
      <Skeleton className="h-9 w-48" />
      <Skeleton className="mt-3 h-4 w-full max-w-md" />
      <div className="mt-6 flex max-w-3xl flex-col gap-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
