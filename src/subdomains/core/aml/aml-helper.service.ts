import { Config } from 'src/config/config';
import { Blockchain } from 'src/integration/blockchain/shared/enums/blockchain.enum';
import { Country } from 'src/shared/models/country/country.entity';
import { Util } from 'src/shared/utils/util';
import { BankData } from 'src/subdomains/generic/user/models/bank-data/bank-data.entity';
import { KycLevel, KycType, UserDataStatus } from 'src/subdomains/generic/user/models/user-data/user-data.entity';
import { UserStatus } from 'src/subdomains/generic/user/models/user/user.entity';
import { AmlRule } from 'src/subdomains/generic/user/models/wallet/wallet.entity';
import { Bank } from 'src/subdomains/supporting/bank/bank/bank.entity';
import {
  SpecialExternalAccount,
  SpecialExternalAccountType,
} from 'src/subdomains/supporting/payment/entities/special-external-account.entity';
import { BuyCrypto } from '../buy-crypto/process/entities/buy-crypto.entity';
import { BuyFiat } from '../sell-crypto/process/buy-fiat.entity';
import { AmlError, AmlErrorResult, AmlErrorType } from './enums/aml-error.enum';
import { AmlReason } from './enums/aml-reason.enum';
import { CheckStatus } from './enums/check-status.enum';

