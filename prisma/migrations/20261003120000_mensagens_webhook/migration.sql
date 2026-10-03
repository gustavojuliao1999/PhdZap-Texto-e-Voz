-- AlterTable
ALTER TABLE "Line" ADD COLUMN     "webhookEvents" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "webhookSecret" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "webhookUrl" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "remote" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "pushName" TEXT,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "extra" JSONB,
    "replyTo" TEXT,
    "status" TEXT NOT NULL,
    "agent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "raw" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Message_lineId_remote_timestamp_idx" ON "Message"("lineId", "remote", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "Message_lineId_timestamp_idx" ON "Message"("lineId", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Message_lineId_waId_key" ON "Message"("lineId", "waId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "Line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

