import { DatabaseZap } from "lucide-react";
import { brand } from "@/config/brand";
import { BrandMark } from "@/components/brand-mark";
import { Card } from "@/components/ui/card";
import { getPublicEnvStatus } from "@/lib/env";

/**
 * Tela exibida quando as variáveis do Supabase não existem ou são inválidas.
 * Mostra apenas NOMES de variáveis, nunca valores.
 */
export function SupabaseNotConfigured() {
  const status = getPublicEnvStatus();
  const invalid = status.ok ? [] : status.invalid;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <BrandMark href="/" className="mb-8" />
      <Card className="w-full max-w-xl" aria-labelledby="sem-supabase-titulo">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-control bg-warning-soft text-warning-soft-fg"
          >
            <DatabaseZap className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 id="sem-supabase-titulo" className="text-xl font-semibold text-fg">
              Supabase não configurado
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              O {brand.name} precisa de um projeto Supabase para autenticar usuários e
              carregar dados. Esta parte do aplicativo fica indisponível até que as
              variáveis de ambiente sejam definidas.
            </p>
          </div>
        </div>

        {invalid.length > 0 ? (
          <div className="mt-5">
            <p className="text-sm font-medium text-fg">Variáveis ausentes ou inválidas</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {invalid.map((name) => (
                <li key={name}>
                  <code className="rounded-control bg-surface-2 px-2 py-1 font-mono text-[0.8125rem] text-fg">
                    {name}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <ol className="mt-6 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-muted marker:text-fg">
          <li>
            Copie <code className="font-mono text-fg">.env.example</code> para{" "}
            <code className="font-mono text-fg">.env.local</code>.
          </li>
          <li>
            Preencha a URL e a chave anon do projeto (para o Supabase local, rode{" "}
            <code className="font-mono text-fg">npx supabase start</code> e use os valores
            exibidos).
          </li>
          <li>Reinicie o servidor de desenvolvimento.</li>
        </ol>
      </Card>
    </div>
  );
}
