import { Controller, Get, Post, Body, Param, Query, DefaultValuePipe, ParseIntPipe, NotFoundException, Patch } from '@nestjs/common';
import { UsersService } from './users.service';
import { User, UserRole} from '../entities/user.entity';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}
  
  @Get()
async findAll(
  @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  @Query('name') name?: string,
  @Query('email') email?: string,
  @Query('document') document?: string,
  @Query('role') role?: UserRole,
  @Query('adminId') adminIdRaw?: string,
  @Query('branchId') branchId?: string,

): Promise<{ data: User[]; total: number; page: number; limit: number }> {
  const adminId = adminIdRaw && !isNaN(Number(adminIdRaw)) ? Number(adminIdRaw) : undefined;
  return this.usersService.findAll({
    page,
    limit,
    filters: {
      name,
      email,
      document,
      role,
      adminId,
      branchId
    },
  });
}
  
  // GET /users/:id → return a specific user by ID
  @Get(':id')
  findOne(@Param('id') id: number): Promise<User | null> {
    return this.usersService.findById(id);
  }
  
  // GET /users/by-document?doc=XXXX → return user by document
  @Get('/document/:doc')
  findByDocument(@Param('doc') doc: string): Promise<User | null> {
    return this.usersService.findByDocument(doc);
  }
  
  // POST /users → create new user
  @Post()
  create(@Body() data: Partial<User>): Promise<User> {
    return this.usersService.create(data);
  }
  /* ---------- PATCH /users/:id  (update) --------------------------- */
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: Partial<User>,
  ): Promise<User> {
    const updated = await this.usersService.update(id, data);
    if (!updated) throw new NotFoundException('User not found');
    return updated;
  }

   /* ---------- PATCH /users/:id/unblock  (set status ACTIVE) -------- */
  @Patch(':id/unblock')
  async unblock(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<User> {
    /** @brief Unblock a user: sets status to ACTIVE. Idempotent. */
    const updated = await this.usersService.unblock(id);
    if (!updated) throw new NotFoundException('User not found');
    return updated;
  }
}
