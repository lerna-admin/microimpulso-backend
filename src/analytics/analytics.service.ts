import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { Branch } from 'src/entities/branch.entity';
import { AnalyticsReport, AnalyticsMonthlyReport, AnalyticsYearlyReport } from './analytics.model';

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
}