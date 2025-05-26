import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '../entities/client.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';

@Injectable()
export class ClientsService {
  async update(id: number, data: any): Promise<Client> {
    const client = await this.clientRepository.findOne({
      where: { id },
      relations: ['agent'],
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    // Sólo permitimos actualizar estos campos
    const allowedFields = ['name', 'phone', 'email', 'document', 'documentType', 'address', 'status'];
    for (const key of allowedFields) {
      if (key in data) {
        client[key] = data[key];
      }
    }

    return this.clientRepository.save(client);
  }
  constructor(
    @InjectRepository(Client)
    private readonly clientRepository: Repository<Client>,

    @InjectRepository(LoanRequest)
    private readonly loanRequestRepository: Repository<LoanRequest>,
  ) {}

  async findAll(): Promise<any[]> {
    const loans = await this.loanRequestRepository.find({
      where: {
        status: LoanRequestStatus.FUNDED,
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
        .filter((t) => t.Transactiontype === 'disbursement')
        .reduce((sum, t) => sum + Number(t.amount), 0);

      const totalPagado = loan.transactions
        .filter((t) => t.Transactiontype === 'repayment')
        .reduce((sum, t) => sum + Number(t.amount), 0);

      const pendientePorPagar = Number(loan.amount) - totalPagado;

      const diasMora =
        loan.endDateAt && new Date() > new Date(loan.endDateAt)
          ? Math.floor((Date.now() - new Date(loan.endDateAt).getTime()) / (1000 * 60 * 60 * 24))
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
  const allLoans = await this.loanRequestRepository.find({
    where: {
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

  const clientMap = new Map<number, any[]>();

  for (const loan of allLoans) {
    const cid = loan.client.id;
    let list = clientMap.get(cid);
    if (!list) {
      list = [];
      clientMap.set(cid, list);
    }
    list.push(loan);
  }

  const result: any[] = [];

  for (const [_, loans] of clientMap.entries()) {
    const client = loans[0].client;

    const hasFunded   = loans.some((l) => l.status === 'funded');
    const allComplete = loans.every((l) => l.status === 'completed');
    const hasRejected = loans.some((l) => l.status === 'rejected');

    let status: 'active' | 'inactive' | 'rejected' | 'unknown' = 'unknown';

    if (hasFunded) status = 'active';
    else if (allComplete) status = 'inactive';
    else if (hasRejected) status = 'rejected';

    const loan = loans.find((l) =>
      status === 'active'   ? l.status === 'funded' :
      status === 'inactive' ? l.status === 'completed' :
      status === 'rejected' ? l.status === 'rejected' :
      true
    );

    const totalRepayment = loan.transactions
      .filter((t) => t.Transactiontype === 'repayment')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const amountBorrowed = loan.transactions
      .filter((t) => t.Transactiontype === 'disbursement')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const totalToPay = amountBorrowed - totalRepayment;

    const diasMora =
      loan.endDateAt && new Date() > new Date(loan.endDateAt)
        ? Math.floor((Date.now() - new Date(loan.endDateAt).getTime()) / 86_400_000)
        : 0;

    result.push({
      ...client,
      status,
      loanRequest: loan,
      totalRepayment,
      amountBorrowed,
      totalToPay,
      diasMora,
    });
  }

  return result;
}



  async findOne(id: number): Promise<any | null> {
    const result = await this.clientRepository
      .createQueryBuilder('client')
      .innerJoin('client.loanRequests', 'loan', 'loan.status = :status', { status: 'funded' })
      .innerJoin('loan.transactions', 'txn')
      .where('client.id = :id', { id })
      .select('client.id', 'clientId')
      .addSelect('client.name', 'clientName')
      .addSelect('loan.id', 'loanRequestId')
      .addSelect('loan.mode', 'loanMode')
      .addSelect('loan.type', 'loanType')
      .addSelect('loan.amount', 'totalAmountToPay')
      .addSelect(
        `
      CASE 
        WHEN loan."endDateAt" IS NOT NULL AND julianday('now') > julianday(loan."endDateAt")
        THEN CAST(julianday('now') - julianday(loan."endDateAt") AS INTEGER)
        ELSE 0
      END
    `,
        'diasMora',
      )
      .addSelect(
        `
      SUM(CASE WHEN txn."Transactiontype" = 'disbursement' THEN txn.amount ELSE 0 END)
    `,
        'montoPrestado',
      )
      .addSelect(
        `
      SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)
    `,
        'totalPagado',
      )
      .addSelect(
        `
      loan.amount - SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)
    `,
        'pendientePorPagar',
      )
      .groupBy('client.id')
      .addGroupBy('loan.id')
      .getRawOne();

    const fullClient = await this.clientRepository.findOne({
      where: { id },
      relations: {
        loanRequests: {
          transactions: true,
        },
      },
    });

    if (fullClient) {
      fullClient.loanRequests = fullClient.loanRequests.filter(
        (loan) => loan.status !== 'completed' && loan.status !== 'rejected',
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
