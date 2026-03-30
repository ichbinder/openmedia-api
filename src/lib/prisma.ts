import { PrismaClient } from "../../generated/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL || "postgresql://cinescope:cinescope_dev@localhost:5432/cinescope";

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

export default prisma;
