import { Controller, Get, Post, Param, Body, Patch, Query, ParseIntPipe, BadRequestException, Req } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { Client } from 'src/entities/client.entity';

@Controller('clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  
  
@Get()
  async findAll(
    @Query('u_id') uId: string,                 // ⬅️ único dato del “current user”
    @Query('limit') limit = '10',
    @Query('page') page = '1',
    @Query('status') status?: string,
    @Query('document') document?: string,
    @Query('name') name?: string,
    @Query('type') type?: string,
    @Query('mode') mode?: string,
    @Query('agent') agent?: string,
    @Query('branch') branch?: string,
    @Query('paymentDay') paymentDay?: string,
    @Query('countryId') countryId?: string,
  ): Promise<any> {
    if (!uId || !String(uId).trim()) {
      throw new BadRequestException('u_id es obligatorio.');
    }
    const requesterUserId = Number(uId);
    if (!Number.isFinite(requesterUserId)) {
      throw new BadRequestException('u_id debe ser numérico.');
    }

    const n = (v?: string) =>
      v !== undefined && v !== null && String(v).trim() !== '' ? Number(v) : undefined;

    const filters: {
      status?: 'active' | 'inactive' | 'rejected';
      document?: string;
      name?: string;
      mode?: string;
      type?: string;
      paymentDay?: string;
      agent?: number;
      branch?: number;
      countryId?: number;
    } = {};

    if (status) {
      const st = status.toLowerCase();
      if (!['active', 'inactive', 'rejected'].includes(st)) {
        throw new BadRequestException('status inválido. Use active|inactive|rejected');
      }
      filters.status = st as any;
    }
    if (document)   filters.document   = document;
    if (name)       filters.name       = name;
    if (mode)       filters.mode       = mode;
    if (type)       filters.type       = type;
    if (paymentDay) filters.paymentDay = paymentDay;

    const nAgent     = n(agent);
    const nBranch    = n(branch);
    const nCountryId = n(countryId);

    if (Number.isFinite(nAgent!))     filters.agent     = nAgent!;
    if (Number.isFinite(nBranch!))    filters.branch    = nBranch!;
    if (Number.isFinite(nCountryId!)) filters.countryId = nCountryId!;

    return this.clientsService.findAll(
      Number(limit) || 10,
      Number(page)  || 1,
      filters,
      requesterUserId,               // ⬅️ solo pasamos el ID del usuario
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
