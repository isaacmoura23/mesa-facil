import type { PaperWidth } from "@/modules/printing/types";

/**
 * CSS do documento térmico e do `@media print`. Texto estático (nada vindo do
 * usuário entra aqui). No papel só sai o conteúdo de `.tp-print-only`: o resto
 * do app (navegação, botões, drawers, o diálogo de impressão) é ocultado.
 */
function css(width: PaperWidth): string {
  return `
@page { size: ${width}mm auto; margin: 0; }
.tp-print-only { display: none; }
.tp-sheet {
  box-sizing: border-box; background: #fff; color: #000; text-align: left;
  font-family: ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px; line-height: 1.35; padding: 3mm; overflow-wrap: anywhere;
}
.tp-sheet.tp-w80 { width: 80mm; }
.tp-sheet.tp-w58 { width: 58mm; font-size: 11px; padding: 2mm; }
.tp-sheet p, .tp-sheet dl, .tp-sheet ul, .tp-sheet dd, .tp-sheet dt { margin: 0; padding: 0; }
.tp-sheet ul { list-style: none; }
.tp-center { text-align: center; }
.tp-restaurant { font-size: 1.25em; font-weight: 800; text-transform: uppercase; }
.tp-doc { font-weight: 700; margin-top: 2px; }
.tp-copy { margin-top: 2px; font-weight: 800; border: 2px solid #000; display: inline-block; padding: 0 4px; }
.tp-rule { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
.tp-number { font-size: 2em; font-weight: 800; text-align: center; line-height: 1.15; }
.tp-meta > div { display: flex; justify-content: space-between; gap: 6px; }
.tp-meta dt, .tp-totals dt { font-weight: 400; }
.tp-meta dd { text-align: right; }
.tp-strong { font-weight: 800; }
.tp-item { break-inside: avoid; page-break-inside: avoid; padding: 4px 0; }
.tp-item + .tp-item { border-top: 1px dotted #000; }
.tp-item-main { display: flex; align-items: baseline; gap: 6px; }
.tp-qty { font-size: 1.7em; font-weight: 800; line-height: 1; min-width: 2.2ch; }
.tp-name { flex: 1; font-size: 1.2em; font-weight: 800; }
.tp-price { font-weight: 700; white-space: nowrap; }
.tp-variant { font-weight: 800; margin-top: 2px; padding-left: 2.6ch; }
.tp-mods { padding-left: 2.6ch; font-weight: 700; margin-top: 2px; }
.tp-note { margin-top: 3px; border: 2px solid #000; padding: 1px 4px; font-weight: 800; break-inside: avoid; }
.tp-totals > div { display: flex; justify-content: space-between; gap: 6px; }
.tp-total { font-size: 1.3em; font-weight: 800; margin-top: 2px; }
.tp-pay { margin-top: 4px; font-weight: 700; }
.tp-foot { font-size: 0.9em; }
.tp-banner { margin-top: 4px; border: 2px solid #000; padding: 2px 4px; font-weight: 800; text-align: center; }
.tp-pays > div { display: flex; justify-content: space-between; gap: 6px; }
.tp-balance { font-size: 1.3em; font-weight: 800; margin-top: 2px; display: flex; justify-content: space-between; gap: 6px; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; height: auto !important; overflow: visible !important; }
  body > *:not(#tp-host) { display: none !important; }
  #tp-host > *:not(.tp-print-only) { display: none !important; }
  .tp-print-only { display: block !important; }
  .tp-sheet { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;
}

export function PrintStyles({ width }: { width: PaperWidth }) {
  return <style>{css(width)}</style>;
}
