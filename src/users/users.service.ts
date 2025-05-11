import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  // Find all users
  async findAll(): Promise<User[]> {
    return this.userRepository.find();
  }

  // Find user by ID
  async findById(id: number): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  // Find user by document
  async findByDocument(document: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { document } });
  }

  // Create a new user
  async create(data: Partial<User>): Promise<User> {
    const user = this.userRepository.create({
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return this.userRepository.save(user);
  }
}
