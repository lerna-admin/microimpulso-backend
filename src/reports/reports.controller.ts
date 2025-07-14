import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
    constructor(private readonly reports: ReportsService) {}
    
    @Get('daily-cash')
    async dailyCash(
        @Query('userId') userId: string,
        @Query('date') date?: string,
    ) {
        if (!userId) throw new BadRequestException('userId is required');
        return this.reports.getDailyCashSummary(userId, date);
    }
    
    /**
    * Daily cash reconciliation (“Arqueo Diario por Agente”)
    * Only userId (caller) and optional date are required.
    * – ADMIN  → results for every agent in caller’s branch
    * – MANAGER → results for every branch, grouped per agent
    */
    @Get('daily-cash-count')
    async dailyCashCount(
        @Query('userId') userId: string,
        @Query('date') date?: string,
    ) {
        if (!userId) {
            throw new BadRequestException('userId is required');
        }
        return this.reports.getDailyCashCountByAgent(userId, date);
    }
    
    /* ------------------------------------------------------------------
    * Active Loans by Status
    * ---------------------------------------------------------------- */
    @Get('active-loans-status')
    async activeLoansByStatus(
        @Query('userId') userId: string,
    ) {
        if (!userId) {
            throw new BadRequestException('userId is required');
        }
        return this.reports.getActiveLoansByStatus(userId);
    }
    
}
