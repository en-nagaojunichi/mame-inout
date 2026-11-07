import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import type { Config } from "./config.js";

export function createDatabase(config: Config) {
  return new PrismaClient({ adapter: new PrismaPg(config.database), log: [] });
}
export type Database = ReturnType<typeof createDatabase>;
