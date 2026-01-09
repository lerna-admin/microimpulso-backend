import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LoanTransaction, TransactionType } from 'src/entities/transaction.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { ClientStatus } from 'src/entities/client.entity';
import { ChatService } from 'src/chat/chat.service';
import { CashMovement, CashMovementType } from 'src/entities/cash-movement.entity';
import { Buffer } from 'buffer';
import { Readable } from 'stream';
import * as sharp from 'sharp';
import { CashMovementCategory } from 'src/entities/cash-movement-category.enum';
import { toZonedTime, format, fromZonedTime } from 'date-fns-tz';
import { PaymentAccount } from 'src/payment-accounts/payment-account.entity';
import { User } from 'src/entities/user.entity';

function formatCOP(value: number | string | null | undefined): string {
  if (!value) return 'N/A';
  return `$${Number(value).toLocaleString('es-CO')}`;
}

function formatDateOnly(date: Date | string | null | undefined): string {
  if (!date) return 'N/A';
  return new Date(date).toISOString().split('T')[0];
}


@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(LoanTransaction)
    private readonly transactionRepo: Repository<LoanTransaction>,
    
    @InjectRepository(LoanRequest)
    private readonly loanRequestRepo: Repository<LoanRequest>,
    
    @InjectRepository(CashMovement)
    private readonly cashMovementRepo: Repository<CashMovement>,
    
    @InjectRepository(PaymentAccount)
    private readonly paymentAccountRepo: Repository<PaymentAccount>,
    
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    
    
    private readonly chatService: ChatService,
  ) { }
  
async findRepaymentAccountForLoan(requestedAmount: number): Promise<PaymentAccount | null> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const accounts = await this.paymentAccountRepo.find({
    where: { isActive: true },
    order: { isPrimary: 'DESC' }, // Primary accounts come first
  });

  for (const account of accounts) {
    const totalReceived = await this.transactionRepo
      .createQueryBuilder('tx')
      .leftJoin('tx.loanRequest', 'loan')
      .where('tx.Transactiontype = :type', { type: TransactionType.REPAYMENT })
      .andWhere('loan.repaymentAccountId = :accountId', { accountId: account.id })
      .andWhere('tx.date BETWEEN :start AND :end', {
        start: startOfMonth.toISOString(),
        end: now.toISOString(),
      })
      .select('SUM(tx.amount)', 'sum')
      .getRawOne();

    const currentTotal = Number(totalReceived?.sum ?? 0);
    const projected = currentTotal + requestedAmount;

    if (projected <= Number(account.limit)) {
      return account; // Found a suitable account
    }
  }

  // ────────────────────────────────
  // Fallback: return a default account (first active, ideally primary)
  // ────────────────────────────────
  return accounts.length > 0 ? accounts[0] : null;
}

  
async create(data: any): Promise<LoanTransaction> {
  const {
    loanRequestId,
    transactionType,  // expected: TransactionType.DISBURSEMENT | REPAYMENT | ...
    amount,
    reference,
    userId,           // <── actor performing the operation (comes from frontend/JWT)
  } = data;

  // 1) Load target loan request (with relations we need)
  const loanRequest = await this.loanRequestRepo.findOne({
    where: { id: loanRequestId },
    relations: [
      'client',
      'agent',
      'agent.branch',
      'agent.branch.administrator',
    ],
  });

  if (!loanRequest) {
    throw new NotFoundException('Loan request not found');
  }

  // Derive branch/admin from agent’s branch (kept from your original logic)
  const branchId = loanRequest.agent?.branch?.id;
  const adminIdFromBranch = loanRequest.agent?.branch?.administrator?.id;

  if (!branchId) {
    throw new BadRequestException('Cannot resolve branchId from agent');
  }

  // 2) Resolve actor (who is creating the transaction) and role flags
  let createdByUserId: number | null = null;
  let isAdminTransaction = false;
  let adminIdForMovement: number | null = null;

  if (userId) {
    const actor = await this.userRepository.findOne({ where: { id: Number(userId) } });
    createdByUserId = actor?.id ?? null;
    const role = (actor?.role ?? '').toUpperCase();
    // Treat ADMIN, MANAGER and SUPERADMIN as "admin-made" for business rules
    isAdminTransaction = role === 'ADMIN' || role === 'MANAGER' || role === 'SUPERADMIN';
    adminIdForMovement = isAdminTransaction ? createdByUserId : null;
  }

  // 3) Create and save the LoanTransaction with audit fields
  const transaction = this.transactionRepo.create({
    Transactiontype: transactionType,
    amount,
    reference,
    loanRequest: { id: loanRequest.id },
    // audit fields (must exist in DB):
    createdByUserId: createdByUserId ?? undefined,
    isAdminTransaction, // INTEGER 0/1 in SQLite (TypeORM boolean ok)
  });

  const saved = await this.transactionRepo.save(transaction);

  // 4) Create related CashMovement
  //    REPAYMENT -> ENTRADA / COBRO_CLIENTE
  //    Others (e.g., DISBURSEMENT) -> SALIDA / PRESTAMO
  const isRepayment = transactionType === TransactionType.REPAYMENT;

  await this.cashMovementRepo.save({
    type: isRepayment ? CashMovementType.ENTRADA : CashMovementType.SALIDA,
    category: isRepayment ? CashMovementCategory.COBRO_CLIENTE : CashMovementCategory.PRESTAMO,
    amount,
    reference,
    transaction: { id: saved.id },
    branchId,
    // keep local server time
    date: new Date(),
    // when admin/manager is the actor, we also stamp the movement adminId
    adminId: adminIdForMovement ?? undefined,
  });

  // 5) Disbursement: update loan status and (optional) client notifications
  if (transactionType === TransactionType.DISBURSEMENT) {
    loanRequest.status = LoanRequestStatus.FUNDED;
    await this.loanRequestRepo.save(loanRequest);

    // (Opcional) tu lógica de notificaciones WhatsApp con SVG/PNG
    // try { ... } catch (e) { ... }
  }

  // 6) Repayment: if fully paid, close the loan (your existing logic)
  if (transactionType === TransactionType.REPAYMENT) {
    const allTransactions = await this.transactionRepo.find({
      where: { loanRequest: { id: loanRequest.id } },
    });

    const totalPaid = allTransactions
      .filter((tx) => tx.Transactiontype === TransactionType.REPAYMENT)
      .reduce((sum, tx) => sum + Number(tx.amount), 0);

    if (totalPaid >= Number(loanRequest.amount)) {
      loanRequest.status = LoanRequestStatus.COMPLETED;
      // Si manejas client.status aquí, conserva tu lógica:
      // loanRequest.client.status = ClientStatus.INACTIVE;
      await this.loanRequestRepo.save(loanRequest);
      // await this.loanRequestRepo.manager.save(loanRequest.client);
    }
  }

  return saved;
}
  
  async findAllByLoanRequest(loanRequestId: string): Promise<LoanTransaction[]> {
    return this.transactionRepo.find({
      where: { loanRequest: { id: Number(loanRequestId) } },
      order: { date: 'DESC' },
    });
  }
}
