import { Controller, Get, Param, Patch, Body, NotFoundException, Res } from '@nestjs/common';
import { join } from 'path';
import { existsSync, createReadStream } from 'fs';
import { Response } from 'express';

import { DocumentService } from './document.service';
import { DocumentType } from '../entities/document.entity';

@Controller('documents')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  /* ---------- Classification ----------------------------------------- */
  @Patch(':id/classify')
  async classifyDocument(@Param('id') id: string, @Body('classification') classification: DocumentType) {
    const doc = await this.documentService.classify(id, classification);
    if (!doc) throw new NotFoundException('Document not found');
    return { success: true, document: doc };
  }

  /* ---------- List documents for a client ---------------------------- */
  @Get('client/:clientId')
  async getDocumentsByClient(@Param('clientId') clientId: number) {
    const client = await this.documentService.getByClientId(clientId);
    return client; // contains client + embedded documents[]
  }

  /* ---------- (A)  JSON metadata  ------------------------------------ */
  @Get(':id')
  async getFileDetails(@Param('id') id: string) {
    const doc = await this.documentService.findById(id);
    if (!doc) throw new NotFoundException('Document not found');

    return {
      id: doc.id,
      mimeType: doc.type,
      url: `/documents/${doc.id}/file`,
      createdAt: doc.createdAt,
      clientId: doc.client?.id,
      classification: doc.classification,
      // add any other fields you need …
    };
  }

  /* ---------- (B)  Binary file  -------------------------------------- */
  @Get(':id/file')
  async getFile(@Param('id') id: string, @Res() res: Response) {
    // console.log('entro');
    // console.log('ID;', id);
    const doc = await this.documentService.findById(id);
    // console.log(doc);
    if (!doc) throw new NotFoundException('Document not found');

    const filePath = join(process.cwd(), 'public', doc.url);
    if (!existsSync(filePath)) {
      throw new NotFoundException('File not found on disk');
    }

    res.setHeader('Content-Type', doc.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');

    return createReadStream(filePath).pipe(res);
  }
}
