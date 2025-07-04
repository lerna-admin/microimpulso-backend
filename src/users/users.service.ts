import { ConsoleLogger, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole} from '../entities/user.entity';
import { truncate } from 'fs';
import { Permission } from 'src/entities/permissions.entity';
import { Branch } from 'src/entities/branch.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(Branch)
    private readonly branchRepository: Repository<Branch>,
    
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
      branchId?: string;
      
    };
  }): Promise<{ data: User[]; total: number; page: number; limit: number }> {
    const { page, limit, filters } = options;
    
    const query = this.userRepository
    .createQueryBuilder('user')
    .leftJoinAndSelect('user.branch', 'branch'); // Include full branch info
    
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
    
    if (filters.branchId !== undefined) {
      query.andWhere('user.branchId = :branchId', { branchId: filters.branchId });
    }
    
    query.skip((page - 1) * limit).take(limit);
    
    const [data, total] = await query.getManyAndCount();
    
    return { data, total, page, limit };
  }
  
  
  
  // Find user by ID, including branch details
  async findById(id: number): Promise<User | null> {
    /* 1️⃣  Load the user with current permissions */
    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['branch', 'permissions'],
    });
    if (!user) return null;
    
    /* 2️⃣  Load the full permission catalogue */
    const allPermissions = await this.permissionRepository.find();
    
    /* 3️⃣  Build a quick-lookup Set of granted permission IDs */
    const grantedSet = new Set(user.permissions.map(p => p.id));
    
    /* 4️⃣  Produce the enriched list */
    const permissionsWithFlag = allPermissions.map(p => ({
      id:          p.id,
      name:        p.name,
      description: p.description,
      label:       p.label,
      granted:     grantedSet.has(p.id),
    }));
    
    /* 5️⃣  Return user with the complete permission list */
    return {
      ...user,
      permissions: permissionsWithFlag,
    } as unknown as User;
  }
  
  /**
  * Find user by document and return
  *  ▸ branch data
  *  ▸ an array with **all** permissions
  *    - granted → true
  *    - not granted → false
  */
  async findByDocument(document: string): Promise<User | null> {
    const user = await this.userRepository.findOne({
      where: { document },
      relations: { branch: true, permissions: true },
    });
    if (!user) return null; // not found
    
    // 2️⃣ Load the full permission catalogue
    const allPermissions = await this.permissionRepository.find();
    
    // 3️⃣ Build the “complete” permission list with a boolean flag
    const permissionMap = new Set(user.permissions.map(p => p.id));
    const permissionsWithFlag = allPermissions.map(p => ({
      id:          p.id,
      name:        p.name,
      description: p.description,
      label:       p.label,
      granted:     permissionMap.has(p.id), // true / false
    }));
    
    // 4️⃣ Replace the original array with the enriched one
    //     (or attach under another key if you prefer)
    return {
      ...user,
      permissions: permissionsWithFlag,
    } as unknown as User;
  }
  
  
  // Create a new user
  async create(data: Partial<User>): Promise<User> {
    const user = this.userRepository.create({
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    
    if( user.role == UserRole.ADMINISTRATOR){
      //UPDATE BRANCH
      let resp = await this.branchRepository.update(user.branchId, {
        administrator: { id: user.id },
      });      
      console.log(resp)
    }else {
      console.log(user.role, UserRole.ADMINISTRATOR)
    }
    return this.userRepository.save(user);
  }
  async update(id: number, data: Partial<User>): Promise<User | null> {
    await this.userRepository.update(id, data);
    return this.userRepository.findOne({ where: { id } });
  }

}
