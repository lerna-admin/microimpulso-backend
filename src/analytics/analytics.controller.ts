import { Controller, Get } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('stats')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // ───── Branch-specific stats ─────

  @Get('branch/current-month')
  getCurrentMonthStats() {
    return this.analyticsService.getCurrentMonthStats();
  }

  @Get('branch/monthly-history')
  getMonthlyHistory() {
    return this.analyticsService.getMonthlyHistory();
  }

  @Get('branch/yearly-history')
  getYearlyHistory() {
    return this.analyticsService.getYearlyHistory();
  }

  @Get('branch/funded-current-vs-previous')
  getFundedCurrentVsPrevious() {
    return this.analyticsService.getFundedCurrentVsPrevious();
  }

  @Get('branch/funded-by-branch-yearly')
  getFundedByBranchYearly() {
    return this.analyticsService.getFundedByBranchYearly();
  }

  @Get('branch/funded-yearly')
  getFundedYearly() {
    return this.analyticsService.getFundedYearlySummary();
  }
  @Get('clients/summary')
    getClientDelinquencyStats() {
    return this.analyticsService.getClientDelinquencyStats();
    }

}
