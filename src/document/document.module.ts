import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../entities/document.entity';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { Client } from 'src/entities/client.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Document, Client])],
  providers: [DocumentService],
  controllers: [DocumentController],
  exports: [DocumentService], // por si otros módulos necesitan consumir documentos
})
export class DocumentModule {}
