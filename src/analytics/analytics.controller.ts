import { Controller, Get, Query } from '@nestjs/common';
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

  /**
   * GET /stats/superadmin/overview
   * Global resumen para SUPERADMIN (todos los países).
   * Query:
   *   - userId    (obligatorio, SUPERADMIN)
   *   - startDate (YYYY-MM-DD, opcional; por defecto inicio de mes actual)
   *   - endDate   (YYYY-MM-DD, opcional; por defecto hoy)
   */
  @Get('superadmin/overview')
  getSuperAdminOverview(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.analyticsService.getSuperAdminGlobalSummary(+userId, startDate, endDate);
  }
  
  /**
  * GET /stats/manager-summary
  * Query params (all optional):
  *   - latestLimit           ▸ latest loan-request count      (default: 5)
  *   - topAgentsLimit        ▸ how many agents to list        (default: 5)
  *   - upcomingPaymentsLimit ▸ how many due-soon requests     (default: 5)
  */
  @Get('manager-summary')
  async getManagerSummary(
    @Query('latestLimit')           latestLimit           = '5',
    @Query('topAgentsLimit')        topAgentsLimit        = '5',
    @Query('upcomingPaymentsLimit') upcomingPaymentsLimit = '5',
    ): Promise<{
      latestRequests: any[];
      topAgentsByUndisbursed: {
        agentId: number;
        agentName: string;
        undisbursedCount: number;
      }[];
      upcomingPayments: {
        loanRequestId: number;
        amount: number;
        endDateAt: Date;
        clientName: string;
        agentName: string;
      }[];
    }> {
      const latestRequests        = await this.analyticsService.getLatestRequests(+latestLimit);
      const topAgentsByUndisbursed = await this.analyticsService.getTopAgentsByUndisbursed(+topAgentsLimit);
      const upcomingPayments      = await this.analyticsService.getUpcomingPayments(+upcomingPaymentsLimit);
      
      return { latestRequests, topAgentsByUndisbursed, upcomingPayments };
    }
    
    
  }
  
