import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CashService } from '../src/cash/cash.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const cashService = app.get(CashService);
  const data = await cashService.getDailyTraceByUser(28, '2025-11-19');
  console.log(JSON.stringify({
    baseAnterior: data.baseAnterior,
    totalIngresosDia: data.totalIngresosDia,
    totalEgresosDia: data.totalEgresosDia,
    totalFinal: data.totalFinal,
    renovados: data.kpis?.clientesRenovados,
    nuevos: data.kpis?.clientesNuevos,
  }, null, 2));
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
