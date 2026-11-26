import { Module } from '@nestjs/common';
import { DocumentProcessingClient } from './document-processing.client';
import { DocumentProcessorService } from './document-processor.service';
import { DocumentStorageService } from './document-storage.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  controllers: [DocumentsController],
  providers: [
    DocumentStorageService,
    DocumentProcessingClient,
    DocumentProcessorService,
    DocumentsService,
  ],
  exports: [DocumentProcessorService, DocumentStorageService],
})
export class DocumentsModule {}
