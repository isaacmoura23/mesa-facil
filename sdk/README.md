# @mesafacil/storefront-sdk

SDK mínimo (só `fetch`, **zero dependências**, ESM + tipos) para vitrines personalizadas —
sites estáticos ou Next.js hospedados em outro domínio (ex.: `la-pastelaria.vercel.app`) — lerem o
cardápio de um restaurante do MesaFácil e cotarem o carrinho pela **API pública v1**.

> A vitrine **nunca** recebe chaves do Supabase. Cardápio, preços, horários e taxas vêm do SaaS; o dono
> edita tudo no painel e a vitrine reflete em até ~1 minuto. Cotar o carrinho **não cria pedido** (a criação
> de pedidos chega na Fase 3).

## Instalação

O pacote ainda não está no npm. Escolha uma das formas:

**1. Copiar a pasta** (mais simples para um site estático): copie `sdk/src/` para o seu projeto
(ex.: `src/vendor/mesafacil-sdk/`) e importe de `./vendor/mesafacil-sdk/index`.

**2. Pasta local** (monorepo/irmãos de pasta):

```bash
cd sdk && npm install && npm run build   # gera sdk/dist
cd ../minha-vitrine
npm i ../caminho/para/test1/sdk
```

**3. Git** (quando o repositório do SaaS estiver acessível; o `prepare` compila o pacote ao instalar):

```bash
npm i "git+https://SEU-REPO.git#main"   # aponte para a subpasta `sdk` conforme o seu fluxo de CI
```

Requer um ambiente com `fetch`, `AbortController` e `Intl` (todos os navegadores atuais e Node 18+).

## Uso rápido

```ts
import { createStorefrontClient, formatCents, lowestPrice, isOpenNow } from "@mesafacil/storefront-sdk";

const api = createStorefrontClient({
  baseUrl: "https://app.mesafacil.com.br", // origem do SaaS, sem barra final
  slug: "la-pastelaria",
});

const menu = await api.getMenu();
console.log(menu.restaurant.name, isOpenNow(menu) ? "Aberto" : "Fechado");

for (const category of menu.categories) {
  for (const product of category.products) {
    const { cents, isFrom } = lowestPrice(product);
    console.log(product.name, isFrom ? "a partir de" : "", formatCents(cents));
  }
}
```

### Opções

| Opção | Descrição |
|---|---|
| `baseUrl` | Origem do SaaS (ex.: `https://app.mesafacil.com.br`). |
| `slug` | Slug do restaurante. |
| `fetch` | `fetch` customizado (testes, cache do Next, polyfill). Padrão: `globalThis.fetch`. |
| `timeoutMs` | Tempo máximo por chamada (padrão 10000). Excedido => `StorefrontApiError` com `code: "timeout"`. |

Cada método aceita ainda `{ signal }` para cancelar a chamada.

## Exemplo: site estático (HTML + JS)

```html
<ul id="menu"></ul>
<script type="module">
  import { createStorefrontClient, formatLowestPrice } from "./mesafacil-sdk/index.js";

  const api = createStorefrontClient({ baseUrl: "https://app.mesafacil.com.br", slug: "la-pastelaria" });
  const list = document.getElementById("menu");

  try {
    const menu = await api.getMenu();
    for (const category of menu.categories) {
      for (const p of category.products.filter((p) => p.isAvailable)) {
        const li = document.createElement("li");
        li.textContent = `${p.name} — ${formatLowestPrice(p)}`; // "a partir de R$ 18,00" quando há variantes
        list.append(li);
      }
    }
  } catch (error) {
    list.textContent = "Não foi possível carregar o cardápio agora.";
  }
</script>
```

> Para sites estáticos sem build, compile antes (`npm run build` em `sdk/`) e copie `dist/` — ou use a
> pasta `src` num projeto com bundler (Vite, esbuild).

## Exemplo: Next.js (App Router)

Servidor (Server Component), com cache de 30 s alinhado ao da API:

```tsx
// app/page.tsx
import { createStorefrontClient, formatLowestPrice } from "@mesafacil/storefront-sdk";

const api = createStorefrontClient({
  baseUrl: process.env.MESAFACIL_API_URL!, // https://app.mesafacil.com.br
  slug: "la-pastelaria",
  // Next: deixa o Data Cache revalidar a cada 30 s
  fetch: (url, init) => fetch(url, { ...init, next: { revalidate: 30 } }),
});

export default async function Page() {
  const menu = await api.getMenu();
  return (
    <main>
      <h1>{menu.restaurant.name}</h1>
      {menu.categories.map((c) => (
        <section key={c.id}>
          <h2>{c.name}</h2>
          {c.products.map((p) => (
            <p key={p.id}>
              {p.name} — {formatLowestPrice(p)}
            </p>
          ))}
        </section>
      ))}
    </main>
  );
}
```

Chamadas do **servidor** (Server Components, rotas, `getStaticProps`) não enviam `Origin`, então **não passam
por CORS**. Já `quoteCart` costuma ser chamado do navegador (carrinho interativo): nesse caso o domínio da
vitrine precisa estar cadastrado (veja CORS abaixo).

## Montando o carrinho e cotando

O carrinho vive no navegador da vitrine; o **preço nunca vem do cliente**: o servidor recalcula tudo.

