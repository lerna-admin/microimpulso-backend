import { Controller, Get, Param, Patch, Body, NotFoundException } from '@nestjs/common';
import { DocumentService } from './document.service';
import { DocumentType } from '../entities/document.entity';

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
}
