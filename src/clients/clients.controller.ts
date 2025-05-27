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
  ): Promise<any> {
    return this.clientsService.findAll(Number(limit), Number(page));
  }

  @Get('agent/:id')
  findByAgent(
    @Param('id') agentId: number,
    @Query('limit') limit = 10,
    @Query('page') page = 1,
  ): Promise<any> {
    return this.clientsService.findAllByAgent(agentId, Number(limit), Number(page));
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
