import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import * as dayjs from 'dayjs';
import 'dayjs/plugin/timezone';
import 'dayjs/plugin/utc';
import { LoanTransaction } from 'src/entities/transaction.entity';
import { User } from 'src/entities/user.entity';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { Client } from 'src/entities/client.entity';
import { TransactionType } from 'src/entities/transaction.entity';
import { Document } from 'src/entities/document.entity';

@Injectable()
export class ReportsService {
    constructor(
        @InjectRepository(LoanTransaction)
        private readonly txRepo: Repository<LoanTransaction>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
        @InjectRepository(LoanRequest)
        private readonly loanRepo: Repository<LoanRequest>,
        @InjectRepository(Client)
        private readonly clientRepo: Repository<Client>,
        @InjectRepository(Document)
        private readonly docRepo: Repository<Document>,
        
        
    ) {}
    
    async getDailyCashSummary(userId: string, date?: string) {
        /* 1 · Load caller -------------------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        const businessDate = date ?? dayjs().format('YYYY-MM-DD');
        
        /* 2 · Base query: loan_transaction → loan_request → agent(user) → branch */
        const qb = this.txRepo
        .createQueryBuilder('t')                              // loan_transaction
        .innerJoin('loan_request', 'lr', 'lr.id = t.loanRequestId')
        .innerJoin('user', 'agent', 'agent.id = lr.agentId')  // agent row
        .innerJoin('branch', 'branch', 'branch.id = agent.branchId')
        .where('DATE(t.date) = :businessDate', { businessDate });
        
        /* 3 · Role-specific grouping -------------------------------------------- */
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
        
        /* 4 · Fold rows → blocks and grand totals ------------------------------- */
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
            const amt = +r.amount;            // signed amount from SQL
            const cnt = +r.count;
            const isDisbursement =
            r.type === TransactionType.DISBURSEMENT || r.type === 'DISBURSEMENT';
            
            /* ── 4.1  Store row in breakdown list ── */
            blk.breakdown.push({ type: r.type, count: cnt, amount: amt });
            
            /* ── 4.2  Accumulate KPIs ───────────────────────────────────────────── */
            blk.kpi.transactionCount += cnt;
            totals.transactionCount += cnt;
            
            if (isDisbursement) {
                // Always treat disbursements as money *out*, even if amount is positive
                blk.kpi.cashPaidOut += Math.abs(amt);
                totals.cashPaidOut += Math.abs(amt);
            } else if (amt >= 0) {
                // Regular inbound cash (repayments, penalties, etc.)
                blk.kpi.totalCollected += amt;
                totals.totalCollected += amt;
            } else {
                // Any other negative amount (refunds, corrections) counts as outflow
                blk.kpi.cashPaidOut += -amt;
                totals.cashPaidOut += -amt;
            }
            
            blk.kpi.netBalance =
            blk.kpi.totalCollected - blk.kpi.cashPaidOut;
        }
        
        totals.netBalance =
        totals.totalCollected - totals.cashPaidOut;
        
