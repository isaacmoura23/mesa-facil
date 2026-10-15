import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils/cn";

type AuthShellProps = {
  children: ReactNode;
  /** Largura do conteúdo. */
  size?: "md" | "lg";
};

/** Coluna centralizada com a marca, usada por login, cadastro e seleção de restaurante. */
export function AuthShell({ children, size = "md" }: AuthShellProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <BrandMark className="mb-8" />
      <div className={cn("w-full", size === "md" ? "max-w-md" : "max-w-xl")}>{children}</div>
    </main>
  );
}

export function AuthSkeleton() {
  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center px-4 py-10"
      aria-busy="true"
    >
      <span className="sr-only" role="status">
        Carregando
      </span>
      <Skeleton className="mb-8 h-8 w-36" />
      <div className="w-full max-w-md rounded-card border border-line bg-surface p-6">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mt-6 h-11 w-full" />
        <Skeleton className="mt-4 h-11 w-full" />
        <Skeleton className="mt-6 h-12 w-full" />
      </div>
    </main>
  );
}
