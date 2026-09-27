import 'dotenv/config';
import { defineConfig } from 'prisma/config';
export default defineConfig({
  schema: 'packages/domain/prisma/schema.prisma',
  migrations: { path: 'packages/domain/prisma/migrations' },
  datasource: {
    url:
      process.env['DATABASE_URL'] ??
      'postgresql://mje_local:local_only_change_me@127.0.0.1:55433/mje_dev',
  },
});
