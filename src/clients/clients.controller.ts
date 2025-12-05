import { Controller, Get, Post, Param, Body, Patch, Query, ParseIntPipe, BadRequestException, Req } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { Client } from 'src/entities/client.entity';
import { distinct, filter } from 'rxjs';

@Controller('clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  
  
@Get()
async findAll(
  @Query('u_id') uId: string | string[],
  @Query('limit') limit = '10',
  @Query('page') page = '1',
  @Query('status') status?: string,
  @Query('mora') mora?: string,
  @Query('document') document?: string,
  @Query('name') name?: string,
  @Query('type') type?: string,
  @Query('mode') mode?: string,
  @Query('agent') agent?: string,
  @Query('branch') branch?: string,
  @Query('paymentDay') paymentDay?: string,
  @Query('countryId') countryId?: string,
  @Query('distinct') distinct?: string | string[],
) {
  const uRaw = Array.isArray(uId) ? uId[0] : uId;
  if (!uRaw || !String(uRaw).trim()) {
    throw new BadRequestException('u_id es obligatorio.');
  }
  const requesterUserId = Number(uRaw);
  if (!Number.isFinite(requesterUserId)) {
    throw new BadRequestException('u_id debe ser numérico.');
  }

  const n = (v?: string) =>
    v !== undefined && v !== null && String(v).trim() !== '' ? Number(v) : undefined;

  const dRaw = Array.isArray(distinct) ? distinct[0] : distinct;
  const distinctFlag = String(dRaw ?? '').trim().toLowerCase() === 'true';

  // ⬇️ construir filters correctamente
  const filters: {
    status?: 'active' | 'inactive' | 'rejected';
    mora?: string;
    document?: string;
    name?: string;
    mode?: string;
    type?: string;
    paymentDay?: string;
    agent?: number;
    branch?: number;
    countryId?: number;
    distinct?: boolean;
  } = { distinct: distinctFlag };

  if (typeof name === 'string' && name.trim() !== '') {
    filters.name = name.trim();
  }
  if (typeof document === 'string' && document.trim() !== '') {
    filters.document = document.trim();
  }
  if (typeof mode === 'string' && mode.trim() !== '') {
    filters.mode = mode.trim();
  }
  if (typeof type === 'string' && type.trim() !== '') {
    filters.type = type.trim();
  }
  if (typeof paymentDay === 'string' && paymentDay.trim() !== '') {
    filters.paymentDay = paymentDay.trim();
  }
  if (typeof status === 'string' && status.trim() !== '') {
    const s = status.trim().toLowerCase();
    if (s === 'active' || s === 'inactive' || s === 'rejected') {
      filters.status = s as 'active' | 'inactive' | 'rejected';
    }
  }
  if (typeof mora === 'string' && mora.trim() !== '') {
    filters.mora = mora.trim().toUpperCase();
  }

  const nAgent     = n(agent);
  const nBranch    = n(branch);
  const nCountryId = n(countryId);
  if (Number.isFinite(nAgent!))     filters.agent     = nAgent!;
  if (Number.isFinite(nBranch!))    filters.branch    = nBranch!;
  if (Number.isFinite(nCountryId!)) filters.countryId = nCountryId!;

  const l = Number(limit) || 10;
  const p = Number(page)  || 1;

  // Opcional: log temporal para verificar que name llega
  // console.log('filters=', filters);

  return this.clientsService.findAll(
    l,
    p,
    filters,
    requesterUserId,
  );
}





  
  @Get('agent/:agentId')
  findAllByAgent(
    @Param('agentId') agentId: number,
    @Query('limit') limit = 10,
    @Query('page') page = 1,
    @Query('status') status?: string,
    @Query('mora') mora?: string,
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
        mora: mora?.toUpperCase(),
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
