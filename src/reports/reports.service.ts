import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import * as dayjs from 'dayjs';
import 'dayjs/plugin/timezone';
import 'dayjs/plugin/utc';
import { LoanTransaction } from 'src/entities/transaction.entity';
import { User } from 'src/entities/user.entity';

@Injectable()
export class ReportsService {
    constructor(
        @InjectRepository(LoanTransaction)
        private readonly txRepo: Repository<LoanTransaction>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
    ) {}
    
    async getDailyCashSummary(userId: string, date?: string) {
        /* 1 · Load caller ------------------------------------------------------ */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        const businessDate =
        date ?? dayjs().tz('America/Bogota').format('YYYY-MM-DD');
        
        /* 2 · Base query: loan_transaction → loan_request → agent(user) → branch */
        const qb = this.txRepo
        .createQueryBuilder('t')                              // loan_transaction
        .innerJoin('loan_request', 'lr', 'lr.id = t.loanRequestId')
        .innerJoin('user', 'agent', 'agent.id = lr.agentId')  // agent row
        .innerJoin('branch', 'branch', 'branch.id = agent.branchId')
        .where('DATE(t.date) = :businessDate', { businessDate });
        
        /* 3 · Role-specific grouping ------------------------------------------ */
        let roleView: 'ADMIN' | 'MANAGER';
        if (caller.role === 'ADMIN') {
            roleView = 'ADMIN';
            qb.andWhere('branch.id = :ownBranch', { ownBranch: caller.branchId })
            .select([
                'agent.id          AS groupId',
                'agent.name        AS groupLabel',
                't.Transactiontype AS type',
                'COUNT(*)          AS count',
                'SUM(t.amount)     AS amount',
            ])
            .groupBy('agent.id, t.Transactiontype');
        } else if (caller.role === 'MANAGER') {
            roleView = 'MANAGER';
            qb.select([
                'branch.id         AS groupId',
                'branch.name       AS groupLabel',
                't.Transactiontype AS type',
                'COUNT(*)          AS count',
                'SUM(t.amount)     AS amount',
            ])
            .groupBy('branch.id, t.Transactiontype');
        } else {
            throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }
        
        const rows = await qb.getRawMany<{
            groupId: string;
            groupLabel: string;
            type: string;
            count: string;
            amount: string;
        }>();
        
        /* 4 · Fold rows → blocks and grand totals ----------------------------- */
        const blocks: Record<
        string,
        {
            id: string;
            label: string;
            kpi: {
                totalCollected: number;
                cashPaidOut: number;
                netBalance: number;
                transactionCount: number;
            };
            breakdown: { type: string; count: number; amount: number }[];
        }
        > = {};
        
        const totals = {
            totalCollected: 0,
            cashPaidOut: 0,
            netBalance: 0,
            transactionCount: 0,
        };
        
        for (const r of rows) {
            const key = r.groupId;
            if (!blocks[key]) {
                blocks[key] = {
                    id: key,
                    label: r.groupLabel,
                    kpi: {
                        totalCollected: 0,
                        cashPaidOut: 0,
                        netBalance: 0,
                        transactionCount: 0,
                    },
                    breakdown: [],
                };
            }
            
            const blk = blocks[key];
            const amt = +r.amount;
            const cnt = +r.count;
            
            // Per-block accumulation
            blk.breakdown.push({ type: r.type, count: cnt, amount: amt });
            blk.kpi.transactionCount += cnt;
            if (amt >= 0) blk.kpi.totalCollected += amt;
            else blk.kpi.cashPaidOut += -amt;
            blk.kpi.netBalance =
            blk.kpi.totalCollected - blk.kpi.cashPaidOut;
            
            // Grand totals accumulation
            totals.transactionCount += cnt;
            if (amt >= 0) totals.totalCollected += amt;
            else totals.cashPaidOut += -amt;
        }
        totals.netBalance =
        totals.totalCollected - totals.cashPaidOut;
        
        /* 5 · Final payload ---------------------------------------------------- */
        return {
            meta: {
                date: businessDate,
                view: roleView,
                generatedAt: new Date().toISOString(),
            },
            totals,                                // overall KPIs
            blocks: Object.values(blocks),         // per-agent or per-branch
        };
    }
    /* ---------------------------------------------------------------------------
    * DAILY CASH COUNT BY AGENT  —  disbursement resta · repayment suma
    * ------------------------------------------------------------------------ */
    /* ---------------------------------------------------------------------------
    * DAILY PORTFOLIO & MOVEMENTS REPORT
    *  - Cartera (monto aún adeudado)
    *  - Repayments / Disbursements / Penalties del día
    * ------------------------------------------------------------------------ */
    async getDailyCashCountByAgent(userId: string, date?: string) {
        /* ---------------------------------------------------------------------------
        * DAILY PORTFOLIO & MOVEMENTS REPORT  (versión SQLite sin TS errors)
        * ------------------------------------------------------------------------ */
        /* 1 · Usuario que llama ---------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }
        
        const businessDate =
        date ?? dayjs().tz('America/Bogota').format('YYYY-MM-DD');
        
        /* 2 · Consultas distintas según rol ---------------------------------- */
        let carteraRows: any[];
        let movRows: any[];
        
        if (caller.role === 'ADMIN') {
            /* --- ADMIN: agrupar POR AGENTE en su sucursal --------------------- */
            const carteraSql = `
      SELECT
        agent.id   AS groupId,
        agent.name AS groupLabel,
        SUM(lr.amount)              AS totalLoaned,
        IFNULL(SUM(rep.repaid),0)   AS totalRepaid
      FROM loan_request lr
        INNER JOIN user agent ON agent.id = lr.agentId
        INNER JOIN branch     ON branch.id = agent.branchId
        LEFT JOIN (
          SELECT loanRequestId, SUM(amount) AS repaid
          FROM   loan_transaction
          WHERE  Transactiontype = 'repayment'
          GROUP  BY loanRequestId
        ) rep ON rep.loanRequestId = lr.id
      WHERE branch.id = ?
      GROUP BY agent.id, agent.name
    `;
            carteraRows = await this.txRepo.query(carteraSql, [caller.branchId]);
            
            const movSql = `
      SELECT
        agent.id            AS groupId,
        t.Transactiontype   AS type,
        COUNT(*)            AS cnt,
        SUM(t.amount)       AS amt
      FROM loan_transaction t
        INNER JOIN loan_request lr ON lr.id = t.loanRequestId
        INNER JOIN user agent      ON agent.id = lr.agentId
        INNER JOIN branch          ON branch.id = agent.branchId
      WHERE DATE(t.date) = ? AND branch.id = ?
      GROUP BY agent.id, t.Transactiontype
    `;
            movRows = await this.txRepo.query(movSql, [businessDate, caller.branchId]);
        } else {
            /* --- MANAGER: agrupar POR SUCURSAL (todas) ------------------------ */
            const carteraSql = `
      SELECT
        branch.id   AS groupId,
        branch.name AS groupLabel,
        SUM(lr.amount)              AS totalLoaned,
        IFNULL(SUM(rep.repaid),0)   AS totalRepaid
      FROM loan_request lr
        INNER JOIN user agent ON agent.id = lr.agentId
        INNER JOIN branch     ON branch.id = agent.branchId
        LEFT JOIN (
          SELECT loanRequestId, SUM(amount) AS repaid
          FROM   loan_transaction
          WHERE  Transactiontype = 'repayment'
          GROUP  BY loanRequestId
        ) rep ON rep.loanRequestId = lr.id
      GROUP BY branch.id, branch.name
    `;
            carteraRows = await this.txRepo.query(carteraSql);
            
            const movSql = `
      SELECT
        branch.id          AS groupId,
        t.Transactiontype  AS type,
        COUNT(*)           AS cnt,
        SUM(t.amount)      AS amt
      FROM loan_transaction t
        INNER JOIN loan_request lr ON lr.id = t.loanRequestId
        INNER JOIN user agent      ON agent.id = lr.agentId
        INNER JOIN branch          ON branch.id = agent.branchId
      WHERE DATE(t.date) = ?
      GROUP BY branch.id, t.Transactiontype
    `;
            movRows = await this.txRepo.query(movSql, [businessDate]);
        }
        
        /* 3 · Combinar resultados ------------------------------------------- */
        type Block = {
            id: string;
            label: string;
            metrics: {
                outstanding: number;
                repayments: { count: number; amount: number };
                disbursements: { count: number; amount: number };
                penalties: { count: number };
            };
        };
        
        const blocks: Record<string, Block> = {};
        
        // Cartera (prestado - pagado)
        for (const r of carteraRows) {
            const outstanding = +r.totalLoaned - +r.totalRepaid;
            blocks[r.groupId] = {
                id: r.groupId,
                label: r.groupLabel,
                metrics: {
                    outstanding,
                    repayments: { count: 0, amount: 0 },
                    disbursements: { count: 0, amount: 0 },
                    penalties: { count: 0 },
                },
            };
        }
        
        // Movimientos del día
        for (const m of movRows) {
            const blk = blocks[m.groupId] ?? {
                id: m.groupId,
                label: '',
                metrics: {
                    outstanding: 0,
                    repayments: { count: 0, amount: 0 },
                    disbursements: { count: 0, amount: 0 },
                    penalties: { count: 0 },
                },
            };
            
            switch (m.type) {
                case 'repayment':
                blk.metrics.repayments.count += +m.cnt;
                blk.metrics.repayments.amount += +m.amt;
                break;
                case 'disbursement':
                blk.metrics.disbursements.count += +m.cnt;
                blk.metrics.disbursements.amount += +m.amt;
                break;
                case 'penalty': // renovaciones
                blk.metrics.penalties.count += +m.cnt;
                break;
            }
            blocks[m.groupId] = blk;
        }
        
        /* 4 · Totales globales ---------------------------------------------- */
        const totals = {
            outstanding: 0,
            repayments: { count: 0, amount: 0 },
            disbursements: { count: 0, amount: 0 },
            penalties: { count: 0 },
        };
        
        for (const blk of Object.values(blocks)) {
            totals.outstanding += blk.metrics.outstanding;
            totals.repayments.count += blk.metrics.repayments.count;
            totals.repayments.amount += blk.metrics.repayments.amount;
            totals.disbursements.count += blk.metrics.disbursements.count;
            totals.disbursements.amount += blk.metrics.disbursements.amount;
            totals.penalties.count += blk.metrics.penalties.count;
        }
        
        /* 5 · Payload -------------------------------------------------------- */
        return {
            meta: {
                date: businessDate,
                view: caller.role, // ADMIN o MANAGER
                generatedAt: new Date().toISOString(),
            },
            totals,
            blocks: Object.values(blocks),
        };
    }
    
}
