import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoanTransaction } from 'src/entities/transaction.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { User } from 'src/entities/user.entity';

@Module({
  imports: [ TypeOrmModule.forFeature([LoanTransaction, User]) ],
  controllers: [ ReportsController ],
  providers: [ ReportsService ],
})
export class ReportsModule {}
