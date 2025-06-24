import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigParam } from '../entities/config-param.entity';

@Injectable()
export class ConfigParamService {
  constructor(
    @InjectRepository(ConfigParam)
    private readonly repo: Repository<ConfigParam>,
  ) {}

  /* List all key/value pairs */
  findAll(): Promise<ConfigParam[]> {
    return this.repo.find();
  }

  /* Get a single key; returns null if missing */
  findOne(key: string): Promise<ConfigParam | null> {
    return this.repo.findOne({ where: { key } });
  }

  /* Create or update a key */
  async upsert(key: string, value: string): Promise<ConfigParam> {
    const item = (await this.findOne(key)) ?? this.repo.create({ key, value });
    item.value = value;
    return this.repo.save(item);
  }

  /* Helper that throws if the key is absent */
  async mustGet(key: string): Promise<ConfigParam> {
    const item = await this.findOne(key);
    if (!item) throw new NotFoundException(`Config key “${key}” not found`);
    return item;
  }
}
