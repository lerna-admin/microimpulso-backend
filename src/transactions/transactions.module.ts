import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { LoanTransaction } from 'src/entities/transaction.entity';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { ChatModule } from 'src/chat/chat.module'; // Import the module that exports ChatService
import { CashMovement } from 'src/entities/cash-movement.entity';
import { PaymentAccount } from 'src/payment-accounts/payment-account.entity';
import { User } from 'src/entities/user.entity';

@Module({
  // Import TypeORM entities and ChatModule to inject ChatService
  imports: [TypeOrmModule.forFeature([LoanTransaction, LoanRequest,CashMovement, PaymentAccount, User]), ChatModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
