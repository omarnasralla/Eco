import { Module } from '@nestjs/common';
import { CurrencyModule } from '../currency/currency.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestTokenGuard } from './ingest.guard';

@Module({
  imports: [CurrencyModule, NotificationsModule],
  controllers: [IngestController],
  providers: [IngestService, IngestTokenGuard],
  exports: [IngestService],
})
export class IngestModule {}
