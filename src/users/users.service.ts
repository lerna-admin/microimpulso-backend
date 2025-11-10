import { ConsoleLogger, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus} from '../entities/user.entity';
import { truncate } from 'fs';
import { Permission } from 'src/entities/permissions.entity';
import { Branch } from 'src/entities/branch.entity';
import { Country } from 'src/entities/country.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(Branch)
    private readonly branchRepository: Repository<Branch>,
     @InjectRepository(Country)
    private readonly countryRepository: Repository<Country>,
    
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
  // 1) Cargar usuario con relaciones necesarias
  const user = await this.userRepository.findOne({
    where: { document },
    relations: {
      branch: { country: true },  // para ADMIN/AGENT
      managerCountry: true,       // para MANAGER
      permissions: true,
    },
  });
  if (!user) return null;

  // 2) Catálogo de permisos + flags
  const allPermissions = await this.permissionRepository.find();
  const grantedSet = new Set(user.permissions.map(p => p.id));
  const permissionsWithFlag = allPermissions.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    label: p.label,
    granted: grantedSet.has(p.id),
  }));

  // 3) Determinar country completo según rol
  const role = String((user as any).role ?? '').toUpperCase();

  // Tipado laxo para no acoplar a tu entidad concreta
  type CountryLike = { id: number; name?: string; code?: string; [k: string]: any };

  let country: CountryLike | null = null;

  if (role === 'MANAGER') {
    country = (user as any).managerCountry ?? null;
    if (!country) {
      const mcId = (user as any).managerCountryId ?? null;
      if (mcId != null) {
        country = await this.countryRepository.findOne({ where: { id: mcId } }) as any;
      }
    }
  } else {
    // ADMIN / AGENT
    country = (user as any)?.branch?.country ?? null;
    if (!country) {
      // intentar con branch.countryId si existe
      const branch: any = (user as any).branch ?? null;
      const countryId =
        (branch && 'countryId' in branch) ? Number(branch.countryId) :
        (branch?.country?.id ?? null);
      if (countryId != null) {
        country = await this.countryRepository.findOne({ where: { id: countryId } }) as any;
      }
    }
  }

  // 4) Retornar usuario enriquecido con country completo
  return {
    ...user,
    permissions: permissionsWithFlag,
    country, // ← objeto completo del país al que “pertenece” el usuario según su rol
  } as unknown as User;
}

  
  // Create a new user
  async create(data: Partial<User>): Promise<User> {
    /* 1️⃣  Persist the user first – we need its ID for the branch update */
    const savedUser = await this.userRepository.save(
      this.userRepository.create({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  
    /* 2️⃣  If the user is an ADMINISTRATOR, set them as branch.administrator */
    if (
      savedUser.role === UserRole.ADMINISTRATOR &&      // correct role check
      savedUser.branchId !== undefined                  // make sure we have a branch
    ) {
      await this.branchRepository.update(savedUser.branchId, {
        administrator: { id: savedUser.id },            // partial relation object
      });
    }
  
    /* 3️⃣  Return the newly created user (already contains the PK) */
    return savedUser;
  }
  async update(id: number, data: Partial<User>): Promise<User | null> {
    await this.userRepository.update(id, data);
    return this.userRepository.findOne({ where: { id } });
  }

  /** ----------------------------------------------------------------
   *  Unblock a user: sets status to ACTIVE (idempotent).
   *  - Returns null if user doesn't exist.
   *  - If already ACTIVE, just returns the current user.
   *  ---------------------------------------------------------------- */
  async unblock(id: number): Promise<User | null> {
    // 1) Load the user by id
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) return null;

    // 2) If already ACTIVE, return as-is (idempotent)
    if (user.status === UserStatus.ACTIVE) {
      return user;
    }

    // 3) Set status to ACTIVE and persist
    user.status = UserStatus.ACTIVE;

    // (Optional future) If you later add lock-related fields,
    // reset them here, e.g. failedLoginAttempts = 0, lockedUntil = null.

    return this.userRepository.save(user);
  }

}
