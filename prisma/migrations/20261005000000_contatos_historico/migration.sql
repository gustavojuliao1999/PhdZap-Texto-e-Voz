-- AlterTable
ALTER TABLE "Line" ADD COLUMN     "hiddenContacts" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "phoneName" TEXT,
ADD COLUMN     "pushName" TEXT,
ADD COLUMN     "remoteJid" TEXT;

-- Agenda pesquisável: contatos de quem já mandou mensagem, com o último nome de perfil.
INSERT INTO "Contact" ("lineId", "remote", "pushName", "remoteJid", "createdAt", "updatedAt")
SELECT DISTINCT ON ("lineId", "remote") "lineId", "remote", "pushName", "remoteJid", now(), now()
FROM "Message"
ORDER BY "lineId", "remote", ("pushName" IS NULL), "timestamp" DESC
ON CONFLICT ("lineId", "remote") DO UPDATE SET "pushName" = EXCLUDED."pushName", "remoteJid" = EXCLUDED."remoteJid";
