import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashMovement } from 'src/entities/cash-movement.entity';
import { AgentClosing } from 'src/entities/agent-closing.entity'; 
import { CashService } from './cash.service';
import { CashController } from './cash.controller';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { LoanTransaction } from 'src/entities/transaction.entity';
import { User } from 'src/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CashMovement, AgentClosing, LoanTransaction, User, LoanRequest]),  
  ],
  providers: [CashService],
  controllers: [CashController],
  exports: [CashService],
})
export class CashModule {}
