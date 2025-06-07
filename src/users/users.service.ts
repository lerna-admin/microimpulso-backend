import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole} from '../entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}
async findAll(options: {
  page: number;
  limit: number;
  filters: {
    name?: string;
    email?: string;
    document?: string;
    role?: UserRole;
    adminId?: number;
  };
}): Promise<{ data: User[]; total: number; page: number; limit: number }> {
  const { page, limit, filters } = options;

  const query = this.userRepository.createQueryBuilder('user');

  if (filters.name) {
    query.andWhere('LOWER(user.name) LIKE :name', {
      name: `%${filters.name.toLowerCase()}%`,
    });
  }

  if (filters.email) {
    query.andWhere('LOWER(user.email) LIKE :email', {
      email: `%${filters.email.toLowerCase()}%`,
    });
  }

  if (filters.document) {
    query.andWhere('LOWER(user.document) LIKE :document', {
      document: `%${filters.document.toLowerCase()}%`,
    });
  }

  if (filters.role) {
    query.andWhere('user.role = :role', { role: filters.role });
  }

  if (filters.adminId !== undefined) {
    query.andWhere('user.adminId = :adminId', { adminId: filters.adminId });
  }

  query.skip((page - 1) * limit).take(limit);

  const [data, total] = await query.getManyAndCount();

  return { data, total, page, limit };
}


  
// Find user by ID, including branch details
async findById(id: number): Promise<User | null> {
  return this.userRepository.findOne({
    where: { id },
    relations: ['branch'], // Include full branch info
  });
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
