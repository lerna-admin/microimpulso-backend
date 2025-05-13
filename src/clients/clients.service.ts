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
    .addSelect('loan.amount', 'totalAmountToPay')
    .addSelect(`
      CASE 
        WHEN loan."endDateAt" IS NOT NULL AND julianday('now') > julianday(loan."endDateAt")
        THEN CAST(julianday('now') - julianday(loan."endDateAt") AS INTEGER)
        ELSE 0
      END
    `, 'diasMora')
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
    .addSelect('loan.amount', 'totalAmountToPay')
    .addSelect(`
      CASE 
        WHEN loan."endDateAt" IS NOT NULL AND julianday('now') > julianday(loan."endDateAt")
        THEN CAST(julianday('now') - julianday(loan."endDateAt") AS INTEGER)
        ELSE 0
      END
    `, 'diasMora')
    .addSelect(`
      SUM(CASE WHEN txn."Transactiontype" = 'disbursement' THEN txn.amount ELSE 0 END)
    `, 'amountBorrowed')
    .addSelect(`
      SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)
    `, 'totalRepayment')
    .addSelect(`
      loan.amount - SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)
    `, 'totalToPay')
    .groupBy('client.id')
    .addGroupBy('loan.id')
    .getRawMany();
}


async findOne(id: number): Promise<any | null> {
  const result = await this.clientRepository
    .createQueryBuilder('client')
    .innerJoin('client.loanRequests', 'loan', 'loan.status = :status', { status: 'approved' })
    .innerJoin('loan.transactions', 'txn')
    .where('client.id = :id', { id })
    .select('client.id', 'clientId')
    .addSelect('client.name', 'clientName')
    .addSelect('loan.id', 'loanRequestId')
    .addSelect('loan.mode', 'loanMode')
    .addSelect('loan.type', 'loanType')
    .addSelect('loan.amount', 'totalAmountToPay')
    .addSelect(`
      CASE 
        WHEN loan."endDateAt" IS NOT NULL AND julianday('now') > julianday(loan."endDateAt")
        THEN CAST(julianday('now') - julianday(loan."endDateAt") AS INTEGER)
        ELSE 0
      END
    `, 'diasMora')
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
    .getRawOne();

  // Si quieres también los objetos completos:
  const fullClient = await this.clientRepository.findOne({
  where: { id },
  relations: {
    loanRequests: {
      transactions: true,
    },
  },
});

// Filtra los loanRequests para dejar solo los aprobados
if (fullClient) {
  fullClient.loanRequests = fullClient.loanRequests.filter(
    (loan) => loan.status === 'approved',
  );
}


  return {
    ...result,
    client: fullClient,
  };
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
