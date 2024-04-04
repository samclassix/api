import { GetConfig } from 'src/config/config';
import { Notification, NotificationOptions } from '../../notification.entity';

export interface MailParamBase {
  to: string | string[];
  subject: string;
  from?: string;
  displayName?: string;
  cc?: string;
  bcc?: string;
  template?: string;
  options?: NotificationOptions;
  correlationId?: string;
}

export interface MailParams extends MailParamBase {
  templateParams?: {
    salutation: string;
    body: string;
    date?: number;
    banner?: string;
    telegramUrl?: string;
    twitterUrl?: string;
    linkedinUrl?: string;
    instagramUrl?: string;
  };
}

export interface MailParamsNew extends MailParamBase {
  templateParams?: any;
}

export class Mail extends Notification {
  readonly #from: { name: string; address: string } = {
    name: 'DFX.swiss',
    address: GetConfig().mail.contact.noReplyMail,
  };
  readonly #to: string | string[];
  readonly #cc: string;
  readonly #bcc: string;
  readonly #subject: string;
  readonly #template: string = GetConfig().mail.defaultMailTemplate;
  readonly #templateParams: { [name: string]: any };

  constructor(params: MailParams | MailParamsNew) {
    super();

    this.#to = params.to;
    this.#subject = params.subject;
    this.#from = {
      name: params.displayName ?? 'DFX.swiss',
      address: params.from ?? GetConfig().mail.contact.noReplyMail,
    };
    this.#cc = params.cc ?? this.#cc;
    this.#bcc = params.bcc ?? this.#bcc;
    this.#template = params.template ?? this.#template;
    this.#templateParams = params.templateParams;
  }

  get from(): { name: string; address: string } {
    const { name, address } = this.#from;
    return { name, address };
  }

  get to(): string | string[] {
    return this.#to;
  }

  get cc(): string {
    return this.#cc;
  }

  get bcc(): string {
    return this.#bcc;
  }

  get template(): string {
    return this.#template;
  }

  get templateParams(): { [name: string]: any } {
    return this.#templateParams;
  }

  get subject(): string {
    return this.#subject;
  }
}
