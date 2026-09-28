import { query, logActivity } from '../database/db.js';

export async function addSchedule({ date, time_slot, title, description = '', location = "Director's Office", priority = 'Normal', created_by = 'PA' }) {
  const result = await query(
    `INSERT INTO schedules (date, time_slot, title, description, location, priority, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [date, time_slot, title, description, location, priority, created_by]
  );
  await logActivity('SCHEDULE', `New meeting scheduled: ${title} on ${date} at ${time_slot}`, 'INFO');
  return result.insertId;
}

export async function getSchedulesByDate(date) {
  const formattedDate = date instanceof Date ? date.toISOString().split('T')[0] : date;
  return await query(
    `SELECT * FROM schedules WHERE date = ? ORDER BY time_slot ASC`,
    [formattedDate]
  );
}

export async function getUpcomingSchedules() {
  const today = new Date().toISOString().split('T')[0];
  return await query(
    `SELECT * FROM schedules WHERE date >= ? ORDER BY date ASC, time_slot ASC LIMIT 20`,
    [today]
  );
}

export async function deleteSchedule(id) {
  return await query(`DELETE FROM schedules WHERE id = ?`, [id]);
}

/**
 * Parses PA's text message into structured schedules.
 * Format examples:
 * "!schedule 10:00 AM - HOD Meet; 02:00 PM - AI Lab Review"
 * "Tomorrow schedule: 11am Exam Board, 3pm Dean Council"
 */
export async function parseScheduleFromText(text, targetDate = null) {
  const dateToUse = targetDate || new Date().toISOString().split('T')[0];
  const cleaned = text.replace(/^!schedule\s*/i, '').trim();
  const items = cleaned.split(/;|\n/);
  const added = [];

  for (const item of items) {
    if (!item.trim()) continue;
    const parts = item.split(/-|:/);
    let timeSlot = 'TBD';
    let title = item.trim();

    if (item.includes('-')) {
      const splitDash = item.split('-');
      timeSlot = splitDash[0].trim();
      title = splitDash.slice(1).join('-').trim();
    }

    const id = await addSchedule({
      date: dateToUse,
      time_slot: timeSlot,
      title: title || 'Scheduled Discussion',
      created_by: 'PA via WhatsApp'
    });
    added.push({ id, time_slot: timeSlot, title });
  }

  return added;
}
