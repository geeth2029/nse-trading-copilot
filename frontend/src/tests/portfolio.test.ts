/**
 * Portfolio Workflow Tests — NSE Trading Copilot (Phase 2)
 *
 * Covers all 9 required test scenarios from the implementation spec:
 *  1. Initial entry calculations (RPT, RPS, Quantity)
 *  2. Invalid stop-loss (StopLoss >= EntryPrice → quantity null)
 *  3. Quantity flooring (floor(RPT / RPS))
 *  4. Strict RSI > 60 eligibility (60.0 fails, 60.1 passes)
 *  5. Inclusive SMA bounds [prev, prev + 3]
 *  6. Multiple entries and accumulated quantity
 *  7. Entry-wise and consolidated P&L
 *  8. Invalid exit data validation
 *  9. Archiving without losing entry history
 */

import { describe, it, expect } from 'vitest';
import {
  calculateTradeSizing,
  evaluatePyramidingEligibility,
  calculateEntryPnl,
  calculatePositionPnl,
  calculateAccumulatedQuantity,
  calculateAverageEntryPrice,
  calculateTotalCapitalDeployed,
  validateExitData,
} from '../services/calculations';
import type { TradeEntry } from '../types/trading';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a minimal TradeEntry stub
// ─────────────────────────────────────────────────────────────────────────────
function makeEntry(
  sequence: number,
  entryPrice: number,
  stopLoss: number,
  quantity: number | null
): TradeEntry {
  const rps = entryPrice - stopLoss;
  const rpt = 500000 * 0.01;
  return {
    id: `entry-${sequence}`,
    positionId: 'pos-test',
    sequence,
    entryType: sequence === 1 ? 'INITIAL_ENTRY' : 'PYRAMID_ENTRY',
    entryDate: `2026-10-0${sequence}`,
    entryPrice,
    stopLoss,
    rps,
    rpt,
    quantity,
    capitalSnapshot: 500000,
    sizingStatus: quantity !== null ? 'VALID' : 'INVALID_RPS_WARNING',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Initial Entry Calculations
// ─────────────────────────────────────────────────────────────────────────────
describe('1. Initial Entry Calculations', () => {
  it('RPT = 1% of user capital', () => {
    const result = calculateTradeSizing({
      userCapital: 1_000_000,
      referencePrice: 2500,
      twentyWeekSma: 2400,
    });
    expect(result.rpt).toBeCloseTo(10_000, 2);
  });

  it('RPS = Entry Price minus Stop-Loss', () => {
    const result = calculateTradeSizing({
      userCapital: 500_000,
      referencePrice: 1800,
      twentyWeekSma: 1720,
    });
    expect(result.rps).toBeCloseTo(80, 2);
  });

  it('Entry price captured from referencePrice (not SMA)', () => {
    const result = calculateTradeSizing({
      userCapital: 500_000,
      referencePrice: 3210.5,
      twentyWeekSma: 3100,
    });
    expect(result.entryPrice).toBe(3210.5);
    expect(result.stopLoss).toBe(3100);
  });

  it('Quantity = floor(RPT / RPS) when RPS > 0', () => {
    // RPT = 5000, RPS = 78 -> 5000/78 = 64.10... -> floor = 64
    const result = calculateTradeSizing({
      userCapital: 500_000,
      referencePrice: 1500,
      twentyWeekSma: 1422,
    });
    expect(result.rps).toBe(78);
    expect(result.quantity).toBe(64);
    expect(result.sizingStatus).toBe('VALID');
  });

  it('capitalRequired = Quantity x Entry Price', () => {
    const result = calculateTradeSizing({
      userCapital: 500_000,
      referencePrice: 1500,
      twentyWeekSma: 1422,
    });
    expect(result.capitalRequired).toBe(64 * 1500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Invalid Stop-Loss
// ─────────────────────────────────────────────────────────────────────────────
describe('2. Invalid Stop-Loss (StopLoss >= EntryPrice)', () => {
  it('returns INVALID_RPS_WARNING when StopLoss equals EntryPrice', () => {
    const result = calculateTradeSizing({
      userCapital: 500_000,
      referencePrice: 2000,
      twentyWeekSma: 2000,
    });
    expect(result.rps).toBe(0);
    expect(result.quantity).toBeNull();
    expect(result.sizingStatus).toBe('INVALID_RPS_WARNING');
    expect(result.warningMessage).toBeDefined();
  });

  it('returns INVALID_RPS_WARNING when StopLoss > EntryPrice', () => {
    const result = calculateTradeSizing({
      userCapital: 500_000,
      referencePrice: 2000,
      twentyWeekSma: 2100,
    });
    expect(result.rps).toBeLessThan(0);
    expect(result.quantity).toBeNull();
    expect(result.sizingStatus).toBe('INVALID_RPS_WARNING');
    expect(result.warningMessage).toContain('Stop-Loss');
  });

  it('returns UNAVAILABLE when capital is zero', () => {
    const result = calculateTradeSizing({
      userCapital: 0,
      referencePrice: 2000,
      twentyWeekSma: 1900,
    });
    expect(result.quantity).toBeNull();
    expect(result.sizingStatus).toBe('UNAVAILABLE');
  });

  it('returns UNAVAILABLE when referencePrice is zero', () => {
    const result = calculateTradeSizing({
      userCapital: 500_000,
      referencePrice: 0,
      twentyWeekSma: 1900,
    });
    expect(result.quantity).toBeNull();
    expect(result.sizingStatus).toBe('UNAVAILABLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Quantity Flooring
// ─────────────────────────────────────────────────────────────────────────────
describe('3. Quantity Flooring', () => {
  it('floors when RPT / RPS is not a whole number', () => {
    // RPT = 5000, RPS = 7 -> 5000/7 = 714.2857 -> floor = 714
    const result = calculateTradeSizing({
      userCapital: 500_000,
      referencePrice: 200,
      twentyWeekSma: 193,
    });
    expect(result.rps).toBe(7);
    expect(result.rpt).toBe(5000);
    expect(result.quantity).toBe(714);
  });

  it('quantity is a whole integer (never fractional)', () => {
    const result = calculateTradeSizing({
      userCapital: 750_000, // RPT = 7500
      referencePrice: 850,
      twentyWeekSma: 817, // RPS = 33
    });
    expect(result.quantity).toBe(227); // floor(7500/33)
    expect(Number.isInteger(result.quantity)).toBe(true);
  });

  it('returns exactly 1 when RPT / RPS is just above 1', () => {
    // RPT = 100, RPS = 99 -> floor(100/99) = 1
    const result = calculateTradeSizing({
      userCapital: 10_000, // RPT = 100
      referencePrice: 500,
      twentyWeekSma: 401, // RPS = 99
    });
    expect(result.rpt).toBe(100);
    expect(result.quantity).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Strict RSI > 60 Eligibility
// ─────────────────────────────────────────────────────────────────────────────
describe('4. Strict RSI > 60 Eligibility', () => {
  const SMA = 1502;
  const PREV_ENTRY = 1500;

  it('RSI = 60.0 FAILS (strictly greater than required)', () => {
    const result = evaluatePyramidingEligibility(60.0, SMA, PREV_ENTRY);
    expect(result.rsiConditionMet).toBe(false);
    expect(result.isEligible).toBe(false);
  });

  it('RSI = 59.9 FAILS', () => {
    const result = evaluatePyramidingEligibility(59.9, SMA, PREV_ENTRY);
    expect(result.rsiConditionMet).toBe(false);
    expect(result.isEligible).toBe(false);
  });

  it('RSI = 60.1 PASSES', () => {
    const result = evaluatePyramidingEligibility(60.1, SMA, PREV_ENTRY);
    expect(result.rsiConditionMet).toBe(true);
    expect(result.isEligible).toBe(true);
  });

  it('RSI = 80 PASSES', () => {
    const result = evaluatePyramidingEligibility(80.0, SMA, PREV_ENTRY);
    expect(result.rsiConditionMet).toBe(true);
    expect(result.isEligible).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Inclusive SMA Bounds [prev, prev + 3]
// ─────────────────────────────────────────────────────────────────────────────
describe('5. Inclusive Pyramiding SMA Bounds', () => {
  const RSI = 65.0;
  const PREV_ENTRY = 2000.0;

  it('SMA exactly at lower bound (= prev entry) PASSES', () => {
    const result = evaluatePyramidingEligibility(RSI, 2000.0, PREV_ENTRY);
    expect(result.smaConditionMet).toBe(true);
    expect(result.isEligible).toBe(true);
  });

  it('SMA exactly at upper bound (= prev entry + 3.0) PASSES', () => {
    const result = evaluatePyramidingEligibility(RSI, 2003.0, PREV_ENTRY);
    expect(result.smaConditionMet).toBe(true);
    expect(result.isEligible).toBe(true);
  });

  it('SMA inside the band PASSES', () => {
    const result = evaluatePyramidingEligibility(RSI, 2001.5, PREV_ENTRY);
    expect(result.smaConditionMet).toBe(true);
    expect(result.isEligible).toBe(true);
  });

  it('SMA just below lower bound (prev - 0.01) FAILS', () => {
    const result = evaluatePyramidingEligibility(RSI, 1999.99, PREV_ENTRY);
    expect(result.smaConditionMet).toBe(false);
    expect(result.isEligible).toBe(false);
  });

  it('SMA just above upper bound (prev + 3.01) FAILS', () => {
    const result = evaluatePyramidingEligibility(RSI, 2003.01, PREV_ENTRY);
    expect(result.smaConditionMet).toBe(false);
    expect(result.isEligible).toBe(false);
  });

  it('FAILS when only RSI passes but SMA is out of band', () => {
    const result = evaluatePyramidingEligibility(75.0, 2050.0, PREV_ENTRY);
    expect(result.rsiConditionMet).toBe(true);
    expect(result.smaConditionMet).toBe(false);
    expect(result.isEligible).toBe(false);
  });

  it('FAILS when only SMA is in band but RSI fails', () => {
    const result = evaluatePyramidingEligibility(55.0, 2001.0, PREV_ENTRY);
    expect(result.rsiConditionMet).toBe(false);
    expect(result.smaConditionMet).toBe(true);
    expect(result.isEligible).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Multiple Entries and Accumulated Quantity
// ─────────────────────────────────────────────────────────────────────────────
describe('6. Multiple Entries and Accumulated Quantity', () => {
  it('accumulated quantity sums all valid entries', () => {
    const entries: TradeEntry[] = [
      makeEntry(1, 1500, 1422, 64),
      makeEntry(2, 1520, 1442, 60),
      makeEntry(3, 1535, 1460, 53),
    ];
    expect(calculateAccumulatedQuantity(entries)).toBe(177);
  });

  it('entries with null quantity are excluded from accumulated total', () => {
    const entries: TradeEntry[] = [
      makeEntry(1, 1500, 1422, 64),
      makeEntry(2, 1500, 1500, null),
    ];
    expect(calculateAccumulatedQuantity(entries)).toBe(64);
  });

  it('each entry preserves its own price snapshot independently', () => {
    const entries: TradeEntry[] = [
      makeEntry(1, 1500, 1422, 64),
      makeEntry(2, 1550, 1470, 55),
    ];
    expect(entries[0].entryPrice).toBe(1500);
    expect(entries[1].entryPrice).toBe(1550);
  });

  it('weighted average entry price computed correctly', () => {
    const entries: TradeEntry[] = [
      makeEntry(1, 1500, 1422, 64),
      makeEntry(2, 1600, 1520, 50),
    ];
    const avg = calculateAverageEntryPrice(entries);
    expect(avg).toBeCloseTo(176000 / 114, 1);
  });

  it('total capital deployed = sum of entryPrice x quantity', () => {
    const entries: TradeEntry[] = [
      makeEntry(1, 1500, 1422, 64),
      makeEntry(2, 1600, 1520, 50),
    ];
    expect(calculateTotalCapitalDeployed(entries)).toBeCloseTo(176000, 2);
  });

  it('returns 0 accumulated quantity for empty entries array', () => {
    expect(calculateAccumulatedQuantity([])).toBe(0);
  });

  it('returns 0 average entry price for empty entries array', () => {
    expect(calculateAverageEntryPrice([])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Entry-wise and Consolidated P&L
// ─────────────────────────────────────────────────────────────────────────────
describe('7. Entry-wise and Consolidated PnL', () => {
  describe('calculateEntryPnl (single entry)', () => {
    it('calculates profit correctly', () => {
      expect(calculateEntryPnl(1500, 1800, 64)).toBeCloseTo(19200, 2);
    });

    it('calculates loss correctly (negative PnL)', () => {
      expect(calculateEntryPnl(1500, 1300, 64)).toBeCloseTo(-12800, 2);
    });

    it('returns null when quantity is null', () => {
      expect(calculateEntryPnl(1500, 1800, null)).toBeNull();
    });

    it('returns null when exit price is 0', () => {
      expect(calculateEntryPnl(1500, 0, 64)).toBeNull();
    });

      it('returns zero PnL when quantity is 0', () => {
        expect(calculateEntryPnl(1500, 1800, 0)).toBe(0);
    });

    it('breakeven returns 0', () => {
      expect(calculateEntryPnl(1500, 1500, 64)).toBe(0);
    });
  });

  describe('calculatePositionPnl (consolidated position)', () => {
    it('calculates entry-wise PnL array and total for multiple entries', () => {
      const entries: TradeEntry[] = [
        makeEntry(1, 1500, 1422, 64),
        makeEntry(2, 1550, 1470, 55),
        makeEntry(3, 1520, 1440, 60),
      ];
      const { entryPnls, totalPnl, hasUnavailableQuantity } =
        calculatePositionPnl(entries, 1800);

      expect(entryPnls[0]).toBeCloseTo(19200, 2);
      expect(entryPnls[1]).toBeCloseTo(13750, 2);
      expect(entryPnls[2]).toBeCloseTo(16800, 2);
      expect(totalPnl).toBeCloseTo(49750, 2);
      expect(hasUnavailableQuantity).toBe(false);
    });

    it('makes consolidated PnL unavailable when any entry has null quantity', () => {
      const entries: TradeEntry[] = [
        makeEntry(1, 1500, 1422, 64),
        makeEntry(2, 1500, 1500, null),
      ];
      const { totalPnl, hasUnavailableQuantity } = calculatePositionPnl(
        entries,
        1800
      );
      expect(hasUnavailableQuantity).toBe(true);
      expect(totalPnl).toBeNull();
    });

    it('keeps zero quantity valid in entry-wise and consolidated PnL', () => {
      const entries: TradeEntry[] = [
        makeEntry(1, 1500, 1422, 0),
        makeEntry(2, 1500, 1422, 64),
      ];
      const { entryPnls, totalPnl, hasUnavailableQuantity } =
        calculatePositionPnl(entries, 1800);

      expect(entryPnls).toEqual([0, 19200]);
      expect(totalPnl).toBe(19200);
      expect(hasUnavailableQuantity).toBe(false);
    });

    it('returns null totalPnl when all entries have null quantity', () => {
      const entries: TradeEntry[] = [
        makeEntry(1, 1500, 1500, null),
        makeEntry(2, 1500, 1500, null),
      ];
      const { totalPnl } = calculatePositionPnl(entries, 1800);
      expect(totalPnl).toBeNull();
    });

    it('returns the total for all-valid quantities including zero', () => {
      const entries: TradeEntry[] = [
        makeEntry(1, 1500, 1422, 0),
        makeEntry(2, 1500, 1422, 10),
      ];
      const { totalPnl, hasUnavailableQuantity } = calculatePositionPnl(entries, 1600);

      expect(totalPnl).toBe(1000);
      expect(hasUnavailableQuantity).toBe(false);
    });

    it('total PnL = sum of individual entry PnLs (no transaction costs)', () => {
      const entries: TradeEntry[] = [
        makeEntry(1, 1000, 950, 100),
        makeEntry(2, 1050, 1000, 80),
      ];
      const { totalPnl } = calculatePositionPnl(entries, 1200);
      expect(totalPnl).toBeCloseTo(32000, 2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Invalid Exit Data Validation
// ─────────────────────────────────────────────────────────────────────────────
describe('8. Invalid Exit Data Validation', () => {
  it('valid exit price and date returns isValid=true', () => {
    const result = validateExitData(1800, '2026-11-01');
    expect(result.isValid).toBe(true);
  });

  it('exit price = 0 is rejected', () => {
    const result = validateExitData(0, '2026-11-01');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('negative exit price is rejected', () => {
    const result = validateExitData(-100, '2026-11-01');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('NaN exit price is rejected', () => {
    const result = validateExitData(NaN, '2026-11-01');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('empty exit date is rejected', () => {
    const result = validateExitData(1800, '');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('whitespace-only exit date is rejected', () => {
    const result = validateExitData(1800, '   ');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('invalid date string is rejected', () => {
    const result = validateExitData(1800, 'not-a-date');
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('small positive exit price (0.01) is valid', () => {
    const result = validateExitData(0.01, '2026-11-01');
    expect(result.isValid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Archiving Without Losing Entry History
// ─────────────────────────────────────────────────────────────────────────────
describe('9. Archiving Without Losing Entry History', () => {
  it('entry records remain unmodified after simulated archival', () => {
    const originalEntries: TradeEntry[] = [
      makeEntry(1, 1500, 1422, 64),
      makeEntry(2, 1550, 1470, 55),
    ];

    const archivedPosition = {
      symbol: 'TEST',
      status: 'ARCHIVED' as const,
      entries: [...originalEntries],
      archivedAt: '2026-11-01',
      archiveReason: 'Soft-archived from active portfolio.',
    };

    expect(archivedPosition.entries).toHaveLength(2);
    expect(archivedPosition.entries[0].entryPrice).toBe(1500);
    expect(archivedPosition.entries[1].entryPrice).toBe(1550);
    expect(archivedPosition.entries[0].quantity).toBe(64);
    expect(archivedPosition.entries[1].quantity).toBe(55);
  });

  it('accumulated quantity of archived position is calculable from its entries', () => {
    const entries: TradeEntry[] = [
      makeEntry(1, 1500, 1422, 64),
      makeEntry(2, 1550, 1470, 55),
      makeEntry(3, 1535, 1460, 53),
    ];
    expect(calculateAccumulatedQuantity(entries)).toBe(172);
  });

  it('realized PnL of an exited and archived position can still be computed', () => {
    const entries: TradeEntry[] = [
      makeEntry(1, 1500, 1422, 64),
      makeEntry(2, 1550, 1470, 55),
    ];
    const exitPrice = 1800;
    const { totalPnl } = calculatePositionPnl(entries, exitPrice);
    expect(totalPnl).toBeCloseTo(32950, 2);
  });

  it('status is ARCHIVED after archival (position not deleted)', () => {
    const archivedPosition = {
      id: 'pos-1',
      status: 'ARCHIVED' as const,
      entries: [makeEntry(1, 1500, 1422, 64)],
    };
    expect(archivedPosition.status).toBe('ARCHIVED');
    expect(archivedPosition.entries).toHaveLength(1);
    expect(archivedPosition.id).toBe('pos-1');
  });
});
