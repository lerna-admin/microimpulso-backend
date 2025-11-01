import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Patch,
  Delete,
  ParseIntPipe,
  BadRequestException,
} from '@nestjs/common';
import { BranchService } from './branch.service';

// ----------------- helpers -----------------
type AnyObj = Record<string, any>;

function parseBool(v: any): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'si', 'sí'].includes(s)) return true;
    if (['false', '0', 'no'].includes(s)) return false;
  }
  return undefined;
}

function normalizeCommon(out: AnyObj) {
  // countryIso2 y phoneCountryCode son opcionales en ambos casos
  if (typeof out.countryIso2 === 'string') out.countryIso2 = out.countryIso2.trim().toUpperCase();
  if (typeof out.phoneCountryCode === 'string') {
    out.phoneCountryCode = out.phoneCountryCode.toString().trim().replace(/[^\d]/g, '');
  }

  // acceptsInbound opcional, si viene lo normalizamos a boolean
  if (out.acceptsInbound !== undefined) {
    const b = parseBool(out.acceptsInbound);
    if (b === undefined) throw new BadRequestException('acceptsInbound debe ser boolean');
    out.acceptsInbound = b;
  }

  // permitir administratorId o administrator (ID numérico)
  if (out.administratorId !== undefined && out.administrator === undefined) {
    const n = Number(out.administratorId);
    if (!Number.isFinite(n)) throw new BadRequestException('administratorId debe ser numérico');
    out.administrator = n;
    delete out.administratorId;
  } else if (out.administrator !== undefined) {
    const n = Number(out.administrator);
    if (!Number.isFinite(n)) throw new BadRequestException('administrator debe ser numérico');
    out.administrator = n;
  }
}

// Normaliza body para CREATE: exige name
function normalizeCreateBody(input: AnyObj = {}) {
  const out: AnyObj = { ...input };
  if (typeof out.name === 'string') out.name = out.name.trim();
  if (!out.name) throw new BadRequestException('name es requerido');

  normalizeCommon(out);
  return {
    name: out.name,
    administrator: out.administrator,
    countryIso2: out.countryIso2,
    phoneCountryCode: out.phoneCountryCode,
    acceptsInbound: out.acceptsInbound,
  };
}

// Normaliza body para UPDATE: NO exige name (parcial)
function normalizeUpdateBody(input: AnyObj = {}) {
  const out: AnyObj = { ...input };

  if (out.name !== undefined) {
    if (typeof out.name === 'string') out.name = out.name.trim();
    if (!out.name) throw new BadRequestException('name no puede ser vacío');
  }

  normalizeCommon(out);

  // armamos un objeto parcial solo con campos presentes
  const patch: AnyObj = {};
  if (out.name !== undefined) patch.name = out.name;
  if (out.administrator !== undefined) patch.administrator = out.administrator;
  if (out.countryIso2 !== undefined) patch.countryIso2 = out.countryIso2;
  if (out.phoneCountryCode !== undefined) patch.phoneCountryCode = out.phoneCountryCode;
  if (out.acceptsInbound !== undefined) patch.acceptsInbound = out.acceptsInbound;

  return patch;
}

@Controller('branches')
export class BranchController {
  constructor(private readonly branchService: BranchService) {}

  // ---------- CREATE ----------
  @Post()
  async create(@Body() body: any) {
    const payload = normalizeCreateBody(body);
    const branch = await this.branchService.create(payload);
    // el service ya devuelve POJO plano; retornamos tal cual
    return branch;
  }

  // ---------- LIST ----------
  @Get()
  findAll(
    @Query('name') name?: string,
    @Query('administratorId') administratorId?: string,
    @Query('countryIso2') countryIso2?: string,
    @Query('acceptsInbound') acceptsInbound?: string,
  ) {
    const filters: AnyObj = {};
    if (name) filters.name = name;
    if (administratorId != null && administratorId !== '') {
      const n = Number(administratorId);
      if (!Number.isFinite(n)) throw new BadRequestException('administratorId debe ser numérico');
      filters.administratorId = n;
    }
    if (countryIso2) filters.countryIso2 = countryIso2.toUpperCase();
    if (acceptsInbound !== undefined) {
      const b = parseBool(acceptsInbound);
      if (b !== undefined) filters.acceptsInbound = b;
    }
    return this.branchService.findAll(filters);
  }

  // ---------- GET ONE ----------
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.branchService.findOne(id);
  }

  // ---------- UPDATE ----------
  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    // NO exigimos name; normalizamos solo lo que venga
    const payload = normalizeUpdateBody(body);
    // no permitimos cambiar ID por body
    if ('id' in payload) delete payload.id;

    const updated = await this.branchService.update(id, payload);
    return updated; // POJO plano desde el service
  }

  // ---------- DELETE ----------
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.branchService.remove(id);
  }
}
