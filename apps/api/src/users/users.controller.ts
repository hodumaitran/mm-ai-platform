import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Auth, Roles } from '../auth/auth.decorators';
import type { AuthContext } from '../auth/auth.types';
import { Role } from '../generated/prisma/client';
import { UsersService, type UserSummary } from './users.service';

export class CreateUserDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;

  // Accounts are provisioned by an administrator; there is no self-registration.
  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @IsIn([Role.ADMIN, Role.USER])
  role?: Role;
}

export class ListUsersQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class SetActiveDto {
  @IsBoolean()
  isActive!: boolean;
}

@Roles(Role.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  create(@Body() body: CreateUserDto): Promise<UserSummary> {
    return this.users.create({
      email: body.email,
      displayName: body.displayName,
      password: body.password,
      role: body.role ?? Role.USER,
    });
  }

  @Get()
  list(@Query() query: ListUsersQuery): ReturnType<UsersService['list']> {
    return this.users.list(query.page ?? 1, query.pageSize ?? 20);
  }

  @Patch(':id')
  setActive(
    @Auth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SetActiveDto,
  ): Promise<UserSummary> {
    if (id === auth.user.id && !body.isActive) {
      // Prevents an administrator from locking themselves out.
      throw new BadRequestException();
    }
    return this.users.setActive(id, body.isActive);
  }
}
