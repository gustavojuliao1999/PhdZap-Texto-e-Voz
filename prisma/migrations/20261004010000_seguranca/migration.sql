-- AlterTable
ALTER TABLE "Line" ADD COLUMN     "rateLimitPerDay" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 20;

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "lineId" TEXT,
    "target" TEXT,
    "details" JSONB,
    "ip" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_lineId_at_idx" ON "AuditLog"("lineId", "at" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_action_at_idx" ON "AuditLog"("action", "at" DESC);

