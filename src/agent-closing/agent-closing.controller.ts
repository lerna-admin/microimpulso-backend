// src/closing/closing.controller.ts
import {
  Controller,
  Post,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';

import { ClosingService } from './agent-closing.service';
import { UsersService } from '../users/users.service';

@Controller('closing')
export class ClosingController {
  constructor(
    private readonly closingService: ClosingService,
    private readonly usersService: UsersService,
  ) {}

  /* =====================================================================
   * POST /closing/agent/:id/close-day
   *
   *  • Guard guarantees the authenticated user is the same agent
   *    (or an admin allowed to close on his behalf).
   *  • Creates an AgentClosing row; if a closing already exists
   *    for today it throws 400.
   * ==================================================================== */
  @Post('agent/:id/close-day')
  async closeDay(
    @Param('id', ParseIntPipe) agentId: number,
  ) {
    const agent = await this.usersService.findById(agentId); // full User entity
    return this.closingService.closeDay(agent);             // returns AgentClosing
  }
}
