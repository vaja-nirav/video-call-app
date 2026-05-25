import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import 'dotenv/config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit
{
  constructor() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_URL environment variable is not defined in .env file');
    }

    // Parse the connection URL: e.g. mysql://root:@localhost:3306/video_call_app
    const parsedUrl = new URL(dbUrl);
    const host = parsedUrl.hostname || 'localhost';
    const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 3306;
    const user = parsedUrl.username || 'root';
    const password = decodeURIComponent(parsedUrl.password || '');
    const database = parsedUrl.pathname.replace(/^\//, '');

    const poolConfig = {
      host,
      port,
      user,
      password,
      database,
      connectionLimit: 10,
    };

    const adapter = new PrismaMariaDb(poolConfig);

    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }
}