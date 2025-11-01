import {
  Controller,
  Get,
  Param,
  Patch,
  Body,
  NotFoundException,
  Res,
  Post,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { join } from 'path';
import { existsSync, createReadStream } from 'fs';
import { Response } from 'express';

import { DocumentService } from './document.service';
import { DocumentType } from '../entities/document.entity';
import { v4 as uuid } from 'uuid';


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

  /* ---------- Upload a new document -------------------------------------- */
@Post()
@UseInterceptors(
  FileInterceptor('file', {
    storage: diskStorage({
      destination: (req, file, cb) => {
        const uploadPath = join(process.cwd(), 'public', 'uploads');
        cb(null, uploadPath);
      },
      filename: (req, file, cb) => {
        const uniqueName = `${uuid()}-${file.originalname}`;
        cb(null, uniqueName);
      },
    }),
  }),
)
async uploadDocument(
  @UploadedFile() file: Express.Multer.File,
  @Body('customerId') customerId: number,
  @Body('classification') classification: DocumentType,
) {
  if (!file) throw new BadRequestException('No se adjuntó ningún archivo');
  if (!customerId) throw new BadRequestException('customerId es requerido');
  if (!classification) throw new BadRequestException('classification es requerida');

  const newDoc = await this.documentService.createDocument({
    filename: file.originalname,
    path: `uploads/${file.filename}`,
    mimeType: file.mimetype,
    customerId,
    classification: classification,
  });

  return {
    success: true,
    document: newDoc,
  };
}

}
