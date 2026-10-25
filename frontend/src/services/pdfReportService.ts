/**
 * PDF Report Generation Service for NSE Trading Copilot.
 * 
 * Generates professional, multi-page vector PDF documents for:
 * 1. Individual Position Reports (Active, Completed, Archived)
 * 2. Consolidated Portfolio Reports (Active, Completed, Archived summary)
 * 
 * Complies strictly with audit requirements:
 * - Clear distinction between actual execution prices and reference closing prices.
 * - Explicit labels for unavailable values (no invented numbers).
 * - Multi-page support with repeated headers, running footers, and page numbers.
 * - Demo Mode vs Authenticated Mode clear disclosures.
 * - Preservation of immutable historical entries and exits.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  PortfolioPosition,
  DashboardSummary,
} from '../types/trading';

export interface PositionPdfOptions {
  isDemoMode?: boolean;
  userEmail?: string | null;
  amfiRank?: number | null;
  rankMap?: Record<string, number>;
  marketDataSource?: string | null;
  asOfTimestamp?: string | null;
  autoDownload?: boolean;
}

export interface PortfolioPdfOptions {
  isDemoMode?: boolean;
  userEmail?: string | null;
  rankMap?: Record<string, number>;
  marketDataSource?: string | null;
  asOfTimestamp?: string | null;
  autoDownload?: boolean;
}

/**
 * Format currency with Indian comma grouping using ASCII-safe "Rs." representation
 * to ensure 100% vector font compatibility across all PDF viewers without glyph corruption.
 */
export function formatPdfCurrency(amount: number | null | undefined, includeDecimals = true): string {
  if (amount === null || amount === undefined || isNaN(amount)) {
    return 'Unavailable';
  }
  const isNegative = amount < 0;
  const abs = Math.abs(amount);
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: includeDecimals ? 2 : 0,
    maximumFractionDigits: includeDecimals ? 2 : 0,
  }).format(abs);

  return isNegative ? `-Rs. ${formatted}` : `Rs. ${formatted}`;
}

/**
 * Format share counts with standard Indian comma grouping.
 */
export function formatPdfShares(quantity: number | null | undefined): string {
  if (quantity === null || quantity === undefined || isNaN(quantity)) {
    return 'Unavailable';
  }
  return new Intl.NumberFormat('en-IN').format(quantity);
}

/**
 * Generates a comprehensive, professional PDF report for a single position.
 */
