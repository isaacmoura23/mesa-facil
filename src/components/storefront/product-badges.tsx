import { Badge, type BadgeTone } from "@/components/ui/badge";
import { MENU_BADGE_LABELS, type MenuBadge } from "@/modules/storefront/schemas";

const TONES: Record<MenuBadge, BadgeTone> = {
  NEW: "accent",
  POPULAR: "warning",
  REGIONAL: "info",
  SWEET: "neutral",
  SPICY: "danger",
  VEGETARIAN: "accent",
};

/** Selos do produto como chips (texto sempre visível; cor só reforça). */
export function ProductBadges({ badges, className }: { badges: MenuBadge[]; className?: string }) {
  if (badges.length === 0) return null;
  return (
    <ul aria-label="Características do item" className={className ?? "flex flex-wrap gap-1.5"}>
      {badges.map((badge) => (
        <li key={badge}>
          <Badge tone={TONES[badge]}>{MENU_BADGE_LABELS[badge]}</Badge>
        </li>
      ))}
    </ul>
  );
}
