export interface AnalyticsReport {
  branchId: number;
  branchName: string;
  totalRequests: number;
  statusCounts: Record<string, number>;
  totalFundedAmount: number;
  totalOwedAmount: number;
}

export interface AnalyticsMonthlyReport {
  month: string; // e.g., '2025-05'
  data: AnalyticsReport[];
}

export interface AnalyticsYearlyReport {
  year: number;
  data: AnalyticsReport[];
}
export interface AnalyticsDailyReport {
  date: string; // e.g., '2025-05-01'
  data: AnalyticsReport[];
}
