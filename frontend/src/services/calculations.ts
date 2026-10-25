import type {
  PyramidingEligibilityCheck,
  TradeCalculationInputs,
  TradeCalculationResult,
  TradeEntry,
} from '../types/trading';

/**
 * Pure calculation functions for NSE Trading Copilot.
 * Strictly adheres to verified business rules in docs/architecture.md.
 */

/**
 * Calculates Risk Per Trade (RPT), Risk Per Share (RPS), and Position Quantity.
 * Formula:
 * - RPT = User Capital * 0.01 (1% risk)
 * - Entry Price = Current Reference Share Price
 * - Stop-Loss = 20-week SMA from the most recently completed weekly candle
 * - RPS = Entry Price - Stop-Loss
 * - Quantity = floor(RPT / RPS) only when RPS > 0
 * 
 * If Stop-Loss >= Entry Price (RPS <= 0), returns SizingStatus 'INVALID_RPS_WARNING'
 * with quantity = null. Never divides by zero or returns negative quantity.
 */
export function calculateTradeSizing(inputs: TradeCalculationInputs): TradeCalculationResult {
  const { userCapital, referencePrice, twentyWeekSma } = inputs;

  // Defensive input validation
  if (userCapital <= 0 || referencePrice <= 0 || twentyWeekSma <= 0) {
    return {
      rpt: 0,
      entryPrice: referencePrice,
      stopLoss: twentyWeekSma,
      rps: 0,
      quantity: null,
      sizingStatus: 'UNAVAILABLE',
      warningMessage: 'Capital, entry price, and 20-week SMA must be positive numbers.',
      capitalRequired: null,
    };
  }

  // 1% risk per trade rule
  const rpt = Number((userCapital * 0.01).toFixed(2));
  const entryPrice = referencePrice;
  const stopLoss = twentyWeekSma;
  const rps = Number((entryPrice - stopLoss).toFixed(2));

  // Critical Warning Rule: Stop-Loss >= Entry Price
  if (rps <= 0) {
    return {
      rpt,
      entryPrice,
      stopLoss,
      rps,
      quantity: null,
      sizingStatus: 'INVALID_RPS_WARNING',
      warningMessage: `Stop-Loss (₹${stopLoss.toFixed(2)}) is greater than or equal to Reference Entry Price (₹${entryPrice.toFixed(2)}). RPS is non-positive (₹${rps.toFixed(2)}). Valid quantity cannot be calculated.`,
      capitalRequired: null,
    };
  }

  // Valid sizing: floor(RPT / RPS)
  const quantity = Math.floor(rpt / rps);

  // Insufficient capital edge case: zero whole shares
  if (quantity <= 0) {
    return {
      rpt,
      entryPrice,
      stopLoss,
      rps,
      quantity: null,
      sizingStatus: 'UNAVAILABLE',
      warningMessage: `Insufficient capital: Risk Per Trade (₹${rpt.toFixed(2)}) is less than Risk Per Share (₹${rps.toFixed(2)}). Calculated quantity is 0 shares. Minimum position size is 1 whole share under the 1% risk rule.`,
      capitalRequired: null,
    };
  }

  const capitalRequired = Number((quantity * entryPrice).toFixed(2));

  return {
    rpt,
    entryPrice,
    stopLoss,
    rps,
    quantity,
    sizingStatus: 'VALID',
    capitalRequired,
  };
}

/**
 * Evaluates Pyramiding Eligibility for an active position:
 * 1. Weekly RSI > 60 (strictly greater than 60)
 * 2. Previous Entry Price <= Current 20-week SMA <= Previous Entry Price + 3
 * 
 * Both conditions must strictly be true.
 */
export function evaluatePyramidingEligibility(
  weeklyRsi: number,
  twentyWeekSma: number,
  previousEntryPrice: number
): PyramidingEligibilityCheck {
  const rsiConditionMet = weeklyRsi > 60.0;
  const lowerBound = previousEntryPrice;
  const upperBound = Number((previousEntryPrice + 3.0).toFixed(2));
  const smaConditionMet = twentyWeekSma >= lowerBound && twentyWeekSma <= upperBound;
  const isEligible = rsiConditionMet && smaConditionMet;

  const reasons: string[] = [];

  if (rsiConditionMet) {
    reasons.push(`Weekly RSI (${weeklyRsi.toFixed(1)}) is strictly > 60.0`);
  } else {
    reasons.push(`Weekly RSI (${weeklyRsi.toFixed(1)}) fails rule: must be strictly > 60.0`);
  }

  if (smaConditionMet) {
    reasons.push(
      `20-week SMA (₹${twentyWeekSma.toFixed(2)}) is within [₹${lowerBound.toFixed(2)}, ₹${upperBound.toFixed(2)}] (Prev Entry + ₹3.00)`
    );
  } else {
    if (twentyWeekSma < lowerBound) {
      reasons.push(
        `20-week SMA (₹${twentyWeekSma.toFixed(2)}) < Prev Entry (₹${lowerBound.toFixed(2)})`
      );
    } else {
      reasons.push(
        `20-week SMA (₹${twentyWeekSma.toFixed(2)}) > Prev Entry + 3 (₹${upperBound.toFixed(2)})`
      );
    }
  }

  return {
    weeklyRsi,
    twentyWeekSma,
    previousEntryPrice,
    rsiConditionMet,
    smaConditionMet,
    isEligible,
    reasons,
  };
}

