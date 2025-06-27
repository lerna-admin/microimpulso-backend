import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentClosing } from '../entities/agent-closing.entity';
import { ClosingService } from './agent-closing.service';
import { ClosingController } from './agent-closing.controller';
import { LoanRequestModule } from '../loan-request/loan-request.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { User } from 'src/entities/user.entity';
import { Branch } from 'src/entities/branch.entity';



import { UsersModule } from '../users/users.module';   // ⬅️  provides UsersService
// If your OwnAgentGuard lives in another module (AuthModule, etc.)
// simply import that module here as well.

@Module({
  /* -------------------------------------------
   * TypeORM needs the entity, and we need the
   * UsersModule to fetch the agent user object.
   * ----------------------------------------- */
  imports: [
    TypeOrmModule.forFeature([AgentClosing, User,Branch]),
    UsersModule,
    LoanRequestModule,
    NotificationsModule
  ],

  /* REST entry-point */
  controllers: [ClosingController],

  /* Business logic */
  providers: [ClosingService],

  /* Export the service so other modules/guards
   * can inject ClosingService if they need to
   * check "isClosedToday". */
  exports: [ClosingService],
})
export class ClosingModule {}
