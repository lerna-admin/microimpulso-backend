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
  * GET /stats/manager-summary
  * Query params (all opcionales):
  *   - latestLimit: número de últimas solicitudes (default: 10)
  *   - topAgentsLimit: número de agentes con más solicitudes sin desembolsar (default: 5)
  *   - recentPaymentsLimit: número de últimos pagos (default: 10)
  */
  @Get('manager-summary')
  async getManagerSummary(
    @Query('latestLimit') latestLimit = '10',
    @Query('topAgentsLimit') topAgentsLimit = '5',
    @Query('recentPaymentsLimit') recentPaymentsLimit = '10',
  ): Promise<{
    latestRequests: any[];
    topAgentsByUndisbursed: { agentId: number; agentName: string; undisbursedCount: number }[];
    recentPayments: { transactionId: number; loanRequestId: number; amount: number; date: Date; clientName: string; agentName: string }[];
  }> {
    const latestRequests = await this.analyticsService.getLatestRequests(+latestLimit);
    const topAgentsByUndisbursed = await this.analyticsService.getTopAgentsByUndisbursed(+topAgentsLimit);
    const recentPayments = await this.analyticsService.getRecentPayments(+recentPaymentsLimit);
    return { latestRequests, topAgentsByUndisbursed, recentPayments };
  }
  
}
