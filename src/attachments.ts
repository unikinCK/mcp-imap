import type { ImapFlow } from 'imapflow';
import type { AccountConfig } from './config.js';

/** Identifies one body part of one message, stable as long as the mailbox keeps its UIDVALIDITY. */
export interface AttachmentRef {
  account: string;
  mailbox: string;
  uid: number;
  part: string;
  uidValidity: string;
  filename?: string;
}

/** Creates a download URL for an attachment; only available in the HTTP server. */
export type AttachmentLinker = (ref: AttachmentRef) => { url: string; expiresAt: string };

export const RESOURCE_TEMPLATE = 'imap://{account}/{mailbox}/{uid}/{part}';

// encodeURIComponent keeps "," which the SDK's URI template matcher treats as a separator.
const encode = (value: string) => encodeURIComponent(value).replace(/,/g, '%2C');

/** URI under which the attachment can be read with resources/read. */
export function resourceUri(account: string, mailbox: string, uid: number, part: string): string {
  return `imap://${encode(account)}/${encode(mailbox)}/${uid}/${part}`;
}

export function uidValidityOf(client: ImapFlow): string {
  return client.mailbox ? String(client.mailbox.uidValidity) : '0';
}

/** Cache key for extracted text; includes the server and user, so HTTP users never share entries. */
export function attachmentKey(account: AccountConfig, ref: Omit<AttachmentRef, 'account' | 'filename'>): string {
  return [account.imap.host, account.imap.port, account.imap.user, ref.mailbox, ref.uidValidity, ref.uid, ref.part].join('\u0000');
}
