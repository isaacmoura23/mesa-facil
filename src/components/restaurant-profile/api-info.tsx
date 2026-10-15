"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";

type ApiInfoProps = {
  /** Origem do SaaS, sem barra final (ex.: https://app.exemplo.com.br). */
  baseUrl: string;
  slug: string;
};

type CopyState = "idle" | "copied" | "failed";

/** URL da API pública do cardápio e um trecho de exemplo do SDK (orientação). */
export function ApiInfo({ baseUrl, slug }: ApiInfoProps) {
  const menuUrl = `${baseUrl}/api/public/v1/restaurants/${slug}/menu`;
  const [copy, setCopy] = useState<CopyState>("idle");
  const urlRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copyUrl() {
    let next: CopyState = "copied";
    try {
      await navigator.clipboard.writeText(menuUrl);
    } catch {
      // Sem permissão de área de transferência: seleciona o texto para copiar à mão.
      urlRef.current?.select();
      next = "failed";
    }
    setCopy(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy("idle"), 3000);
  }

  const snippet = `import { createStorefrontClient, formatLowestPrice } from "@mesafacil/storefront-sdk";

const api = createStorefrontClient({
  baseUrl: "${baseUrl}",
  slug: "${slug}",
});

const menu = await api.getMenu();
console.log(menu.restaurant.name);
for (const category of menu.categories) {
  for (const product of category.products) {
    console.log(product.name, formatLowestPrice(product));
  }
}`;

  return (
    <Card aria-labelledby="api-title">
      <CardHeader
        title={<span id="api-title">API pública do cardápio</span>}
        description="Para quem desenvolve o seu site próprio. Somente leitura: não é preciso nenhuma chave."
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="api-menu-url" className="text-sm font-medium text-fg">
            Endereço do cardápio (GET)
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="api-menu-url"
              ref={urlRef}
              readOnly
              value={menuUrl}
              onFocus={(event) => event.currentTarget.select()}
              className="block h-11 min-w-0 flex-1 rounded-control border border-line bg-surface-2 px-3 font-mono text-base text-fg sm:text-sm"
            />
            <Button variant="secondary" onClick={() => void copyUrl()}>
              {copy === "copied" ? (
                <Check aria-hidden="true" className="size-4" />
              ) : (
                <Copy aria-hidden="true" className="size-4" />
              )}
              {copy === "copied" ? "Copiado" : "Copiar endereço"}
            </Button>
          </div>
          <p role="status" className="min-h-5 text-sm text-muted">
            {copy === "copied" ? "Endereço copiado." : null}
            {copy === "failed" ? "Não foi possível copiar automaticamente. O texto foi selecionado: use Ctrl+C." : null}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-fg">Exemplo com o SDK</p>
          <pre
            tabIndex={0}
            aria-label="Exemplo de código com o SDK"
            className="max-w-full overflow-x-auto rounded-control border border-line bg-surface-2 p-3 text-xs leading-relaxed text-fg"
          >
            <code>{snippet}</code>
          </pre>
          <p className="text-sm text-muted">
            O pacote ainda não está no npm: as instruções de instalação e mais exemplos (incluindo cotação de
            carrinho) estão em <code className="text-fg">sdk/README.md</code>, no repositório do MesaFácil.
            Chamadas feitas pelo servidor do seu site não precisam de domínio autorizado; as feitas pelo
            navegador precisam.
          </p>
        </div>
      </div>
    </Card>
  );
}
