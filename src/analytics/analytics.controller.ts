import { Controller, Get } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('stats')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // ───── Branch-specific stats ─────

  @Get('branches/current-month')
  getCurrentMonthStats() {
    return this.analyticsService.getCurrentMonthStats();
  }

  @Get('branches/monthly-history')
  getMonthlyHistory() {
    return this.analyticsService.getMonthlyHistory();
  }

  @Get('branches/yearly-history')
  getYearlyHistory() {
    return this.analyticsService.getYearlyHistory();
  }

  @Get('branches/funded-current-vs-previous')
  getFundedCurrentVsPrevious() {
    return this.analyticsService.getFundedCurrentVsPrevious();
  }

  @Get('branches/funded-by-branch-yearly')
  getFundedByBranchYearly() {
    return this.analyticsService.getFundedByBranchYearly();
  }

  @Get('branches/funded-yearly')
  getFundedYearly() {
    return this.analyticsService.getFundedYearlySummary();
  }
  @Get('clients/summary')
    getClientDelinquencyStats() {
    return this.analyticsService.getClientDelinquencyStats();
    }

}
