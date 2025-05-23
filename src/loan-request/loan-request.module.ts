import { Module } from '@nestjs/common';
import { LoanRequestService } from './loan-request.service';
import { LoanRequestController } from './loan-request.controller';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from '../chat/chat.module'; // ✅ Importación necesaria para usar ChatService

@Module({
  imports: [
    TypeOrmModule.forFeature([LoanRequest]),
    ChatModule, // ✅ Esto permite usar ChatService en el controller o service
  ],
  controllers: [LoanRequestController],
  providers: [LoanRequestService],
  exports: [LoanRequestService],
})
export class LoanRequestModule {}
