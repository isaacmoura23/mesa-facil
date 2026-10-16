import { FULFILLMENT_LABELS, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from "@/modules/operations/types";
import { formatAddress, formatMoney } from "@/modules/operations/format";
import { DOCUMENT_LABELS, type PaperWidth, type PrintItem, type PrintPayload } from "@/modules/printing/types";

type PrintDocumentProps = {
  payload: PrintPayload;
  width: PaperWidth;
  /** 1 = original; 2+ = reimpressão (aparece como "2ª via" no papel). */
  copyNumber?: number;
};

function Rule() {
  return <hr className="tp-rule" />;
}

export function ItemLine({ item, receipt }: { item: PrintItem; receipt: boolean }) {
  return (
    <li className="tp-item">
      <div className="tp-item-main">
        <span className="tp-qty">{item.quantity}x</span>
        <span className="tp-name">{item.name}</span>
        {receipt && item.line_total_cents != null ? (
          <span className="tp-price">{formatMoney(item.line_total_cents)}</span>
        ) : null}
      </div>
      {item.variant_name ? <p className="tp-variant">{item.variant_name}</p> : null}
      {item.modifiers.length > 0 ? (
        <ul className="tp-mods">
          {item.modifiers.map((modifier, index) => (
            <li key={`${modifier.name}-${index}`}>
              + {modifier.quantity > 1 ? `${modifier.quantity}x ` : ""}
              {modifier.name}
              {receipt && modifier.price_delta_cents > 0 ? ` (${formatMoney(modifier.price_delta_cents)})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {item.notes ? <p className="tp-note">OBS: {item.notes}</p> : null}
    </li>
  );
}

/**
 * Documento térmico (comanda de preparo ou recibo do pedido). Todo texto vem do
 * payload montado no servidor e é escapado pelo React. A comanda nunca mostra preços.
 */
export function PrintDocument({ payload, width, copyNumber = 1 }: PrintDocumentProps) {
  const receipt = payload.document_type === "ORDER_RECEIPT";
  const place = [
    payload.table_label ? `Mesa ${payload.table_label}` : null,
    payload.tab_label ? `Comanda ${payload.tab_label}` : null,
  ]
    .filter(Boolean)
    .join(" / ");
  const customer = receipt ? payload.customer_name : payload.customer_first_name;
  const address = formatAddress(payload.delivery_address);
  const method = payload.payment_method
    ? (PAYMENT_METHOD_LABELS[payload.payment_method] ?? payload.payment_method)
    : null;
  const payAt =
    payload.fulfillment_type === "DELIVERY"
      ? "na entrega"
      : payload.fulfillment_type === "PICKUP"
        ? "na retirada"
        : "no local";

  return (
    <article
      className={`tp-sheet tp-w${width}`}
      aria-label={`${DOCUMENT_LABELS[payload.document_type]} do pedido ${payload.order_number}`}
    >
      <header className="tp-center">
        <p className="tp-restaurant">{payload.restaurant_name}</p>
        <p className="tp-doc">{DOCUMENT_LABELS[payload.document_type]}</p>
        {copyNumber > 1 ? <p className="tp-copy">{copyNumber}ª VIA (REIMPRESSÃO)</p> : null}
      </header>
      <Rule />
      <p className="tp-number">PEDIDO #{payload.order_number}</p>
      <dl className="tp-meta">
        {payload.created_at_local ? (
          <div>
            <dt>Data/hora</dt>
            <dd>{payload.created_at_local}</dd>
          </div>
        ) : null}
        <div>
          <dt>Modalidade</dt>
          <dd className="tp-strong">{FULFILLMENT_LABELS[payload.fulfillment_type]}</dd>
        </div>
        {place ? (
          <div>
            <dt>Local</dt>
            <dd className="tp-strong">{place}</dd>
          </div>
        ) : null}
        {customer ? (
          <div>
            <dt>Cliente</dt>
            <dd>{customer}</dd>
          </div>
        ) : null}
      </dl>
      <Rule />
      {payload.items.length === 0 ? (
        <p>Nenhum item registrado.</p>
      ) : (
        <ul className="tp-items">
          {payload.items.map((item, index) => (
            <ItemLine key={`${item.name}-${index}`} item={item} receipt={receipt} />
          ))}
        </ul>
      )}
      {payload.notes ? (
        <>
          <Rule />
          <p className="tp-note">OBS DO PEDIDO: {payload.notes}</p>
        </>
      ) : null}

      {receipt ? (
        <>
          <Rule />
          <dl className="tp-totals">
            {payload.subtotal_cents != null ? (
              <div>
                <dt>Subtotal</dt>
                <dd>{formatMoney(payload.subtotal_cents)}</dd>
              </div>
            ) : null}
            {payload.delivery_fee_cents ? (
              <div>
                <dt>Taxa de entrega</dt>
                <dd>{formatMoney(payload.delivery_fee_cents)}</dd>
              </div>
            ) : null}
            {payload.discount_cents ? (
              <div>
                <dt>Desconto</dt>
                <dd>-{formatMoney(payload.discount_cents)}</dd>
              </div>
            ) : null}
            {payload.total_cents != null ? (
              <div className="tp-total">
                <dt>TOTAL</dt>
                <dd>{formatMoney(payload.total_cents)}</dd>
              </div>
            ) : null}
          </dl>
          <p className="tp-pay">
            {method ? `Pagamento declarado: ${method}, a pagar ${payAt}.` : "Forma de pagamento não declarada."}
            {payload.payment_method === "CASH" && payload.change_for_cents && payload.total_cents != null
              ? ` Troco para ${formatMoney(payload.change_for_cents)} (levar ${formatMoney(Math.max(0, payload.change_for_cents - payload.total_cents))}).`
              : ""}
          </p>
          {payload.payment_status ? (
            <p>Situação: {PAYMENT_STATUS_LABELS[payload.payment_status] ?? payload.payment_status}</p>
          ) : null}
          {payload.fulfillment_type === "DELIVERY" && address.length > 0 ? (
            <>
              <Rule />
              <p className="tp-strong">Entregar em:</p>
              {address.map((line) => (
                <p key={line}>{line}</p>
              ))}
              {payload.delivery_address?.complement ? <p>Compl.: {payload.delivery_address.complement}</p> : null}
              {payload.delivery_address?.instructions ? <p>Ref.: {payload.delivery_address.instructions}</p> : null}
            </>
          ) : null}
        </>
      ) : null}
      <Rule />
      <footer className="tp-center tp-foot">
        {receipt ? <p>Documento sem valor fiscal.</p> : <p>Comanda de preparo, sem preços.</p>}
      </footer>
    </article>
  );
}
