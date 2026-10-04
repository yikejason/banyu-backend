import bcrypt from "bcryptjs";
import { prisma } from "./src/lib/prisma.js";
await prisma.anonymousMood.create({
  data: {
    shareCode: "m_expired1",
    content: "过期的心情",
    passcodeHash: await bcrypt.hash("9999", 10),
    expiresAt: new Date(Date.now() - 1000),
  },
});
await prisma.$disconnect();
