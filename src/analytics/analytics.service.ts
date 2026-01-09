import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { Branch } from 'src/entities/branch.entity';
import { AnalyticsReport, AnalyticsMonthlyReport, AnalyticsYearlyReport } from './analytics.model';
import { LoanTransaction, TransactionType } from 'src/entities/transaction.entity';
import { User } from 'src/entities/user.entity';
import { Country } from 'src/entities/country.entity';
import { SuperAdminGlobalSummary } from './analytics-superadmin.dto';
export interface FundedByBranchComparison {
branchId: number;
branchName: string;
currentMonthFunded: number;
previousMonthFunded: number;
}
type FundedBranchStat = {
branchId: number;
branchName: string;
month: string;
totalAmount: number;
count: number;
};



@Injectable()
export class AnalyticsService {
    constructor( 
        @InjectRepository(LoanRequest)
        private readonly loanRequestRepo: Repository<LoanRequest>,
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,  
        @InjectRepository(LoanTransaction)
        private readonly loanTransactionRepository: Repository<LoanTransaction>,
        @InjectRepository(Country)
        private readonly countryRepository: Repository<Country>,

        ) {
            
    }

    // Return the first and last day of the given month
    private getDateRangeOfMonth(year: number, month: number): { start: Date; end: Date } {
        const start = new Date(year, month, 1);
        const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
        return { start, end };
    }
    /**
     * Global summary for SUPERADMIN
     * Aggregates key KPIs by country (all branches, all agents).
     */
    async getSuperAdminGlobalSummary(
      userId: number,
      startDate?: string,
      endDate?: string,
    ): Promise<SuperAdminGlobalSummary> {
      const caller = await this.userRepository.findOne({ where: { id: userId }, relations: { branch: { country: true }, managerCountry: true } as any });
      if (!caller) throw new NotFoundException('User not found');
      const role = String(caller.role ?? '').toUpperCase();
      if (role !== 'SUPERADMIN') {
        throw new ForbiddenException('Only SUPERADMIN may access this overview');
      }

      const end = endDate ? new Date(endDate + 'T23:59:59.999Z') : new Date();
      const start = startDate ? new Date(startDate + 'T00:00:00.000Z') : new Date(end.getFullYear(), end.getMonth(), 1);

      // Active loans: funded or renewed
      const ACTIVE_STATUSES: LoanRequestStatus[] = [
        LoanRequestStatus.FUNDED,
        LoanRequestStatus.RENEWED,
      ];

      const loans = await this.loanRequestRepo.find({
        where: {
          createdAt: Between(start, end),
        },
        relations: ['agent', 'agent.branch', 'agent.branch.country', 'client', 'transactions'],
      });

      // Helper: determine country for a loan (via agent.branch.country or client.countryId).
      const countryCache = new Map<number, Country>();
      const getCountryForLoan = async (loan: LoanRequest): Promise<Country | null> => {
        const branchCountry = (loan as any)?.agent?.branch?.country as Country | undefined;
        if (branchCountry) return branchCountry;
        const clientCountryId = (loan as any)?.client?.countryId as number | undefined;
        if (!clientCountryId) return null;
        if (countryCache.has(clientCountryId)) return countryCache.get(clientCountryId)!;
        const c = await this.countryRepository.findOne({ where: { id: clientCountryId } });
        if (c) countryCache.set(clientCountryId, c);
        return c;
      };

      const now = new Date();

      type Acc = {
        activeLoanAmount: number;
        activeLoansCount: number;
        activeClients: Set<number>;
        disbursedAmount: number;
        disbursementCount: number;
        repaidAmount: number;
        repaymentCount: number;
        delinquentAmount: number;
      };

      const byCountry = new Map<number | null, Acc>();

      const ensureAcc = (countryKey: number | null): Acc => {
        if (!byCountry.has(countryKey)) {
          byCountry.set(countryKey, {
            activeLoanAmount: 0,
            activeLoansCount: 0,
            activeClients: new Set<number>(),
            disbursedAmount: 0,
            disbursementCount: 0,
            repaidAmount: 0,
            repaymentCount: 0,
            delinquentAmount: 0,
          });
        }
        return byCountry.get(countryKey)!;
      };

      for (const loan of loans) {
        const country = await getCountryForLoan(loan);
        const countryKey = country?.id ?? null;
        const acc = ensureAcc(countryKey);

        const status = loan.status as LoanRequestStatus;
        const txs = (loan.transactions ?? []) as LoanTransaction[];

        const disbursements = txs.filter(t => t.Transactiontype === TransactionType.DISBURSEMENT);
        const repayments = txs.filter(t => t.Transactiontype === TransactionType.REPAYMENT);

        const disbursedSum = disbursements.reduce((s, t) => s + Number(t.amount ?? 0), 0);
        const repaidSum = repayments.reduce((s, t) => s + Number(t.amount ?? 0), 0);

        acc.disbursedAmount += disbursedSum;
        acc.disbursementCount += disbursements.length;
        acc.repaidAmount += repaidSum;
        acc.repaymentCount += repayments.length;

        const loanAmount = Number(loan.amount ?? 0);
        const outstanding = Math.max(loanAmount - repaidSum, 0);

        if (ACTIVE_STATUSES.includes(status)) {
          acc.activeLoanAmount += outstanding;
          acc.activeLoansCount += 1;
          const clientId = (loan as any)?.client?.id as number | undefined;
          if (clientId) acc.activeClients.add(clientId);

          // crude delinquency: overdue if endDateAt < now and outstanding > 0
          if (loan.endDateAt && outstanding > 0 && loan.endDateAt.getTime() < now.getTime()) {
            acc.delinquentAmount += outstanding;
          }
        }
      }

      let totalActiveLoanAmount = 0;
      let totalActiveLoansCount = 0;
      let totalActiveClients = 0;
      let totalDisbursedAmount = 0;
      let totalDisbursementCount = 0;
      let totalRepaidAmount = 0;
      let totalRepaymentCount = 0;
      let totalDelinquentAmount = 0;

      const entries: SuperAdminGlobalSummary['byCountry'] = [];

      for (const [countryKey, acc] of byCountry.entries()) {
        const country =
          countryKey != null ? await this.countryRepository.findOne({ where: { id: countryKey } }) : null;

        const activeClientsCount = acc.activeClients.size;
        const delinquencyRate =
          acc.activeLoanAmount > 0 ? acc.delinquentAmount / acc.activeLoanAmount : 0;

        entries.push({
          countryId: countryKey,
          countryName: country?.name ?? null,
          currencyCode: (country as any)?.currencyCode ?? null,
          activeLoanAmount: acc.activeLoanAmount,
          delinquentAmount: acc.delinquentAmount,
          activeLoansCount: acc.activeLoansCount,
          activeClientsCount,
          disbursedAmount: acc.disbursedAmount,
          disbursementCount: acc.disbursementCount,
          repaidAmount: acc.repaidAmount,
          repaymentCount: acc.repaymentCount,
          delinquencyRate,
        });

        totalActiveLoanAmount += acc.activeLoanAmount;
        totalActiveLoansCount += acc.activeLoansCount;
        totalActiveClients += activeClientsCount;
        totalDisbursedAmount += acc.disbursedAmount;
        totalDisbursementCount += acc.disbursementCount;
        totalRepaidAmount += acc.repaidAmount;
        totalRepaymentCount += acc.repaymentCount;
        totalDelinquentAmount += acc.delinquentAmount;
      }

      const globalDelinquencyRate =
        totalActiveLoanAmount > 0 ? totalDelinquentAmount / totalActiveLoanAmount : 0;

      return {
        meta: {
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
          generatedAt: new Date().toISOString(),
        },
        totals: {
          activeLoanAmount: totalActiveLoanAmount,
          activeLoansCount: totalActiveLoansCount,
          activeClientsCount: totalActiveClients,
          disbursedAmount: totalDisbursedAmount,
          disbursementCount: totalDisbursementCount,
          repaidAmount: totalRepaidAmount,
          repaymentCount: totalRepaymentCount,
          delinquencyRate: globalDelinquencyRate,
        },
        byCountry: entries.sort((a, b) => (a.countryName ?? '').localeCompare(b.countryName ?? '')),
      };
    }

