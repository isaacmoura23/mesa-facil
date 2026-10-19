"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils/cn";
import type { AuditResult, TeamMember } from "@/modules/team/types";
import { ActivityPanel } from "./activity-panel";
import { MembersPanel } from "./members-panel";

type TabKey = "integrantes" | "atividades";

type TeamWorkspaceProps = {
  slug: string;
  restaurantName: string;
  members: TeamMember[];
  currentUserId: string;
  initialAudit: AuditResult;
};

export function TeamWorkspace({ slug, restaurantName, members, currentUserId, initialAudit }: TeamWorkspaceProps) {
  const [tab, setTab] = useState<TabKey>("integrantes");
  const refs = useRef<Record<TabKey, HTMLButtonElement | null>>({ integrantes: null, atividades: null });

  const activeCount = members.filter((member) => member.status === "active").length;
  const tabs: { key: TabKey; label: string; badge: number | null }[] = [
    { key: "integrantes", label: "Integrantes", badge: activeCount },
    { key: "atividades", label: "Histórico", badge: null },
  ];

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[next].key);
    refs.current[tabs[next].key]?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Seções da equipe"
        className="mb-6 grid grid-cols-2 gap-1 rounded-control bg-surface-2 p-1 sm:inline-grid sm:grid-cols-[repeat(2,minmax(8rem,auto))]"
      >
        {tabs.map((item, index) => {
          const selected = tab === item.key;
          return (
            <button
              key={item.key}
              ref={(node) => {
                refs.current[item.key] = node;
              }}
              role="tab"
              type="button"
              id={`team-tab-${item.key}`}
              aria-selected={selected}
              aria-controls={`team-panel-${item.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(item.key)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "flex min-h-10 items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-medium transition-colors",
                selected ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg",
              )}
            >
              {item.label}
              {item.badge !== null ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-xs tabular-nums",
                    selected ? "bg-accent-soft text-accent-soft-fg" : "bg-line text-muted",
                  )}
                >
                  {item.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`team-panel-${tab}`}
        aria-labelledby={`team-tab-${tab}`}
        tabIndex={0}
        className="outline-offset-4"
      >
        {tab === "integrantes" ? (
          <MembersPanel slug={slug} restaurantName={restaurantName} members={members} currentUserId={currentUserId} />
        ) : (
          <ActivityPanel slug={slug} initial={initialAudit} />
        )}
      </div>
    </div>
  );
}
