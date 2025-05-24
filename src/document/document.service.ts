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
  const client = await this.clientRepository.findOne({
    where: { id: clientId },
  });
  if (!client) return null;

  client.documents = await this.documentRepository.find({
    where: [
      // docs with no loanRequest
      { client: { id: clientId }, loanRequest: null },
      // docs whose loanRequest is NOT completed/rejected
      {
        client: { id: clientId },
        loanRequest: { status: Not(In(['completed', 'rejected'])) },
      },
    ],
    relations: ['loanRequest'],
  });

  return client;
}

}
