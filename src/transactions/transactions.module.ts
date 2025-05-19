import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { Transaction } from 'src/entities/transaction.entity';
import { LoanRequest } from 'src/entities/loan-request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction, LoanRequest])],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