    // Aggregates loan statistics between two dates, grouped by branch
    private async getStatsBetween(start: Date, end: Date): Promise<AnalyticsReport[]> {
        const requests = await this.loanRequestRepo.createQueryBuilder('loan')
        .leftJoinAndSelect('loan.agent', 'agent')
        .leftJoinAndSelect('agent.branch', 'branch')
        .where('loan.createdAt BETWEEN :start AND :end', { start, end })
        .getMany();
        
        const branchStats: Map<number, AnalyticsReport> = new Map();
        
        for (const req of requests) {
            if (!req.agent || !req.agent.branch) continue;
            
            const branch = req.agent.branch;
            const current = branchStats.get(branch.id) || {
                branchId: branch.id,
                branchName: branch.name,
                totalRequests: 0,
                statusCounts: {},
                totalFundedAmount: 0,
                totalOwedAmount: 0,
            };
            
            current.totalRequests++;
            
            const status = req.status as LoanRequestStatus;
            current.statusCounts[status] = (current.statusCounts[status] || 0) + 1;
            
            if (status === 'funded') {
                current.totalFundedAmount += req.amount || 0;
                current.totalOwedAmount += req.amount || 0; // TODO: Replace with real balance calc from transactions
            }
            
            branchStats.set(branch.id, current);
        }
        
        return Array.from(branchStats.values());
    }

