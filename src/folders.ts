import type { ImapFlow } from 'imapflow';

/** Possible paths of a server-managed folder: as configured, and inside the personal namespace. */
export function folderCandidates(client: ImapFlow, folder: string | undefined): string[] {
  if (!folder) return [];
  const prefix = client.namespace?.prefix ?? '';
  const names = [folder.toLowerCase()];
  if (prefix && !folder.toLowerCase().startsWith(prefix.toLowerCase())) names.push(`${prefix}${folder}`.toLowerCase());
  return names;
}

export function isFolder(client: ImapFlow, folder: string | undefined, path: string | undefined): boolean {
  return Boolean(path) && folderCandidates(client, folder).includes(path!.toLowerCase());
}

/**
 * Finds an existing server-managed folder, or creates it when `create` is set (inside the personal
 * namespace if the server requires one). Returns undefined if it does not exist and is not created.
 */
export async function resolveFolder(client: ImapFlow, folder: string, create: boolean): Promise<string | undefined> {
  const wanted = folderCandidates(client, folder);
  const existing = (await client.list()).find((box) => wanted.includes(box.path.toLowerCase()));
  if (existing || !create) return existing?.path;
  const prefix = client.namespace?.prefix ?? '';
  const path = prefix && !folder.startsWith(prefix) ? `${prefix}${folder}` : folder;
  await client.mailboxCreate(path);
  return path;
}
