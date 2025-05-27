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

  const clientMap = new Map<number, any[]>();

  for (const loan of loans) {
    const clientId = loan.client.id;
    if (!clientMap.has(clientId)) {
      clientMap.set(clientId, []);
    }
    clientMap.get(clientId)!.push(loan);
  }

  const result: any[] = [];

  for (const [clientId, clientLoans] of clientMap.entries()) {
    const client = clientLoans[0].client;

    const hasFunded = clientLoans.some((l) => l.status === 'funded');
    const allCompleted = clientLoans.every((l) => l.status === 'completed');
    const hasRejected = clientLoans.some((l) => l.status === 'rejected');

    let status: 'active' | 'inactive' | 'rejected' | 'unknown' = 'unknown';
    if (hasFunded) status = 'active';
    else if (allCompleted) status = 'inactive';
    else if (hasRejected) status = 'rejected';

    if (status === 'unknown') continue;

    const selectedLoan = clientLoans.find((l) =>
      status === 'active' ? l.status === 'funded' :
      status === 'inactive' ? l.status === 'completed' :
      status === 'rejected' ? l.status === 'rejected' :
      false
    );

    const totalRepayment = selectedLoan.transactions
      .filter((t) => t.Transactiontype === 'repayment')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const amountBorrowed = selectedLoan.transactions
      .filter((t) => t.Transactiontype === 'disbursement')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const totalToPay = amountBorrowed - totalRepayment;

    const diasMora =
      selectedLoan.endDateAt && new Date() > new Date(selectedLoan.endDateAt)
        ? Math.floor((Date.now() - new Date(selectedLoan.endDateAt).getTime()) / 86_400_000)
        : 0;

    result.push({
      client,
      loanRequest: {
        id: selectedLoan.id,
        status: selectedLoan.status,
        amount: selectedLoan.amount,
        requestedAmount: selectedLoan.requestedAmount,
        createdAt: selectedLoan.createdAt,
        updatedAt: selectedLoan.updatedAt,
        type: selectedLoan.type,
        mode: selectedLoan.mode,
        mora: selectedLoan.mora,
        endDateAt: selectedLoan.endDateAt,
        paymentDay: selectedLoan.paymentDay,
        transactions: selectedLoan.transactions,
      },
      totalRepayment,
      amountBorrowed,
      totalToPay,
      diasMora,
      status,
    });
  }

  return result;
}


 async findAllByAgent(agentId: number): Promise<any[]> {
  const loans = await this.loanRequestRepository.find({
    where: { agent: { id: agentId } },
    relations: { client: true, transactions: true },
    order: { createdAt: 'DESC' },
  });

  const clientMap = new Map<number, any[]>();

  for (const loan of loans) {
    const clientId = loan.client.id;
    if (!clientMap.has(clientId)) {
      clientMap.set(clientId, []);
    }
    clientMap.get(clientId)!.push(loan);
  }

  const result: any[] = [];

  for (const [clientId, clientLoans] of clientMap.entries()) {
    const client = clientLoans[0].client;

    const hasFunded = clientLoans.some((l) => l.status === 'funded');
    const allCompleted = clientLoans.every((l) => l.status === 'completed');
    const hasRejected = clientLoans.some((l) => l.status === 'rejected');

    let status: 'active' | 'inactive' | 'rejected' | 'unknown' = 'unknown';
    if (hasFunded) status = 'active';
    else if (allCompleted) status = 'inactive';
    else if (hasRejected) status = 'rejected';

    if (status === 'unknown') continue; // omitimos los que no tienen estado claro

    const selectedLoan = clientLoans.find((l) =>
      status === 'active' ? l.status === 'funded' :
      status === 'inactive' ? l.status === 'completed' :
      status === 'rejected' ? l.status === 'rejected' :
      false
    );

    const totalRepayment = selectedLoan.transactions
      .filter((t) => t.Transactiontype === 'repayment')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const amountBorrowed = selectedLoan.transactions
      .filter((t) => t.Transactiontype === 'disbursement')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const totalToPay = amountBorrowed - totalRepayment;

    const diasMora =
      selectedLoan.endDateAt && new Date() > new Date(selectedLoan.endDateAt)
        ? Math.floor((Date.now() - new Date(selectedLoan.endDateAt).getTime()) / 86_400_000)
        : 0;

    result.push({
      client,
      loanRequest: {
        id: selectedLoan.id,
        status: selectedLoan.status,
        amount: selectedLoan.amount,
        requestedAmount: selectedLoan.requestedAmount,
        createdAt: selectedLoan.createdAt,
        updatedAt: selectedLoan.updatedAt,
        type: selectedLoan.type,
        mode: selectedLoan.mode,
        mora: selectedLoan.mora,
        endDateAt: selectedLoan.endDateAt,
        paymentDay: selectedLoan.paymentDay,
        transactions: selectedLoan.transactions,
      },
      totalRepayment,
      amountBorrowed,
      totalToPay,
      diasMora,
      status,
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