    // Statistics for current month by branch
    async getCurrentMonthStats(): Promise<AnalyticsReport[]> {
        const now = new Date();
        const { start, end } = this.getDateRangeOfMonth(now.getFullYear(), now.getMonth());
        return this.getStatsBetween(start, end);
    }

    // Historical monthly statistics grouped by branch
    async getMonthlyHistory(): Promise<AnalyticsMonthlyReport[]> {
        const oldest = await this.loanRequestRepo.createQueryBuilder('loan')
        .orderBy('loan.createdAt', 'ASC')
        .limit(1)
        .getOne();
        
        const startDate = oldest?.createdAt || new Date();
        const now = new Date();
        const result: AnalyticsMonthlyReport[] = [];
        
        for (let year = startDate.getFullYear(); year <= now.getFullYear(); year++) {
            const startMonth = year === startDate.getFullYear() ? startDate.getMonth() : 0;
            const endMonth = year === now.getFullYear() ? now.getMonth() : 11;
            
            for (let month = startMonth; month <= endMonth; month++) {
                const { start, end } = this.getDateRangeOfMonth(year, month);
                const data = await this.getStatsBetween(start, end);
                result.push({ month: `${year}-${String(month + 1).padStart(2, '0')}`, data });
            }
        }
        
        return result;
    }

    // Historical yearly statistics grouped by branch
    async getYearlyHistory(): Promise<AnalyticsYearlyReport[]> {
        const oldest = await this.loanRequestRepo.createQueryBuilder('loan')
        .orderBy('loan.createdAt', 'ASC')
        .limit(1)
        .getOne();
        
        const startDate = oldest?.createdAt || new Date();
        const now = new Date();
        const result: AnalyticsYearlyReport[] = [];
        
        for (let year = startDate.getFullYear(); year <= now.getFullYear(); year++) {
            const start = new Date(year, 0, 1);
            const end = new Date(year, 11, 31, 23, 59, 59, 999);
            const data = await this.getStatsBetween(start, end);
            result.push({ year, data });
        }
        
        return result;
    }


