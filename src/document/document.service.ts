import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Document, DocumentType } from '../entities/document.entity';
import { Brackets, Repository } from 'typeorm';
import { Client } from 'src/entities/client.entity';

@Injectable()
export class DocumentService {
  constructor(
    @InjectRepository(Document)
    private documentRepository: Repository<Document>,
    @InjectRepository(Client)
    private clientRepository: Repository<Client>,
    
  ) {}
  
  async classify(id: string, classification: DocumentType): Promise<Document | null> {
    const doc = await this.documentRepository.findOne({ where: { id } });
    if (!doc) return null;
    
    doc.classification = classification;
    return this.documentRepository.save(doc);
  }
  async findById(id: string): Promise<Document | null> {
    return this.documentRepository.findOne({ where: { id },relations: ['client'] });
  }
  
  async getByClientId(clientId: number): Promise<Client | null> {
    // 1) Fetch the client first
    const client = await this.clientRepository.findOne({
      where: { id: clientId },
    });
    if (!client) return null;
    
    // 2) Fetch the documents that satisfy your business rule
    const documents = await this.documentRepository
    .createQueryBuilder('document')
    .leftJoinAndSelect('document.loanRequest', 'loanRequest')
    .where('document.clientId = :clientId', { clientId })
    .andWhere(
      new Brackets((qb) => {
        qb.where('document.loanRequestId IS NULL')
        .orWhere('loanRequest.status NOT IN (:...excluded)', {
          excluded: ['completed', 'rejected'],
        });
      }),
    )
    .getMany();
    
    // 3) Attach and return
    client.documents = documents;
    return client;
  }
  
  
}