export class AmlHelperService {
  static getAmlErrors(
    entity: BuyCrypto | BuyFiat,
    minVolume: number,
    amountInChf: number,
    last24hVolume: number,
    last7dVolume: number,
    last30dVolume: number,
    last365dVolume: number,
    bankData: BankData,
    blacklist: SpecialExternalAccount[],
    instantBanks?: Bank[],
    ibanCountry?: Country,
  ): AmlError[] {
    const errors = [];

    if (entity.inputReferenceAmount < minVolume * 0.9) errors.push(AmlError.MIN_VOLUME_NOT_REACHED);
    if (!entity.user.isPaymentStatusEnabled) errors.push(AmlError.INVALID_USER_STATUS);
    if (!entity.userData.isPaymentStatusEnabled) errors.push(AmlError.INVALID_USER_DATA_STATUS);
    if (!entity.userData.isPaymentKycStatusEnabled) errors.push(AmlError.INVALID_KYC_STATUS);
    if (entity.userData.kycType !== KycType.DFX) errors.push(AmlError.INVALID_KYC_TYPE);
    if (!entity.userData.verifiedName) errors.push(AmlError.NO_VERIFIED_NAME);
    if (!entity.userData.verifiedCountry) {
      errors.push(AmlError.NO_VERIFIED_COUNTRY);
    } else if (!entity.userData.verifiedCountry.fatfEnable) {
      errors.push(AmlError.VERIFIED_COUNTRY_NOT_ALLOWED);
    }
    if (ibanCountry && !ibanCountry.fatfEnable) errors.push(AmlError.IBAN_COUNTRY_NOT_ALLOWED);
    if (!entity.userData.hasValidNameCheckDate)
      errors.push(entity.userData.birthday ? AmlError.NAME_CHECK_WITH_BIRTHDAY : AmlError.NAME_CHECK_WITHOUT_KYC);
    if (blacklist.some((b) => b.matches([SpecialExternalAccountType.BANNED_MAIL], entity.userData.mail)))
      errors.push(AmlError.SUSPICIOUS_MAIL);
    if (last30dVolume > Config.tradingLimits.monthlyDefault) errors.push(AmlError.MONTHLY_LIMIT_REACHED);
    if (entity.userData.kycLevel < KycLevel.LEVEL_50 && last365dVolume > Config.tradingLimits.yearlyWithoutKyc)
      errors.push(AmlError.YEARLY_LIMIT_WO_KYC_REACHED);
    if (last24hVolume > Config.tradingLimits.dailyDefault) {
      // KYC required
      if (entity.userData.kycLevel < KycLevel.LEVEL_50) errors.push(AmlError.KYC_LEVEL_TOO_LOW);
      if (!entity.userData.hasBankTxVerification) errors.push(AmlError.NO_BANK_TX_VERIFICATION);
      if (!entity.userData.letterSentDate) errors.push(AmlError.NO_LETTER);
      if (!entity.userData.amlListAddedDate) errors.push(AmlError.NO_AML_LIST);
      if (!entity.userData.kycFileId) errors.push(AmlError.NO_KYC_FILE_ID);
      if (entity.userData.annualBuyVolume + amountInChf > entity.userData.depositLimit)
        errors.push(AmlError.DEPOSIT_LIMIT_REACHED);
    }

    if (entity instanceof BuyFiat || !entity.cryptoInput) {
      if (!bankData || bankData.active === null) {
        errors.push(AmlError.BANK_DATA_MISSING);
      } else if (!bankData.active) {
        errors.push(AmlError.BANK_DATA_NOT_ACTIVE);
      } else if (entity.userData.id !== bankData.userData.id) {
        errors.push(AmlError.BANK_DATA_USER_MISMATCH);
      }
    }

    if (entity.cryptoInput) {
      // crypto input
      if (!entity.cryptoInput.isConfirmed) errors.push(AmlError.INPUT_NOT_CONFIRMED);
    } else if (entity.userData.status === UserDataStatus.NA && entity.userData.hasSuspiciousMail)
      errors.push(AmlError.SUSPICIOUS_MAIL);

    if (entity instanceof BuyCrypto) {
      // buyCrypto
      if (!entity.target.asset.buyable) errors.push(AmlError.ASSET_NOT_BUYABLE);

      switch (entity.user.wallet.amlRule) {
        case AmlRule.DEFAULT:
          break;
        case AmlRule.RULE_1:
          if (entity.checkoutTx && entity.user.status === UserStatus.NA && entity.checkoutTx.ip !== entity.user.ip)
            errors.push(AmlError.IP_MISMATCH);
          break;
        case AmlRule.RULE_2:
          if (
            entity.user.status === UserStatus.NA &&
            entity.userData.kycLevel < KycLevel.LEVEL_30 &&
            entity.target.asset.blockchain !== Blockchain.LIGHTNING
          )
            errors.push(AmlError.KYC_LEVEL_30_NOT_REACHED);
          break;
        case AmlRule.RULE_3:
          if (
            entity.user.status === UserStatus.NA &&
            entity.userData.kycLevel < KycLevel.LEVEL_50 &&
            entity.target.asset.blockchain !== Blockchain.LIGHTNING
          )
            errors.push(AmlError.KYC_LEVEL_50_NOT_REACHED);
          break;
        case AmlRule.RULE_4:
          if (last7dVolume > Config.tradingLimits.weeklyAmlRule) errors.push(AmlError.WEEKLY_LIMIT_REACHED);
          break;
      }

      if (entity.bankTx) {
        // bank
        if (blacklist.some((b) => b.matches([SpecialExternalAccountType.BANNED_BIC], entity.bankTx.bic)))
          errors.push(AmlError.BIC_BLACKLISTED);
        if (
          blacklist.some((b) =>
            b.matches(
              [SpecialExternalAccountType.BANNED_IBAN, SpecialExternalAccountType.BANNED_IBAN_BUY],
              entity.bankTx.iban,
            ),
          )
        )
          errors.push(AmlError.IBAN_BLACKLISTED);
        if (instantBanks?.some((b) => b.iban === entity.bankTx.accountIban)) {
          if (!entity.userData.olkypayAllowed) errors.push(AmlError.INSTANT_NOT_ALLOWED);
          if (!entity.target.asset.instantBuyable) errors.push(AmlError.ASSET_NOT_INSTANT_BUYABLE);
        }
      } else if (entity.checkoutTx) {
        // checkout
        if (!entity.target.asset.cardBuyable) errors.push(AmlError.ASSET_NOT_CARD_BUYABLE);
        if (
          blacklist.some((b) =>
            b.matches(
              [SpecialExternalAccountType.BANNED_IBAN, SpecialExternalAccountType.BANNED_IBAN_BUY],
              entity.checkoutTx.cardFingerPrint,
            ),
          )
        )
          errors.push(AmlError.CARD_BLACKLISTED);
        if (last7dVolume > Config.tradingLimits.weeklyAmlRule) errors.push(AmlError.WEEKLY_LIMIT_REACHED);
      } else {
        // swap
        if (entity.userData.status !== UserDataStatus.ACTIVE && entity.userData.kycLevel < KycLevel.LEVEL_30) {
          errors.push(AmlError.KYC_LEVEL_TOO_LOW);
        }
      }
    } else {
      // buyFiat
      if (!entity.target.asset.sellable) errors.push(AmlError.ASSET_NOT_SELLABLE);
      if (
        blacklist.some((b) =>
          b.matches(
            [SpecialExternalAccountType.BANNED_IBAN, SpecialExternalAccountType.BANNED_IBAN_SELL],
            entity.sell.iban,
          ),
        )
      )
        errors.push(AmlError.IBAN_BLACKLISTED);
    }

    return errors;
  }

