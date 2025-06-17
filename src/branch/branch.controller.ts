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
} from '@nestjs/common';
import { BranchService } from './branch.service';

@Controller('branches')
export class BranchController {
  constructor(private readonly branchService: BranchService) {}

  @Post()
  create(@Body() body: any) {
    return this.branchService.create(body);
  }

  @Get()
  findAll(
    @Query('name') name?: string,
    @Query('administratorId') administratorId?: string,
  ) {
    return this.branchService.findAll({
      name,
      administratorId: administratorId ? +administratorId : undefined,
    });
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.branchService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.branchService.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.branchService.remove(id);
  }
}
