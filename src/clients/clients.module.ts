import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { Client } from '../entities/client.entity';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { User } from 'src/entities/user.entity';
import { Country } from 'src/entities/country.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Client, LoanRequest, User, Country])], // ✅ Importa el repositorio aquí
  controllers: [ClientsController],
  providers: [ClientsService],
})
export class ClientsModule {}
