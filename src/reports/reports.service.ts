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
    
    
    
}
