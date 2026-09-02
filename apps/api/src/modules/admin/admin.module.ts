import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

// AuditService and the Prisma/Redis services come from @Global() modules, so
// this needs no imports of its own.
@Module({
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
