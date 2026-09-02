import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  adminUpdateUserSchema,
  adminUserQuerySchema,
  type AdminUpdateUserInput,
  type AdminUserQuery,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { AdminService } from './admin.service';

/**
 * Administration of other people's accounts.
 *
 * `@Roles('ADMIN')` sits on the controller rather than each handler so a route
 * added later cannot be published unguarded by forgetting a decorator. The
 * guard is registered globally, and ADMIN satisfies every lesser role, so this
 * is the whole access rule.
 */
@ApiTags('admin')
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('stats')
  @ApiOperation({ summary: 'System-wide counts' })
  async stats() {
    return this.admin.stats();
  }

  @Get('users')
  @ApiOperation({ summary: 'List and search every account' })
  async listUsers(@Query(zodQuery(adminUserQuerySchema)) query: AdminUserQuery) {
    return this.admin.listUsers(query);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'One account, with its recent activity' })
  async findUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.findUser(id);
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Change role, name or verified state' })
  async updateUser(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(adminUpdateUserSchema)) dto: AdminUpdateUserInput,
    @Req() req: Request,
  ) {
    return this.admin.updateUser(actorId, id, dto, context(req));
  }

  @Post('users/:id/unlock')
  @ApiOperation({ summary: 'Clear a failed-login lockout' })
  async unlock(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.admin.unlockUser(actorId, id, context(req));
  }

  @Post('users/:id/force-logout')
  @ApiOperation({ summary: 'Revoke every session for the account' })
  async forceLogout(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.admin.forceLogout(actorId, id, context(req));
  }

  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete an account (reversible)' })
  async remove(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.admin.deleteUser(actorId, id, context(req));
  }

  @Post('users/:id/restore')
  @ApiOperation({ summary: 'Undo a soft delete' })
  async restore(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.admin.restoreUser(actorId, id, context(req));
  }
}

function context(req: Request) {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: (req as Request & { id?: string }).id ?? null,
  };
}
