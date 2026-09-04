'use strict';

// India Standard Time offset, so "today" matches your actual day, not UTC's.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTDateString(date) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10); // YYYY-MM-DD
}

function startOfTodayIST() {
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  istNow.setUTCHours(0, 0, 0, 0);
  return new Date(istNow.getTime() - IST_OFFSET_MS);
}

/**
 * range: 'today' | '7d' | '30d' | 'all'
 * Returns { startDate: Date|null, days: string[] } where days is the list of
 * YYYY-MM-DD (IST) date keys covered, oldest first — used for chart buckets.
 */
function resolveRange(range) {
  const todayStart = startOfTodayIST();

  if (range === 'today') {
    return { startDate: todayStart, days: [toISTDateString(new Date())] };
  }

  const daysBack = range === '30d' ? 30 : range === '7d' ? 7 : null;

  if (daysBack) {
    const startDate = new Date(todayStart.getTime() - (daysBack - 1) * 24 * 60 * 60 * 1000);
    const days = [];
    for (let i = 0; i < daysBack; i++) {
      days.push(toISTDateString(new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000)));
    }
    return { startDate, days };
  }

  // 'all' — no lower bound
  return { startDate: null, days: null };
}

module.exports = { resolveRange, toISTDateString, startOfTodayIST };