        /* 5 · Final payload ------------------------------------------------------ */
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
    async getDailyCashCountByAgent(userId: string, date?: string, branchId?:string) {
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
        date ?? dayjs().format('YYYY-MM-DD');
        
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
            let carteraSql: string;
            let carteraParams: any[] = [];

            if (branchId) {
                carteraSql = `
                    SELECT
                        branch.id   AS groupId,
                        branch.name AS groupLabel,
                        SUM(lr.amount)              AS totalLoaned,
                        IFNULL(SUM(rep.repaid), 0)  AS totalRepaid
                    FROM loan_request lr
                        INNER JOIN user agent ON agent.id = lr.agentId
                        INNER JOIN branch     ON branch.id = agent.branchId
                        LEFT JOIN (
                            SELECT loanRequestId, SUM(amount) AS repaid
                            FROM loan_transaction
                            WHERE Transactiontype = 'repayment'
                            GROUP BY loanRequestId
                        ) rep ON rep.loanRequestId = lr.id
                    WHERE branch.id = ?
                    GROUP BY branch.id, branch.name
                    `;
                    carteraParams = [branchId];
                } else {
                    carteraSql = `
                    SELECT
                        branch.id   AS groupId,
                        branch.name AS groupLabel,
                        SUM(lr.amount)              AS totalLoaned,
                        IFNULL(SUM(rep.repaid), 0)  AS totalRepaid
                    FROM loan_request lr
                        INNER JOIN user agent ON agent.id = lr.agentId
                        INNER JOIN branch     ON branch.id = agent.branchId
                        LEFT JOIN (
                            SELECT loanRequestId, SUM(amount) AS repaid
                            FROM loan_transaction
                            WHERE Transactiontype = 'repayment'
                            GROUP BY loanRequestId
                        ) rep ON rep.loanRequestId = lr.id
                    GROUP BY branch.id, branch.name
                    `;
                    carteraParams = [];
                }

                carteraRows = await this.txRepo.query(carteraSql, carteraParams);

            
            let movSql: string;
            let movParams: any[] = [];

            if (branchId) {
                movSql = `
                SELECT
                    branch.id          AS groupId,
                    t.Transactiontype  AS type,
                    COUNT(*)           AS cnt,
                    SUM(t.amount)      AS amt
                FROM loan_transaction t
                    INNER JOIN loan_request lr ON lr.id = t.loanRequestId
                    INNER JOIN user agent      ON agent.id = lr.agentId
                    INNER JOIN branch          ON branch.id = agent.branchId
                WHERE DATE(t.date) = ? AND branch.id = ?
                GROUP BY branch.id, t.Transactiontype
                `;
                movParams = [businessDate, branchId];
            } else {
                movSql = `
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
                movParams = [businessDate];
            }

            movRows = await this.txRepo.query(movSql, movParams);

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
    
    /* ---------------------------------------------------------------------------
    * ACTIVE LOANS BY STATUS REPORT
    *   - ADMIN   → shows only loans in caller's branch
    *   - MANAGER → shows loans across all branches
    * ------------------------------------------------------------------------ */
    async getActiveLoansByStatus(userId: string, branchId?: string) {
        /* 1 · Load caller ----------------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }
        
        /* 2 · Build raw SQL: count and outstanding per status ---------------- */
        const ACTIVE_STATUSES = [
            "'new'",
            "'under_review'",
            "'approved'",
            "'funded'",
        ].join(',');
        
        let sql = caller.role === 'ADMIN'
        ? `
      SELECT
        lr.status                                AS status,
        COUNT(*)                                 AS cnt,
        SUM(lr.amount - IFNULL(rep.repaid, 0))   AS outstanding
      FROM loan_request lr
        INNER JOIN user agent ON agent.id = lr.agentId
        INNER JOIN branch     ON branch.id = agent.branchId
        LEFT JOIN (
          SELECT loanRequestId, SUM(amount) AS repaid
          FROM   loan_transaction
          WHERE  Transactiontype = 'repayment'
          GROUP  BY loanRequestId
        ) rep ON rep.loanRequestId = lr.id
      WHERE lr.status IN (${ACTIVE_STATUSES})
        AND branch.id = ?
      GROUP BY lr.status
    `
        : `
      SELECT
        lr.status                                AS status,
        COUNT(*)                                 AS cnt,
        SUM(lr.amount - IFNULL(rep.repaid, 0))   AS outstanding
      FROM loan_request lr
        LEFT JOIN (
          SELECT loanRequestId, SUM(amount) AS repaid
          FROM   loan_transaction
          WHERE  Transactiontype = 'repayment'
          GROUP  BY loanRequestId
        ) rep ON rep.loanRequestId = lr.id
      WHERE lr.status IN (${ACTIVE_STATUSES})
      GROUP BY lr.status
    `;

    let params: any[] = caller.role === 'ADMIN' ? [caller.branchId] : [];

    /* 3 · Apply optional override if MANAGER + branchId ------------------ */
    if (caller.role === 'MANAGER' && branchId) {
        sql = `
      SELECT
        lr.status                                AS status,
        COUNT(*)                                 AS cnt,
        SUM(lr.amount - IFNULL(rep.repaid, 0))   AS outstanding
      FROM loan_request lr
        INNER JOIN user agent ON agent.id = lr.agentId
        INNER JOIN branch     ON branch.id = agent.branchId
        LEFT JOIN (
          SELECT loanRequestId, SUM(amount) AS repaid
          FROM   loan_transaction
          WHERE  Transactiontype = 'repayment'
          GROUP  BY loanRequestId
        ) rep ON rep.loanRequestId = lr.id
      WHERE lr.status IN (${ACTIVE_STATUSES})
        AND branch.id = ?
      GROUP BY lr.status
    `;
        params = [branchId];
    }


        
        const rows: { status: string; cnt: number; outstanding: number }[] =
        await this.loanRepo.query(sql, params);
        
        /* 4 · Totals ---------------------------------------------------------- */
        const totals = rows.reduce(
            (acc, r) => {
                acc.count += r.cnt;
                acc.outstanding += r.outstanding;
                return acc;
            },
            { count: 0, outstanding: 0 },
        );
        
        /* 5 · Payload --------------------------------------------------------- */
        return {
            meta: {
                view: caller.role,          // ADMIN or MANAGER
                generatedAt: new Date().toISOString(),
            },
            totals,
            statuses: rows.map(r => ({
                status: r.status,
                count: r.cnt,
                outstanding: r.outstanding,
            })),
        };
    }
    
    /* ---------------------------------------------------------------------------
    * UPCOMING DUES (next-7-days window)
    *   ADMIN   → grouped by agent in caller’s branch
    *   MANAGER → grouped by branch, then agent
    * ------------------------------------------------------------------------ */
    async getUpcomingDues(userId: string) {
        /* 1 · Caller --------------------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }
        
        /* 2 · Date window: today .. +7 days --------------------------------- */
        const startDate = dayjs().startOf('day');
        const endDate   = startDate.add(7, 'day');              // inclusive
        
        /* 3 · Raw SQL to fetch each loan and its outstanding balance -------- */
        const activeStatuses = [
            "'new'",
            "'under_review'",
            "'approved'",
            "'funded'",
        ].join(',');
        
        const sql = caller.role === 'ADMIN'
        ? `
        SELECT
            lr.id                  AS loanId,
            DATE(lr.endDateAt)     AS dueDate,
            lr.amount              AS loanAmount,
            IFNULL(rep.repaid,0)   AS totalRepaid,
            agent.id               AS agentId,
            agent.name             AS agentName,
            branch.id              AS branchId,
            branch.name            AS branchName,
            client.name            AS clientName
        FROM loan_request lr
            INNER JOIN user agent  ON agent.id  = lr.agentId
            INNER JOIN branch      ON branch.id = agent.branchId
            INNER JOIN client      ON client.id = lr.clientId

            LEFT  JOIN (
            SELECT loanRequestId, SUM(amount) AS repaid
            FROM   loan_transaction
            WHERE  Transactiontype = 'repayment'
            GROUP  BY loanRequestId
            ) rep ON rep.loanRequestId = lr.id
        WHERE lr.status IN (${activeStatuses})
            AND DATE(lr.endDateAt) BETWEEN DATE(?) AND DATE(?)
            AND branch.id = ?
        `
        : `
        SELECT
            lr.id                  AS loanId,
            DATE(lr.endDateAt)     AS dueDate,
            lr.amount              AS loanAmount,
            IFNULL(rep.repaid,0)   AS totalRepaid,
            agent.id               AS agentId,
            agent.name             AS agentName,
            branch.id              AS branchId,
            branch.name            AS branchName,
            client.name            AS clientName
        FROM loan_request lr
            INNER JOIN user agent  ON agent.id  = lr.agentId
            INNER JOIN branch      ON branch.id = agent.branchId
            INNER JOIN client      ON client.id = lr.clientId
            LEFT  JOIN (
            SELECT loanRequestId, SUM(amount) AS repaid
            FROM   loan_transaction
            WHERE  Transactiontype = 'repayment'
            GROUP  BY loanRequestId
            ) rep ON rep.loanRequestId = lr.id
        WHERE lr.status IN (${activeStatuses})
            AND DATE(lr.endDateAt) BETWEEN DATE(?) AND DATE(?)
        `;
        
        const params = caller.role === 'ADMIN'
        ? [startDate.format('YYYY-MM-DD'), endDate.format('YYYY-MM-DD'), caller.branchId]
        : [startDate.format('YYYY-MM-DD'), endDate.format('YYYY-MM-DD')];
        
        const loans: {
            loanId: number;
            dueDate: string;
            loanAmount: number;
            totalRepaid: number;
            agentId: number;
            agentName: string;
            branchId: number;
            branchName: string;
            clientName: string;
        }[] = await this.loanRepo.query(sql, params);
        
        /* 4 · Build blocks --------------------------------------------------- */
        type AgentBlock = {
            agentId: number;
            agentName: string;
            dueCount: number;
            dueAmount: number;
            nextDueDate: string;
        };
        
        type BranchBlock = {
            branchId: number;
            branchName: string;
            dueCount: number;
            dueAmount: number;
            nextDueDate: string;
            agents: AgentBlock[];
        };
        
        const branchMap = new Map<number, BranchBlock>();
        
        for (const l of loans) {
            const outStanding = l.loanAmount - l.totalRepaid;
            /* --- Manager & Admin both need agent aggregation ----------------- */
            let agentBlock: AgentBlock = {
                agentId: l.agentId,
                agentName: l.agentName,
                dueCount: 0,
                dueAmount: 0,
                nextDueDate: l.dueDate,
            };
            
            if (caller.role === 'ADMIN') {
                // group by agent only (one branch)
                const existing = branchMap.get(l.agentId) as unknown as AgentBlock | undefined;
                if (existing) agentBlock = existing;
                
                agentBlock.dueCount += 1;
                agentBlock.dueAmount += outStanding;
                if (dayjs(l.dueDate).isBefore(agentBlock.nextDueDate)) {
                    agentBlock.nextDueDate = l.dueDate;
                }
                
                branchMap.set(l.agentId, agentBlock as unknown as BranchBlock);
            } else {
                // MANAGER: first group by branch
                let branchBlock = branchMap.get(l.branchId);
                if (!branchBlock) {
                    branchBlock = {
                        branchId: l.branchId,
                        branchName: l.branchName,
                        dueCount: 0,
                        dueAmount: 0,
                        nextDueDate: l.dueDate,
                        agents: [],
                    };
                    branchMap.set(l.branchId, branchBlock);
                }
                
                // update branch totals
                branchBlock.dueCount += 1;
                branchBlock.dueAmount += outStanding;
                if (dayjs(l.dueDate).isBefore(branchBlock.nextDueDate)) {
                    branchBlock.nextDueDate = l.dueDate;
                }
                
                // update / add agent inside branch
                let agent = branchBlock.agents.find(a => a.agentId === l.agentId);
                if (!agent) {
                    agent = {
                        agentId: l.agentId,
                        agentName: l.agentName,
                        dueCount: 0,
                        dueAmount: 0,
                        nextDueDate: l.dueDate,
                    };
                    branchBlock.agents.push(agent);
                }
                agent.dueCount += 1;
                agent.dueAmount += outStanding;
                if (dayjs(l.dueDate).isBefore(agent.nextDueDate)) {
                    agent.nextDueDate = l.dueDate;
                }
            }
        }
        
        /* 5 · Totals --------------------------------------------------------- */
        const totals = {
            loanCount: loans.length,
            amountDue: loans.reduce((sum, l) => sum + (l.loanAmount - l.totalRepaid), 0),
        };
        
        /* 6 · Sort blocks by nextDueDate ------------------------------------ */
        const blocks = Array.from(branchMap.values()).sort((a: any, b: any) =>
            dayjs(a.nextDueDate).diff(dayjs(b.nextDueDate)),
    );
    if (caller.role === 'MANAGER') {
        blocks.forEach(b =>
            b.agents.sort((x, y) =>
                dayjs(x.nextDueDate).diff(dayjs(y.nextDueDate)),
        ),
    );
}

/* 7 · Payload -------------------------------------------------------- */
return {
    meta: {
        date: startDate.format('YYYY-MM-DD'),
        window: 7,
        view: caller.role,         // ADMIN or MANAGER
        generatedAt: new Date().toISOString(),
    },
    totals,
    loans,
    blocks,
};
}

    /* ---------------------------------------------------------------------------
    * OVER-DUE LOANS REPORT
    *   ADMIN   → one block per agent in caller’s branch
    *   MANAGER → blocks per branch, each with agent breakdown
    * ------------------------------------------------------------------------ */
    async getOverdueLoans(userId: string) {
        /* 1 · Caller --------------------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }
        
        /* 2 · Reference date: today ----------------------------------------- */
        const today = dayjs().startOf('day');
        
        /* 3 · Raw SQL: list every loan past due and still outstanding -------- */
        const ACTIVE_STATUSES = [
            "'new'",
            "'under_review'",
            "'approved'",
            "'funded'",
        ].join(',');
        
        const sql = caller.role === 'ADMIN'
        ? `
            SELECT
                lr.id                  AS loanId,
                DATE(lr.endDateAt)     AS dueDate,
                lr.amount              AS loanAmount,
                IFNULL(rep.repaid,0)   AS totalRepaid,
                agent.id               AS agentId,
                agent.name             AS agentName,
                branch.id              AS branchId,
                branch.name            AS branchName,
                client.name            AS clientName
            FROM loan_request lr
                INNER JOIN user agent  ON agent.id  = lr.agentId
                INNER JOIN branch      ON branch.id = agent.branchId
                INNER JOIN client      ON client.id = lr.clientId

                LEFT  JOIN (
                SELECT loanRequestId, SUM(amount) AS repaid
                FROM   loan_transaction
                WHERE  Transactiontype = 'repayment'
                GROUP  BY loanRequestId
                ) rep ON rep.loanRequestId = lr.id
            WHERE lr.status IN (${ACTIVE_STATUSES})
                AND DATE(lr.endDateAt) < DATE(?)        /* past due */
                AND branch.id = ?
            `
        : `
            SELECT
                lr.id                  AS loanId,
                DATE(lr.endDateAt)     AS dueDate,
                lr.amount              AS loanAmount,
                IFNULL(rep.repaid,0)   AS totalRepaid,
                agent.id               AS agentId,
                agent.name             AS agentName,
                branch.id              AS branchId,
                branch.name            AS branchName,
                client.name            AS clientName

            FROM loan_request lr
                INNER JOIN user agent  ON agent.id  = lr.agentId
                INNER JOIN branch      ON branch.id = agent.branchId
                INNER JOIN client      ON client.id = lr.clientId

                LEFT  JOIN (
                SELECT loanRequestId, SUM(amount) AS repaid
                FROM   loan_transaction
                WHERE  Transactiontype = 'repayment'
                GROUP  BY loanRequestId
                ) rep ON rep.loanRequestId = lr.id
            WHERE lr.status IN (${ACTIVE_STATUSES})
                AND DATE(lr.endDateAt) < DATE(?)
            `;
        
        const params = caller.role === 'ADMIN'
        ? [today.format('YYYY-MM-DD'), caller.branchId]
        : [today.format('YYYY-MM-DD')];
        
        const loans: {
            loanId: number;
            dueDate: string;
            loanAmount: number;
            totalRepaid: number;
            agentId: number;
            agentName: string;
            branchId: number;
            branchName: string;
            clientName : string;
        }[] = await this.loanRepo.query(sql, params);
        
        /* 4 · Build blocks --------------------------------------------------- */
        type AgentBlock = {
            agentId: number;
            agentName: string;
            loanCount: number;
            amountDue: number;
            mostOverdueDays: number;
        };
        
        type BranchBlock = {
            branchId: number;
            branchName: string;
            loanCount: number;
            amountDue: number;
            mostOverdueDays: number;
            agents: AgentBlock[];
        };
        
        const branchMap = new Map<number, BranchBlock>();
        
        for (const l of loans) {
            const pending = l.loanAmount - l.totalRepaid;
            const overdueDays = today.diff(dayjs(l.dueDate), 'day');
            
            if (caller.role === 'ADMIN') {
                /* --- group by agent only --------------------------------------- */
                let agent = branchMap.get(l.agentId) as unknown as AgentBlock | undefined;
                if (!agent) {
                    agent = {
                        agentId: l.agentId,
                        agentName: l.agentName,
                        loanCount: 0,
                        amountDue: 0,
                        mostOverdueDays: overdueDays,
                    };
                    branchMap.set(l.agentId, agent as unknown as BranchBlock);
                }
                agent.loanCount += 1;
                agent.amountDue += pending;
                agent.mostOverdueDays = Math.max(agent.mostOverdueDays, overdueDays);
            } else {
                /* --- group by branch then agent -------------------------------- */
                let branch = branchMap.get(l.branchId);
                if (!branch) {
                    branch = {
                        branchId: l.branchId,
                        branchName: l.branchName,
                        loanCount: 0,
                        amountDue: 0,
                        mostOverdueDays: overdueDays,
                        agents: [],
                    };
                    branchMap.set(l.branchId, branch);
                }
                branch.loanCount += 1;
                branch.amountDue += pending;
                branch.mostOverdueDays = Math.max(branch.mostOverdueDays, overdueDays);
                
                let agent = branch.agents.find(a => a.agentId === l.agentId);
                if (!agent) {
                    agent = {
                        agentId: l.agentId,
                        agentName: l.agentName,
                        loanCount: 0,
                        amountDue: 0,
                        mostOverdueDays: overdueDays,
                    };
                    branch.agents.push(agent);
                }
                agent.loanCount += 1;
                agent.amountDue += pending;
                agent.mostOverdueDays = Math.max(agent.mostOverdueDays, overdueDays);
            }
        }
        
        /* 5 · Totals --------------------------------------------------------- */
        const totals = {
            loanCount: loans.length,
            amountDue: loans.reduce(
                (sum, l) => sum + (l.loanAmount - l.totalRepaid),
                0,
            ),
        };
        
        /* 6 · Sort blocks (oldest overdue first) ----------------------------- */
        const blocks = Array.from(branchMap.values()).sort(
            (a: any, b: any) => b.mostOverdueDays - a.mostOverdueDays,
        );
        if (caller.role === 'MANAGER') {
            blocks.forEach(b =>
                b.agents.sort(
                    (x, y) => y.mostOverdueDays - x.mostOverdueDays,
                ),
            );
        }
        
        /* 7 · Payload -------------------------------------------------------- */
        return {
            meta: {
                asOf: today.format('YYYY-MM-DD'),
                view: caller.role,
                generatedAt: new Date().toISOString(),
            },
            loans,
            totals,
            blocks,
        };
    }

    /* ---------------------------------------------------------------------------
    * DAILY RENEWALS REPORT
    *   ADMIN   → bloque por agente (solo su sucursal)
    *   MANAGER → bloques por sucursal, cada uno con agentes
    *   • Cuenta transacciones tipo 'penalty' (renovaciones)
    *   • No muestra monto — solo el número de renovaciones realizadas
    * ------------------------------------------------------------------------ */
    async getDailyRenewals(userId: string, date?: string) {
    /* 1 · Caller --------------------------------------------------------- */
    const caller = await this.userRepo.findOne({ where: { id: +userId } });
    if (!caller) throw new NotFoundException('User not found');
    
    if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
        throw new ForbiddenException('Only ADMIN or MANAGER may call this');
    }
    
    /* 2 · Fecha del reporte --------------------------------------------- */
    const businessDate =
    (date ?? dayjs().format('YYYY-MM-DD'))
    .slice(0, 10);                    // ensure YYYY-MM-DD
    
    /* 3 · SQL: contar transacciones 'penalty' del día -------------------- */
    const baseSql = `
            FROM loan_transaction t
            INNER JOIN loan_request lr ON lr.id = t.loanRequestId
            INNER JOIN user agent      ON agent.id = lr.agentId
            INNER JOIN branch          ON branch.id = agent.branchId
            WHERE t.Transactiontype = 'penalty'
            AND DATE(t.date) = DATE(?)
        `;
    
    const adminSql = `
            SELECT agent.id   AS groupId,
                agent.name AS groupLabel,
                COUNT(*)   AS renewals
            ${baseSql}
            AND branch.id = ?
            GROUP BY agent.id, agent.name
        `;
    
    const managerSql = `
            SELECT branch.id   AS branchId,
                branch.name AS branchName,
                agent.id    AS agentId,
                agent.name  AS agentName,
                COUNT(*)    AS renewals
            ${baseSql}
            GROUP BY branch.id, branch.name, agent.id, agent.name
        `;
    
    /* 4 · Ejecutar y armar estructura ----------------------------------- */
    
    if (caller.role === 'ADMIN') {
        const rows: { groupId: number; groupLabel: string; renewals: number }[] =
        await this.txRepo.query(adminSql, [businessDate, caller.branchId]);
        
        const blocks = rows.map(r => ({
            id: r.groupId,
            label: r.groupLabel,
            renewals: r.renewals,
        }));
        
        const totalRenewals = rows.reduce((sum, r) => sum + r.renewals, 0);
        
        return {
            meta: {
                date: businessDate,
                view: 'ADMIN',
                generatedAt: new Date().toISOString(),
            },
            totals: { renewals: totalRenewals },
            blocks,                         // un bloque por agente
        };
    }
    
    /* -- MANAGER -------------------------------------------------------- */
    const rows: {
        branchId: number;
        branchName: string;
        agentId: number;
        agentName: string;
        renewals: number;
    }[] = await this.txRepo.query(managerSql, [businessDate]);
    
    // agrupar sucursal→agentes
    const branchMap = new Map<number, {
        branchId: number;
        branchName: string;
        renewals: number;
        agents: { agentId: number; agentName: string; renewals: number }[];
    }>();
    
    for (const r of rows) {
        let branch = branchMap.get(r.branchId);
        if (!branch) {
            branch = {
                branchId: r.branchId,
                branchName: r.branchName,
                renewals: 0,
                agents: [],
            };
            branchMap.set(r.branchId, branch);
        }
        branch.renewals += r.renewals;
        branch.agents.push({
            agentId: r.agentId,
            agentName: r.agentName,
            renewals: r.renewals,
        });
    }
    
    const totals = {
        renewals: Array.from(branchMap.values()).reduce(
            (sum, b) => sum + b.renewals, 0),
        };
        
        return {
            meta: {
                date: businessDate,
                view: 'MANAGER',
                generatedAt: new Date().toISOString(),
            },
            totals,
            blocks: Array.from(branchMap.values())    // bloques por sucursal
        };
    }
    
    
    /* ---------------------------------------------------------------------------
    * CLIENT LOANS HISTORY
    *  ADMIN   → sólo clientes de su propia sucursal
    *  MANAGER → clientes de cualquier sucursal
    *  Devuelve cada préstamo del cliente con saldo pendiente y totales agregados
    * ------------------------------------------------------------------------ */
    async getClientLoansHistory(userId: string, clientId: string) {
        /* 1 · Usuario que llama ---------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }
        
        /* 2 · Información básica del cliente --------------------------------- */
        const client = await this.clientRepo.findOne({ where: { id: +clientId } });
        if (!client) throw new NotFoundException('Client not found');
        
        /* 3 · Consulta SQL ---------------------------------------------------- */
        const sql = caller.role === 'ADMIN'
        ? `
            SELECT
                lr.id                        AS loanId,
                lr.amount                    AS loanAmount,
                lr.status                    AS status,
                DATE(lr.createdAt)  AS startDate,
                DATE(lr.endDateAt)  AS endDate,
                IFNULL(rep.repaid,0)         AS totalRepaid,
                (lr.amount - IFNULL(rep.repaid,0)) AS outstanding
            FROM loan_request lr
                INNER JOIN user agent ON agent.id = lr.agentId
                INNER JOIN branch     ON branch.id = agent.branchId
                LEFT JOIN (
                SELECT loanRequestId, SUM(amount) AS repaid
                FROM   loan_transaction
                WHERE  Transactiontype = 'repayment'
                GROUP  BY loanRequestId
                ) rep ON rep.loanRequestId = lr.id
            WHERE lr.clientId = ?
                AND branch.id = ?
            ORDER BY lr.createdAt DESC
            `
        : `
            SELECT
                lr.id                        AS loanId,
                lr.amount                    AS loanAmount,
                lr.status                    AS status,
                DATE(lr.createdAt)         AS startDate,
                DATE(lr.endDateAt)           AS endDate,
                IFNULL(rep.repaid,0)         AS totalRepaid,
                (lr.amount - IFNULL(rep.repaid,0)) AS outstanding
            FROM loan_request lr
                LEFT JOIN (
                SELECT loanRequestId, SUM(amount) AS repaid
                FROM   loan_transaction
                WHERE  Transactiontype = 'repayment'
                GROUP  BY loanRequestId
                ) rep ON rep.loanRequestId = lr.id
            WHERE lr.clientId = ?
            ORDER BY lr.createdAt DESC
            `;
        
        const params = caller.role === 'ADMIN'
        ? [+clientId, caller.branchId]
        : [+clientId];
        
        const rows: {
            loanId: number;
            loanAmount: number;
            status: string;
            startDate: string;
            endDate: string;
            totalRepaid: number;
            outstanding: number;
        }[] = await this.loanRepo.query(sql, params);
        
        /* 4 · Totales -------------------------------------------------------- */
        const totals = rows.reduce(
            (acc, r) => {
                acc.loanCount += 1;
                acc.totalLoaned += r.loanAmount;
                acc.totalRepaid += r.totalRepaid;
                acc.totalOutstanding += r.outstanding;
                return acc;
            },
            { loanCount: 0, totalLoaned: 0, totalRepaid: 0, totalOutstanding: 0 },
        );
        
        /* 5 · Payload -------------------------------------------------------- */
        return {
            meta: {
                clientId: client.id,
                clientName: client.name,
                view: caller.role,
                generatedAt: new Date().toISOString(),
            },
            totals,
            loans: rows,          // lista de todos los préstamos del cliente
        };
    }
    
    /* ---------------------------------------------------------------------------
    * NEW CLIENTS BY DATE RANGE
    *   ADMIN   → un bloque por agente de SU sucursal
    *   MANAGER → bloques por sucursal, cada uno con sus agentes
    *   • Cuenta cuántos clientes fueron creados entre startDate y endDate
    *   • Desglosa por status inicial (PROSPECT, ACTIVE, …)
    * ------------------------------------------------------------------------ */
    async getNewClients(
        userId: string,
        startDate?: string,
        endDate?: string,
    ) {
        /* 1 · Llamador ------------------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }
        
        /* 2 · Ventana temporal (default últimos 7 días) ---------------------- */
        const end   = endDate
        ? dayjs(endDate).endOf('day')
        : dayjs().endOf('day');
        const start = startDate
        ? dayjs(startDate).startOf('day')
        : end.subtract(7, 'day').startOf('day');
        
        /* 3 · SQL base ------------------------------------------------------- */
        const baseSql = `
            FROM client c
            INNER JOIN user agent  ON agent.id  = c.agentId
            INNER JOIN branch      ON branch.id = agent.branchId
            WHERE DATE(c.createdAt) BETWEEN DATE(?) AND DATE(?)
        `;
        
        /* -------- ADMIN: agrupar por agente en su sucursal ----------------- */
        const adminSql = `
            SELECT
            agent.id    AS agentId,
            agent.name  AS agentName,
            c.status    AS status,
            COUNT(*)    AS cnt
            ${baseSql}
            AND branch.id = ?
            GROUP BY agent.id, agent.name, c.status
        `;
        
        /* -------- MANAGER: agrupar por sucursal → agente ------------------- */
        const managerSql = `
            SELECT
            branch.id   AS branchId,
            branch.name AS branchName,
            agent.id    AS agentId,
            agent.name  AS agentName,
            c.status    AS status,
            COUNT(*)    AS cnt
            ${baseSql}
            GROUP BY branch.id, branch.name, agent.id, agent.name, c.status
        `;
        
        /* 4 · Ejecutar consulta --------------------------------------------- */
        const paramsAdmin   = [start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), caller.branchId];
        const paramsManager = [start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')];
        
        if (caller.role === 'ADMIN') {
            const rows: { agentId: number; agentName: string; status: string; cnt: number }[] =
            await this.clientRepo.query(adminSql, paramsAdmin);
            
            /* Bloques por agente */
            const blocks = rows.reduce((acc, r) => {
                let ag = acc.get(r.agentId);
                if (!ag) {
                    ag = {
                        id: r.agentId,
                        label: r.agentName,
                        newCount: 0,
                        byStatus: {} as Record<string, number>,
                    };
                    acc.set(r.agentId, ag);
                }
                ag.newCount += r.cnt;
                ag.byStatus[r.status] = (ag.byStatus[r.status] ?? 0) + r.cnt;
                return acc;
            }, new Map<number, any>());
            
            const total = Array.from(blocks.values()).reduce((s, b) => s + b.newCount, 0);
            
            return {
                meta: {
                    range: `${start.format('YYYY-MM-DD')} → ${end.format('YYYY-MM-DD')}`,
                    view: 'ADMIN',
                    generatedAt: new Date().toISOString(),
                },
                totals: { newCount: total },
                blocks: Array.from(blocks.values()).sort((a, b) => b.newCount - a.newCount),
            };
        }
        
        /* ------------- MANAGER --------------------------------------------- */
        const rows: {
            branchId: number; branchName: string;
            agentId: number;  agentName: string;
            status: string;   cnt: number;
        }[] = await this.clientRepo.query(managerSql, paramsManager);
        
        /* Construir mapa branch → agents */
        const branchMap = new Map<number, any>();
        
        for (const r of rows) {
            /* rama sucursal */
            let br = branchMap.get(r.branchId);
            if (!br) {
                br = {
                    branchId: r.branchId,
                    branchName: r.branchName,
                    newCount: 0,
                    agents: [] as any[],
                };
                branchMap.set(r.branchId, br);
            }
            br.newCount += r.cnt;
            
            /* sub-rama agente */
            let ag = br.agents.find((a: any) => a.agentId === r.agentId);
            if (!ag) {
                ag = {
                    agentId: r.agentId,
                    agentName: r.agentName,
                    newCount: 0,
                    byStatus: {} as Record<string, number>,
                };
                br.agents.push(ag);
            }
            ag.newCount += r.cnt;
            ag.byStatus[r.status] = (ag.byStatus[r.status] ?? 0) + r.cnt;
        }
        
        const total = Array.from(branchMap.values()).reduce((s, b) => s + b.newCount, 0);
        
        return {
            meta: {
                range: `${start.format('YYYY-MM-DD')} → ${end.format('YYYY-MM-DD')}`,
                view: 'MANAGER',
                generatedAt: new Date().toISOString(),
            },
            totals: { newCount: total },
            blocks: Array.from(branchMap.values())
            .sort((a: any, b: any) => b.newCount - a.newCount)
            .map((b: any) => ({
                ...b,
                agents: b.agents.sort((x: any, y: any) => y.newCount - x.newCount),
            })),
        };
    }
    
    /* ---------------------------------------------------------------------------
    * CLIENTES ACTIVOS vs INACTIVOS
    *   ADMIN   → bloque por agente (solo su sucursal)
    *   MANAGER → bloques por sucursal, cada uno con sus agentes
    * ------------------------------------------------------------------------ */
    
    async getClientsActiveInactive(userId: string) {
        /* ── 1 · Validar usuario que llama ────────────────────────────────── */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }
        
        /* ── 2 · Sub-consulta de clientes con al menos un préstamo funded ─── */
        const activeSub = `
            SELECT DISTINCT lr.clientId
            FROM loan_request lr
            WHERE lr.status = 'funded'
        `;                                  /* SQLite-friendly */
        
        /* ── 3 · Consulta principal según rol ─────────────────────────────── */
        if (caller.role === 'ADMIN') {
            /* --- ADMIN: agrupar por agente en SU sucursal -------------------- */
            const adminRows = await this.clientRepo.query(
                `
            SELECT
                IFNULL(agent.id, 0)                  AS agentId,
                IFNULL(agent.name, 'Sin asignar')    AS agentName,
                c.id                                 AS clientId,
                c.name                               AS clientName,
                CASE WHEN a.clientId IS NOT NULL THEN 1 ELSE 0 END AS isActive
            FROM client c
                LEFT JOIN user   agent  ON agent.id  = c.agentId
                LEFT JOIN branch        ON branch.id = agent.branchId
                LEFT JOIN (${activeSub}) a ON a.clientId = c.id
            WHERE branch.id = ?
            `,
                [caller.branchId],
            );
            
            /* --- Agrupar en blocks ------------------------------------------ */
            const agentMap = new Map<number, {
                id: number; label: string;
                active: number; inactive: number;
                clients: { clientId: number; clientName: string; status: 'ACTIVE' | 'INACTIVE' }[];
            }>();
            
            for (const r of adminRows) {
                let blk = agentMap.get(r.agentId);
                if (!blk) {
                    blk = {
                        id:    r.agentId,
                        label: r.agentName,
                        active: 0,
                        inactive: 0,
                        clients: [],
                    };
                    agentMap.set(r.agentId, blk);
                }
                if (r.isActive) blk.active   += 1;
                else            blk.inactive += 1;
                
                blk.clients.push({
                    clientId:   r.clientId,
                    clientName: r.clientName,
                    status:     r.isActive ? 'ACTIVE' : 'INACTIVE',
                });
            }
            
            const totals = Array.from(agentMap.values()).reduce(
                (acc, b) => {
                    acc.active   += b.active;
                    acc.inactive += b.inactive;
                    return acc;
                },
                { active: 0, inactive: 0 },
            );
            
            return {
                meta:   { view: 'ADMIN', generatedAt: new Date().toISOString() },
                totals,
                blocks: Array.from(agentMap.values())
                .sort((x, y) => (y.active + y.inactive) - (x.active + x.inactive)),
            };
        }
        
        /* --- MANAGER: bloques por sucursal → agentes ---------------------- */
        const mgrRows = await this.clientRepo.query(
            `
            SELECT
            branch.id                      AS branchId,
            branch.name                    AS branchName,
            IFNULL(agent.id, 0)            AS agentId,
            IFNULL(agent.name,'Sin asignar') AS agentName,
            c.id                           AS clientId,
            c.name                         AS clientName,
            CASE WHEN a.clientId IS NOT NULL THEN 1 ELSE 0 END AS isActive
            FROM client c
            LEFT JOIN user   agent  ON agent.id  = c.agentId
            LEFT JOIN branch        ON branch.id = agent.branchId
            LEFT JOIN (${activeSub}) a ON a.clientId = c.id
            `,
        );
        
        /* --- Agrupar sucursal → agente ------------------------------------ */
        const branchMap = new Map<number, {
            branchId: number; branchName: string;
            active: number; inactive: number;
            agents: {
                agentId: number; agentName: string;
                active: number; inactive: number;
                clients: { clientId: number; clientName: string; status: 'ACTIVE' | 'INACTIVE' }[];
            }[];
        }>();
        
        for (const r of mgrRows) {
            /* bloque de sucursal */
            let br = branchMap.get(r.branchId);
            if (!br) {
                br = { branchId: r.branchId, branchName: r.branchName, active: 0, inactive: 0, agents: [] };
                branchMap.set(r.branchId, br);
            }
            
            /* sub-bloque de agente */
            let ag = br.agents.find(a => a.agentId === r.agentId);
            if (!ag) {
                ag = { agentId: r.agentId, agentName: r.agentName, active: 0, inactive: 0, clients: [] };
                br.agents.push(ag);
            }
            
            if (r.isActive) { br.active++; ag.active++; }
            else            { br.inactive++; ag.inactive++; }
            
            ag.clients.push({
                clientId: r.clientId,
                clientName: r.clientName,
                status: r.isActive ? 'ACTIVE' : 'INACTIVE',
            });
        }
        
        const totals = Array.from(branchMap.values()).reduce(
            (acc, b) => {
                acc.active   += b.active;
                acc.inactive += b.inactive;
                return acc;
            },
            { active: 0, inactive: 0 },
        );
        
        return {
            meta: { view: 'MANAGER', generatedAt: new Date().toISOString() },
            totals,
            blocks: Array.from(branchMap.values())
            .sort((x, y) => (y.active + y.inactive) - (x.active + x.inactive))
            .map(b => ({
                ...b,
                agents: b.agents.sort(
                    (x, y) => (y.active + y.inactive) - (x.active + x.inactive),
                ),
            })),
        };
    }

    /* ---------------------------------------------------------------------------
    * RANKING DE AGENTES
    *   • fundedCount       → nº de préstamos funded en el rango
    *   • disbursedAmount   → Σ de transacciones disbursement en el rango
    *   • collectionAmount  → Σ de transacciones repayment    en el rango
    *   ADMIN   → solo agentes de SU sucursal
    *   MANAGER → todos los agentes (todas las sucursales)
    * ------------------------------------------------------------------------ */
    async getAgentsRanking(
        userId: string,
        startDate?: string,
        endDate?: string,
        metric: 'fundedCount' | 'disbursedAmount' | 'collectionAmount' = 'fundedCount',
        limit?: number,
    ) {
        /* 1 ▸ caller + fechas ------------------------------------------------ */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }

        const end   = endDate
            ? dayjs(endDate).endOf('day')
            : dayjs().endOf('day');
        const start = startDate
            ? dayjs(startDate).startOf('day')
            : end.startOf('month');

        /* 2 ▸ sub-consultas agregadas (fechas duplicadas para placeholders) -- */
        const fundedSub = `
            SELECT lr.agentId AS agentId, COUNT(*) AS fundedCount
            FROM loan_request lr
            WHERE lr.status = 'funded'
            AND DATE(lr.createdAt) BETWEEN DATE(?) AND DATE(?)
            GROUP BY lr.agentId
        `;

        const disbursedSub = `
            SELECT lr.agentId AS agentId, IFNULL(SUM(t.amount),0) AS disbursedAmount
            FROM loan_request lr
            JOIN loan_transaction t ON t.loanRequestId = lr.id
            WHERE t.Transactiontype = 'disbursement'
            AND DATE(t.date) BETWEEN DATE(?) AND DATE(?)
            GROUP BY lr.agentId
        `;

        const collectionSub = `
            SELECT lr.agentId AS agentId, IFNULL(SUM(t.amount),0) AS collectionAmount
            FROM loan_request lr
            JOIN loan_transaction t ON t.loanRequestId = lr.id
            WHERE t.Transactiontype = 'repayment'
            AND DATE(t.date) BETWEEN DATE(?) AND DATE(?)
            GROUP BY lr.agentId
        `;

        /* 3 ▸ query principal ----------------------------------------------- */
        const mainSql = `
            SELECT
                agent.id              AS agentId,
                agent.name            AS agentName,
                branch.id             AS branchId,
                branch.name           AS branchName,
                IFNULL(fc.fundedCount,0)         AS fundedCount,
                IFNULL(da.disbursedAmount,0)     AS disbursedAmount,
                IFNULL(ca.collectionAmount,0)    AS collectionAmount
            FROM user agent
                JOIN branch ON branch.id = agent.branchId
                LEFT JOIN (${fundedSub})     fc ON fc.agentId = agent.id
                LEFT JOIN (${disbursedSub})  da ON da.agentId = agent.id
                LEFT JOIN (${collectionSub}) ca ON ca.agentId = agent.id
            WHERE 1 = 1
                ${caller.role === 'ADMIN' ? 'AND branch.id = ?' : ''}
                AND (
                IFNULL(fc.fundedCount,0)      > 0 OR
                IFNULL(da.disbursedAmount,0)  > 0 OR
                IFNULL(ca.collectionAmount,0) > 0
                )
            `;

        /* 4 ▸ ejecutar ------------------------------------------------------- */
        const params: any[] = [
            start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'),   // funded
            start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'),   // disbursed
            start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'),   // collection
        ];
        if (caller.role === 'ADMIN') params.push(caller.branchId);

        let rows = await this.userRepo.query(mainSql, params);

        /* 5 ▸ ordenar y limitar --------------------------------------------- */
        rows.sort((a: any, b: any) => b[metric] - a[metric]);
        if (limit) rows = rows.slice(0, limit);

        /* 6 ▸ payload -------------------------------------------------------- */
        return {
            meta: {
            range: `${start.format('YYYY-MM-DD')} → ${end.format('YYYY-MM-DD')}`,
            metric,
            view: caller.role,
            generatedAt: new Date().toISOString(),
            },
            blocks: rows.map((r: any) => ({
            agentId:           +r.agentId,
            agentName:         r.agentName,
            branchId:          +r.branchId,
            branchName:        r.branchName,
            fundedCount:       +r.fundedCount,
            disbursedAmount:   +r.disbursedAmount,
            collectionAmount:  +r.collectionAmount,
            })),
        };
    }
    /* ---------------------------------------------------------------------------
    * TOTAL LOANED (acumulado o por rango de fechas)
    *   Visible solo para GERENTE (role='MANAGER')
    *   • Suma el monto efectivamente desembolsado (lr.amount)
    *     para préstamos con status='funded'
    *   • Desglosa por sucursal → agentes
    * ------------------------------------------------------------------------ */
    async getTotalLoaned(
        userId: string,
        startDate?: string,
        endDate?: string,
    ) {
        /* 1 · Validar usuario y rol ------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        if (caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only MANAGER may call this');
        }

        /* 2 · Determinar rango de fechas -------------------------------------- */
        const end = endDate
            ? dayjs(endDate).endOf('day')
            : dayjs().endOf('day');
        const start = startDate
            ? dayjs(startDate).startOf('day')
            : dayjs('1970-01-01').startOf('day');  // todo el historial

        /* 3 · Consulta SQL: sumar lr.amount solo para funded ------------------ */
        const sql = `
            SELECT
            branch.id      AS branchId,
            branch.name    AS branchName,
            agent.id       AS agentId,
            agent.name     AS agentName,
            SUM(lr.amount) AS totalLoaned
            FROM loan_request lr
            INNER JOIN user   agent  ON agent.id  = lr.agentId
            INNER JOIN branch        ON branch.id = agent.branchId
            WHERE lr.status = 'funded'
            AND DATE(lr.createdAt) BETWEEN DATE(?) AND DATE(?)
            GROUP BY branch.id, branch.name, agent.id, agent.name
            ORDER BY branch.id, totalLoaned DESC
        `;

        const params = [ start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD') ];
        const rows: {
            branchId: number;
            branchName: string;
            agentId: number;
            agentName: string;
            totalLoaned: string;
        }[] = await this.loanRepo.query(sql, params);

        /* 4 · Construir estructura por sucursal → agentes ------------------- */
        const branchMap = new Map<number, {
            branchId: number;
            branchName: string;
            totalLoaned: number;
            agents: { agentId: number; agentName: string; totalLoaned: number }[];
        }>();

        for (const r of rows) {
            let br = branchMap.get(r.branchId);
            if (!br) {
            br = {
                branchId:    r.branchId,
                branchName:  r.branchName,
                totalLoaned: 0,
                agents:      [],
            };
            branchMap.set(r.branchId, br);
            }
            const amount = Number(r.totalLoaned);
            br.totalLoaned += amount;
            br.agents.push({
            agentId:     r.agentId,
            agentName:   r.agentName,
            totalLoaned: amount,
            });
        }

        /* 5 · Totales generales --------------------------------------------- */
        const grandTotal = Array.from(branchMap.values())
            .reduce((sum, b) => sum + b.totalLoaned, 0);

        /* 6 · Payload -------------------------------------------------------- */
        return {
            meta: {
            startDate: start.format('YYYY-MM-DD'),
            endDate:   end.format('YYYY-MM-DD'),
            view:      caller.role,
            generatedAt: new Date().toISOString(),
            },
            totals: {
            totalLoaned: grandTotal,
            },
            blocks: Array.from(branchMap.values()).map(b => ({
            branchId:    b.branchId,
            branchName:  b.branchName,
            totalLoaned: b.totalLoaned,
            agents: b.agents.sort((a, c) => c.totalLoaned - a.totalLoaned),
            })),
        };
    }

    /* ---------------------------------------------------------------------------
    * TOTAL COLLECTED (pagos recibidos)
    *   Visible solo para GERENTE (role='MANAGER')
    *   • Suma montos de transacciones TYPE='repayment'
    *   • Desglosa por sucursal → agentes
    * ------------------------------------------------------------------------ */
    async getTotalCollected(
        userId: string,
        startDate?: string,
        endDate?: string,
    ) {
        /* 1 · Validar usuario y rol ------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        if (caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only GERENTE may call this');
        }

        /* 2 · Determinar rango de fechas -------------------------------------- */
        const end = endDate
            ? dayjs(endDate).endOf('day')
            : dayjs().endOf('day');
        const start = startDate
            ? dayjs(startDate).startOf('day')
            : dayjs('1970-01-01').startOf('day');

        /* 3 · Consulta SQL: sumar t.amount para repayment -------------------- */
        const sql = `
            SELECT
            branch.id      AS branchId,
            branch.name    AS branchName,
            agent.id       AS agentId,
            agent.name     AS agentName,
            IFNULL(SUM(t.amount),0) AS totalCollected
            FROM loan_transaction t
            INNER JOIN loan_request lr ON lr.id = t.loanRequestId
            INNER JOIN user   agent  ON agent.id  = lr.agentId
            INNER JOIN branch        ON branch.id = agent.branchId
            WHERE t.Transactiontype = 'repayment'
            AND DATE(t.date) BETWEEN DATE(?) AND DATE(?)
            GROUP BY branch.id, branch.name, agent.id, agent.name
            ORDER BY branch.id, totalCollected DESC
        `;

        const params = [ start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD') ];
        const rows: {
            branchId: number;
            branchName: string;
            agentId: number;
            agentName: string;
            totalCollected: string;
        }[] = await this.txRepo.query(sql, params);

        /* 4 · Construir estructura por sucursal → agentes ------------------- */
        const branchMap = new Map<number, {
            branchId: number;
            branchName: string;
            totalCollected: number;
            agents: { agentId: number; agentName: string; totalCollected: number }[];
        }>();

        for (const r of rows) {
            let br = branchMap.get(r.branchId);
            if (!br) {
            br = {
                branchId:       r.branchId,
                branchName:     r.branchName,
                totalCollected: 0,
                agents:         [],
            };
            branchMap.set(r.branchId, br);
            }
            const amt = Number(r.totalCollected);
            br.totalCollected += amt;
            br.agents.push({
            agentId:        r.agentId,
            agentName:      r.agentName,
            totalCollected: amt,
            });
        }

        /* 5 · Totales generales --------------------------------------------- */
        const grandTotal = Array.from(branchMap.values())
            .reduce((sum, b) => sum + b.totalCollected, 0);

        /* 6 · Payload -------------------------------------------------------- */
        return {
            meta: {
            startDate:    start.format('YYYY-MM-DD'),
            endDate:      end.format('YYYY-MM-DD'),
            view:         caller.role,         // should be 'MANAGER'
            generatedAt:  new Date().toISOString(),
            },
            totals: {
            totalCollected: grandTotal,
            },
            blocks: Array.from(branchMap.values()).map(b => ({
            branchId:        b.branchId,
            branchName:      b.branchName,
            totalCollected:  b.totalCollected,
            agents: b.agents.sort((a, c) => c.totalCollected - a.totalCollected),
            })),
        };
    }

    /* ---------------------------------------------------------------------
    * DOCUMENTOS SUBIDOS POR CLIENTE
    *   • Admin ve SOLO clientes de su sucursal
    *   • Manager ve TODOS los clientes
    *   • Muestra conteo, desglose por tipo y lista de documentos
    * ------------------------------------------------------------------ */
    async getDocumentsByClient(
        userId:     string,
        startDate?: string,
        endDate?:   string,
        docType?:   string,
    ) {
        // 1 · Validar caller y rol
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
        throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }

        // 2 · Rango de fechas (por defecto todo historial)
        const start = startDate
        ? dayjs(startDate).startOf('day')
        : dayjs('1970-01-01').startOf('day');
        const end   = endDate
        ? dayjs(endDate).endOf('day')
        : dayjs().endOf('day');

        // 3 · Query builder para filtrar documentos
        const qb = this.docRepo.createQueryBuilder('d')
        .innerJoin('d.client', 'c')
        .innerJoin('c.agent', 'agent')
        .innerJoin('agent.branch', 'branch')
        .where('d.createdAt BETWEEN :start AND :end', {
            start: start.format('YYYY-MM-DD'),
            end:   end.format('YYYY-MM-DD'),
        });

        if (docType) {
        qb.andWhere('d.type = :docType', { docType });
        }
        if (caller.role === 'ADMIN') {
        qb.andWhere('agent.branchId = :branchId', { branchId: caller.branchId });
        }

        qb.select([
        'c.id        AS clientId',
        'c.name      AS clientName',
        'd.id        AS docId',
        'd.type      AS type',
        'd.createdAt AS uploadedAt',
        ]);

        const rows: {
        clientId:   number;
        clientName: string;
        docId:      number;
        type:       string;
        uploadedAt: Date;
        }[] = await qb.getRawMany();

        // 4 · Agrupar por cliente
        const map = new Map<number, {
        clientId:   number;
        clientName: string;
        totalDocs:  number;
        byType:     Record<string, number>;
        documents:  { docId: number; type: string; uploadedAt: Date }[];
        }>();

        for (const r of rows) {
        let blk = map.get(r.clientId);
        if (!blk) {
            blk = {
            clientId:   r.clientId,
            clientName: r.clientName,
            totalDocs:  0,
            byType:     {},
            documents:  [],
            };
            map.set(r.clientId, blk);
        }
        blk.totalDocs += 1;
        blk.byType[r.type] = (blk.byType[r.type] ?? 0) + 1;
        blk.documents.push({
            docId:      r.docId,
            type:       r.type,
            uploadedAt: r.uploadedAt,
        });
        }

        // 5 · Totales globales
        const totalDocuments = Array.from(map.values())
        .reduce((sum, b) => sum + b.totalDocs, 0);

        // 6 · Payload
        return {
        meta: {
            startDate:   start.format('YYYY-MM-DD'),
            endDate:     end.format('YYYY-MM-DD'),
            docType:     docType ?? 'all',
            view:        caller.role,
            generatedAt: new Date().toISOString(),
        },
        totals: { totalDocuments },
        blocks: Array.from(map.values())
            .sort((a, b) => b.totalDocs - a.totalDocs),
        };
    }
    /* ---------------------------------------------------------------------------
    * AGENT ACTIVITY REPORT
    *   • loanRequestsCount   → total solicitudes creadas
    *   • fundedCount         → préstamos funded
    *   • disbursementCount   → transacciones disbursement
    *   • repaymentCount      → transacciones repayment
    *   • penaltyCount        → transacciones penalty (renovaciones)
    *   • clientOnboardCount  → clientes nuevos creados
    *   • documentUploadCount → documentos subidos
    *   ADMIN   → solo sus agentes de sucursal
    *   MANAGER → todos los agentes
    * ------------------------------------------------------------------------ */
    async getAgentActivity(
        userId: string,
        startDate?: string,
        endDate?: string,
    ) {
        // 1 · Load caller
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        if (caller.role !== 'ADMIN' && caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only ADMIN or MANAGER may call this');
        }

        // 2 · Date window
        const end   = endDate
            ? dayjs(endDate).endOf('day')
            : dayjs().endOf('day');
        const start = startDate
            ? dayjs(startDate).startOf('day')
            : end.startOf('month');

        // 3 · Sub-queries (SQLite)
        const lrSub = `
            SELECT agentId, COUNT(*) AS loanRequestsCount
            FROM loan_request
            WHERE DATE(createdAt) BETWEEN DATE(?) AND DATE(?)
            GROUP BY agentId
        `;
        const fundedSub = `
            SELECT agentId, COUNT(*) AS fundedCount
            FROM loan_request
            WHERE status = 'funded'
            AND DATE(createdAt) BETWEEN DATE(?) AND DATE(?)
            GROUP BY agentId
        `;
        const txSub = `
            SELECT lr.agentId         AS agentId,
                SUM(CASE WHEN t.Transactiontype='disbursement' THEN 1 ELSE 0 END) AS disbursementCount,
                SUM(CASE WHEN t.Transactiontype='repayment'    THEN 1 ELSE 0 END) AS repaymentCount,
                SUM(CASE WHEN t.Transactiontype='penalty'      THEN 1 ELSE 0 END) AS penaltyCount
            FROM loan_transaction t
            JOIN loan_request lr ON lr.id = t.loanRequestId
            WHERE DATE(t.date) BETWEEN DATE(?) AND DATE(?)
            GROUP BY lr.agentId
        `;
        const clientSub = `
            SELECT agentId, COUNT(*) AS clientOnboardCount
            FROM client
            WHERE DATE(createdAt) BETWEEN DATE(?) AND DATE(?)
            GROUP BY agentId
        `;
        const docSub = `
            SELECT c.agentId        AS agentId,
                COUNT(*)         AS documentUploadCount
            FROM document d
            JOIN client c ON c.id = d.clientId
            WHERE DATE(d.createdAt) BETWEEN DATE(?) AND DATE(?)
            GROUP BY c.agentId
        `;

        // 4 · Main SQL
        const mainSql = `
            SELECT
            agent.id     AS agentId,
            agent.name   AS agentName,
            branch.id    AS branchId,
            branch.name  AS branchName,
            IFNULL(lr.loanRequestsCount,0)   AS loanRequestsCount,
            IFNULL(fu.fundedCount,0)         AS fundedCount,
            IFNULL(tx.disbursementCount,0)   AS disbursementCount,
            IFNULL(tx.repaymentCount,0)      AS repaymentCount,
            IFNULL(tx.penaltyCount,0)        AS penaltyCount,
            IFNULL(cl.clientOnboardCount,0)  AS clientOnboardCount,
            IFNULL(doc.documentUploadCount,0)AS documentUploadCount
            FROM user agent
            JOIN branch ON branch.id = agent.branchId
            LEFT JOIN (${lrSub}) lr     ON lr.agentId = agent.id
            LEFT JOIN (${fundedSub}) fu ON fu.agentId = agent.id
            LEFT JOIN (${txSub}) tx     ON tx.agentId = agent.id
            LEFT JOIN (${clientSub}) cl  ON cl.agentId = agent.id
            LEFT JOIN (${docSub}) doc   ON doc.agentId = agent.id
            WHERE 1=1
            ${caller.role === 'ADMIN' ? 'AND branch.id = ?' : ''}
            ORDER BY loanRequestsCount DESC
        `;

        // 5 · Execute
        const params = [
            start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), // lrSub
            start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), // fundedSub
            start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), // txSub
            start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), // clientSub
            start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), // docSub
        ];
        if (caller.role === 'ADMIN') params.push(caller.branchId.toString());

        const rows: Array<{
            agentId: number; agentName: string;
            branchId: number; branchName: string;
            loanRequestsCount: number; fundedCount: number;
            disbursementCount: number; repaymentCount: number; penaltyCount: number;
            clientOnboardCount: number; documentUploadCount: number;
        }> = await this.userRepo.query(mainSql, params);

        // 6 · Build blocks
        const blocks = rows.map(r => ({
            agentId:             r.agentId,
            agentName:           r.agentName,
            branchId:            r.branchId,
            branchName:          r.branchName,
            metrics: {
            loanRequestsCount:    r.loanRequestsCount,
            fundedCount:          r.fundedCount,
            disbursementCount:    r.disbursementCount,
            repaymentCount:       r.repaymentCount,
            penaltyCount:         r.penaltyCount,
            clientOnboardCount:   r.clientOnboardCount,
            documentUploadCount:  r.documentUploadCount,
            },
        }));

        // 7 · Payload
        return {
            meta: {
            startDate:   start.format('YYYY-MM-DD'),
            endDate:     end.format('YYYY-MM-DD'),
            view:        caller.role,
            generatedAt: new Date().toISOString(),
            },
            blocks,
        };
    }

 }


    



