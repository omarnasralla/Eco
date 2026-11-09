import { Module } from '@nestjs/common';
import { BudgetsModule } from '../budgets/budgets.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WantsModule } from '../wants/wants.module';
import { TasksModule } from '../tasks/tasks.module';
import { BirthdaysModule } from '../birthdays/birthdays.module';
import { WeatherModule } from '../weather/weather.module';
import { BriefingController } from './briefing.controller';
import { BriefingService } from './briefing.service';

@Module({
  imports: [
    BudgetsModule,
    DashboardModule,
    NotificationsModule,
    WantsModule,
    TasksModule,
    BirthdaysModule,
    WeatherModule,
  ],
  controllers: [BriefingController],
  providers: [BriefingService],
})
export class BriefingModule {}
