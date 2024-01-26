import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEmail, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { EntityDto } from 'src/shared/dto/entity.dto';
import { Language } from 'src/shared/models/language/language.entity';
import { Util } from 'src/shared/utils/util';
import { IsDfxPhone } from '../../user-data/is-dfx-phone.validator';

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  mail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsDfxPhone()
  @Transform(Util.trim)
  phone?: string;

  @ApiPropertyOptional({ type: EntityDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => EntityDto)
  language?: Language;
}
