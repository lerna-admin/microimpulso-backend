import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { UpdateLoanRequestDto } from './dto/update-loan-request.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Not, Repository } from 'typeorm';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { TransactionType, LoanTransaction} from 'src/entities/transaction.entity';
import { User } from 'src/entities/user.entity'
import { Notification } from 'src/notifications/notifications.entity';


@Injectable()
export class LoanRequestService {
  sendContract(id: number) {
    throw new Error('Method not implemented.');
  }
  constructor(
    @InjectRepository(LoanRequest)
    private readonly loanRequestRepository: Repository<LoanRequest>,
    @InjectRepository(LoanTransaction)
    private readonly transactionRepository: Repository<LoanTransaction>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    
    ) {}
  
  
  async create(data: Partial<LoanRequest>): Promise<LoanRequest> {
    if (!data.agent) {
      const randomAgent = await this.userRepository
      .createQueryBuilder('user')
      .where('user.role = :role', { role: 'AGENT' })
      .orderBy('RANDOM()')
      .limit(1)
      .getOne();

      if (!randomAgent) {
        throw new Error('No available agent to assign');
      }

      data.agent = randomAgent;
    }
    console.log(data)

    data.mode = (data.amount ? data.amount / 1000 : 100 ).toString().concat("X1");
    const loanRequest = this.loanRequestRepository.create(data);
    return await this.loanRequestRepository.save(loanRequest);
  }

  
  async renewLoanRequest(
    loanRequestId: number,
    amount: number,
    newDate: string,
    ): Promise<LoanRequest> {
    const loan = await this.loanRequestRepository.findOne({
      where: { id: loanRequestId },
      relations: ['transactions'],   
    });
    
    if (!loan) throw new NotFoundException('Loan request not found');
    
    
    const penaltyTx = this.transactionRepository.create({
      Transactiontype: TransactionType.PENALTY,
      amount,
      reference: 'Renewal penalty',
      date: new Date(),
    });
    
    loan.transactions.push(penaltyTx);  
    
    loan.isRenewed = true;
    loan.renewedAt = new Date();
    loan.endDateAt = new Date(newDate);
    
    return this.loanRequestRepository.save(loan);
  }
  
  
  
