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
    /* ------------------------------------------------------------------
    * Upcoming-due loans (next 7 days)
    * ---------------------------------------------------------------- */
    @Get('upcoming-dues')
    async upcomingDues(
        @Query('userId') userId: string,
    ) {
        if (!userId) throw new BadRequestException('userId is required');
        return this.reports.getUpcomingDues(userId);      // 7-day window
    }


    /* ------------------------------------------------------------------
    * Over-due loans (all already past due)
    * ---------------------------------------------------------------- */
    @Get('overdue-loans')
    async overdueLoans(
    @Query('userId') userId: string,
    ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getOverdueLoans(userId);
    }
    /* ------------------------------------------------------------------
    * Renewals made on a given day  (“Renovaciones Realizadas”)
    * ---------------------------------------------------------------- */
    @Get('renewals')
    async renewals(
    @Query('userId') userId: string,
    @Query('date')   date?: string,         // opcional – por defecto hoy
    ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getDailyRenewals(userId, date);
    }

    /* ------------------------------------------------------------------
    * Histórico de préstamos por cliente
    *  GET /reports/client-loans-history?userId=&clientId=
    * ---------------------------------------------------------------- */
    @Get('client-loans-history')
    async clientLoansHistory(
        @Query('userId')  userId:  string,
        @Query('clientId') clientId: string,) {
        if (!userId || !clientId) {
            throw new BadRequestException('userId and clientId are required');
        }
        return this.reports.getClientLoansHistory(userId, clientId);
    }

    /* ------------------------------------------------------------------
    * Clientes nuevos por rango de fechas
    *   GET /reports/new-clients?userId=&startDate=&endDate=
    *   • startDate / endDate  → YYYY-MM-DD (ambos opcionales; por defecto
    *     los últimos 7 días contados desde hoy).
    * ---------------------------------------------------------------- */
    @Get('new-clients')
    async newClients(
    @Query('userId')    userId:    string,
    @Query('startDate') startDate?: string,
    @Query('endDate')   endDate?:   string,
    ) {
    if (!userId) {
        throw new BadRequestException('userId is required');
    }
    return this.reports.getNewClients(userId, startDate, endDate);
    }




    
}
