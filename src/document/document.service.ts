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
  async createDocumentOLD(data: {
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
  * Crear documento (usado por POST /documents)
  * ------------------------------------------------- */
  async createDocument(data: {
    filename: string;              // nombre original que subió el usuario
    path: string;                  // ruta relativa pública, ej: "uploads/uuid-foo.pdf"
    mimeType: string;              // tipo MIME ej: "application/pdf"
    customerId: number;            // id del cliente dueño del doc
    classification: DocumentType;  // categoría elegida en el uploader
    loanRequestId?: number | null; // opcional, por si en el futuro quieres asociar a una solicitud
  }): Promise<Document> {
    
    // --- Log 1: Inicio de la función y datos recibidos ---
    console.log(`[createDocument] INICIO. Datos recibidos:`, {
        filename: data.filename,
        path: data.path,
        mimeType: data.mimeType,
        customerId: data.customerId,
        classification: data.classification,
        loanRequestId: data.loanRequestId,
    });

    try {
        // buscar cliente
        // --- Log 2: Intentando buscar cliente ---
        console.log(`[createDocument] Buscando cliente con ID: ${data.customerId}`);
        
        const client = await this.clientRepository.findOne({
            where: { id: data.customerId },
        });

        // --- Log 3: Resultado de la búsqueda del cliente ---
        if (!client) {
            console.warn(`[createDocument] Advertencia: Cliente con ID ${data.customerId} NO encontrado.`);
            throw new Error('Cliente no encontrado');
        }
        console.log(`[createDocument] Cliente encontrado. ID: ${client.id}`);


        // construir entidad Document
        // --- Log 4: Construyendo la entidad Document ---
        const doc = this.documentRepository.create({
            client: client,
            // loanRequest: (si la quieres soportar más adelante, habría que buscarla por id y asignarla)
            type: data.mimeType,            // guarda el mimetype en la columna `type`
            url: data.path,                 // guarda la ruta relativa en la columna `url`
            classification: data.classification, // enum DocumentType
            // createdAt se llena solo por @CreateDateColumn()
        });
        console.log(`[createDocument] Entidad Document construida:`, {
            type: doc.type,
            url: doc.url,
            classification: doc.classification,
            clientId: doc.client.id, // Acceder al ID para evitar logear todo el objeto client
        });


        // guardar en DB
        // --- Log 5: Intentando guardar en la DB ---
        console.log(`[createDocument] Intentando guardar el documento en la base de datos.`);
        const saved = await this.documentRepository.save(doc);

        // --- Log 6: Documento guardado exitosamente ---
        console.log(`[createDocument] Documento guardado exitosamente. Document ID: ${saved.id}`);

        // devolvemos el doc + agregamos campos cómodos para frontend si quieres
        // --- Log 7: Fin de la ejecución exitosa ---
        console.log(`[createDocument] FIN exitoso.`);
        return saved;

    } catch (error) {
        // --- Log de Error: Capturando cualquier excepción ---
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[createDocument] ERROR CRÍTICO. Fallo durante el proceso: ${errorMessage}`, {
            dataEntrada: data,
            stack: error instanceof Error ? error.stack : 'N/A',
        });
        
        // La lógica original lanza el error, lo mantenemos intacto.
        throw error;
    }
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
   * Regla de negocio actualizada:
   *   - devolver TODOS los documentos del cliente,
   *     independientemente del estado de la loanRequest asociada.
   * ------------------------------------------------- */
  async getByClientId(clientId: number): Promise<Client | null> {
    // 1. Traer cliente
    const client = await this.clientRepository.findOne({
      where: { id: clientId },
    });
    if (!client) return null;

    // 2. Traer todos los documentos del cliente, sin filtrar por estado de la solicitud
    const documents = await this.documentRepository
      .createQueryBuilder('document')
      .where('document.clientId = :clientId', { clientId })
      .orderBy('document.createdAt', 'DESC')
      .getMany();

    // 3. "inyectar" esos docs en el objeto cliente para que el controller los pueda devolver
    (client as any).documents = documents;

    return client;
  }
}
