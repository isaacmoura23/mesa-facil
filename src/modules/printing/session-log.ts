/**
 * Memória da sessão (só nesta aba): quantas vezes o diálogo de impressão foi
 * aberto por pedido. Serve para trocar "Imprimir" por "Reimprimir" e numerar a via.
 * A fonte da verdade continua sendo `print_jobs` no servidor.
 */
const dispatched = new Map<string, number>();
const listeners = new Set<() => void>();

export function subscribeSessionLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatchCount(orderId: string): number {
  return dispatched.get(orderId) ?? 0;
}

export function recordDispatch(orderId: string): number {
  const next = dispatchCount(orderId) + 1;
  dispatched.set(orderId, next);
  for (const listener of listeners) listener();
  return next;
}