  static getAmlResult(
    entity: BuyCrypto | BuyFiat,
    minVolume: number,
    amountInChf: number,
    last24hVolume: number,
    last7dVolume: number,
    last30dVolume: number,
    last365dVolume: number,
    bankData: BankData,
    blacklist: SpecialExternalAccount[],
    instantBanks?: Bank[],
    ibanCountry?: Country,
  ): { amlCheck?: CheckStatus; amlReason?: AmlReason; comment?: string; amlResponsible?: string } {
    const amlErrors = this.getAmlErrors(
      entity,
      minVolume,
      amountInChf,
      last24hVolume,
      last7dVolume,
      last30dVolume,
      last365dVolume,
      bankData,
      blacklist,
      instantBanks,
      ibanCountry,
    );

    const comment = amlErrors.join(';');

    // Pass
    if (amlErrors.length === 0) return { amlCheck: CheckStatus.PASS, amlReason: AmlReason.NA, amlResponsible: 'API' };

    const amlResults = amlErrors.map((amlError) => ({ amlError, ...AmlErrorResult[amlError] }));

    // Crucial error aml
    const crucialErrorResults = amlResults.filter((r) => r.type === AmlErrorType.CRUCIAL);
    if (crucialErrorResults.length) {
      const crucialErrorResult =
        crucialErrorResults.find((c) => c.amlCheck === CheckStatus.FAIL) ?? crucialErrorResults[0];
      return Util.minutesDiff(entity.created) >= 10
        ? {
            amlCheck: crucialErrorResult.amlCheck,
            amlReason: crucialErrorResult.amlReason,
            comment,
            amlResponsible: 'API',
          }
        : { comment };
    }

    // Only error aml
    const onlyErrorResult = amlResults.find((r) => r.type === AmlErrorType.SINGLE);
    if (onlyErrorResult && amlErrors.length === 1)
      return { amlCheck: onlyErrorResult.amlCheck, amlReason: onlyErrorResult.amlReason, comment };

    // Same error aml
    if (
      amlResults.every((r) => r.type === AmlErrorType.MULTI) &&
      (amlResults.every((r) => r.amlCheck === CheckStatus.PENDING) ||
        amlResults.every((r) => r.amlCheck === CheckStatus.FAIL))
    )
      return { amlCheck: amlResults[0].amlCheck, amlReason: amlResults[0].amlReason, comment, amlResponsible: 'API' };

    // GSheet
    if (Util.minutesDiff(entity.created) >= 10) return { amlCheck: CheckStatus.GSHEET, comment };

    // No Result - only comment
    return { comment };
  }
}
