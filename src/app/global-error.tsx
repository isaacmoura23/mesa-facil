"use client";

import { brand } from "@/config/brand";

/**
 * Último recurso: substitui o layout raiz quando ele próprio falha. Precisa
 * declarar <html> e <body>; usa estilos inline porque o CSS global pode não
 * ter sido carregado.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang={brand.locale}>
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "12px",
          padding: "24px",
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#f6f7f8",
          color: "#16181d",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Algo deu errado</h1>
        <p style={{ margin: 0, maxWidth: "28rem", color: "#4b5260" }}>
          Ocorreu um erro inesperado em {brand.name}. Tente novamente.
        </p>
        {error.digest ? (
          <p style={{ margin: 0, fontFamily: "monospace", fontSize: "0.75rem" }}>
            Código: {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => retry()}
          style={{
            height: "44px",
            padding: "0 20px",
            border: 0,
            borderRadius: "10px",
            background: "#0b6b4b",
            color: "#f4fbf8",
            fontSize: "0.875rem",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Tentar novamente
        </button>
      </body>
    </html>
  );
}
