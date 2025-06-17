import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Branch } from 'src/entities/branch.entity';
import { Repository, ILike } from 'typeorm';

@Injectable()
export class BranchService {
    constructor(
        @InjectRepository(Branch)
        private branchRepository: Repository<Branch>,
    ) {}
    
    create(data: Partial<Branch>) {
        const branch = this.branchRepository.create(data);
        return this.branchRepository.save(branch);
    }
    
    findAll(filters?: { name?: string; administratorId?: number }) {
        const where: any = {};
        
        if (filters?.name) {
            where.name = ILike(`%${filters.name}%`);
        }
        
        if (filters?.administratorId) {
            where.administrator = { id: filters.administratorId };
        }
        
        return this.branchRepository
        .createQueryBuilder('branch')
        .select(['branch.id', 'branch.name'])
        .orderBy('branch.createdAt', 'DESC')
        .getMany();
        
    }
    
    findOne(id: number) {
        return this.branchRepository.findOne({
            where: { id },
            relations: ['administrator', 'agents'],
        });
    }
    
    async update(id: number, data: Partial<Branch>) {
        await this.branchRepository.update(id, data);
        return this.findOne(id);
    }
    
    async remove(id: number) {
        const branch = await this.findOne(id);
        if (!branch) {
            throw new Error(`Branch with ID ${id} not found`);
        }
        return this.branchRepository.remove(branch);
    }
    
}
