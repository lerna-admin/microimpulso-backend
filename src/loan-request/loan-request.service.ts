import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { UpdateLoanRequestDto } from './dto/update-loan-request.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LoanRequest } from 'src/entities/loan-request.entity';

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
  
  async findAll(): Promise<LoanRequest[]> {
    return this.loanRequestRepository
    .createQueryBuilder('loan')
    .leftJoinAndSelect('loan.client', 'client')
    .leftJoinAndSelect('loan.agent', 'agent')
    .select(['loan', 'client', 'agent.id', 'agent.name', 'agent.email', 'agent.role'])
    .getMany();
  }
  
// loan-request.service.ts
async findAllByAgent(agentId: number): Promise<LoanRequest[]> {
  return this.loanRequestRepository
    .createQueryBuilder('loan')
    .leftJoinAndSelect('loan.client', 'client')
    .leftJoinAndSelect('loan.agent',  'agent')
    .leftJoinAndSelect('loan.transactions', 'tx')
    .select([
      // ▶ loan + client completos (incluye todas las columnas declaradas)
      'loan',
      'client',
      // ▶ solo lo necesario del agente
      'agent.id',
      'agent.name',
      'agent.email',
      'agent.role',
      // ▶ columnas existentes en Transaction
      'tx.id',
      'tx.amount',
      'tx.Transactiontype',   
      'tx.date',
      'tx.reference',
      'tx.daysLate'
    ])
    .where('loan.agentId = :agentId', { agentId })
    .orderBy('loan.createdAt', 'DESC')
    .addOrderBy('tx.date', 'ASC')       
    .getMany();
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
