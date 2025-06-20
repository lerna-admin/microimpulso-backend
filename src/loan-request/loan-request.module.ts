import { Module } from '@nestjs/common';
import { LoanRequestService } from './loan-request.service';
import { LoanRequestController } from './loan-request.controller';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from '../chat/chat.module';
import { LoanTransaction } from '../entities/transaction.entity';
import { UsersModule } from '../users/users.module'
import { User } from '../entities/user.entity';




@Module({
  imports: [
    TypeOrmModule.forFeature([LoanRequest,LoanTransaction, User]),
    ChatModule,
    UsersModule
  ],
  controllers: [LoanRequestController],
  providers: [LoanRequestService],
  exports: [LoanRequestService],
})
export class LoanRequestModule {}
