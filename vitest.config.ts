import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

// O projeto e2e (navegador real) só entra quando pedido (`npx vitest run --project e2e` ou E2E=1), para o `npm test`
// padrão continuar leve e sem depender do dev server.
const wantsE2e = Boolean(process.env.E2E) || process.argv.some((a) => a === "e2e" || a === "--project=e2e");
const e2eProject = {
  // E2E com NAVEGADOR REAL (playwright-core + Chromium) contra o dev server local (E2E_BASE_URL, padrão
  // http://localhost:3100) e o Supabase local. Sequencial; sem globalSetup (o seed é rodado antes: npm run db:seed:dev).
  extends: true as const,
  test: {
    name: "e2e",
    include: ["tests/e2e/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    sequence: { concurrent: false },
    setupFiles: ["./tests/e2e/setup.ts"],
  },
};
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
      ...(wantsE2e ? [e2eProject] : []),
    ],
  },
});
