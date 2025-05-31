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
    @Get('funded-current-vs-previous')
    getFundedCurrentVsPrevious() {
        return this.analyticsService.getFundedCurrentVsPrevious();
    }
    @Get('funded-by-branch-yearly')
    async getFundedByBranchYearly() {
        return this.analyticsService.getFundedByBranchYearly();
    }
    
    @Get('funded-yearly')
    async getFundedYearly() {
        return this.analyticsService.getFundedYearlySummary();
    }
    
}
