import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Between, Repository } from 'typeorm';
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
import { Branch } from 'src/entities/branch.entity';

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
        @InjectRepository(Branch)
        private readonly branchRepo: Repository<Branch>,
        
        
        
    ) {}
    
    async getDailyCashSummary(userId: string, date?: string) {
        /* 1 · Load caller -------------------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        const businessDate = date ?? dayjs().format('YYYY-MM-DD');

        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        
        /* 2 · Base query: loan_transaction → loan_request → agent(user) → branch */
        const qb = this.txRepo
        .createQueryBuilder('t')                              // loan_transaction
        .innerJoin('loan_request', 'lr', 'lr.id = t.loanRequestId')
        .innerJoin('user', 'agent', 'agent.id = lr.agentId')  // agent row
        .innerJoin('branch', 'branch', 'branch.id = agent.branchId')
        .where('DATE(t.date) = :businessDate', { businessDate });
        
        /* 3 · Role-specific grouping -------------------------------------------- */
        let roleView: 'ADMIN' | 'MANAGER';
        if (isAdmin) {
            roleView = 'ADMIN';
            qb.andWhere('branch.id = :ownBranch', { ownBranch: caller.branchId })
            .select([
                'agent.id          AS groupId',
                'agent.name        AS groupLabel',
                't.Transactiontype AS type',
                'COUNT(*)          AS count',
                'SUM(t.amount)     AS amount',
            ]);
            qb.groupBy('agent.id, t.Transactiontype');
        } else if (isManager || isSuperAdmin) {
            roleView = 'MANAGER';
            qb.select([
                'branch.id         AS groupId',
                'branch.name       AS groupLabel',
                't.Transactiontype AS type',
                'COUNT(*)          AS count',
                'SUM(t.amount)     AS amount',
            ]);
            qb.groupBy('branch.id, t.Transactiontype');
        } else {
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
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
    
    async getDailyCashCountByAgent(
        userId: string,
        opts?: { date?: string; branchId?: string; agentId?: string },
    ) {
        /* ───────────────────────── 0. INPUTS */
        const { date, branchId, agentId } = opts ?? {};
        const businessDate = date ?? dayjs().format('YYYY-MM-DD');
        
        /* ───────────────────────── 1. CALLER  */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');

        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        
        if (!isAdmin && !isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
        }
        
        /* ───────────────────────── 2. DYNAMIC FILTERS */
        const whereCartera: string[] = ['agent.role = "AGENT"']; // ← AGENT-only
        const paramsCartera: any[] = [];
        
        const whereMov: string[] = ['DATE(t.date) = ?', 'agent.role = "AGENT"']; // ← AGENT-only
        const paramsMov: any[] = [businessDate];
        
        // Branch restrictions
        if (isAdmin) {
            whereCartera.push('branch.id = ?');
            whereMov.push('branch.id = ?');
            paramsCartera.push(caller.branchId);
            paramsMov.push(caller.branchId);
        } else if (branchId) {
            whereCartera.push('branch.id = ?');
            whereMov.push('branch.id = ?');
            paramsCartera.push(branchId);
            paramsMov.push(branchId);
        }
        
        // Optional agent filter
        if (agentId) {
            whereCartera.push('agent.id = ?');
            whereMov.push('agent.id = ?');
            paramsCartera.push(agentId);
            paramsMov.push(agentId);
        }
        
        const whereCarteraSql =
        whereCartera.length ? `WHERE ${whereCartera.join(' AND ')}` : '';
        const whereMovSql =
        whereMov.length ? `WHERE ${whereMov.join(' AND ')}` : '';
        
        /* ───────────────────────── 3. PORTFOLIO (outstanding loans) */
        const carteraSql = `
    SELECT
      agent.id                       AS agentId,
      agent.name                     AS agentName,
      branch.id                      AS branchId,
      branch.name                    AS branchName,
      IFNULL(SUM(lr.amount), 0)      AS totalLoaned,
      IFNULL(SUM(rep.repaid), 0)     AS totalRepaid
    FROM user agent
      INNER JOIN branch              ON branch.id = agent.branchId
      LEFT JOIN loan_request lr      ON lr.agentId = agent.id
      LEFT JOIN (
        SELECT loanRequestId, SUM(amount) AS repaid
        FROM   loan_transaction
        WHERE  Transactiontype = 'repayment'
        GROUP  BY loanRequestId
      ) rep                          ON rep.loanRequestId = lr.id
    ${whereCarteraSql}
    GROUP BY agent.id, agent.name, branch.id, branch.name
  `;
        const carteraRows = await this.txRepo.query(carteraSql, paramsCartera);
        
        /* ───────────────────────── 4. MOVEMENTS OF THE DAY */
        const movSql = `
    SELECT
      agent.id            AS agentId,
      t.Transactiontype   AS type,
      COUNT(*)            AS cnt,
      SUM(t.amount)       AS amt
    FROM loan_transaction t
      INNER JOIN loan_request lr ON lr.id = t.loanRequestId
      INNER JOIN user   agent    ON agent.id = lr.agentId
      INNER JOIN branch          ON branch.id = agent.branchId
    ${whereMovSql}
    GROUP BY agent.id, t.Transactiontype
  `;
        const movRows = await this.txRepo.query(movSql, paramsMov);
        
        /* ───────────────────────── 5. MERGE RESULTS */
        type Block = {
            id: number;
            label: string;
            branch: { id: number; name: string };
            metrics: {
                outstanding: number;
                repayments: { count: number; amount: number };
                disbursements: { count: number; amount: number };
                penalties: { count: number };
            };
        };
        
        const blocks: Record<number, Block> = {};
        
        for (const r of carteraRows) {
            const outstanding = +r.totalLoaned - +r.totalRepaid;
            blocks[r.agentId] = {
                id: r.agentId,
                label: `${r.agentName} (${r.branchName})`,
                branch: { id: r.branchId, name: r.branchName },
                metrics: {
                    outstanding,
                    repayments: { count: 0, amount: 0 },
                    disbursements: { count: 0, amount: 0 },
                    penalties: { count: 0 },
                },
            };
        }
        
        for (const m of movRows) {
            const blk =
            blocks[m.agentId] ??
            {
                id: m.agentId,
                label: `Agent ${m.agentId}`,
                branch: { id: 0, name: '' },
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
                case 'penalty':
                blk.metrics.penalties.count += +m.cnt;
                break;
            }
            blocks[m.agentId] = blk;
        }
        
        /* ───────────────────────── 6. GLOBAL TOTALS */
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
        
        /* ───────────────────────── 7. OUTPUT */
        return {
            meta: {
                date: businessDate,
                view: caller.role,
                generatedAt: new Date().toISOString(),
                branchFilter: branchId ?? null,
                agentFilter: agentId ?? null,
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
        
        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        
        if (!isAdmin && !isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
        }
        
        /* 2 · Build raw SQL: count and outstanding per status ---------------- */
        const ACTIVE_STATUSES = [
            "'new'",
            "'under_review'",
            "'approved'",
            "'funded'",
        ].join(',');
        
        let sql = isAdmin
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
        
        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        
        if (!isAdmin && !isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
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
        
        const params = isAdmin
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
        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        if (!isAdmin && !isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
        }
    
    /* 2 · Reference date: today ----------------------------------------- */
    const today = dayjs().startOf('day');
    
    /* 3 · Raw SQL: list every loan past due and still outstanding -------- */
    const ACTIVE_STATUSES = [
        "'funded'"
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
    
    const role = (caller.role ?? '').toUpperCase();
    const isAdmin = role === 'ADMIN';
    const isManager = role === 'MANAGER';
    const isSuperAdmin = role === 'SUPERADMIN';
    if (!isAdmin && !isManager && !isSuperAdmin) {
        throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
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
        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        if (!isAdmin && !isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
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
    
    /**
    * getNewClients
    * -------------
    * Returns every client created in [start, end] with its agent / branch
    * and, if created on the same calendar day, the matching loan_request.
    *
    * • loan_request joined with AND DATE(lr.createdAt) = DATE(c.createdAt)
    *   so only same-day loans are returned.
    * • ADMIN   → restricted to caller.branchId (if branch present).
    * • MANAGER → all branches.
    */
    async getNewClients(userId: string, startDate?: string, endDate?: string) {
        /* 1 · Caller --------------------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        if (!isAdmin && !isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
        }
        
        /* 2 · Date window ---------------------------------------------------- */
        const end   = endDate
        ? dayjs(endDate).endOf('day')
        : dayjs().endOf('day');
        
        const start = startDate
        ? dayjs(startDate).startOf('day')
        : end.clone().subtract(7, 'day').startOf('day');
        
        /* 3 · Base SQL ------------------------------------------------------- */
        const baseSql = `
        FROM client c
        /* pick ONE same-day loan via a correlated sub-query (first row) */
        LEFT JOIN loan_request lr
                ON lr.id = (
                    SELECT lr2.id
                    FROM loan_request lr2
                    WHERE lr2.clientId = c.id
                        AND DATE(lr2.createdAt) = DATE(c.createdAt)
                    ORDER BY lr2.id
                    LIMIT 1
                    )
        LEFT JOIN user    agent   ON agent.id  = lr.agentId
        LEFT JOIN branch          ON branch.id = agent.branchId
        WHERE DATE(c.createdAt) BETWEEN DATE(?) AND DATE(?)
    `;
        
        /* 3.1 · SELECT list -------------------------------------------------- */
        const selectCols = `
        c.id        AS clientId,
        c.name      AS clientName,
        c.status    AS clientStatus,
        c.createdAt AS clientCreatedAt,
        c.phone     AS clientPhone,
        c.email     AS clientEmail,
        
        lr.id       AS loanId,
        lr.amount   AS loanAmount,
        lr.status   AS loanStatus,
        lr.createdAt AS loanCreatedAt,
        
        agent.id    AS agentId,
        agent.name  AS agentName,
        
        branch.id   AS branchId,
        branch.name AS branchName
    `;
        
        /* 3.2 · Queries ------------------------------------------------------ */
        const adminSql = `
        SELECT ${selectCols}
        ${baseSql}
            AND (branch.id = ? OR branch.id IS NULL) /* ADMIN filter */
        ORDER BY c.createdAt DESC
    `;
        const managerSql = `
        SELECT ${selectCols}
        ${baseSql}
        ORDER BY c.createdAt DESC
    `;
        
        /* 4 · Params --------------------------------------------------------- */
        const paramsAdmin   = [ start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), caller.branchId ];
        const paramsManager = [ start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD') ];
        
        /* 5 · Run query ------------------------------------------------------ */
        const rows: any[] = await this.clientRepo.query(
            caller.role === 'ADMIN' ? adminSql : managerSql,
            caller.role === 'ADMIN' ? paramsAdmin : paramsManager,
        );
        
        /* 6 · Transform rows ------------------------------------------------- */
        const records = rows.map(r => ({
            client: {
                id        : r.clientId,
                name      : r.clientName,
                status    : r.clientStatus,
                createdAt : r.clientCreatedAt,
                phone     : r.clientPhone,
                email     : r.clientEmail,
            },
            loan: r.loanId ? {
                id        : r.loanId,
                amount    : r.loanAmount,
                status    : r.loanStatus,
                createdAt : r.loanCreatedAt,
                agent : r.agentId ? {
                    id   : r.agentId,
                    name : r.agentName,
                    branch: r.branchId ? { id: r.branchId, name: r.branchName } : undefined,
                } : null,
            } : null,
        }));
        
        /* 7 · Totals --------------------------------------------------------- */
        const totals = records.reduce(
            (acc, rec) => {
                acc.newCount  += 1;
                acc.loanCount += rec.loan ? 1 : 0;
                return acc;
            },
            { newCount: 0, loanCount: 0 },
        );
        
        /* 8 · Response ------------------------------------------------------- */
        return {
            meta: {
                range: `${start.format('YYYY-MM-DD')} → ${end.format('YYYY-MM-DD')}`,
                view : caller.role,
                generatedAt: new Date().toISOString(),
            },
            totals,
            records,
        };
    }
    
    /* ---------------------------------------------------------------------------
    * CLIENTES ACTIVOS vs INACTIVOS
    *   ADMIN   → bloque por agente (solo su sucursal)
    *   MANAGER → bloques por sucursal, cada uno con sus agentes
    * ------------------------------------------------------------------------ */
    async getClientsActiveInactive(
        userId: string,
        branchId?: number,
        agentId?: number,
    ) {
        /* 1 ▸ Usuario y rol --------------------------------------------------- */
        const caller = await this.userRepo.findOne({
            where: { id: +userId },
            select: ['id', 'role', 'branchId'],
        });
        if (!caller) throw new NotFoundException('User not found');
        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        if (!isAdmin && !isManager && !isSuperAdmin)
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
        
        /* 2 ▸ Qué branch se aplica por defecto ------------------------------- */
        //   ADMIN → su propia sede si no se envía branchId
        //   MANAGER → sin restricción a menos que la pida
        const effBranchId =
        isAdmin ? branchId ?? caller.branchId : branchId;
        
        /* 3 ▸ Consulta base (loan_request → agent → branch) ------------------ */
        const baseWhere: string[] = [];
        const params: any[] = [];
        
        if (agentId) {
            baseWhere.push('agent.id = ?');
            params.push(agentId);
        }
        if (effBranchId) {
            baseWhere.push('agent.branchId = ?');
            params.push(effBranchId);
        }
        const whereSql = baseWhere.length ? 'WHERE ' + baseWhere.join(' AND ') : '';
        
        // Clientes con al menos un préstamo funded (para marcar “active”)
        const activeSub = `
    SELECT DISTINCT lr.clientId
    FROM loan_request lr
    INNER JOIN user agent ON agent.id = lr.agentId
    WHERE lr.status = 'funded'
    ${baseWhere.length ? 'AND ' + baseWhere.join(' AND ') : ''}
  `;
        
        const rows = await this.clientRepo.query(
            `
    SELECT
      branch.id           AS branchId,
      branch.name         AS branchName,
      agent.id            AS agentId,
      agent.name          AS agentName,
      lr.clientId         AS clientId,
      c.name              AS clientName,
      CASE WHEN lr.status = 'funded' THEN 1 ELSE 0 END AS isActive
    FROM loan_request lr
    INNER JOIN client c  ON c.id  = lr.clientId
    INNER JOIN user  agent ON agent.id = lr.agentId
    INNER JOIN branch      ON branch.id = agent.branchId
    ${whereSql}
    UNION                   -- incluir clientes sin loan funded pero con algún loan
    SELECT
      branch.id, branch.name,
      agent.id,  agent.name,
      lr.clientId, c.name,
      0 AS isActive
    FROM loan_request lr
    INNER JOIN client c  ON c.id  = lr.clientId
    INNER JOIN user  agent ON agent.id = lr.agentId
    INNER JOIN branch      ON branch.id = agent.branchId
    LEFT  JOIN (${activeSub}) act ON act.clientId = lr.clientId
    WHERE act.clientId IS NULL
    ${whereSql ? 'AND ' + whereSql.replace('WHERE ', '') : ''}
    `,
            [...params, ...params],   // parámetros para las dos partes del UNION
        );
        
        /* 4 ▸ Agrupar resultado ---------------------------------------------- */
        if (caller.role === 'ADMIN') {
            // Agrupar solo por agente
            const agMap = new Map<number, any>();
            for (const r of rows) {
                let blk = agMap.get(r.agentId);
                if (!blk) {
                    blk = { id: r.agentId, label: r.agentName, active: 0, inactive: 0, clients: [] };
                    agMap.set(r.agentId, blk);
                }
                blk[r.isActive ? 'active' : 'inactive']++;
                blk.clients.push({
                    clientId: r.clientId, clientName: r.clientName,
                    status: r.isActive ? 'ACTIVE' : 'INACTIVE',
                });
            }
            const totals = [...agMap.values()].reduce(
                (t, b) => ({ active: t.active + b.active, inactive: t.inactive + b.inactive }),
                { active: 0, inactive: 0 },
            );
            return {
                meta: { view: 'ADMIN', generatedAt: new Date().toISOString() },
                totals,
                blocks: [...agMap.values()].sort((a, b) => (b.active + b.inactive) - (a.active + a.inactive)),
            };
        }
        
        // MANAGER → agrupar sucursal ▸ agente
        const brMap = new Map<number, any>();
        for (const r of rows) {
            let br = brMap.get(r.branchId);
            if (!br) {
                br = { branchId: r.branchId, branchName: r.branchName, active: 0, inactive: 0, agents: [] };
                brMap.set(r.branchId, br);
            }
            let ag = br.agents.find((a: any) => a.agentId === r.agentId);
            if (!ag) {
                ag = { agentId: r.agentId, agentName: r.agentName, active: 0, inactive: 0, clients: [] };
                br.agents.push(ag);
            }
            br[r.isActive ? 'active' : 'inactive']++;
            ag[r.isActive ? 'active' : 'inactive']++;
            ag.clients.push({
                clientId: r.clientId, clientName: r.clientName,
                status: r.isActive ? 'ACTIVE' : 'INACTIVE',
            });
        }
        
        const totals = [...brMap.values()].reduce(
            (t, b) => ({ active: t.active + b.active, inactive: t.inactive + b.inactive }),
            { active: 0, inactive: 0 },
        );
        
        return {
            meta: { view: 'MANAGER', generatedAt: new Date().toISOString() },
            totals,
            blocks: [...brMap.values()]
            .sort((x, y) => (y.active + y.inactive) - (x.active + x.inactive))
            .map(b => ({
                ...b,
                agents: b.agents.sort(
                    (x: any, y: any) => (y.active + y.inactive) - (x.active + x.inactive),
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
        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        if (!isAdmin && !isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
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
        branchId?: string
    ) {
        /* 1 · Validar usuario y rol ------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        const role = (caller.role ?? '').toUpperCase();
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        if (!isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only MANAGER or SUPERADMIN may call this');
        }
        
        /* 2 · Determinar rango de fechas -------------------------------------- */
        const end = endDate
        ? dayjs(endDate).endOf('day')
        : dayjs().endOf('day');
        const start = startDate
        ? dayjs(startDate).startOf('day')
        : dayjs('1970-01-01').startOf('day');  // todo el historial
        
        /* 3 · Consulta SQL: sumar lr.amount solo para funded ------------------ */
        let sql = `
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
  `;
        
        const params = [start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')];
        
        if (branchId) {
            sql += ` AND branch.id = ?`;
            params.push(branchId);
        }
        
        sql += `
    GROUP BY branch.id, branch.name, agent.id, agent.name
    ORDER BY branch.id, totalLoaned DESC
  `;
        
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
                branchId:  branchId ?? null,
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
        filters?: { agentId?: number; branchId?: number }
    ) {
        /* 1 · Validar usuario y rol ------------------------------------------- */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        const role = (caller.role ?? '').toUpperCase();
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        if (!isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only GERENTE or SUPERADMIN may call this');
        }
        
        /* 2 · Determinar rango de fechas -------------------------------------- */
        const end = endDate
        ? dayjs(endDate).endOf('day')
        : dayjs().endOf('day');
        const start = startDate
        ? dayjs(startDate).startOf('day')
        : dayjs('1970-01-01').startOf('day');
        
        /* 3 · Construir cláusulas dinámicas para filtros ---------------------- */
        const conditions: string[] = [
            `t.Transactiontype = 'repayment'`,
            `DATE(t.date) BETWEEN DATE(?) AND DATE(?)`,
        ];
        const params: (string | number)[] = [
            start.format('YYYY-MM-DD'),
            end.format('YYYY-MM-DD'),
        ];
        
        if (filters?.branchId) {
            conditions.push(`agent.branchId = ?`);
            params.push(filters.branchId);
        }
        if (filters?.agentId) {
            conditions.push(`agent.id = ?`);
            params.push(filters.agentId);
        }
        
        const whereClause = conditions.join(' AND ');
        
        /* 4 · Consulta SQL con filtros aplicados ------------------------------- */
        const sql = `
            SELECT
            branch.id      AS branchId,
            branch.name    AS branchName,
            agent.id       AS agentId,
            agent.name     AS agentName,
            IFNULL(SUM(t.amount), 0) AS totalCollected
            FROM loan_transaction t
            INNER JOIN loan_request lr ON lr.id = t.loanRequestId
            INNER JOIN user agent      ON agent.id = lr.agentId
            INNER JOIN branch          ON branch.id = agent.branchId
            WHERE ${whereClause}
            GROUP BY branch.id, branch.name, agent.id, agent.name
            ORDER BY branch.id, totalCollected DESC
        `;
        
        const rows: {
            branchId: number;
            branchName: string;
            agentId: number;
            agentName: string;
            totalCollected: string;
        }[] = await this.txRepo.query(sql, params);
        
        /* 5 · Construir estructura por sucursal → agentes ------------------- */
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
                    branchId: r.branchId,
                    branchName: r.branchName,
                    totalCollected: 0,
                    agents: [],
                };
                branchMap.set(r.branchId, br);
            }
            const amt = Number(r.totalCollected);
            br.totalCollected += amt;
            br.agents.push({
                agentId: r.agentId,
                agentName: r.agentName,
                totalCollected: amt,
            });
        }
        
        /* 6 · Totales generales --------------------------------------------- */
        const grandTotal = Array.from(branchMap.values())
        .reduce((sum, b) => sum + b.totalCollected, 0);
        
        /* 7 · Payload -------------------------------------------------------- */
        return {
            meta: {
                startDate: start.format('YYYY-MM-DD'),
                endDate: end.format('YYYY-MM-DD'),
                view: caller.role,
                generatedAt: new Date().toISOString(),
                filters: {
                    agentId: filters?.agentId ?? null,
                    branchId: filters?.branchId ?? null,
                },
            },
            totals: {
                totalCollected: grandTotal,
            },
            blocks: Array.from(branchMap.values()).map(b => ({
                branchId: b.branchId,
                branchName: b.branchName,
                totalCollected: b.totalCollected,
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
    
    DOC_TYPE_LABELS: Record<string, string> = {
        ID: 'Cédula',
        WORK_LETTER: 'Carta laboral',
        UTILITY_BILL: 'Recibo',
        PAYMENT_DETAIL: 'Desprendible de pago',
        OTHER: 'Otro documento',
    };
    
    VALID_DOC_TYPES = Object.keys(this.DOC_TYPE_LABELS);
    
    async getDocumentsByClient(
        userId: string,
        startDate?: string,
        endDate?: string,
        docType?: string,
        clientId?: number
    ) {
        // 1 · Validar usuario y rol
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        if (!isAdmin && !isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
        }
        
        // 2 · Fechas
        const start = startDate
        ? dayjs(startDate).startOf('day')
        : dayjs('1970-01-01').startOf('day');
        const end = endDate
        ? dayjs(endDate).endOf('day')
        : dayjs().endOf('day');
        
        // 3 · Diccionario de etiquetas
        const DOC_TYPE_LABELS: Record<string, string> = {
            ID: 'Cédula',
            WORK_LETTER: 'Carta laboral',
            UTILITY_BILL: 'Recibo',
            PAYMENT_DETAIL: 'Desprendible de pago',
            OTHER: 'Otro documento',
            UNKNOWN: 'Desconocido',
        };
        
        // 4 · Query
        const qb = this.docRepo.createQueryBuilder('d')
        .innerJoin('d.client', 'c')
        .where('d.createdAt BETWEEN :start AND :end', {
            start: start.toISOString(),
            end: end.toISOString(),
        });
        
        if (docType) {
            qb.andWhere('d.classification = :docType', { docType });
        }
        
        if (clientId) {
            qb.andWhere('c.id = :clientId', { clientId });
        }
        
        qb.select([
            'c.id               AS clientId',
            'c.name             AS clientName',
            'd.id               AS docId',
            'd.classification   AS classification',
            'd.createdAt        AS uploadedAt',
            'd.url              AS url' 
        ]);
        
        const rows: {
            clientId: number;
            clientName: string;
            docId: string;
            classification: string | null;
            uploadedAt: Date;
            url : string;
        }[] = await qb.getRawMany();
        
        // 5 · Agrupación
        const map = new Map<number, {
            clientId: number;
            clientName: string;
            totalDocs: number;
            byType: Record<string, number>;
            documents: {
                docId: string;
                type: string;
                uploadedAt: Date;
                label: string;
                url : string;
            }[];
        }>();
        
        for (const r of rows) {
            let blk = map.get(r.clientId);
            if (!blk) {
                blk = {
                    clientId: r.clientId,
                    clientName: r.clientName,
                    totalDocs: 0,
                    byType: {},
                    documents: [],
                };
                map.set(r.clientId, blk);
            }
            
            const typeKey = r.classification?.toUpperCase() || 'UNKNOWN';
            const label = DOC_TYPE_LABELS[typeKey] ?? 'Desconocido';
            
            blk.totalDocs += 1;
            blk.byType[typeKey] = (blk.byType[typeKey] ?? 0) + 1;
            blk.documents.push({
                docId: r.docId,
                type: typeKey,
                uploadedAt: r.uploadedAt,
                label,
                url : r.url,
            });
        }
        
        const totalDocuments = Array.from(map.values())
        .reduce((sum, b) => sum + b.totalDocs, 0);
        
        return {
            meta: {
                startDate: start.format('YYYY-MM-DD'),
                endDate: end.format('YYYY-MM-DD'),
                docType: docType ?? 'all',
                clientId: clientId ?? null,
                view: caller.role,
                generatedAt: new Date().toISOString(),
            },
            totals: { totalDocuments },
            blocks: Array.from(map.values()).sort((a, b) => b.totalDocs - a.totalDocs),
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
  branchId?: string,
  agentId?: string,
) {
  const caller = await this.userRepo.findOne({ where: { id: +userId } });
  if (!caller) throw new NotFoundException('User not found');
  const role = (caller.role ?? '').toUpperCase();
  const isAdmin = role === 'ADMIN';
  const isManager = role === 'MANAGER';
  const isSuperAdmin = role === 'SUPERADMIN';
  if (!isAdmin && !isManager && !isSuperAdmin) {
    throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
  }

  const end = endDate ? dayjs(endDate).endOf('day') : dayjs().endOf('day');
  const start = startDate ? dayjs(startDate).startOf('day') : end.startOf('month');

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
    SELECT lr.agentId AS agentId,
      SUM(CASE WHEN t.Transactiontype='disbursement' THEN 1 ELSE 0 END) AS disbursementCount,
      SUM(CASE WHEN t.Transactiontype='repayment' THEN 1 ELSE 0 END)         AS repaymentCount,
      SUM(CASE WHEN t.Transactiontype='penalty' THEN 1 ELSE 0 END)           AS penaltyCount
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
    SELECT c.agentId AS agentId,
      COUNT(*) AS documentUploadCount
    FROM document d
    JOIN client c ON c.id = d.clientId
    WHERE DATE(d.createdAt) BETWEEN DATE(?) AND DATE(?)
    GROUP BY c.agentId
  `;

  let where = 'WHERE 1=1';
  const sqlParams = [
    start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), // lrSub
    start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), // fundedSub
    start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), // txSub
    start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), // clientSub
    start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'), // docSub
  ];

  // NOTE: Admin is constrained to own branch (as per your current rule).
  if (caller.role === 'ADMIN') {
    where += ' AND branch.id = ?';
    sqlParams.push(caller.branchId.toString());
    if (agentId) {
      where += ' AND agent.id = ?';
      sqlParams.push(agentId);
    }
  }

  if (caller.role === 'MANAGER') {
    if (branchId) {
      where += ' AND branch.id = ?';
      sqlParams.push(branchId);
    }
    if (agentId) {
      where += ' AND agent.id = ?';
      sqlParams.push(agentId);
    }
  }

  const mainSql = `
    SELECT
      agent.id   AS agentId,
      agent.name AS agentName,
      branch.id  AS branchId,
      branch.name AS branchName,
      IFNULL(lr.loanRequestsCount, 0)   AS loanRequestsCount,
      IFNULL(fu.fundedCount, 0)         AS fundedCount,
      IFNULL(tx.disbursementCount, 0)   AS disbursementCount,
      IFNULL(tx.repaymentCount, 0)      AS repaymentCount,
      IFNULL(tx.penaltyCount, 0)        AS penaltyCount,
      IFNULL(cl.clientOnboardCount, 0)  AS clientOnboardCount,
      IFNULL(doc.documentUploadCount, 0) AS documentUploadCount
    FROM user agent
    JOIN branch ON branch.id = agent.branchId
    LEFT JOIN (${lrSub})    lr  ON lr.agentId  = agent.id
    LEFT JOIN (${fundedSub}) fu  ON fu.agentId  = agent.id
    LEFT JOIN (${txSub})     tx  ON tx.agentId  = agent.id
    LEFT JOIN (${clientSub}) cl  ON cl.agentId  = agent.id
    LEFT JOIN (${docSub})    doc ON doc.agentId = agent.id
    ${where} AND agent.role = 'AGENT'
    ORDER BY branch.name, agent.name
  `;

  const rows = await this.userRepo.query(mainSql, sqlParams);

  // Group by branch
  const branchMap = new Map<number, {
    branchId: number;
    branchName: string;
    agents: any[];
  }>();

  for (const row of rows) {
    if (!branchMap.has(row.branchId)) {
      branchMap.set(row.branchId, {
        branchId: row.branchId,
        branchName: row.branchName,
        agents: [],
      });
    }

    branchMap.get(row.branchId)!.agents.push({
      agentId: row.agentId,
      agentName: row.agentName,
      metrics: {
        loanRequestsCount: row.loanRequestsCount,
        fundedCount: row.fundedCount,
        disbursementCount: row.disbursementCount,
        repaymentCount: row.repaymentCount,
        penaltyCount: row.penaltyCount,
        clientOnboardCount: row.clientOnboardCount,
        documentUploadCount: row.documentUploadCount,
      },
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // totals: sum across all returned agents (respecting the applied filters)
  // ────────────────────────────────────────────────────────────────────────────
  const totals = {
    /** Total number of loan requests created in range */
    loanRequestsCount: 0,
    /** Total number of funded loan requests created in range */
    fundedCount: 0,
    /** Total number of disbursement transactions in range */
    disbursementCount: 0,
    /** Total number of repayment transactions in range */
    repaymentCount: 0,
    /** Total number of penalty transactions in range */
    penaltyCount: 0,
    /** Total number of newly onboarded clients in range */
    clientOnboardCount: 0,
    /** Total number of uploaded documents in range */
    documentUploadCount: 0,
    /** Optional useful aggregates */
    branches: branchMap.size,
    agents: rows.length,
  };

  for (const r of rows) {
    totals.loanRequestsCount     += Number(r.loanRequestsCount) || 0;
    totals.fundedCount           += Number(r.fundedCount) || 0;
    totals.disbursementCount     += Number(r.disbursementCount) || 0;
    totals.repaymentCount        += Number(r.repaymentCount) || 0;
    totals.penaltyCount          += Number(r.penaltyCount) || 0;
    totals.clientOnboardCount    += Number(r.clientOnboardCount) || 0;
    totals.documentUploadCount   += Number(r.documentUploadCount) || 0;
  }

  return {
    meta: {
      view: caller.role,
      startDate: start.format('YYYY-MM-DD'),
      endDate: end.format('YYYY-MM-DD'),
      filters: {
        branchId: branchId ? +branchId : undefined,
        agentId: agentId ? +agentId : undefined,
      },
      generatedAt: new Date().toISOString(),
    },
    totals,                         // ← agregado al mismo nivel de blocks
    blocks: Array.from(branchMap.values()),
  };
}

    
    async getApprovalTimeReport(
        userId: number,
        startDate?: string,
        endDate?: string,
        branchId?: number,
        agentId?: number
    ) {
        const caller = await this.userRepo.findOne({ where: { id: userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        const role = (caller.role ?? '').toUpperCase();
        const isManager = role === 'MANAGER';
        const isAdmin   = role === 'ADMIN';
        const isSuperAdmin = role === 'SUPERADMIN';
        
        if (!isManager && !isAdmin && !isSuperAdmin) {
            throw new ForbiddenException('Only MANAGER, ADMIN or SUPERADMIN may access this report');
        }
        
        const start = startDate ? dayjs(startDate).startOf('day') : dayjs().subtract(30, 'day').startOf('day');
        const end   = endDate   ? dayjs(endDate).endOf('day')     : dayjs().endOf('day');
        
        // Buscar loans dentro del rango y relaciones necesarias
        const loans = await this.loanRepo.find({
            where: {
                createdAt: Between(start.toDate(), end.toDate()),
                ...(agentId ? { agent: { id: agentId } } : {})
            },
            relations: ['agent', 'agent.branch', 'client', 'transactions']
        });
        
        // Filtrar por disbursement y branch (solo si aplica)
        const filtered = loans.filter(loan => {
            const hasDisbursement = loan.transactions?.some(tx => tx.Transactiontype === 'disbursement');
            const belongsToBranch = isAdmin
            ? loan.agent.branch.id === caller.branchId
            : (!branchId || loan.agent.branch.id === branchId);
            return hasDisbursement && belongsToBranch;
        });
        
        const byAgent = new Map<number, {
            agentId: number;
            agentName: string;
            branchId: number;
            branchName: string;
            durations: number[];
        }>();
        
        for (const loan of filtered) {
            const disbursement = loan.transactions
            .filter(t => t.Transactiontype === 'disbursement')
            .sort((a, b) => +a.date - +b.date)[0];
            
            if (!disbursement) continue;
            
            const timeInMs = disbursement.date.getTime() - loan.createdAt.getTime();
            let timeInDays = timeInMs / (1000 * 60 * 60 * 24);
            
            if (timeInDays < 0) {
                timeInDays = 1;
            }            
            const agentId = loan.agent.id;
            if (!byAgent.has(agentId)) {
                byAgent.set(agentId, {
                    agentId,
                    agentName: loan.agent.name,
                    branchId: loan.agent.branch.id,
                    branchName: loan.agent.branch.name,
                    durations: []
                });
            }
            
            byAgent.get(agentId)!.durations.push(timeInDays);
        }
        
        const details = Array.from(byAgent.values()).map(entry => ({
            agentId: entry.agentId,
            agentName: entry.agentName,
            branchId: entry.branchId,
            branchName: entry.branchName,
            loansCount: entry.durations.length,
            averageTime: parseInt((entry.durations.reduce((a, b) => a + b, 0) / entry.durations.length).toFixed(1))
        }));
        
        const allDurations = details.flatMap(d => byAgent.get(d.agentId)?.durations ?? []);
        const totalAvg = allDurations.length > 0
        ? (allDurations.reduce((a, b) => a + b, 0) / allDurations.length).toFixed(1)
        : 0;
        
        return {
            meta: {
                view: caller.role,
                startDate: start.format('YYYY-MM-DD'),
                endDate: end.format('YYYY-MM-DD'),
                branchId: isAdmin ? caller.branchId : (branchId ?? null),
                agentId: agentId ?? null
            },
            averageDisbursementTime:totalAvg,
            details
        };
    }
    
    
    async getCashFlowReport(
        userId: number,
        startDate?: string,
        endDate?: string
    ) {
        const caller = await this.userRepo.findOne({ where: { id: userId } });
        if (!caller) throw new NotFoundException('User not found');
        if (caller.role !== 'MANAGER') {
            throw new ForbiddenException('Only MANAGER may access this report');
        }
        
        const start = startDate
        ? dayjs(startDate).startOf('day')
        : dayjs().subtract(30, 'day').startOf('day');
        
        const end = endDate
        ? dayjs(endDate).endOf('day')
        : dayjs().endOf('day');
        
        // Traer todas las transacciones dentro del rango
        const transactions = await this.txRepo.find({
            where: {
                date: Between(start.toDate(), end.toDate())
            }
        });
        
        // Agrupar por fecha
        const dayMap = new Map<string, {
            disbursed: number;
            repayments: number;
            penalties: number;
        }>();
        
        for (const tx of transactions) {
            const day = dayjs(tx.date).format('YYYY-MM-DD');
            
            if (!dayMap.has(day)) {
                dayMap.set(day, {
                    disbursed: 0,
                    repayments: 0,
                    penalties: 0
                });
            }
            
            const entry = dayMap.get(day)!;
            const amount = Number(tx.amount);
            
            switch (tx.Transactiontype) {
                case 'disbursement':
                entry.disbursed += amount;
                break;
                case 'repayment':
                entry.repayments += amount;
                break;
                case 'penalty':
                entry.penalties += amount;
                break;
            }
        }
        
        // Convertir a arreglo ordenado por fecha
        const dailyBreakdown = Array.from(dayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, entry]) => ({
            date,
            disbursed: entry.disbursed,
            repayments: entry.repayments,
            penalties: entry.penalties,
            netFlow: entry.repayments + entry.penalties - entry.disbursed
        }));
        
        // Sumar totales
        const summary = dailyBreakdown.reduce(
            (acc, d) => {
                acc.disbursed += d.disbursed;
                acc.repayments += d.repayments;
                acc.penalties += d.penalties;
                return acc;
            },
            { disbursed: 0, repayments: 0, penalties: 0 }
        );
        
        const netFlow = summary.repayments + summary.penalties - summary.disbursed;
        
        return {
            meta: {
                view: caller.role,
                startDate: start.format('YYYY-MM-DD'),
                endDate: end.format('YYYY-MM-DD')
            },
            summary: {
                ...summary,
                netFlow
            },
            dailyBreakdown
        };
    }
    
    
    async getTransactionsDetail(
        userId: number,
        startDate?: string,
        endDate?: string,
        branchId?: string,
        agentId?: string,
    ) {
        const caller = await this.userRepo.findOne({ where: { id: userId } });
        if (!caller) throw new NotFoundException('User not found');
        const role = (caller.role ?? '').toUpperCase();
        const isAdmin = role === 'ADMIN';
        const isManager = role === 'MANAGER';
        const isSuperAdmin = role === 'SUPERADMIN';
        if (!isAdmin && !isManager && !isSuperAdmin) {
            throw new ForbiddenException('Only ADMIN, MANAGER or SUPERADMIN may call this');
        }
        
        const start = startDate ? dayjs(startDate).startOf('day') : null;
        const end   = endDate   ? dayjs(endDate).endOf('day')     : null;
        
        const qb = this.txRepo
        .createQueryBuilder('tx')
        .innerJoinAndSelect('tx.loanRequest', 'loanRequest')
        .innerJoinAndSelect('loanRequest.client', 'client')
        .innerJoinAndSelect('loanRequest.agent', 'agent')
        .innerJoinAndSelect('agent.branch', 'branch');
        
        if (start)   qb.andWhere('tx.date >= :startDate', { startDate: start.toDate() });
        if (end)     qb.andWhere('tx.date <= :endDate', { endDate: end.toDate() });
        if (agentId) qb.andWhere('agent.id = :agentId',   { agentId: +agentId });
        if (branchId)qb.andWhere('branch.id = :branchId', { branchId: +branchId });
        
        if (caller.role === 'ADMIN' && !branchId) {
            qb.andWhere('branch.id = :adminBranch', { adminBranch: caller.branchId });
        }
        
        const rows = await qb.orderBy('tx.date', 'DESC').getMany();
        
        let skipped = 0;
        const transactionsOut: any[] = [];
        
        for (const tx of rows) {
            const lr = tx.loanRequest;
            const cl = lr?.client;
            const ag = lr?.agent;
            const br = ag?.branch;
            
            if (!lr || !cl || !ag || !br) {
                skipped++;
                continue;
            }
            
            transactionsOut.push({
                id: tx.id,
                type: tx.Transactiontype,
                amount: tx.amount,
                date: tx.date,
                client: { id: cl.id, name: cl.name },
                agent:  { id: ag.id, name: ag.name },
                branch: { id: br.id, name: br.name },
            });
        }
        
        return {
            meta: {
                view: caller.role,
                startDate: start ? start.format('YYYY-MM-DD') : null,
                endDate:   end   ? end.format('YYYY-MM-DD')   : null,
                branchId:  branchId ? +branchId : (caller.role === 'ADMIN' ? caller.branchId : null),
                agentId:   agentId ? +agentId : null,
                total:     transactionsOut.length,
                skipped,
            },
            transactions: transactionsOut,
        };
    }
    
    
    async getBranchStatsReport(
        userId: number,
        startDate?: string,
        endDate?: string,
    ) {
        const caller = await this.userRepo.findOne({ where: { id: userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        if (caller.role !== 'MANAGER' && caller.role !== 'ADMIN') {
            throw new ForbiddenException('Only MANAGER or ADMIN may access this report');
        }
        
        const start = startDate ? dayjs(startDate).startOf('day') : dayjs().subtract(30, 'day').startOf('day');
        const end = endDate ? dayjs(endDate).endOf('day') : dayjs().endOf('day');
        
        // ADMIN: limitar solo a su sede
        const adminBranchId = caller.role === 'ADMIN' ? caller.branchId : null;
        
        // 1) Obtener préstamos
        const loans = await this.loanRepo.find({
            where: {
                createdAt: Between(start.toDate(), end.toDate()),
            },
            relations: ['agent', 'agent.branch', 'client'],
        });
        
        const filteredLoans = adminBranchId
        ? loans.filter(l => l.agent.branch.id === adminBranchId)
        : loans;
        
        // 2) Obtener transacciones
        const transactions = await this.txRepo.find({
            where: {
                date: Between(start.toDate(), end.toDate()),
            },
            relations: ['loanRequest', 'loanRequest.agent', 'loanRequest.agent.branch'],
        });
        
        const filteredTx = adminBranchId
        ? transactions.filter(tx => tx.loanRequest.agent.branch.id === adminBranchId)
        : transactions;
        
        const branchMap: Map<number, any> = new Map();
        
        function getBranchEntry(bId: number, bName: string) {
            let entry = branchMap.get(bId);
            if (!entry) {
                entry = {
                    branchId: bId,
                    branchName: bName,
                    totalLoaned: 0,
                    totalDisbursed: 0,
                    totalCollected: 0,
                    penalties: 0,
                    repayments: 0,
                    activeClients: 0,
                    overdueAmount: 0,
                    overdueLoans: 0,
                    clientsSet: new Set<number>(),
                };
                branchMap.set(bId, entry);
            }
            return entry;
        }
        
        // 3.a) Procesar préstamos
        for (const lr of filteredLoans) {
            const bId = lr.agent.branch.id;
            const bName = lr.agent.branch.name;
            const entry = getBranchEntry(bId, bName);
            
            entry.totalLoaned += Number(lr.amount);
            
            const isActive = ['funded', 'approved'].includes((lr.status || '').toLowerCase());
            if (isActive && lr.client?.id) {
                entry.clientsSet.add(lr.client.id);
            }
            
            const txsForLoan = filteredTx.filter(
                tx => tx.loanRequest?.id === lr.id && tx.Transactiontype === 'repayment'
            );
            
            const totalPaid = txsForLoan.reduce((sum, tx) => sum + Number(tx.amount), 0);
            const pendingAmount = Number(lr.amount) - totalPaid;
            
            if (lr.endDateAt && dayjs(lr.endDateAt).isBefore(end) && pendingAmount > 0) {
                entry.overdueAmount += pendingAmount;
                entry.overdueLoans += 1;
            }
        }
        // 3.b) Procesar transacciones
        for (const tx of filteredTx) {
            if (!tx.loanRequest?.agent?.branch) continue; // Seguridad ante datos incompletos
            
            const bId = tx.loanRequest.agent.branch.id;
            const bName = tx.loanRequest.agent.branch.name;
            const entry = getBranchEntry(bId, bName);
            
            const amount = Number(tx.amount);
            switch (tx.Transactiontype) {
                case 'disbursement':
                entry.totalDisbursed += amount;
                break;
                case 'repayment':
                entry.repayments += amount;
                entry.totalCollected += amount;
                break;
                case 'penalty':
                entry.penalties += amount;
                entry.totalCollected += amount;
                break;
            }
        }
        
        
        // 4) Construir bloques
        const branches = Array.from(branchMap.values()).map(b => {
            b.activeClients = b.clientsSet.size;
            delete b.clientsSet;
            b.netFlow = (b.repayments + b.penalties) - b.totalDisbursed;
            return b;
        });
        
        // 5) Totales globales
        const totals = branches.reduce((acc, b) => {
            acc.totalLoaned += b.totalLoaned;
            acc.totalDisbursed += b.totalDisbursed;
            acc.totalCollected += b.totalCollected;
            acc.repayments += b.repayments;
            acc.penalties += b.penalties;
            acc.activeClients += b.activeClients;
            acc.overdueAmount += b.overdueAmount;
            acc.overdueLoans += b.overdueLoans;
            acc.netFlow += b.netFlow;
            return acc;
        }, {
            totalLoaned: 0,
            totalDisbursed: 0,
            totalCollected: 0,
            repayments: 0,
            penalties: 0,
            activeClients: 0,
            overdueAmount: 0,
            overdueLoans: 0,
            netFlow :0
        });
        
        return {
            meta: {
                view: caller.role,
                startDate: start.format('YYYY-MM-DD'),
                endDate: end.format('YYYY-MM-DD'),
                generatedAt: new Date().toISOString(),
            },
            totals,
            branches: branches.sort((a, b) => a.branchId - b.branchId),
        };
    }

    /* ---------------------------------------------------------------------------
    * MARKETING · CHAT SUMMARY (stub inicial)
    *   - Por ahora solo valida usuario/fechas y devuelve estructura vacía,
    *     para permitir compilar y dejar listo el contrato del endpoint.
    *   - Más adelante se implementará el cálculo real (volumen chats, 24h, etc.).
    * ------------------------------------------------------------------------ */
    async getMarketingChatSummary(
        userId: number,
        startDate?: string,
        endDate?: string,
    ) {
        const caller = await this.userRepo.findOne({ where: { id: userId } });
        if (!caller) throw new NotFoundException('User not found');

        const allowedRoles = ['MANAGER', 'ADMIN', 'SUPERADMIN', 'MARKETING'];
        if (!allowedRoles.includes(caller.role)) {
            throw new ForbiddenException('Only MANAGER, ADMIN, SUPERADMIN or MARKETING may access this report');
        }

        const end = endDate
            ? dayjs(endDate).endOf('day')
            : dayjs().endOf('day');
        const start = startDate
            ? dayjs(startDate).startOf('day')
            : end.clone().subtract(7, 'day').startOf('day');

        return {
            meta: {
                view: caller.role,
                startDate: start.format('YYYY-MM-DD'),
                endDate: end.format('YYYY-MM-DD'),
                generatedAt: new Date().toISOString(),
            },
            totals: {
                totalDistinctClients: 0,
                clientsManagedWithin24h: 0,
                clientsUnmanaged: 0,
                clientsRespondedAfter24h: 0,
            },
            perDay: [],
        };
    }

}