    async getFundedCurrentVsPrevious(): Promise<FundedByBranchComparison[]> {
        const now = new Date();
        const { start: currentStart, end: currentEnd } = this.getDateRangeOfMonth(now.getFullYear(), now.getMonth());
        
        const previousMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
        const previousYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
        const { start: prevStart, end: prevEnd } = this.getDateRangeOfMonth(previousYear, previousMonth);
        
        const [currentData, previousData] = await Promise.all([
            this.getStatsBetween(currentStart, currentEnd),
            this.getStatsBetween(prevStart, prevEnd),
        ]);
        
        const result: FundedByBranchComparison[] = [];
        const branchIds = new Set([
            ...currentData.map(b => b.branchId),
            ...previousData.map(b => b.branchId),
        ]);
        
        for (const id of branchIds) {
            const current = currentData.find(b => b.branchId === id);
            const previous = previousData.find(b => b.branchId === id);
            
            result.push({
                branchId: id,
                branchName: current?.branchName || previous?.branchName || 'N/A',
                currentMonthFunded: current?.statusCounts['funded'] || 0,
                previousMonthFunded: previous?.statusCounts['funded'] || 0,
            });
        }
        
        return result;
    }
    async getFundedByBranchYearly(): Promise<FundedBranchStat[]> {
        const now = new Date();
        const currentYear = now.getFullYear();
        const result: FundedBranchStat[] = [];
        
        // Loop through current and previous year
        for (const year of [currentYear - 1, currentYear]) {
            for (let month = 0; month < 12; month++) {
                const start = new Date(year, month, 1);
                const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
                
                // Fetch funded loan requests in this month
                const requests = await this.loanRequestRepo.find({
                    where: {
                        status: LoanRequestStatus.FUNDED,
                        createdAt: Between(start, end),
                    },
                    relations: ['agent', 'agent.branch'],
                });
                
                // Group by branch ID
                const grouped: Map<number, FundedBranchStat> = new Map();
                
                for (const req of requests) {
                    const branch = req.agent?.branch;
                    if (!branch) continue;
                    
                    if (!grouped.has(branch.id)) {
                        grouped.set(branch.id, {
                            branchId: branch.id,
                            branchName: branch.name,
                            month: `${year}-${String(month + 1).padStart(2, '0')}`,
                            totalAmount: 0,
                            count: 0,
                        });
                    }
                    
                    const stat = grouped.get(branch.id)!;
                    stat.totalAmount += req.amount || 0;
                    stat.count += 1;
                }
                
                result.push(...grouped.values());
            }
        }
        
        return result;
    }

    async getFundedYearlySummary(): Promise<{ month: string; totalAmount: number; count: number }[]> {
        const now = new Date();
        const currentYear = now.getFullYear();
        const result: { month: string; totalAmount: number; count: number }[] = [];
        
        for (const year of [currentYear - 1, currentYear]) {
            for (let month = 0; month < 12; month++) {
                const start = new Date(year, month, 1);
                const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
                
                const requests = await this.loanRequestRepo.find({
                    where: {
                        status: LoanRequestStatus.FUNDED,
                        createdAt: Between(start, end),
                    },
                });
                
                const totalAmount = requests.reduce((sum, req) => sum + (req.amount || 0), 0);
                const count = requests.length;
                
                result.push({
                    month: `${year}-${String(month + 1).padStart(2, '0')}`,
                    totalAmount,
                    count,
                });
            }
        }
        
        return result;
    }

    /**
    * Returns a summary of delinquent clients:
    * - Not paid loans (still active)
    * - Loans with 15+ days of delay
    * - Loans with 30+ days of delay (critical)
    */
    async getClientDelinquencyStats(): Promise<any> {
        const now = new Date();
        
        // Load all loan requests with transactions and clients
        const allLoans = await this.loanRequestRepo.find({
            where: {},
            relations: ['transactions'],
        });
        
        let notPaid = 0;
        let lateOver15 = 0;
        let critical = 0;
        
        for (const loan of allLoans) {
            // Skip completed loans
            if (loan.status === 'completed' || loan.status === 'rejected') {
                continue;
            }
            
            // Find latest repayment transaction
            const lastRepayment = loan.transactions
            .filter(t => t.Transactiontype === TransactionType.REPAYMENT)
            .sort((a, b) => +new Date(b.date) - +new Date(a.date))[0];
            
            // Calculate how many days since last payment (or from loan creation)
            const referenceDate = lastRepayment ? new Date(lastRepayment.date) : new Date(loan.createdAt);
            const daysLate = Math.floor((+now - +referenceDate) / (1000 * 60 * 60 * 24));
            
            notPaid++;
            
            if (daysLate > 15) lateOver15++;
            if (daysLate > 30) critical++;
        }
        
        // TODO: Replace mock variations with historical comparison if available
        return {
            notPaid: {
                count: notPaid,
                variation: {
                    percentage: 15,
                    type: 'increase',
                },
            },
            lateOver15: {
                count: lateOver15,
                variation: {
                    percentage: -5,
                    type: 'decrease',
                },
            },
            critical: {
                count: critical,
                variation: {
                    percentage: -12,
                    type: 'decrease',
                },
            },
        };
    }
    // 1) Fetch the most recent loan requests
    async getLatestRequests(limit: number): Promise<LoanRequest[]> {
        return this.loanRequestRepo.find({
            order: { createdAt: 'DESC' },
            take: limit,
            relations: ['client', 'agent'],
        });
    }

