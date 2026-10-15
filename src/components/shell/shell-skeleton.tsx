import { Skeleton } from "@/components/ui/skeleton";

/** Esqueleto do shell autenticado, exibido enquanto os guards resolvem. */
export function ShellSkeleton() {
  return (
    <div
      className="min-h-dvh lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)]"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Carregando o painel</span>
      <aside className="hidden border-r border-line bg-surface p-4 lg:block">
        <Skeleton className="mb-8 h-8 w-36" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-col">
        <div className="flex h-16 items-center justify-between border-b border-line bg-surface px-4 sm:px-6">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="size-8 rounded-full" />
        </div>
        <PageSkeleton />
      </div>
    </div>
  );
}

/** Esqueleto de uma página interna (título + cartões). */
export function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="mt-3 h-4 w-full max-w-lg" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}
