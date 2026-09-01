import { Module } from '@nestjs/common';
import { IncomeModule } from '../income/income.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BudgetsController } from './budgets.controller';
import { BudgetsService } from './budgets.service';

@Module({
  imports: [NotificationsModule, IncomeModule],
  controllers: [BudgetsController],
  providers: [BudgetsService],
  exports: [BudgetsService],
})
export class BudgetsModule {}
