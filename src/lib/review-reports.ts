// Reporting an unfair review: the reasons an owner can give, and what the
// owner's Reviews says about a report while the PotongKu team looks at it
// and once they have decided.

import { t } from './lang.ts';

/** The reasons report_review takes, in the order the form offers them. */
export const REPORT_REASONS = ['not_customer', 'rude', 'off_topic', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Longest note, as the database allows. */
export const REPORT_NOTE_MAX_LENGTH = 200;

/** A review's report as its shop's owner reads it: open while outcome is null. */
export type ReviewReport = {
  reason: ReportReason;
  note: string | null;
  outcome: 'kept' | 'removed' | null;
  decided_at: string | null;
  created_at: string;
};

/** What the owner's Reviews asks for of each review's report. */
export const REPORT_COLUMNS = 'reason, note, outcome, decided_at, created_at';

/** "Not a real customer", as the form and the review's card say it. */
export function reasonLabel(reason: ReportReason): string {
  switch (reason) {
    case 'not_customer':
      return t('Not a real customer');
    case 'rude':
      return t('Rude or hateful');
    case 'off_topic':
      return t('About something else');
    default:
      return t('Other');
  }
}

/** Where a report is: with the team, or decided. */
export type ReportState = 'open' | 'kept' | 'removed';

export const reportState = (report: Pick<ReviewReport, 'outcome'>): ReportState => report.outcome ?? 'open';

/** The badge on a reported review, and the line beside it. `app` is the app's name, whose team decides. */
export function reportStatus(report: Pick<ReviewReport, 'outcome' | 'reason'>, app: string): { badge: string; line: string } {
  switch (reportState(report)) {
    case 'kept':
      return { badge: t('Kept'), line: t('The {app} team looked at your report and kept this review.', { app }) };
    case 'removed':
      return {
        badge: t('Removed'),
        line: t('Removed by the {app} team. Customers don’t see it, and it doesn’t count in your stars.', { app }),
      };
    default:
      return {
        badge: t('Reported'),
        line: t('{reason}. It stays on your page until the {app} team decides.', {
          reason: reasonLabel(report.reason),
          app,
        }),
      };
  }
}
