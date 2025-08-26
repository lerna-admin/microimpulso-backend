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
    
    private readonly chatService: ChatService,
  ) { }
  
  async findRepaymentAccountForLoan(requestedAmount: number): Promise<PaymentAccount | null> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const accounts = await this.paymentAccountRepo.find({
      where: { isActive: true },
      order: { isPrimary: 'DESC' },
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
        return account;
      }
    }
    
    return null;
  }
  
  
  async create(data: any): Promise<LoanTransaction> {
    const { loanRequestId, transactionType, amount, reference } = data;
    
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
    const branchId = loanRequest.agent?.branch?.id;
    const adminId  = loanRequest.agent?.branch?.administrator?.id;
    
    if (!branchId || !adminId) {
      throw new BadRequestException(
        'No se pudo determinar branchId o adminId desde el agente'
      );
    }
    
    const transaction = this.transactionRepo.create({
      Transactiontype: transactionType,
      amount,
      reference,
      loanRequest: { id: loanRequest.id },
    });
    
    const saved = await this.transactionRepo.save(transaction);
    
    // Register cash movement based on transaction type
    const movement = this.cashMovementRepo.save({
      type: transactionType === TransactionType.REPAYMENT
      ? CashMovementType.ENTRADA
      : CashMovementType.SALIDA,
      category: transactionType === TransactionType.REPAYMENT
      ? CashMovementCategory.COBRO_CLIENTE
      : CashMovementCategory.PRESTAMO,
      amount,
      reference,
      transaction: { id: saved.id },
      adminId,
      branchId,
      date: new Date(), // Usa hora local del servidor directamente
    });
    
    if (!loanRequest.repaymentAccount) {
      const repaymentAccount = await this.findRepaymentAccountForLoan(loanRequest.requestedAmount);
      if (!repaymentAccount) {
        throw new BadRequestException('No repayment account available with sufficient limit');
      }
      
      loanRequest.repaymentAccount = repaymentAccount;
    }
    if (transactionType === TransactionType.DISBURSEMENT) {
      loanRequest.status = LoanRequestStatus.FUNDED;
      await this.loanRequestRepo.save(loanRequest);
      
      const client = loanRequest.client;
      
      const message = `✅ Tu préstamo de ${formatCOP(loanRequest.requestedAmount)} ha sido desembolsado.\n\n` +
      `💵 Total a pagar: ${formatCOP(loanRequest.amount)}\n` +
      `📅 Fecha límite de pago: ${formatDateOnly(loanRequest.endDateAt)}\n` +
      `📆 Cuotas: Pago único\n\n` +
      `Por favor realiza el pago a tiempo para evitar penalidades.`;
      
      const svgContent = `
<svg width="600" height="250" xmlns="http://www.w3.org/2000/svg">
  <style>
    .title { font: bold 22px sans-serif; fill: #222; }
    .label { font: 16px sans-serif; fill: #333; }
    .value { font: bold 16px sans-serif; fill: #006400; }
  </style>
  <rect width="100%" height="100%" fill="#f9f9f9" stroke="#ccc" stroke-width="1"/>
  <text x="30" y="40" class="title">Tu préstamo ha sido desembolsado</text>
  <text x="30" y="90" class="label">💵 Monto desembolsado:</text>
  <text x="300" y="90" class="value">${formatCOP(loanRequest.requestedAmount)}</text>
  <text x="30" y="130" class="label">📅 Fecha límite de pago:</text>
  <text x="300" y="130" class="value">${formatDateOnly(loanRequest.endDateAt)}</text>
  <text x="30" y="170" class="label">📆 Total a pagar:</text>
  <text x="300" y="170" class="value">${formatCOP(loanRequest.amount)}</text>
</svg>`.trim();
      
      const svgBuffer = Buffer.from(svgContent, 'utf-8');
      const pngBuffer = await sharp(svgBuffer).png().toBuffer();
      /**
      try {
        
        await this.chatService.sendMessageToClient(client.id, message);
        
        await this.chatService.sendSimulationToClient(client.id, {
          fieldname: 'file',
          originalname: 'desembolso.png',
          encoding: '7bit',
          mimetype: 'image/png',
          size: pngBuffer.length,
          destination: '',
          filename: 'desembolso.png',
          path: '',
          buffer: pngBuffer,
          stream: Readable.from(pngBuffer),
        });
      } catch (error) {
        console.log("FALLO DESEMBOLSANDO")
        console.log(error)
      }
      
    }
      TODO: DESCOMENTAR CUANDO SE AJUSTE EL TEMA DE META

    */
    
    if (transactionType === TransactionType.REPAYMENT) {
      const allTransactions = await this.transactionRepo.find({
        where: { loanRequest: { id: loanRequest.id } },
      });
      
      const totalPaid = allTransactions
      .filter(tx => tx.Transactiontype === TransactionType.REPAYMENT)
      .reduce((sum, tx) => sum + Number(tx.amount), 0);
      
      if (totalPaid >= Number(loanRequest.amount)) {
        loanRequest.status = LoanRequestStatus.COMPLETED;
        loanRequest.client.status = ClientStatus.INACTIVE;
        
        await this.loanRequestRepo.save(loanRequest);
        await this.loanRequestRepo.manager.save(loanRequest.client);
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
