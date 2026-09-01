import { Module } from '@nestjs/common';
import { DashboardModule } from '../dashboard/dashboard.module';
import { GoalsModule } from '../goals/goals.module';
import { IncomeModule } from '../income/income.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiContextService } from './ai-context.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  imports: [IncomeModule, GoalsModule, DashboardModule, NotificationsModule],
  controllers: [AiController],
  providers: [AiService, AiContextService],
  exports: [AiService, AiContextService],
})
export class AiModule {}
