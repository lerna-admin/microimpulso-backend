import { Controller, Get, Post, Param, Body, Patch, Query, ParseIntPipe, BadRequestException } from '@nestjs/common';
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
    @Query('branch') branch?: number,
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
        agent,
        branch
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

  /**
   * Search clients by a free-text query across multiple fields.
   * q: search string (required)
   * limit/offset: optional pagination
   */
  @Get('query')
  async search(
    @Query('q') q?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    console.log("entro a query")
    if (!q || !q.trim()) {
      throw new BadRequestException('Missing required query param "q".');
    }
    return this.clientsService.search(q.trim(), { limit, offset });
  }

  
@Get(':id')
findOne(@Param('id', ParseIntPipe) id: number) {
  return this.clientsService.findOne(id);
}
  


}