  async findAll(
    limit: number = 10,
    page: number = 1,
    filters?: {
      id?: number;
      amount?: number;
      requestedAmount?: number;
      status?: LoanRequestStatus;
      type?: string;
      mode?: Date;
      mora?: number;
      endDateAt?: Date;
      paymentDay?: string;
      createdAt?: Date;
      updatedAt?: Date;
      clientId?: number;
      agentId?: number;
      branchId?: number;
    },
    ): Promise<{
    data: LoanRequest[];
    totalItems: number;
    totalPages: number;
    page: number;
    limit: number;
  }> {
    console.log(filters)
    /* ───── Base query ───── */
    const qb = this.loanRequestRepository
    .createQueryBuilder('loan')
    .leftJoinAndSelect('loan.client', 'client')
    .leftJoinAndSelect('loan.agent',  'agent')
    /* Join the branch table; we do not need to select its columns */
    .leftJoinAndSelect('agent.branch', 'branch')
    .select([
      'loan',
      'client',
      'agent',
      'branch'
    ])
    
    /* ───── Dynamic filters ───── */
    if (filters?.id !== undefined)               qb.andWhere('loan.id = :id', { id: filters.id });
    if (filters?.amount !== undefined)           qb.andWhere('loan.amount = :amount', { amount: filters.amount });
    if (filters?.requestedAmount !== undefined)  qb.andWhere('loan.requestedAmount = :reqAmt', { reqAmt: filters.requestedAmount });
    if (filters?.status)                         qb.andWhere('loan.status = :status', { status: filters.status });
    if (filters?.type)                           qb.andWhere('loan.type   = :type',   { type:   filters.type });
    if (filters?.mode)                           qb.andWhere('loan.mode   = :mode',   { mode:   filters.mode });
    if (filters?.mora !== undefined)             qb.andWhere('loan.mora   = :mora',   { mora:   filters.mora });
    if (filters?.endDateAt)                      qb.andWhere('loan.endDateAt = :endDate', { endDate: filters.endDateAt });
    if (filters?.paymentDay)                     qb.andWhere('loan.paymentDay = :paymentDay', { paymentDay: filters.paymentDay });
    if (filters?.createdAt)                      qb.andWhere('loan.createdAt = :createdAt', { createdAt: filters.createdAt });
    if (filters?.updatedAt)                      qb.andWhere('loan.updatedAt = :updatedAt', { updatedAt: filters.updatedAt });
    if (filters?.clientId !== undefined)         qb.andWhere('loan.clientId = :clientId', { clientId: filters.clientId });
    if (filters?.agentId !== undefined)          qb.andWhere('loan.agentId  = :agentId',  { agentId:  filters.agentId });
    if (filters?.branchId !== undefined)         qb.andWhere('branch.id     = :branchId', { branchId: filters.branchId });
    
    /* ───── Sort & pagination ───── */
    qb.orderBy('loan.createdAt', 'DESC');
    
    if (limit > 0 && page > 0) {
      qb.skip((page - 1) * limit).take(limit);
    }
    
    const [data, totalItems] = await qb.getManyAndCount();
    
    return {
      data,
      totalItems,
      totalPages: limit > 0 ? Math.ceil(totalItems / limit) : 1,
      page,
      limit,
    };
  }
  
  
  async findAllByAgent(
    agentId: number,
    limit: number = 10,
    page: number = 1,
    filters?: {
      id?: number;
      amount?: number;
      requestedAmount?: number;
      status?: LoanRequestStatus;
      type?: string;
      mode?: Date;
      mora?: number;
      endDateAt?: Date;
      paymentDay?: string;
      createdAt?: Date;
      updatedAt?: Date;
      clientId?: number;
    }
    ): Promise<{
    data: LoanRequest[];
    totalItems: number;
    totalPages: number;
    page: number;
    limit: number;
  }> {
    const qb = this.loanRequestRepository
    .createQueryBuilder('loan')
    .leftJoinAndSelect('loan.client', 'client')
    .leftJoinAndSelect('loan.agent',  'agent')
    .leftJoinAndSelect('loan.transactions', 'tx')
    .select([
      'loan',
      'client',
      'agent.id',
      'agent.name',
      'agent.email',
      'agent.role',
      'tx.id',
      'tx.amount',
      'tx.Transactiontype',
      'tx.date',
      'tx.reference',
      'tx.daysLate',
    ])
    // fixed agent filter
    .where('loan.agentId = :agentId', { agentId });
    
    // ---------- dynamic filters on loan columns ----------
    if (filters?.id !== undefined) {
      qb.andWhere('loan.id = :id', { id: filters.id });
    }
    if (filters?.amount !== undefined) {
      qb.andWhere('loan.amount = :amount', { amount: filters.amount });
    }
    if (filters?.requestedAmount !== undefined) {
      qb.andWhere('loan.requestedAmount = :req', {
        req: filters.requestedAmount,
      });
    }
    if (filters?.status) {
      qb.andWhere('loan.status = :status', { status: filters.status });
    }
    if (filters?.type) {
      qb.andWhere('loan.type = :type', { type: filters.type });
    }
    if (filters?.mode) {
      qb.andWhere('loan.mode = :mode', { mode: filters.mode });
    }
    if (filters?.mora !== undefined) {
      qb.andWhere('loan.mora = :mora', { mora: filters.mora });
    }
    if (filters?.endDateAt) {
      qb.andWhere('loan.endDateAt = :endDate', {
        endDate: filters.endDateAt,
      });
    }
    if (filters?.paymentDay) {
      qb.andWhere('loan.paymentDay = :pd', { pd: filters.paymentDay });
    }
    if (filters?.createdAt) {
      qb.andWhere('loan.createdAt = :ca', { ca: filters.createdAt });
    }
    if (filters?.updatedAt) {
      qb.andWhere('loan.updatedAt = :ua', { ua: filters.updatedAt });
    }
    if (filters?.clientId !== undefined) {
      qb.andWhere('loan.clientId = :cid', { cid: filters.clientId });
    }
    
    // pagination & ordering
    qb.orderBy('loan.createdAt', 'DESC')
    .addOrderBy('tx.date', 'ASC')
    .skip((page - 1) * limit)
    .take(limit);
    
    const [data, totalItems] = await qb.getManyAndCount();
    
    return {
      data,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
      page,
      limit,
    };
  }
  
  /** Returns the single open loan request for the client */
  async findOpenByClientId(clientId: number) {
    const openRequest = await this.loanRequestRepository.findOne({
      where: {
        client: { id: clientId },
        status: Not(In(['completed', 'rejected'])),
      },
      relations: { transactions: true, client: true },
      order: { createdAt: 'DESC' },
    });
    
    if (!openRequest) {
      throw new NotFoundException(
    `No open loan request found for client ${clientId}`,
    );
    }
    return openRequest;
  }
  async findAllByClient(clientId: number) {
    const openRequest = await this.loanRequestRepository.find({
      where: {
        client: { id: clientId }/**,
        status: Not(In(['completed', 'rejected'])),*/
      },
      relations: { transactions: true, client: true, agent: true},
      order: { createdAt: 'DESC' },
    });
    
    if (!openRequest) {
      throw new NotFoundException(
    `No open loan request found for client ${clientId}`,
    );
    }
    return openRequest;
  }
  
