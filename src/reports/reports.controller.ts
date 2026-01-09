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
        @Query('branchId') branchId?: string,
        @Query('agentId') agentId?: string

    ) {
        if (!userId) {
            throw new BadRequestException('userId is required');
        }
        let opts = {date, branchId, agentId};
        return this.reports.getDailyCashCountByAgent(userId, opts);
    }
    
    /* ------------------------------------------------------------------
    * Active Loans by Status
    * ---------------------------------------------------------------- */
    @Get('active-loans-status')
    async activeLoansByStatus(
        @Query('userId') userId: string,
        @Query('branchId') branchId: string,

    ) {
        if (!userId) {
            throw new BadRequestException('userId is required');
        }
        return this.reports.getActiveLoansByStatus(userId, branchId);
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

    /* ------------------------------------------------------------------
    * Clientes Activos vs Inactivos
    *   GET /reports/clients-active-inactive?userId=
    * ---------------------------------------------------------------- */
    @Get('clients-active-inactive')
    async clientsActiveInactive(
        @Query('userId') userId: string,
        @Query('branchId') branchId?: string,
        @Query('agentId') agentId?: string,
    ) {
    if (!userId) throw new BadRequestException('userId is required');

        return this.reports.getClientsActiveInactive(
            userId,
            branchId ? Number(branchId) : undefined,
            agentId ? Number(agentId) : undefined
        );
    }



    /* ------------------------------------------------------------------
    * Ranking de Agentes
    *   GET /reports/agents-ranking
    *   Parámetros:
    *     userId     (number, obligatorio)
    *     startDate  (YYYY-MM-DD, opcional; default 1.er día del mes)
    *     endDate    (YYYY-MM-DD, opcional; default hoy)
    *     metric     (fundedCount | disbursedAmount | collectionAmount;
    *                 opcional; default fundedCount)
    *     limit      (number, opcional; default sin límite)
    * ---------------------------------------------------------------- */
    @Get('agents-ranking')
    async agentsRanking(
        @Query('userId')    userId: string,
        @Query('startDate') startDate?: string,
        @Query('endDate')   endDate?: string,
        @Query('metric')    metric?: 'fundedCount' | 'disbursedAmount' | 'collectionAmount',
        @Query('limit')     limit?: string,
    ) {
            if (!userId) throw new BadRequestException('userId is required');
            return this.reports.getAgentsRanking(
                userId,
                startDate,
                endDate,
                metric,
                limit ? +limit : undefined,
        );
    }

    /* ------------------------------------------------------------------
    * Monto Prestado Total (Acumulado)
    *   GET /reports/total-loaned
    *   Parámetros:
    *     userId     (number, obligatorio)
    *     startDate  (YYYY-MM-DD, opcional; default inicio de registros)
    *     endDate    (YYYY-MM-DD, opcional; default hoy)
    * ---------------------------------------------------------------- */
    @Get('total-loaned')
    async totalLoaned(
        @Query('userId')    userId: string,
        @Query('startDate') startDate?: string,
        @Query('endDate')   endDate?: string,
        @Query('branchId')  branchId?: string,
    ) {
        if (!userId) throw new BadRequestException('userId is required');
        return this.reports.getTotalLoaned(userId, startDate, endDate, branchId ? branchId : undefined);
    }


    /* ------------------------------------------------------------------
    * Recaudo Total (Pagos Recibidos)
    *   GET /reports/total-collected
    *   Parámetros:
    *     userId     (number, obligatorio)
    *     startDate  (YYYY-MM-DD, opcional; default inicio de registros)
    *     endDate    (YYYY-MM-DD, opcional; default hoy)
    * ---------------------------------------------------------------- */
    @Get('total-collected')
    async totalCollected(
        @Query('userId') userId: string,
        @Query('startDate') startDate?: string,
        @Query('endDate') endDate?: string,
        @Query('agentId') agentId?: string,
        @Query('branchId') branchId?: string,
    ) {
        if (!userId) throw new BadRequestException('userId is required');

        const filters: { agentId?: number; branchId?: number } = {};
        if (agentId)  filters.agentId  = +agentId;
        if (branchId) filters.branchId = +branchId;

        return this.reports.getTotalCollected(userId, startDate, endDate, filters);
    }


    /* ------------------------------------------------------------------
    * Documentos Subidos por Cliente
    *   GET /reports/documents-by-client
    *   Parámetros:
    *     userId    (number, obligatorio)
    *     startDate (YYYY-MM-DD, opcional; default todo el historial)
    *     endDate   (YYYY-MM-DD, opcional; default hoy)
    *     docType   (string, opcional; filtra por tipo de documento)
    * ---------------------------------------------------------------- */
@Get('documents-by-client')
async documentsByClient(
  @Query('userId') userId: string,
  @Query('startDate') startDate?: string,
  @Query('endDate') endDate?: string,
  @Query('docType') docType?: string,
  @Query('clientId') clientId?: string,
) {
  if (!userId) throw new BadRequestException('userId is required');

  const allowedDocTypes = ['ID', 'WORK_LETTER', 'UTILITY_BILL', 'PAYMENT_DETAIL', 'OTHER'];

  if (docType && !allowedDocTypes.includes(docType)) {
    throw new BadRequestException(`Invalid document type: ${docType}`);
  }

  return this.reports.getDocumentsByClient(
    userId,
    startDate,
    endDate,
    docType,                          // ← pasa string plano
    clientId ? Number(clientId) : undefined
  );
}





    /* ------------------------------------------------------------------
    * Actividad de los Agentes
    *   GET /reports/agent-activity
    *   Parámetros:
    *     userId     (number, obligatorio)
    *     startDate  (YYYY-MM-DD, opcional; default inicio del mes)
    *     endDate    (YYYY-MM-DD, opcional; default hoy)
    * ---------------------------------------------------------------- */
    @Get('agent-activity')
    async agentActivity(
        @Query('userId') userId: string,
        @Query('startDate') startDate?: string,
        @Query('endDate') endDate?: string,
        @Query('branchId') branchId?: string,
        @Query('agentId') agentId?: string,
    ) {
        if (!userId) throw new BadRequestException('userId is required');
        return this.reports.getAgentActivity(userId, startDate, endDate, branchId, agentId);
    }


    /* ------------------------------------------------------------------
    * Tiempo Promedio de Aprobación
    *   GET /reports/approval-time
    *   Parámetros:
    *     userId     (number, obligatorio)
    *     startDate  (YYYY-MM-DD, opcional)
    *     endDate    (YYYY-MM-DD, opcional)
    *     branchId   (number, opcional)
    *     agentId    (number, opcional)
    * ---------------------------------------------------------------- */
    @Get('approval-time')
    async approvalTime(
        @Query('userId')    userId:    string,
        @Query('startDate') startDate?: string,
        @Query('endDate')   endDate?:   string,
        @Query('branchId')  branchId?:  string,
        @Query('agentId')   agentId?:   string,
    ) {
        if (!userId) throw new BadRequestException('userId is required');
        return this.reports.getApprovalTimeReport(
            +userId,
            startDate,
            endDate,
            branchId ? +branchId : undefined,
            agentId ? +agentId : undefined
        );
    }

    @Get('cash-flow')
async cashFlow(
  @Query('userId') userId: string,
  @Query('startDate') startDate?: string,
  @Query('endDate') endDate?: string,
) {
  if (!userId) throw new BadRequestException('userId is required');
  return this.reports.getCashFlowReport(+userId, startDate, endDate);
}

/* ------------------------------------------------------------------
 * Detalle de Transacciones
 *   GET /reports/transactions-detail
 *   Parámetros:
 *     userId     (number, obligatorio)
 *     startDate  (YYYY-MM-DD, opcional)
 *     endDate    (YYYY-MM-DD, opcional)
 *     branchId   (number, opcional)
 *     agentId    (number, opcional)
 * ---------------------------------------------------------------- */
@Get('transactions-detail')
async getTransactionsDetail(
  @Query('userId') userId: string,
  @Query('startDate') startDate?: string,
  @Query('endDate') endDate?: string,
  @Query('branchId') branchId?: string,
  @Query('agentId') agentId?: string,
) {
  if (!userId) throw new BadRequestException('userId is required');
  return this.reports.getTransactionsDetail(+userId, startDate, endDate, branchId, agentId);
}


  @Get('branch-stats')
  async branchStats(
  @Query('userId')    userId: string,
  @Query('startDate') startDate?: string,
  @Query('endDate')   endDate?: string,
  ) {
  if (!userId) throw new BadRequestException('userId is required');
  return this.reports.getBranchStatsReport(+userId, startDate, endDate);
  }

  /* ------------------------------------------------------------------
   * Marketing: Resumen de chats (histórico o por rango)
   *   GET /reports/marketing/chat-summary
   *   Parámetros:
   *     userId     (number, obligatorio)
   *     startDate  (YYYY-MM-DD, opcional; default todo el historial)
   *     endDate    (YYYY-MM-DD, opcional; default hoy)
   * ---------------------------------------------------------------- */
  @Get('marketing/chat-summary')
  async marketingChatSummary(
    @Query('userId')    userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate')   endDate?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getMarketingChatSummary(+userId, startDate, endDate);
  }

  /* ==================================================================
   * Namespaced aliases (finance / clients / loans / agents)
   *  - NO se tocan las rutas existentes; estas son rutas nuevas.
   * ================================================================= */

  /* --------------------------- Finance ----------------------------- */

  @Get('finance/daily-cash')
  async financeDailyCash(
    @Query('userId') userId: string,
    @Query('date') date?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getDailyCashSummary(userId, date);
  }

  @Get('finance/daily-cash-count')
  async financeDailyCashCount(
    @Query('userId') userId: string,
    @Query('date') date?: string,
    @Query('branchId') branchId?: string,
    @Query('agentId') agentId?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    const opts = { date, branchId, agentId };
    return this.reports.getDailyCashCountByAgent(userId, opts);
  }

  @Get('finance/cash-flow')
  async financeCashFlow(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getCashFlowReport(+userId, startDate, endDate);
  }

  @Get('finance/transactions')
  async financeTransactions(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
    @Query('agentId') agentId?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getTransactionsDetail(
      +userId,
      startDate,
      endDate,
      branchId,
      agentId,
    );
  }

  @Get('finance/branch-stats')
  async financeBranchStats(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getBranchStatsReport(+userId, startDate, endDate);
  }

  @Get('finance/total-loaned')
  async financeTotalLoaned(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getTotalLoaned(
      userId,
      startDate,
      endDate,
      branchId ? branchId : undefined,
    );
  }

  @Get('finance/total-collected')
  async financeTotalCollected(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('agentId') agentId?: string,
    @Query('branchId') branchId?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');

    const filters: { agentId?: number; branchId?: number } = {};
    if (agentId) filters.agentId = +agentId;
    if (branchId) filters.branchId = +branchId;

    return this.reports.getTotalCollected(userId, startDate, endDate, filters);
  }

  /* --------------------------- Clients ----------------------------- */

  @Get('clients/new')
  async clientsNew(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getNewClients(userId, startDate, endDate);
  }

  @Get('clients/active-inactive')
  async clientsActiveInactiveNamespaced(
    @Query('userId') userId: string,
    @Query('branchId') branchId?: string,
    @Query('agentId') agentId?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');

    return this.reports.getClientsActiveInactive(
      userId,
      branchId ? Number(branchId) : undefined,
      agentId ? Number(agentId) : undefined,
    );
  }

  @Get('clients/documents')
  async clientsDocuments(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('docType') docType?: string,
    @Query('clientId') clientId?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');

    const allowedDocTypes = [
      'ID',
      'WORK_LETTER',
      'UTILITY_BILL',
      'PAYMENT_DETAIL',
      'OTHER',
    ];

    if (docType && !allowedDocTypes.includes(docType)) {
      throw new BadRequestException(`Invalid document type: ${docType}`);
    }

    return this.reports.getDocumentsByClient(
      userId,
      startDate,
      endDate,
      docType,
      clientId ? Number(clientId) : undefined,
    );
  }

  @Get('clients/loans-history')
  async clientsLoansHistoryNamespaced(
    @Query('userId') userId: string,
    @Query('clientId') clientId: string,
  ) {
    if (!userId || !clientId) {
      throw new BadRequestException('userId and clientId are required');
    }
    return this.reports.getClientLoansHistory(userId, clientId);
  }

  /* ---------------------------- Loans ------------------------------ */

  @Get('loans/active-status')
  async loansActiveStatus(
    @Query('userId') userId: string,
    @Query('branchId') branchId: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getActiveLoansByStatus(userId, branchId);
  }

  @Get('loans/upcoming-dues')
  async loansUpcomingDues(
    @Query('userId') userId: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getUpcomingDues(userId);
  }

  @Get('loans/overdue')
  async loansOverdue(
    @Query('userId') userId: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getOverdueLoans(userId);
  }

  @Get('loans/renewals')
  async loansRenewals(
    @Query('userId') userId: string,
    @Query('date') date?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getDailyRenewals(userId, date);
  }

  /* ---------------------------- Agents ----------------------------- */

  @Get('agents/ranking')
  async agentsRankingNamespaced(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('metric')
    metric?: 'fundedCount' | 'disbursedAmount' | 'collectionAmount',
    @Query('limit') limit?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getAgentsRanking(
      userId,
      startDate,
      endDate,
      metric,
      limit ? +limit : undefined,
    );
  }

  @Get('agents/activity')
  async agentsActivityNamespaced(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
    @Query('agentId') agentId?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getAgentActivity(
      userId,
      startDate,
      endDate,
      branchId,
      agentId,
    );
  }

  @Get('agents/approval-time')
  async agentsApprovalTimeNamespaced(
    @Query('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
    @Query('agentId') agentId?: string,
  ) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.reports.getApprovalTimeReport(
      +userId,
      startDate,
      endDate,
      branchId ? +branchId : undefined,
      agentId ? +agentId : undefined,
    );
  }

}
