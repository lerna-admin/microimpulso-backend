import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { UpdateLoanRequestDto } from './dto/update-loan-request.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Not, Repository } from 'typeorm';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { TransactionType, LoanTransaction} from 'src/entities/transaction.entity';
import { User } from 'src/entities/user.entity'
import { Notification } from 'src/notifications/notifications.entity';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import tz from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(tz);

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
  // 1) Rango de "hoy" en America/Bogota, en UTC para la DB
  const tzName = 'America/Bogota';
  const start = dayjs().tz(tzName).startOf('day').utc().toDate();
  const end   = dayjs().tz(tzName).endOf('day').utc().toDate();

  // 2) Cartera (opción SQL agregada, evita traer todas las transacciones)
  //    Ajusta columnas: loan.amount (desembolsado?) y tx.Transactiontype, tx.amount
  const { totalAmount } = await this.loanRequestRepository
    .createQueryBuilder('loan')
    .select('COALESCE(SUM(loan.amount), 0)', 'totalAmount')
    .where('loan.status = :status', { status: LoanRequestStatus.FUNDED })
    .andWhere('loan.agentId = :agentId', { agentId })
    .getRawOne<{ totalAmount: string }>();

  const { totalRepaid } = await this.transactionRepository
    .createQueryBuilder('tx')
    .innerJoin('tx.loanRequest', 'loan')
    .select(`COALESCE(SUM(CASE WHEN tx.Transactiontype = :rep THEN tx.amount ELSE 0 END), 0)`, 'totalRepaid')
    .where('loan.status IN (:...st)', { st: [LoanRequestStatus.FUNDED, LoanRequestStatus.COMPLETED] })
    .andWhere('loan.agentId = :agentId', { agentId })
    .setParameters({ rep: TransactionType.REPAYMENT })
    .getRawOne<{ totalRepaid: string }>();

  const cartera = Number(totalAmount ?? 0) - Number(totalRepaid ?? 0);

  // 3) Cobrado hoy (todas las REPAYMENT hoy, incluso COMPLETED), con filtro de rango
  const cobradoRows = await this.transactionRepository
    .createQueryBuilder('tx')
    .innerJoin('tx.loanRequest', 'loan')
    .innerJoin('loan.agent', 'agent')
    .select('COALESCE(SUM(tx.amount), 0)', 'sum')
    .where('tx.Transactiontype = :type', { type: TransactionType.REPAYMENT })
    .andWhere('tx.date BETWEEN :start AND :end', { start, end })
    .andWhere('agent.id = :agentId', { agentId })
    .getRawOne<{ sum: string }>();

  const cobrado = Number(cobradoRows?.sum ?? 0);

  // 4) Renovados hoy (compara renewedAt por rango)
  const renewedToday = await this.loanRequestRepository
    .createQueryBuilder('loan')
    .select([
      'COUNT(*)::int AS count',              // ajusta a tu SQL dialect
      'COALESCE(SUM(loan.requestedAmount),0) AS total',
    ])
    .where('loan.agentId = :agentId', { agentId })
    .andWhere('loan.isRenewed = :r', { r: true })
    .andWhere('loan.renewedAt BETWEEN :start AND :end', { start, end })
    .getRawOne<{ count: string; total: string }>();

  const renovados = Number(renewedToday?.count ?? 0);
  const valorRenovados = Number(renewedToday?.total ?? 0);

  // 5) Nuevos hoy (DISBURSEMENT con filtro por agente en SQL)
  const newRows = await this.transactionRepository
    .createQueryBuilder('tx')
    .innerJoin('tx.loanRequest', 'loan')
    .innerJoin('loan.agent', 'agent')
    .select([
      'COUNT(*)::int AS count',
      'COALESCE(SUM(COALESCE(loan.requestedAmount, tx.amount)), 0) AS total',
    ])
    .where('tx.Transactiontype = :type', { type: TransactionType.DISBURSEMENT })
    .andWhere('tx.date BETWEEN :start AND :end', { start, end })
    .andWhere('agent.id = :agentId', { agentId })
    .getRawOne<{ count: string; total: string }>();

  const nuevos = Number(newRows?.count ?? 0);
  const valorNuevos = Number(newRows?.total ?? 0);

  // 6) Clientes únicos (si realmente quieres “clientes” y no “préstamos”)
  const clientsRow = await this.loanRequestRepository
    .createQueryBuilder('loan')
    .innerJoin('loan.client', 'c')
    .select('COUNT(DISTINCT c.id)', 'clients')
    .where('loan.status = :status', { status: LoanRequestStatus.FUNDED })
    .andWhere('loan.agentId = :agentId', { agentId })
    .getRawOne<{ clients: string }>();

  const clientes = Number(clientsRow?.clients ?? 0);

  return {
    cartera,
    cobrado,
    clientes,        // ahora sí, clientes únicos con loans funded del agente
    renovados,
    valorRenovados,
    nuevos,
    valorNuevos,
  };
}
  
  
  
  
}
