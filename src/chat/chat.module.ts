import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';

import { Client } from '../entities/client.entity';
import { User } from '../entities/user.entity';
import { LoanRequest } from '../entities/loan-request.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { Document } from '../entities/document.entity';
import { Notification } from 'src/notifications/notifications.entity';
import { Branch } from 'src/entities/branch.entity';

@Module({
  imports: [
    // Importar ConfigModule aquí garantiza que ConfigService esté disponible
    // incluso si no lo marcaste global en AppModule.
    ConfigModule,
    TypeOrmModule.forFeature([
      Client,
      User,
      LoanRequest,
      ChatMessage,
      Document,
      Notification,
      Branch
    ]),
  ],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
