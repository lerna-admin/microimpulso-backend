import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '../entities/client.entity';

@Injectable()
export class ClientsService {
  constructor(
    @InjectRepository(Client)
    private readonly clientRepository: Repository<Client>,
  ) {}

  // Return all clients from the database
async findAll(): Promise<any[]> {
  return this.clientRepository
    .createQueryBuilder('client')
    .innerJoin('client.loanRequests', 'loan', 'loan.status = :status', { status: 'approved' })
    .innerJoin('loan.transactions', 'txn')
    .select('client.id', 'clientId')
    .addSelect('client.name', 'clientName')
    .addSelect('loan.id', 'loanRequestId')
    .addSelect('loan.mode', 'loanMode')
    .addSelect('loan.type', 'loanType')
    .addSelect('loan.daysLate', 'loanDaysLate')
    .addSelect('loan.amount', 'totalAmountToPay')
    .addSelect(`
      SUM(CASE WHEN txn."Transactiontype" = 'disbursement' THEN txn.amount ELSE 0 END)
    `, 'montoPrestado')
    .addSelect(`
      SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)
    `, 'totalPagado')
    .addSelect(`
      loan.amount - SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)
    `, 'pendientePorPagar')
    .groupBy('client.id')
    .addGroupBy('loan.id')
    .getRawMany();
}

async findAllByAgent(agentId: number): Promise<any[]> {
  return this.clientRepository
    .createQueryBuilder('client')
    .innerJoin('client.loanRequests', 'loan', 'loan.status = :status AND loan.agentId = :agentId', {
      status: 'approved',
      agentId,
    })
    .innerJoin('loan.transactions', 'txn')
    .select('client.id', 'clientId')
    .addSelect('client.name', 'clientName')
    .addSelect('loan.id', 'loanRequestId')
    .addSelect('loan.mode', 'loanMode')
    .addSelect('loan.type', 'loanType')
    .addSelect('loan.daysLate', 'loanDaysLate')
    .addSelect('loan.amount', 'totalAmountToPay')
    .addSelect(`
      SUM(CASE WHEN txn."Transactiontype" = 'disbursement' THEN txn.amount ELSE 0 END)
    `, 'montoPrestado')
    .addSelect(`
      SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)
    `, 'totalPagado')
    .addSelect(`
      loan.amount - SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)
    `, 'pendientePorPagar')
    .groupBy('client.id')
    .addGroupBy('loan.id')
    .getRawMany();
}


  // Return a single client by ID
  async findOne(id: number): Promise<Client | null> {
    return this.clientRepository.findOneBy({ id });
  }

  // Create a new client record
  async create(data: Partial<Client>): Promise<Client> {
    const client = this.clientRepository.create({
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return this.clientRepository.save(client);
  }
}
