import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { MailModule } from '../mail/mail.module';

// AuditService and the Prisma/Redis services come from @Global() modules;
// MailModule is not global, and issuing a reset link emails it too.
@Module({
  imports: [MailModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
