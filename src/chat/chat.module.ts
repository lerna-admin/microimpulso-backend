import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { Client } from '../entities/client.entity';
import { User } from '../entities/user.entity';
import { LoanRequest } from '../entities/loan-request.entity';
import { ChatMessage } from '../entities/chat-message.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Client,
      User,
      LoanRequest,
      ChatMessage,
    ]),
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
