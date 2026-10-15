import { Skeleton } from "@/components/ui/skeleton";

/** Esqueleto do cardápio (cabeçalho + hero + categorias + cartões). */
export function StorefrontSkeleton() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true">
      <span className="sr-only" role="status">
        Carregando cardápio
      </span>
      <div className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <Skeleton className="size-9" />
          <Skeleton className="h-5 w-40" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <ContentSkeleton />
      </div>
    </div>
  );
}

export function ContentSkeleton() {
  return (
    <div>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="mt-3 h-5 w-72 max-w-full" />
      <Skeleton className="mt-6 h-11 w-full" />
      <div className="mt-4 flex gap-2 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-24 shrink-0 rounded-full" />
        ))}
      </div>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 w-full rounded-card" />
        ))}
      </div>
    </div>
  );
}
