-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('PDF', 'DOCX', 'TXT');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'PARTIAL', 'FAILED', 'OCR_REQUIRED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "extractionMetadata" JSONB,
    "errorCode" TEXT,
    "activeGeneration" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "generation" UUID NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "heading" TEXT,
    "section" TEXT,
    "location" JSONB,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,
    "estimatedTokens" INTEGER NOT NULL,
    "processingVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_processing_jobs" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "runAfter" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_storageKey_key" ON "documents"("storageKey");

-- CreateIndex
CREATE INDEX "documents_userId_createdAt_idx" ON "documents"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "documents_userId_status_idx" ON "documents"("userId", "status");

-- CreateIndex
CREATE INDEX "documents_userId_kind_idx" ON "documents"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_documentId_generation_chunkIndex_key" ON "document_chunks"("documentId", "generation", "chunkIndex");

-- CreateIndex
CREATE UNIQUE INDEX "document_processing_jobs_documentId_key" ON "document_processing_jobs"("documentId");

-- CreateIndex
CREATE INDEX "document_processing_jobs_status_runAfter_idx" ON "document_processing_jobs"("status", "runAfter");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_processing_jobs" ADD CONSTRAINT "document_processing_jobs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written constraints (not expressible in the Prisma schema).
ALTER TABLE "documents" ADD CONSTRAINT "documents_size_positive" CHECK ("sizeBytes" > 0);
ALTER TABLE "documents" ADD CONSTRAINT "documents_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_index_nonnegative" CHECK ("chunkIndex" >= 0);
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_offsets_ordered" CHECK ("charStart" >= 0 AND "charEnd" >= "charStart");
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_pages_ordered"
    CHECK (("pageStart" IS NULL AND "pageEnd" IS NULL) OR ("pageStart" >= 1 AND "pageEnd" >= "pageStart"));
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_tokens_nonnegative" CHECK ("estimatedTokens" >= 0);
-- At most one job is being processed per document at a time is implied by the unique documentId;
-- a leased job must carry its lease information.
ALTER TABLE "document_processing_jobs" ADD CONSTRAINT "document_jobs_lease_consistent"
    CHECK ("status" <> 'PROCESSING' OR ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL));
ALTER TABLE "document_processing_jobs" ADD CONSTRAINT "document_jobs_attempts_nonnegative" CHECK ("attempts" >= 0);
