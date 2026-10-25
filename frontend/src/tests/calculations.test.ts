import { describe, it, expect } from 'vitest';
import {
  calculateTradeSizing,
  evaluatePyramidingEligibility,
  formatINR,
  formatShares,
} from '../services/calculations';

describe('Trading Calculations Service', () => {
  describe('calculateTradeSizing', () => {
    it('calculates exact 1% RPT from user capital', () => {
      const result = calculateTradeSizing({
        userCapital: 500000,
        referencePrice: 2000,
        twentyWeekSma: 1900,
      });

      expect(result.rpt).toBe(5000); // 500,000 * 0.01 = 5,000
    });

    it('calculates RPS as Entry Price - Stop-Loss', () => {
      const result = calculateTradeSizing({
        userCapital: 500000,
        referencePrice: 2000,
        twentyWeekSma: 1950,
      });

      expect(result.rps).toBe(50); // 2000 - 1950 = 50
    });

    it('calculates floor quantity when RPS is positive', () => {
      const result = calculateTradeSizing({
        userCapital: 500000, // RPT = 5000
        referencePrice: 2000,
        twentyWeekSma: 1930, // RPS = 70
      });

      // 5000 / 70 = 71.42857... -> floor = 71
      expect(result.quantity).toBe(71);
      expect(result.sizingStatus).toBe('VALID');
      expect(result.capitalRequired).toBe(71 * 2000);
    });

    it('enforces critical warning rule when Stop-Loss >= Entry Price (RPS <= 0)', () => {
      // Case 1: Stop-Loss exactly equals Entry Price (RPS = 0)
      const zeroRps = calculateTradeSizing({
        userCapital: 500000,
        referencePrice: 2000,
        twentyWeekSma: 2000,
      });

      expect(zeroRps.rps).toBe(0);
      expect(zeroRps.quantity).toBeNull();
      expect(zeroRps.sizingStatus).toBe('INVALID_RPS_WARNING');
      expect(zeroRps.warningMessage).toBeDefined();

      // Case 2: Stop-Loss is above Entry Price (RPS < 0)
      const negativeRps = calculateTradeSizing({
        userCapital: 500000,
        referencePrice: 2000,
        twentyWeekSma: 2050,
      });

      expect(negativeRps.rps).toBe(-50);
      expect(negativeRps.quantity).toBeNull();
      expect(negativeRps.sizingStatus).toBe('INVALID_RPS_WARNING');
      expect(negativeRps.warningMessage).toContain('Stop-Loss');
    });

    it('returns UNAVAILABLE when capital or prices are non-positive', () => {
      const zeroCapital = calculateTradeSizing({
        userCapital: 0,
        referencePrice: 2000,
        twentyWeekSma: 1900,
      });

      expect(zeroCapital.sizingStatus).toBe('UNAVAILABLE');
      expect(zeroCapital.quantity).toBeNull();
    });
  });

  describe('evaluatePyramidingEligibility', () => {
    it('strictly requires Weekly RSI > 60.0 (60.0 fails boundary)', () => {
      // Exactly 60.0 must FAIL
      const atBoundary = evaluatePyramidingEligibility(60.0, 100, 100);
      expect(atBoundary.rsiConditionMet).toBe(false);
      expect(atBoundary.isEligible).toBe(false);

      // 59.9 must FAIL
      const belowBoundary = evaluatePyramidingEligibility(59.9, 100, 100);
      expect(belowBoundary.rsiConditionMet).toBe(false);
      expect(belowBoundary.isEligible).toBe(false);

      // 60.1 must PASS
      const aboveBoundary = evaluatePyramidingEligibility(60.1, 100, 100);
      expect(aboveBoundary.rsiConditionMet).toBe(true);
      expect(aboveBoundary.isEligible).toBe(true);
    });

    it('checks inclusive SMA bounds [Previous Entry, Previous Entry + 3]', () => {
      const prevEntry = 1500.0;

      // Exactly at lower bound (SMA = prevEntry)
      const atLower = evaluatePyramidingEligibility(65.0, 1500.0, prevEntry);
      expect(atLower.smaConditionMet).toBe(true);
      expect(atLower.isEligible).toBe(true);

      // Exactly at upper bound (SMA = prevEntry + 3.0)
      const atUpper = evaluatePyramidingEligibility(65.0, 1503.0, prevEntry);
      expect(atUpper.smaConditionMet).toBe(true);
      expect(atUpper.isEligible).toBe(true);

      // Within bounds (SMA = prevEntry + 1.5)
      const inside = evaluatePyramidingEligibility(65.0, 1501.5, prevEntry);
      expect(inside.smaConditionMet).toBe(true);
      expect(inside.isEligible).toBe(true);

      // Below lower bound (SMA = 1499.9)
      const below = evaluatePyramidingEligibility(65.0, 1499.9, prevEntry);
      expect(below.smaConditionMet).toBe(false);
      expect(below.isEligible).toBe(false);

      // Above upper bound (SMA = 1503.1)
      const above = evaluatePyramidingEligibility(65.0, 1503.1, prevEntry);
      expect(above.smaConditionMet).toBe(false);
      expect(above.isEligible).toBe(false);
    });

    it('fails if either RSI or SMA fails', () => {
      // RSI passes, SMA fails
      const rsiOnly = evaluatePyramidingEligibility(65.0, 1600.0, 1500.0);
      expect(rsiOnly.rsiConditionMet).toBe(true);
      expect(rsiOnly.smaConditionMet).toBe(false);
      expect(rsiOnly.isEligible).toBe(false);

      // SMA passes, RSI fails
      const smaOnly = evaluatePyramidingEligibility(55.0, 1502.0, 1500.0);
      expect(smaOnly.rsiConditionMet).toBe(false);
      expect(smaOnly.smaConditionMet).toBe(true);
      expect(smaOnly.isEligible).toBe(false);
    });
  });

  describe('formatters', () => {
    it('formats INR correctly', () => {
      expect(formatINR(184520)).toContain('1,84,520');
      expect(formatINR(-5000)).toContain('-₹');
      expect(formatINR(null)).toBe('₹--');
    });

    it('formats shares with standard whole number format', () => {
      expect(formatShares(1420)).toBe('1,420');
      expect(formatShares(null)).toBe('--');
    });
  });
});
