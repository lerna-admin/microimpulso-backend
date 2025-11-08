import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
} from '@nestjs/common';
import { CountriesService } from './country.service';
@Controller('countries')
export class CountriesController {
  constructor(private readonly countriesService: CountriesService) {}

  // ──────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────
  @Get()
  async findAll(
    @Query('limit') limit = '20',
    @Query('page') page = '1',
    @Query('q') q?: string, // búsqueda por code/name
  ) {
    const nLimit = Number(limit) || 20;
    const nPage = Number(page) || 1;
    return this.countriesService.findAll(nLimit, nPage, q);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.countriesService.findOne(Number(id));
  }

  @Post()
  async create(@Body() data: any) {
    // data: { code, name }
    return this.countriesService.create(data);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() data: any) {
    return this.countriesService.update(Number(id), data);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.countriesService.remove(Number(id));
  }

  // ──────────────────────────────────────
  // RELACIONES
  // ──────────────────────────────────────
  @Get(':id/branches')
  async branches(@Param('id') id: string) {
    return this.countriesService.getBranches(Number(id));
  }

  @Get(':id/clients')
  async clients(@Param('id') id: string) {
    return this.countriesService.getClients(Number(id));
  }

  @Get(':id/managers')
  async managers(@Param('id') id: string) {
    return this.countriesService.getManagers(Number(id));
  }

  // Asignar / quitar manager a este país
  @Post(':id/managers/:userId')
  async assignManager(@Param('id') id: string, @Param('userId') userId: string) {
    return this.countriesService.assignManager(Number(id), Number(userId));
  }

  @Delete(':id/managers/:userId')
  async unassignManager(@Param('id') id: string, @Param('userId') userId: string) {
    return this.countriesService.unassignManager(Number(id), Number(userId));
  }
}