  async findById(id: number): Promise<LoanRequest | null> {
    return this.loanRequestRepository
    .createQueryBuilder('loan')
    .leftJoinAndSelect('loan.client', 'client')
    .leftJoinAndSelect('loan.agent', 'agent')
    .leftJoinAndSelect('loan.transactions', 'tx') // ← agregamos las transacciones
    .select([
      'loan',
      'client',
      'agent.id', 'agent.name', 'agent.email', 'agent.role',
      'tx.id', 'tx.amount', 'tx.Transactiontype', 'tx.date', 'tx.reference', 'tx.daysLate' // ← columnas reales de la entidad Transaction
    ])
    .where('loan.id = :id', { id })
    .orderBy('tx.date', 'ASC') // ← opcional para que salgan cronológicamente
    .getOne();
  }
  
  async update(id: number, updateLoanRequestDto: UpdateLoanRequestDto): Promise<LoanRequest> {
    const loanRequest = await this.loanRequestRepository.findOne({ where: { id },
      relations: ['agent', 'agent.branch', 'agent.branch.administrator'], });
    
    if (!loanRequest) {
      throw new NotFoundException(`loanRequest with ID ${id} not found`);
    }
    
    const updated = Object.assign(loanRequest, updateLoanRequestDto);
    if(updated.status == LoanRequestStatus.APPROVED){
      await this.notificationRepository.save(
        this.notificationRepository.create({
          recipientId:  updated.agent.branch.administrator.id,
          category:     'loan',
          type:         'loan.approved',
          payload:      { author :  { id: updated.agent.id, name: updated.agent.name },  loanRequestId: loanRequest.id},
          description : `El agente ${updated.agent.name} ha aprobado una nueva solicitud, revisa las solicitudes pendientes de desembolso.`
        }),
      );
    }
    return await this.loanRequestRepository.save(updated);
  }
  
  
  async getClosingSummary(agentId: number) {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    
    /* ─── 1. Funded loans (used for cartera / renovados) ─── */
    const fundedLoans = await this.loanRequestRepository.find({
      where: { agent: { id: agentId }, status: LoanRequestStatus.FUNDED },
      relations: ['transactions', 'client'],
    });
    
    /* ─── 1-a. cartera ─── */
    let cartera = 0;
    for (const loan of fundedLoans) {
      const repaid = loan.transactions
      .filter(tx => tx.Transactiontype === TransactionType.REPAYMENT)
      .reduce((sum, tx) => sum + Number(tx.amount), 0);
      cartera += loan.amount - repaid;
    }
    
    /* ─── 2. cobrado: *all* REPAYMENTs today, even on COMPLETED loans ─── */
    const todayStr = now.toISOString().split('T')[0]; // e.g. 2025-06-14
    
    const repaymentsToday = await this.transactionRepository
    .createQueryBuilder('tx')
    .leftJoin('tx.loanRequest', 'loanRequest')
    .leftJoin('loanRequest.agent', 'agent')
    .where('tx.Transactiontype = :type', { type: TransactionType.REPAYMENT })
    .andWhere('date(tx.date) = :today', { today: todayStr })
    .andWhere('agent.id = :agentId', { agentId })        // ✅ agent filter
    .getMany();                                          // no status filter
    
    const cobrado = repaymentsToday.reduce(
      (sum, tx) => sum + Number(tx.amount), 0,
      );
    
    /* ─── 3. Renewals (same logic) ─── */
    const renewedLoans = fundedLoans.filter(
      l => l.isRenewed &&
      l.renewedAt &&
      new Date(l.renewedAt).toISOString().split('T')[0] === todayStr,
      );
    const renovados      = renewedLoans.length;
    const valorRenovados = renewedLoans.reduce(
      (sum, l) => sum + Number(l.requestedAmount), 0,
      );
    
    /* ─── 4. “Nuevos” (already correct) ─── */
    const disbursementsToday = await this.transactionRepository
    .createQueryBuilder('tx')
    .leftJoinAndSelect('tx.loanRequest', 'loanRequest')
    .leftJoinAndSelect('loanRequest.agent', 'agent')
    .where('tx.Transactiontype = :type', { type: TransactionType.DISBURSEMENT })
    .andWhere('date(tx.date) = :today', { today: todayStr })
    .getMany();
    
    const agentDisbursements = disbursementsToday.filter(
      tx => tx.loanRequest?.agent?.id === agentId,
      );
    
    const nuevos      = agentDisbursements.length;
    const valorNuevos = agentDisbursements.reduce(
      (sum, tx) => sum + Number(tx.loanRequest?.requestedAmount ?? tx.amount), 0,
      );
    
    /* ─── 5. Return summary ─── */
    return {
      cartera,
      cobrado,          // ← now counts every repayment made today
      clientes: fundedLoans.length,
      renovados,
      valorRenovados,
      nuevos,
      valorNuevos,
    };
  }
  
  
  
  
}
