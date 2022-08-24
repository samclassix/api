import { Blockchain } from 'src/ain/node/node.service';
import { Deposit } from '../../deposit.entity';

const defaultDeposit: Partial<Deposit> = {
  address: 'someAddress',
  blockchain: Blockchain.DEFICHAIN,
};

export function createDefaultDeposit(): Deposit {
  return createCustomDeposit({});
}

export function createCustomDeposit(customValues: Partial<Deposit>): Deposit {
  return Object.assign(new Deposit(), { ...defaultDeposit, ...customValues });
}