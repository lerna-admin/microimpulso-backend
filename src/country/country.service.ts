import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Country } from 'src/entities/country.entity';
import { Branch } from 'src/entities/branch.entity';
import { Client } from 'src/entities/client.entity';
import { User } from 'src/entities/user.entity';

@Injectable()
export class CountriesService {
  constructor(
    @InjectRepository(Country)
    private readonly countryRepo: Repository<Country>,
    @InjectRepository(Branch)
    private readonly branchRepo: Repository<Branch>,
    @InjectRepository(Client)
    private readonly clientRepo: Repository<Client>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // CRUD BÁSICO
  // ─────────────────────────────────────────────────────────────
  async findAll(
    limit = 20,
    page = 1,
    q?: string, // búsqueda por code/name
  ) {
    const where = q
      ? [{ code: ILike(`%${q}%`) }, { name: ILike(`%${q}%`) }]
      : undefined;

    const [items, total] = await this.countryRepo.findAndCount({
      where,
      order: { name: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      page,
      limit,
      totalItems: total,
      totalPages: Math.ceil(total / limit),
      data: items,
    };
    }

  async findOne(id: number) {
    const c = await this.countryRepo.findOne({
      where: { id },
      relations: ['branches', 'clients', 'managers'],
    });
    if (!c) throw new NotFoundException('Country not found');
    return c;
  }

  async create(data: Partial<Country>) {
    const code = String(data.code ?? '').trim().toUpperCase();
    const name = String(data.name ?? '').trim();

    if (!code || !name) {
      throw new BadRequestException('code y name son obligatorios');
    }

    const dup = await this.countryRepo.findOne({ where: { code } });
    if (dup) throw new ConflictException('Ya existe un país con ese code');

    const entity = this.countryRepo.create({ code, name });
    return await this.countryRepo.save(entity);
  }

  async update(id: number, data: Partial<Country>) {
    const country = await this.countryRepo.findOne({ where: { id } });
    if (!country) throw new NotFoundException('Country not found');

    if (data.code) {
      const newCode = String(data.code).trim().toUpperCase();
      if (!newCode) throw new BadRequestException('code inválido');

      const dup = await this.countryRepo.findOne({
        where: { code: newCode },
      });
      if (dup && dup.id !== id) {
        throw new ConflictException('Ya existe otro país con ese code');
      }
      country.code = newCode;
    }

    if (data.name !== undefined) {
      const newName = String(data.name).trim();
      if (!newName) throw new BadRequestException('name inválido');
      country.name = newName;
    }

    return await this.countryRepo.save(country);
  }

  async remove(id: number) {
    const country = await this.countryRepo.findOne({ where: { id } });
    if (!country) throw new NotFoundException('Country not found');
    await this.countryRepo.remove(country);
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // RELACIONES
  // ─────────────────────────────────────────────────────────────
  async getBranches(id: number) {
    const country = await this.countryRepo.findOne({ where: { id } });
    if (!country) throw new NotFoundException('Country not found');

    // Si tu Branch tiene columna countryId:
    return this.branchRepo.find({
      where: { country: { id } as any }, // o { countryId: id } si lo tienes
      order: { id: 'ASC' },
    });
  }

  async getClients(id: number) {
    const country = await this.countryRepo.findOne({ where: { id } });
    if (!country) throw new NotFoundException('Country not found');

    return this.clientRepo.find({
      where: { country: { id } as any }, // o { countryId: id }
      order: { id: 'DESC' },
    });
  }

  async getManagers(id: number) {
    const country = await this.countryRepo.findOne({ where: { id } });
    if (!country) throw new NotFoundException('Country not found');

    // Si tu User tiene managerCountryId o relación managerCountry:
    // Filtramos por rol opcionalmente si tu esquema lo usa
    return this.userRepo.find({
      where: [
        // por relación:
        { managerCountry: { id } as any },
        // o por FK si la tienes:
        { managerCountryId: id } as any,
      ],
      order: { id: 'ASC' },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // ASIGNACIÓN / REMOCIÓN DE MANAGERS AL PAÍS
  // ─────────────────────────────────────────────────────────────
  async assignManager(countryId: number, userId: number) {
    const [country, user] = await Promise.all([
      this.countryRepo.findOne({ where: { id: countryId } }),
      this.userRepo.findOne({ where: { id: userId } }),
    ]);
    if (!country) throw new NotFoundException('Country not found');
    if (!user) throw new NotFoundException('User not found');

    // Si manejas role para managers, puedes validar aquí:
    // if (user.role !== 'MANAGER') throw new BadRequestException('El usuario no es MANAGER');

    // Setear la FK o la relación
    // @ts-ignore
    user.managerCountry = country;
    // Si usas FK explícita:
    // (user as any).managerCountryId = countryId;

    await this.userRepo.save(user);
    return { ok: true };
  }

  async unassignManager(countryId: number, userId: number) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['managerCountry'],
    });
    if (!user) throw new NotFoundException('User not found');

    // Solo desasignamos si efectivamente está asignado a ese país
    const currentId =
      (user as any)?.managerCountryId ?? (user as any)?.managerCountry?.id;
    if (currentId !== countryId) {
      throw new BadRequestException('El usuario no es manager de este país');
    }

    // @ts-ignore
    user.managerCountry = null;
    // Si usas FK:
    // (user as any).managerCountryId = null;

    await this.userRepo.save(user);
    return { ok: true };
  }
}
