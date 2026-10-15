import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          testTimeout: 10_000,
        },
      },
      {
        // Integração contra o Supabase LOCAL real (PostgREST/RPC/Storage/Realtime com JWT de usuário).
        // Arquivos em sequência: os testes mexem em estado compartilhado (status de restaurante, slug,
        // sessões de suporte) e restauram tudo ao final.
        extends: true,
        test: {
          name: "rls",
          // tests/api (HTTP contra o dev server em API_BASE_URL) roda no MESMO projeto, em sequência: compartilha os DEMO e o
          // globalSetup/seed. Sem servidor respondendo, o arquivo se pula sozinho.
          include: ["tests/rls/**/*.test.ts", "tests/api/**/*.test.ts"],
          globalSetup: ["./tests/setup/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
