import type { SessionMap, World } from "../fixtures/world";

declare module "vitest" {
  export interface ProvidedContext {
    world: World;
    sessions: SessionMap;
  }
}

export {};
