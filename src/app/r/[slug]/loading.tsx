import { ContentSkeleton } from "@/components/storefront/storefront-skeleton";

export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Carregando
      </span>
      <ContentSkeleton />
    </div>
  );
}
