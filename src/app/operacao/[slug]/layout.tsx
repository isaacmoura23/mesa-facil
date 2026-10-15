import { Suspense } from "react";
import { RestaurantAreaShell } from "@/components/shell/restaurant-area-shell";
import { ShellSkeleton } from "@/components/shell/shell-skeleton";

export const metadata = { robots: { index: false, follow: false } };

export default function Layout({ children, params }: LayoutProps<"/operacao/[slug]">) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <RestaurantAreaShell area="operacao" params={params}>
        {children}
      </RestaurantAreaShell>
    </Suspense>
  );
}
