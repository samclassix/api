import { ChainId, Currency, CurrencyAmount, Ether, NativeCurrency, Percent, Token, TradeType } from '@uniswap/sdk-core';
import { AlphaRouter, SwapRoute, SwapType } from '@uniswap/smart-order-router';
import { buildSwapMethodParameters } from '@uniswap/smart-order-router/build/main/util/methodParameters';
import IUniswapV3PoolABI from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json';
import QuoterV2ABI from '@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json';
import { FeeAmount, MethodParameters, Pool, Route, SwapQuoter, Trade } from '@uniswap/v3-sdk';
import { AssetTransfersCategory, BigNumberish } from 'alchemy-sdk';
import { Contract, BigNumber as EthersNumber, ethers } from 'ethers';
import { AlchemyService } from 'src/integration/alchemy/services/alchemy.service';
import ERC20_ABI from 'src/integration/blockchain/shared/evm/abi/erc20.abi.json';
import SIGNATURE_TRANSFER_ABI from 'src/integration/blockchain/shared/evm/abi/signature-transfer.abi.json';
import { Asset, AssetType } from 'src/shared/models/asset/asset.entity';
import { HttpService } from 'src/shared/services/http.service';
import { AsyncCache } from 'src/shared/utils/async-cache';
import { Util } from 'src/shared/utils/util';
import { WalletAccount } from './domain/wallet-account';
import { EvmTokenBalance } from './dto/evm-token-balance.dto';
import { EvmUtil } from './evm.util';
import { EvmCoinHistoryEntry, EvmTokenHistoryEntry } from './interfaces';

export interface EvmClientParams {
  http: HttpService;
  alchemyService?: AlchemyService;
  gatewayUrl: string;
  apiKey: string;
  walletPrivateKey: string;
  chainId: ChainId;
  swapContractAddress: string;
  quoteContractAddress: string;
  scanApiUrl?: string;
  scanApiKey?: string;
}

interface AssetTransfersParams {
  fromAddress?: string;
  toAddress?: string;
  fromBlock: number;
  categories: AssetTransfersCategory[];
}

export abstract class EvmClient {
  protected http: HttpService;
  private alchemyService: AlchemyService;
  private chainId: ChainId;

  protected provider: ethers.providers.JsonRpcProvider;
  protected randomReceiverAddress = '0x4975f78e8903548bD33aF404B596690D47588Ff5';
  protected wallet: ethers.Wallet;
  private nonce = new Map<string, number>();
  private tokens = new AsyncCache<Token>();
  private router: AlphaRouter;
  private swapContractAddress: string;
  private quoteContractAddress: string;

  constructor(params: EvmClientParams) {
    this.http = params.http;
    this.alchemyService = params.alchemyService;
    this.chainId = params.chainId;

    const url = `${params.gatewayUrl}/${params.apiKey ?? ''}`;
    this.provider = new ethers.providers.JsonRpcProvider(url);

    this.wallet = new ethers.Wallet(params.walletPrivateKey, this.provider);

    this.router = new AlphaRouter({
      chainId: this.chainId,
      provider: this.provider,
    });
    this.swapContractAddress = params.swapContractAddress;
    this.quoteContractAddress = params.quoteContractAddress;
  }

  // --- PUBLIC API - GETTERS --- //

  async getNativeCoinTransactions(walletAddress: string, fromBlock: number): Promise<EvmCoinHistoryEntry[]> {
    const categories = this.alchemyService.getNativeCoinCategories(this.chainId);

    return this.getHistory(walletAddress, fromBlock, categories);
  }

  async getERC20Transactions(walletAddress: string, fromBlock: number): Promise<EvmTokenHistoryEntry[]> {
    const categories = this.alchemyService.getERC20Categories(this.chainId);

    return this.getHistory(walletAddress, fromBlock, categories);
  }

  async getNativeCoinBalance(): Promise<number> {
    return this.getNativeCoinBalanceForAddress(this.dfxAddress);
  }

