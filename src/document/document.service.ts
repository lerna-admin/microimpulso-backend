import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import { Document, DocumentType } from '../entities/document.entity';
import { Client } from 'src/entities/client.entity';

@Injectable()
export class DocumentService {
  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,

    @InjectRepository(Client)
    private readonly clientRepository: Repository<Client>,
  ) {}

  /* -------------------------------------------------
   * Crear documento (usado por POST /documents)
   * ------------------------------------------------- */
  async createDocument(data: {
    filename: string;              // nombre original que subió el usuario
    path: string;                  // ruta relativa pública, ej: "uploads/uuid-foo.pdf"
    mimeType: string;              // tipo MIME ej: "application/pdf"
    customerId: number;            // id del cliente dueño del doc
    classification: DocumentType;  // categoría elegida en el uploader
    loanRequestId?: number | null; // opcional, por si en el futuro quieres asociar a una solicitud
  }): Promise<Document> {
    // buscar cliente
    const client = await this.clientRepository.findOne({
      where: { id: data.customerId },
    });

    if (!client) {
      throw new Error('Cliente no encontrado');
    }

    // construir entidad Document
    const doc = this.documentRepository.create({
      client: client,
      // loanRequest: (si la quieres soportar más adelante, habría que buscarla por id y asignarla)
      type: data.mimeType,            // guarda el mimetype en la columna `type`
      url: data.path,                 // guarda la ruta relativa en la columna `url`
      classification: data.classification, // enum DocumentType
      // createdAt se llena solo por @CreateDateColumn()
    });

    // guardar en DB
    const saved = await this.documentRepository.save(doc);

    // devolvemos el doc + agregamos campos cómodos para frontend si quieres
    return saved;
  }

  /* -------------------------------------------------
   * Cambiar clasificación (PATCH /documents/:id/classify)
   * ------------------------------------------------- */
  async classify(id: string, classification: DocumentType): Promise<Document | null> {
    const doc = await this.documentRepository.findOne({
      where: { id },
    });
    if (!doc) return null;

    doc.classification = classification;
    return this.documentRepository.save(doc);
  }

  /* -------------------------------------------------
   * Buscar por ID (GET /documents/:id y GET /documents/:id/file)
   * ------------------------------------------------- */
  async findById(id: string): Promise<Document | null> {
    return this.documentRepository.findOne({
      where: { id },
      relations: ['client', 'loanRequest'],
    });
  }

  /* -------------------------------------------------
   * Listar documentos de un cliente
   * Regla de negocio actual:
   *   - documentos del cliente
   *   - pero si están ligados a una loanRequest con estado 'completed' o 'rejected',
   *     ya NO se devuelven (salvo que no tengan loanRequest)
   * ------------------------------------------------- */
  async getByClientId(clientId: number): Promise<Client | null> {
    // 1. Traer cliente
    const client = await this.clientRepository.findOne({
      where: { id: clientId },
    });
    if (!client) return null;

    // 2. Traer documentos visibles según tu regla
    const documents = await this.documentRepository
      .createQueryBuilder('document')
      .leftJoinAndSelect('document.loanRequest', 'loanRequest')
      .where('document.clientId = :clientId', { clientId })
      .andWhere(
        new Brackets((qb) => {
          qb.where('document.loanRequestId IS NULL').orWhere(
            'loanRequest.status NOT IN (:...excluded)',
            {
              excluded: ['completed', 'rejected'],
            },
          );
        }),
      )
      .orderBy('document.createdAt', 'DESC')
      .getMany();

    // 3. "inyectar" esos docs en el objeto cliente para que el controller los pueda devolver
    (client as any).documents = documents;

    return client;
  }
}
