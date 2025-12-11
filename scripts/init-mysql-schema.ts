import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as path from 'path';

async function bootstrap() {
  const entitiesGlob = path.resolve(__dirname, '../src/**/*.entity.{ts,js}');

  const mysqlSource = new DataSource({
    type: 'mysql',
    host: 'localhost',
    port: 3306,
    username: 'microimpulso_user',
    password: 'MiAppDb#2025',
    database: 'microimpulso_app',
    entities: [entitiesGlob],
    synchronize: true,
    logging: false,
  });

  await mysqlSource.initialize();
  console.log('[init-mysql-schema] Schema synchronized in microimpulso_app');
  await mysqlSource.destroy();
}

bootstrap().catch((err) => {
  console.error('[init-mysql-schema] Error:', err);
  process.exit(1);
});
