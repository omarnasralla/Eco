import type { PrismaService } from '../../prisma/prisma.service';
import { todayIso } from './dates';

/** Today on this user's own clock; UTC's date if the user cannot be found. */
export async function userToday(prisma: PrismaService, userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  return todayIso(user?.timezone);
}
