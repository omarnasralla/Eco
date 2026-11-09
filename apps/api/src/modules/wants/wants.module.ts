import { Module } from '@nestjs/common';
import { CurrencyModule } from '../currency/currency.module';
import { IncomeModule } from '../income/income.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WantsController } from './wants.controller';
import { WantsService } from './wants.service';
import { WorkTimeService } from './work-time.service';

@Module({
  imports: [CurrencyModule, IncomeModule, NotificationsModule],
  controllers: [WantsController],
  providers: [WantsService, WorkTimeService],
  exports: [WantsService, WorkTimeService],
})
export class WantsModule {}
