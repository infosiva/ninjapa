import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { saveInvoice, listInvoices, getInvoiceCountThisMonth, getUser, ensurePdfDir } from '../db.js';

interface InvoiceItem {
  description: string;
  qty: number;
  rate: number;
}

function generateInvoiceNumber(userId: number): string {
  const now = new Date();
  const yy = now.getFullYear().toString().slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const rand = Math.floor(Math.random() * 900) + 100;
  return `INV-${yy}${mm}-${rand}`;
}

function formatCurrency(amount: number, currency: string): string {
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹' };
  const sym = symbols[currency] ?? currency + ' ';
  return `${sym}${amount.toFixed(2)}`;
}

export async function tool_generate_invoice(userId: number, args: {
  client_name: string;
  client_email?: string;
  items: InvoiceItem[];
  currency?: string;
  tax_pct?: number;
  due_days?: number;
}) {
  const user = getUser(userId);
  const profile = JSON.parse(user?.profile ?? '{}');

  const currency = args.currency ?? profile.default_currency ?? 'GBP';
  const taxPct = args.tax_pct ?? 0;
  const dueDays = args.due_days ?? 30;
  const invoiceNo = generateInvoiceNumber(userId);

  // Calculate totals
  const subtotal = args.items.reduce((sum, i) => sum + i.qty * i.rate, 0);
  const taxAmount = subtotal * (taxPct / 100);
  const total = subtotal + taxAmount;

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + dueDays);
  const issuedDate = new Date().toLocaleDateString('en-GB');
  const dueDateStr = dueDate.toLocaleDateString('en-GB');

  // Generate PDF
  const pdfDir = ensurePdfDir();
  const pdfPath = path.join(pdfDir, `${invoiceNo}.pdf`);

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // ── Header ────────────────────────────────────────────────────────────────
    doc.fontSize(24).font('Helvetica-Bold').fillColor('#111')
       .text('INVOICE', 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#666')
       .text(`Invoice No: ${invoiceNo}`, 50, 85)
       .text(`Issued: ${issuedDate}`, 50, 100)
       .text(`Due: ${dueDateStr}`, 50, 115);

    // From block
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#111')
       .text('FROM', 350, 50)
       .font('Helvetica').fillColor('#444')
       .text(profile.company_name ?? profile.name ?? 'Your Name', 350, 65)
       .text(profile.email ?? '', 350, 80)
       .text(profile.address ?? '', 350, 95);

    // Divider
    doc.moveTo(50, 140).lineTo(545, 140).strokeColor('#e5e7eb').stroke();

    // Bill to
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#111')
       .text('BILL TO', 50, 155)
       .font('Helvetica').fillColor('#444')
       .text(args.client_name, 50, 170)
       .text(args.client_email ?? '', 50, 185);

    // ── Items Table ───────────────────────────────────────────────────────────
    const tableTop = 220;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff');
    doc.rect(50, tableTop, 495, 22).fill('#111');
    doc.text('DESCRIPTION', 58, tableTop + 7)
       .text('QTY', 340, tableTop + 7)
       .text('RATE', 390, tableTop + 7)
       .text('AMOUNT', 460, tableTop + 7);

    let y = tableTop + 30;
    doc.font('Helvetica').fillColor('#111');
    args.items.forEach((item, i) => {
      const amount = item.qty * item.rate;
      if (i % 2 === 1) {
        doc.rect(50, y - 4, 495, 20).fill('#f9fafb');
        doc.fillColor('#111');
      }
      doc.text(item.description, 58, y, { width: 270 })
         .text(String(item.qty), 340, y)
         .text(formatCurrency(item.rate, currency), 390, y)
         .text(formatCurrency(amount, currency), 460, y);
      y += 22;
    });

    // ── Totals ────────────────────────────────────────────────────────────────
    doc.moveTo(350, y + 5).lineTo(545, y + 5).strokeColor('#e5e7eb').stroke();
    y += 15;
    doc.fontSize(9).fillColor('#444')
       .text('Subtotal', 370, y).text(formatCurrency(subtotal, currency), 460, y);
    if (taxPct > 0) {
      y += 16;
      doc.text(`Tax (${taxPct}%)`, 370, y).text(formatCurrency(taxAmount, currency), 460, y);
    }
    y += 16;
    doc.moveTo(350, y).lineTo(545, y).strokeColor('#e5e7eb').stroke();
    y += 8;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#111')
       .text('TOTAL', 370, y).text(formatCurrency(total, currency), 460, y);

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica').fillColor('#9ca3af')
       .text('Thank you for your business.', 50, 700, { align: 'center', width: 495 });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  // Save to DB
  saveInvoice(userId, {
    invoice_no: invoiceNo,
    client_name: args.client_name,
    client_email: args.client_email,
    items: args.items,
    currency,
    tax_pct: taxPct,
    due_days: dueDays,
    pdf_path: pdfPath,
  });

  return {
    success: true,
    invoice_no: invoiceNo,
    pdf_path: pdfPath,
    total: formatCurrency(total, currency),
    due_date: dueDateStr,
  };
}

export async function tool_list_invoices(userId: number) {
  const invoices = listInvoices(userId);
  if (invoices.length === 0) return { invoices: [], message: 'No invoices yet.' };
  return {
    invoices: invoices.map(inv => ({
      id: inv.id,
      invoice_no: inv.invoice_no,
      client_name: inv.client_name,
      currency: inv.currency,
      total: JSON.parse(inv.items).reduce((s: number, i: InvoiceItem) => s + i.qty * i.rate, 0),
      created_at: inv.created_at,
      pdf_path: inv.pdf_path,
    })),
  };
}
