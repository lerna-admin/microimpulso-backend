import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS for all origins — development only
  app.enableCors({
    origin: '*', // ⚠️ Solo para desarrollo, en producción usa origenes específicos
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: false,
  });

  await app.listen(process.env.PORT ?? 3100);
}
bootstrap();
