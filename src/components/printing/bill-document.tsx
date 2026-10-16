import { formatMoney } from "@/modules/operations/format";
import {
  BILL_DOCUMENT_LABELS,
  BILL_NOT_FISCAL_NOTICE,
  billPlace,
  billTotals,
  type BillPayload,
} from "@/modules/printing/bill";
import { paymentMethodLabel } from "@/modules/tab-billing/types";
import type { PaperWidth } from "@/modules/printing/types";
import { ItemLine } from "./print-document";

type BillDocumentProps = {
  payload: BillPayload;
  width: PaperWidth;
  /** 1 = original; 2+ = reimpressão (aparece como "2ª via" no papel). */
  copyNumber?: number;
};

/**
 * Conta térmica (parcial ou final) de uma comanda. Todo texto vem do payload
 * montado no servidor e é escapado pelo React. Não mostra dados pessoais e
 * deixa explícito que não é documento fiscal.
 */
export function BillDocument({ payload, width, copyNumber = 1 }: BillDocumentProps) {
  const { items, subtotalCents, paidCents, remainingCents } = billTotals(payload);
  const label = BILL_DOCUMENT_LABELS[payload.document_type];
  const place = billPlace(payload);
  const tab = payload.tab;
  const settled = remainingCents === 0;

  return (
    <article className={`tp-sheet tp-w${width}`} aria-label={`${label}${place ? `, ${place}` : ""}`}>
      <header className="tp-center">
        <p className="tp-restaurant">{payload.restaurant_name}</p>
        <p className="tp-doc">{label}</p>
        {copyNumber > 1 ? <p className="tp-copy">{copyNumber}ª VIA (REIMPRESSÃO)</p> : null}
        <p className="tp-banner">{BILL_NOT_FISCAL_NOTICE[payload.document_type]}</p>
      </header>
      <hr className="tp-rule" />
      <dl className="tp-meta">
        {place ? (
          <div>
            <dt>Local</dt>
            <dd className="tp-strong">{place}</dd>
          </div>
        ) : null}
        {tab?.guests ? (
          <div>
            <dt>Pessoas</dt>
            <dd>{tab.guests}</dd>
          </div>
        ) : null}
        {tab?.opened_at_local ? (
          <div>
            <dt>Abertura</dt>
            <dd>{tab.opened_at_local}</dd>
          </div>
        ) : null}
        {tab?.closed_at_local ? (
          <div>
            <dt>Fechamento</dt>
            <dd>{tab.closed_at_local}</dd>
          </div>
        ) : null}
        {payload.printed_at_local ? (
          <div>
            <dt>Emissão</dt>
            <dd>{payload.printed_at_local}</dd>
          </div>
        ) : null}
      </dl>
      <hr className="tp-rule" />
      {items.length === 0 ? (
        <p>Nenhum item consumido.</p>
      ) : (
        <ul className="tp-items">
          {items.map((item, index) => (
            <ItemLine key={`${item.name}-${index}`} item={item} receipt />
          ))}
        </ul>
      )}
      <hr className="tp-rule" />
      <dl className="tp-totals">
        <div className="tp-total">
          <dt>CONSUMO</dt>
          <dd>{formatMoney(subtotalCents)}</dd>
        </div>
      </dl>
      {payload.payments.length > 0 ? (
        <>
          <hr className="tp-rule" />
          <p className="tp-strong">Pagamentos registrados</p>
          <dl className="tp-pays">
            {payload.payments.map((payment, index) => (
              <div key={`${payment.method}-${index}`}>
                <dt>{paymentMethodLabel(payment.method)}</dt>
                <dd>{formatMoney(payment.amount_cents)}</dd>
              </div>
            ))}
          </dl>
          <dl className="tp-totals">
            <div>
              <dt>Total pago</dt>
              <dd>{formatMoney(paidCents)}</dd>
            </div>
          </dl>
        </>
      ) : null}
      <hr className="tp-rule" />
      <p className="tp-balance">
        <span>{settled ? "SALDO" : "A PAGAR"}</span>
        <span>{formatMoney(remainingCents)}</span>
      </p>
      {settled && subtotalCents > 0 ? <p className="tp-center">Conta quitada.</p> : null}
      {payload.unpaid_cents ? (
        <p className="tp-center">Comanda fechada com {formatMoney(payload.unpaid_cents)} em aberto.</p>
      ) : null}
      <hr className="tp-rule" />
      <footer className="tp-center tp-foot">
        <p>{BILL_NOT_FISCAL_NOTICE[payload.document_type]}</p>
        <p>Este sistema não emite nota fiscal.</p>
      </footer>
    </article>
  );
}