  async getNativeCoinBalanceForAddress(address: string): Promise<number> {
    const balance = await this.alchemyService.getNativeCoinBalance(this.chainId, address);

    return EvmUtil.fromWeiAmount(balance);
  }

  async getTokenBalance(asset: Asset, address?: string): Promise<number> {
    const evmTokenBalances = await this.getTokenBalances([asset], address);

    return evmTokenBalances[0]?.balance ?? 0;
  }

  async getTokenBalances(assets: Asset[], address?: string): Promise<EvmTokenBalance[]> {
    const evmTokenBalances: EvmTokenBalance[] = [];

    const tokenBalances = await this.alchemyService.getTokenBalances(this.chainId, address ?? this.dfxAddress, assets);

    for (const tokenBalance of tokenBalances) {
      const token = await this.getTokenByAddress(tokenBalance.contractAddress);
      const balance = EvmUtil.fromWeiAmount(tokenBalance.tokenBalance ?? 0, token.decimals);

      evmTokenBalances.push({ contractAddress: tokenBalance.contractAddress, balance: balance });
    }

    return evmTokenBalances;
  }

  async getRecommendedGasPrice(): Promise<EthersNumber> {
    // 10% cap
    return this.provider.getGasPrice().then((p) => p.mul(11).div(10));
  }