```ts
import type { QuoteInput } from "@mesafacil/storefront-sdk";

type CartLine = {
  productId: string;
  variantId?: string; // obrigatório se o produto tem `variants`
  quantity: number; // 1 a 99
  modifierIds: string[]; // adicionais escolhidos
  notes?: string; // até 500 caracteres
};

const cart: CartLine[] = [
  { productId: pastel.id, variantId: grande.id, quantity: 2, modifierIds: [catupiry.id] },
  { productId: refri.id, quantity: 1, modifierIds: [], notes: "bem gelado" },
];

const input: QuoteInput = {
  fulfillmentType: "DELIVERY", // "DELIVERY" | "PICKUP" | "DINE_IN"
  deliveryZoneId: zona.id, // só para DELIVERY (veja menu.settings.deliveryZones)
  items: cart, // até 50 itens
};

const quote = await api.quoteCart(input);

if (quote.ok) {
  console.log("Total:", formatCents(quote.totalCents)); // subtotal + taxa de entrega - desconto
} else {
  // Cotar com problemas NÃO é erro HTTP: vem ok=false + errors[] (mensagens PT-BR prontas para exibir).
  for (const e of quote.errors) {
    console.warn(e.itemIndex === null ? "Pedido:" : `Item ${e.itemIndex + 1}:`, e.message, `[${e.code}]`);
  }
}
```

Códigos de `quote.errors[].code`: `RESTAURANT_UNAVAILABLE`, `RESTAURANT_CLOSED`, `FULFILLMENT_DISABLED`,
`PRODUCT_UNAVAILABLE`, `VARIANT_REQUIRED`, `VARIANT_UNAVAILABLE`, `VARIANT_NOT_ALLOWED`, `MODIFIER_UNAVAILABLE`,
`MODIFIER_NOT_ALLOWED`, `MODIFIER_GROUP_MIN`, `MODIFIER_GROUP_MAX`, `INVALID_QUANTITY`, `BELOW_MINIMUM`,
`ZONE_REQUIRED`, `ZONE_UNAVAILABLE`, `EMPTY_CART`. Aceite códigos desconhecidos (novos podem surgir) e use
`message`.

### Preço exibido

* `product.priceCents` é o preço base; com `variants`, é o **menor** entre as variantes disponíveis.
* `lowestPrice(product)` devolve `{ cents, isFrom }`; `isFrom` indica que a vitrine deve mostrar “a partir de”.
* `formatLowestPrice(product)` já devolve o texto (“a partir de R$ 18,00”).
* `isOpenNow(menu)` usa o `isOpenNow` calculado pelo servidor (horários, exceções e fuso do restaurante).
  `menu.settings.acceptsOrders` indica se o restaurante está recebendo pedidos.

## Tratamento de erros

Toda falha é um `StorefrontApiError` com `code`, `status` (0 para falhas locais) e `message`:

```ts
import { StorefrontApiError } from "@mesafacil/storefront-sdk";

try {
  await api.quoteCart(input);
} catch (error) {
  if (error instanceof StorefrontApiError) {
    switch (error.code) {
      case "rate_limited": // 429 — espere error.retryAfterSeconds
      case "origin_not_allowed": // 403 — cadastre a origem (veja CORS)
      case "invalid_request": // 400 — veja error.details
      case "restaurant_not_found": // 404
      case "payload_too_large": // 413
      case "network_error": // sem resposta (rede ou CORS bloqueado pelo navegador)
      case "timeout":
      case "internal_error": // 500
    }
  }
}
```

## CORS: cadastre o domínio da vitrine

Chamadas feitas **do navegador** só funcionam para origens autorizadas por restaurante:

1. No painel do SaaS, abra `/app/[slug]/restaurante` e cadastre a **origem exata** da vitrine em
   “Origens permitidas”: esquema + domínio (+ porta), por exemplo `https://la-pastelaria.vercel.app`.
2. Regras: apenas `https`, sem curingas (`*.vercel.app` não vale), sem barra final ou caminho, no máximo 5
   origens. Domínio próprio e domínio `.vercel.app` são origens diferentes: cadastre os dois se usar ambos.
3. Em desenvolvimento do **SaaS** (`NODE_ENV !== "production"`), `http://localhost:*` e `http://127.0.0.1:*`
   também são aceitos. Em produção, teste a vitrine local apontando para a API de homologação ou use o
   servidor (Server Components), que não passa por CORS.
4. Origem não cadastrada => `403 origin_not_allowed` (no navegador aparece como erro de CORS/`network_error`).
5. O cache da lista de origens é de ~60 s: após cadastrar, aguarde um minuto.

Requisições sem cabeçalho `Origin` (servidor a servidor, `curl`) não são afetadas por CORS.

## Limites

Por IP + restaurante: menu 120 req/min, cotação 60 req/min (`429` com `Retry-After`). Corpo de cotação
até 64 KB. Em hospedagem serverless o contador é por instância; trate `rate_limited` com
espera e cacheie o cardápio na vitrine (`revalidate`) em vez de chamar a cada visita.

## Desenvolvimento do SDK

```bash
npx tsc -p sdk/tsconfig.json --noEmit   # checagem de tipos
cd sdk && npm run build                 # gera dist/ (ESM + .d.ts)
```