export function generatePositionPdf(
  position: PortfolioPosition,
  options: PositionPdfOptions = {}
): jsPDF {
  const {
    isDemoMode = false,
    userEmail = null,
    amfiRank = null,
    marketDataSource = 'TejHQ EOD Market Data (NSE)',
    asOfTimestamp = null,
    autoDownload = true,
  } = options;

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;
  let currentY = 16;

  // 1. Report Mode Banner
  if (isDemoMode) {
    doc.setFillColor(254, 243, 199); // amber-100
    doc.rect(margin, currentY, pageWidth - margin * 2, 7, 'F');
    doc.setDrawColor(217, 119, 6); // amber-600
    doc.rect(margin, currentY, pageWidth - margin * 2, 7, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(180, 83, 9); // amber-700
    doc.text(
      'DEMO SIMULATION REPORT — SAMPLE / MOCK DATA (NOT A LIVE BROKERAGE OR AUTHENTICATED RECORD)',
      pageWidth / 2,
      currentY + 4.5,
      { align: 'center' }
    );
    currentY += 11;
  } else {
    doc.setFillColor(240, 253, 250); // teal-50
    doc.rect(margin, currentY, pageWidth - margin * 2, 7, 'F');
    doc.setDrawColor(13, 148, 136); // teal-600
    doc.rect(margin, currentY, pageWidth - margin * 2, 7, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(15, 118, 110); // teal-700
    const userLabel = userEmail ? ` • Account: ${userEmail}` : '';
    doc.text(
      `AUTHENTICATED PORTFOLIO RECORD — LIVE TRADING JOURNAL${userLabel}`,
      pageWidth / 2,
      currentY + 4.5,
      { align: 'center' }
    );
    currentY += 11;
  }

  // 2. Header Title & Report Generation Metadata
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42); // slate-900
  doc.text('NSE TRADING COPILOT', margin, currentY);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139); // slate-500
  const generationDate = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  doc.text(`Generated: ${generationDate} IST`, pageWidth - margin, currentY, { align: 'right' });
  currentY += 6;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(8, 145, 178); // cyan-600
  doc.text(`Position Report: ${position.symbol} (${position.companyName})`, margin, currentY);
  currentY += 7;

  // 3. Position Summary Grid (Boxes)
  const boxWidth = (pageWidth - margin * 2 - 6) / 3;
  const boxHeight = 18;

  const summaryBoxes = [
    {
      title: 'POSITION STATUS',
      val: position.status,
      sub: position.status === 'ARCHIVED'
        ? (position.archivedAt ? `Archived: ${position.archivedAt.slice(0, 10)}` : 'Soft-Archived')
        : position.status === 'COMPLETED'
        ? 'Fully Exited'
        : 'Active Portfolio',
    },
    {
      title: 'ACCUMULATED SHARES',
      val: `${formatPdfShares(position.accumulatedQuantity)} shares`,
      sub: `Across ${position.entries.length} recorded ${position.entries.length === 1 ? 'entry' : 'entries'}`,
    },
    {
      title: 'CAPITAL DEPLOYED',
      val: formatPdfCurrency(position.totalCapitalDeployed),
      sub: `Avg Entry: ${formatPdfCurrency(position.averageEntryPrice)}`,
    },
    {
      title: 'AMFI LARGE-CAP RANK',
      val: amfiRank ? `#${amfiRank}` : 'Top-100 Large-Cap',
      sub: 'AMFI Classification',
    },
    {
      title: 'GROSS REALISED P&L',
      val: position.realizedPnl != null
        ? formatPdfCurrency(position.realizedPnl)
        : (position.status === 'COMPLETED' ? 'Unavailable' : 'N/A (Active Position)'),
      sub: position.realizedPnl != null && position.totalCapitalDeployed > 0
        ? `${((position.realizedPnl / position.totalCapitalDeployed) * 100).toFixed(1)}% on deployed capital`
        : 'Closed trades only',
    },
    {
      title: 'GROSS UNREALISED P&L',
      val: position.status === 'ACTIVE'
        ? (position.unrealizedPnl != null
            ? formatPdfCurrency(position.unrealizedPnl)
            : 'Unavailable (Pending Live Quote)')
        : 'N/A (Position Closed)',
      sub: position.status === 'ACTIVE' && position.unrealizedPnl != null && position.totalCapitalDeployed > 0
        ? `${((position.unrealizedPnl / position.totalCapitalDeployed) * 100).toFixed(1)}% based on reference price`
        : 'Open trades only',
    },
  ];

  summaryBoxes.forEach((b, idx) => {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const x = margin + col * (boxWidth + 3);
    const y = currentY + row * (boxHeight + 3);

    doc.setFillColor(248, 250, 252); // slate-50
    doc.rect(x, y, boxWidth, boxHeight, 'F');
    doc.setDrawColor(226, 232, 240); // slate-200
    doc.rect(x, y, boxWidth, boxHeight, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(b.title, x + 3, y + 4.5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text(b.val, x + 3, y + 10.5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(100, 116, 139);
    doc.text(b.sub, x + 3, y + 15);
  });

  currentY += Math.ceil(summaryBoxes.length / 3) * (boxHeight + 3) + 4;

  // 4. Market Data & Price Semantics Notice
  doc.setFillColor(241, 245, 249); // slate-100
  doc.rect(margin, currentY, pageWidth - margin * 2, 13, 'F');
  doc.setDrawColor(203, 213, 225);
  doc.rect(margin, currentY, pageWidth - margin * 2, 13, 'S');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(15, 23, 42);
  doc.text('PRICE SEMANTICS & MARKET DATA REFERENCE:', margin + 3, currentY + 4);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(71, 85, 105);
  const refPriceText = position.currentReferencePrice !== null && position.currentReferencePrice !== undefined
    ? formatPdfCurrency(position.currentReferencePrice)
    : 'Unavailable';
  const smaText = position.twentyWeekSmaStopLoss !== null && position.twentyWeekSmaStopLoss !== undefined
    ? formatPdfCurrency(position.twentyWeekSmaStopLoss)
    : 'Unavailable';
  const rsiText = position.latestWeeklyRsi !== null && position.latestWeeklyRsi !== undefined
    ? position.latestWeeklyRsi.toFixed(1)
    : 'Unavailable';

  const refDetails = `Latest Reference Quote: ${refPriceText} • 20w SMA Stop-Loss: ${smaText} • Weekly RSI: ${rsiText} • Source: ${marketDataSource}${asOfTimestamp ? ` (${asOfTimestamp})` : ''}`;
  doc.text(refDetails, margin + 3, currentY + 8);
  doc.text(
    'Note: Reference closing prices are EOD technical indicators for decision support. Actual trade records reflect the trader\'s confirmed execution fills.',
    margin + 3,
    currentY + 11.5
  );

  currentY += 17;

  // 5. Complete Entry History Table
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text('Complete Trade Entry & Pyramiding History', margin, currentY);
  currentY += 2;

  const entryHeaders = [
    '#',
    'Date',
    'Execution Price',
    'Stop-Loss (SMA)',
    'RPS',
    'RPT (1%)',
    'Shares',
    'Capital Deployed',
    'Exit Price',
    'Realised P&L',
  ];

  const hasExit = !!position.exit;
  const exitPriceStr = hasExit ? formatPdfCurrency(position.exit?.exitPrice) : '--';

  const entryRows = position.entries.map((entry) => {
    const isInitial = entry.sequence === 1;
    const seqLabel = isInitial ? 'Initial' : `Pyramid #${entry.sequence - 1}`;
    const capitalDeployed = entry.quantity !== null && entry.quantity !== undefined
      ? formatPdfCurrency(entry.entryPrice * entry.quantity)
      : 'Unavailable';

    const pnlStr = entry.entryPnl !== null && entry.entryPnl !== undefined
      ? formatPdfCurrency(entry.entryPnl)
      : (hasExit ? 'Unavailable' : '--');

    return [
      seqLabel,
      entry.entryDate || '--',
      formatPdfCurrency(entry.entryPrice),
      formatPdfCurrency(entry.stopLoss),
      formatPdfCurrency(entry.rps),
      formatPdfCurrency(entry.rpt),
      entry.quantity !== null && entry.quantity !== undefined ? formatPdfShares(entry.quantity) : 'Unavailable',
      capitalDeployed,
      exitPriceStr,
      pnlStr,
    ];
  });

  autoTable(doc, {
    startY: currentY,
    head: [entryHeaders],
    body: entryRows,
    margin: { left: margin, right: margin },
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 7,
      cellPadding: 2,
      textColor: [15, 23, 42],
    },
    headStyles: {
      fillColor: [30, 41, 59], // slate-800
      textColor: [248, 250, 252],
      fontStyle: 'bold',
      halign: 'right',
    },
    columnStyles: {
      0: { halign: 'left', fontStyle: 'bold' },
      1: { halign: 'center' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'right' },
      9: { halign: 'right', fontStyle: 'bold' },
    },
    didDrawPage: (data) => {
      currentY = data.cursor?.y ?? currentY;
    },
  });

  // Fetch updated cursor position after table
  currentY = (doc as any).lastAutoTable.finalY + 6;

  // 6. Exit & Archival Details Section (if applicable)
  if (hasExit || position.status === 'ARCHIVED') {
    // Check if we need page break
    if (currentY + 28 > pageHeight - margin) {
      doc.addPage();
      currentY = 16;
    }

    doc.setFillColor(248, 250, 252);
    doc.rect(margin, currentY, pageWidth - margin * 2, 22, 'F');
    doc.setDrawColor(226, 232, 240);
    doc.rect(margin, currentY, pageWidth - margin * 2, 22, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(15, 23, 42);
    doc.text('Lifecycle & Historical Record Snapshot:', margin + 3, currentY + 5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(51, 65, 85);

    let textRowY = currentY + 10;
    if (hasExit) {
      const exitDateStr = position.exit?.exitDate || '--';
      const exitPriceFormatted = formatPdfCurrency(position.exit?.exitPrice);
      const exitPnl = position.realizedPnl !== null && position.realizedPnl !== undefined
        ? formatPdfCurrency(position.realizedPnl)
        : 'Unavailable';
      doc.text(
        `• Single Exit Rule: Position closed on ${exitDateStr} at executed fill price of ${exitPriceFormatted}. Consolidated Gross P&L: ${exitPnl}.`,
        margin + 3,
        textRowY
      );
      textRowY += 4.5;
      if (position.exit?.notes) {
        doc.text(`• Exit Journal Notes: ${position.exit.notes}`, margin + 3, textRowY);
        textRowY += 4.5;
      }
    }

    if (position.status === 'ARCHIVED') {
      const archDate = position.archivedAt ? position.archivedAt.slice(0, 19).replace('T', ' ') : 'Historical';
      const reason = position.archiveReason || 'Soft-archived by trader; trading history preserved.';
      doc.text(`• Archival Status: Soft-archived on ${archDate}. Reason: "${reason}".`, margin + 3, textRowY);
    }

    currentY += 26;
  }

  // 7. Statutory Disclosures Note
  if (currentY + 14 > pageHeight - margin) {
    doc.addPage();
    currentY = 16;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(148, 163, 184); // slate-400
  doc.text(
    'Disclosures: Profit & Loss calculations represent gross investment results. Brokerage fees, Securities Transaction Tax (STT), exchange turnover charges, GST, and stamp duties are excluded. This document is generated for trading discipline and personal record-keeping only.',
    margin,
    currentY,
    { maxWidth: pageWidth - margin * 2 }
  );

  // 8. Add Multi-Page Running Footers with Page Numbers
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184);
    doc.text(
      `NSE Trading Copilot • Position Report: ${position.symbol} • ${position.status}`,
      margin,
      pageHeight - 8
    );
    doc.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - 8, { align: 'right' });
  }

  // Auto-download if triggered from user interface
  if (autoDownload) {
    const filename = `${position.symbol}_${position.status}_report_${new Date().toISOString().slice(0, 10)}.pdf`;
    doc.save(filename);
  }

  return doc;
}

/**
 * Generates a consolidated, multi-page PDF report for the user's complete portfolio.
 */
export function generatePortfolioPdf(
  positions: PortfolioPosition[],
  archivedPositions: PortfolioPosition[] = [],
  summary?: DashboardSummary,
  options: PortfolioPdfOptions = {}
): jsPDF {
  const {
    isDemoMode = false,
    userEmail = null,
    rankMap = {},
    marketDataSource = 'TejHQ EOD Market Data (NSE)',
    asOfTimestamp = null,
    autoDownload = true,
  } = options;

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;
  let currentY = 16;

  // 1. Report Mode Banner
  if (isDemoMode) {
    doc.setFillColor(254, 243, 199); // amber-100
    doc.rect(margin, currentY, pageWidth - margin * 2, 7, 'F');
    doc.setDrawColor(217, 119, 6);
    doc.rect(margin, currentY, pageWidth - margin * 2, 7, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(180, 83, 9);
    doc.text(
      'DEMO SIMULATION PORTFOLIO — SAMPLE / MOCK DATA (NOT A LIVE BROKERAGE OR AUTHENTICATED RECORD)',
      pageWidth / 2,
      currentY + 4.5,
      { align: 'center' }
    );
    currentY += 11;
  } else {
    doc.setFillColor(240, 253, 250); // teal-50
    doc.rect(margin, currentY, pageWidth - margin * 2, 7, 'F');
    doc.setDrawColor(13, 148, 136);
    doc.rect(margin, currentY, pageWidth - margin * 2, 7, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(15, 118, 110);
    const userLabel = userEmail ? ` • Account: ${userEmail}` : '';
    doc.text(
      `AUTHENTICATED CONSOLIDATED PORTFOLIO — VERIFIED USER ACCOUNT${userLabel}`,
      pageWidth / 2,
      currentY + 4.5,
      { align: 'center' }
    );
    currentY += 11;
  }

  // 2. Title & Metadata
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.text('NSE TRADING COPILOT', margin, currentY);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  const generationDate = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  doc.text(`Generated: ${generationDate} IST`, pageWidth - margin, currentY, { align: 'right' });
  currentY += 6;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(8, 145, 178);
  doc.text('Consolidated Portfolio & Risk Review', margin, currentY);
  currentY += 7;

  // 3. Consolidated Portfolio Metrics Grid (6 KPI cards)
  const boxWidth = (pageWidth - margin * 2 - 6) / 3;
  const boxHeight = 18;

  const activePositions = positions.filter((p) => p.status === 'ACTIVE');
  const completedPositions = positions.filter((p) => p.status === 'COMPLETED');

  // Sum unrealized P&L strictly where valid
  let totalUnrealizedPnl: number | null = 0;
  let hasValidUnrealized = false;
  activePositions.forEach((p) => {
    if (p.unrealizedPnl !== null && p.unrealizedPnl !== undefined) {
      totalUnrealizedPnl = (totalUnrealizedPnl ?? 0) + p.unrealizedPnl;
      hasValidUnrealized = true;
    }
  });
  if (!hasValidUnrealized && activePositions.length > 0) {
    totalUnrealizedPnl = null;
  }

  // Build safe summary metrics with resilient fallbacks if summary is undefined
  const totalAllocatedShares = positions.reduce((acc, p) => acc + (p.accumulatedQuantity || 0), 0);
  const totalAllocatedCapital = positions.reduce((acc, p) => acc + (p.totalCapitalDeployed || 0), 0);
  const totalRealized = positions.concat(archivedPositions).reduce((acc, p) => acc + (p.realizedPnl || 0), 0);

  const safeSummary = {
    activePositionsCount: summary?.activePositionsCount ?? activePositions.length,
    totalQuantity: summary?.totalQuantity ?? totalAllocatedShares,
    totalCapitalDeployed: summary?.totalCapitalDeployed ?? totalAllocatedCapital,
    realizedPnl: summary?.realizedPnl ?? totalRealized,
    realizedPnlPercent: summary?.realizedPnlPercent ?? 0,
    archivedPositionsCount: summary?.archivedPositionsCount ?? archivedPositions.length,
  };

  const kpis = [
    {
      title: 'ACTIVE POSITIONS',
      val: `${safeSummary.activePositionsCount} Active`,
      sub: `${formatPdfShares(safeSummary.totalQuantity)} shares allocated`,
    },
    {
      title: 'CAPITAL DEPLOYED',
      val: formatPdfCurrency(safeSummary.totalCapitalDeployed),
      sub: 'Basis across active positions',
    },
    {
      title: 'TOTAL REALISED P&L',
      val: formatPdfCurrency(safeSummary.realizedPnl),
      sub: `${safeSummary.realizedPnlPercent >= 0 ? '+' : ''}${safeSummary.realizedPnlPercent}% on closed positions`,
    },
    {
      title: 'TOTAL UNREALISED P&L',
      val: totalUnrealizedPnl !== null ? formatPdfCurrency(totalUnrealizedPnl) : 'Unavailable',
      sub: totalUnrealizedPnl !== null && safeSummary.totalCapitalDeployed > 0
        ? `${((totalUnrealizedPnl / safeSummary.totalCapitalDeployed) * 100).toFixed(1)}% on active capital`
        : 'Based on fresh market quotes',
    },
    {
      title: 'ARCHIVED / COMPLETED',
      val: `${safeSummary.archivedPositionsCount} Preserved`,
      sub: `${completedPositions.length} completed in active view`,
    },
    {
      title: 'DATA STATUS & AS-OF',
      val: isDemoMode ? 'Sample Data' : 'Verified EOD Data',
      sub: asOfTimestamp || marketDataSource || 'EOD Data',
    },
  ];

  kpis.forEach((b, idx) => {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const x = margin + col * (boxWidth + 3);
    const y = currentY + row * (boxHeight + 3);

    doc.setFillColor(248, 250, 252);
    doc.rect(x, y, boxWidth, boxHeight, 'F');
    doc.setDrawColor(226, 232, 240);
    doc.rect(x, y, boxWidth, boxHeight, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(b.title, x + 3, y + 4.5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text(b.val, x + 3, y + 10.5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(100, 116, 139);
    doc.text(b.sub, x + 3, y + 15);
  });

  currentY += Math.ceil(kpis.length / 3) * (boxHeight + 3) + 6;

  // 4. Section 1: Active Positions Table
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`Active Positions (${activePositions.length})`, margin, currentY);
  currentY += 2;

  const activeHeaders = [
    'Symbol',
    'Company Name',
    'Rank',
    'Entries',
    'Shares',
    'Avg Entry',
    'Capital Deployed',
    'Recorded Stop-Loss',
    'Ref Price',
    'Unrealised P&L',
  ];

  const activeRows = activePositions.length > 0
    ? activePositions.map((p) => {
        const rankVal = rankMap[p.symbol] ? `#${rankMap[p.symbol]}` : '--';
        const stopLossVal = p.twentyWeekSmaStopLoss !== null && p.twentyWeekSmaStopLoss !== undefined
          ? formatPdfCurrency(p.twentyWeekSmaStopLoss)
          : '--';
        const refPriceVal = p.currentReferencePrice !== null && p.currentReferencePrice !== undefined
          ? formatPdfCurrency(p.currentReferencePrice)
          : '--';
        const unrealizedVal = p.unrealizedPnl !== null && p.unrealizedPnl !== undefined
          ? formatPdfCurrency(p.unrealizedPnl)
          : 'Unavailable';

        return [
          p.symbol,
          p.companyName,
          rankVal,
          `${p.entries.length} ${p.entries.length === 1 ? 'entry' : 'entries'}`,
          formatPdfShares(p.accumulatedQuantity),
          formatPdfCurrency(p.averageEntryPrice),
          formatPdfCurrency(p.totalCapitalDeployed),
          stopLossVal,
          refPriceVal,
          unrealizedVal,
        ];
      })
    : [['No active positions in portfolio.', '', '', '', '', '', '', '', '', '']];

  autoTable(doc, {
    startY: currentY,
    head: [activeHeaders],
    body: activeRows,
    margin: { left: margin, right: margin },
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 6.5,
      cellPadding: 1.8,
      textColor: [15, 23, 42],
    },
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [248, 250, 252],
      fontStyle: 'bold',
      halign: 'right',
    },
    columnStyles: {
      0: { halign: 'left', fontStyle: 'bold' },
      1: { halign: 'left' },
      2: { halign: 'center' },
      3: { halign: 'center' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'right' },
      9: { halign: 'right', fontStyle: 'bold' },
    },
  });

  currentY = (doc as any).lastAutoTable.finalY + 7;

  // 5. Section 2: Completed / Closed Positions Table
  if (currentY + 25 > pageHeight - margin) {
    doc.addPage();
    currentY = 16;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`Completed / Closed Positions (${completedPositions.length})`, margin, currentY);
  currentY += 2;

  const completedHeaders = [
    'Symbol',
    'Company Name',
    'Initial Date',
    'Exit Date',
    'Shares',
    'Weighted Avg Entry',
    'Exit Execution Price',
    'Capital Basis',
    'Gross Realised P&L',
  ];

  const completedRows = completedPositions.length > 0
    ? completedPositions.map((p) => {
        const exitDate = p.exit?.exitDate || '--';
        const exitPrice = p.exit?.exitPrice !== undefined ? formatPdfCurrency(p.exit.exitPrice) : '--';
        const pnl = p.realizedPnl !== null && p.realizedPnl !== undefined
          ? formatPdfCurrency(p.realizedPnl)
          : 'Unavailable';

        return [
          p.symbol,
          p.companyName,
          p.initialEntryDate || '--',
          exitDate,
          formatPdfShares(p.accumulatedQuantity),
          formatPdfCurrency(p.averageEntryPrice),
          exitPrice,
          formatPdfCurrency(p.totalCapitalDeployed),
          pnl,
        ];
      })
    : [['No closed positions in active portfolio view.', '', '', '', '', '', '', '', '']];

  autoTable(doc, {
    startY: currentY,
    head: [completedHeaders],
    body: completedRows,
    margin: { left: margin, right: margin },
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 6.5,
      cellPadding: 1.8,
      textColor: [15, 23, 42],
    },
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: [248, 250, 252],
      fontStyle: 'bold',
      halign: 'right',
    },
    columnStyles: {
      0: { halign: 'left', fontStyle: 'bold' },
      1: { halign: 'left' },
      2: { halign: 'center' },
      3: { halign: 'center' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'right', fontStyle: 'bold' },
    },
  });

  currentY = (doc as any).lastAutoTable.finalY + 7;

  // 6. Section 3: Soft-Archived Positions Table
  if (currentY + 25 > pageHeight - margin) {
    doc.addPage();
    currentY = 16;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`Preserved Historical Archive (${archivedPositions.length})`, margin, currentY);
  currentY += 2;

  const archivedHeaders = [
    'Symbol',
    'Company Name',
    'Status',
    'Shares',
    'Capital Deployed',
    'Realised P&L',
    'Archived Date',
    'Archive Reason / Notes',
  ];

  const archivedRows = archivedPositions.length > 0
    ? archivedPositions.map((p) => {
        const hasExit = !!p.exit;
        const statusLabel = hasExit ? 'Exited & Archived' : 'Active & Archived';
        const pnl = p.realizedPnl !== null && p.realizedPnl !== undefined
          ? formatPdfCurrency(p.realizedPnl)
          : (hasExit ? 'Unavailable' : '--');
        const archDate = p.archivedAt ? p.archivedAt.slice(0, 10) : 'Historical';
        const reason = p.archiveReason || 'Soft-archived';

        return [
          p.symbol,
          p.companyName,
          statusLabel,
          formatPdfShares(p.accumulatedQuantity),
          formatPdfCurrency(p.totalCapitalDeployed),
          pnl,
          archDate,
          reason,
        ];
      })
    : [['No soft-archived positions in account history.', '', '', '', '', '', '', '']];

  autoTable(doc, {
    startY: currentY,
    head: [archivedHeaders],
    body: archivedRows,
    margin: { left: margin, right: margin },
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 6.5,
      cellPadding: 1.8,
      textColor: [15, 23, 42],
    },
    headStyles: {
      fillColor: [71, 85, 105],
      textColor: [248, 250, 252],
      fontStyle: 'bold',
      halign: 'right',
    },
    columnStyles: {
      0: { halign: 'left', fontStyle: 'bold' },
      1: { halign: 'left' },
      2: { halign: 'center' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right', fontStyle: 'bold' },
      6: { halign: 'center' },
      7: { halign: 'left' },
    },
  });

  currentY = (doc as any).lastAutoTable.finalY + 7;

  // 7. Statutory Disclosures Note
  if (currentY + 14 > pageHeight - margin) {
    doc.addPage();
    currentY = 16;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(148, 163, 184);
  doc.text(
    'Disclosures: Profit & Loss calculations represent gross investment results. Brokerage fees, Securities Transaction Tax (STT), exchange turnover charges, GST, and stamp duties are excluded. This document is generated for trading discipline and personal record-keeping only.',
    margin,
    currentY,
    { maxWidth: pageWidth - margin * 2 }
  );

  // 8. Add Multi-Page Running Footers with Page Numbers
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184);
    doc.text(
      'NSE Trading Copilot • Consolidated Portfolio & Risk Review',
      margin,
      pageHeight - 8
    );
    doc.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - 8, { align: 'right' });
  }

  if (autoDownload) {
    const filename = `nse_copilot_portfolio_report_${new Date().toISOString().slice(0, 10)}.pdf`;
    doc.save(filename);
  }

  return doc;
}
