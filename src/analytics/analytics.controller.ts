import { Controller, Get } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('stats/branches')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('current-month')
  getCurrentMonthStats() {
    return this.analyticsService.getCurrentMonthStats();
  }

  @Get('monthly-history')
  getMonthlyHistory() {
    return this.analyticsService.getMonthlyHistory();
  }

  @Get('yearly-history')
  getYearlyHistory() {
    return this.analyticsService.getYearlyHistory();
  }
}
