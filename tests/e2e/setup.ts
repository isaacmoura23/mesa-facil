import { afterEach } from "vitest";
import { saveFailureShots } from "./helpers";

// Screenshots SÓ em falhas (tests/e2e/.artifacts, ignorado pelo git via .gitignore do projeto).
afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail") await saveFailureShots(ctx.task.name);
});
