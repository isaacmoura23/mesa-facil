import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { getPublicEnvStatus } from "@/lib/env";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { PLATFORM_NAV } from "@/config/navigation";
import { SupabaseNotConfigured } from "@/components/supabase-not-configured";
import { ShellFrame } from "./shell-frame";
import { UserMenu } from "./user-menu";

/**
 * Layout de /platform. Única porta de entrada da área: chama
 * `requirePlatformAdmin()` (RPC is_platform_admin) antes de renderizar.
 * Deve ser renderizado dentro de <Suspense>.
 */
export async function PlatformShell({ children }: { children: ReactNode }) {
  if (!getPublicEnvStatus().ok) return <SupabaseNotConfigured />;

  const user = await requirePlatformAdmin();

  return (
    <ShellFrame
      areaLabel="Plataforma"
      nav={PLATFORM_NAV}
      headerStart={
        <div className="flex min-w-0 items-center gap-2 px-1">
          <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="truncate text-sm font-semibold text-fg">
            Administração da plataforma
          </span>
        </div>
      }
      headerEnd={
        <UserMenu name={user.name} email={user.email} caption="Administrador da plataforma" />
      }
    >
      {children}
    </ShellFrame>
  );
}
