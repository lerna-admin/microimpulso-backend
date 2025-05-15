import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '../entities/client.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';



@Injectable()
export class ClientsService {
  constructor(
  @InjectRepository(Client)
  private readonly clientRepository: Repository<Client>,

  @InjectRepository(LoanRequest)
  private readonly loanRequestRepository: Repository<LoanRequest>,
) {}

async findAll(): Promise<any[]> {
  const loans = await this.loanRequestRepository.find({
    where: {
      status: LoanRequestStatus.APPROVED,
    },
    relations: {
      client: true,
      transactions: true,
    },
    order: {
      createdAt: 'DESC',
    },
  });

  return loans.map((loan) => {
    const montoPrestado = loan.transactions
      .filter(t => t.Transactiontype === 'disbursement')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const totalPagado = loan.transactions
      .filter(t => t.Transactiontype === 'repayment')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const pendientePorPagar = Number(loan.amount) - totalPagado;

    const diasMora =
      loan.endDateAt && new Date() > new Date(loan.endDateAt)
        ? Math.floor(
            (Date.now() - new Date(loan.endDateAt).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0;

    return {
      client: loan.client,
      loanRequest: {
        ...loan,
        transactions: loan.transactions,
      },
      montoPrestado,
      totalPagado,
      pendientePorPagar,
      diasMora,
    };
  });
}



async findAllByAgent(agentId: number): Promise<any[]> {
  const loans = await this.loanRequestRepository.find({
    where: {
      status: LoanRequestStatus.APPROVED,
      agent: { id: agentId },
    },
    relations: {
      client: true,
      transactions: true,
    },
    order: {
      createdAt: 'DESC',
    },
  });

  return loans.map((loan) => {
    const totalRepayment = loan.transactions
      .filter(t => t.Transactiontype === 'repayment')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const amountBorrowed = loan.transactions
      .filter(t => t.Transactiontype === 'disbursement')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const totalToPay = Number(loan.amount) - totalRepayment;

    const diasMora =
      loan.endDateAt && new Date() > new Date(loan.endDateAt)
        ? Math.floor(
            (Date.now() - new Date(loan.endDateAt).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0;

    return {
      client: loan.client,
      loanRequest: {
        ...loan,
        transactions: loan.transactions,
      },
      totalRepayment,
      amountBorrowed,
      totalToPay,
      diasMora,
    };
  });
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
