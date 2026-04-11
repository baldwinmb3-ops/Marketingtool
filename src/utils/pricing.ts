import { CartLine, TicketLine } from "../types";

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function formatMoney(value: number): string {
  return roundMoney(value).toFixed(2);
}

export function parseCurrencyInput(value: string): number {
  const cleaned = value.replace(/[^0-9.-]/g, "");
  if (!cleaned) {
    return 0;
  }
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

export function parsePositiveIntegerInput(value: string, fallback = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.trunc(parsed);
  if (normalized < 1) {
    return fallback;
  }
  return normalized;
}

export function buildTicketDisplayText(ticketLabel: string, qualifierText: string): string {
  if (!qualifierText.trim()) {
    return ticketLabel.trim();
  }
  return `${ticketLabel.trim()} ${qualifierText.trim()}`;
}

export function lineRetailTotal(line: CartLine): number {
  return roundMoney(line.retailEach * line.qty);
}

export function lineCmaTotal(line: CartLine): number {
  return roundMoney(line.cmaEach * line.qty);
}

export function cartRetailGrandTotal(cartLines: CartLine[]): number {
  return roundMoney(cartLines.reduce((sum, line) => sum + lineRetailTotal(line), 0));
}

export function cartGuestStartingTotal(cartLines: CartLine[]): number {
  return roundMoney(cartLines.reduce((sum, line) => sum + lineCmaTotal(line), 0));
}

export interface TwoWayTotalsInput {
  guestStartingTotal: number;
  contributionInput: string;
  guestFinalInput: string;
  lastEdited: "contribution" | "guestFinal";
}

export interface TwoWayTotalsResult {
  marketerContribution: number;
  guestFinalTotal: number;
  contributionWasClamped: boolean;
  guestFinalWasClamped: boolean;
}

export function calculateTwoWayTotals(input: TwoWayTotalsInput): TwoWayTotalsResult {
  const guestStarting = roundMoney(Math.max(0, input.guestStartingTotal));

  if (input.lastEdited === "guestFinal") {
    const requestedGuestFinal = parseCurrencyInput(input.guestFinalInput);
    const clampedGuestFinal = roundMoney(Math.min(guestStarting, Math.max(0, requestedGuestFinal)));

    return {
      marketerContribution: roundMoney(guestStarting - clampedGuestFinal),
      guestFinalTotal: clampedGuestFinal,
      contributionWasClamped: false,
      guestFinalWasClamped: requestedGuestFinal !== clampedGuestFinal
    };
  }

  const requestedContribution = parseCurrencyInput(input.contributionInput);
  const clampedContribution = roundMoney(Math.min(guestStarting, Math.max(0, requestedContribution)));

  return {
    marketerContribution: clampedContribution,
    guestFinalTotal: roundMoney(guestStarting - clampedContribution),
    contributionWasClamped: requestedContribution !== clampedContribution,
    guestFinalWasClamped: false
  };
}

export function mapLineToCart(brandName: string, line: TicketLine): Omit<CartLine, "id" | "qty"> {
  return {
    brandId: line.brandId,
    brandName,
    ticketLineId: line.id,
    ticketDisplayText: buildTicketDisplayText(line.ticketLabel, line.qualifierText),
    retailEach: line.retailPrice,
    cmaEach: line.cmaPrice
  };
}
