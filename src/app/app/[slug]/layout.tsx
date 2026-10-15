import { Suspense } from "react";
import { RestaurantAreaShell } from "@/components/shell/restaurant-area-shell";
import { ShellSkeleton } from "@/components/shell/shell-skeleton";

export const metadata = { robots: { index: false, follow: false } };

export default function Layout({ children, params }: LayoutProps<"/app/[slug]">) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <RestaurantAreaShell area="app" params={params}>
        {children}
      </RestaurantAreaShell>
    </Suspense>
  );
}
