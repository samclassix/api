import { BadRequestException, Injectable } from '@nestjs/common';
import { Blockchain } from 'src/integration/blockchain/shared/enums/blockchain.enum';
import { AssetRepository } from 'src/shared/models/asset/asset.repository';
import { Util } from 'src/shared/utils/util';
import { FindOptionsWhere, In, Not } from 'typeorm';
import { Asset, AssetCategory, AssetType } from './asset.entity';
import { UpdateAssetDto } from './dto/update-asset.dto';

export interface AssetQuery {
  dexName: string;
  blockchain: Blockchain;
  type: AssetType;
}

@Injectable()
export class AssetService {
  constructor(private assetRepo: AssetRepository) {}

  async updateAsset(id: number, dto: UpdateAssetDto): Promise<Asset> {
    const entity = await this.assetRepo.findOneBy({ id });
    if (!entity) throw new BadRequestException('Asset not found');

    Object.assign(entity, dto);

    return this.assetRepo.save(entity);
  }

  async getAllAsset(blockchains: Blockchain[], includePrivate = true): Promise<Asset[]> {
    const search: FindOptionsWhere<Asset> = {};
    search.blockchain = blockchains.length > 0 ? In(blockchains) : Not(Blockchain.DEFICHAIN);
    !includePrivate && (search.category = Not(AssetCategory.PRIVATE));

    return this.assetRepo.findCachedBy(JSON.stringify(search), search);
  }

  async getActiveAsset(): Promise<Asset[]> {
    return this.assetRepo.findBy([
      { buyable: true },
      { sellable: true },
      { instantBuyable: true },
      { instantSellable: true },
      { cardBuyable: true },
      { cardSellable: true },
    ]);
  }

  async getAssetById(id: number): Promise<Asset> {
    return this.assetRepo.findOneCachedBy(`${id}`, { id });
  }

  async getAssetByChainId(blockchain: Blockchain, chainId: string): Promise<Asset> {
    return this.assetRepo.findOneCachedBy(`${blockchain}-${chainId}`, { blockchain, chainId });
  }

  async getAssetByUniqueName(uniqueName: string): Promise<Asset> {
    return this.assetRepo.findOneCachedBy(uniqueName, { uniqueName });
  }

  async getAssetByQuery(query: AssetQuery): Promise<Asset> {
    return this.assetRepo.findOneCachedBy(`${query.dexName}-${query.blockchain}-${query.type}`, query);
  }

  async getNativeAsset(blockchain: Blockchain): Promise<Asset> {
    return this.assetRepo.findOneCachedBy(`native-${blockchain}`, { blockchain, type: AssetType.COIN });
  }

  async getSellableBlockchains(): Promise<Blockchain[]> {
    return this.assetRepo
      .findCachedBy('sellable', { sellable: true })
      .then((assets) => Array.from(new Set(assets.map((a) => a.blockchain))));
  }

  async updatePrice(assetId: number, usdPrice: number, chfPrice: number) {
    await this.assetRepo.update(assetId, { approxPriceUsd: usdPrice, approxPriceChf: chfPrice });
    this.assetRepo.invalidateCache();
  }

  async getAssetsUsedOn(exchange: string): Promise<string[]> {
    return this.assetRepo
      .createQueryBuilder('asset')
      .select('DISTINCT asset.name', 'name')
      .innerJoin('asset.liquidityManagementRule', 'lmRule')
      .innerJoin('lmRule.deficitStartAction', 'deficitAction')
      .where('asset.buyable = 1')
      .andWhere('deficitAction.system = :exchange', { exchange })
      .getRawMany<{ name: string }>()
      .then((l) => l.map((a) => a.name));
  }

  //*** UTILITY METHODS ***//

  getByQuerySync(assets: Asset[], { dexName, blockchain, type }: AssetQuery): Asset | undefined {
    return assets.find((a) => a.dexName === dexName && a.blockchain === blockchain && a.type === type);
  }

  getByChainIdSync(assets: Asset[], blockchain: Blockchain, chainId: string): Asset | undefined {
    return assets.find(
      (a) => a.blockchain === blockchain && a.type === AssetType.TOKEN && Util.equalsIgnoreCase(a.chainId, chainId),
    );
  }

  async getDfiCoin(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'DFI',
      blockchain: Blockchain.DEFICHAIN,
      type: AssetType.COIN,
    });
  }

  async getDfiToken(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'DFI',
      blockchain: Blockchain.DEFICHAIN,
      type: AssetType.TOKEN,
    });
  }

  async getEthCoin(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'ETH',
      blockchain: Blockchain.ETHEREUM,
      type: AssetType.COIN,
    });
  }

  async getBnbCoin(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'BNB',
      blockchain: Blockchain.BINANCE_SMART_CHAIN,
      type: AssetType.COIN,
    });
  }

  async getArbitrumCoin(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'ETH',
      blockchain: Blockchain.ARBITRUM,
      type: AssetType.COIN,
    });
  }

  async getOptimismCoin(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'ETH',
      blockchain: Blockchain.OPTIMISM,
      type: AssetType.COIN,
    });
  }

  async getPolygonCoin(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'MATIC',
      blockchain: Blockchain.POLYGON,
      type: AssetType.COIN,
    });
  }

  async getBaseCoin(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'ETH',
      blockchain: Blockchain.BASE,
      type: AssetType.COIN,
    });
  }

  async getBtcCoin(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'BTC',
      blockchain: Blockchain.BITCOIN,
      type: AssetType.COIN,
    });
  }

  async getLightningCoin(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'BTC',
      blockchain: Blockchain.LIGHTNING,
      type: AssetType.COIN,
    });
  }

  async getMoneroCoin(): Promise<Asset> {
    return this.getAssetByQuery({
      dexName: 'XMR',
      blockchain: Blockchain.MONERO,
      type: AssetType.COIN,
    });
  }
}
