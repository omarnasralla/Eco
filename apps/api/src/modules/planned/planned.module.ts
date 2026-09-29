import { Module } from '@nestjs/common';
import { CurrencyModule } from '../currency/currency.module';
import { PlannedController } from './planned.controller';
import { PlannedService } from './planned.service';

@Module({
  imports: [CurrencyModule],
  controllers: [PlannedController],
  providers: [PlannedService],
  exports: [PlannedService],
})
export class PlannedModule {}
