import { Controller, Get, Post, Param, Body, Patch, Query } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { Client } from 'src/entities/client.entity';

@Controller('clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  
  
  @Get()
  findAll(
    @Query('limit') limit = 10,
    @Query('page') page = 1,
    @Query('status') status?: string,
    @Query('document') document?: string,
    @Query('name') name?: string,
    @Query('type') type?: string,
    @Query('mode') mode?: string,
    @Query('agent') agent?: number,

    @Query('paymentDay') paymentDay?: string,
    
    
  ): Promise<any> {
    return this.clientsService.findAll(
      Number(limit),
      Number(page),
      {
        status: status?.toLowerCase() as 'active' | 'inactive' | 'rejected',
        document,
        name,
        type,
        mode,
        paymentDay,
        agent
      },
    );
  }
  
  @Get('agent/:agentId')
  findAllByAgent(
    @Param('agentId') agentId: number,
    @Query('limit') limit = 10,
    @Query('page') page = 1,
    @Query('status') status?: string,
    @Query('document') document?: string,
    @Query('name') name?: string,
       @Query('type') type?: string,
    @Query('mode') mode?: string,
    @Query('paymentDay') paymentDay?: string,

  ): Promise<any> {
    return this.clientsService.findAllByAgent(
      agentId,
      Number(limit),
      Number(page),
      {
        status: status?.toLowerCase() as 'active' | 'inactive' | 'rejected',
        document,
        name,
        type,
        mode,
        paymentDay
      }
    );
  }
  
  // GET /clients/:id → return a specific client by ID
  @Get(':id')
  findOne(@Param('id') id: number) {
    return this.clientsService.findOne(id);
  }
  
  // POST /clients → create a new client
  @Post()
  create(@Body() body: any) {
    return this.clientsService.create(body);
  }
  // ✅ PATCH /clients/:id → update existing client
  @Patch(':id')
  update(@Param('id') id: number, @Body() body: any) {
    return this.clientsService.update(+id, body);
  }
}
