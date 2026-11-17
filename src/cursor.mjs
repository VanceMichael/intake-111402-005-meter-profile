import {randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// 负荷曲线的续读游标：meterEpoch 标识哪一块表，nextEntry 是下一段未读区段的起点（null 表示已读完）。
export function validCursor(data) {
  return typeof data?.meterEpoch === 'string' && data.meterEpoch !== '' &&
    (data.nextEntry === null || Number.isInteger(data.nextEntry));
}

export async function readCursor(directory,name = 'profile-cursor.json') {
  try {
    const data = JSON.parse(await readFile(join(directory,name),'utf8'));
    return validCursor(data) ? {meterEpoch:data.meterEpoch,nextEntry:data.nextEntry} : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeCursor(directory,cursor,name = 'profile-cursor.json') {
  if (!validCursor(cursor)) throw new Error('invalid cursor');
  await mkdir(directory,{recursive:true});
  const temporary = join(directory,`${randomUUID()}.tmp`);
  await writeFile(temporary,JSON.stringify(cursor)+'\n');
  const handle = await open(temporary,'r');
  try {await handle.sync();} finally {await handle.close();}
  await rename(temporary,join(directory,name));
}
