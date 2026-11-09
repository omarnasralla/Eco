import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { weatherLocationSchema, type WeatherLocationInput } from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { WeatherService } from './weather.service';

@ApiTags('weather')
@Controller('weather')
export class WeatherController {
  constructor(private readonly weather: WeatherService) {}

  @Get()
  @ApiOperation({ summary: "Today's forecast for the user's place, or null" })
  async today(@CurrentUser('id') userId: string) {
    // Wrapped, because a bare null body reads to a client as "no response".
    return { weather: await this.weather.today(userId) };
  }

  @Get('places')
  @ApiOperation({ summary: 'Search cities by name' })
  async places(@Query('q') q = '') {
    return this.weather.searchPlaces(q.slice(0, 100));
  }

  @Put('location')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set the place the weather is for' })
  async setLocation(
    @CurrentUser('id') userId: string,
    @Body(zodBody(weatherLocationSchema)) dto: WeatherLocationInput,
  ) {
    await this.weather.setLocation(userId, dto);
  }

  @Delete('location')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop showing weather' })
  async clearLocation(@CurrentUser('id') userId: string) {
    await this.weather.clearLocation(userId);
  }
}
