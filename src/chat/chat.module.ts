import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { Client } from '../entities/client.entity';
import { User } from '../entities/user.entity';
import { LoanRequest } from '../entities/loan-request.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { Document } from '../entities/document.entity';
import { NotificationsService } from 'src/notifications/notifications.service';
import { Notification } from 'src/notifications/notifications.entity';
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Client,
      User,
      LoanRequest,
      ChatMessage,
      Document,
      Notification
    ]),
  ],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService], 
})
export class ChatModule {}