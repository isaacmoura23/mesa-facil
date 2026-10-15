import { Suspense } from "react";
import { PlatformShell } from "@/components/shell/platform-shell";
import { ShellSkeleton } from "@/components/shell/shell-skeleton";

export const metadata = { robots: { index: false, follow: false } };

export default function Layout({ children }: LayoutProps<"/platform">) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <PlatformShell>{children}</PlatformShell>
    </Suspense>
  );
}
