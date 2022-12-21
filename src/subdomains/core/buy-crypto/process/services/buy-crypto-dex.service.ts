import { Injectable } from '@nestjs/common';
import { BuyCryptoBatchRepository } from '../repositories/buy-crypto-batch.repository';
import { BuyCryptoBatchStatus, BuyCryptoBatch } from '../entities/buy-crypto-batch.entity';
import { BuyCryptoNotificationService } from './buy-crypto-notification.service';
import { BuyCryptoPricingService } from './buy-crypto-pricing.service';
import { LiquidityOrderContext } from 'src/subdomains/supporting/dex/entities/liquidity-order.entity';
import { LiquidityOrderNotReadyException } from 'src/subdomains/supporting/dex/exceptions/liquidity-order-not-ready.exception';
import { NotEnoughLiquidityException } from 'src/subdomains/supporting/dex/exceptions/not-enough-liquidity.exception';
import { PriceSlippageException } from 'src/subdomains/supporting/dex/exceptions/price-slippage.exception';
import { PurchaseLiquidityRequest, ReserveLiquidityRequest } from 'src/subdomains/supporting/dex/interfaces';
import { DexService } from 'src/subdomains/supporting/dex/services/dex.service';
import { FeeResult } from 'src/subdomains/supporting/payout/interfaces';

@Injectable()
export class BuyCryptoDexService {
  constructor(
    private readonly buyCryptoBatchRepo: BuyCryptoBatchRepository,
    private readonly buyCryptoNotificationService: BuyCryptoNotificationService,
    private readonly dexService: DexService,
    private readonly buyCryptoPricingService: BuyCryptoPricingService,
  ) {}

  async secureLiquidity(): Promise<void> {
    try {
      const newBatches = await this.buyCryptoBatchRepo.find({
        where: { status: BuyCryptoBatchStatus.CREATED },
        relations: ['transactions'],
      });

      const pendingBatches = await this.buyCryptoBatchRepo.find({
        where: { status: BuyCryptoBatchStatus.PENDING_LIQUIDITY },
        relations: ['transactions'],
      });

      await this.checkPendingBatches(pendingBatches);
      await this.processNewBatches(newBatches);
    } catch (e) {
      console.error(e);
    }
  }

  private async checkPendingBatches(pendingBatches: BuyCryptoBatch[]): Promise<void> {
    for (const batch of pendingBatches) {
      try {
        const { target: liquidity, fee: nativeFee } = await this.dexService.fetchLiquidityTransactionResult(
          LiquidityOrderContext.BUY_CRYPTO,
          batch.id.toString(),
        );

        const finalFee = await this.getPurchaseFeeAmountInBatchAsset(batch, nativeFee);

        batch.secure(liquidity.amount, finalFee);
        await this.buyCryptoBatchRepo.save(batch);

        console.info(`Secured liquidity for batch. Batch ID: ${batch.id}`);
      } catch (e) {
        if (e instanceof LiquidityOrderNotReadyException) {
          continue;
        }

        console.error(`Failed to check pending batch. Batch ID: ${batch.id}`, e);
      }
    }
  }

  private async processNewBatches(newBatches: BuyCryptoBatch[]): Promise<void> {
    for (const batch of newBatches) {
      try {
        const liquidity = await this.checkLiquidity(batch);

        if (liquidity !== 0) {
          batch.secure(liquidity, 0);
          await this.buyCryptoBatchRepo.save(batch);

          console.info(`Secured liquidity for batch. Batch ID: ${batch.id}.`);

          continue;
        }

        await this.purchaseLiquidity(batch);
      } catch (e) {
        console.info(`Error in processing new batch. Batch ID: ${batch.id}.`, e.message);
      }
    }
  }

  private async checkLiquidity(batch: BuyCryptoBatch): Promise<number> {
    try {
      const request = await this.createLiquidityRequest(batch);

      return await this.dexService.reserveLiquidity(request);
    } catch (e) {
      if (e instanceof NotEnoughLiquidityException) {
        console.info(e.message);
        return 0;
      }

      if (e instanceof PriceSlippageException) {
        await this.handleSlippageException(
          batch,
          `Slippage error while checking liquidity for asset '${batch.outputAsset.dexName}. Batch ID: ${batch.id}`,
          e,
        );
      }

      throw new Error(`Error in checking liquidity for a batch, ID: ${batch.id}. ${e.message}`);
    }
  }

  private async purchaseLiquidity(batch: BuyCryptoBatch) {
    let txId: string;

    try {
      const request = await this.createLiquidityRequest(batch);

      await this.dexService.purchaseLiquidity(request);

      batch.pending();
    } catch (e) {
      if (e instanceof PriceSlippageException) {
        await this.handleSlippageException(
          batch,
          `Composite swap slippage error while purchasing asset '${batch.outputAsset.dexName}. Batch ID: ${batch.id}`,
          e,
        );
      }

      throw new Error(
        `Error in purchasing liquidity of asset '${batch.outputAsset.dexName}'. Batch ID: ${batch.id}. ${e.message}`,
      );
    }

    try {
      await this.buyCryptoBatchRepo.save(batch);
    } catch (e) {
      console.error(
        `Error in saving PENDING status after purchasing '${batch.outputAsset.dexName}'. Batch ID: ${batch.id}. Purchase ID: ${txId}`,
        e,
      );
      throw e;
    }
  }

  private async getPurchaseFeeAmountInBatchAsset(batch: BuyCryptoBatch, nativeFee: FeeResult): Promise<number> {
    const priceRequestCorrelationId = `BuyCryptoBatch_ConvertActualPurchaseFee_${batch.id}`;
    const errorMessage = `Could not get price for actual purchase fee calculation. Ignoring fee. Batch ID: ${batch.id}. Native fee asset: ${nativeFee.asset.dexName}, batch reference asset: ${batch.outputReferenceAsset.dexName}`;

    return this.buyCryptoPricingService.getFeeAmountInBatchAsset(
      batch,
      nativeFee,
      priceRequestCorrelationId,
      errorMessage,
    );
  }

  private async createLiquidityRequest(
    batch: BuyCryptoBatch,
  ): Promise<PurchaseLiquidityRequest | ReserveLiquidityRequest> {
    const { outputAsset: targetAsset, outputReferenceAsset: referenceAsset } = batch;

    return {
      context: LiquidityOrderContext.BUY_CRYPTO,
      correlationId: batch.id.toString(),
      referenceAsset,
      referenceAmount: batch.outputReferenceAmount,
      targetAsset,
    };
  }

  private async handleSlippageException(batch: BuyCryptoBatch, message: string, e: Error): Promise<void> {
    await this.buyCryptoNotificationService.sendNonRecoverableErrorMail(batch, message, e);
  }
}
