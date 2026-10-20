import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { SupportWorkspace } from "@/components/platform-admin/support-workspace";
import { fetchSessions, fetchTickets, getPlatformAccess } from "@/modules/platform-admin/queries";

export const metadata: Metadata = { title: "Suporte (plataforma)" };

export default async function Page({ searchParams }: PageProps<"/platform/support">) {
  await getPlatformAccess("/platform/support");
  const tab = (await searchParams).aba === "sessoes" ? "sessoes" : "tickets";
  const [tickets, sessions] = await Promise.all([fetchTickets("", null), fetchSessions(true, null)]);

  return (
    <>
      <PageHeader
        title="Suporte"
        description="Tickets dos restaurantes e sessões de atendimento somente leitura."
      />
      <SupportWorkspace
        initialTab={tab}
        tickets={{
          rows: tickets.ok ? tickets.rows : [],
          cursor: tickets.ok ? tickets.nextCursor : null,
          error: tickets.ok ? null : tickets.message,
        }}
        sessions={{
          rows: sessions.ok ? sessions.rows : [],
          cursor: sessions.ok ? sessions.nextCursor : null,
          error: sessions.ok ? null : sessions.message,
        }}
      />
    </>
  );
}
