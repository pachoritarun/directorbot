import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function generateExecutiveBriefingPdf({
  dateStr,
  organizationName = 'University Executive Office',
  directorTitle = 'Office of the Director',
  schedules = [],
  emails = [],
  whatsappSummary = null,
  edTechNews = []
}) {
  const outputDir = path.join(__dirname, '../../storage/briefings');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const safeDate = dateStr.replace(/[^0-9-]/g, '_');
  const filePath = path.join(outputDir, `executive_briefing_${safeDate}.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: {
        Title: `Executive Briefing - ${dateStr}`,
        Author: 'Executive AI Chief of Staff'
      }
    });

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Color Palette
    const NAVY = '#0F172A';
    const SLATE = '#334155';
    const MUTED = '#64748B';
    const GOLD = '#D97706';
    const LIGHT_BG = '#F8FAFC';
    const BORDER = '#E2E8F0';
    const RED = '#DC2626';

    // Header Top Bar
    doc.rect(0, 0, doc.page.width, 14).fill(NAVY);

    // Organization & Header Title
    doc.fontSize(10).fillColor(GOLD).font('Helvetica-Bold')
       .text(organizationName.toUpperCase(), 40, 30, { characterSpacing: 1.5 });
    
    doc.fontSize(22).fillColor(NAVY).font('Helvetica-Bold')
       .text('EXECUTIVE DAILY BRIEFING', 40, 46);

    doc.fontSize(10).fillColor(MUTED).font('Helvetica')
       .text(`${directorTitle}  •  Prepared for: ${dateStr}  •  CONFIDENTIAL`, 40, 74);

    // Horizontal Rule
    doc.strokeColor(BORDER).lineWidth(1.5).moveTo(40, 92).lineTo(doc.page.width - 40, 92).stroke();

    let y = 110;

    const checkPageBreak = (neededHeight) => {
      if (y + neededHeight > doc.page.height - 50) {
        doc.addPage();
        y = 40;
      }
    };

    // --- Section Helper ---
    const drawSectionHeader = (iconText, title) => {
      checkPageBreak(50);
      doc.rect(40, y, doc.page.width - 80, 24).fill(LIGHT_BG);
      doc.fontSize(11).fillColor(NAVY).font('Helvetica-Bold')
         .text(`${iconText}  ${title.toUpperCase()}`, 50, y + 6);
      y += 34;
    };

    // --- SECTION 1: TODAY'S SCHEDULE & MEETINGS ---
    drawSectionHeader('[1]', "Today's Official Itinerary & Meetings");
    if (!schedules || schedules.length === 0) {
      doc.fontSize(9.5).fillColor(MUTED).font('Helvetica-Oblique')
         .text('No scheduled appointments recorded by PA for today.', 50, y);
      y += 24;
    } else {
      schedules.forEach((item) => {
        checkPageBreak(40);
        doc.rect(45, y, 70, 18).fill('#E0E7FF');
        doc.fontSize(8.5).fillColor('#3730A3').font('Helvetica-Bold')
           .text(item.time_slot, 50, y + 4, { width: 60, align: 'center' });

        doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold')
           .text(item.title, 125, y + 2, { width: 300 });

        if (item.location) {
          doc.fontSize(8.5).fillColor(MUTED).font('Helvetica')
             .text(`Loc: ${item.location}`, 430, y + 3, { width: 120, align: 'right' });
        }

        y += 26;
      });
      y += 8;
    }

    // --- SECTION 2: HIGH PRIORITY EMAIL ACTION ITEMS ---
    drawSectionHeader('[2]', 'High-Priority Email Intelligence & Actions');
    const priorityEmails = (emails || []).filter(e => e.priority === 'Urgent' || e.priority === 'High');
    const displayEmails = priorityEmails.length > 0 ? priorityEmails : (emails || []).slice(0, 3);

    if (displayEmails.length === 0) {
      doc.fontSize(9.5).fillColor(MUTED).font('Helvetica-Oblique')
         .text('Inbox clear. No urgent pending emails require executive intervention.', 50, y);
      y += 24;
    } else {
      displayEmails.forEach((email) => {
        checkPageBreak(55);
        const isUrgent = email.priority === 'Urgent';
        doc.rect(45, y, 50, 16).fill(isUrgent ? '#FEE2E2' : '#FEF3C7');
        doc.fontSize(8).fillColor(isUrgent ? RED : GOLD).font('Helvetica-Bold')
           .text(email.priority.toUpperCase(), 47, y + 3, { width: 46, align: 'center' });

        doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold')
           .text(email.subject || '(No Subject)', 105, y + 2, { width: doc.page.width - 150 });
        y += 18;

        doc.fontSize(8.5).fillColor(SLATE).font('Helvetica-Bold')
           .text(`From: ${email.from || email.senderName}`, 50, y);
        y += 14;

        if (email.summary) {
          doc.fontSize(8.5).fillColor(SLATE).font('Helvetica')
             .text(`Summary: ${email.summary}`, 50, y, { width: doc.page.width - 100 });
          y += doc.heightOfString(`Summary: ${email.summary}`, { width: doc.page.width - 100 }) + 4;
        }

        if (email.action_required) {
          doc.fontSize(8.5).fillColor(RED).font('Helvetica-Bold')
             .text(`Action Required: ${email.action_required}`, 50, y, { width: doc.page.width - 100 });
          y += doc.heightOfString(`Action Required: ${email.action_required}`, { width: doc.page.width - 100 }) + 6;
        }
        y += 4;
      });
    }

    // --- SECTION 3: WHATSAPP PENDING MATTERS (SILENT DIGEST) ---
    drawSectionHeader('[3]', "WhatsApp Inbound Priority Digest (Kept Unread)");
    if (!whatsappSummary || (!whatsappSummary.urgent_alerts?.length && !whatsappSummary.summary_points?.length)) {
      doc.fontSize(9.5).fillColor(MUTED).font('Helvetica-Oblique')
         .text('No high-priority incoming WhatsApp messages awaiting response.', 50, y);
      y += 24;
    } else {
      if (whatsappSummary.urgent_alerts?.length) {
        whatsappSummary.urgent_alerts.forEach(alert => {
          checkPageBreak(30);
          doc.fontSize(9).fillColor(RED).font('Helvetica-Bold')
             .text(`* URGENT: ${alert}`, 50, y, { width: doc.page.width - 100 });
          y += 16;
        });
      }
      if (whatsappSummary.summary_points?.length) {
        whatsappSummary.summary_points.slice(0, 4).forEach(point => {
          checkPageBreak(30);
          doc.fontSize(9).fillColor(SLATE).font('Helvetica')
             .text(`• ${point}`, 50, y, { width: doc.page.width - 100 });
          y += 16;
        });
      }
      y += 6;
    }

    // --- SECTION 4: EDTECH & AI STRATEGIC DEVELOPMENTS ---
    drawSectionHeader('[4]', 'Top EdTech & Higher-Ed AI Strategic Trends');
    if (!edTechNews || edTechNews.length === 0) {
      doc.fontSize(9.5).fillColor(MUTED).font('Helvetica-Oblique')
         .text('AI news curation service updating.', 50, y);
      y += 24;
    } else {
      edTechNews.forEach((news, idx) => {
        checkPageBreak(45);
        doc.fontSize(9.5).fillColor(NAVY).font('Helvetica-Bold')
           .text(`${idx + 1}. ${news.title}`, 50, y, { width: doc.page.width - 100 });
        y += 14;

        if (news.source) {
          doc.fontSize(8).fillColor(GOLD).font('Helvetica')
             .text(`Source: ${news.source}`, 50, y);
          y += 12;
        }

        if (news.takeaway) {
          doc.fontSize(8.5).fillColor(SLATE).font('Helvetica')
             .text(`Executive Takeaway: ${news.takeaway}`, 50, y, { width: doc.page.width - 100 });
          y += doc.heightOfString(`Executive Takeaway: ${news.takeaway}`, { width: doc.page.width - 100 }) + 8;
        }
      });
    }

    // Footer
    const bottom = doc.page.height - 30;
    doc.fontSize(8).fillColor(MUTED).font('Helvetica')
       .text('Generated automatically by University Executive AI Chief of Staff. All rights reserved.', 40, bottom, { align: 'center' });

    doc.end();

    stream.on('finish', () => resolve(filePath));
    stream.on('error', (err) => reject(err));
  });
}
