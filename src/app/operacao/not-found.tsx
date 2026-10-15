import { NotFoundView } from "@/components/feedback/not-found-view";

export default function OperacaoNotFound() {
  return (
    <NotFoundView
      title="Página não encontrada"
      description="Este restaurante ou página não existe, ou você não tem vínculo com ele."
      homeHref="/entrar"
      homeLabel="Escolher restaurante"
    />
  );
}
