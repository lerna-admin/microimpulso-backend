import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction, TransactionType } from 'src/entities/transaction.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,

    @InjectRepository(LoanRequest)
    private readonly loanRequestRepo: Repository<LoanRequest>,
  ) {}

 async create(data: any): Promise<Transaction> {
  const { loanRequestId, transactionType, amount } = data;

  const loanRequest = await this.loanRequestRepo.findOne({
    where: { id: loanRequestId },
  });

  if (!loanRequest) {
    throw new NotFoundException('Loan request not found');
  }

  // Si es un desembolso, cambia el estado del préstamo
  if (transactionType === 'disbursement') {
    loanRequest.status = LoanRequestStatus.APPROVED; // asegúrate que este estado exista en tu enum o columna
    await this.loanRequestRepo.save(loanRequest);
  }

  const transaction = this.transactionRepo.create({
    Transactiontype: transactionType,
    amount,
    loanRequest,
  });

  return this.transactionRepo.save(transaction);
}


  async findAllByLoanRequest(loanRequestId: string): Promise<Transaction[]> {
    return this.transactionRepo.find({
      where: { loanRequest: { id: Number(loanRequestId)} },
      order: { date: 'DESC' },
    });
  }
}
