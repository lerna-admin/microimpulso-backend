import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { AgentClosing } from 'src/entities/agent-closing.entity';
import { User } from '../entities/user.entity';
import { LoanRequestService } from '../loan-request/loan-request.service';
import { startOfDay, endOfDay } from 'date-fns';
import { NotificationsService } from '../notifications/notifications.service';
import { Branch } from 'src/entities/branch.entity';
import { Notification } from 'src/notifications/notifications.entity';


@Injectable()
export class ClosingService {
  constructor(
    @InjectRepository(AgentClosing)
    private readonly closingRepo: Repository<AgentClosing>,
    private readonly notificationsService: NotificationsService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Branch)
    private readonly branchRepo: Repository<Branch>,
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,


    
    // Optional: pull KPIs for the daily summary
    private readonly loanRequestService: LoanRequestService,
  ) {}
  
  /** ------------------------------------------------------------------
  * Closes the day for a specific agent.
  * Throws 400 if he already closed today.
  * ------------------------------------------------------------------ */
  async closeDay(agent: User) {
    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());
    
    const alreadyClosed = await this.closingRepo.findOne({
      where: {
        agent: { id: agent.id },
        closedAt: Between(todayStart, todayEnd),
      },
    });
    if (alreadyClosed) {
      throw new BadRequestException('Day already closed for this agent.');
    }
    
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
    const saved = await this.closingRepo.save(closing);

    // Notify branch administrator
    let branch =await  this.branchRepo.findOne({
      where : {
        id : agent.branch.id
      },
      relations: ['administrator'],
    });
    console.log(branch)
    const branchAdminId = branch?.administrator?.id;
    console.log(agent.branch)
   
      const payload = {
        author: { id: agent.id, name: agent.name },
        verb: 'https://w3id.org/xapi/dod-isd/verbs/closed',
        object: {
          id: saved.id,
          definition: { name: { 'en-US': 'Closed Day' } },
          timestamp: saved.closedAt.toISOString(),
        },
        
      };
     const description =  `El agente ${agent.name} ha realizado el cierre del día.`
     

      await this.notificationRepository.save(
        this.notificationRepository.create({
          recipientId:  branchAdminId,
          category:      'closing',
          type:         'agent.closed_day',
          payload:      payload,
          description : description
        }),
      );
    
    return saved;
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
