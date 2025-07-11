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
        /* ── 1 · load caller ── */
        const caller = await this.userRepo.findOne({ where: { id: +userId } });
        if (!caller) throw new NotFoundException('User not found');
        
        const businessDate = date ?? dayjs().tz('America/Bogota').format('YYYY-MM-DD');
        
        /* ── 2 · base query: join through loan_request → agent(user) → branch ── */
        const qb = this.txRepo
        .createQueryBuilder('t')                                              // loan_transaction
        .innerJoin('loan_request', 'lr', 'lr.id = t.loanRequestId')
        .innerJoin('user',         'agent', 'agent.id = lr.agentId')         // agent is a user
        .innerJoin('branch',       'branch', 'branch.id = agent.branchId')   // names table may differ
        .where('DATE(t.date) = :businessDate', { businessDate });
        
        /* ── 3 · role-specific grouping ── */
        let roleView: 'ADMIN' | 'MANAGER';
        if (caller.role === 'ADMIN') {
            roleView = 'ADMIN';
            qb.andWhere('branch.id = :ownBranch', { ownBranch: caller.branchId })   // force own branch
            .select([
                'agent.id              AS groupId',     // per-agent
                'agent.name            AS groupLabel',
                't.Transactiontype     AS type',
                'COUNT(*)              AS count',
                'SUM(t.amount)         AS amount',
            ])
            .groupBy('agent.id, t.Transactiontype');
        } else if (caller.role === 'MANAGER') {
            roleView = 'MANAGER';
            qb.select([
                'branch.id             AS groupId',     // per-branch
                'branch.name           AS groupLabel',
                't.Transactiontype     AS type',
                'COUNT(*)              AS count',
                'SUM(t.amount)         AS amount',
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
        
        /* ── 4 · fold rows → view blocks ── */
        const blocks: Record<string, {
            id: string;
            label: string;
            kpi: { totalCollected: number; cashPaidOut: number; netBalance: number; transactionCount: number };
            breakdown: { type: string; count: number; amount: number }[];
        }> = {};
        
        for (const r of rows) {
            const key = r.groupId;
            if (!blocks[key]) {
                blocks[key] = {
                    id: key,
                    label: r.groupLabel,
                    kpi: { totalCollected: 0, cashPaidOut: 0, netBalance: 0, transactionCount: 0 },
                    breakdown: [],
                };
            }
            const blk = blocks[key];
            const amt = +r.amount;
            blk.breakdown.push({ type: r.type, count: +r.count, amount: amt });
            blk.kpi.transactionCount += +r.count;
            if (amt >= 0) blk.kpi.totalCollected += amt;
            else          blk.kpi.cashPaidOut   += -amt;
            blk.kpi.netBalance = blk.kpi.totalCollected - blk.kpi.cashPaidOut;
        }
        
        /* ── 5 · response ── */
        return {
            meta: {
                date: businessDate,
                view: roleView,                    // ADMIN or MANAGER
                generatedAt: new Date().toISOString(),
            },
            blocks: Object.values(blocks),       // array of per-agent or per-branch sections
        };
    }
    
    
}
