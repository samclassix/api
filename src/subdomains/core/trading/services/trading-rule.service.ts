import { Inject, Injectable } from '@nestjs/common';
import { DfxLogger } from 'src/shared/services/dfx-logger';
import { IsNull, Not } from 'typeorm';
import { TradingOrder } from '../entities/trading-order.entity';
import { TradingRule } from '../entities/trading-rule.entity';
import { TradingRuleStatus } from '../enums';
import { TradingOrderRepository } from '../repositories/trading-order.respository';
import { TradingRuleRepository } from '../repositories/trading-rule.respository';
import { TradingService } from './trading.service';

@Injectable()
export class TradingRuleService {
  private readonly logger = new DfxLogger(TradingRuleService);

  @Inject() private readonly ruleRepo: TradingRuleRepository;
  @Inject() private readonly orderRepo: TradingOrderRepository;

  constructor(private readonly tradingService: TradingService) {}

  // --- PUBLIC API --- //

  async processRules() {
    const rules = await this.ruleRepo.findBy({
      status: TradingRuleStatus.ACTIVE,
    });

    for (const rule of rules) {
      await this.executeRule(rule);
    }
  }

  async reactivateRules(): Promise<void> {
    const rules = await this.ruleRepo.findBy({
      status: TradingRuleStatus.PAUSED,
      reactivationTime: Not(IsNull()),
    });

    for (const rule of rules) {
      if (rule.shouldReactivate()) {
        rule.reactivate();
        await this.ruleRepo.save(rule);
        this.logger.info(`Reactivated trading rule ${rule.id}`);
      }
    }
  }

  // --- HELPER METHODS --- //

  private async executeRule(rule: TradingRule): Promise<void> {
    try {
      if (!rule.isActive()) {
        this.logger.error(`Could not execute rule ${rule.id}: status is ${rule.status}`);
        return;
      }

      if (rule.leftAsset.blockchain !== rule.rightAsset.blockchain) {
        rule.deactivate();
        await this.ruleRepo.save(rule);

        throw new Error(`Blockchain mismatch in trading rule ${rule.id}`);
      }

      const tradingInfo = await this.tradingService.createTradingInfo(rule);

      if (tradingInfo.amountIn) {
        rule.processing();
        await this.ruleRepo.save(rule);

        const order = TradingOrder.create(rule, tradingInfo);
        await this.orderRepo.save(order);
      }
    } catch (e) {
      this.logger.error(`Error processing trading rule ${rule.id}:`, e);
    }
  }
}
