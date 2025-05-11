import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { Client } from 'src/entities/client.entity';

@Controller('clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  // GET /clients → return all clients
  @Get()
  findAll(): Promise<Client[]> {
    return this.clientsService.findAll();
  }

  @Get('agent/:id')
  findByAgent(@Param('id') agentId: number): Promise<Client[]> {
    return this.clientsService.findAllByAgent(agentId);
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
}
