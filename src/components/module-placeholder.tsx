import type { ReactNode } from "react";
import { Eye, Hammer } from "lucide-react";
import { MODULES, type ModuleKey } from "@/config/modules";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

type ModulePlaceholderProps = {
  module: ModuleKey;
  /** Visualização somente leitura (ex.: ambiente de gestão ou dono). */
  readOnly?: boolean;
  /** Texto extra sobre o que este perfil poderá fazer quando o módulo existir. */
  note?: string;
  children?: ReactNode;
};

/**
 * Estado vazio honesto para módulos ainda não construídos. Não exibe botões
 * de ação nem números: apenas diz o que é o módulo e quando está previsto.
 */
export function ModulePlaceholder({
  module,
  readOnly = false,
  note,
  children,
}: ModulePlaceholderProps) {
  const info = MODULES[module];

  return (
    <>
      <PageHeader
        title={info.title}
        description={info.description}
        badge={
          readOnly ? (
            <Badge tone="info">
              <Eye aria-hidden="true" className="mr-1 size-3" />
              Somente leitura
            </Badge>
          ) : undefined
        }
      />
      {children}
      <EmptyState
        icon={<Hammer />}
        title={`Módulo previsto para a Fase ${info.phase}`}
        description={
          <>
            Esta área ainda não foi construída, por isso não há dados nem ações
            disponíveis aqui.
            {note ? <> {note}</> : null}
          </>
        }
      />
    </>
  );
}