/**
 * Calculates Entry-level Gross P&L:
 * Formula: (Exit Price - Entry Price) * Entry Quantity
 * If Quantity is null or unavailable, returns null (cannot be calculated).
 * No transaction costs included.
 */
export function calculateEntryPnl(
  entryPrice: number,
  exitPrice: number,
  quantity: number | null
): number | null {
  if (quantity === null || isNaN(quantity) || quantity < 0) {
    return null;
  }
  if (exitPrice <= 0 || isNaN(exitPrice)) {
    return null;
  }
  return Number(((exitPrice - entryPrice) * quantity).toFixed(2));
}

/**
 * Calculates Consolidated Position P&L across all entry rows:
 * - Applies one single exit to all accumulated entries.
 * - Entry P&L = (Exit Price - Entry Price) * Quantity.
 * - Total P&L = sum of valid entry P&L values.
 * - If any entry has null quantity, labels hasUnavailableQuantity = true.
 */
export function calculatePositionPnl(
  entries: TradeEntry[],
  exitPrice: number
): {
  entryPnls: (number | null)[];
  totalPnl: number | null;
  hasUnavailableQuantity: boolean;
} {
  let total = 0;

  const entryPnls = entries.map((entry) => {
    const pnl = calculateEntryPnl(entry.entryPrice, exitPrice, entry.quantity);
    if (pnl !== null) {
      total += pnl;
    }
    return pnl;
  });
  const hasUnavailableQuantity = entries.some((entry) => entry.quantity === null);
  const hasUnavailablePnl = entryPnls.some((pnl) => pnl === null);

  return {
    entryPnls,
    totalPnl: entries.length > 0 && !hasUnavailablePnl ? Number(total.toFixed(2)) : null,
    hasUnavailableQuantity,
  };
}

/**
 * Computes the total accumulated quantity of whole shares across entries.
 * Entries with null quantity are excluded from the valid count.
 */
export function calculateAccumulatedQuantity(entries: TradeEntry[]): number {
  return entries.reduce((acc, entry) => {
    return entry.quantity !== null && entry.quantity >= 0 ? acc + entry.quantity : acc;
  }, 0);
}

/**
 * Computes the total capital deployed across valid entries: sum(entryPrice * quantity).
 */
export function calculateTotalCapitalDeployed(entries: TradeEntry[]): number {
  const sum = entries.reduce((acc, entry) => {
    return entry.quantity !== null && entry.quantity >= 0
      ? acc + entry.entryPrice * entry.quantity
      : acc;
  }, 0);
  return Number(sum.toFixed(2));
}

/**
 * Computes weighted average entry price across valid entries.
 * Returns 0 if accumulated quantity is 0.
 */
export function calculateAverageEntryPrice(entries: TradeEntry[]): number {
  const totalQty = calculateAccumulatedQuantity(entries);
  if (totalQty <= 0) return 0;
  const totalCapital = calculateTotalCapitalDeployed(entries);
  return Number((totalCapital / totalQty).toFixed(2));
}

/**
 * Validates exit inputs:
 * - Exit price must be positive number (> 0)
 * - Exit date must be non-empty and valid string
 */
export function validateExitData(
  exitPrice: number,
  exitDate: string
): { isValid: boolean; error?: string } {
  if (isNaN(exitPrice) || exitPrice <= 0) {
    return {
      isValid: false,
      error: 'Exit price must be a positive number greater than 0.',
    };
  }
  if (!exitDate || exitDate.trim() === '') {
    return {
      isValid: false,
      error: 'Exit date is required.',
    };
  }
  const dateObj = new Date(exitDate);
  if (isNaN(dateObj.getTime())) {
    return {
      isValid: false,
      error: 'Exit date is not a valid date.',
    };
  }
  return { isValid: true };
}

/**
 * Formats a currency amount into standard Indian Rupee format (INR).
 * Example: 184520 -> "₹1,84,520.00"
 */
export function formatINR(amount: number | null | undefined, includeDecimals = true): string {
  if (amount === null || amount === undefined || isNaN(amount)) {
    return '₹--';
  }

  const isNegative = amount < 0;
  const absAmount = Math.abs(amount);
  
  const formatted = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: includeDecimals ? 2 : 0,
    maximumFractionDigits: includeDecimals ? 2 : 0,
  }).format(absAmount);

  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Formats whole share quantity with standard comma separation.
 */
export function formatShares(quantity: number | null | undefined): string {
  if (quantity === null || quantity === undefined || isNaN(quantity)) {
    return '--';
  }
  return new Intl.NumberFormat('en-IN').format(quantity);
}
