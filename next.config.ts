import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  images: {
    // Imagens do cardápio vêm do bucket público do Supabase Storage.
    remotePatterns: [
      { protocol: "http", hostname: "127.0.0.1", port: "54321", pathname: "/storage/v1/object/public/**" },
      { protocol: "http", hostname: "localhost", port: "54321", pathname: "/storage/v1/object/public/**" },
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
    ],
  },
  partialPrefetching: true,
  experimental: {
    // As áreas autenticadas (/app, /operacao, /platform) e o cardápio público
    // dependem de cookies/banco a cada requisição, então não são "instantâneas"
    // por natureza. Valida a navegação instantânea só onde houver `export const
    // instant` explícito (evita ruído de avisos em desenvolvimento).
    instantInsights: { validationLevel: "manual-warning" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
