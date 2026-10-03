import { PrismaClient } from "@prisma/client";

/** Cliente único do Prisma (só no processo principal; os workers não acessam o banco). */
export const prisma = new PrismaClient();
