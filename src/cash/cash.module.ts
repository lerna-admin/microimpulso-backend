import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashMovement } from 'src/entities/cash-movement.entity';
import { AgentClosing } from 'src/entities/agent-closing.entity'; 
import { CashService } from './cash.service';
import { CashController } from './cash.controller';
import { LoanRequestStatus } from 'src/entities/loan-request.entity';
import { LoanTransaction } from 'src/entities/transaction.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CashMovement, AgentClosing, LoanTransaction]),  
  ],
  providers: [CashService],
  controllers: [CashController],
  exports: [CashService],
})
export class CashModule {}
