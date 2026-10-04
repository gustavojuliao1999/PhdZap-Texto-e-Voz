-- AlterTable
ALTER TABLE "Line" ADD COLUMN     "businessHours" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "businessHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "groupsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offHoursMessage" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "recordCalls" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transcribeCalls" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transcribeVoiceNotes" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "recordingFile" TEXT,
ADD COLUMN     "recordingSeconds" INTEGER,
ADD COLUMN     "transcript" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "participant" TEXT,
ADD COLUMN     "participantName" TEXT,
ADD COLUMN     "transcript" TEXT;

-- CreateTable
CREATE TABLE "Contact" (
    "lineId" TEXT NOT NULL,
    "remote" TEXT NOT NULL,
    "name" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedUserId" TEXT,
    "assignedName" TEXT,
    "lastAutoReplyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("lineId","remote")
);

-- CreateTable
CREATE TABLE "QuickReply" (
    "id" TEXT NOT NULL,
    "lineId" TEXT,
    "shortcut" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contact_lineId_assignedUserId_idx" ON "Contact"("lineId", "assignedUserId");

-- CreateIndex
CREATE INDEX "Contact_lineId_status_idx" ON "Contact"("lineId", "status");

-- CreateIndex
CREATE INDEX "QuickReply_lineId_idx" ON "QuickReply"("lineId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "Line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "Line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

