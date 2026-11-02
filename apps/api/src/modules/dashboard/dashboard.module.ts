import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { GoalsModule } from '../goals/goals.module';
import { IncomeModule } from '../income/income.module';
import { ReceivablesModule } from '../receivables/receivables.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [IncomeModule, GoalsModule, AccountsModule, ReceivablesModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