    // 2) Get agents with the highest count of requests not approved and not rejected
    async getTopAgentsByUndisbursed(limit: number,): Promise<{ agentId: number; agentName: string; undisbursedCount: number }[]> {
        const rows = await this.loanRequestRepo
        .createQueryBuilder('lr')
        .select('lr.agentId', 'agentId')
        .addSelect('COUNT(*)', 'undisbursedCount')
        .where('lr.status NOT IN (:...statuses)', { statuses: [LoanRequestStatus.APPROVED, LoanRequestStatus.REJECTED] })
        .groupBy('lr.agentId')
        .orderBy('undisbursedCount', 'DESC')
        .limit(limit)
        .getRawMany<{ agentId: number; undisbursedCount: string }>();
        
        const agentIds = rows.map(r => r.agentId);
        const agents = await this.userRepository.findByIds(agentIds);
        
        return rows.map(r => ({
            agentId: r.agentId,
            agentName: agents.find(a => a.id === r.agentId)?.name ?? 'Unknown',
            undisbursedCount: +r.undisbursedCount,
        }));
    }

    // 3) Retrieve the latest repayment transactions
    async getRecentPayments(
        limit: number,
        ): Promise<
        {
            transactionId: number;
            loanRequestId: number;
            amount: number;
            date: Date;
            clientName: string;
            agentName: string;
        }[]
        > {
            const txns = await this.loanTransactionRepository
            .createQueryBuilder('tx')
            .leftJoinAndSelect('tx.loanRequest', 'lr')
            .leftJoinAndSelect('lr.client', 'client')
            .leftJoinAndSelect('lr.agent', 'agent')
            .where('tx.transactionType = :type', { type: 'repayment' })
            .orderBy('tx.date', 'DESC')
            .limit(limit)
            .getMany();
            
            return txns.map(tx => ({
                transactionId: tx.id,
                loanRequestId: tx.loanRequest.id,
                amount: tx.amount,
                date: tx.date,
                clientName: tx.loanRequest.client.name,
                agentName: tx.loanRequest.agent.name,
            }));
    }
    /**
    * Returns the next loan requests that are about to fall due,
    * ordered by endDateAt (soonest first).
    */
    async getUpcomingPayments(
        limit = 10,
        ): Promise<
        {
            loanRequestId: number;
            amount: number;
            endDateAt: Date;
            clientName: string;
            agentName: string;
        }[]
        > {
            const loans = await this.loanRequestRepo
            .createQueryBuilder('lr')
            .leftJoinAndSelect('lr.client', 'client')
            .leftJoinAndSelect('lr.agent',  'agent')
            .where('lr.endDateAt IS NOT NULL')
            // Ignore already-closed requests; tweak as needed
            .andWhere('lr.status NOT IN (:...closed)', {
                closed: [
                    LoanRequestStatus.COMPLETED,
                    LoanRequestStatus.CANCELED,
                    LoanRequestStatus.REJECTED,
                ],
            })
            .orderBy('lr.endDateAt', 'ASC')   // earliest due date first
            .limit(limit)
            .getMany();
            
            return loans.map(lr => ({
                loanRequestId: lr.id,
                amount: +(lr.requestedAmount ?? lr.amount ?? 0),
                endDateAt: lr.endDateAt,
                clientName: lr.client.name,
                agentName: lr.agent.name,
                type : lr.type,
                paymentDay : lr.paymentDay,
                mode : lr.mode
            }));
    }
        
}
