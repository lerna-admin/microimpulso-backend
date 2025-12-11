import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { Client } from '../entities/client.entity';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { User } from 'src/entities/user.entity';
import { Country } from 'src/entities/country.entity';
import { ChatMessage } from 'src/entities/chat-message.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Client, LoanRequest, ChatMessage, User, Country])],
  controllers: [ClientsController],
  providers: [ClientsService],
})
export class ClientsModule {}
