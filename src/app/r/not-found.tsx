import { NotFoundView } from "@/components/feedback/not-found-view";

export default function RNotFound() {
  return (
    <NotFoundView
      title="Restaurante não encontrado"
      description="Não encontramos um cardápio com este endereço. Confira o link ou peça um novo ao restaurante."
      homeHref="/"
      homeLabel="Ir para o início"
    />
  );
}
