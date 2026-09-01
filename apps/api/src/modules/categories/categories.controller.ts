import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { categorySchema, updateCategorySchema, type CategoryInput } from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CategoriesService } from './categories.service';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List categories' })
  async findAll(
    @CurrentUser('id') userId: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.categories.findAll(userId, includeArchived === 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one category' })
  async findOne(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.findOne(userId, id);
  }

  @Post()
  @Audit('CREATE', 'Category')
  @ApiOperation({ summary: 'Create a custom category' })
  async create(
    @CurrentUser('id') userId: string,
    @Body(zodBody(categorySchema)) dto: CategoryInput,
  ) {
    return this.categories.create(userId, dto);
  }

  @Patch(':id')
  @Audit('UPDATE', 'Category')
  @ApiOperation({ summary: 'Rename, recolour or archive a category' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateCategorySchema)) dto: Partial<CategoryInput> & { isArchived?: boolean },
  ) {
    return this.categories.update(userId, id, dto);
  }

  @Post(':id/merge/:targetId')
  @Audit('UPDATE', 'Category')
  @ApiOperation({ summary: 'Move all expenses into another category and archive this one' })
  async merge(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.categories.merge(userId, id, targetId);
  }

  @Delete(':id')
  @Audit('DELETE', 'Category')
  @ApiOperation({ summary: 'Delete, or archive when the category has history' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.remove(userId, id);
  }
}
