import { Injectable } from '@nestjs/common';
import { BlockchainAddress } from 'src/shared/models/blockchain-address';
import { DfxLogger } from 'src/shared/services/dfx-logger';
import { Swap } from 'src/subdomains/core/buy-crypto/routes/swap/swap.entity';
import { SwapRepository } from 'src/subdomains/core/buy-crypto/routes/swap/swap.repository';
import { CryptoInput, PayInPurpose } from 'src/subdomains/supporting/payin/entities/crypto-input.entity';
import { PayInService } from 'src/subdomains/supporting/payin/services/payin.service';
import { TransactionHelper, ValidationError } from 'src/subdomains/supporting/payment/services/transaction-helper';
import { IsNull, Not } from 'typeorm';
import { BuyCryptoRepository } from '../repositories/buy-crypto.repository';
import { BuyCryptoService } from './buy-crypto.service';

@Injectable()
export class BuyCryptoRegistrationService {
  private readonly logger = new DfxLogger(BuyCryptoRegistrationService);

  constructor(
    private readonly buyCryptoRepo: BuyCryptoRepository,
    private readonly buyCryptoService: BuyCryptoService,
    private readonly swapRepository: SwapRepository,
    private readonly payInService: PayInService,
    private readonly transactionHelper: TransactionHelper,
  ) {}

  async registerCryptoPayIn(): Promise<void> {
    const newPayIns = await this.payInService.getNewPayIns();

    if (newPayIns.length === 0) return;

    const buyCryptoPayIns = await this.filterBuyCryptoPayIns(newPayIns);

    buyCryptoPayIns.length > 0 &&
      this.logger.verbose(
        `Registering ${buyCryptoPayIns.length} new buy-crypto(s) from crypto pay-in(s) ID(s): ${buyCryptoPayIns.map(
          (s) => s[0].id,
        )}`,
      );

    await this.createBuyCryptosAndAckPayIns(buyCryptoPayIns);
  }

  //*** HELPER METHODS ***//

  private async filterBuyCryptoPayIns(allPayIns: CryptoInput[]): Promise<[CryptoInput, Swap][]> {
    const routes = await this.swapRepository.find({
      where: { deposit: Not(IsNull()) },
      relations: { deposit: true, user: { userData: true, wallet: true } },
    });

    return this.pairRoutesWithPayIns(routes, allPayIns);
  }

  private pairRoutesWithPayIns(routes: Swap[], allPayIns: CryptoInput[]): [CryptoInput, Swap][] {
    const result = [];

    for (const payIn of allPayIns) {
      const relevantRoute = routes.find(
        (r) =>
          payIn.address.address.toLowerCase() === r.deposit.address.toLowerCase() &&
          r.deposit.blockchainList.includes(payIn.address.blockchain),
      );

      relevantRoute && result.push([payIn, relevantRoute]);
    }

    return result;
  }

  private async createBuyCryptosAndAckPayIns(payInsPairs: [CryptoInput, Swap][]): Promise<void> {
    for (const [payIn, cryptoRoute] of payInsPairs) {
      try {
        const alreadyExists = await this.buyCryptoRepo.exist({ where: { cryptoInput: { id: payIn.id } } });

        if (!alreadyExists) {
          const result = await this.transactionHelper.validateInput(payIn.asset, payIn.amount);

          if (result === ValidationError.PAY_IN_TOO_SMALL) {
            await this.payInService.ignorePayIn(payIn, PayInPurpose.BUY_CRYPTO, cryptoRoute);
            continue;
          } else if (result === ValidationError.PAY_IN_NOT_SELLABLE) {
            if (cryptoRoute.asset.blockchain === payIn.address.blockchain) {
              await this.payInService.returnPayIn(
                payIn,
                PayInPurpose.BUY_CRYPTO,
                BlockchainAddress.create(cryptoRoute.user.address, payIn.address.blockchain),
                cryptoRoute,
              );
              continue;
            }
          }

          await this.buyCryptoService.createFromCryptoInput(payIn, cryptoRoute);
        }

        await this.payInService.acknowledgePayIn(payIn.id, PayInPurpose.BUY_CRYPTO, cryptoRoute);
      } catch (e) {
        this.logger.error(`Error during buy-crypto pay-in registration (pay-in ${payIn.id}):`, e);
      }
    }
  }
}
