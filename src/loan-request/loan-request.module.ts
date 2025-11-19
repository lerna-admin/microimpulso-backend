import { Module } from '@nestjs/common';
import { LoanRequestService } from './loan-request.service';
import { LoanRequestController } from './loan-request.controller';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from '../chat/chat.module';
import { LoanTransaction } from '../entities/transaction.entity';
import { UsersModule } from '../users/users.module'
import { User } from '../entities/user.entity';
import { Notification } from 'src/notifications/notifications.entity';
import { Client } from 'src/entities/client.entity';
import { ClientsModule } from 'src/clients/clients.module';
import { CashMovement } from 'src/entities/cash-movement.entity';



@Module({
  imports: [
    TypeOrmModule.forFeature([LoanRequest, LoanTransaction, CashMovement, User, Notification, Client]),
    ChatModule,
    UsersModule,
    ClientsModule
    
  ],
  controllers: [LoanRequestController],
  providers: [LoanRequestService],
  exports: [LoanRequestService],
})
export class LoanRequestModule {}
