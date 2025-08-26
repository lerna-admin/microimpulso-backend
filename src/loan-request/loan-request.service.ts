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
  


// ────────────────────────────────────────────────────────────────────────────
// Closing Summary SIN dayjs (no cambia tsconfig, ni otros archivos)
// ────────────────────────────────────────────────────────────────────────────
async getClosingSummary(agentId: number) {
  // Get 'YYYY-MM-DD' for today's date in America/Bogota using only Intl.
  const getBogotaToday = (): string => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year')!.value;
    const m = parts.find(p => p.type === 'month')!.value;
    const d = parts.find(p => p.type === 'day')!.value;
    return `${y}-${m}-${d}`; // e.g. 2025-08-25
  };

  const today = getBogotaToday();

  // ──────────────────────────────────────────────────────────────────────────
  // Cartera = SUM(disbursed) - SUM(repayments) for this agent
  // ──────────────────────────────────────────────────────────────────────────
  const totalAmountRow = await this.loanRequestRepository
    .createQueryBuilder('loan')
    .select('COALESCE(SUM(loan.amount), 0)', 'totalAmount')
    .where('loan.status = :status', { status: LoanRequestStatus.FUNDED })
    .andWhere('loan.agentId = :agentId', { agentId })
    .getRawOne<{ totalAmount?: string }>();

  const totalRepaidRow = await this.transactionRepository
    .createQueryBuilder('tx')
    .innerJoin('tx.loanRequest', 'loan')
    .select(
      `COALESCE(SUM(CASE WHEN LOWER(tx.Transactiontype) = 'repayment' THEN tx.amount ELSE 0 END), 0)`,
      'totalRepaid'
    )
    .where('loan.status IN (:...st)', { st: [LoanRequestStatus.FUNDED, LoanRequestStatus.COMPLETED] })
    .andWhere('loan.agentId = :agentId', { agentId })
    .getRawOne<{ totalRepaid?: string }>();

  const totalAmount = Number(totalAmountRow?.totalAmount ?? 0);
  const totalRepaid = Number(totalRepaidRow?.totalRepaid ?? 0);
  const cartera = totalAmount - totalRepaid;

  // ──────────────────────────────────────────────────────────────────────────
  // Cobrado hoy: all REPAYMENT rows dated today for this agent
  // ──────────────────────────────────────────────────────────────────────────
  const cobradoRow = await this.transactionRepository
    .createQueryBuilder('tx')
    .innerJoin('tx.loanRequest', 'loan')
    .innerJoin('loan.agent', 'agent')
    .select('COALESCE(SUM(tx.amount), 0)', 'sum')
    .where(`LOWER(tx.Transactiontype) = 'repayment'`)
    .andWhere(`substr(tx.date, 1, 10) = :today`, { today })
    .andWhere('agent.id = :agentId', { agentId })
    .getRawOne<{ sum?: string }>();

  const cobrado = Number(cobradoRow?.sum ?? 0);

  // ──────────────────────────────────────────────────────────────────────────
  // Renovados hoy: loans with isRenewed = true and DATE(renewedAt) = today
  // ──────────────────────────────────────────────────────────────────────────
  const renewedTodayRow = await this.loanRequestRepository
    .createQueryBuilder('loan')
    .select([
      'COUNT(*) AS count',
      'COALESCE(SUM(loan.requestedAmount), 0) AS total',
    ])
    .where('loan.agentId = :agentId', { agentId })
    .andWhere('loan.isRenewed = :r', { r: true })
    .andWhere(`substr(loan.renewedAt, 1, 10) = :today`, { today })
    .getRawOne<{ count?: string; total?: string }>();

  const renovados = Number(renewedTodayRow?.count ?? 0);
  const valorRenovados = Number(renewedTodayRow?.total ?? 0);

  // ──────────────────────────────────────────────────────────────────────────
  // Nuevos hoy: disbursements today for this agent (count + amount)
  // Prefer loan.requestedAmount, fallback to tx.amount
  // ──────────────────────────────────────────────────────────────────────────
  const newRows = await this.transactionRepository
    .createQueryBuilder('tx')
    .innerJoin('tx.loanRequest', 'loan')
    .innerJoin('loan.agent', 'agent')
    .select([
      'COUNT(*) AS count',
      'COALESCE(SUM(COALESCE(loan.requestedAmount, tx.amount)), 0) AS total',
    ])
    .where(`LOWER(tx.Transactiontype) = 'disbursement'`)
    .andWhere(`substr(tx.date, 1, 10) = :today`, { today })
    .andWhere('agent.id = :agentId', { agentId })
    .getRawOne<{ count?: string; total?: string }>();

  const nuevos = Number(newRows?.count ?? 0);
  const valorNuevos = Number(newRows?.total ?? 0);

  // ──────────────────────────────────────────────────────────────────────────
  // Unique clients with FUNDED loans (stock metric)
  // ──────────────────────────────────────────────────────────────────────────
  const clientsRow = await this.loanRequestRepository
    .createQueryBuilder('loan')
    .innerJoin('loan.client', 'c')
    .select('COUNT(DISTINCT c.id)', 'clients')
    .where('loan.status = :status', { status: LoanRequestStatus.FUNDED })
    .andWhere('loan.agentId = :agentId', { agentId })
    .getRawOne<{ clients?: string }>();
  const clientes = Number(clientsRow?.clients ?? 0);

  return {
    cartera,
    cobrado,        // con tus datos: 440000
    clientes,       // con tus datos: 2
    renovados,
    valorRenovados,
    nuevos,         // con tus datos: 2
    valorNuevos,    // con tus datos: 500000
  };
}

}
