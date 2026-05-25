import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Enable CORS so the React frontend on port 5173 can securely communicate with this API
  app.enableCors({
    origin: '*',
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
