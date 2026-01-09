export interface SuperAdminGlobalSummary {
  meta: {
    startDate: string;
    endDate: string;
    generatedAt: string;
  };
  totals: {
    activeLoanAmount: number;
    activeLoansCount: number;
    activeClientsCount: number;
    disbursedAmount: number;
    disbursementCount: number;
    repaidAmount: number;
    repaymentCount: number;
    delinquencyRate: number; // 0–1
  };
  byCountry: {
    countryId: number | null;
    countryName: string | null;
    currencyCode: string | null;
    activeLoanAmount: number;
    delinquentAmount: number;
    activeLoansCount: number;
    activeClientsCount: number;
    disbursedAmount: number;
    disbursementCount: number;
    repaidAmount: number;
    repaymentCount: number;
    delinquencyRate: number; // 0–1
  }[];
}
