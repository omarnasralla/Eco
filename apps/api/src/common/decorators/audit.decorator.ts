import { SetMetadata } from '@nestjs/common';
import type { AuditAction } from '@eco/shared';

export const AUDIT_KEY = 'audit';

export interface AuditMetadata {
  action: AuditAction;
  entityType: string;
}

/**
 * Records the decorated mutation in the append-only audit log. Applied at the
 * controller so the logged action matches what the user actually requested,
 * not whatever internal calls it fanned out into.
 */
export const Audit = (action: AuditAction, entityType: string) =>
  SetMetadata(AUDIT_KEY, { action, entityType } satisfies AuditMetadata);
