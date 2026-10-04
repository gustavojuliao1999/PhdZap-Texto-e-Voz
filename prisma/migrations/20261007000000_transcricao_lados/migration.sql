-- Transcrição das ligações separada por lado (contato / atendente).
ALTER TABLE "Call" ADD COLUMN "transcriptSegments" JSONB;
