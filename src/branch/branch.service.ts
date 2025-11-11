import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Branch } from 'src/entities/branch.entity';
import { User } from 'src/entities/user.entity';
import { filter } from 'rxjs';

type CreateBranchInput = {
  name: string;
  administrator?: number;         // ID de User (opcional)
  countryIso2?: string;           // p.ej. 'CO'
  phoneCountryCode?: string;      // p.ej. '57'
  acceptsInbound?: boolean;
};
type UpdateBranchInput = Partial<CreateBranchInput>;

// ---------- utils de normalización ----------
const normIso2 = (v?: string) => (v ? v.trim().toUpperCase() : undefined);
const normPhoneCode = (v?: string) =>
  v ? v.toString().trim().replace(/[^\d]/g, '') || undefined : undefined;

// como no podemos importar del front, lo declaramos aquí:
const AGENT_ROLE = 'AGENT';

@Injectable()
export class BranchService {
  constructor(
    @InjectRepository(Branch) private readonly branchRepository: Repository<Branch>,
    @InjectRepository(User) private readonly userRepository: Repository<User>,
  ) {}

  // Mapea la entidad a un objeto plano serializable
  private mapBranch(b: Branch) {
    // nos aseguramos de tener agentes y de filtrar por rol
    const agents = Array.isArray(b.agents)
      ? b.agents
          .filter((a) => a.role === AGENT_ROLE)
          .map((a) => ({
            id: a.id,
            name: a.name,
            email: a.email,
          }))
      : [];

    return {
      id: b.id,
      name: b.name,
      countryIso2: b.countryIso2 ?? null,
      phoneCountryCode: b.phoneCountryCode ?? null,
      acceptsInbound: !!b.acceptsInbound,
      administrator: b.administrator
        ? { id: b.administrator.id, name: b.administrator.name, email: b.administrator.email }
        : null,
      agents,                      // 👈 ya los exponemos
      agentsCount: agents.length,  // 👈 mantiene tu conteo
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
  }

  private async getAdminOrUndefined(id?: number) {
    if (!id && id !== 0) return undefined;
    const admin = await this.userRepository.findOne({ where: { id } });
    if (!admin) throw new BadRequestException(`administrator id=${id} no existe`);
    return admin;
  }

  // ---------- CREATE ----------
  async create(data: CreateBranchInput) {
    if (!data?.name?.trim()) throw new BadRequestException('name es requerido');

    const administrator = await this.getAdminOrUndefined(data.administrator);

    const toCreate: Partial<Branch> = {
      name: data.name.trim(),
      administrator,
      countryIso2: normIso2(data.countryIso2),
      phoneCountryCode: normPhoneCode(data.phoneCountryCode),
      acceptsInbound: data.acceptsInbound ?? true,
    };

    const entity = this.branchRepository.create(toCreate);
    const saved = await this.branchRepository.save(entity);

    // Re-cargar con relaciones para responder completo
    const reloaded = await this.branchRepository.findOne({
      where: { id: saved.id },
      relations: { administrator: true, agents: true },
    });
    if (!reloaded) throw new NotFoundException(`Branch id=${saved.id} no encontrada`);

    return this.mapBranch(reloaded);
  }

  // ---------- READ ----------
  async findAll(filters?: { name?: string; administratorId?: number; countryIso2?: string; acceptsInbound?: boolean , countryId? : number}) {
    const where: any = {};
    if (filters?.name) where.name = ILike(`%${filters.name}%`);
    if (filters?.administratorId) where.administrator = { id: filters.administratorId };
    if (filters?.countryIso2) where.countryIso2 = normIso2(filters.countryIso2);
    if (typeof filters?.acceptsInbound === 'boolean') where.acceptsInbound = filters.acceptsInbound;
    if (filters?.countryId) where.countryId=filters.countryId;

    const rows = await this.branchRepository.find({
      where,
      relations: { administrator: true, agents: true },
      order: { createdAt: 'DESC' },
    });

    return rows.map((b) => this.mapBranch(b));
  }

  async findOne(id: number) {
    const b = await this.branchRepository.findOne({
      where: { id },
      relations: { administrator: true, agents: true },
    });
    if (!b) throw new NotFoundException(`Branch id=${id} no encontrada`);
    return this.mapBranch(b);
  }

  // ---------- UPDATE ----------
  async update(id: number, data: UpdateBranchInput) {
    const exists = await this.branchRepository.findOne({ where: { id } });
    if (!exists) throw new NotFoundException(`Branch id=${id} no encontrada`);

    const patch: Partial<Branch> = {};
    if (data.name !== undefined) patch.name = data.name?.trim() || '';
    if (data.countryIso2 !== undefined) patch.countryIso2 = normIso2(data.countryIso2);
    if (data.phoneCountryCode !== undefined) patch.phoneCountryCode = normPhoneCode(data.phoneCountryCode);
    if (data.acceptsInbound !== undefined) patch.acceptsInbound = !!data.acceptsInbound;

    if (data.administrator !== undefined) {
      patch.administrator = await this.getAdminOrUndefined(data.administrator);
    }

    await this.branchRepository.update(id, patch);
    return this.findOne(id); // ya mapeado
  }

  // ---------- DELETE ----------
  async remove(id: number) {
    const b = await this.branchRepository.findOne({ where: { id } });
    if (!b) throw new NotFoundException(`Branch id=${id} no encontrada`);
    await this.branchRepository.remove(b);
    return { id };
  }
}