  async getCurrentBlock(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async getTokenGasLimitForAsset(token: Asset): Promise<EthersNumber> {
    const contract = this.getERC20ContractForDex(token.chainId);

    return this.getTokenGasLimitForContact(contract);
  }

  async getTokenGasLimitForContact(contract: Contract): Promise<EthersNumber> {
    return contract.estimateGas.transfer(this.randomReceiverAddress, 1).then((l) => l.mul(12).div(10));
  }

  // --- PUBLIC API - WRITE TRANSACTIONS --- //

  async sendRawTransactionFromAccount(
    account: WalletAccount,
    request: ethers.providers.TransactionRequest,
  ): Promise<ethers.providers.TransactionResponse> {
    const wallet = EvmUtil.createWallet(account, this.provider);

    return this.sendRawTransaction(wallet, request);
  }

  async sendRawTransactionFromDex(
    request: ethers.providers.TransactionRequest,
  ): Promise<ethers.providers.TransactionResponse> {
    return this.sendRawTransaction(this.wallet, request);
  }

  async sendRawTransaction(
    wallet: ethers.Wallet,
    request: ethers.providers.TransactionRequest,
  ): Promise<ethers.providers.TransactionResponse> {
    let { nonce, gasPrice, value } = request;

    nonce = nonce ?? (await this.getNonce(request.from));
    gasPrice = gasPrice ?? +(await this.getRecommendedGasPrice());
    value = EvmUtil.toWeiAmount(value as number);

    return wallet.sendTransaction({
      ...request,
      nonce,
      gasPrice,
      value,
    });
  }

  async sendNativeCoinFromAccount(
    account: WalletAccount,
    toAddress: string,
    amount: number,
    feeLimit?: number,
  ): Promise<string> {
    const wallet = EvmUtil.createWallet(account, this.provider);

    return this.sendNativeCoin(wallet, toAddress, amount, feeLimit);
  }

  async sendNativeCoinFromDex(toAddress: string, amount: number, feeLimit?: number, nonce?: number): Promise<string> {
    return this.sendNativeCoin(this.wallet, toAddress, amount, feeLimit, nonce);
  }

  async sendTokenFromAccount(
    account: WalletAccount,
    toAddress: string,
    token: Asset,
    amount: number,
    feeLimit?: number,
  ): Promise<string> {
    const wallet = EvmUtil.createWallet(account, this.provider);

    const contract = new ethers.Contract(token.chainId, ERC20_ABI, wallet);

    return this.sendToken(contract, wallet.address, toAddress, amount, feeLimit);
  }

  async sendTokenFromDex(
    toAddress: string,
    token: Asset,
    amount: number,
    feeLimit?: number,
    nonce?: number,
  ): Promise<string> {
    const contract = this.getERC20ContractForDex(token.chainId);

    return this.sendToken(contract, this.dfxAddress, toAddress, amount, feeLimit, nonce);
  }

  async isPermitContract(address: string): Promise<boolean> {
    return this.contractHasMethod(address, SIGNATURE_TRANSFER_ABI, 'permitTransferFrom');
  }

  async permitTransfer(
    from: string,
    signature: string,
    signatureTransferContract: string,
    asset: Asset,
    amount: number,
    permittedAmount: number,
    to: string,
    nonce: number,
    deadline: BigNumberish,
  ): Promise<string> {
    const contract = new ethers.Contract(signatureTransferContract, SIGNATURE_TRANSFER_ABI, this.wallet);

    const token = await this.getToken(asset);
    const requestedAmount = EvmUtil.toWeiAmount(amount, token.decimals);
    const permittedAmountWei = EvmUtil.toWeiAmount(permittedAmount, token.decimals);

    const values = {
      permitted: {
        token: asset.chainId,
        amount: permittedAmountWei,
      },
      spender: this.dfxAddress,
      nonce,
      deadline,
    };
    const transferDetails = { to, requestedAmount };

    const gasPrice = +(await this.getRecommendedGasPrice());
    const currentNonce = await this.getNonce(this.dfxAddress);

    const result = await contract.permitTransferFrom(values, transferDetails, from, signature, {
      gasPrice,
      nonce: currentNonce,
    });
    return result.hash;
  }

  // --- PUBLIC API - UTILITY --- //

  async isTxComplete(txHash: string): Promise<boolean> {
    const transaction = await this.getTxReceipt(txHash);

    return transaction && transaction.confirmations > 0 && transaction.status === 1;
  }

  async getTx(txHash: string): Promise<ethers.providers.TransactionResponse> {
    return this.provider.getTransaction(txHash);
  }

  async getTxReceipt(txHash: string): Promise<ethers.providers.TransactionReceipt> {
    return this.provider.getTransactionReceipt(txHash);
  }

  async getTxNonce(txHash: string): Promise<number> {
    return this.provider.getTransaction(txHash).then((r) => r?.nonce);
  }

  async getTxActualFee(txHash: string): Promise<number> {
    const { gasUsed, effectiveGasPrice } = await this.getTxReceipt(txHash);
    const actualFee = gasUsed.mul(effectiveGasPrice);

    return EvmUtil.fromWeiAmount(actualFee);
  }

  async approveContract(asset: Asset, contractAddress: string): Promise<string> {
    const contract = this.getERC20ContractForDex(asset.chainId);

    const transaction = await contract.populateTransaction.approve(contractAddress, ethers.constants.MaxInt256);

    const gasPrice = await this.getRecommendedGasPrice();

    const tx = await this.wallet.sendTransaction({
      ...transaction,
      from: this.dfxAddress,
      gasPrice,
    });

    return tx.hash;
  }

  // --- PUBLIC API - SWAPS --- //
  async getPoolAddress(asset1: Asset, asset2: Asset, poolFee: FeeAmount): Promise<string> {
    const token1 = await this.getToken(asset1);
    const token2 = await this.getToken(asset2);

    if (token1 instanceof Token && token2 instanceof Token) {
      return Pool.getAddress(token1, token2, poolFee);
    } else {
      throw new Error(`Only tokens can be in a pool`);
    }
  }

  async testSwap(
    source: Asset,
    sourceAmount: number,
    target: Asset,
    maxSlippage: number,
  ): Promise<{ targetAmount: number; feeAmount: number }> {
    if (source.id === target.id) return { targetAmount: sourceAmount, feeAmount: 0 };

    const route = await this.getRoute(source, target, sourceAmount, maxSlippage);

    return {
      targetAmount: +route.quote.toExact(),
      feeAmount: EvmUtil.fromWeiAmount(route.estimatedGasUsed.mul(route.gasPriceWei)),
    };
  }

  async testSwapPool(
    source: Asset,
    sourceAmount: number,
    target: Asset,
    poolFee: FeeAmount,
  ): Promise<{ targetAmount: number; feeAmount: number; priceImpact: number }> {
    if (source.id === target.id) return { targetAmount: sourceAmount, feeAmount: 0, priceImpact: 0 };

    const sourceToken = await this.getToken(source);
    const targetToken = await this.getToken(target);
    if (sourceToken instanceof NativeCurrency || targetToken instanceof NativeCurrency)
      throw new Error(`Only tokens can be in a pool`);

    const poolContract = this.getPoolContract(Pool.getAddress(sourceToken, targetToken, poolFee));

    const token0IsInToken = sourceToken.address === (await poolContract.token0());
    const slot0 = await poolContract.slot0();
    const sqrtPriceX96 = slot0.sqrtPriceX96;

    const quote = await this.getQuoteContract().callStatic.quoteExactInputSingle({
      tokenIn: sourceToken.address,
      tokenOut: targetToken.address,
      fee: poolFee,
      amountIn: EvmUtil.toWeiAmount(sourceAmount, sourceToken.decimals),
      sqrtPriceLimitX96: '0',
    });

    const sqrtPriceX96After = quote.sqrtPriceX96After;
    let sqrtPriceRatio = sqrtPriceX96After / sqrtPriceX96;
    if (!token0IsInToken) sqrtPriceRatio = 1 / sqrtPriceRatio;

    const gasPrice = await this.getRecommendedGasPrice();

    return {
      targetAmount: EvmUtil.fromWeiAmount(quote.amountOut, targetToken.decimals),
      feeAmount: EvmUtil.fromWeiAmount(quote.gasEstimate.mul(gasPrice)),
      priceImpact: Math.abs(1 - sqrtPriceRatio),
    };
  }

  async swap(sourceToken: Asset, sourceAmount: number, targetToken: Asset, maxSlippage: number): Promise<string> {
    const route = await this.getRoute(sourceToken, targetToken, sourceAmount, maxSlippage);

    return this.doSwap(route.methodParameters);
  }

  async swapPool(
    source: Asset,
    target: Asset,
    sourceAmount: number,
    poolFee: FeeAmount,
    maxSlippage: number,
  ): Promise<string> {
    // get pool info
    const sourceToken = await this.getToken(source);
    const targetToken = await this.getToken(target);
    if (sourceToken instanceof NativeCurrency || targetToken instanceof NativeCurrency)
      throw new Error(`Only tokens can be in a pool`);

    const poolContract = this.getPoolContract(Pool.getAddress(sourceToken, targetToken, poolFee));
    const [liquidity, slot0] = await Promise.all([poolContract.liquidity(), poolContract.slot0()]);

    // create route
    const pool = new Pool(sourceToken, targetToken, poolFee, slot0[0].toString(), liquidity.toString(), slot0[1]);
    const route = new Route([pool], sourceToken, targetToken);

    const { calldata } = SwapQuoter.quoteCallParameters(
      route,
      this.toCurrencyAmount(sourceAmount, sourceToken),
      TradeType.EXACT_INPUT,
      {
        useQuoterV2: true,
      },
    );
    const quoteCallReturnData = await this.provider.call({
      to: this.quoteContractAddress,
      data: calldata,
    });

    const [amountOut] = ethers.utils.defaultAbiCoder.decode(['uint256'], quoteCallReturnData);

    // generate call parameters
    const trade = Trade.createUncheckedTrade({
      route,
      inputAmount: this.toCurrencyAmount(sourceAmount, sourceToken),
      outputAmount: CurrencyAmount.fromRawAmount(targetToken, +amountOut),
      tradeType: TradeType.EXACT_INPUT,
    });

    const parameters = buildSwapMethodParameters(trade as any, this.swapConfig(maxSlippage), this.chainId);

    return this.doSwap(parameters);
  }

  async getSwapResult(txId: string, asset: Asset): Promise<number> {
    const receipt = await this.getTxReceipt(txId);

    const swapLog = receipt?.logs?.find((l) => l.address.toLowerCase() === asset.chainId);
    if (!swapLog) throw new Error(`Failed to get swap result for TX ${txId}`);

    const token = await this.getToken(asset);
    return EvmUtil.fromWeiAmount(swapLog.data, token.decimals);
  }

  private async getRoute(source: Asset, target: Asset, sourceAmount: number, maxSlippage: number): Promise<SwapRoute> {
    const sourceToken = await this.getToken(source);
    const targetToken = await this.getToken(target);

    const route = await this.router.route(
      this.toCurrencyAmount(sourceAmount, sourceToken),
      targetToken,
      TradeType.EXACT_INPUT,
      this.swapConfig(maxSlippage),
    );

    if (!route)
      throw new Error(
        `No swap route found for ${sourceAmount} ${source.name} -> ${target.name} (${source.blockchain})`,
      );

    return route;
  }

  private async doSwap(parameters: MethodParameters) {
    const gasPrice = await this.getRecommendedGasPrice();

    const tx = await this.wallet.sendTransaction({
      data: parameters.calldata,
      to: this.swapContractAddress,
      value: parameters.value,
      from: this.dfxAddress,
      gasPrice,
    });

    return tx.hash;
  }

  // --- GETTERS --- //
  get dfxAddress(): string {
    return this.wallet.address;
  }

  swapConfig(maxSlippage: number) {
    return {
      recipient: this.dfxAddress,
      slippageTolerance: new Percent(maxSlippage * 1000, 1000),
      deadline: Math.floor(Util.minutesAfter(30).getTime() / 1000),
      type: SwapType.SWAP_ROUTER_02,
    };
  }

  // --- PUBLIC HELPER METHODS --- //

  async getToken(asset: Asset): Promise<Currency> {
    return asset.type === AssetType.COIN ? Ether.onChain(this.chainId) : this.getTokenByAddress(asset.chainId);
  }

  getPoolContract(poolAddress: string): Contract {
    return new ethers.Contract(poolAddress, IUniswapV3PoolABI.abi, this.wallet);
  }

  getQuoteContract(): Contract {
    return new ethers.Contract(this.quoteContractAddress, QuoterV2ABI.abi, this.wallet);
  }

  // --- PRIVATE HELPER METHODS --- //

  private toCurrencyAmount<T extends NativeCurrency | Token>(amount: number, token: T): CurrencyAmount<T> {
    const targetAmount = EvmUtil.toWeiAmount(amount, token.decimals).toString();

    return CurrencyAmount.fromRawAmount(token, targetAmount);
  }

  private async getTokenByAddress(address: string): Promise<Token> {
    const contract = this.getERC20ContractForDex(address);
    return this.getTokenByContract(contract);
  }

  protected getERC20ContractForDex(tokenAddress: string): Contract {
    return new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
  }

  protected async getTokenByContract(contract: Contract): Promise<Token> {
    return this.tokens.get(
      contract.address,
      async () => new Token(this.chainId, contract.address, await contract.decimals()),
    );
  }

  async getCurrentGasCostForCoinTransaction(): Promise<number> {
    const totalGas = await this.getCurrentGasForCoinTransaction(this.dfxAddress, 1e-18);
    const gasPrice = await this.getRecommendedGasPrice();

    return EvmUtil.fromWeiAmount(totalGas.mul(gasPrice));
  }

  async getCurrentGasCostForTokenTransaction(token: Asset): Promise<number> {
    const totalGas = await this.getTokenGasLimitForAsset(token);
    const gasPrice = await this.getRecommendedGasPrice();

    return EvmUtil.fromWeiAmount(totalGas.mul(gasPrice));
  }

  protected async sendNativeCoin(
    wallet: ethers.Wallet,
    toAddress: string,
    amount: number,
    feeLimit?: number,
    nonce?: number,
  ): Promise<string> {
    const fromAddress = wallet.address;

    const gasLimit = await this.getCurrentGasForCoinTransaction(fromAddress, amount);
    const gasPrice = await this.getGasPrice(+gasLimit, feeLimit);
    const currentNonce = await this.getNonce(fromAddress);
    const txNonce = nonce ?? currentNonce;

    const tx = await wallet.sendTransaction({
      from: fromAddress,
      to: toAddress,
      value: EvmUtil.toWeiAmount(amount),
      nonce: txNonce,
      gasPrice,
      gasLimit,
    });

    if (txNonce >= currentNonce) this.nonce.set(fromAddress, txNonce + 1);

    return tx.hash;
  }

  protected async getCurrentGasForCoinTransaction(fromAddress: string, amount: number): Promise<EthersNumber> {
    return this.provider.estimateGas({
      from: fromAddress,
      to: this.randomReceiverAddress,
      value: EvmUtil.toWeiAmount(amount),
    });
  }

  private async sendToken(
    contract: Contract,
    fromAddress: string,
    toAddress: string,
    amount: number,
    feeLimit?: number,
    nonce?: number,
  ): Promise<string> {
    const gasLimit = +(await this.getTokenGasLimitForContact(contract));
    const gasPrice = await this.getGasPrice(gasLimit, feeLimit);
    const currentNonce = await this.getNonce(fromAddress);
    const txNonce = nonce ?? currentNonce;

    const token = await this.getTokenByContract(contract);
    const targetAmount = EvmUtil.toWeiAmount(amount, token.decimals);

    const tx = await contract.transfer(toAddress, targetAmount, { gasPrice, gasLimit, nonce: txNonce });

    if (txNonce >= currentNonce) this.nonce.set(fromAddress, txNonce + 1);

    return tx.hash;
  }

  protected async getGasPrice(gasLimit: number, feeLimit?: number): Promise<number> {
    const currentGasPrice = +(await this.getRecommendedGasPrice());
    const proposedGasPrice =
      feeLimit != null ? Util.round(+EvmUtil.toWeiAmount(feeLimit) / gasLimit, 0) : Number.MAX_VALUE;

    return Math.min(currentGasPrice, proposedGasPrice);
  }

  protected async getNonce(address: string): Promise<number> {
    const blockchainNonce = await this.provider.getTransactionCount(address);
    const cachedNonce = this.nonce.get(address) ?? 0;

    return Math.max(blockchainNonce, cachedNonce);
  }

  private async getHistory<T>(
    walletAddress: string,
    fromBlock: number,
    categories: AssetTransfersCategory[],
  ): Promise<T[]> {
    const params: AssetTransfersParams = {
      fromAddress: walletAddress,
      toAddress: undefined,
      fromBlock: fromBlock,
      categories: categories,
    };

    const assetTransferResult = await this.alchemyService.getAssetTransfers(this.chainId, params);

    params.fromAddress = undefined;
    params.toAddress = walletAddress;

    assetTransferResult.push(...(await this.alchemyService.getAssetTransfers(this.chainId, params)));

    assetTransferResult.sort((atr1, atr2) => Number(atr1.blockNum) - Number(atr2.blockNum));

    return <T[]>assetTransferResult.map((atr) => ({
      blockNumber: Number(atr.blockNum).toString(),
      timeStamp: Number(new Date(atr.metadata.blockTimestamp).getTime() / 1000).toString(),
      hash: atr.hash,
      from: atr.from,
      to: atr.to,
      value: Number(atr.rawContract.value).toString(),
      contractAddress: atr.rawContract.address ?? '',
      tokenName: atr.asset,
      tokenDecimal: Number(atr.rawContract.decimal).toString(),
    }));
  }

  private async contractHasMethod(address: string, abi: any, method: string): Promise<boolean> {
    const method_selector = new ethers.utils.Interface(abi).getSighash(method).substring(2);

    return this.provider.getCode(address).then((code) => code.includes(method_selector));
  }
}
