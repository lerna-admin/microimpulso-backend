import { Controller, Get, Param, Patch, Body, NotFoundException, Res } from '@nestjs/common';
import { DocumentService } from './document.service';
import { DocumentType } from '../entities/document.entity';
import { join } from 'path';
import { existsSync, createReadStream } from 'fs';
import { Response } from 'express'; // 👈 ESTA es la importación correcta

@Controller('documents')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Patch(':id/classify')
  async classifyDocument(
    @Param('id') id: string,
    @Body('classification') classification: DocumentType,
  ) {
    const updated = await this.documentService.classify(id, classification);
    if (!updated) throw new NotFoundException('Document not found');
    return { success: true, document: updated };
  }

  @Get('client/:clientId')
  async getDocumentsByClient(@Param('clientId') clientId: number) {
    const client = await this.documentService.getByClientId(clientId);
    return  client ;
  }

  @Get(':id/file')
  async getFile(@Param('id') id: string, @Res() res: Response) {
    const doc = await this.documentService.findById(id);
    if (!doc) throw new NotFoundException('Document not found');

    const filePath = join(__dirname, '..', '..', 'public', doc.url);
    if (!existsSync(filePath)) {
      throw new NotFoundException('File not found on disk');
    }

    const stream = createReadStream(filePath);
    stream.pipe(res);
  }
}
