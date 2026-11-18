import {resolve,join} from 'node:path';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collectProfileEntries,registerValue} from './reader.mjs';import {Archive} from './archive.mjs';
import {createApi} from './api.mjs';

const dataDirectory = resolve(process.env.DATA_DIR ?? '.state');
const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(dataDirectory);
const api = await createApi(archive,Number(process.env.PORT ?? 4020));
console.log(JSON.stringify({source:source.origin,api:api.origin}));

/*
 * 抄表员中断后从上次的 cursor 继续，而不是重抄整张表。
 * 游标是运行状态，删除 .state 即恢复空收件箱。
 */
const cursorPath = join(dataDirectory,'profile-cursor.json');
async function loadCursor() {
  try {return JSON.parse(await readFile(cursorPath,'utf8'));}
  catch(error) {if(error.code === 'ENOENT') return null;throw error;}
}
async function saveCursor(cursor) {
  await mkdir(dataDirectory,{recursive:true});
  const temporary = `${cursorPath}.tmp`;
  await writeFile(temporary,JSON.stringify(cursor,null,2)+'\n');
  await rename(temporary,cursorPath);
}

try {
  const client = createClient(source.origin);
  const register = registerValue(await client('/register'));
  const batch = await collectProfileEntries(client,{cursor:await loadCursor(),origin:source.origin});
  const result = await archive.put([register,...batch.rows],{
    source:source.origin,
    adapter:'profile',
    meterEpoch:batch.cursor.meterEpoch,
  });
  await saveCursor(batch.cursor);
  console.log(JSON.stringify({...result,complete:batch.complete,uninterpretable:batch.uninterpretable}));
} catch(error) {console.error(error.message);}

let stopping = false;
const stop = async () => {if(stopping) return;stopping = true;await Promise.all([source.close(),api.close()]);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
