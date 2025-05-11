import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { UsersService } from './users.service';
import { User } from '../entities/user.entity';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // GET /users → return all users
  @Get()
  findAll(): Promise<User[]> {
    return this.usersService.findAll();
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
}
