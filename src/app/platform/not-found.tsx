import { NotFoundView } from "@/components/feedback/not-found-view";

export default function PlatformNotFound() {
  return (
    <NotFoundView
      title="Página não encontrada"
      description="O endereço não existe ou você não tem acesso à administração da plataforma."
      homeHref="/entrar"
      homeLabel="Voltar ao início"
    />
  );
}
