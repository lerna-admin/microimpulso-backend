import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { UpdateLoanRequestDto } from './dto/update-loan-request.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';

@Injectable()
export class LoanRequestService {
  sendContract(id: number) {
    throw new Error('Method not implemented.');
  }
  constructor(
    @InjectRepository(LoanRequest)
    private readonly loanRequestRepository: Repository<LoanRequest>,
  ) {}
  
  async create(createLoanRequestDto: CreateLoanRequestDto): Promise<LoanRequest> {
    const loanRequest = this.loanRequestRepository.create(createLoanRequestDto);
    return await this.loanRequestRepository.save(loanRequest);
  }
  async renewLoanRequest(
    loanRequestId: number,
    amount: number,
    newDate: string
  ): Promise<LoanRequest> {
    const loan = await this.loanRequestRepository.findOne({
      where: { id: loanRequestId },
      relations: ['transactions'],
    });
    
    if (!loan) throw new NotFoundException('Loan request not found');
    
    const penaltyTx = this.loanRequestRepository.manager.create('Transaction', {
      loanRequest: loan,
      Transactiontype: 'penalty',
      amount: amount,
      reference: 'Renewal penalty',
      date: new Date(),
    });
    await this.loanRequestRepository.manager.save(penaltyTx);
    
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
    .leftJoinAndSelect('loan.agent', 'agent')
    .select([
      'loan',
      'client.id',
      'agent.id',
      'agent.name',
      'agent.email',
      'agent.role',
    ]);
    
    if (filters?.id !== undefined) {
      qb.andWhere('loan.id = :id', { id: filters.id });
    }
    if (filters?.amount !== undefined) {
      qb.andWhere('loan.amount = :amount', { amount: filters.amount });
    }
    if (filters?.requestedAmount !== undefined) {
      qb.andWhere('loan.requestedAmount = :reqAmt', {
        reqAmt: filters.requestedAmount,
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
      qb.andWhere('loan.endDateAt = :endDate', { endDate: filters.endDateAt });
    }
    if (filters?.paymentDay) {
      qb.andWhere('loan.paymentDay = :paymentDay', {
        paymentDay: filters.paymentDay,
      });
    }
    if (filters?.createdAt) {
      qb.andWhere('loan.createdAt = :createdAt', {
        createdAt: filters.createdAt,
      });
    }
    if (filters?.updatedAt) {
      qb.andWhere('loan.updatedAt = :updatedAt', {
        updatedAt: filters.updatedAt,
      });
    }
    if (filters?.clientId !== undefined) {
      qb.andWhere('loan.clientId = :clientId', { clientId: filters.clientId });
    }
    if (filters?.agentId !== undefined) {
      qb.andWhere('loan.agentId = :agentId', { agentId: filters.agentId });
    }
    
    qb.orderBy('loan.createdAt', 'DESC')
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
    const loanRequest = await this.loanRequestRepository.findOne({ where: { id } });
    
    if (!loanRequest) {
      throw new NotFoundException(`loanRequest with ID ${id} not found`);
    }
    
    const updated = Object.assign(loanRequest, updateLoanRequestDto);
    return await this.loanRequestRepository.save(updated);
  }
}
