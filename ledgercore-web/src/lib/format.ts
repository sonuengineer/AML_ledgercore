/**
 * Display formatting.
 *
 * Dates from this API come in two flavours and must not be confused:
 *  - `workingDate` is a calendar date (YYYY-MM-DD) with no time and no zone.
 *    Passing it through `new Date()` would reinterpret it as UTC midnight and
 *    render as the previous day for anyone west of Greenwich -- an off-by-one
 *    on the business date is a posting-date bug.
 *  - everything else is a real ISO instant and is rendered in local time.
 */

const dateOnly = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const instant = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** For `YYYY-MM-DD` strings only. Rendered as-written, never shifted. */
export const formatBusinessDate = (value: string): string => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? value : dateOnly.format(parsed);
};

/**
 * For columns the database stores as DATE but serialises as a UTC-midnight
 * timestamp (branch.openedOn). Formatted in UTC so it shows the calendar date
 * that was stored, not that date shifted into the viewer's zone.
 */
export const formatCalendarDate = (value: string | null | undefined): string => {
  if (!value) return '--';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateOnly.format(parsed);
};

export const formatInstant = (value: string | null | undefined): string => {
  if (!value) return '--';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : instant.format(parsed);
};

/** Branch codes are numbers on the wire but read as identifiers in the UI. */
export const formatBranchCode = (code: number): string => String(code);
