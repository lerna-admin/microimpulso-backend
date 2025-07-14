import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import * as dayjs from 'dayjs';
import 'dayjs/plugin/timezone';
import 'dayjs/plugin/utc';
import { LoanTransaction } from 'src/entities/transaction.entity';
import { User } from 'src/entities/user.entity';
import { LoanRequest } from 'src/entities/loan-request.entity';

@Injectable()
export class ReportsService {
    constructor(
        @InjectRepository(LoanTransaction)
        private readonly txRepo: Repository<LoanTransaction>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
        @InjectRepository(LoanRequest)
        private readonly loanRepo: Repository<LoanRequest>,
        
    ) {}
    
    async getDailyCashSummary(userId: string, date?: string) {
        /* 1 · Load caller ------------------------------------------------------ */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        const businessDate =
        date ?? dayjs().format('YYYY-MM-DD');
        
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
    
    /* ---------------------------------------------------------------------------
    * ACTIVE LOANS BY STATUS REPORT
    *   - ADMIN   → shows only loans in caller's branch
    *   - MANAGER → shows loans across all branches
    * ------------------------------------------------------------------------ */
    async getActiveLoansByStatus(userId: string) {
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
        
        const sql = caller.role === 'ADMIN'
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
        
        const rows: { status: string; cnt: number; outstanding: number }[] =
        caller.role === 'ADMIN'
        ? await this.loanRepo.query(sql, [caller.branchId])
        : await this.loanRepo.query(sql);
        
        /* 3 · Totals ---------------------------------------------------------- */
        const totals = rows.reduce(
            (acc, r) => {
                acc.count += r.cnt;
                acc.outstanding += r.outstanding;
                return acc;
            },
            { count: 0, outstanding: 0 },
        );
        
        /* 4 · Payload --------------------------------------------------------- */
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
            branch.name            AS branchName
        FROM loan_request lr
            INNER JOIN user agent  ON agent.id  = lr.agentId
            INNER JOIN branch      ON branch.id = agent.branchId
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
            branch.name            AS branchName
        FROM loan_request lr
            INNER JOIN user agent  ON agent.id  = lr.agentId
            INNER JOIN branch      ON branch.id = agent.branchId
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
            branch.name            AS branchName
        FROM loan_request lr
            INNER JOIN user agent  ON agent.id  = lr.agentId
            INNER JOIN branch      ON branch.id = agent.branchId
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
            branch.name            AS branchName
        FROM loan_request lr
            INNER JOIN user agent  ON agent.id  = lr.agentId
            INNER JOIN branch      ON branch.id = agent.branchId
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
        totals,
        blocks,
    };
    }



}
