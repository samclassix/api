import { Injectable, NotFoundException } from '@nestjs/common';
import { MasternodeRepository } from 'src/payment/models/masternode/masternode.repository';
import { LessThan } from 'typeorm';
import { CreateMasternodeDto } from './dto/create-masternode.dto';
import { UpdateMasternodeDto } from './dto/update-masternode.dto';
import { Masternode } from './masternode.entity';

@Injectable()
export class MasternodeService {
  constructor(private readonly masternodeRepo: MasternodeRepository) {}

  async get(): Promise<Masternode[]> {
    return this.masternodeRepo.find();
  }

  async create(dto: CreateMasternodeDto): Promise<Masternode> {
    const masternode = this.masternodeRepo.create(dto);
    return this.masternodeRepo.save(masternode);
  }

  async update(hash: string, dto: UpdateMasternodeDto): Promise<Masternode> {
    const masternode = await this.masternodeRepo.findOne({ hash });
    if (!masternode) throw new NotFoundException('Masternode not found');

    return await this.masternodeRepo.save({ ...masternode, ...dto });
  }

  async getCount(date: Date = new Date()): Promise<number> {
    return this.masternodeRepo.count({ where: { enabled: true, created: LessThan(date) } });
  }

  async getActiveMasternodes(): Promise<Masternode[]> {
    return this.masternodeRepo.find({ where: { enabled: true } });
  }
}
