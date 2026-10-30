# @mesafacil/storefront-sdk

SDK mínimo (só `fetch`, **zero dependências**, ESM + tipos) para vitrines personalizadas —
sites estáticos ou Next.js hospedados em outro domínio (ex.: `la-pastelaria.vercel.app`) — lerem o
cardápio de um restaurante do MesaFácil, cotarem o carrinho e **enviarem e acompanharem pedidos** pela
**API pública v1**.

> A vitrine **nunca** recebe chaves do Supabase. Cardápio, preços, horários e taxas vêm do SaaS; o dono
> edita tudo no painel e a vitrine reflete em até ~1 minuto. Cotar o carrinho **não cria pedido**; o pedido só
> existe depois de `createOrder`. **Não há pagamento online**: o cliente declara a forma (dinheiro, Pix ou
> cartão) e paga ao receber/retirar.

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

## Enviando o pedido (checkout)

`createOrder` recalcula tudo no servidor (preços, taxa, mínimo, horário) e cria o pedido com status
`RECEIVED`. Ele é **idempotente** por chave: reenviar o mesmo pedido com a mesma `idempotencyKey` (duplo clique,
retry após falha de rede) devolve o mesmo pedido (`idempotentReplay: true`), nunca um duplicado.

```ts
import {
  createStorefrontClient,
  newIdempotencyKey,
  StorefrontApiError,
} from "@mesafacil/storefront-sdk";

const api = createStorefrontClient({ baseUrl: "https://app.mesafacil.com.br", slug: "la-pastelaria" });

// Gere UMA chave por tentativa de checkout e guarde-a até o sucesso (sessionStorage).
const key = sessionStorage.getItem("checkout-key") ?? newIdempotencyKey();
sessionStorage.setItem("checkout-key", key);

try {
  const order = await api.createOrder({
    fulfillmentType: "DELIVERY",
    deliveryZoneId: zona.id,
    items: cart, // mesmo formato da cotação
    customer: { name: "Maria Souza", phone: "(11) 91234-5678", email: "maria@exemplo.com" },
    address: {
      street: "Rua das Flores",
      number: "120",
      neighborhood: "Centro",
      city: "São Paulo",
      postalCode: "01310-100",
      complement: "Apto 4",
      instructions: "Interfone 4",
    },
    notes: "Sem cebola",
    payment: { method: "CASH", changeForCents: 10000 }, // dinheiro, troco para R$ 100,00
    idempotencyKey: key,
  });

  sessionStorage.removeItem("checkout-key"); // sucesso: a próxima compra usa outra chave
  // Guarde o código: ele é o único segredo do acompanhamento.
  localStorage.setItem("ultimo-pedido", order.publicCode);
  location.href = `/pedido.html?codigo=${encodeURIComponent(order.publicCode)}`;
} catch (error) {
  if (error instanceof StorefrontApiError) {
    if (error.code === "order_rejected") {
      // 422: regras de negócio. Cada item de `rejections` tem mensagem PT-BR pronta para exibir.
      for (const r of error.rejections ?? []) {
        console.warn(r.itemIndex === null ? "Pedido:" : `Item ${r.itemIndex + 1}:`, r.message, `[${r.code}]`);
      }
    } else if (error.code === "rate_limited") {
      // 429: no máximo 5 pedidos a cada 10 min por IP e restaurante. Espere error.retryAfterSeconds.
    } else if (error.code === "invalid_request") {
      console.warn(error.details); // 400: [{ path: "customer.phone", message: "..." }]
    }
  }
}
```

### Acompanhar o pedido

```ts
const order = await api.trackOrder(publicCode); // 404 `order_not_found` se o código não existe
console.log(order.status, order.estimatedReadyAt, order.statusReason);
```

`status`: `RECEIVED` > `CONFIRMED` > `PREPARING` > `READY` > (`OUT_FOR_DELIVERY` só em entrega) > `COMPLETED`;
ou `REJECTED` / `CANCELLED` (com `statusReason`). Para acompanhar ao vivo, consulte a cada 10 a 15 s,
**pause quando a aba estiver oculta** (`document.visibilityState`), aumente o intervalo se houver erro e pare
nos estados finais. A resposta não traz telefone, e-mail, nome do cliente nem o endereço completo (só o bairro).

