import { Module } from '@nestjs/common'
import { ConfigModule as NestConfigModule } from '@nestjs/config'

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationOptions: {
        allowUnknown: false,
        abortEarly: true,
      },
    }),
  ],
})
export class ConfigModule {}
