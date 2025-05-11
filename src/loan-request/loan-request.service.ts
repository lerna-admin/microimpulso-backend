import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { UpdateLoanRequestDto } from './dto/update-loan-request.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LoanRequest } from 'src/entities/loan-request.entity';

@Injectable()
export class LoanRequestService {
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

  async findAllByAgent(agentId: number): Promise<LoanRequest[]> {
    return this.loanRequestRepository
      .createQueryBuilder('loan')
      .leftJoinAndSelect('loan.client', 'client')
      .leftJoinAndSelect('loan.agent', 'agent')
      .select(['loan', 'client', 'agent.id', 'agent.name', 'agent.email', 'agent.role'])
      .where('loan.agentId = :agentId', { agentId })
      .getMany();
  }

  async findById(id: number): Promise<LoanRequest | null> {
    return this.loanRequestRepository
      .createQueryBuilder('loan')
      .leftJoinAndSelect('loan.client', 'client')
      .leftJoinAndSelect('loan.agent', 'agent')
      .select(['loan', 'client', 'agent.id', 'agent.name', 'agent.email', 'agent.role'])
      .where('loan.id = :id', { id })
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
