import { Test, TestingModule } from '@nestjs/testing'
import { AppController } from './app.controller'

describe('AppController', () => {
  let appController: AppController

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
    }).compile()

    appController = app.get<AppController>(AppController)
  })

  describe('health', () => {
    it('reports ok with a timestamp', () => {
      const result = appController.getHealth()

      expect(result.status).toBe('ok')
      expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false)
    })
  })
})
