import { Module } from '@nestjs/common';
import { GoalsModule } from '../goals/goals.module';
import { IncomeModule } from '../income/income.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [IncomeModule, GoalsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
