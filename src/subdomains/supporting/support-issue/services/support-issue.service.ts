import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Util } from 'src/shared/utils/util';
import { ContentType, FileType } from 'src/subdomains/generic/kyc/dto/kyc-file.dto';
import { DocumentStorageService } from 'src/subdomains/generic/kyc/services/integration/document-storage.service';
import { UserService } from 'src/subdomains/generic/user/models/user/user.service';
import { TransactionService } from '../../payment/services/transaction.service';
import { CreateTransactionIssueDto } from '../dto/create-support-issue.dto';
import { CreateSupportMessageDto } from '../dto/create-support-message.dto';
import { UpdateSupportIssueDto } from '../dto/update-support-issue.dto';
import { SupportIssue, SupportIssueType } from '../entities/support-issue.entity';
import { CustomerAuthor } from '../entities/support-message.entity';
import { SupportIssueRepository } from '../repositories/support-issue.repository';
import { SupportMessageRepository } from '../repositories/support-message.repository';
import { SupportIssueNotificationService } from './support-issue-notification.service';

@Injectable()
export class SupportIssueService {
  constructor(
    private readonly supportIssueRepo: SupportIssueRepository,
    private readonly transactionService: TransactionService,
    private readonly storageService: DocumentStorageService,
    private readonly userService: UserService,
    private readonly messageRepo: SupportMessageRepository,
    private readonly supportIssueNotificationService: SupportIssueNotificationService,
  ) {}

  async createTransactionIssue(userId: number, transactionId: number, dto: CreateTransactionIssueDto): Promise<void> {
    const existing = await this.supportIssueRepo.findOneBy({
      transaction: { id: transactionId },
      reason: dto.reason,
    });
    if (existing) throw new ConflictException('There is already a support issue for this transaction');

    const user = await this.userService.getUser(userId, { userData: true });
    if (!user.userData.mail) throw new BadRequestException('Mail is missing');

    let entity = this.supportIssueRepo.create({ type: SupportIssueType.TRANSACTION_ISSUE, ...dto });

    entity.transaction = await this.transactionService.getTransactionById(transactionId, { user: { userData: true } });
    if (!entity.transaction) throw new NotFoundException('Transaction not found');
    if (!entity.transaction.user || entity.transaction.user.userData.id !== user.userData.id)
      throw new ForbiddenException('You can only create support issue for your own transaction');

    entity = await this.supportIssueRepo.save(entity);

    await this.createSupportMessage(entity.id, { ...dto, author: CustomerAuthor }, userId);
  }

  async updateSupportIssue(id: number, dto: UpdateSupportIssueDto): Promise<SupportIssue> {
    const entity = await this.supportIssueRepo.findOneBy({ id });
    if (!entity) throw new NotFoundException('Support issue not found');

    Object.assign(entity, dto);

    return this.supportIssueRepo.save(entity);
  }

  async createSupportMessage(id: number, dto: CreateSupportMessageDto, userId: number): Promise<void> {
    const existing = await this.messageRepo.findOneBy({
      message: dto.message,
      issue: { id },
    });
    if (existing) throw new ConflictException('Support message already exists');

    const entity = this.messageRepo.create(dto);

    entity.issue = await this.supportIssueRepo.findOne({
      where: { id },
      relations: { transaction: { user: { userData: true } } },
    });
    if (!entity.issue) throw new NotFoundException('Support issue not found');

    const user = await this.userService.getUser(userId, { userData: true });

    if (dto.author === CustomerAuthor && entity.userData.id !== user.userData.id)
      throw new ForbiddenException('You can only create support messages for your own transaction');

    // upload document proof
    if (dto.file) {
      const { contentType, buffer } = Util.fromBase64(dto.file);

      entity.fileUrl = await this.storageService.uploadFile(
        entity.userData.id,
        FileType.SUPPORT_ISSUE,
        `${Util.isoDateTime(new Date())}_support-issue_user-upload_${dto.fileName}`,
        buffer,
        contentType as ContentType,
      );
    }

    await this.messageRepo.save(entity);

    if (dto.author !== CustomerAuthor) await this.supportIssueNotificationService.newSupportMessage(entity);
  }
}