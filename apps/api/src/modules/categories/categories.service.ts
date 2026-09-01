import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CategoryDto, CategoryInput } from '@eco/shared';
import type { Category } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { toNumberOrNull } from '../../common/utils/money';

function toDto(category: Category): CategoryDto {
  return {
    id: category.id,
    name: category.name,
    icon: category.icon,
    color: category.color,
    parentId: category.parentId,
    isSystem: category.isSystem,
    isArchived: category.isArchived,
    monthlyBudgetMinor: toNumberOrNull(category.monthlyBudgetMinor),
    createdAt: category.createdAt.toISOString(),
  };
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async findAll(userId: string, includeArchived = false): Promise<CategoryDto[]> {
    const categories = await this.prisma.category.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return categories.map(toDto);
  }

  async findOne(userId: string, id: string): Promise<CategoryDto> {
    const category = await this.prisma.category.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!category) throw new NotFoundException('Category not found');
    return toDto(category);
  }

  async create(userId: string, input: CategoryInput): Promise<CategoryDto> {
    if (input.parentId) await this.assertOwned(userId, input.parentId);

    const category = await this.prisma.category.create({
      data: {
        userId,
        name: input.name,
        icon: input.icon,
        color: input.color,
        parentId: input.parentId ?? null,
        monthlyBudgetMinor:
          input.monthlyBudgetMinor != null ? BigInt(input.monthlyBudgetMinor) : null,
      },
    });

    await this.redis.invalidateUser(userId);
    return toDto(category);
  }

  async update(
    userId: string,
    id: string,
    input: Partial<CategoryInput> & { isArchived?: boolean },
  ): Promise<CategoryDto> {
    const existing = await this.assertOwned(userId, id);

    // A category cannot be its own parent, nor a descendant of itself — either
    // would make the tree cyclic and hang every recursive walk over it.
    if (input.parentId) {
      if (input.parentId === id) {
        throw new BadRequestException('A category cannot be its own parent');
      }
      await this.assertOwned(userId, input.parentId);
      if (await this.isDescendant(userId, id, input.parentId)) {
        throw new BadRequestException('That would create a loop in the category tree');
      }
    }

    // Seeded categories can be recoloured and renamed but keep their slug, so
    // the AI layer still recognises "food" after the user renames it.
    if (existing.isSystem && input.name && input.name !== existing.name) {
      // Allowed — the slug is what carries the meaning, not the label.
    }

    const category = await this.prisma.category.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}),
        ...(input.monthlyBudgetMinor !== undefined
          ? {
              monthlyBudgetMinor:
                input.monthlyBudgetMinor != null ? BigInt(input.monthlyBudgetMinor) : null,
            }
          : {}),
      },
    });

    await this.redis.invalidateUser(userId);
    return toDto(category);
  }

  /**
   * Archives rather than deletes when a category has history.
   *
   * Deleting a category with expenses attached would either orphan them or
   * silently rewrite months of a user's records — both are worse than an
   * archived category that simply stops appearing in pickers.
   */
  async remove(userId: string, id: string): Promise<{ archived: boolean }> {
    const category = await this.assertOwned(userId, id);

    const expenseCount = await this.prisma.expense.count({
      where: { categoryId: id, deletedAt: null },
    });

    if (expenseCount > 0 || category.isSystem) {
      await this.prisma.category.update({ where: { id }, data: { isArchived: true } });
      await this.redis.invalidateUser(userId);
      return { archived: true };
    }

    await this.prisma.category.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.redis.invalidateUser(userId);
    return { archived: false };
  }

  /**
   * Moves every expense to another category, then archives the source.
   * The escape hatch for "I made too many categories and want to merge them".
   */
  async merge(userId: string, sourceId: string, targetId: string): Promise<{ moved: number }> {
    if (sourceId === targetId) {
      throw new BadRequestException('Pick two different categories to merge');
    }
    await this.assertOwned(userId, sourceId);
    await this.assertOwned(userId, targetId);

    const { count } = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.expense.updateMany({
        where: { userId, categoryId: sourceId },
        data: { categoryId: targetId },
      });
      await tx.budgetLine.deleteMany({ where: { categoryId: sourceId } });
      await tx.category.update({ where: { id: sourceId }, data: { isArchived: true } });
      return moved;
    });

    await this.redis.invalidateUser(userId);
    return { moved: count };
  }

  private async assertOwned(userId: string, id: string): Promise<Category> {
    const category = await this.prisma.category.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  /** Walks up from `candidateParent` looking for `id`. Depth-capped. */
  private async isDescendant(
    userId: string,
    id: string,
    candidateParent: string,
  ): Promise<boolean> {
    let cursor: string | null = candidateParent;
    for (let depth = 0; cursor && depth < 10; depth += 1) {
      if (cursor === id) return true;
      // Copied into a local so the query's `where` does not reference the
      // variable its own result is assigned to — TypeScript cannot infer
      // through that cycle.
      const currentId: string = cursor;
      const parent: { parentId: string | null } | null =
        await this.prisma.category.findFirst({
          where: { id: currentId, userId },
          select: { parentId: true },
        });
      cursor = parent?.parentId ?? null;
    }
    return false;
  }
}
