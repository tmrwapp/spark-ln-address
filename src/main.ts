import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { Logger } from '@nestjs/common'
import { NestExpressApplication } from '@nestjs/platform-express'
import { configureTrustProxy } from './rate-limit/rate-limit.module'

async function bootstrap() {
  const logger = new Logger('Main')
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  })
  // Rate limiting keys on req.ip, which must be the client behind NGINX.
  configureTrustProxy(app, process.env.TRUST_PROXY)
  const port = process.env.PORT || 3003
  await app.listen(port)
  logger.log(`Application is running on: ${await app.getUrl()}`)
  logger.log(`Environment: ${process.env.NODE_ENV}`)
  logger.log(`Port: ${port}`)
  logger.log(`Public Base URL: ${process.env.PUBLIC_BASE_URL}`)
}
bootstrap()
