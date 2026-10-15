import { Skeleton } from "@/components/ui/skeleton";

/** Esqueleto do cardápio: cabeçalho, abas e linhas de produto. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Carregando o cardápio</span>
      <Skeleton className="h-9 w-40" />
      <Skeleton className="mt-3 h-4 w-full max-w-md" />
      <Skeleton className="mt-6 h-16 w-full" />
      <Skeleton className="mt-6 h-10 w-full max-w-sm" />
      <div className="mt-6 flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
    </div>
  );
}
