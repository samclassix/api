import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Config, Process } from 'src/config/config';
import { CheckoutPayment } from 'src/integration/checkout/dto/checkout.dto';
import { CheckoutService } from 'src/integration/checkout/services/checkout.service';
import { DfxLogger } from 'src/shared/services/dfx-logger';
import { Lock } from 'src/shared/utils/lock';
import { Util } from 'src/shared/utils/util';
import { CheckoutTx } from '../entities/checkout-tx.entity';
import { CheckoutTxRepository } from '../repositories/checkout-tx.repository';
import { CheckoutTxService } from './checkout-tx.service';

@Injectable()
export class FiatPayInSyncService {
  private readonly logger = new DfxLogger(FiatPayInSyncService);

  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly checkoutTxRepo: CheckoutTxRepository,
    private readonly checkoutTxService: CheckoutTxService,
  ) {}

  // --- JOBS --- //

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock(1800)
  async syncCheckout() {
    if (Config.processDisabled(Process.FIAT_PAY_IN)) return;

    const payments = await this.checkoutService.getPayments(Util.minutesBefore(10));

    for (const payment of payments) {
      try {
        const checkoutTx = await this.createCheckoutTx(payment);

        if (checkoutTx.approved && !checkoutTx.buyCrypto)
          await this.checkoutTxService.createCheckoutBuyCrypto(checkoutTx);
      } catch (e) {
        this.logger.error(`Failed to import checkout transaction:`, e);
      }
    }
  }

  async createCheckoutTx(payment: CheckoutPayment): Promise<CheckoutTx> {
    const tx = this.mapCheckoutPayment(payment);

    let entity = await this.checkoutTxRepo.findOne({
      where: { paymentId: tx.paymentId },
      relations: { buyCrypto: true },
    });
    if (entity) {
      Object.assign(entity, tx);
    } else {
      entity = tx;
    }

    return this.checkoutTxRepo.save(entity);
  }

  private mapCheckoutPayment(payment: CheckoutPayment): CheckoutTx {
    return this.checkoutTxRepo.create({
      paymentId: payment.id,
      requestedOn: new Date(payment.requested_on),
      expiresOn: new Date(payment.expires_on),
      amount: payment.amount / 100,
      currency: payment.currency,
      status: payment.status,
      approved: payment.approved,
      reference: payment.reference,
      description: payment.description,
      type: payment.payment_type,
      cardName: payment.source?.name,
      cardFingerPrint: payment.source?.fingerprint,
      ip: payment.payment_ip,
      risk: payment.risk?.flagged,
      riskScore: payment.risk?.score,
      raw: JSON.stringify(payment),
    });
  }
}