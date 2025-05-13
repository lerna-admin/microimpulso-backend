import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '../entities/client.entity';

@Injectable()
export class ClientsService {
  constructor(
    @InjectRepository(Client)
    private readonly clientRepository: Repository<Client>,
  ) {}

  // Return all clients from the database
async findAll(): Promise<Client[]> {
  return this.clientRepository
    .createQueryBuilder('client')
    .innerJoinAndSelect('client.loanRequests', 'loan', 'loan.status = :status', { status: 'approved' })
    .innerJoinAndSelect('loan.transactions', 'txn')
    .getMany();
}

async findAllByAgent(agentId: number): Promise<Client[]> {
  return this.clientRepository
    .createQueryBuilder('client')
    .innerJoinAndSelect('client.loanRequests', 'loan', 'loan.agentId = :agentId AND loan.status = :status', {
      agentId,
      status: 'approved',
    })
    .innerJoinAndSelect('loan.transactions', 'txn')
    .getMany();
}


  // Return a single client by ID
  async findOne(id: number): Promise<Client | null> {
    return this.clientRepository.findOneBy({ id });
  }

  // Create a new client record
  async create(data: Partial<Client>): Promise<Client> {
    const client = this.clientRepository.create({
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return this.clientRepository.save(client);
  }
}
