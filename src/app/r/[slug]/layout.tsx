import { Suspense, type ReactNode } from "react";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { StorefrontSkeleton } from "@/components/storefront/storefront-skeleton";

export default function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  return (
    <Suspense fallback={<StorefrontSkeleton />}>
      <StorefrontShell params={params}>{children}</StorefrontShell>
    </Suspense>
  );
}