### Exemplo de página estática de checkout

```html
<form id="checkout">
  <input name="name" required minlength="2" maxlength="80" />
  <input name="phone" required inputmode="tel" />
  <select name="payment">
    <option value="PIX">Pix na entrega</option>
    <option value="CASH">Dinheiro</option>
    <option value="CARD">Cartão na entrega</option>
  </select>
  <button type="submit">Enviar pedido</button>
  <p id="msg" role="alert"></p>
</form>
<script type="module">
  import { createStorefrontClient, newIdempotencyKey, StorefrontApiError } from "./mesafacil-sdk/index.js";
  const api = createStorefrontClient({ baseUrl: "https://app.mesafacil.com.br", slug: "la-pastelaria" });
  const form = document.getElementById("checkout");
  const msg = document.getElementById("msg");
  const cart = JSON.parse(localStorage.getItem("cart") ?? "[]"); // [{ productId, quantity, modifierIds }]
  let key = sessionStorage.getItem("key") ?? newIdempotencyKey();
  sessionStorage.setItem("key", key);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true; // evita duplo clique (a chave de idempotência é a segunda barreira)
    const data = new FormData(form);
    try {
      const order = await api.createOrder({
        fulfillmentType: "PICKUP",
        items: cart,
        customer: { name: data.get("name"), phone: data.get("phone") },
        payment: { method: data.get("payment") },
        idempotencyKey: key,
      });
      sessionStorage.removeItem("key");
      localStorage.removeItem("cart");
      location.href = `pedido.html?codigo=${encodeURIComponent(order.publicCode)}`;
    } catch (error) {
      msg.textContent =
        error instanceof StorefrontApiError && error.rejections?.length
          ? error.rejections.map((r) => r.message).join(" ")
          : "Não foi possível enviar o pedido. Tente novamente.";
      button.disabled = false;
    }
  });
</script>
```

> `createOrder` envia o header `Idempotency-Key`, que dispara um preflight CORS: cadastre a origem da vitrine
> (veja CORS abaixo). Chamado do servidor da vitrine (Server Action / rota), não há CORS.

## Tratamento de erros

Toda falha é um `StorefrontApiError` com `code`, `status` (0 para falhas locais) e `message`:

```ts
import { StorefrontApiError } from "@mesafacil/storefront-sdk";

try {
  await api.quoteCart(input);
} catch (error) {
  if (error instanceof StorefrontApiError) {
    switch (error.code) {
      case "order_rejected": // 422 — veja error.rejections (createOrder)
      case "idempotency_conflict": // 409 — a chave foi usada com outro conteúdo
      case "order_not_found": // 404 — trackOrder com código inexistente
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

Por IP + restaurante: menu 120 req/min, cotação 60 req/min, acompanhamento 60 req/min e **pedidos 5 a cada
10 min** (`429` com `Retry-After`). Corpo de cotação/pedido até 64 KB. Em hospedagem serverless o contador é por instância; trate `rate_limited` com
espera e cacheie o cardápio na vitrine (`revalidate`) em vez de chamar a cada visita.

## Desenvolvimento do SDK

```bash
npx tsc -p sdk/tsconfig.json --noEmit   # checagem de tipos
cd sdk && npm run build                 # gera dist/ (ESM + .d.ts)
```

## CAPTCHA e limites (proteção contra abuso)

- Se a verificação CAPTCHA (Cloudflare Turnstile) estiver ligada no servidor, envie `captchaToken` em `createOrder`; sem ele a API responde `403 captcha_failed` (`StorefrontApiError.code === "captcha_failed"`).
- Pedidos também têm limite por telefone (5 por hora) e por restaurante (60 por minuto): a resposta traz o erro `RATE_LIMITED`.
- Restaurante com assinatura vencida ou cancelada responde `SUBSCRIPTION_INACTIVE`: mostre "restaurante temporariamente indisponível".
