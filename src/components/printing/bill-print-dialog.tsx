"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Info, Printer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { BILL_DOCUMENT_LABELS, type BillDocumentType, type BillPayload } from "@/modules/printing/bill";
import {
  getPaperWidthServerSnapshot,
  getPaperWidthSnapshot,
  setPaperWidth,
  subscribePaperWidth,
} from "@/modules/printing/paper-width";
import { markPrintJob, requestTabPrint } from "@/modules/printing/rpc";
import { dispatchCount, recordDispatch } from "@/modules/printing/session-log";
import { PAPER_WIDTHS, type PaperWidth } from "@/modules/printing/types";
import { BillDocument } from "./bill-document";
import { PrintStyles } from "./print-styles";
import { Segmented } from "./segmented";

export type BillPrintDialogProps = {
  tabId: string;
  documentType: BillDocumentType;
  /** Mesa/comanda para o título (ex.: "Mesa 4"). */
  placeLabel?: string;
  onClose: () => void;
};

type Phase = "idle" | "requesting" | "printing" | "opened" | "failed";
type Job = { id: string; payload: BillPayload; copy: number };

const WIDTH_LABELS: Record<PaperWidth, string> = { "80": "80 mm (padrão)", "58": "58 mm" };

/**
 * Diálogo de impressão da conta. Mesmo fluxo do pedido: `request_tab_print`
 * (o servidor registra quem/quando e devolve o payload) -> renderiza ->
 * `window.print()` -> `mark_print_job` DISPATCHED. Só afirma que o diálogo do
 * navegador foi aberto, nunca que o papel saiu. Reimprimir cria novo pedido de impressão.
 */
export function BillPrintDialog({ tabId, documentType, placeLabel, onClose }: BillPrintDialogProps) {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const helpId = useId();
  const logKey = `${tabId}:${documentType}`;
  const width = useSyncExternalStore(subscribePaperWidth, getPaperWidthSnapshot, getPaperWidthServerSnapshot);
  const [phase, setPhase] = useState<Phase>("idle");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [sent, setSent] = useState(() => dispatchCount(logKey));
  const printedJobRef = useRef<string | null>(null);
  const label = BILL_DOCUMENT_LABELS[documentType];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const busy = phase === "requesting" || phase === "printing";

  async function send() {
    if (busy) return;
    setPhase("requesting");
    setError(null);
    setWarning(null);
    try {
      const result = await requestTabPrint(supabase, tabId, documentType);
      setJob({ id: result.job_id, payload: result.payload, copy: sent + 1 });
      setPhase("printing");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível pedir a impressão.");
      setPhase("failed");
    }
  }

  // Com o documento já renderizado, abre o diálogo do navegador e registra o resultado.
  useEffect(() => {
    if (phase !== "printing" || !job) return;
    let frame = 0;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (printedJobRef.current === job.id) return;
        printedJobRef.current = job.id;
        void (async () => {
          let failure: string | null = null;
          try {
            window.print();
          } catch (cause) {
            failure = cause instanceof Error ? cause.message : "O navegador não abriu a impressão.";
          }
          try {
            await markPrintJob(supabase, job.id, failure ? "FAILED" : "DISPATCHED");
          } catch (cause) {
            setWarning(
              `${cause instanceof Error ? cause.message : "Falha ao registrar."} O pedido de impressão ficou sem o estado final no servidor.`,
            );
          }
          if (failure) {
            setError(`Não foi possível abrir a impressão: ${failure}`);
            setPhase("failed");
          } else {
            setSent(recordDispatch(logKey));
            setPhase("opened");
          }
        })();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [phase, job, supabase, logKey]);

  const widthOptions = PAPER_WIDTHS.map((value) => ({ value, label: WIDTH_LABELS[value] }));
  const again = sent > 0 || phase === "opened" || phase === "failed";

  return (
    <>
      <PrintStyles width={width} />
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={helpId}
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) onClose();
        }}
        onClick={(event) => {
          if (event.target === dialogRef.current && !busy) onClose();
        }}
        className="m-auto max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-lg overflow-y-auto rounded-card border border-line bg-surface p-0 text-fg shadow-pop"
      >
        <div className="flex flex-col gap-5 p-5 sm:p-6">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold">
                {again ? "Reimprimir" : "Imprimir"} {label.toLowerCase()}
                {placeLabel ? `: ${placeLabel}` : ""}
              </h2>
              <p id={helpId} className="mt-1 text-sm leading-relaxed text-muted">
                Abre o diálogo de impressão do navegador. Escolha a impressora térmica nele.
              </p>
            </div>
            <Button variant="ghost" size="md" onClick={onClose} disabled={busy} aria-label="Fechar" className="-mr-2 px-3">
              <X aria-hidden="true" className="size-5" />
            </Button>
          </header>

          <p className="text-sm font-medium">{label} (não é documento fiscal)</p>
          <Segmented
            legend="Largura do papel"
            value={width}
            options={widthOptions}
            onChange={setPaperWidth}
            disabled={phase === "printing"}
          />

          <div role="status" aria-live="polite" className="min-h-6 text-sm">
            {phase === "requesting" ? <p className="text-muted">Registrando o pedido de impressão...</p> : null}
            {phase === "printing" ? <p className="text-muted">Abrindo o diálogo de impressão...</p> : null}
            {phase === "opened" ? (
              <p className="font-medium text-accent-soft-fg">
                Enviado para impressão: o diálogo de impressão foi aberto. Confira o papel na impressora.
              </p>
            ) : null}
            {warning ? <p className="mt-1 text-warning-soft-fg">{warning}</p> : null}
          </div>
          {phase === "failed" && error ? (
            <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm font-medium text-danger-soft-fg">
              {error}
            </p>
          ) : null}

          {job ? (
            <section aria-label="Prévia do documento" className="overflow-x-auto rounded-control border border-line bg-surface-2 p-3">
              <div className="mx-auto w-fit shadow-card">
                <BillDocument payload={job.payload} width={width} copyNumber={job.copy} />
              </div>
            </section>
          ) : null}

          <details className="group rounded-control border border-line px-3 py-2 text-sm">
            <summary className="flex cursor-pointer items-center gap-2 font-medium">
              <Info aria-hidden="true" className="size-4 shrink-0 text-muted" />
              Sobre a impressão
            </summary>
            <div className="mt-2 flex flex-col gap-2 leading-relaxed text-muted">
              <p>
                A conta mostra o consumo e os pagamentos registrados até o momento do pedido. O sistema registra cada
                pedido de impressão (quem pediu e quando), mas não sabe se o papel saiu: só que o diálogo do navegador foi
                aberto.
              </p>
              <p>Este documento não é nota fiscal. Reimprimir cria um novo pedido de impressão com os valores atuais.</p>
            </div>
          </details>

          <footer className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>
              Fechar
            </Button>
            <Button size="lg" onClick={() => void send()} loading={busy}>
              <Printer aria-hidden="true" className="size-4" />
              {again ? "Reimprimir" : "Enviar para impressão"}
            </Button>
          </footer>
        </div>
      </dialog>

      {job ? (
        <div className="tp-print-only" aria-hidden="true">
          <BillDocument payload={job.payload} width={width} copyNumber={job.copy} />
        </div>
      ) : null}
    </>
  );
}
