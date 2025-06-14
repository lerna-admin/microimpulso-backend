import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { AgentClosing } from 'src/entities/agent-closing.entity';
import { User } from '../entities/user.entity';
import { LoanRequestService } from '../loan-request/loan-request.service';
import { startOfDay, endOfDay } from 'date-fns';

@Injectable()
export class ClosingService {
  constructor(
    @InjectRepository(AgentClosing)
    private readonly closingRepo: Repository<AgentClosing>,
    
    // Optional: pull KPIs for the daily summary
    private readonly loanRequestService: LoanRequestService,
  ) {}
  
  /** ------------------------------------------------------------------
  * Closes the day for a specific agent.
  * Throws 400 if he already closed today.
  * ------------------------------------------------------------------ */
  async closeDay(agent: User) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    // Has this agent already closed today?
    const alreadyClosed = await this.closingRepo.findOne({
      where: {
        agent: { id: agent.id },
        closedAt: Between(todayStart, new Date()),
      },
    });
    if (alreadyClosed)
      throw new BadRequestException('Day already closed for this agent.');
    
    // OPTIONAL – gather a KPI snapshot to store with the closing record
    const summary = await this.loanRequestService.getClosingSummary(agent.id);
    
    const closing = this.closingRepo.create({
      agent,
      closedAt: new Date(),
      cartera: summary.cartera,
      cobrado: summary.cobrado,
      renovados: summary.renovados,
      nuevos: summary.nuevos,
      resumenJson: JSON.stringify(summary),
    });
    
    return this.closingRepo.save(closing);
  }
  
  /** ------------------------------------------------------------------
  * Returns true if the agent has already closed today.
  * ------------------------------------------------------------------ */
  async isClosedToday(agentId: number): Promise<boolean> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    return !!(await this.closingRepo.findOne({
      where: {
        agent: { id: agentId },
        closedAt: Between(todayStart, new Date()),
      },
      select: ['id'], // fetch only the PK – faster
    }));
  }
  
  async hasClosedToday(agentId: number): Promise<boolean> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    
    const record = await this.closingRepo.findOne({
      where: {
        agent: { id: agentId },
        closedAt: Between(today, tomorrow),
      },
    });
    
    return !!record;
  }
  /* ---------------------------------------------------------------
  * Removes today’s closing for the given agent.
  * ------------------------------------------------------------- */
  async reopenDay(agent: User): Promise<AgentClosing> {
    const todayStart = startOfDay(new Date());
    const todayEnd   = endOfDay(new Date());
    
    const closing = await this.closingRepo.findOne({
      where: {
        agent: { id: agent.id },
        closedAt: Between(todayStart, todayEnd),
      },
    });
    
    if (!closing) {
      throw new NotFoundException('No closing found for today');
    }
    
    await this.closingRepo.remove(closing);
    return closing; // returned for confirmation/logging
  }
  
  
  
}
