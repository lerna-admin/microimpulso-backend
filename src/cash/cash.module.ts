import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashMovement } from 'src/entities/cash-movement.entity';
import { AgentClosing } from 'src/entities/agent-closing.entity'; 
import { CashService } from './cash.service';
import { CashController } from './cash.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([CashMovement, AgentClosing]),  
  ],
  providers: [CashService],
  controllers: [CashController],
  exports: [CashService],
})
export class CashModule {}
