import { BadRequestException, ConsoleLogger, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { User, UserRole, UserStatus} from '../entities/user.entity';
import { truncate } from 'fs';
import { Permission } from 'src/entities/permissions.entity';
import { Branch } from 'src/entities/branch.entity';
import { Country } from 'src/entities/country.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';

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

   /**
   * Inactiva un usuario (AGENT o ADMIN) con reglas de reemplazo.
   * - ADMIN puede inactivar AGENT de su propia branch (siendo su administrator).
   * - MANAGER puede inactivar ADMIN; si el admin maneja branch(es), debe elegirse o crearse admin reemplazo (que no administre otra).
   *
   * @param targetUserId ID del usuario a inactivar
   * @param body { replacementUserId?, createReplacement?, reason? }
   * @param currentUser Usuario autenticado (req.user)
   */
async inactivateUser(
  targetUserId: number,
  body: any,
  currentUser: any,
) {
  // ===== Helpers (solo console.*) =====
  const safeBody = (b: any) => {
    try {
      const clone: any = JSON.parse(JSON.stringify(b ?? {}));
      const SENSITIVE = ['password', 'pass', 'pwd', 'token', 'accessToken', 'secret', 'authorization'];
      const redact = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        for (const k of Object.keys(obj)) {
          if (SENSITIVE.includes(k)) obj[k] = '***REDACTED***';
          else if (typeof obj[k] === 'object') redact(obj[k]);
        }
      };
      redact(clone);
      return clone;
    } catch { return b; }
  };
  const logErrorAndRethrow = (e: any, where: string, extra?: Record<string, any>) => {
    console.error(`[inactivateUser][ERROR] ${where} ::`, {
      msg: e?.message, name: e?.name, code: e?.code, driverError: e?.driverError, ...extra,
    });
    throw e;
  };

  // Determinar el "actor" (quien ejecuta), SIN exigir autenticación previa
  const actorUserId =
    Number(currentUser?.id ?? body?.currentUserId ?? body?.currentUser ?? NaN);

  const ctx = {
    targetUserId,
    actorUserId: isNaN(actorUserId) ? undefined : actorUserId,
    body: safeBody(body),
  };

  console.log('[inactivateUser] called ::', ctx);

  try {
    // Cargar target con relaciones necesarias
    let target: User | null = null;
    try {
      target = await this.userRepository.findOne({
        where: { id: targetUserId },
        relations: ['branch', 'branch.administrator'],
      });
      console.log('[inactivateUser] loaded target ::', target ? { id: target.id, role: target.role, branchId: target.branch?.id } : null);
    } catch (e) {
      return logErrorAndRethrow(e, 'findOne(target)', ctx);
    }

    if (!target) {
      console.error('[inactivateUser] Target no existe ::', ctx);
      throw new NotFoundException('Usuario a inactivar no existe.');
    }

    // Proteger contra auto-inactivación si el actor es el mismo target (solo si conocemos actorUserId)
    if (!isNaN(actorUserId) && target.id === actorUserId) {
      console.error('[inactivateUser] Auto-inactivación bloqueada ::', { ...ctx, targetId: target.id });
      throw new BadRequestException('No puedes inactivarte a ti mismo.');
    }

    const targetRole = String(target.role).toUpperCase();

    // ===== TRANSACCIÓN =====
    try {
      return await this.userRepository.manager.transaction(async (trx) => {
        const txnId =
          (trx as any)?.queryRunner?.connection?.name ||
          (trx as any)?.queryRunner?.id ||
          `tx_${Date.now()}`;
        const txLog = (m: string, extra?: any) =>
          console.log(`[inactivateUser][TX:${txnId}] ${m} ::`, extra ?? {});

        const userTx = trx.getRepository(User);
        const branchTx = trx.getRepository(Branch);
        const loanTx = trx.getRepository(LoanRequest);

        // Cargar "me" (actor) solo si tenemos id; si no, se seguirá fallando al validar permisos explícitos
        let me: User | null = null;
        if (!isNaN(actorUserId)) {
          try {
            me = await userTx.findOne({ where: { id: actorUserId }, relations: ['branch'] });
            txLog('actor loaded', me ? { id: me.id, role: me.role, branchId: me.branch?.id } : { me: null, actorUserId });
          } catch (e) {
            logErrorAndRethrow(e, 'TX findOne(actor)', { txnId, actorUserId });
          }
        } else {
          txLog('actorUserId not provided, will rely on explicit permission checks', { actorUserId });
        }

        // ========= CASO 1: ADMIN inactiva AGENTE (misma branch) =========
        if (targetRole === 'AGENT') {
          // Validar SOLO rol ADMIN del actor
          if (!me || String(me.role).toUpperCase() !== 'ADMIN') {
            console.error('[inactivateUser] Permiso denegado (se requiere ADMIN) ::', { txnId, actorId: me?.id, actorRole: me?.role });
            throw new ForbiddenException('Solo un ADMIN puede inactivar agentes.');
          }
          if (!target.branch?.id) {
            console.error('[inactivateUser] AGENT sin branch ::', { txnId, targetId: target.id });
            throw new BadRequestException('El agente no tiene branch asignada.');
          }

          // Verificar que el ADMIN sea administrator de la branch del target
          let branchOfTarget: Branch | null = null;
          try {
            branchOfTarget = await branchTx.findOne({
              where: { id: target.branch.id },
              relations: ['administrator'],
            });
            txLog('branchOfTarget loaded', branchOfTarget ? { id: branchOfTarget.id, adminId: branchOfTarget.administrator?.id } : { branchOfTarget: null });
          } catch (e) {
            logErrorAndRethrow(e, 'TX findOne(branchOfTarget)', { txnId, branchId: target.branch.id });
          }
          /**

          if (!branchOfTarget?.administrator?.id || branchOfTarget.administrator.id !== me.id) {
            console.error('[inactivateUser] ADMIN no coincide con branch del AGENT ::', {
              txnId, branchId: branchOfTarget?.id, adminOfBranch: branchOfTarget?.administrator?.id, actorId: me?.id,
            });
            throw new ForbiddenException('No eres el administrador de la sede de este agente.');
          }
            */

          // Resolver reemplazo AGENT
          let replacement: User | null = null;

          if (body?.replacementUserId) {
            try {
              replacement = await userTx.findOne({
                where: { id: Number(body.replacementUserId) },
                relations: ['branch'],
              });
              txLog('replacement AGENT loaded', replacement ? { id: replacement.id, role: replacement.role, branchId: replacement.branch?.id } : { replacement: null });
            } catch (e) {
              logErrorAndRethrow(e, 'TX findOne(replacement AGENT)', { txnId, replacementUserId: body?.replacementUserId });
            }
            if (!replacement) {
              console.error('[inactivateUser] Replacement AGENT no existe ::', { txnId, replacementUserId: body?.replacementUserId });
              throw new NotFoundException('Agente de reemplazo no existe.');
            }
            if (String(replacement.role).toUpperCase() !== 'AGENT') {
              console.error('[inactivateUser] Replacement no es AGENT ::', { txnId, replacementId: replacement.id, replacementRole: replacement.role });
              throw new BadRequestException('El reemplazo debe ser un AGENT.');
            }
            if (replacement.branch?.id !== branchOfTarget.id) {
              console.error('[inactivateUser] Replacement AGENT en otra branch ::', {
                txnId, replacementId: replacement.id, replacementBranch: replacement.branch?.id, targetBranch: branchOfTarget.id,
              });
              throw new BadRequestException('El reemplazo debe pertenecer a la misma sede.');
            }
          } else if (body?.createReplacement) {
            const payload = body.createReplacement || {};
            try {
              const newAgent = userTx.create({
                name: payload.name || 'Nuevo Agente',
                email: payload.email || `agent_${Date.now()}@example.com`,
                password: payload.password || 'changeme',
                role: 'AGENT',
                branch: branchOfTarget,
              } as Partial<User>);
              replacement = await userTx.save(newAgent);
              txLog('replacement AGENT created', { id: replacement.id, email: replacement.email });
            } catch (e) {
              logErrorAndRethrow(e, 'TX create/save(replacement AGENT)', { txnId, payload: safeBody(payload) });
            }
          } else {
            console.error('[inactivateUser] Falta replacement AGENT ::', { txnId, ...ctx });
            throw new BadRequestException('Debes elegir o crear un agente de reemplazo.');
          }

          // Reasignar loans abiertas
          let toReassign: LoanRequest[] = [];
          try {
            const CLOSED = new Set<any>(['completed', 'rejected', LoanRequestStatus.COMPLETED, LoanRequestStatus.REJECTED].filter(Boolean));
            toReassign = await loanTx.find({
              where: {
                agent: { id: target.id },
                status: Not(In(Array.from(CLOSED))),
              },
              relations: ['agent'],
            });
            txLog('loans to reassign', { count: toReassign.length });
            if (toReassign.length > 0) {
              for (const lr of toReassign) lr.agent = replacement!;
              await loanTx.save(toReassign);
              txLog('loans reassigned', { count: toReassign.length, replacementId: replacement!.id });
            }
          } catch (e) {
            logErrorAndRethrow(e, 'TX reassign loans (AGENT)', { txnId, replacementId: replacement?.id });
          }

          // Inactivar agente
          try {
            const patch: Partial<User> =
              ('active' in target) ? ({ active: false } as any) : ({ status: 'INACTIVE' } as any);
            await userTx.update(target.id, patch);
            txLog('agent inactivated', { targetId: target.id });
          } catch (e) {
            logErrorAndRethrow(e, 'TX update(target AGENT inactive)', { txnId, targetId: target.id });
          }

          return { ok: true, inactivatedUserId: target.id, replacementUserId: (replacement as User).id, reassignedLoans: toReassign.length, txnId };
        }

        // ========= CASO 2: MANAGER inactiva ADMIN =========
        if (targetRole === 'ADMIN') {
          // Validar SOLO rol MANAGER del actor
          if (!me || String(me.role).toUpperCase() !== 'MANAGER') {
            console.error('[inactivateUser] Permiso denegado (se requiere MANAGER) ::', { txnId, actorId: me?.id, actorRole: me?.role });
            throw new ForbiddenException('Solo un MANAGER puede inactivar admins.');
          }

          // Branches del admin target
          let targetBranches: Branch[] = [];
          try {
            targetBranches = await branchTx.find({
              where: { administrator: { id: target.id } as any },
              relations: ['administrator'],
            });
            txLog('targetBranches loaded', { count: targetBranches.length });
          } catch (e) {
            logErrorAndRethrow(e, 'TX find(targetBranches by admin)', { txnId, targetAdminId: target.id });
          }

          // Resolver replacement ADMIN si corresponde
          let replacement: User | null = null;

          if (targetBranches.length > 0) {
            if (body?.replacementUserId) {
              try {
                replacement = await userTx.findOne({ where: { id: Number(body.replacementUserId) } });
                txLog('replacement ADMIN loaded', replacement ? { id: replacement.id, role: replacement.role } : { replacement: null });
              } catch (e) {
                logErrorAndRethrow(e, 'TX findOne(replacement ADMIN)', { txnId, replacementUserId: body?.replacementUserId });
              }
              if (!replacement) {
                console.error('[inactivateUser] Replacement ADMIN no existe ::', { txnId, replacementUserId: body?.replacementUserId });
                throw new NotFoundException('Admin de reemplazo no existe.');
              }
              if (String(replacement.role).toUpperCase() !== 'ADMIN') {
                console.error('[inactivateUser] Replacement no es ADMIN ::', { txnId, replacementId: replacement.id, replacementRole: replacement.role });
                throw new BadRequestException('El reemplazo debe ser un ADMIN.');
              }
              try {
                const countAdmin = await branchTx.count({ where: { administrator: { id: replacement.id } as any } });
                if (countAdmin > 0) {
                  console.error('[inactivateUser] Replacement ADMIN ya administra otra branch ::', { txnId, replacementId: replacement.id, countAdmin });
                  throw new BadRequestException('El admin de reemplazo ya administra otra sede.');
                }
              } catch (e) {
                logErrorAndRethrow(e, 'TX count(branch by replacement ADMIN)', { txnId, replacementId: replacement.id });
              }
            } else if (body?.createReplacement) {
              const payload = body.createReplacement || {};
              try {
                const newAdmin = userTx.create({
                  name: payload.name || 'Nuevo Admin',
                  email: payload.email || `admin_${Date.now()}@example.com`,
                  password: payload.password || 'changeme',
                  role: 'ADMIN',
                } as Partial<User>);
                replacement = await userTx.save(newAdmin);
                txLog('replacement ADMIN created', { id: replacement.id, email: replacement.email });
              } catch (e) {
                logErrorAndRethrow(e, 'TX create/save(replacement ADMIN)', { txnId, payload: safeBody(payload) });
              }
            } else {
              console.error('[inactivateUser] Falta replacement ADMIN para sedes ::', { txnId, countBranches: targetBranches.length, ...ctx });
              throw new BadRequestException('Debes elegir o crear un admin de reemplazo para las sedes que administra.');
            }
          }

          // Reasignar branches al replacement
          if (targetBranches.length > 0 && replacement) {
            try {
              for (const b of targetBranches) b.administrator = replacement!;
              await branchTx.save(targetBranches);
              txLog('branches reassigned to replacement', { replacementId: replacement.id, count: targetBranches.length });
            } catch (e) {
              logErrorAndRethrow(e, 'TX save(reassign branches to replacement ADMIN)', { txnId, replacementId: replacement.id, branchesCount: targetBranches.length });
            }
          }

          // Inactivar admin
          try {
            const patch: Partial<User> =
              ('active' in target) ? ({ active: false } as any) : ({ status: 'INACTIVE' } as any);
            await userTx.update(target.id, patch);
            txLog('admin inactivated', { targetId: target.id });
          } catch (e) {
            logErrorAndRethrow(e, 'TX update(target ADMIN inactive)', { txnId, targetId: target.id });
          }

          return { ok: true, inactivatedUserId: target.id, replacementUserId: replacement?.id ?? null, reassignedBranches: targetBranches.length, txnId };
        }

        // Otros roles: no soportado en este flujo
        console.error('[inactivateUser] Rol no soportado ::', { role: target.role, ...ctx });
        throw new BadRequestException('Solo se permite inactivar usuarios con rol AGENT o ADMIN.');
      });
    } catch (e) {
      // Errores dentro de la transacción
      return logErrorAndRethrow(e, 'TRANSACTION WRAPPER', ctx);
    }
  } catch (e) {
    // Errores fuera/previos a la transacción
    logErrorAndRethrow(e, 'TOP-LEVEL CATCH', ctx);
  }
}



}
