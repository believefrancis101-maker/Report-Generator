import PDFDocument from 'pdfkit';
import type { ClaimedJob } from '../worker/claim.js';
import type {
  SalesAnalysis,
  SalesReportParams,
} from './aggregate.js';

/**
 * Renders the sales report as a PDF.
 *
 * The built-in PDF fonts have no glyph for the naira sign, so the amount is
 * written with the plain text `NGN`.
 */

const MARGIN = 50;
const ROW_HEIGHT = 16;

/** Formats an amount stored in minor units as `NGN 1,234.56`. */
export function formatMoney(minorUnits: number): string {
  const negative = minorUnits < 0;
  const absolute = Math.abs(minorUnits);
  const whole = Math.floor(absolute / 100).toLocaleString('en-US');
  const cents = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}NGN ${whole}.${cents}`;
}

interface Column {
  title: string;
  width: number;
  align?: 'left' | 'right';
}

interface TableOptions {
  title: string;
  columns: Column[];
  rows: string[][];
}

/**
 * Renders the report and returns the PDF as a buffer.
 */
export async function renderSalesReportPdf(
  job: ClaimedJob,
  params: SalesReportParams,
  analysis: SalesAnalysis,
  generatedAt: string,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  const contentWidth = doc.page.width - MARGIN * 2;
  let y = MARGIN;

  const newPage = (): void => {
    doc.addPage();
    y = MARGIN;
  };

  const ensureSpace = (needed: number): void => {
    if (y + needed > doc.page.height - MARGIN) {
      newPage();
    }
  };

  /** Draws a table, repeating the header on every new page. */
  const table = ({ title, columns, rows }: TableOptions): void => {
    ensureSpace(ROW_HEIGHT * 3);
    doc.font('Helvetica-Bold').fontSize(12).text(title, MARGIN, y);
    y += 20;

    const drawHeader = (): void => {
      doc.font('Helvetica-Bold').fontSize(9);
      let x = MARGIN;
      for (const column of columns) {
        doc.text(column.title, x, y, { width: column.width, align: column.align ?? 'left' });
        x += column.width;
      }
      y += ROW_HEIGHT;
      doc
        .moveTo(MARGIN, y - 4)
        .lineTo(MARGIN + contentWidth, y - 4)
        .lineWidth(0.5)
        .stroke();
    };

    drawHeader();

    doc.font('Helvetica').fontSize(9);
    for (const row of rows) {
      if (y + ROW_HEIGHT > doc.page.height - MARGIN) {
        newPage();
        drawHeader();
        doc.font('Helvetica').fontSize(9);
      }
      let x = MARGIN;
      row.forEach((cell, index) => {
        const column = columns[index];
        if (!column) return;
        doc.text(cell, x, y, {
          width: column.width,
          align: column.align ?? 'left',
          lineBreak: false,
        });
        x += column.width;
      });
      y += ROW_HEIGHT;
    }
    y += 12;
  };

  // --- Title block -------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(20).text('Sales Report', MARGIN, y);
  y += 28;
  doc.font('Helvetica').fontSize(10);
  doc.text(`Job id: ${job.id}`, MARGIN, y);
  y += 14;
  doc.text(
    `Parameters: ${params.dateFrom} to ${params.dateTo} (inclusive, UTC)`,
    MARGIN,
    y,
  );
  y += 14;
  doc.text(`Generated at: ${generatedAt}`, MARGIN, y);
  y += 14;
  doc.text(`Job type: ${job.type}`, MARGIN, y);
  y += 22;

  // --- Totals ------------------------------------------------------------
  ensureSpace(60);
  doc.font('Helvetica-Bold').fontSize(12).text('Totals', MARGIN, y);
  y += 18;
  doc.font('Helvetica').fontSize(10);
  doc.text(`Revenue: ${formatMoney(analysis.totals.revenueMinor)}`, MARGIN, y);
  y += 14;
  const categories = new Set(
    analysis.byCategoryMonth.map((row) => row.category),
  ).size;
  doc.text(`Orders: ${analysis.totals.orders}`, MARGIN, y);
  y += 14;
  doc.text(`Months covered: ${analysis.growth.length}`, MARGIN, y);
  y += 14;
  doc.text(`Categories: ${categories}`, MARGIN, y);
  y += 22;

  // --- Revenue by category and month -------------------------------------
  table({
    title: 'Revenue by category and month',
    columns: [
      { title: 'Month', width: contentWidth * 0.18 },
      { title: 'Category', width: contentWidth * 0.3 },
      { title: 'Revenue', width: contentWidth * 0.2, align: 'right' },
      { title: 'Orders', width: contentWidth * 0.12, align: 'right' },
      { title: 'Customers', width: contentWidth * 0.1, align: 'right' },
      { title: 'Top customer', width: contentWidth * 0.1 },
    ],
    rows: analysis.byCategoryMonth.map((row) => [
      row.month,
      row.category,
      formatMoney(row.revenueMinor),
      String(row.orders),
      String(row.customers),
      row.topCustomer ?? '-',
    ]),
  });

  // --- Top customers -----------------------------------------------------
  table({
    title: 'Top 10 customers by spend',
    columns: [
      { title: 'Rank', width: contentWidth * 0.1 },
      { title: 'Customer', width: contentWidth * 0.4 },
      { title: 'Revenue', width: contentWidth * 0.25, align: 'right' },
      { title: 'Orders', width: contentWidth * 0.25, align: 'right' },
    ],
    rows: analysis.topCustomers.map((row) => [
      String(row.rank),
      row.customerName,
      formatMoney(row.revenueMinor),
      String(row.orders),
    ]),
  });

  // --- Growth ------------------------------------------------------------
  table({
    title: 'Month over month revenue growth',
    columns: [
      { title: 'Month', width: contentWidth * 0.16 },
      { title: 'Revenue', width: contentWidth * 0.2, align: 'right' },
      { title: 'Previous', width: contentWidth * 0.2, align: 'right' },
      { title: 'Growth', width: contentWidth * 0.14, align: 'right' },
      { title: 'Orders', width: contentWidth * 0.12, align: 'right' },
      { title: 'Leading category', width: contentWidth * 0.18 },
    ],
    rows: analysis.growth.map((row) => {
      const leading = row.categories[0];
      return [
        row.month,
        formatMoney(row.revenueMinor),
        row.prevRevenueMinor === null ? '-' : formatMoney(row.prevRevenueMinor),
        row.growthPct === null ? '-' : `${row.growthPct.toFixed(2)}%`,
        String(row.orders),
        leading ? `${leading.category} (${leading.sharePct.toFixed(2)}%)` : '-',
      ];
    }),
  });

  doc.end();
  return finished;
}
