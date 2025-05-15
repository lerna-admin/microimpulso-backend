import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { Client } from '../entities/client.entity';
import { LoanRequest } from 'src/entities/loan-request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Client, LoanRequest])], // ✅ Importa el repositorio aquí
  controllers: [ClientsController],
  providers: [ClientsService],
})
export class ClientsModule {}
