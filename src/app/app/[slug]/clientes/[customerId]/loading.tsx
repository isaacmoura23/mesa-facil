import { Skeleton } from "@/components/ui/skeleton";

/** Esqueleto da lista de clientes: cabeçalho, aviso, busca e linhas. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Carregando o cliente</span>
      <Skeleton className="h-9 w-40" />
      <Skeleton className="mt-3 h-4 w-full max-w-md" />
      <Skeleton className="mt-6 h-16 w-full" />
      <Skeleton className="mt-5 h-24 w-full" />
      <div className="mt-5 flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
