"use client";

import { ErrorView } from "@/components/feedback/error-view";

export default function PlatformError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <ErrorView
      error={error}
      retry={retry}
      homeHref="/entrar"
      homeLabel="Voltar ao início"
    />
  );
}
