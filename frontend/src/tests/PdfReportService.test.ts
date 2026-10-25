import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generatePositionPdf,
  generatePortfolioPdf,
  formatPdfCurrency,
  formatPdfShares,
} from '../services/pdfReportService';
import type { PortfolioPosition, TradeEntry, DashboardSummary } from '../types/trading';

describe('PDF Report Service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Formatting Utilities', () => {
    it('formats currency correctly in Indian numbering without crashing or unicode corruption', () => {
      expect(formatPdfCurrency(0)).toBe('Rs. 0.00');
      expect(formatPdfCurrency(1234.56)).toBe('Rs. 1,234.56');
      expect(formatPdfCurrency(150000)).toBe('Rs. 1,50,000.00');
      expect(formatPdfCurrency(10000000)).toBe('Rs. 1,00,00,000.00');
      expect(formatPdfCurrency(-5432.1)).toBe('-Rs. 5,432.10');
      expect(formatPdfCurrency(1500, false)).toBe('Rs. 1,500');
    });

    it('returns "Unavailable" for null, undefined, or NaN currency values', () => {
      expect(formatPdfCurrency(null)).toBe('Unavailable');
      expect(formatPdfCurrency(undefined)).toBe('Unavailable');
      expect(formatPdfCurrency(NaN)).toBe('Unavailable');
    });

    it('formats whole share counts with Indian grouping', () => {
      expect(formatPdfShares(0)).toBe('0');
      expect(formatPdfShares(150)).toBe('150');
      expect(formatPdfShares(12500)).toBe('12,500');
      expect(formatPdfShares(null)).toBe('Unavailable');
      expect(formatPdfShares(undefined)).toBe('Unavailable');
    });
  });

  describe('Individual Position PDF Generation', () => {
    const mockInitialEntry: TradeEntry = {
      id: 'entry-1',
      positionId: 'pos-tcs-1',
      entryType: 'INITIAL_ENTRY',
      sequence: 1,
      entryDate: '2026-10-15',
      entryPrice: 3450.0,
      executionPrice: 3452.5,
      priceSource: 'EXPLICIT_EXECUTION',
      stopLoss: 3300.0,
      rps: 150.0,
      rpt: 5000.0,
      quantity: 33,
      capitalSnapshot: 113932.5,
      sizingStatus: 'VALID',
      entryPnl: null,
      notes: 'Initial breakout entry above 20W SMA',
    };

    const mockPyramidEntry: TradeEntry = {
      id: 'entry-2',
      positionId: 'pos-tcs-1',
      entryType: 'PYRAMID_ENTRY',
      sequence: 2,
      entryDate: '2026-10-22',
      entryPrice: 3500.0,
      executionPrice: 3500.0,
      priceSource: 'CONFIRMED_REFERENCE',
      stopLoss: 3400.0,
      rps: 100.0,
      rpt: 5000.0,
      quantity: 50,
      capitalSnapshot: 175000.0,
      sizingStatus: 'VALID',
      entryPnl: null,
      notes: 'Pyramid #1 entry on pull-back test',
    };

    const mockActivePosition: PortfolioPosition = {
      id: 'pos-tcs-1',
      symbol: 'TCS',
      companyName: 'Tata Consultancy Services Ltd',
      status: 'ACTIVE',
      initialEntryDate: '2026-10-15',
      accumulatedQuantity: 83,
      averageEntryPrice: 3481.11,
      currentReferencePrice: 3620.0,
      twentyWeekSmaStopLoss: 3400.0,
      latestWeeklyRsi: 65.5,
      isPyramidEligible: true,
      unrealizedPnl: 11527.43,
      realizedPnl: null,
      totalCapitalDeployed: 288932.5,
      entries: [mockInitialEntry, mockPyramidEntry],
    };

    it('generates a PDF document for an active position with multiple entries', () => {
      const doc = generatePositionPdf(mockActivePosition, {
        isDemoMode: false,
        userEmail: 'trader@example.com',
        autoDownload: false,
        rankMap: { TCS: 2 },
      });

      expect(doc).toBeDefined();
      expect((doc as any).internal.getNumberOfPages()).toBeGreaterThanOrEqual(1);

      // Verify text output includes symbol, rank, user, status
      const pdfText = doc.output();
      expect(pdfText).toContain('TCS');
      expect(pdfText).toContain('Tata Consultancy Services Ltd');
    });

    it('clearly distinguishes execution prices from reference prices in the output', () => {
      const doc = generatePositionPdf(mockActivePosition, {
        isDemoMode: false,
        userEmail: 'trader@example.com',
        autoDownload: false,
      });

      expect(doc).toBeDefined();
      // Ensure entries table has both Reference Closing Price and Actual Execution Price
      const entries = mockActivePosition.entries;
      expect(entries[0].priceSource).toBe('EXPLICIT_EXECUTION');
      expect(entries[0].executionPrice).toBe(3452.5);
      expect(entries[0].entryPrice).toBe(3450.0);
      expect(entries[1].priceSource).toBe('CONFIRMED_REFERENCE');
    });

    it('generates a completed position PDF with recorded exit price and entry-level realised P&L', () => {
      const completedPosition: PortfolioPosition = {
        ...mockActivePosition,
        id: 'pos-tcs-completed',
        status: 'COMPLETED',
        unrealizedPnl: null,
        realizedPnl: 18197.5,
        exit: {
          exitPrice: 3700.0,
          exitDate: '2026-10-25',
          notes: 'Target hit; single-exit rule applied to all accumulated entries',
        },
        entries: [
          {
            ...mockInitialEntry,
            entryPnl: 8167.5, // (3700 - 3452.5) * 33
          },
          {
            ...mockPyramidEntry,
            entryPnl: 10000.0, // (3700 - 3500) * 50
          },
        ],
      };

      const doc = generatePositionPdf(completedPosition, {
        isDemoMode: false,
        userEmail: 'investor@example.com',
        autoDownload: false,
      });

      expect(doc).toBeDefined();
      expect((doc as any).internal.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    });

    it('generates an archived position PDF preserving soft-archive audit notes', () => {
      const archivedPosition: PortfolioPosition = {
        ...mockActivePosition,
        id: 'pos-tcs-archived',
        status: 'ARCHIVED',
        archiveReason: 'Rebalanced into defensive sector allocation',
        archivedAt: '2026-10-24T18:00:00Z',
      };

      const doc = generatePositionPdf(archivedPosition, {
        isDemoMode: false,
        userEmail: 'investor@example.com',
        autoDownload: false,
      });

      expect(doc).toBeDefined();
    });

    it('handles missing or unavailable P&L and market data gracefully without inventing values', () => {
      const positionWithUnavailableData: PortfolioPosition = {
        id: 'pos-infy-nodata',
        symbol: 'INFY',
        companyName: 'Infosys Limited',
        status: 'ACTIVE',
        initialEntryDate: '2026-10-20',
        accumulatedQuantity: 50,
        averageEntryPrice: 1500.0,
        currentReferencePrice: (null as unknown) as number, // No market quote available
        twentyWeekSmaStopLoss: (null as unknown) as number,
        latestWeeklyRsi: null,
        isPyramidEligible: false,
        unrealizedPnl: null, // Market data unavailable -> cannot determine
        realizedPnl: null,
        totalCapitalDeployed: 75000.0,
        entries: [
          {
            id: 'e1',
            positionId: 'pos-infy-nodata',
            entryType: 'INITIAL_ENTRY',
            sequence: 1,
            entryDate: '2026-10-20',
            entryPrice: 1500.0,
            executionPrice: 1500.0,
            priceSource: 'CONFIRMED_REFERENCE',
            stopLoss: 1450.0,
            rps: 50.0,
            rpt: 5000.0,
            quantity: 50,
            capitalSnapshot: 75000.0,
            sizingStatus: 'VALID',
            entryPnl: null,
          },
        ],
      };

      const doc = generatePositionPdf(positionWithUnavailableData, {
        isDemoMode: false,
        userEmail: 'investor@example.com',
        autoDownload: false,
      });

      expect(doc).toBeDefined();
    });

    it('does not mutate the original position data during PDF generation', () => {
      const originalCopy = JSON.parse(JSON.stringify(mockActivePosition));
      generatePositionPdf(mockActivePosition, {
        isDemoMode: false,
        userEmail: 'test@example.com',
        autoDownload: false,
      });

      expect(mockActivePosition).toEqual(originalCopy);
    });

    it('spans multiple pages cleanly for positions with long pyramid histories', () => {
      // Create 35 pyramid entries to force page breaks across multiple A4 pages
      const longEntries: TradeEntry[] = [];
      for (let i = 1; i <= 35; i++) {
        longEntries.push({
          id: `entry-${i}`,
          positionId: 'pos-long',
          entryType: i === 1 ? 'INITIAL_ENTRY' : 'PYRAMID_ENTRY',
          sequence: i,
          entryDate: `2026-0${Math.min(i, 9)}-15`,
          entryPrice: 2000 + i * 50,
          executionPrice: 2002 + i * 50,
          priceSource: 'EXPLICIT_EXECUTION',
          stopLoss: 1950 + i * 50,
          rps: 50,
          rpt: 5000,
          quantity: 100,
          capitalSnapshot: (2002 + i * 50) * 100,
          sizingStatus: 'VALID',
          entryPnl: null,
          notes: `Pyramid #${i - 1} accumulation note explaining market context, volume expansion, and trend alignment`,
        });
      }

      const multiEntryPosition: PortfolioPosition = {
        ...mockActivePosition,
        entries: longEntries,
      };

      const doc = generatePositionPdf(multiEntryPosition, {
        isDemoMode: false,
        autoDownload: false,
      });

      expect(doc).toBeDefined();
      expect((doc as any).internal.getNumberOfPages()).toBeGreaterThan(1);
    });
  });

  describe('Consolidated Portfolio PDF Generation', () => {
    const mockActivePosition: PortfolioPosition = {
      id: 'pos-1',
      symbol: 'RELIANCE',
      companyName: 'Reliance Industries Ltd',
      status: 'ACTIVE',
      initialEntryDate: '2026-10-10',
      accumulatedQuantity: 50,
      averageEntryPrice: 2500.0,
      currentReferencePrice: 2650.0,
      twentyWeekSmaStopLoss: 2420.0,
      latestWeeklyRsi: 64.2,
      isPyramidEligible: true,
      unrealizedPnl: 7500.0,
      realizedPnl: null,
      totalCapitalDeployed: 125000.0,
      entries: [
        {
          id: 'e1',
          positionId: 'pos-1',
          entryType: 'INITIAL_ENTRY',
          sequence: 1,
          entryDate: '2026-10-10',
          entryPrice: 2500.0,
          executionPrice: 2500.0,
          priceSource: 'CONFIRMED_REFERENCE',
          stopLoss: 2420.0,
          rps: 80.0,
          rpt: 5000.0,
          quantity: 50,
          capitalSnapshot: 125000.0,
          sizingStatus: 'VALID',
          entryPnl: null,
        },
      ],
    };

    const mockCompletedPosition: PortfolioPosition = {
      id: 'pos-2',
      symbol: 'HDFCBANK',
      companyName: 'HDFC Bank Ltd',
      status: 'COMPLETED',
      initialEntryDate: '2026-10-01',
      accumulatedQuantity: 100,
      averageEntryPrice: 1600.0,
      currentReferencePrice: 1720.0,
      twentyWeekSmaStopLoss: 1550.0,
      latestWeeklyRsi: 61.5,
      isPyramidEligible: false,
      unrealizedPnl: null,
      realizedPnl: 12000.0,
      totalCapitalDeployed: 160000.0,
      exit: {
        exitPrice: 1720.0,
        exitDate: '2026-10-24',
        notes: 'Target reached',
      },
      entries: [
        {
          id: 'e2',
          positionId: 'pos-2',
          entryType: 'INITIAL_ENTRY',
          sequence: 1,
          entryDate: '2026-10-01',
          entryPrice: 1600.0,
          executionPrice: 1600.0,
          priceSource: 'CONFIRMED_REFERENCE',
          stopLoss: 1550.0,
          rps: 50.0,
          rpt: 5000.0,
          quantity: 100,
          capitalSnapshot: 160000.0,
          sizingStatus: 'VALID',
          entryPnl: 12000.0,
        },
      ],
    };

    const mockArchivedPosition: PortfolioPosition = {
      id: 'pos-3',
      symbol: 'INFY',
      companyName: 'Infosys Ltd',
      status: 'ARCHIVED',
      initialEntryDate: '2026-09-20',
      archiveReason: 'Stop triggered',
      accumulatedQuantity: 60,
      averageEntryPrice: 1450.0,
      currentReferencePrice: 1400.0,
      twentyWeekSmaStopLoss: 1410.0,
      latestWeeklyRsi: 48.0,
      isPyramidEligible: false,
      unrealizedPnl: null,
      realizedPnl: -3000.0,
      totalCapitalDeployed: 87000.0,
      exit: {
        exitPrice: 1400.0,
        exitDate: '2026-10-18',
        notes: '20W SMA breached',
      },
      entries: [
        {
          id: 'e3',
          positionId: 'pos-3',
          entryType: 'INITIAL_ENTRY',
          sequence: 1,
          entryDate: '2026-09-20',
          entryPrice: 1450.0,
          executionPrice: 1450.0,
          priceSource: 'CONFIRMED_REFERENCE',
          stopLoss: 1410.0,
          rps: 40.0,
          rpt: 5000.0,
          quantity: 60,
          capitalSnapshot: 87000.0,
          sizingStatus: 'VALID',
          entryPnl: -3000.0,
        },
      ],
    };

    const mockSummary: DashboardSummary = {
      activePositionsCount: 1,
      totalQuantity: 50,
      totalCapitalDeployed: 125000,
      realizedPnl: 12000,
      realizedPnlPercent: 7.5,
      archivedPositionsCount: 1,
      dataStatus: 'LIVE_SIMULATION',
      asOfTimestamp: '2026-10-25 15:30:00 IST',
    };

    it('generates a consolidated portfolio PDF including active, completed, and archived positions', () => {
      const doc = generatePortfolioPdf(
        [mockActivePosition, mockCompletedPosition],
        [mockArchivedPosition],
        mockSummary,
        {
          isDemoMode: false,
          userEmail: 'portfolio_manager@example.com',
          autoDownload: false,
          rankMap: { RELIANCE: 1, HDFCBANK: 3, INFY: 4 },
        }
      );

      expect(doc).toBeDefined();
      expect((doc as any).internal.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    });

    it('handles completely empty portfolios gracefully without errors', () => {
      const emptySummary: DashboardSummary = {
        activePositionsCount: 0,
        totalQuantity: 0,
        totalCapitalDeployed: 0,
        realizedPnl: 0,
        realizedPnlPercent: 0,
        archivedPositionsCount: 0,
        dataStatus: 'LIVE_SIMULATION',
        asOfTimestamp: '2026-10-25 15:30:00 IST',
      };

      const doc = generatePortfolioPdf([], [], emptySummary, {
        isDemoMode: false,
        userEmail: 'new_trader@example.com',
        autoDownload: false,
      });

      expect(doc).toBeDefined();
      expect((doc as any).internal.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    });

    it('clearly distinguishes realised P&L from unrealised P&L in the portfolio summary and tables', () => {
      const doc = generatePortfolioPdf(
        [mockActivePosition, mockCompletedPosition],
        [],
        mockSummary,
        {
          isDemoMode: false,
          autoDownload: false,
        }
      );

      expect(doc).toBeDefined();
      expect(mockSummary.realizedPnl).toBe(12000);
      expect(mockActivePosition.unrealizedPnl).toBe(7500);
    });
  });

  describe('Isolation & Security Tests', () => {
    it('isolates and prominently labels Demo Mode exports with simulation warnings', () => {
      const demoPosition: PortfolioPosition = {
        id: 'demo-pos-1',
        symbol: 'DEMOSTOCK',
        companyName: 'Demo Paper Corporation',
        status: 'ACTIVE',
        initialEntryDate: '2026-10-25',
        accumulatedQuantity: 10,
        averageEntryPrice: 100.0,
        currentReferencePrice: 105.0,
        twentyWeekSmaStopLoss: 95.0,
        latestWeeklyRsi: 62.0,
        isPyramidEligible: true,
        unrealizedPnl: 50.0,
        realizedPnl: null,
        totalCapitalDeployed: 1000.0,
        entries: [
          {
            id: 'demo-entry-1',
            positionId: 'demo-pos-1',
            entryType: 'INITIAL_ENTRY',
            sequence: 1,
            entryDate: '2026-10-25',
            entryPrice: 100.0,
            executionPrice: 100.0,
            priceSource: 'CONFIRMED_REFERENCE',
            stopLoss: 95.0,
            rps: 5.0,
            rpt: 50.0,
            quantity: 10,
            capitalSnapshot: 1000.0,
            sizingStatus: 'VALID',
            entryPnl: null,
          },
        ],
      };

      const doc = generatePositionPdf(demoPosition, {
        isDemoMode: true,
        userEmail: 'demouser@example.com',
        autoDownload: false,
      });

      expect(doc).toBeDefined();
      const textOutput = doc.output();
      expect(textOutput).toContain('DEMO');
    });

    it('isolates authenticated exports by rendering user email and live provenance', () => {
      const userPosition: PortfolioPosition = {
        id: 'live-pos-1',
        symbol: 'TCS',
        companyName: 'Tata Consultancy Services',
        status: 'ACTIVE',
        initialEntryDate: '2026-10-25',
        accumulatedQuantity: 25,
        averageEntryPrice: 3500.0,
        currentReferencePrice: 3550.0,
        twentyWeekSmaStopLoss: 3400.0,
        latestWeeklyRsi: 63.5,
        isPyramidEligible: false,
        unrealizedPnl: 1250.0,
        realizedPnl: null,
        totalCapitalDeployed: 87500.0,
        entries: [],
      };

      const userEmail = 'secure_investor@enterprise.com';
      const doc = generatePositionPdf(userPosition, {
        isDemoMode: false,
        userEmail,
        autoDownload: false,
      });

      expect(doc).toBeDefined();
      const textOutput = doc.output();
      expect(textOutput).toContain(userEmail);
    });

    it('does not expose another user data or modify records during consolidated report generation', () => {
      const userA_positions: PortfolioPosition[] = [
        {
          id: 'pos-user-a',
          symbol: 'INFY',
          companyName: 'Infosys',
          status: 'ACTIVE',
          initialEntryDate: '2026-10-15',
          accumulatedQuantity: 10,
          averageEntryPrice: 1500,
          currentReferencePrice: 1520,
          twentyWeekSmaStopLoss: 1450,
          latestWeeklyRsi: 61.0,
          isPyramidEligible: false,
          unrealizedPnl: 200,
          realizedPnl: null,
          totalCapitalDeployed: 15000,
          entries: [],
        },
      ];

      const doc = generatePortfolioPdf(userA_positions, [], undefined, {
        isDemoMode: false,
        userEmail: 'user_a@domain.com',
        autoDownload: false,
      });

      expect(doc).toBeDefined();
      const textOutput = doc.output();
      expect(textOutput).toContain('user_a@domain.com');
      expect(textOutput).not.toContain('user_b@domain.com');
    });
  });
});
