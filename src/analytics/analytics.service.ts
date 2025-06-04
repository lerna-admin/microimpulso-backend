import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { Branch } from 'src/entities/branch.entity';
import { AnalyticsReport, AnalyticsMonthlyReport, AnalyticsYearlyReport } from './analytics.model';
import { TransactionType } from 'src/entities/transaction.entity';
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
  ) {}
  
  // Return the first and last day of the given month
  private getDateRangeOfMonth(year: number, month: number): { start: Date; end: Date } {
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
    return { start, end };
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
  async getFundedYearlySummary(): Promise<
  { month: string; totalAmount: number; count: number }[]
  > {
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


  
}