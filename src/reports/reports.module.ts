import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoanTransaction } from 'src/entities/transaction.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { User } from 'src/entities/user.entity';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { Client } from 'src/entities/client.entity';
import { Document } from 'src/entities/document.entity';
import { Branch } from 'src/entities/branch.entity';

@Module({
  imports: [ TypeOrmModule.forFeature([LoanTransaction, User, LoanRequest, Client, Document, Branch]) ],
  controllers: [ ReportsController ],
  providers: [ ReportsService ],
})
export class ReportsModule {}
