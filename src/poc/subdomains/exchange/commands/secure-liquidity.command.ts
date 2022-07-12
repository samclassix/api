import { ICommand } from 'src/poc/shared/events/command';

interface SecureLiquidityCommandPayload {
  // TODO - ideally would have only one asset
  referenceAsset: string;
  referenceAmount: number;
  targetAsset: string;
}

export class SecureLiquidityCommand extends ICommand {
  constructor(readonly correlationId: string, readonly payload: SecureLiquidityCommandPayload) {
    super(correlationId, payload);
  }
}
